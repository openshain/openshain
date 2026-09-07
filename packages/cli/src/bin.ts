#!/usr/bin/env node
import { parseArgs } from "node:util";
import { anthropicProvider, openaiCompatibleProvider } from "@openshain/agent";
import { isOpenshainError, type RuntimeProviders } from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { init } from "./commands/init.ts";
import { mcp } from "./commands/mcp.ts";
import { toolsList } from "./commands/tools.ts";
import { workList, workShow } from "./commands/work.ts";
import { plain } from "./format.ts";
import { errorLabel } from "./labels.ts";
import { startTui } from "./tui/index.ts";
import { findWorkspace } from "./workspace.ts";

const USAGE = `使い方:
  openshain                      端末で対話を始める
  openshain init                 openshain.yaml のひな型を書く
  openshain tools list           使える Tool の一覧
  openshain work list            Work の一覧
  openshain work show <id>       Work の詳細
  openshain mcp                  MCP Server を stdio で起動する

  --workspace <dir>              起点のディレクトリ。省略時はカレントディレクトリ
                                 init はそこに書き、他のコマンドはそこから上に openshain.yaml を探す`;

/** The providers this CLI knows, by the ids used in openshain.yaml. */
const providers: RuntimeProviders = {
  models: {
    anthropic: (model) => anthropicProvider(model),
    "openai-compatible": (model) => openaiCompatibleProvider(model),
  },
  tools: { standard: () => standardTools() },
};

async function main(argv: string[]): Promise<number> {
  const write = (line: string) => console.log(plain(line));
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
  if (!command && !values.help && process.stdin.isTTY === true && process.stdout.isTTY === true) {
    const workspaceRoot = await findWorkspace(values.workspace ?? process.cwd());
    return startTui({ workspaceRoot, providers });
  }
  if (values.help || !command) {
    write(USAGE);
    return values.help ? 0 : 2;
  }
  switch (command) {
    case "init":
      await init({ workspaceRoot: values.workspace ?? process.cwd(), write });
      return 0;
    case "mcp": {
      const workspaceRoot = await findWorkspace(values.workspace ?? process.cwd());
      await mcp({ workspaceRoot, providers });
      return 0;
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
      if (!(sub === "list" || (sub === "show" && id))) {
        write(USAGE);
        return 2;
      }
      const workspaceRoot = await findWorkspace(values.workspace ?? process.cwd());
      if (sub === "list") {
        await workList({ workspaceRoot, write });
        return 0;
      }
      await workShow({ workspaceRoot, id, write });
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
    if (isOpenshainError(err)) {
      const heading = errorLabel(err.code);
      console.error(plain(`エラー(${err.code}) ${heading ? `${heading}。` : ""}${err.message}`));
    } else {
      console.error(err);
    }
    process.exit(1);
  },
);
