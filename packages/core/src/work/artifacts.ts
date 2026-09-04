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
