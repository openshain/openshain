#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { anthropicProvider } from "@openshain/agent";
import { isOpenshainError, type RuntimeProviders } from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { init } from "./commands/init.ts";
import { run } from "./commands/run.ts";
import { toolsList } from "./commands/tools.ts";
import { workList, workResume, workShow } from "./commands/work.ts";
import { errorLabel } from "./labels.ts";
import { findWorkspace } from "./workspace.ts";

const USAGE = `使い方:
  openshain init                 openshain.yaml のひな型を書く
  openshain run "<依頼>"          依頼を Work として進める
  openshain tools list           使える Tool の一覧
  openshain work list            Work の一覧
  openshain work show <id>       Work の詳細
  openshain work resume <id>     途中で止まった Work を続ける

  --workspace <dir>              起点のディレクトリ。省略時はカレントディレクトリ
                                 init はそこに書き、他のコマンドはそこから上に openshain.yaml を探す`;

/** The providers this CLI knows, by the ids used in openshain.yaml. */
const providers: RuntimeProviders = {
  models: { anthropic: (model) => anthropicProvider(model) },
  tools: { standard: () => standardTools() },
};

async function main(argv: string[]): Promise<number> {
  const write = (line: string) => console.log(line);
  let values: { workspace?: string; help?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: argv,
      options: { workspace: { type: "string" }, help: { type: "boolean", short: "h" } },
      allowPositionals: true,
    }));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const option = /'(-[^']*)'/.exec(message)?.[1];
    const unknown = (err as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && option;
    write(unknown ? `不明なオプション ${option}` : `引数を解釈できません。${message}`);
    write(USAGE);
    return 2;
  }
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    write(USAGE);
    return values.help ? 0 : 2;
  }
  switch (command) {
    case "init":
      await init({ workspaceRoot: values.workspace ?? process.cwd(), write });
      return 0;
    case "run": {
      const objective = rest.join(" ").trim();
      if (!objective) {
        write('依頼の文を指定してください。openshain run "今月の経理を進めて" のように。');
        return 2;
      }
      const workspaceRoot = await findWorkspace(values.workspace ?? process.cwd());
      return withTerminal((ask) =>
        run({ workspaceRoot, providers, objective, write, ...(ask && { ask }) }),
      );
    }
    case "tools": {
      if (rest[0] !== "list") {
        write(USAGE);
        return 2;
      }
      const workspaceRoot = await findWorkspace(values.workspace ?? process.cwd());
      await toolsList({ workspaceRoot, providers, write });
      return 0;
    }
    case "work": {
      const sub = rest[0];
      const id = rest[1] ?? "";
      if (!(sub === "list" || ((sub === "show" || sub === "resume") && id))) {
        write(USAGE);
        return 2;
      }
      const workspaceRoot = await findWorkspace(values.workspace ?? process.cwd());
      if (sub === "list") {
        await workList({ workspaceRoot, write });
        return 0;
      }
      if (sub === "show") {
        await workShow({ workspaceRoot, id, write });
        return 0;
      }
      return withTerminal((ask) =>
        workResume({ workspaceRoot, providers, id, write, ...(ask && { ask }) }),
      );
    }
    default:
      write(`不明なコマンド ${command}`);
      write(USAGE);
      return 2;
  }
}

/** Runs `fn` with a way to ask the person when a terminal is there to answer; otherwise without one. */
async function withTerminal(
  fn: (ask?: (question: string) => Promise<string>) => Promise<number>,
): Promise<number> {
  // Without a terminal there is no one to answer; the work waits instead.
  if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) return fn();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await fn((question) => rl.question(`${question}\n> `));
  } finally {
    rl.close();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (isOpenshainError(err)) {
      const heading = errorLabel(err.code);
      console.error(`エラー(${err.code}) ${heading ? `${heading}。` : ""}${err.message}`);
    } else {
      console.error(err);
    }
    process.exit(1);
  },
);
