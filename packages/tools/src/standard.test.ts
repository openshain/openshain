import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newWorkId, OpenshainError, type ToolContext } from "@openshain/core";
import { standardTools } from "./standard.ts";

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "openshain-tools-"));
  await writeFile(join(root, "openshain.yaml"), "version: 1\n");
  await mkdir(join(root, "work"));
  await mkdir(join(root, "receipts"));
  await writeFile(
    join(root, "receipts", "2026-07.csv"),
    'date,vendor,amount\n2026-07-01,"Acme, Inc.",1200\n2026-07-02,"Quote ""Q""",30\n',
  );
  await writeFile(join(root, "notes.md"), "# 7月\n\nメモ\n\n## 交通費\n\n- 電車\n\n### 内訳\n");
  await writeFile(join(root, ".secret"), "x");
  const ctx: ToolContext = { workId: newWorkId(), principalId: "alice", workspaceRoot: root };
  const provider = standardTools();
  const call = (name: string, input: unknown) => provider.call({ id: "c", name, input }, ctx);
  return { root, provider, call };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("standard tools", () => {
  test("lists the six tools with their effects", async () => {
    const { provider } = await workspace();

    const tools = await provider.listTools();

    expect(tools.map((t) => [t.name, t.effect])).toEqual([
      ["fs_list", "observe"],
      ["fs_read", "observe"],
      ["fs_write", "mutate"],
      ["csv_read", "observe"],
      ["csv_write", "mutate"],
      ["markdown_read", "observe"],
    ]);
    for (const tool of tools) expect(tool.inputSchema.type).toBe("object");
  });

  test("fs_list shows files and directories, without hidden or reserved entries", async () => {
    const { call } = await workspace();

    const result = await call("fs_list", { path: "." });

    expect(result.content[0]).toEqual({
      type: "json",
      value: [
        { name: "notes.md", type: "file" },
        { name: "receipts", type: "directory" },
      ],
    });
  });

  test("fs_read returns the text and where it came from", async () => {
    const { call } = await workspace();

    const result = await call("fs_read", { path: "notes.md" });

    expect(result.content[0]).toEqual({
      type: "text",
      text: "# 7月\n\nメモ\n\n## 交通費\n\n- 電車\n\n### 内訳\n",
    });
    expect(result.observation?.source).toBe("notes.md");
    expect(result.isError).toBeFalsy();
  });

  test("fs_read fails as a tool error for a missing file", async () => {
    const { call } = await workspace();

    await expect(call("fs_read", { path: "missing.txt" })).rejects.toThrow(/missing.txt/);
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
        "fs_read",
        "fs_write",
        "csv_read",
        "csv_write",
        "markdown_read",
        "fs_list",
      ]) {
        const input = name.endsWith("write") ? { path, content: "x", rows: [] } : { path };
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

  test("csv_read returns one object per row using the header", async () => {
    const { call } = await workspace();

    const result = await call("csv_read", { path: "receipts/2026-07.csv" });

    expect(result.content[0]).toEqual({
      type: "json",
      value: [
        { date: "2026-07-01", vendor: "Acme, Inc.", amount: "1200" },
        { date: "2026-07-02", vendor: 'Quote "Q"', amount: "30" },
      ],
    });
    expect(result.observation?.source).toBe("receipts/2026-07.csv");
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
    expect(back.content[0]).toEqual({ type: "json", value: rows });
  });

  test("csv_write can be told the column order", async () => {
    const { root, call } = await workspace();

    await call("csv_write", { path: "out/a.csv", rows: [{ b: "2", a: "1" }], columns: ["a", "b"] });

    expect(await readFile(join(root, "out", "a.csv"), "utf8")).toBe("a,b\n1,2\n");
  });

  test("markdown_read returns the text and the headings", async () => {
    const { call } = await workspace();

    const result = await call("markdown_read", { path: "notes.md" });

    expect(result.content[0]?.type).toBe("text");
    expect(result.content[1]).toEqual({
      type: "json",
      value: {
        headings: [
          { level: 1, text: "7月" },
          { level: 2, text: "交通費" },
          { level: 3, text: "内訳" },
        ],
      },
    });
  });

  test("fs_read refuses a file larger than the limit as a tool error", async () => {
    const { root, call } = await workspace();
    await writeFile(join(root, "big.bin"), Buffer.alloc(2 * 1024 * 1024, 65));

    await expect(call("fs_read", { path: "big.bin" })).rejects.toThrow(/too large/);
  });
});
