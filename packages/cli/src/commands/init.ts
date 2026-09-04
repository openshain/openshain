import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE_NAME, OpenshainError } from "@openshain/core";

export const CONFIG_TEMPLATE = `version: 1
company:
  name: サンプル株式会社   # 会社名。model に伝わる
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
    # allow: [fs_list, fs_read, csv_read, markdown_read, fs_write, csv_write]   # 省略時は全部
  # - module: ./tools/my-tool.ts   # ToolProvider を default export するモジュール
limits:
  max_model_calls: 30      # 超えると Work は失敗(上限到達)で止まる
  max_tool_calls: 100
  max_output_tokens: 16000 # model の 1 回の出力の上限
# debug:
#   persist_raw: true      # provider の生の応答を記録に残す
`;

export interface InitOptions {
  workspaceRoot: string;
  write: (line: string) => void;
}

/** Writes a starter openshain.yaml. Never overwrites one that exists. */
export async function init({ workspaceRoot, write }: InitOptions): Promise<void> {
  const path = join(workspaceRoot, CONFIG_FILE_NAME);
  try {
    await writeFile(path, CONFIG_TEMPLATE, { flag: "wx" });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new OpenshainError("config", `${path} はすでにあります。上書きはしません。`);
    }
    if (code === "ENOENT") {
      throw new OpenshainError(
        "config",
        `${workspaceRoot} がありません。先にディレクトリを作ってください。`,
      );
    }
    throw err;
  }
  write(`${path} を作りました。`);
  write(
    "company と principal を自分の会社に合わせ、api_key_env に書いた環境変数を設定してから openshain run を実行してください。",
  );
}
