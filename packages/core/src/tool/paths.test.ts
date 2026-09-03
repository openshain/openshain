import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import { resolveWorkspacePath } from "./paths.ts";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "openshain-paths-"));
  await mkdir(join(root, "receipts"));
  await writeFile(join(root, "receipts", "2026-07.csv"), "a,b\n");
  await writeFile(join(root, "openshain.yaml"), "version: 1\n");
  await mkdir(join(root, "work"));
  return realpath(root);
}

async function rejected(fn: () => Promise<unknown>): Promise<OpenshainError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OpenshainError);
    return err as OpenshainError;
  }
  throw new Error("expected a rejection");
}

describe("resolveWorkspacePath", () => {
  test("resolves a relative path inside the workspace", async () => {
    const root = await workspace();

    expect(await resolveWorkspacePath(root, "receipts/2026-07.csv")).toBe(
      join(root, "receipts", "2026-07.csv"),
    );
  });

  test("accepts a path to a file that does not exist yet", async () => {
    const root = await workspace();

    expect(await resolveWorkspacePath(root, "receipts/summary.md")).toBe(
      join(root, "receipts", "summary.md"),
    );
  });

  test("normalizes ./ segments", async () => {
    const root = await workspace();

    expect(await resolveWorkspacePath(root, "./receipts/./2026-07.csv")).toBe(
      join(root, "receipts", "2026-07.csv"),
    );
  });

  test.each(["../secret.txt", "receipts/../../secret.txt", "/etc/passwd"])(
    "rejects %s as outside the workspace",
    async (input) => {
      const root = await workspace();

      const err = await rejected(() => resolveWorkspacePath(root, input));

      expect(err.code).toBe("invalid_path");
      expect(err.message).toContain(input);
    },
  );

  test.each(["openshain.yaml", "work", "work/work_x/events.jsonl", "./work/../work/lock"])(
    "rejects the reserved path %s",
    async (input) => {
      const root = await workspace();

      const err = await rejected(() => resolveWorkspacePath(root, input));

      expect(err.code).toBe("invalid_path");
      expect(err.message).toContain("reserved");
    },
  );

  test("rejects a symlink that points outside the workspace", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "openshain-outside-"));
    await writeFile(join(outside, "secret.txt"), "x");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));

    const err = await rejected(() => resolveWorkspacePath(root, "link.txt"));

    expect(err.code).toBe("invalid_path");
  });

  test("rejects a new file under a symlinked directory that points outside", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "openshain-outside-"));
    await symlink(outside, join(root, "shared"));

    const err = await rejected(() => resolveWorkspacePath(root, "shared/new.md"));

    expect(err.code).toBe("invalid_path");
  });

  test("accepts a symlink that stays inside the workspace", async () => {
    const root = await workspace();
    await symlink(join(root, "receipts"), join(root, "alias"));

    expect(await resolveWorkspacePath(root, "alias/2026-07.csv")).toBe(
      join(root, "receipts", "2026-07.csv"),
    );
  });

  test("rejects an empty path", async () => {
    const root = await workspace();

    const err = await rejected(() => resolveWorkspacePath(root, ""));

    expect(err.code).toBe("invalid_path");
  });
});
