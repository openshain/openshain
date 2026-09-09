import {
  buildIndex,
  checkKnowledge,
  hashKnowledgeInput,
  hasKnowledge,
  KNOWLEDGE_DIR_NAME,
  type KnowledgeSource,
  writeIndex,
} from "@openshain/core";

export interface KnowledgeOptions {
  workspaceRoot: string;
  write: (line: string) => void;
  /** Also say which sources have not been looked at for a year. Never changes the outcome. */
  stale?: boolean;
  now?: Date;
}

/** A year is how long a company's source may sit before it is worth looking at again. */
const STALE_DAYS = 365;

/**
 * Checks what a person wrote and, when nothing is wrong, writes the index. Every problem is
 * printed, not only the first: a person fixing a set of files should need one pass, not one run
 * per mistake. When anything is wrong, `knowledge/build/` is left exactly as it was.
 */
export async function knowledgeBuild(options: KnowledgeOptions): Promise<number> {
  const { workspaceRoot, write } = options;
  if (!(await hasKnowledge(workspaceRoot))) {
    write(
      `${KNOWLEDGE_DIR_NAME}/ がありません。会社の決まりは ${KNOWLEDGE_DIR_NAME}/rules/、根拠の資料は ${KNOWLEDGE_DIR_NAME}/sources/ に置きます。`,
    );
    return 1;
  }
  const checked = await checkKnowledge(workspaceRoot);
  if (checked.problems.length > 0) {
    for (const problem of checked.problems) write(problem);
    write(`${checked.problems.length} 件の問題があります。索引は作りませんでした。`);
    return 1;
  }
  if (options.stale) for (const line of staleLines(checked.sources, options.now)) write(line);

  const manifest = await writeIndex(workspaceRoot, buildIndex(checked), {
    hash: await hashKnowledgeInput(workspaceRoot),
    rules: checked.rules.length,
    sources: checked.sources.length,
  });
  write(
    `決まり ${manifest.rules} 件、資料 ${manifest.sources} 件から ${manifest.units} 件の索引を作りました。`,
  );
  write("対話を開いている場合は、いったん閉じて開き直すと社員エージェントが引けるようになります。");
  return 0;
}

/** The same checks without writing anything, for a person or for CI. */
export async function knowledgeCheck(options: KnowledgeOptions): Promise<number> {
  const { workspaceRoot, write } = options;
  if (!(await hasKnowledge(workspaceRoot))) {
    write(`${KNOWLEDGE_DIR_NAME}/ がありません。`);
    return 1;
  }
  const checked = await checkKnowledge(workspaceRoot);
  for (const problem of checked.problems) write(problem);
  if (options.stale) for (const line of staleLines(checked.sources, options.now)) write(line);
  if (checked.problems.length > 0) {
    write(`${checked.problems.length} 件の問題があります。`);
    return 1;
  }
  write(`決まり ${checked.rules.length} 件、資料 ${checked.sources.length} 件。問題はありません。`);
  return 0;
}

/** Sources nobody has looked at for a year. A warning, never a reason to fail. */
function staleLines(sources: KnowledgeSource[], now = new Date()): string[] {
  const limit = new Date(now);
  limit.setUTCDate(limit.getUTCDate() - STALE_DAYS);
  const cutoff = limit.toISOString().slice(0, 10);
  return sources
    .filter((source) => source.retrieved_at < cutoff)
    .map(
      (source) =>
        `${source.file}: ${source.id} を確かめたのは ${source.retrieved_at} です。出どころが変わっていないか確認してください。`,
    );
}
