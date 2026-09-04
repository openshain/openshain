import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntime, type RuntimeProviders } from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { runWork } from "./loop.ts";
import { anthropicProvider } from "./providers/anthropic.ts";
import { openaiCompatibleProvider } from "./providers/openai-compatible.ts";

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
    あなたはこの会社の事務担当です。依頼された作業を、workspace 内のファイルだけを使って進めてください。
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
  const runtime = await createRuntime({ workspaceRoot: root, providers });
  const work = await runtime.works.create({
    objective:
      "receipts/2026-07.csv の amount を合計して、summary.md に「合計 <数値>」と書いてください。",
    principal: "alice",
    profession: "generic",
  });
  const done = await runWork(runtime, work.id);
  const summary = await readFile(join(root, "summary.md"), "utf8").catch(() => "");
  return { done, summary };
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
});
