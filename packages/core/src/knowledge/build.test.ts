import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIndex,
  hashKnowledgeInput,
  INDEX_FORMAT_VERSION,
  readIndex,
  serializeIndex,
  writeIndex,
} from "./build.ts";
import { checkKnowledge } from "./check.ts";
import { inEffect, search } from "./search.ts";

const SOURCE = `---
id: invoice.2023
title: 適格請求書等保存方式の概要
publisher: 国税庁
url: https://example.invalid/invoice
retrieved_at: 2026-09-01
version: "2023-10"
effective_from: 2023-10-01
effective_to: null
scope: { visibility: company }
expertise: tax
---

## 保存の要件

登録番号のある請求書の保存が仕入税額控除の要件です。

## 経過措置

一定期間は控除の割合が下がります。
`;

const RULES = `version: 1
rules:
  - id: invoice.keep-registered
    statement: 仕入税額控除を受ける請求書は登録番号のあるものを保存します。
    aliases: [インボイス, 適格請求書]
    effective_from: 2023-10-01
    effective_to: null
    expertise: tax
    source: { id: invoice.2023, section: 保存の要件 }
  - id: expenses.receipt-required
    statement: 1 万円以上の経費には領収書の原本が要ります。長い資料に負けない短い決まりです。
    effective_from: 2026-04-01
    effective_to: null
    expertise: none
    source: { id: internal.expense-policy }
    scope: { visibility: company }
`;

const EXPENSE_SOURCE = `---
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

## 領収書

原本を保存します。
`;

async function built(files: Record<string, string> = {}) {
  const root = await mkdtemp(join(tmpdir(), "openshain-index-"));
  await mkdir(join(root, "knowledge", "rules"), { recursive: true });
  await mkdir(join(root, "knowledge", "sources"), { recursive: true });
  await mkdir(join(root, "policies"), { recursive: true });
  await writeFile(join(root, "policies", "expenses.md"), "原本です。\n");
  const all = {
    "knowledge/sources/invoice.md": SOURCE,
    "knowledge/sources/expenses.md": EXPENSE_SOURCE,
    "knowledge/rules/invoice.yaml": RULES,
    ...files,
  };
  for (const [path, text] of Object.entries(all)) await writeFile(join(root, path), text);
  const checked = await checkKnowledge(root);
  const index = buildIndex(checked);
  const manifest = await writeIndex(root, index, {
    hash: await hashKnowledgeInput(root),
    rules: checked.rules.length,
    sources: checked.sources.length,
  });
  return { root, checked, index, manifest };
}

