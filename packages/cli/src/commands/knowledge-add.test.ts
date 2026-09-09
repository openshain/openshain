import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkKnowledge } from "@openshain/core";
import { knowledgeAdd } from "./knowledge-add.ts";

const SOURCE = `---
id: internal.expense-policy
title: 経費規程
publisher: サンプル株式会社
url: https://example.invalid/policy
retrieved_at: 2026-09-01
effective_from: 2020-01-01
effective_to: null
expertise: none
---

## 領収書

原本を保存します。
`;

async function workspace(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "openshain-add-"));
  await mkdir(join(root, "knowledge", "rules"), { recursive: true });
  await mkdir(join(root, "knowledge", "sources"), { recursive: true });
  for (const [path, text] of Object.entries({
    "knowledge/sources/expenses.md": SOURCE,
    ...files,
  })) {
    await writeFile(join(root, path), text);
  }
  return root;
}

/** Answers the questions in order, as a person at the terminal would. */
function answering(answers: string[]) {
  const lines: string[] = [];
  const asked: string[] = [];
  let at = 0;
  return {
    lines,
    asked,
    write: (line: string) => lines.push(line),
    ask: async (question: string) => {
      asked.push(question);
      return answers[at++] ?? "";
    },
  };
}

const ANSWERS = [
  "1 万円以上の経費には領収書の原本が要ります。",
  "expenses.receipt-required",
  "2026-04-01",
  "",
  "internal.expense-policy",
  "領収書",
  "レシート、証憑",
  "",
];

describe("knowledge add", () => {
  test("writes the rule a person answered for, and builds the index", async () => {
    const root = await workspace();
    const { lines, write, ask } = answering(ANSWERS);

    const code = await knowledgeAdd({ workspaceRoot: root, write, ask, interactive: true });

    expect(code).toBe(0);
    const written = await readFile(join(root, "knowledge/rules/expenses.yaml"), "utf8");
    expect(written).toContain("- id: expenses.receipt-required");
    expect(written).toContain('aliases: ["レシート", "証憑"]');
    expect(written).toContain("effective_to: null");
    const { rules, problems } = await checkKnowledge(root);
    expect(problems).toEqual([]);
    expect(rules.map((rule) => rule.id)).toEqual(["expenses.receipt-required"]);
    expect(lines.join("\n")).toContain("索引を作りました");
  });

  test("adds to the file that is already there rather than starting another", async () => {
    const root = await workspace();
    const first = answering(ANSWERS);
    await knowledgeAdd({
      workspaceRoot: root,
      write: first.write,
      ask: first.ask,
      interactive: true,
    });

    const second = answering([
      "3 万円以上の支出には稟議が要ります。金額の大きい支出の決まりです。",
      "expenses.approval-required",
      "2026-04-01",
      "",
      "internal.expense-policy",
      "",
      "",
      "",
    ]);
    const code = await knowledgeAdd({
      workspaceRoot: root,
      write: second.write,
      ask: second.ask,
      interactive: true,
    });

    expect(code).toBe(0);
    const { rules, problems } = await checkKnowledge(root);
    expect(problems).toEqual([]);
    expect(rules.map((rule) => rule.id).sort()).toEqual([
      "expenses.approval-required",
      "expenses.receipt-required",
    ]);
  });

  test("a rule that would not hold up is not written, and what was there still works", async () => {
    const root = await workspace();
    const first = answering(ANSWERS);
    await knowledgeAdd({
      workspaceRoot: root,
      write: first.write,
      ask: first.ask,
      interactive: true,
    });
    const before = await readFile(join(root, "knowledge/rules/expenses.yaml"), "utf8");
    const index = await readFile(join(root, "knowledge/build/index.json"), "utf8");

    // A source nobody wrote, and a day that is not a day.
    const bad = answering([
      "この決まりは根拠のない決まりです。追加されないはずです。",
      "expenses.nowhere",
      "2026-02-30",
      "",
      "internal.nothing",
      "",
      "",
      "",
    ]);
    const code = await knowledgeAdd({
      workspaceRoot: root,
      write: bad.write,
      ask: bad.ask,
      interactive: true,
    });

    expect(code).toBe(1);
    expect(bad.lines.join("\n")).toContain("会社の決まりはそのままです");
    expect(await readFile(join(root, "knowledge/rules/expenses.yaml"), "utf8")).toBe(before);
    expect(await readFile(join(root, "knowledge/build/index.json"), "utf8")).toBe(index);
    expect((await checkKnowledge(root)).problems).toEqual([]);
  });

  test("asks for the ways of saying it, since nothing else bridges a different word", async () => {
    const root = await workspace();
    const { asked, write, ask } = answering(ANSWERS);

    await knowledgeAdd({ workspaceRoot: root, write, ask, interactive: true });

    expect(asked.join("\n")).toContain("他にどう言い換えますか");
  });

  test("with no source to cite, it says so before asking anything", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-add-"));
    await mkdir(join(root, "knowledge", "rules"), { recursive: true });
    const { lines, asked, write, ask } = answering(ANSWERS);

    const code = await knowledgeAdd({ workspaceRoot: root, write, ask, interactive: true });

    expect(code).toBe(1);
    expect(asked).toEqual([]);
    expect(lines[0]).toContain("knowledge/sources/");
  });

  test("without a terminal it asks nothing and says where the file is", async () => {
    const root = await workspace();
    const { lines, asked, write, ask } = answering(ANSWERS);

    const code = await knowledgeAdd({ workspaceRoot: root, write, ask, interactive: false });

    expect(code).toBe(2);
    expect(asked).toEqual([]);
    expect(lines[0]).toContain("knowledge/rules/");
  });

  test("a statement with quotation marks in it stays the statement it was", async () => {
    const root = await workspace();
    const { write, ask } = answering([
      '「1 万円」以上の経費には "領収書" の原本が要ります。',
      "expenses.quoted",
      "2026-04-01",
      "",
      "internal.expense-policy",
      "",
      "",
      "",
    ]);

    await knowledgeAdd({ workspaceRoot: root, write, ask, interactive: true });

    const { rules, problems } = await checkKnowledge(root);
    expect(problems).toEqual([]);
    expect(rules[0]?.statement).toBe('「1 万円」以上の経費には "領収書" の原本が要ります。');
  });
});
