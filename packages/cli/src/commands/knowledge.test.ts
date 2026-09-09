import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knowledgeBuild, knowledgeCheck } from "./knowledge.ts";

const SOURCE = `---
id: internal.expense-policy
title: 経費規程
publisher: サンプル株式会社
path: policies/expenses.md
retrieved_at: 2026-09-01
effective_from: 2026-04-01
effective_to: null
expertise: none
---

## 領収書

1 万円以上は原本を保存します。
`;

const RULES = `version: 1
rules:
  - id: expenses.receipt-required
    statement: 1 万円以上の経費には領収書の原本が要ります。
    aliases: [領収書, レシート]
    effective_from: 2026-04-01
    effective_to: null
    expertise: none
    source: { id: internal.expense-policy, section: "領収書" }
`;

async function workspace(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "openshain-kn-cli-"));
  await mkdir(join(root, "knowledge", "rules"), { recursive: true });
  await mkdir(join(root, "knowledge", "sources"), { recursive: true });
  await mkdir(join(root, "policies"), { recursive: true });
  await writeFile(join(root, "policies", "expenses.md"), "原本です。\n");
  const all = {
    "knowledge/sources/expenses.md": SOURCE,
    "knowledge/rules/expenses.yaml": RULES,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) await writeFile(join(root, path), text);
  const lines: string[] = [];
  return { root, lines, write: (line: string) => lines.push(line) };
}

describe("knowledge build", () => {
  test("writes the index and says what went into it", async () => {
    const { root, lines, write } = await workspace();

    const code = await knowledgeBuild({ workspaceRoot: root, write });

    expect(code).toBe(0);
    expect(lines[0]).toBe("決まり 1 件、資料 1 件から 2 件の索引を作りました。");
    const manifest = JSON.parse(
      await readFile(join(root, "knowledge/build/manifest.json"), "utf8"),
    );
    expect(manifest).toMatchObject({ rules: 1, sources: 1, units: 2 });
  });

  test("says every problem, writes nothing, and leaves the index that was there", async () => {
    const { root, lines, write } = await workspace();
    await knowledgeBuild({ workspaceRoot: root, write });
    const before = await readFile(join(root, "knowledge/build/index.json"), "utf8");

    // One problem in each file. A file the schema refuses is not cross-checked further, so its
    // own rules cannot show a second kind of problem; other files still do.
    await writeFile(
      join(root, "knowledge/rules/expenses.yaml"),
      RULES.replace("effective_from: 2026-04-01", "effective_from: 2026-02-30"),
    );
    await writeFile(
      join(root, "knowledge/rules/travel.yaml"),
      `version: 1
rules:
  - id: travel.nowhere
    statement: 出典のない決まりです。索引には入りません。
    effective_from: 2026-04-01
    effective_to: null
    expertise: none
    source: { id: internal.nothing }
`,
    );
    lines.length = 0;
    const code = await knowledgeBuild({ workspaceRoot: root, write });

    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("that day does not exist");
    expect(lines.join("\n")).toContain("which no source declares");
    expect(lines.at(-1)).toBe("2 件の問題があります。索引は作りませんでした。");
    expect(await readFile(join(root, "knowledge/build/index.json"), "utf8")).toBe(before);
  });

  test("a workspace without the folder is told where the files go", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-kn-cli-"));
    const lines: string[] = [];

    const code = await knowledgeBuild({ workspaceRoot: root, write: (l) => lines.push(l) });

    expect(code).toBe(1);
    expect(lines[0]).toContain("knowledge/rules/");
  });
});

describe("knowledge check", () => {
  test("says nothing is wrong and writes no index", async () => {
    const { root, lines, write } = await workspace();

    const code = await knowledgeCheck({ workspaceRoot: root, write });

    expect(code).toBe(0);
    expect(lines.at(-1)).toBe("決まり 1 件、資料 1 件。問題はありません。");
    await expect(readFile(join(root, "knowledge/build/index.json"), "utf8")).rejects.toThrow();
  });

  test("fails on the same problems the build fails on", async () => {
    const { root, lines, write } = await workspace({
      "knowledge/rules/expenses.yaml": RULES.replace("internal.expense-policy", "internal.nothing"),
    });

    expect(await knowledgeCheck({ workspaceRoot: root, write })).toBe(1);
    expect(lines.at(-1)).toBe("1 件の問題があります。");
  });

  test("with --stale it names a source nobody has looked at for a year, and still passes", async () => {
    const { root, lines, write } = await workspace({
      "knowledge/sources/expenses.md": SOURCE.replace(
        "retrieved_at: 2026-09-01",
        "retrieved_at: 2024-01-15",
      ),
    });

    const code = await knowledgeCheck({
      workspaceRoot: root,
      write,
      stale: true,
      now: new Date("2026-09-09T00:00:00Z"),
    });

    expect(code).toBe(0);
    expect(lines.join("\n")).toContain("確かめたのは 2024-01-15 です");
  });

  test("without --stale an old source is not mentioned", async () => {
    const { root, lines, write } = await workspace({
      "knowledge/sources/expenses.md": SOURCE.replace(
        "retrieved_at: 2026-09-01",
        "retrieved_at: 2024-01-15",
      ),
    });

    await knowledgeCheck({ workspaceRoot: root, write, now: new Date("2026-09-09T00:00:00Z") });

    expect(lines.join("\n")).not.toContain("確かめたのは");
  });
});
