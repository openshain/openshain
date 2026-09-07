import { isNode, LineCounter, parseDocument } from "yaml";
import type { z } from "zod";
import { OpenshainError } from "../errors.ts";

/** Where a problem in a YAML file is, as `file:line:col path: message`. */
export type Problem = (path: readonly PropertyKey[], message: string) => string;

/**
 * Parses a YAML file against a zod schema. Every problem is reported with its line and column
 * and the path of the field, so that a person can fix the file. Returns the data together with
 * `problem`, for checks the caller adds after parsing.
 */
export function parseYamlFile<T extends z.ZodType>(
  text: string,
  schema: T,
  fileName: string,
): { data: z.output<T>; problem: Problem } {
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
  const problem: Problem = (path, message) => {
    const { line, col } = locate(path);
    const where = path.length === 0 ? "<root>" : path.map(String).join(".");
    return `${fileName}:${line}:${col} ${where}: ${message}`;
  };

  const result = schema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => problem(issue.path, issue.message));
    throw new OpenshainError("config", problems.join("\n"));
  }
  return { data: result.data, problem };
}

function firstLine(message: string): string {
  return message.split("\n", 1)[0] ?? message;
}
