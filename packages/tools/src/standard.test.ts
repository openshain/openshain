import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newWorkId, OpenshainError, type ToolContext, type ToolResult } from "@openshain/core";
import { MAX_READ_BYTES, MAX_WRITE_BYTES, standardTools } from "./standard.ts";

const NOTES = "# 7月\n\nメモ\n\n## 交通費\n\n- 電車\n\n### 内訳\n";
const RECEIPTS = 'date,vendor,amount\n2026-07-01,"Acme, Inc.",1200\n2026-07-02,"Quote ""Q""",30\n';
const LEDGER =
  "date,category,amount\n" +
  '2026-07-01,交通費,"1,200"\n' +
  "2026-07-02,消耗品,¥300\n" +
  "2026-07-03,交通費,800\n" +
  "2026-07-04,交通費,n/a\n";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "openshain-tools-"));
  await writeFile(join(root, "openshain.yaml"), "version: 1\n");
  await mkdir(join(root, "work"));
  await mkdir(join(root, "receipts"));
  await writeFile(join(root, "receipts", "2026-07.csv"), RECEIPTS);
  await writeFile(join(root, "notes.md"), NOTES);
  await writeFile(join(root, ".secret"), "x");
  const ctx: ToolContext = { workId: newWorkId(), principalId: "alice", workspaceRoot: root };
  const provider = standardTools();
  const call = (name: string, input: unknown) => provider.call({ id: "c", name, input }, ctx);
  return { root, provider, call };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The JSON part of a result, which every observing tool puts first. */
function jsonOf(result: ToolResult): Record<string, unknown> {
  const part = result.content[0];
  if (part?.type !== "json") throw new Error(`expected a json part, got ${JSON.stringify(part)}`);
  return part.value as Record<string, unknown>;
}

function messageOf(result: ToolResult): string {
  const part = result.content[0];
  if (part?.type !== "text") throw new Error(`expected a text part, got ${JSON.stringify(part)}`);
  return part.text;
}

function textOf(result: ToolResult): string {
  const part = result.content[1] ?? result.content[0];
  if (part?.type !== "text") throw new Error(`expected a text part, got ${JSON.stringify(part)}`);
  return part.text;
}

