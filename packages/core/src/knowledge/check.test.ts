import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkKnowledge, hasKnowledge } from "./check.ts";

const SOURCE = `---
id: internal.expense-policy
title: 経費規程
publisher: サンプル株式会社
path: policies/expenses.md
retrieved_at: 2026-09-01
effective_from: 2026-04-01
effective_to: null
scope: { visibility: company }
expertise: none
---

## 3.2 領収書

1 万円以上は原本を保存します。
`;

const RULE = `version: 1
rules:
  - id: expenses.receipt-required
    statement: 1 万円以上の経費には領収書の原本が要ります。
    aliases: [領収書, レシート]
    effective_from: 2026-04-01
    effective_to: null
    expertise: none
    source: { id: internal.expense-policy, section: "3.2" }
`;

async function workspace(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "openshain-knowledge-"));
  await mkdir(join(root, "knowledge", "rules"), { recursive: true });
  await mkdir(join(root, "knowledge", "sources"), { recursive: true });
  await mkdir(join(root, "policies"), { recursive: true });
  await writeFile(join(root, "policies", "expenses.md"), "原本です。\n");
  const all = {
    "knowledge/sources/expenses.md": SOURCE,
    "knowledge/rules/expenses.yaml": RULE,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) {
    if (text === "") continue;
    await writeFile(join(root, path), text);
  }
  return root;
}

describe("what a person wrote under knowledge/", () => {
  test("a workspace without the folder has nothing to check", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-knowledge-"));

    expect(await hasKnowledge(root)).toBe(false);
    expect(await checkKnowledge(root)).toEqual({ rules: [], sources: [], problems: [] });
  });

  test("reads the rules and the sources, and finds nothing wrong with a sound set", async () => {
    const root = await workspace();

    const { rules, sources, problems } = await checkKnowledge(root);

    expect(problems).toEqual([]);
    expect(rules.map((r) => r.id)).toEqual(["expenses.receipt-required"]);
    expect(rules[0]?.file).toBe("knowledge/rules/expenses.yaml");
    expect(sources.map((s) => s.id)).toEqual(["internal.expense-policy"]);
    expect(sources[0]?.body).toContain("1 万円以上は原本を保存します。");
  });

  test("says everything that is wrong, not only the first thing", async () => {
    const root = await workspace({
      "knowledge/rules/expenses.yaml": `version: 1
rules:
  - id: expenses.no-source
    statement: 出典のない決まりです。ここでは索引に入りません。
    effective_from: 2026-04-01
    effective_to: null
    expertise: none
    source: { id: internal.nothing }
  - id: expenses.backwards
    statement: 終わりが始まりより前にある決まりです。日付が逆です。
    effective_from: 2026-04-01
    effective_to: 2026-03-01
    expertise: none
    source: { id: internal.expense-policy }
`,
    });

    const { problems } = await checkKnowledge(root);

    expect(problems).toHaveLength(2);
    expect(problems.join("\n")).toContain("cites internal.nothing, which no source declares");
    expect(problems.join("\n")).toContain("ends before it starts");
  });

  test("a rule may not outlive, or start before, the source it cites", async () => {
    const root = await workspace({
      "knowledge/sources/expenses.md": SOURCE.replace(
        "effective_to: null",
        "effective_to: 2026-08-31",
      ),
      "knowledge/rules/expenses.yaml": RULE.replace(
        "effective_from: 2026-04-01",
        "effective_from: 2026-01-01",
      ),
    });

    const { problems } = await checkKnowledge(root);

    expect(problems.join("\n")).toContain("starts before internal.expense-policy");
    expect(problems.join("\n")).toContain("outlives internal.expense-policy");
  });

  test("a rule may not be read by more people than the source it cites", async () => {
    const root = await workspace({
      "knowledge/sources/expenses.md": SOURCE.replace(
        "scope: { visibility: company }",
        "scope: { principals: [alice] }",
      ),
    });

    const { problems } = await checkKnowledge(root);

    expect(problems.join("\n")).toContain(
      "may be read by more people than internal.expense-policy",
    );
  });

  test("a source may not point outside the company folder or at a path the runtime keeps", async () => {
    for (const path of ["../outside.md", "authority/policy.yaml", "work/w1/events.jsonl"]) {
      const root = await workspace({
        "knowledge/sources/expenses.md": SOURCE.replace(
          "path: policies/expenses.md",
          `path: ${path}`,
        ),
      });

      const { problems } = await checkKnowledge(root);

      expect(problems.join("\n")).toContain("which the runtime does not read");
    }
  });

  test("two rules on the same source, in effect at once, contradict each other", async () => {
    const second = `  - id: expenses.receipt-required-2027
    statement: 3 万円以上の経費には領収書の原本が要ります。金額を変えました。
    effective_from: 2027-01-01
    effective_to: null
    expertise: none
    source: { id: internal.expense-policy }
`;
    const root = await workspace({ "knowledge/rules/expenses.yaml": RULE + second });

    const { problems } = await checkKnowledge(root);

    expect(problems.join("\n")).toContain("are in effect at the same time");
  });

  test("saying which rule it replaces settles it", async () => {
    const second = `  - id: expenses.receipt-required-2027
    statement: 3 万円以上の経費には領収書の原本が要ります。金額を変えました。
    effective_from: 2027-01-01
    effective_to: null
    supersedes: expenses.receipt-required
    expertise: none
    source: { id: internal.expense-policy }
`;
    const root = await workspace({ "knowledge/rules/expenses.yaml": RULE + second });

    expect((await checkKnowledge(root)).problems).toEqual([]);
  });

  test("a file that is not well formed is reported with its line, and the rest is still read", async () => {
    const root = await workspace({
      "knowledge/rules/broken.yaml":
        "version: 1\nrules:\n  - id: no.statement\n    expertise: none\n",
    });

    const { rules, problems } = await checkKnowledge(root);

    expect(problems.join("\n")).toContain("knowledge/rules/broken.yaml:");
    expect(rules.map((r) => r.id)).toEqual(["expenses.receipt-required"]);
  });

  test("a source without front matter is refused", async () => {
    const root = await workspace({ "knowledge/sources/plain.md": "# 見出しだけ\n" });

    expect((await checkKnowledge(root)).problems.join("\n")).toContain(
      "must start with front matter",
    );
  });

  test("the same id in two files is refused", async () => {
    const root = await workspace({ "knowledge/rules/again.yaml": RULE });

    expect((await checkKnowledge(root)).problems.join("\n")).toContain("is defined more than once");
  });
});
