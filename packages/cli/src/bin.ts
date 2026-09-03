#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { isOpenshainError, type RuntimeProviders } from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { init } from "./commands/init.ts";
import { run } from "./commands/run.ts";
import { toolsList } from "./commands/tools.ts";
import { findWorkspace } from "./workspace.ts";

const USAGE = `使い方:
  openshain init                 openshain.yaml のひな型を書く
  openshain run "<依頼>"          依頼を Work として進める
  openshain tools list           使える Tool の一覧

  --workspace <dir>              workspace を指定する。省略時はカレントディレクトリから上に探す`;

/** Model providers arrive with their own packages; until then only the standard tools are wired. */
const providers: RuntimeProviders = {
  models: {},
  tools: { standard: () => standardTools() },
};

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { workspace: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  const write = (line: string) => console.log(line);
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    write(USAGE);
    return command ? 0 : 2;
  }
  switch (command) {
    case "init":
      await init({ workspaceRoot: values.workspace ?? process.cwd(), write });
      return 0;
    case "run": {
      const objective = rest.join(" ").trim();
      if (!objective) {
        write('依頼の文を指定してください。例: openshain run "今月の経理を進めて"');
        return 2;
      }
      const workspaceRoot = await findWorkspace(values.workspace ?? process.cwd());
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await run({
          workspaceRoot,
          providers,
          objective,
          write,
          ask: (question) => rl.question(`${question}\n> `),
        });
      } finally {
        rl.close();
      }
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
    default:
      write(`不明なコマンド ${command}`);
      write(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (isOpenshainError(err)) console.error(`エラー(${err.code}) ${err.message}`);
    else console.error(err);
    process.exit(1);
  },
);