describe("standard tools", () => {
  test("lists the eight tools with their effects", async () => {
    const { provider } = await workspace();

    const tools = await provider.listTools();

    expect(tools.map((t) => [t.name, t.effect])).toEqual([
      ["fs_list", "observe"],
      ["fs_search", "observe"],
      ["fs_read", "observe"],
      ["fs_write", "mutate"],
      ["csv_read", "observe"],
      ["csv_aggregate", "observe"],
      ["csv_write", "mutate"],
      ["markdown_read", "observe"],
    ]);
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
  });

  test("fs_list shows files with sizes and directories, without hidden or reserved entries", async () => {
    const { call } = await workspace();

    const result = await call("fs_list", { path: "." });

    expect(jsonOf(result)).toEqual({
      path: ".",
      entries: [
        { name: "notes.md", type: "file", size: Buffer.byteLength(NOTES) },
        { name: "receipts", type: "directory" },
      ],
      total: 2,
      truncated: false,
    });
    expect(result.observation?.source).toBe(".");
  });

  test("fs_list keeps the names matching the glob and cuts the list at limit", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "a.csv"), "");
    await writeFile(join(root, "b.csv"), "");
    await writeFile(join(root, "c.txt"), "");

    const result = await call("fs_list", { path: ".", pattern: "*.csv", limit: 1 });

    expect(jsonOf(result)).toEqual({
      path: ".",
      entries: [{ name: "a.csv", type: "file", size: 0 }],
      total: 2,
      truncated: true,
    });
  });

  test("fs_list orders entries by code point, the same on every machine", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "b.txt"), "");
    await writeFile(join(root, "B.txt"), "");
    await writeFile(join(root, "a.txt"), "");

    const result = await call("fs_list", { path: "." });

    const entries = jsonOf(result).entries as { name: string }[];
    expect(entries.map((e) => e.name)).toEqual(["B.txt", "a.txt", "b.txt", "notes.md", "receipts"]);
  });

  test("fs_read returns a short file whole, with its line count and where it came from", async () => {
    const { call } = await workspace();

    const result = await call("fs_read", { path: "notes.md" });

    expect(jsonOf(result)).toEqual({
      path: "notes.md",
      offset: 0,
      returned: 9,
      lines: 9,
      truncated: false,
      bytes: Buffer.byteLength(NOTES),
    });
    expect(textOf(result)).toBe(NOTES);
    expect(result.observation?.source).toBe("notes.md");
    expect(result.isError).toBeFalsy();
  });

  test("fs_read returns the window of lines the model asks for and says what remains", async () => {
    const { root, call } = await workspace();
    await writeFile(
      join(root, "n.txt"),
      `${Array.from({ length: 10 }, (_, i) => i + 1).join("\n")}\n`,
    );

    const middle = await call("fs_read", { path: "n.txt", offset: 3, limit: 2 });
    const tail = await call("fs_read", { path: "n.txt", offset: 9, limit: 5 });

    expect(textOf(middle)).toBe("4\n5\n");
    expect(jsonOf(middle)).toMatchObject({ offset: 3, returned: 2, lines: 10, truncated: true });
    expect(textOf(tail)).toBe("10\n");
    expect(jsonOf(tail)).toMatchObject({ offset: 9, returned: 1, lines: 10, truncated: false });
  });

  test("fs_read fails as a tool error for a missing file", async () => {
    const { call } = await workspace();

    await expect(call("fs_read", { path: "missing.txt" })).rejects.toThrow(/missing.txt/);
  });

  test("fs_read refuses a file larger than the limit as a tool error", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 65));

    await expect(call("fs_read", { path: "big.bin" })).rejects.toThrow(/too large/);
  });

  test("fs_write creates the file and its parents and reports the hash", async () => {
    const { root, call } = await workspace();

    const result = await call("fs_write", {
      path: "reports/2026/summary.md",
      content: "# まとめ\n",
    });

    expect(await readFile(join(root, "reports", "2026", "summary.md"), "utf8")).toBe("# まとめ\n");
    expect(result.after).toEqual([
      { path: "reports/2026/summary.md", sha256: sha256("# まとめ\n") },
    ]);
  });

  test("fs_write through a symlink inside the workspace writes the real file and reports its path", async () => {
    const { root, call } = await workspace();
    await symlink(join(root, "notes.md"), join(root, "alias.md"));

    const result = await call("fs_write", { path: "alias.md", content: "replaced\n" });

    expect(await readFile(join(root, "notes.md"), "utf8")).toBe("replaced\n");
    expect(result.after?.[0]?.path).toBe("notes.md");
  });

  test.each(["../outside.txt", "work/anything", ".secret", "openshain.yaml"])(
    "every tool refuses %s with the path guard's own error",
    async (path) => {
      const { call } = await workspace();

      for (const name of [
        "fs_list",
        "fs_search",
        "fs_read",
        "fs_write",
        "csv_read",
        "csv_aggregate",
        "csv_write",
        "markdown_read",
      ]) {
        const input = name.endsWith("write")
          ? { path, content: "x", rows: [] }
          : { path, pattern: "x" };
        try {
          await call(name, input);
          throw new Error(`${name} accepted ${path}`);
        } catch (err) {
          expect(err).toBeInstanceOf(OpenshainError);
          expect(["reserved_path", "outside_workspace", "invalid_path"]).toContain(
            (err as OpenshainError).code,
          );
        }
      }
    },
  );

  test("csv_read returns the columns, the row count and one object per row", async () => {
    const { call } = await workspace();

    const result = await call("csv_read", { path: "receipts/2026-07.csv" });

    expect(jsonOf(result)).toEqual({
      path: "receipts/2026-07.csv",
      columns: ["date", "vendor", "amount"],
      rowCount: 2,
      offset: 0,
      returned: 2,
      truncated: false,
      rows: [
        { date: "2026-07-01", vendor: "Acme, Inc.", amount: "1200" },
        { date: "2026-07-02", vendor: 'Quote "Q"', amount: "30" },
      ],
    });
    expect(result.observation?.source).toBe("receipts/2026-07.csv");
  });

  test("csv_read pages through the rows with offset and limit", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "ledger.csv"), LEDGER);

    const result = await call("csv_read", { path: "ledger.csv", offset: 1, limit: 2 });

    expect(jsonOf(result)).toMatchObject({
      rowCount: 4,
      offset: 1,
      returned: 2,
      truncated: true,
      rows: [
        { date: "2026-07-02", category: "消耗品", amount: "¥300" },
        { date: "2026-07-03", category: "交通費", amount: "800" },
      ],
    });
  });

  test("csv_read keeps the header of a file with no rows", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "empty.csv"), "a,b\n");

    const result = await call("csv_read", { path: "empty.csv" });

    expect(jsonOf(result)).toMatchObject({ columns: ["a", "b"], rowCount: 0, rows: [] });
  });

  test("csv_aggregate totals a column per group, reading separators and skipping the rest", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "ledger.csv"), LEDGER);

    const result = await call("csv_aggregate", {
      path: "ledger.csv",
      group_by: ["category"],
      sum: ["amount"],
    });

    expect(jsonOf(result)).toEqual({
      path: "ledger.csv",
      rowCount: 4,
      matched: 4,
      groupCount: 2,
      groups: [
        {
          group: { category: "交通費" },
          rows: 3,
          totals: { amount: { sum: 2000, min: 800, max: 1200, count: 2, skipped: 1 } },
        },
        {
          group: { category: "消耗品" },
          rows: 1,
          totals: { amount: { sum: 300, min: 300, max: 300, count: 1, skipped: 0 } },
        },
      ],
      truncated: false,
    });
    expect(result.observation?.source).toBe("ledger.csv");
  });

  test("csv_aggregate applies the filter and makes one group when there is no group_by", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "ledger.csv"), LEDGER);

    const result = await call("csv_aggregate", {
      path: "ledger.csv",
      sum: ["amount"],
      filter: [{ column: "category", equals: "交通費" }],
    });

    expect(jsonOf(result)).toMatchObject({
      rowCount: 4,
      matched: 3,
      groupCount: 1,
      groups: [{ group: {}, rows: 3, totals: { amount: { sum: 2000, count: 2, skipped: 1 } } }],
    });
  });

  test("csv_aggregate sums decimals without floating point noise", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "d.csv"), "x\n0.1\n0.2\n");

    const result = await call("csv_aggregate", { path: "d.csv", sum: ["x"] });

    expect((jsonOf(result).groups as { totals: { x: { sum: number } } }[])[0]?.totals.x.sum).toBe(
      0.3,
    );
  });

  test("csv_aggregate cuts the groups at limit", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "ledger.csv"), LEDGER);

    const result = await call("csv_aggregate", {
      path: "ledger.csv",
      group_by: ["date"],
      limit: 2,
    });

    expect(jsonOf(result)).toMatchObject({ groupCount: 4, truncated: true });
    expect(jsonOf(result).groups).toHaveLength(2);
  });

  test("csv_aggregate names the columns when asked for one that does not exist", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "ledger.csv"), LEDGER);

    const result = await call("csv_aggregate", { path: "ledger.csv", sum: ["total"] });

    expect(result.isError).toBe(true);
    expect(messageOf(result)).toContain('"total"');
    expect(messageOf(result)).toContain("date, category, amount");
  });

  test("csv_write writes a header and quotes what needs quoting, and csv_read reads it back", async () => {
    const { root, call } = await workspace();
    const rows = [
      { vendor: "Acme, Inc.", note: 'said "hi"', amount: "1" },
      { vendor: "Beta", note: "line\nbreak", amount: "2" },
    ];

    const written = await call("csv_write", { path: "out/vendors.csv", rows });
    const back = await call("csv_read", { path: "out/vendors.csv" });

    const text = await readFile(join(root, "out", "vendors.csv"), "utf8");
    expect(text.split("\n")[0]).toBe("vendor,note,amount");
    expect(written.after?.[0]).toEqual({ path: "out/vendors.csv", sha256: sha256(text) });
    expect(jsonOf(back)).toMatchObject({ columns: ["vendor", "note", "amount"], rows });
  });

  test("csv_write can be told the column order", async () => {
    const { root, call } = await workspace();

    await call("csv_write", { path: "out/a.csv", rows: [{ b: "2", a: "1" }], columns: ["a", "b"] });

    expect(await readFile(join(root, "out", "a.csv"), "utf8")).toBe("a,b\n1,2\n");
  });

  test("markdown_read returns the outline with line numbers and the first lines", async () => {
    const { call } = await workspace();

    const result = await call("markdown_read", { path: "notes.md" });

    expect(jsonOf(result)).toEqual({
      path: "notes.md",
      lines: 9,
      headings: [
        { level: 1, text: "7月", line: 1 },
        { level: 2, text: "交通費", line: 5 },
        { level: 3, text: "内訳", line: 9 },
      ],
      offset: 0,
      returned: 9,
      truncated: false,
    });
    expect(textOf(result)).toBe(NOTES);
  });

  test("markdown_read returns one section, down to the next heading of the same level", async () => {
    const { call } = await workspace();

    const result = await call("markdown_read", { path: "notes.md", section: "交通費" });

    expect(textOf(result)).toBe("## 交通費\n\n- 電車\n\n### 内訳\n");
    expect(jsonOf(result)).toMatchObject({
      section: { text: "交通費", level: 2, line: 5, lines: 5 },
      offset: 4,
      returned: 5,
      truncated: false,
    });
  });

  test("markdown_read names the headings when the section does not exist", async () => {
    const { call } = await workspace();

    const result = await call("markdown_read", { path: "notes.md", section: "食費" });

    expect(result.isError).toBe(true);
    expect(messageOf(result)).toContain("7月, 交通費, 内訳");
  });

  test("markdown_read cuts a long file at limit but keeps the whole outline", async () => {
    const { root, call } = await workspace();
    const lines = Array.from({ length: 300 }, (_, i) => (i === 249 ? "## 後半" : `行 ${i + 1}`));
    await writeFile(join(root, "long.md"), `# 前半\n${lines.slice(1).join("\n")}\n`);

    const result = await call("markdown_read", { path: "long.md" });

    expect(jsonOf(result)).toMatchObject({
      lines: 300,
      headings: [
        { level: 1, text: "前半", line: 1 },
        { level: 2, text: "後半", line: 250 },
      ],
      returned: 100,
      truncated: true,
    });
  });

  test("markdown_read ignores headings inside fenced code blocks", async () => {
    const { root, call } = await workspace();
    await writeFile(
      join(root, "code.md"),
      "# 本物\n\n```sh\n# コメント\n```\n\n~~~\n## これも違う\n~~~\n\n## 本物 2\n",
    );

    const result = await call("markdown_read", { path: "code.md" });

    expect(jsonOf(result).headings).toEqual([
      { level: 1, text: "本物", line: 1 },
      { level: 2, text: "本物 2", line: 11 },
    ]);
  });

  test("fs_search finds a string in every text file, in path order, with line numbers", async () => {
    const { root, call } = await workspace();
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs", "a.md"), "one\ntwo\nAcme は取引先\n");

    const result = await call("fs_search", { pattern: "Acme" });

    expect(jsonOf(result)).toEqual({
      pattern: "Acme",
      path: ".",
      matches: [
        { path: "docs/a.md", line: 3, text: "Acme は取引先" },
        { path: "receipts/2026-07.csv", line: 2, text: '2026-07-01,"Acme, Inc.",1200' },
      ],
      filesSearched: 3,
      filesSkipped: 0,
      truncated: false,
    });
  });

  test("fs_search skips hidden, reserved, binary and symlinked entries", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, ".secret"), "needle\n");
    await mkdir(join(root, "work", "w1"));
    await writeFile(join(root, "work", "w1", "events.jsonl"), "needle\n");
    await writeFile(
      join(root, "bin.dat"),
      Buffer.concat([Buffer.from("needle\n"), Buffer.alloc(4, 0)]),
    );
    await writeFile(join(root, "ok.txt"), "a needle\n");
    await symlink(join(root, "ok.txt"), join(root, "link.txt"));

    const result = await call("fs_search", { pattern: "needle" });

    expect(jsonOf(result)).toMatchObject({
      matches: [{ path: "ok.txt", line: 1, text: "a needle" }],
      filesSkipped: 1,
    });
  });

  test("fs_search takes a regular expression when asked, and refuses one that could run away", async () => {
    const { call } = await workspace();

    const found = await call("fs_search", {
      pattern: "Acme|Quote",
      regex: true,
      path: "receipts/2026-07.csv",
    });
    const refused = await call("fs_search", { pattern: "(a+)+$", regex: true });
    const broken = await call("fs_search", { pattern: "(", regex: true });

    expect((jsonOf(found).matches as { line: number }[]).map((m) => m.line)).toEqual([2, 3]);
    expect(refused.isError).toBe(true);
    expect(messageOf(refused)).toContain("too long");
    expect(broken.isError).toBe(true);
  });

  test("fs_search stops at limit and says so", async () => {
    const { call } = await workspace();

    const result = await call("fs_search", { pattern: "2026-07", limit: 1 });

    expect(jsonOf(result)).toMatchObject({
      matches: [{ path: "receipts/2026-07.csv", line: 2 }],
      truncated: true,
    });
  });
});

