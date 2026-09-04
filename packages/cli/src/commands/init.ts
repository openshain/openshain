import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CONFIG_FILE_NAME, OpenshainError } from "@openshain/core";

export const CONFIG_TEMPLATE = `version: 1
company:
  name: サンプル株式会社
principal:
  id: alice
  name: Alice
profession:
  id: generic
  instructions: |
    あなたはこの会社の事務担当です。依頼された作業を、workspace 内のファイルだけを使って進めてください。
model:
  provider: anthropic
  model: claude-opus-5
  api_key_env: ANTHROPIC_API_KEY
tools:
  - provider: standard
limits:
  max_model_calls: 30
  max_tool_calls: 100
  max_output_tokens: 16000
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
