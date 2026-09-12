import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolveWorkspacePath } from "../tool/paths.ts";
import type { Artifact } from "./events.ts";

/**
 * The hash of a file of the company folder, read a piece at a time. The path comes from the
 * model: the artifact a work says it wrote, or the file a held call would write. Holding such a
 * file whole would put whatever size it names into memory, so it is read as a stream and only
 * the digest is kept.
 */
async function hashOf(root: string, path: string): Promise<string> {
  const resolved = await resolveWorkspacePath(root, path);
  const hash = createHash("sha256");
  for await (const piece of createReadStream(resolved)) hash.update(piece as Buffer);
  return hash.digest("hex");
}

/**
 * The artifact as it is now. The runtime computes the hash rather than taking anyone's word.
 * When the file cannot be read, because a later call moved or deleted it or because nobody
 * wrote it, the artifact keeps the hash that was reported and is marked missing.
 */
export async function verifyArtifact(
  root: string,
  path: string,
  reported: string,
): Promise<Artifact> {
  try {
    return { path, sha256: await hashOf(root, path) };
  } catch {
    return { path, sha256: reported, missing: true };
  }
}

/**
 * What a file of the company folder holds now, as a hash, or null when it is not there. Used to
 * hold on to what a person was looking at when they approved a write, so the write can be
 * refused if the file has moved on since.
 */
export async function hashWorkspaceFile(root: string, path: string): Promise<string | null> {
  try {
    return await hashOf(root, path);
  } catch {
    return null;
  }
}
