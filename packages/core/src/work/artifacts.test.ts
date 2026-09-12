import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_READ_BYTES } from "../tool/files.ts";
import { hashWorkspaceFile, verifyArtifact } from "./artifacts.ts";

async function workspace() {
  return await mkdtemp(join(tmpdir(), "openshain-artifacts-"));
}

describe("what a file of the company folder holds", () => {
  test("is hashed however large it is, since the path is the model's to name", async () => {
    const root = await workspace();
    // Larger than a tool may read as text: hashing does not hold the file, so it has no such limit.
    const body = "あ".repeat(MAX_READ_BYTES);
    await writeFile(join(root, "big.csv"), body);

    const hash = await hashWorkspaceFile(root, "big.csv");

    expect(hash).toBe(createHash("sha256").update(body).digest("hex"));
  });

  test("is nothing when the file is not there, and nothing outside the company folder", async () => {
    const root = await workspace();

    expect(await hashWorkspaceFile(root, "missing.csv")).toBeNull();
    expect(await hashWorkspaceFile(root, "../outside.csv")).toBeNull();
  });

  test("an artifact keeps what was reported and is marked missing when it cannot be read", async () => {
    const root = await workspace();
    await writeFile(join(root, "summary.md"), "done\n");

    const there = await verifyArtifact(root, "summary.md", "whatever was claimed");
    const gone = await verifyArtifact(root, "nothing.md", "claimed");

    expect(there).toEqual({
      path: "summary.md",
      sha256: createHash("sha256").update("done\n").digest("hex"),
    });
    expect(gone).toEqual({ path: "nothing.md", sha256: "claimed", missing: true });
  });
});