describe("limits on reads at the boundary", () => {
  test("reads a file of exactly the limit and refuses one byte more", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "edge.txt"), Buffer.alloc(MAX_READ_BYTES, 65));
    await writeFile(join(root, "over.txt"), Buffer.alloc(MAX_READ_BYTES + 1, 65));

    const edge = await call("fs_read", { path: "edge.txt" });
    expect(jsonOf(edge)).toMatchObject({ lines: 1, bytes: MAX_READ_BYTES });
    await expect(call("fs_read", { path: "over.txt" })).rejects.toThrow(/too large/);
  });
});

describe("limits on writes", () => {
  test("refuses to write a file that no tool could read back", async () => {
    const { call } = await workspace();

    const err = await call("fs_write", {
      path: "huge.txt",
      content: "x".repeat(MAX_WRITE_BYTES + 1),
    }).catch((e: unknown) => e);

    expect((err as Error).message).toContain("too large to write");
  });

  test("keeps formulas in CSV cells from running, and negative numbers as they are", async () => {
    const { root, call } = await workspace();

    await call("csv_write", {
      path: "out.csv",
      rows: [{ memo: "=cmd|' /C calc'!A1", amount: "-100", note: "+1", tag: "@x" }],
    });

    const text = await readFile(join(root, "out.csv"), "utf8");
    expect(text).toContain("'=cmd");
    expect(text).toContain("-100");
    expect(text).not.toContain("'-100");
    expect(text).toContain("'+1");
    expect(text).toContain("'@x");
  });
});
