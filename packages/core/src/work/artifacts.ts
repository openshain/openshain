import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolveWorkspacePath } from "../tool/paths.ts";
import type { Artifact } from "./events.ts";

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
    const resolved = await resolveWorkspacePath(root, path);
    const sha256 = createHash("sha256")
      .update(await readFile(resolved))
      .digest("hex");
    return { path, sha256 };
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
    const resolved = await resolveWorkspacePath(root, path);
    return createHash("sha256")
      .update(await readFile(resolved))
      .digest("hex");
  } catch {
    return null;
  }
}
