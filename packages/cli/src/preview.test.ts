import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewCall } from "./preview.ts";

const kinds = (lines: { kind: string; text: string }[]) => lines.map((l) => `${l.kind}:${l.text}`);

describe("previewCall", () => {
  test("a new file is all additions, with a note naming it", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-preview-"));

    const lines = await previewCall(root, {
      name: "fs_write",
      input: { path: "ledger/2026-07.csv", content: "a,b\n1,2\n" },
    });

    expect(kinds(lines)).toEqual([
      "note:ledger/2026-07.csv を新しく作ります(3 行)",
      "added:a,b",
      "added:1,2",
      "added:",
    ]);
  });

  test("an existing file is a diff with context, and unchanged runs are summarized", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-preview-"));
    const before = ["h", "1", "2", "3", "4", "5", "6", "7", "8", "9"].join("\n");
    await writeFile(join(root, "ledger.csv"), before);

    const lines = await previewCall(root, {
      name: "csv_write",
      input: { path: "ledger.csv", content: before.replace("\n5\n", "\n五\n") },
    });

    expect(kinds(lines)[0]).toBe("note:ledger.csv を書き換えます");
    expect(kinds(lines)).toContain("removed:5");
    expect(kinds(lines)).toContain("added:五");
    expect(kinds(lines)).toContain("context:4");
    expect(kinds(lines).some((l) => l.startsWith("note:… 変わらない"))).toBe(true);
    expect(kinds(lines)).not.toContain("context:1");
  });

  test("csv_write rows are rendered as the file will read, and diffed", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-preview-"));
    await writeFile(join(root, "ledger.csv"), "category,件数,合計\n古い,0,0\n");

    const lines = await previewCall(root, {
      name: "csv_write",
      input: {
        path: "ledger.csv",
        rows: [
          { category: "交通費", 件数: "1", 合計: "800" },
          { category: "会議費", 件数: "1", 合計: "1200" },
        ],
      },
    });

    expect(kinds(lines)).toEqual([
      "note:ledger.csv を書き換えます",
      "context:category,件数,合計",
      "removed:古い,0,0",
      "added:交通費,1,800",
      "added:会議費,1,1200",
      "context:",
    ]);
  });

  test("a cell with a comma or a quote is quoted, and the column order is respected", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-preview-"));

    const lines = await previewCall(root, {
      name: "csv_write",
      input: {
        path: "new.csv",
        columns: ["b", "a"],
        rows: [{ a: 'x"y', b: "1,2" }],
      },
    });

    expect(kinds(lines)).toEqual([
      "note:new.csv を新しく作ります(3 行)",
      "added:b,a",
      'added:"1,2","x""y"',
      "added:",
    ]);
  });

  test("a call without content is shown as its input", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-preview-"));

    const lines = await previewCall(root, { name: "fs_list", input: { path: "." } });

    expect(lines).toEqual([{ kind: "note", text: '{"path":"."}' }]);
  });

  test("a large file is summarized instead of diffed, and long output is cut", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-preview-"));
    const many = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
    await writeFile(join(root, "big.csv"), many);

    const big = await previewCall(root, {
      name: "fs_write",
      input: { path: "big.csv", content: `${many}\nmore` },
    });
    expect(big).toHaveLength(1);
    expect(big[0]?.text).toContain("大きいので差分は出しません");

    const long = await previewCall(root, {
      name: "fs_write",
      input: { path: "new.csv", content: Array.from({ length: 100 }, (_, i) => i).join("\n") },
    });
    expect(long).toHaveLength(25);
    expect(long.at(-1)?.text).toMatch(/^ほか \d+ 行$/);
  });
});
