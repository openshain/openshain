import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE_NAME, type Language, OpenshainError } from "@openshain/core";

/** The company's language for the template: from the OS locale, Japanese unless the locale says otherwise. */
export function detectLanguage(env: Record<string, string | undefined>): Language {
  const raw = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  const code = raw.toLowerCase().split(/[_.@-]/)[0] ?? "";
  if (code === "ja" || code === "" || code === "c" || code === "posix") return "ja";
  return "en";
}

export const configTemplate = (language: Language) => `version: 1
company:
  name: サンプル株式会社   # 会社名。model に伝わる
  language: ${language}             # ja | en。社員エージェントの名前の言語。init が OS の locale から埋める
principal:
  id: alice                # 依頼する人の id。小文字の英数字、_ と -
  name: Alice
profession:
  id: generic
  # model への指示。100,000 文字まで
  instructions: |
    あなたはこの会社の事務担当です。依頼された作業を、workspace 内のファイルだけを使って進めてください。
model:
  provider: anthropic      # anthropic | openai-compatible
  model: claude-opus-5
  api_key_env: ANTHROPIC_API_KEY   # API キーを入れておく環境変数の名前。サーバーを替えるなら変数名も見直す
  # base_url: http://localhost:11434/v1   # openai-compatible のとき
  # options: { effort: high }             # provider にそのまま渡す
tools:
  - provider: standard
    # allow: [fs_list, fs_search, fs_read, csv_read, csv_aggregate, markdown_read, fs_write, csv_write]   # 省略時は全部
  # - module: ./tools/my-tool.ts   # ToolProvider を default export するモジュール
limits:
  max_model_calls: 30      # 超えると Work は失敗(上限到達)で止まる
  max_tool_calls: 100
  max_output_tokens: 16000 # model の 1 回の出力の上限
# debug:
#   persist_raw: true      # provider の生の応答を記録に残す
`;

export const CONFIG_TEMPLATE = configTemplate("ja");

/** Registers the runtime as a project MCP server for Claude Code. `openshain` must be on PATH. */
export const MCP_TEMPLATE = `${JSON.stringify(
  { mcpServers: { openshain: { command: "openshain", args: ["mcp"] } } },
  null,
  2,
)}\n`;

/** What an outside agent reads before working in the folder. Codex reads AGENTS.md; Claude Code reads it through CLAUDE.md. */
export const AGENTS_TEMPLATE = `# この会社フォルダで働くエージェントへ

このフォルダは openshain の Company Workspace です。この指示は、Claude Code や Codex のような外部のエージェントが MCP 経由でこのフォルダを扱うときのものです。\`openshain run\` で Runtime 自身が動くときは、Work の作成と完了を Runtime が行うので、下の work_* の手順は当てはまりません。

会社のファイルの読み書きと集計は openshain の MCP tool で行います。Claude Code や Codex 自身の Read、Write、Bash は会社のファイルには使いません。Runtime を通らなかった操作は記録に残らないためです。

- 依頼を受けたら、まず \`work_create\` に依頼の文をそのまま渡して Work を作る
- ファイルは \`fs_list\`、\`fs_search\`、\`fs_read\`、\`csv_read\`、\`markdown_read\` で見る。合計や件数は \`csv_aggregate\` に任せ、自分で合計しない
- 書くときは \`fs_write\` か \`csv_write\`
- 終わったら \`work_complete\` に、何をしたかと、書いたファイルを渡す。続けられないときは \`work_fail\`
- \`openshain.yaml\` と \`work/\` は Runtime のもの。変更しない
`;

export const CLAUDE_TEMPLATE = "@AGENTS.md\n";

export interface InitOptions {
  workspaceRoot: string;
  write: (line: string) => void;
}

/**
 * Writes the starter files of a company workspace: openshain.yaml, .mcp.json, AGENTS.md and
 * CLAUDE.md. A workspace that already has openshain.yaml is left alone with an error. An existing
 * .mcp.json keeps its servers and gains the openshain entry when it lacks one; any other file that
 * already exists is kept as it is.
 */
export async function init({ workspaceRoot, write }: InitOptions): Promise<void> {
  const configPath = join(workspaceRoot, CONFIG_FILE_NAME);
  try {
    await writeFile(configPath, configTemplate(detectLanguage(process.env)), { flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new OpenshainError("config", `${configPath} はすでにあります。上書きはしません。`);
    }
    if (code === "ENOENT") {
      throw new OpenshainError(
        "config",
        `${workspaceRoot} がありません。先にディレクトリを作ってください。`,
      );
    }
    throw err;
  }
  write(`${configPath} を作りました。`);
  for (const [name, content] of [
    [".mcp.json", MCP_TEMPLATE],
    ["AGENTS.md", AGENTS_TEMPLATE],
    ["CLAUDE.md", CLAUDE_TEMPLATE],
  ] as const) {
    const path = join(workspaceRoot, name);
    try {
      await writeFile(path, content, { flag: "wx" });
      write(`${path} を作りました。`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (name === ".mcp.json") write(await addToMcpConfig(path));
      else write(`${path} はすでにあるので変更しません。`);
    }
  }
  write(
    "company と principal を自分の会社に合わせ、api_key_env に書いた環境変数を設定してから openshain run を実行してください。",
  );
}

/**
 * Adds the openshain server to a .mcp.json that is already there, keeping every other server.
 * A file that cannot be read as JSON is left as it is, and the line says so.
 */
async function addToMcpConfig(path: string): Promise<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    return `${path} はすでにあり、JSON として読めないので変更しません。openshain を手動で登録してください。`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `${path} はすでにあり、形が違うので変更しません。openshain を手動で登録してください。`;
  }
  const config = parsed as { mcpServers?: unknown };
  const servers =
    config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {};
  if (Object.hasOwn(servers, "openshain"))
    return `${path} には openshain がすでにあるので変更しません。`;
  const next = {
    ...config,
    mcpServers: { ...servers, openshain: { command: "openshain", args: ["mcp"] } },
  };
  await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return `${path} に openshain を追加しました。他の項目はそのままです。`;
}
