import { constants } from "node:fs";
import { mkdir, open, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import { KNOWLEDGE_DIR_NAME } from "./check.ts";

/**
 * Touching the files under `knowledge/`. The tools cannot reach them — it is a reserved path, so
 * that what the index filters cannot be read around — which leaves the runtime to read and write
 * them itself, without the guard the tools go through. These functions are that guard: the
 * directory must be the one inside the company folder, and a link must never carry a write.
 */

/** How large a file under `knowledge/` may be for the runtime to read it whole. */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * The directory the path names inside `knowledge/`, once it is known to be that directory. A
 * link left in the folder would otherwise send a write anywhere the person can write.
 */
async function directory(workspaceRoot: string, parts: string[]): Promise<string> {
  const root = await realpath(workspaceRoot);
  const dir = join(root, KNOWLEDGE_DIR_NAME, ...parts);
  await mkdir(dir, { recursive: true });
  if ((await realpath(dir)) !== dir) {
    throw new OpenshainError(
      "invalid_path",
      `${[KNOWLEDGE_DIR_NAME, ...parts].join("/")} leads out of the company folder; nothing was written`,
    );
  }
  return dir;
}

/**
 * Writes a file under `knowledge/` through a temporary file renamed into place, so a reader
 * never sees half of one. The temporary name is easy to guess, so it is opened without following
 * a link.
 */
export async function writeKnowledgeFile(
  workspaceRoot: string,
  parts: string[],
  text: string,
): Promise<void> {
  const name = parts.at(-1) as string;
  const dir = await directory(workspaceRoot, parts.slice(0, -1));
  const path = join(dir, name);
  const temporary = `${path}.writing`;
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(temporary, flags, 0o644);
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

/** Reads a file under `knowledge/`, or nothing when it is missing, a link, or too large. */
export async function readKnowledgeFile(
  workspaceRoot: string,
  parts: string[],
): Promise<string | undefined> {
  const path = join(workspaceRoot, KNOWLEDGE_DIR_NAME, ...parts);
  try {
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const { size } = await handle.stat();
      if (size > MAX_BYTES) return undefined;
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}

/** Where a file under `knowledge/` is, for a message a person reads. */
export function knowledgePath(parts: string[]): string {
  return [KNOWLEDGE_DIR_NAME, ...parts].join("/");
}
