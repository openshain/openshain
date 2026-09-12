import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { TextDecoder } from "node:util";
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
 * The most a tool reads from one file that is not text. A PDF carries its fonts and its scans,
 * so its bytes say little about how much of it reaches the model: only the words do, and the
 * result's own limit holds those.
 */
export const MAX_BINARY_READ_BYTES = 20 * 1024 * 1024;

/**
 * The encodings a file of a company folder is read as, in order. A Japanese company's files are
 * not all UTF-8: a bank's CSV, a card statement and a spreadsheet's export are usually Shift_JIS.
 */
const TEXT_ENCODINGS = ["utf-8", "shift_jis"];

/**
 * The text of these bytes, or nothing when they are text in none of those encodings. Each is
 * tried strictly, so bytes that fit none come back as nothing rather than as replacement
 * characters. Mojibake is the worse outcome: it reaches the model looking like a supplier's
 * name, and gets written into the ledger as one.
 */
export function textOf(bytes: Buffer): string | undefined {
  for (const encoding of TEXT_ENCODINGS) {
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch {
      // Not this encoding. The last one to fail leaves nothing.
    }
  }
  return undefined;
}

/**
 * Reads a file through one descriptor: the size check and the read see the same file, so a swap
 * between the two cannot slip a larger file past the limit.
 */
async function bytesOf(root: string, path: string, limit: number): Promise<Buffer> {
  const resolved = await resolveWorkspacePath(root, path);
  let handle: FileHandle;
  try {
    handle = await open(resolved, "r");
  } catch (err) {
    throw new Error(`cannot read "${path}": ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  try {
    const { size } = await handle.stat();
    if (size > limit) {
      throw new Error(`"${path}" is too large to read (${size} bytes, limit ${limit})`);
    }
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

/** The text of a file of the company folder. Bytes that are text in no encoding are refused. */
export async function readWorkspaceText(root: string, path: string): Promise<string> {
  const text = textOf(await bytesOf(root, path, MAX_READ_BYTES));
  if (text === undefined) {
    throw new Error(`"${path}" is not text: its bytes are neither ${TEXT_ENCODINGS.join(" nor ")}`);
  }
  return text;
}

/** The bytes of a file of the company folder, for a tool that reads a format rather than text. */
export function readWorkspaceBytes(root: string, path: string): Promise<Buffer> {
  return bytesOf(root, path, MAX_BINARY_READ_BYTES);
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
