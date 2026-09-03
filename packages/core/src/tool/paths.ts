import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { OpenshainError } from "../errors.ts";

/** Paths the runtime keeps for itself. Tools may not read or write them. */
export const RESERVED_PATHS = ["openshain.yaml", "work"] as const;

/**
 * Turns a tool-supplied relative path into an absolute path inside the workspace.
 * Rejects absolute paths, `..` escapes, reserved paths and symlinks that lead outside.
 * The target itself may not exist yet; its nearest existing ancestor is checked instead.
 */
export async function resolveWorkspacePath(root: string, input: string): Promise<string> {
  const reject = (why: string) => new OpenshainError("invalid_path", `${why}: "${input}"`);

  if (input === "") throw reject("empty path");
  if (isAbsolute(input)) throw reject("absolute paths are not allowed");
  const rel = normalize(input);
  if (rel === ".." || rel.startsWith(`..${sep}`)) throw reject("path escapes the workspace");
  if (isReserved(rel)) throw reject("reserved path");

  const rootReal = await realpath(root);
  const { real, remainder } = await realpathOfNearestExisting(resolve(rootReal, rel));
  const finalPath = remainder ? join(real, remainder) : real;
  if (finalPath !== rootReal && !finalPath.startsWith(rootReal + sep)) {
    throw reject("path resolves outside the workspace");
  }
  if (isReserved(relative(rootReal, finalPath))) throw reject("reserved path");
  return finalPath;
}

function isReserved(rel: string): boolean {
  const first = rel.split(sep)[0];
  return (RESERVED_PATHS as readonly string[]).includes(first ?? "");
}

async function realpathOfNearestExisting(
  target: string,
): Promise<{ real: string; remainder: string }> {
  let existing = target;
  for (;;) {
    try {
      return { real: await realpath(existing), remainder: relative(existing, target) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const parent = dirname(existing);
      if (parent === existing) throw err;
      existing = parent;
    }
  }
}