describe("the index", () => {
  test("holds a unit for each rule and each section of a source", async () => {
    const { index, checked } = await built();

    expect(checked.problems).toEqual([]);
    expect(index.units.map((u) => u.key)).toEqual([
      "rule:expenses.receipt-required",
      "rule:invoice.keep-registered",
      "source:internal.expense-policy#領収書",
      "source:invoice.2023#保存の要件",
      "source:invoice.2023#経過措置",
    ]);
    const section = index.units.find((u) => u.heading === "保存の要件");
    expect(section?.provenance).toMatchObject({ publisher: "国税庁", version: "2023-10" });
    expect(section?.expertise).toBe("tax");
  });

  test("a source with no heading is one unit", async () => {
    const { index } = await built({
      "knowledge/sources/invoice.md": SOURCE.replace(/## .*\n/g, ""),
    });

    const units = index.units.filter((u) => u.ref === "invoice.2023");
    expect(units).toHaveLength(1);
    expect(units[0]?.heading).toBe("適格請求書等保存方式の概要");
    expect(units[0]?.text).toContain("登録番号のある請求書");
  });

  test("a word that shares no characters finds the rule that lists it as another way of saying it", async () => {
    const { index } = await built();

    const hits = search(index, "インボイス");

    expect(hits[0]?.unit.ref).toBe("invoice.keep-registered");
  });

  test("a question of two characters is answered, and one character is not a question", async () => {
    const { index } = await built();

    expect(search(index, "経費").map((h) => h.unit.ref)).toContain("expenses.receipt-required");
    expect(search(index, "請")).toEqual([]);
  });

  test("full width and half width are the same question", async () => {
    const { index } = await built();

    expect(search(index, "ｲﾝﾎﾞｲｽ").map((h) => h.unit.key)).toEqual(
      search(index, "インボイス").map((h) => h.unit.key),
    );
  });

  test("a page of prose does not outrank the short rule that answers the question", async () => {
    const filler = Array.from(
      { length: 40 },
      (_, i) => `第 ${i} 項では、取引先との契約や支払の期日、帳簿の記載事項について定めています。`,
    ).join("\n");
    const { index } = await built({
      "knowledge/sources/invoice.md": SOURCE.replace(
        "登録番号のある請求書の保存が仕入税額控除の要件です。",
        `登録番号のある請求書の保存が仕入税額控除の要件です。\n${filler}`,
      ),
      "knowledge/rules/invoice.yaml": RULES.replace(
        "statement: 仕入税額控除を受ける請求書は登録番号のあるものを保存します。",
        "statement: 登録番号のある請求書の保存が仕入税額控除の要件です。",
      ),
    });

    const hits = search(index, "登録番号のある請求書の保存");

    expect(hits[0]?.unit.kind).toBe("rule");
  });

  test("a rule another rule replaces is closed the day before that one starts", async () => {
    const { index } = await built({
      "knowledge/rules/invoice.yaml": `${RULES}  - id: expenses.receipt-required-2027
    statement: 3 万円以上の経費には領収書の原本が要ります。金額を引き上げました。
    effective_from: 2027-01-01
    effective_to: null
    supersedes: expenses.receipt-required
    expertise: none
    source: { id: invoice.2023 }
    scope: { visibility: company }
`,
    });

    const old = index.units.find((u) => u.key === "rule:expenses.receipt-required");
    expect(old?.to).toBe("2026-12-31");
    expect(inEffect(old as never, "2026-12-31")).toBe(true);
    expect(inEffect(old as never, "2027-01-01")).toBe(false);
  });

  test("a heading that repeats in one source still names one unit each", async () => {
    const { index } = await built({
      "knowledge/sources/invoice.md": SOURCE.replace("## 経過措置", "## 保存の要件"),
    });

    const keys = index.units.filter((u) => u.ref === "invoice.2023").map((u) => u.key);
    expect(keys).toEqual(["source:invoice.2023#保存の要件", "source:invoice.2023#保存の要件 (2)"]);
    expect(new Set(index.units.map((u) => u.key)).size).toBe(index.units.length);
  });

  test("a day that does not exist is refused before anything is built from it", async () => {
    const { checked } = await built({
      "knowledge/rules/invoice.yaml": RULES.replace(
        "effective_from: 2023-10-01",
        "effective_from: 2026-02-30",
      ),
    });

    expect(checked.problems.join("\n")).toContain("that day does not exist");
  });

  test("the same input makes the same bytes", async () => {
    const { root, checked, index } = await built();
    const first = await readFile(join(root, "knowledge/build/index.json"), "utf8");

    await writeIndex(root, buildIndex(checked), {
      hash: await hashKnowledgeInput(root),
      rules: checked.rules.length,
      sources: checked.sources.length,
    });

    expect(await readFile(join(root, "knowledge/build/index.json"), "utf8")).toBe(first);
    expect(serializeIndex(index)).toBe(first);
  });
});

describe("an index the runtime is asked to trust", () => {
  test("is read when the manifest matches both the input and the index", async () => {
    const { root, manifest } = await built();

    const state = await readIndex(root);

    expect(state.ok).toBe(true);
    expect(manifest.format).toBe(INDEX_FORMAT_VERSION);
    expect(manifest.units).toBe(5);
  });

  test("is refused when the index alone was rewritten", async () => {
    const { root } = await built();
    const path = join(root, "knowledge/build/index.json");
    const index = JSON.parse(await readFile(path, "utf8"));
    index.units[0].text = "誰も書いていない決まり";
    await writeFile(path, `${JSON.stringify(index, null, 2)}\n`);

    const state = await readIndex(root);

    expect(state).toEqual({
      ok: false,
      reason:
        "the index does not match the files it was built from; run `openshain knowledge build`",
    });
  });

  test("is refused when the rules changed without a build", async () => {
    const { root } = await built();

    await writeFile(
      join(root, "knowledge/rules/invoice.yaml"),
      RULES.replace("1 万円以上", "5 万円以上"),
    );

    expect((await readIndex(root)).ok).toBe(false);
  });

  test("is refused when it was built by another version of the runtime", async () => {
    const { root } = await built();
    const path = join(root, "knowledge/build/manifest.json");
    const manifest = JSON.parse(await readFile(path, "utf8"));
    manifest.format = INDEX_FORMAT_VERSION + 1;
    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`);

    expect((await readIndex(root)).ok).toBe(false);
  });

  test("a build directory that leads out of the folder is not written to", async () => {
    const { root, checked } = await built();
    const outside = await mkdtemp(join(tmpdir(), "openshain-outside-"));
    await rm(join(root, "knowledge", "build"), { recursive: true });
    await symlink(outside, join(root, "knowledge", "build"));

    const write = writeIndex(root, buildIndex(checked), { hash: "x", rules: 1, sources: 1 });

    await expect(write).rejects.toThrow(/leads out of the company folder/);
    expect(await readdir(outside)).toEqual([]);
  });

  test("a link left where the temporary file goes does not carry the write", async () => {
    const { root, checked } = await built();
    const outside = await mkdtemp(join(tmpdir(), "openshain-outside-"));
    await symlink(join(outside, "taken.json"), join(root, "knowledge/build/index.json.writing"));

    const write = writeIndex(root, buildIndex(checked), { hash: "x", rules: 1, sources: 1 });

    await expect(write).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });

  test("is refused when there is none", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-index-"));

    expect(await readIndex(root)).toEqual({
      ok: false,
      reason: "there is no index; run `openshain knowledge build`",
    });
  });
});
