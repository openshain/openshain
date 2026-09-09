import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { resolveWorkspacePath } from "./paths.ts";

/**
 * Reading and writing a file of the company folder. Everything that reaches a file on behalf of
 * a tool goes through here, so the path guard and the size limit are applied in one place rather
 * than remembered at each call. A caller that opens a file itself is a caller that can forget.
 */

/** The most a tool reads from one file. Larger files are refused, not truncated. */
export const MAX_READ_BYTES = 1024 * 1024;

/** The most a tool writes to one file. */
export const MAX_WRITE_BYTES = MAX_READ_BYTES;

/**
 * Reads a text file through one descriptor: the size check and the read see the same file, so a
 * swap between the two cannot slip a larger file past the limit.
 */
export async function readWorkspaceText(root: string, path: string): Promise<string> {
  const resolved = await resolveWorkspacePath(root, path);
  let handle: FileHandle;
  try {
    handle = await open(resolved, "r");
  } catch (err) {
    throw new Error(`cannot read "${path}": ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  try {
    const { size } = await handle.stat();
    if (size > MAX_READ_BYTES) {
      throw new Error(`"${path}" is too large to read (${size} bytes, limit ${MAX_READ_BYTES})`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** The same read, but a file that is missing, too large or unreadable comes back as undefined. */
export async function readWorkspaceTextIfAny(
  root: string,
  path: string,
): Promise<string | undefined> {
  try {
    return await readWorkspaceText(root, path);
  } catch {
    return undefined;
  }
}

/** Writes through a descriptor opened with O_NOFOLLOW, so the final component may not be a symlink. */
export async function writeWorkspaceText(
  root: string,
  path: string,
  content: string,
): Promise<{ path: string; sha256: string }> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`"${path}" is too large to write (${bytes} bytes, limit ${MAX_WRITE_BYTES})`);
  }
  const resolved = await resolveWorkspacePath(root, path);
  const rootReal = await resolveWorkspacePath(root, ".");
  await mkdir(dirname(resolved), { recursive: true });
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(resolved, flags, 0o644);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return {
    path: relative(rootReal, resolved),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}
