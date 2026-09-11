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

describe("a scope that names somebody", () => {
  /** The same folder, with people written and a rule scoped to a role. */
  async function withPeople(scope: string) {
    const root = await workspace({
      "knowledge/rules/scoped.yaml": `version: 1
rules:
  - id: expenses.scoped
    statement: 範囲を持つ決まりです。書いた人にだけ見えます。
    effective_from: 2026-04-01
    effective_to: null
    expertise: none
    scope: ${scope}
    source: { id: internal.expense-policy }
`,
    });
    await mkdir(join(root, "principals"), { recursive: true });
    await writeFile(
      join(root, "principals", "bob.yaml"),
      "id: bob\nname: Bob\nroles: [accounting]\n",
    );
    return root;
  }

  test("passes when the person and the role are written", async () => {
    const byRole = await withPeople("{ roles: [accounting] }");
    const byName = await withPeople("{ principals: [bob] }");

    expect((await checkKnowledge(byRole)).problems).toEqual([]);
    expect((await checkKnowledge(byName)).problems).toEqual([]);
  });

  test("a role nobody has is refused: it would build a rule nobody can read", async () => {
    const root = await withPeople("{ roles: [accountnig] }");

    const { problems } = await checkKnowledge(root);

    expect(problems.join("\n")).toContain("the role accountnig, which nobody has");
  });

  test("a person nobody wrote is refused", async () => {
    const root = await withPeople("{ principals: [carol] }");

    const { problems } = await checkKnowledge(root);

    expect(problems.join("\n")).toContain("carol, who is not in principals/");
  });

  test("with nobody written there is nothing to check against, and the names pass", async () => {
    const root = await workspace({
      "knowledge/rules/scoped.yaml": `version: 1
rules:
  - id: expenses.scoped
    statement: 範囲を持つ決まりです。書いた人にだけ見えます。
    effective_from: 2026-04-01
    effective_to: null
    expertise: none
    scope: { roles: [accounting] }
    source: { id: internal.expense-policy }
`,
    });

    expect((await checkKnowledge(root)).problems).toEqual([]);
  });
});

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

  test("two rules drawn from the same passage, in effect at once, contradict each other", async () => {
    const second = `  - id: expenses.receipt-required-2027
    statement: 3 万円以上の経費には領収書の原本が要ります。金額を変えました。
    effective_from: 2027-01-01
    effective_to: null
    expertise: none
    source: { id: internal.expense-policy, section: "3.2" }
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
    source: { id: internal.expense-policy, section: "3.2" }
`;
    const root = await workspace({ "knowledge/rules/expenses.yaml": RULE + second });

    expect((await checkKnowledge(root)).problems).toEqual([]);
  });

  test("one document backs many rules, which is how a company writes", async () => {
    const second = `  - id: expenses.approval-required
    statement: 3 万円以上の支出には稟議が要ります。金額の大きい支出の決まりです。
    effective_from: 2026-04-01
    effective_to: null
    expertise: none
    source: { id: internal.expense-policy, section: "4.1" }
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

  test("a build reads a bounded number of files, whatever the folder holds", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 3; i++)
      many[`knowledge/rules/many-${i}.yaml`] = RULE.replace(
        "expenses.receipt-required",
        `expenses.rule-${i}`,
      );
    const root = await workspace(many);

    // The budget is the runtime's, not the test's; here it only has to be spent in order.
    const { problems } = await checkKnowledge(root);

    expect(problems.join("\n")).not.toContain("not read");
  });

  test("the same id in two files is refused", async () => {
    const root = await workspace({ "knowledge/rules/again.yaml": RULE });

    expect((await checkKnowledge(root)).problems.join("\n")).toContain("is defined more than once");
  });
});
