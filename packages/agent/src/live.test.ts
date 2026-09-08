import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type RuntimeProviders, WorkStore } from "@openshain/core";
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
  tools: { standard: () => standardTools() },
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
});
