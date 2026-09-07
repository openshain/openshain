import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isNode, LineCounter, parseDocument } from "yaml";
import { OpenshainError } from "../errors.ts";
import { type Config, ConfigFileSchema, toConfig } from "./schema.ts";

export const CONFIG_FILE_NAME = "openshain.yaml";

export interface ParseConfigOptions {
  /** Provider ids the runtime can construct. When given, other names are rejected. */
  modelProviders?: readonly string[];
  /** Name used in error messages. Defaults to openshain.yaml. */
  fileName?: string;
}

export async function loadConfig(
  workspaceRoot: string,
  options: Omit<ParseConfigOptions, "fileName"> = {},
): Promise<Config> {
  const fileName = join(workspaceRoot, CONFIG_FILE_NAME);
  let text: string;
  try {
    text = await readFile(fileName, "utf8");
  } catch (cause) {
    throw new OpenshainError("config", `${CONFIG_FILE_NAME} not found in ${workspaceRoot}`, {
      cause,
    });
  }
  return parseConfig(text, { ...options, fileName });
}

export function parseConfig(text: string, options: ParseConfigOptions = {}): Config {
  const fileName = options.fileName ?? CONFIG_FILE_NAME;
  const lineCounter = new LineCounter();
  let doc: ReturnType<typeof parseDocument>;
  let data: unknown;
  try {
    doc = parseDocument(text, { lineCounter });
    data = doc.errors.length > 0 ? undefined : doc.toJS();
  } catch (cause) {
    // yaml refuses resource-exhaustion documents (alias bombs) with a plain error
    throw new OpenshainError("config", `${fileName}: ${(cause as Error).message}`, { cause });
  }

  if (doc.errors.length > 0) {
    const lines = doc.errors.map((error) => {
      const pos = error.linePos?.[0] ?? { line: 0, col: 0 };
      return `${fileName}:${pos.line}:${pos.col} ${firstLine(error.message)}`;
    });
    throw new OpenshainError("config", lines.join("\n"));
  }

  const locate = (path: readonly PropertyKey[]): { line: number; col: number } => {
    for (let i = path.length; i >= 0; i--) {
      const node = i === 0 ? doc.contents : doc.getIn(path.slice(0, i), true);
      if (isNode(node) && node.range) return lineCounter.linePos(node.range[0]);
    }
    return { line: 1, col: 1 };
  };
  const problem = (path: readonly PropertyKey[], message: string): string => {
    const { line, col } = locate(path);
    const where = path.length === 0 ? "<root>" : path.map(String).join(".");
    return `${fileName}:${line}:${col} ${where}: ${message}`;
  };

  const result = ConfigFileSchema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => problem(issue.path, issue.message));
    throw new OpenshainError("config", problems.join("\n"));
  }

  const known = options.modelProviders;
  if (known && result.data.model && !known.includes(result.data.model.provider)) {
    throw new OpenshainError(
      "config",
      problem(
        ["model", "provider"],
        `unknown provider "${result.data.model.provider}"; known providers: ${known.length > 0 ? known.join(", ") : "none"}`,
      ),
    );
  }

  return toConfig(result.data);
}

function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? message;
}
