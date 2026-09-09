import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildIndex,
  checkKnowledge,
  hashKnowledgeInput,
  loadConfig,
  type RuntimeProviders,
  WorkStore,
  writeIndex,
} from "@openshain/core";
import { createMcpServer } from "@openshain/mcp";
import { standardTools } from "@openshain/tools";
import { connectInMemory } from "./client.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { openaiCompatibleProvider } from "./providers/openai-compatible.ts";
import { createSession } from "./session.ts";

/**
 * Real calls to the API. They run only with OPENSHAIN_LIVE_TESTS=1 and an ANTHROPIC_API_KEY;
 * everywhere else they are skipped. The OpenAI-compatible path goes through Anthropic's
 * compatibility endpoint, so one key exercises both providers.
 */
const live = process.env.OPENSHAIN_LIVE_TESTS === "1" && Boolean(process.env.ANTHROPIC_API_KEY);
const model = process.env.OPENSHAIN_LIVE_MODEL ?? "claude-opus-5";

async function workspace(modelSection: string) {
  const root = await mkdtemp(join(tmpdir(), "openshain-live-"));
  await writeFile(
    join(root, "openshain.yaml"),
    `version: 1
company:
  name: サンプル株式会社
principal:
  id: alice
  name: Alice
profession:
  id: generic
  instructions: |
    あなたはこの会社の一般事務の社員エージェントです。依頼された作業を、workspace 内のファイルだけを使って進めてください。
model:
${modelSection}tools:
  - provider: standard
limits:
  max_model_calls: 8
  max_tool_calls: 8
  max_output_tokens: 4000
`,
  );
  await mkdir(join(root, "receipts"));
  await writeFile(
    join(root, "receipts", "2026-07.csv"),
    "date,amount\n2026-07-01,100\n2026-07-02,250\n",
  );
  return root;
}

const providers: RuntimeProviders = {
  models: {
    anthropic: (m) => anthropicProvider(m),
    "openai-compatible": (m) => openaiCompatibleProvider(m),
  },
  tools: { standard: (workspaceRoot: string) => standardTools(workspaceRoot) },
};

async function smoke(modelSection: string) {
  const root = await workspace(modelSection);
  const config = await loadConfig(root, { modelProviders: Object.keys(providers.models) });
  const modelConfig = config.model as NonNullable<typeof config.model>;
  const model = (providers.models[modelConfig.provider] as (m: typeof modelConfig) => never)(
    modelConfig,
  );
  const server = await createMcpServer({ workspaceRoot: root, tools: providers.tools });
  const client = await connectInMemory(server);
  const session = await createSession(client, { model, config });
  await session.turn(
    "receipts/2026-07.csv の amount を合計して、summary.md に「合計 <数値>」と書いてください。",
  );
  const store = new WorkStore(root);
  const work = (await store.list()).works.find((w) => w.type !== "session");
  const done = work ? await store.get(work.id) : { status: "no work" };
  const summary = await readFile(join(root, "summary.md"), "utf8").catch(() => "");
  return { done, summary };
}

const EXPENSE_SOURCE = `---
id: internal.expense-policy
title: 経費規程
publisher: サンプル株式会社
url: https://example.invalid/expenses
retrieved_at: 2026-04-01
effective_from: 2020-01-01
effective_to: null
expertise: none
---

## 3.2 領収書

1 万円以上の経費には領収書の原本が要ります。

## 3.3 交際費

交際費は 5,000 円以上で領収書の原本が要ります。
`;

const EXPENSE_RULES = `version: 1
rules:
  - id: expenses.receipt-required
    statement: 1 万円以上の経費には領収書の原本が要ります。
    aliases: [領収書, レシート, 証憑]
    effective_from: 2026-04-01
    effective_to: null
    expertise: none
    source: { id: internal.expense-policy, section: "3.2 領収書" }
  - id: expenses.receipt-required-old
    statement: 3 万円以上の経費には領収書の原本が要りました。2026 年 3 月までの決まりです。
    effective_from: 2020-04-01
    effective_to: 2026-03-31
    expertise: none
    source: { id: internal.expense-policy, section: "3.2 領収書" }
`;

/** One more rule, in effect at the same time, that a question about a meal could also fall under. */
const ENTERTAINMENT_RULE = `  - id: expenses.entertainment-receipt
    statement: 交際費は 5,000 円以上で領収書の原本が要ります。
    aliases: [交際費, 接待, 飲食]
    effective_from: 2026-04-01
    effective_to: null
    expertise: none
    source: { id: internal.expense-policy, section: "3.3 交際費" }
`;

/** A workspace whose knowledge is written and built, as a company would leave it. */
async function withKnowledge(model: string, extraRules = "") {
  const root = await workspace(
    `  provider: anthropic\n  model: ${model}\n  api_key_env: ANTHROPIC_API_KEY\n`,
  );
  await mkdir(join(root, "knowledge", "rules"), { recursive: true });
  await mkdir(join(root, "knowledge", "sources"), { recursive: true });
  await writeFile(join(root, "knowledge/sources/expenses.md"), EXPENSE_SOURCE);
  await writeFile(join(root, "knowledge/rules/expenses.yaml"), `${EXPENSE_RULES}${extraRules}`);
  const checked = await checkKnowledge(root);
  expect(checked.problems).toEqual([]);
  await writeIndex(root, buildIndex(checked), {
    hash: await hashKnowledgeInput(root),
    rules: checked.rules.length,
    sources: checked.sources.length,
  });
  return root;
}

