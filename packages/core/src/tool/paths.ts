import { lstat, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { OpenshainError } from "../errors.ts";

/** Paths the runtime keeps for itself. Tools may not read or write them. */
export const RESERVED_PATHS = ["openshain.yaml", "work"] as const;

const MAX_SYMLINK_HOPS = 32;

/**
 * Turns a tool-supplied relative path into an absolute path inside the workspace.
 *
 * Rejects absolute paths, `..` escapes, the reserved paths, every hidden entry
 * (a segment starting with `.`, which covers `.git`, `.github`, `.env` and the
 * like) and symbolic links that lead outside. Links are followed one hop at a
 * time by reading them, so a link whose target does not exist yet is judged by
 * where it points, not by what happens to exist. The target itself may not
 * exist yet. Every failure is an OpenshainError.
 *
 * The result is a string: nothing stops the filesystem from changing between
 * this check and the file operation. Tools that write should open with
 * O_NOFOLLOW where the platform allows it.
 */
export async function resolveWorkspacePath(root: string, input: string): Promise<string> {
  if (input === "") throw new OpenshainError("invalid_path", 'empty path: ""');
  if (isAbsolute(input)) {
    throw new OpenshainError("invalid_path", `absolute paths are not allowed: "${input}"`);
  }
  let rootReal: string;
  try {
    rootReal = await realpath(root);
  } catch (cause) {
    throw new OpenshainError("invalid_path", `workspace root is not accessible: "${root}"`, {
      cause,
    });
  }
  return walk(rootReal, normalize(input), input, 0);
}

async function walk(rootReal: string, rel: string, input: string, hops: number): Promise<string> {
  if (rel === ".." || rel.startsWith(`..${sep}`)) {
    throw new OpenshainError("outside_workspace", `path escapes the workspace: "${input}"`);
  }
  const segments = rel === "." ? [] : rel.split(sep);
  for (const segment of segments) {
    if ((RESERVED_PATHS as readonly string[]).includes(segment) && segment === segments[0]) {
      throw new OpenshainError("reserved_path", `reserved path: "${input}"`);
    }
    if (segment.startsWith(".")) {
      throw new OpenshainError("reserved_path", `hidden paths are reserved: "${input}"`);
    }
  }

  let current = rootReal;
  for (let i = 0; i < segments.length; i++) {
    const candidate = join(current, segments[i] ?? "");
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(candidate);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return join(candidate, ...segments.slice(i + 1));
      throw new OpenshainError("invalid_path", `cannot resolve "${input}": ${code ?? "error"}`, {
        cause: err,
      });
    }
    if (stats.isSymbolicLink()) {
      if (hops >= MAX_SYMLINK_HOPS) {
        throw new OpenshainError("invalid_path", `too many symbolic links: "${input}"`);
      }
      const target = resolve(dirname(candidate), await readlink(candidate));
      const rest = segments.slice(i + 1);
      const next = normalize(join(relative(rootReal, target) || ".", ...rest));
      return walk(rootReal, next, input, hops + 1);
    }
    if (i < segments.length - 1 && !stats.isDirectory()) {
      throw new OpenshainError("invalid_path", `not a directory: "${input}"`);
    }
    current = candidate;
  }
  return current;
}
