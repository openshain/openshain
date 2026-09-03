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

async function outsideDir() {
  return mkdtemp(join(tmpdir(), "openshain-outside-"));
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

  test("accepts a new file in a directory that does not exist yet", async () => {
    const root = await workspace();

    expect(await resolveWorkspacePath(root, "reports/2026/summary.md")).toBe(
      join(root, "reports", "2026", "summary.md"),
    );
  });

  test("normalizes ./ segments and resolves . to the root", async () => {
    const root = await workspace();

    expect(await resolveWorkspacePath(root, "./receipts/./2026-07.csv")).toBe(
      join(root, "receipts", "2026-07.csv"),
    );
    expect(await resolveWorkspacePath(root, ".")).toBe(root);
  });

  test.each(["../secret.txt", "receipts/../../secret.txt"])(
    "rejects %s as outside the workspace",
    async (input) => {
      const root = await workspace();

      const err = await rejected(() => resolveWorkspacePath(root, input));

      expect(err.code).toBe("outside_workspace");
      expect(err.message).toContain(input);
    },
  );

  test("rejects an absolute path", async () => {
    const root = await workspace();

    const err = await rejected(() => resolveWorkspacePath(root, "/etc/passwd"));

    expect(err.code).toBe("invalid_path");
  });

  test.each(["openshain.yaml", "work", "work/work_x/events.jsonl", "./work/../work/lock"])(
    "rejects the reserved path %s",
    async (input) => {
      const root = await workspace();

      const err = await rejected(() => resolveWorkspacePath(root, input));

      expect(err.code).toBe("reserved_path");
    },
  );

  test.each([".git/hooks/pre-commit", ".github/workflows/ci.yml", ".env", "receipts/.hidden/x"])(
    "rejects the hidden path %s",
    async (input) => {
      const root = await workspace();

      const err = await rejected(() => resolveWorkspacePath(root, input));

      expect(err.code).toBe("reserved_path");
    },
  );

  test("allows a reserved name below the top level", async () => {
    const root = await workspace();

    expect(await resolveWorkspacePath(root, "receipts/work/notes.md")).toBe(
      join(root, "receipts", "work", "notes.md"),
    );
  });

  test("rejects a symlink that points outside the workspace", async () => {
    const root = await workspace();
    const outside = await outsideDir();
    await writeFile(join(outside, "secret.txt"), "x");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));

    const err = await rejected(() => resolveWorkspacePath(root, "link.txt"));

    expect(err.code).toBe("outside_workspace");
  });

  test("rejects a new file under a symlinked directory that points outside", async () => {
    const root = await workspace();
    const outside = await outsideDir();
    await symlink(outside, join(root, "shared"));

    const err = await rejected(() => resolveWorkspacePath(root, "shared/new.md"));

    expect(err.code).toBe("outside_workspace");
  });

  test("judges a dangling symlink by where it points, not by what exists", async () => {
    const root = await workspace();
    const outside = await outsideDir();
    await symlink(join(outside, "evil.txt"), join(root, "output.md"));
    await symlink(join(root, "work", "pwned.txt"), join(root, "latest-report.md"));

    expect((await rejected(() => resolveWorkspacePath(root, "output.md"))).code).toBe(
      "outside_workspace",
    );
    expect((await rejected(() => resolveWorkspacePath(root, "latest-report.md"))).code).toBe(
      "reserved_path",
    );
  });

  test("accepts a symlink that stays inside the workspace and returns the real path", async () => {
    const root = await workspace();
    await symlink(join(root, "receipts"), join(root, "alias"));

    expect(await resolveWorkspacePath(root, "alias/2026-07.csv")).toBe(
      join(root, "receipts", "2026-07.csv"),
    );
  });

  test("accepts a relative symlink that stays inside the workspace", async () => {
    const root = await workspace();
    await symlink("receipts", join(root, "rel-alias"));

    expect(await resolveWorkspacePath(root, "rel-alias/new.csv")).toBe(
      join(root, "receipts", "new.csv"),
    );
  });

  test("rejects a symlink named like an alias of a reserved directory", async () => {
    const root = await workspace();
    await symlink(join(root, "work"), join(root, "alias-to-work"));

    const err = await rejected(() => resolveWorkspacePath(root, "alias-to-work/lock"));

    expect(err.code).toBe("reserved_path");
  });

  test("rejects a symlink loop as an invalid path, not a raw error", async () => {
    const root = await workspace();
    await symlink(join(root, "loop-b"), join(root, "loop-a"));
    await symlink(join(root, "loop-a"), join(root, "loop-b"));

    const err = await rejected(() => resolveWorkspacePath(root, "loop-a/file.txt"));

    expect(err.code).toBe("invalid_path");
    expect(err.message).toContain("symbolic links");
  });

  test("rejects a path that treats a file as a directory, as an invalid path", async () => {
    const root = await workspace();

    const err = await rejected(() =>
      resolveWorkspacePath(root, "receipts/2026-07.csv/nested/file.txt"),
    );

    expect(err.code).toBe("invalid_path");
    expect(err.message).toContain("not a directory");
  });

  test("rejects an empty path", async () => {
    const root = await workspace();

    expect((await rejected(() => resolveWorkspacePath(root, ""))).code).toBe("invalid_path");
  });

  test("rejects a workspace root that does not exist", async () => {
    const err = await rejected(() =>
      resolveWorkspacePath(join(tmpdir(), "openshain-missing-root"), "a.txt"),
    );

    expect(err.code).toBe("invalid_path");
  });
});