/** Opens a conversation on that workspace and asks one thing. */
async function asked(root: string, request: string) {
  const config = await loadConfig(root, { modelProviders: Object.keys(providers.models) });
  const modelConfig = config.model as NonNullable<typeof config.model>;
  const model = (providers.models[modelConfig.provider] as (m: typeof modelConfig) => never)(
    modelConfig,
  );
  const server = await createMcpServer({
    workspaceRoot: root,
    tools: providers.tools,
  });
  const client = await connectInMemory(server);
  const session = await createSession(client, { model, config });
  const turn = await session.turn(request);
  return { reply: turn.reply, store: new WorkStore(root) };
}

/** The models the reply has to reach the person on: a small one and a large one. */
const REPORTING_MODELS = (
  process.env.OPENSHAIN_LIVE_MODELS ?? "claude-haiku-4-5-20251001,claude-opus-5"
)
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

/** Runs the same request and returns what the person would read on the screen. */
async function report(modelSection: string) {
  const root = await workspace(modelSection);
  const config = await loadConfig(root, { modelProviders: Object.keys(providers.models) });
  const modelConfig = config.model as NonNullable<typeof config.model>;
  const model = (providers.models[modelConfig.provider] as (m: typeof modelConfig) => never)(
    modelConfig,
  );
  const server = await createMcpServer({ workspaceRoot: root, tools: providers.tools });
  const client = await connectInMemory(server);
  const session = await createSession(client, { model, config });
  const turn = await session.turn(
    "receipts/2026-07.csv の amount を合計して、結果を教えてください。",
  );
  const store = new WorkStore(root);
  const work = (await store.list()).works.find((w) => w.type !== "session");
  const done = work ? await store.get(work.id) : { status: "no work" };
  return { reply: turn.reply, done };
}

describe("live smoke", () => {
  test.skipIf(!live)(
    "Anthropic: reads the CSV and writes the summary",
    async () => {
      const { done, summary } = await smoke(
        `  provider: anthropic\n  model: ${model}\n  api_key_env: ANTHROPIC_API_KEY\n`,
      );

      expect(done.status).toBe("completed");
      expect(summary).toContain("350");
    },
    180_000,
  );

  test.skipIf(!live)(
    "OpenAI-compatible: the same through Anthropic's compatibility endpoint",
    async () => {
      const { done, summary } = await smoke(
        `  provider: openai-compatible\n  model: ${model}\n  api_key_env: ANTHROPIC_API_KEY\n  base_url: https://api.anthropic.com/v1\n`,
      );

      expect(done.status).toBe("completed");
      expect(summary).toContain("350");
    },
    180_000,
  );

  // The person sees the reply and the tool call lines, never the tool results or the work's
  // summary. A model that finishes the work and says nothing leaves them with no answer, so the
  // number the tools produced has to appear in what the agent writes back.
  for (const name of REPORTING_MODELS) {
    test.skipIf(!live)(
      `${name}: the total reaches the person in the reply`,
      async () => {
        const { reply, done } = await report(
          `  provider: anthropic\n  model: ${name}\n  api_key_env: ANTHROPIC_API_KEY\n`,
        );

        expect(done.status).toBe("completed");
        expect(reply).toContain("350");
      },
      180_000,
    );
  }

  // The whole point of the knowledge slice: a person asks something the company has decided, and
  // the agent looks it up rather than answering from what a model happens to know.
  for (const name of REPORTING_MODELS) {
    test.skipIf(!live)(
      `${name}: looks up a rule nobody named, and cites it`,
      async () => {
        const root = await withKnowledge(name);

        const { reply } = await asked(root, "8000 円の会議費に領収書は要りますか。");

        expect(reply).toContain("expenses.receipt-required");
        expect(reply).toContain("2026-04-01");
        // The rule in effect today, not the one that ended in March.
        expect(reply).not.toContain("expenses.receipt-required-old");
      },
      240_000,
    );

    // Two rules can both fit one question, and which one applies is the person's call to make.
    // An agent that picks one and says nothing about the other hides that choice from them.
    test.skipIf(!live)(
      `${name}: shows both rules when two of them could apply`,
      async () => {
        const root = await withKnowledge(name, ENTERTAINMENT_RULE);

        const { reply } = await asked(root, "8,000 円の飲食代に領収書は要りますか。");

        // Both rules have to be in the reply: the one for entertainment and the general one,
        // with what separates them. Whether each carries its id is the earlier test's business.
        expect(reply).toContain("交際費");
        expect(reply).toMatch(/5,?000/);
        expect(reply).toMatch(/1\s?万円|10,?000/);
      },
      240_000,
    );

    test.skipIf(!live)(
      `${name}: says there is no rule rather than answering from general knowledge`,
      async () => {
        const root = await withKnowledge(name);

        const { reply } = await asked(root, "出張の日当はいくらですか。");

        expect(reply).toContain("見つかりません");
      },
      240_000,
    );
  }
});
