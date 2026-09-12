import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_READ_BYTES,
  readWorkspaceText,
  readWorkspaceTextIfAny,
  writeWorkspaceText,
} from "./files.ts";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "openshain-files-"));
  await mkdir(join(root, "receipts"));
  await writeFile(join(root, "receipts", "2026-07.csv"), "date,amount\n2026-07-01,100\n");
  return root;
}

describe("a file of the company folder", () => {
  test("a file a Japanese bank wrote is read as its own text, not as mojibake", async () => {
    const root = await workspace();
    // Shift_JIS for 日付,摘要,金額 and one row naming a company: what a bank's CSV download holds.
    const bytes = Buffer.from([
      0x93, 0xfa, 0x95, 0x74, 0x2c, 0x93, 0x45, 0x97, 0x76, 0x2c, 0x8b, 0xe0, 0x8a, 0x7a, 0x0a,
      0x32, 0x30, 0x32, 0x36, 0x2d, 0x30, 0x37, 0x2d, 0x30, 0x33, 0x2c, 0x8a, 0x94, 0x8e, 0xae,
      0x89, 0xef, 0x8e, 0xd0, 0x2c, 0x31, 0x33, 0x32, 0x30, 0x30, 0x30, 0x0a,
    ]);
    await writeFile(join(root, "bank.csv"), bytes);

    const text = await readWorkspaceText(root, "bank.csv");

    expect(text).toBe("日付,摘要,金額\n2026-07-03,株式会社,132000\n");
    expect(text).not.toContain("\ufffd");
  });

  test("a file that is not text at all is refused, rather than read as characters", async () => {
    const root = await workspace();
    await writeFile(join(root, "receipt.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]));

    await expect(readWorkspaceText(root, "receipt.png")).rejects.toThrow(/is not text/);
  });

  test("is read and written through the guard, and a write reports where it landed", async () => {
    const root = await workspace();

    expect(await readWorkspaceText(root, "receipts/2026-07.csv")).toContain("2026-07-01,100");
    const after = await writeWorkspaceText(root, "ledger/2026-07.csv", "date,amount\n");

    expect(after.path).toBe("ledger/2026-07.csv");
    expect(after.sha256).toHaveLength(64);
    expect(await readFile(join(root, "ledger", "2026-07.csv"), "utf8")).toBe("date,amount\n");
  });

  test("outside the workspace, a reserved path and a hidden entry are refused, reading and writing alike", async () => {
    const root = await workspace();
    await mkdir(join(root, "work"), { recursive: true });
    await writeFile(join(root, "work", "note.txt"), "内部");

    for (const path of ["../outside.txt", "/etc/hostname", "work/note.txt", ".env"]) {
      await expect(readWorkspaceText(root, path)).rejects.toThrow();
      await expect(writeWorkspaceText(root, path, "x")).rejects.toThrow();
    }
  });

  test("a symlink that leads out of the workspace is refused", async () => {
    const root = await workspace();
    const outside = await mkdtemp(join(tmpdir(), "openshain-outside-"));
    await writeFile(join(outside, "secret.txt"), "秘密");
    await symlink(join(outside, "secret.txt"), join(root, "link.txt"));

    await expect(readWorkspaceText(root, "link.txt")).rejects.toThrow();
  });

  test("a file over the limit is refused rather than truncated", async () => {
    const root = await workspace();
    await writeFile(join(root, "big.txt"), "あ".repeat(MAX_READ_BYTES));

    await expect(readWorkspaceText(root, "big.txt")).rejects.toThrow(/too large to read/);
    await expect(writeWorkspaceText(root, "big2.txt", "あ".repeat(MAX_READ_BYTES))).rejects.toThrow(
      /too large to write/,
    );
  });

  test("the forgiving read says nothing for a file that is missing, refused or too large", async () => {
    const root = await workspace();

    expect(await readWorkspaceTextIfAny(root, "receipts/2026-07.csv")).toContain("amount");
    expect(await readWorkspaceTextIfAny(root, "receipts/2026-08.csv")).toBeUndefined();
    expect(await readWorkspaceTextIfAny(root, "../outside.txt")).toBeUndefined();
  });
});
