import { createInterface } from "node:readline/promises";
import {
  checkKnowledge,
  KNOWLEDGE_DIR_NAME,
  type KnowledgeRule,
  knowledgePath,
  type LoadedKnowledgeRule,
  readKnowledgeFile,
  writeKnowledgeFile,
} from "@openshain/core";
import { knowledgeBuild } from "./knowledge.ts";

/**
 * Adding one rule by answering questions, so that a person does not have to learn the shape of
 * the file to write one. Nothing is written until the rule holds up against everything already
 * there: a rule that would break the build never reaches the folder, so adding one can only
 * succeed or leave the company's knowledge exactly as it was.
 */

export interface KnowledgeAddOptions {
  workspaceRoot: string;
  write: (line: string) => void;
  /** Asks the person one question and returns what they typed. Given by the terminal. */
  ask?: (question: string) => Promise<string>;
  /** Whether a person is there to answer. */
  interactive?: boolean;
  today?: string;
}

export async function knowledgeAdd(options: KnowledgeAddOptions): Promise<number> {
  const { write } = options;
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    write("openshain knowledge add は端末で使います。決まりを直接書くなら knowledge/rules/ です。");
    return 2;
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const ask = options.ask ?? ((question: string) => readline.question(`${question}\n> `));
  try {
    return await run({ ...options, ask }, write);
  } finally {
    readline.close();
  }
}

async function run(
  options: KnowledgeAddOptions & { ask: (question: string) => Promise<string> },
  write: (line: string) => void,
): Promise<number> {
  const { workspaceRoot, ask } = options;
  const today = options.today ?? new Date().toISOString().slice(0, 10);
  const existing = await checkKnowledge(workspaceRoot);
  if (existing.sources.length === 0) {
    write(
      `根拠になる資料がまだありません。${KNOWLEDGE_DIR_NAME}/sources/ に 1 件置いてから実行してください。`,
    );
    return 1;
  }

  write("会社の決まりを 1 件追加します。答えたくない項目は空のまま Enter で戻れます。");
  const statement = (await ask("どんな決まりですか。1 文で書いてください")).trim();
  if (statement === "") {
    write("何も書かれなかったので、やめました。");
    return 1;
  }
  const id = (await ask("この決まりの id(例 expenses.receipt-required)")).trim();
  const from = (await ask(`いつから有効ですか(YYYY-MM-DD。空なら ${today})`)).trim() || today;
  const to = (await ask("いつまでですか(期限がなければ空のまま)")).trim();

  write("根拠にする資料を選んでください。");
  for (const source of existing.sources) write(`  ${source.id}  ${source.title}`);
  const sourceId = (await ask("資料の id")).trim();
  const section = (await ask("その資料のどの節ですか(なければ空のまま)")).trim();
  const aliases = (await ask("他にどう言い換えますか(読点で区切ります。なければ空のまま)"))
    .split(/[,、]/)
    .map((word) => word.trim())
    .filter(Boolean);
  const expertise =
    (await ask("資格者の領域に関わりますか(none、tax、legal、labor など。空なら none)")).trim() ||
    "none";

  const rule = {
    id,
    statement,
    ...(aliases.length > 0 && { aliases }),
    effective_from: from,
    effective_to: to === "" ? null : to,
    expertise,
    source: { id: sourceId, ...(section !== "" && { section }) },
  } as KnowledgeRule;

  // The file it would live in, named after what the id is about.
  const parts = ["rules", `${(id.split(".")[0] || "rules").replace(/[^a-z0-9-]/g, "")}.yaml`];
  const file = knowledgePath(parts);
  const checked = await checkKnowledge(workspaceRoot, {
    adding: [{ ...rule, file } as LoadedKnowledgeRule],
  });
  if (checked.problems.length > 0) {
    for (const problem of checked.problems) write(problem);
    write("この決まりは追加していません。会社の決まりはそのままです。");
    return 1;
  }

  const before = await readKnowledgeFile(workspaceRoot, parts);
  await writeKnowledgeFile(workspaceRoot, parts, appended(before, rule));
  write(`${file} に ${id} を書きました。`);
  return knowledgeBuild({ workspaceRoot, write });
}

/** The rule as a person would have written it, added to the file or starting one. */
function appended(before: string | undefined, rule: KnowledgeRule): string {
  const lines = [
    `  - id: ${rule.id}`,
    `    statement: ${quoted(rule.statement)}`,
    ...(rule.aliases ? [`    aliases: [${rule.aliases.map(quoted).join(", ")}]`] : []),
    `    effective_from: ${rule.effective_from}`,
    `    effective_to: ${rule.effective_to === null ? "null" : rule.effective_to}`,
    `    expertise: ${rule.expertise}`,
    `    source: { id: ${rule.source.id}${rule.source.section ? `, section: ${quoted(rule.source.section)}` : ""} }`,
  ];
  const head = before?.trimEnd() ?? "version: 1\nrules:";
  return `${head}\n${lines.join("\n")}\n`;
}

/** YAML that means the string and nothing else, whatever is in it. */
function quoted(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
