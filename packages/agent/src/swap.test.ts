import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyEvent, loadConfig, type RuntimeProviders, WorkStore } from "@openshain/core";
import { createMcpServer } from "@openshain/mcp";
import { standardTools } from "@openshain/tools";
import { connectInMemory } from "./client.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.ts";
import { createSession } from "./session.ts";

type ProviderId = "anthropic" | "openai-compatible";

/** The same script for both providers: read the CSV, write the summary, say what was done. */
const SCRIPT = [
  { call: { id: "c0", name: "work_create", input: { objective: "receipts を集計して" } } },
  { call: { id: "c1", name: "csv_read", input: { path: "receipts/2026-07.csv" } } },
  { call: { id: "c2", name: "fs_write", input: { path: "summary.md", content: "# 合計 350\n" } } },
  {
    call: {
      id: "c3",
      name: "work_complete",
      input: { summary: "summary.md に合計 350 を書きました" },
    },
  },
  { text: "summary.md に合計 350 を書きました" },
];

function anthropicBody(step: (typeof SCRIPT)[number]) {
  const usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: null };
  return step.call
    ? {
        type: "message",
        role: "assistant",
        content: [
          { type: "tool_use", id: step.call.id, name: step.call.name, input: step.call.input },
        ],
        stop_reason: "tool_use",
        usage,
      }
    : {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: step.text }],
        stop_reason: "end_turn",
        usage,
      };
}

function openaiBody(step: (typeof SCRIPT)[number]) {
  const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const message = step.call
    ? {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: step.call.id,
            type: "function",
            function: { name: step.call.name, arguments: JSON.stringify(step.call.input) },
          },
        ],
      }
    : { role: "assistant", content: step.text };
  return {
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: step.call ? "tool_calls" : "stop" }],
    usage,
  };
}

/** Answers each call with the next step of the script, in the provider's own wire format. */
function scripted(provider: ProviderId) {
  const bodies: Record<string, unknown>[] = [];
  let turn = 0;
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")));
    const step = SCRIPT[Math.min(turn, SCRIPT.length - 1)] as (typeof SCRIPT)[number];
    turn += 1;
    const body = provider === "anthropic" ? anthropicBody(step) : openaiBody(step);
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { bodies, fetch };
}

async function workspace(provider: ProviderId) {
  const root = await mkdtemp(join(tmpdir(), "openshain-swap-"));
  const model =
    provider === "anthropic"
      ? "  provider: anthropic\n  model: claude-opus-5\n  api_key_env: SWAP_KEY\n"
      : "  provider: openai-compatible\n  model: gpt-5\n  api_key_env: SWAP_KEY\n  base_url: http://localhost:11434/v1\n";
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
  instructions: 事務担当として働く。
model:
${model}tools:
  - provider: standard
`,
  );
  await mkdir(join(root, "receipts"));
  await writeFile(
    join(root, "receipts", "2026-07.csv"),
    "date,amount\n2026-07-01,100\n2026-07-02,250\n",
  );
  return root;
}

async function runScript(provider: ProviderId) {
  const root = await workspace(provider);
  const wire = scripted(provider);
  const providers: RuntimeProviders = {
    models: {
      anthropic: (m) => new AnthropicProvider({ model: m.model, apiKey: "k", fetch: wire.fetch }),
      "openai-compatible": (m) =>
        new OpenAICompatibleProvider({
          model: m.model,
          apiKey: "k",
          fetch: wire.fetch,
          ...(m.baseUrl && { baseUrl: m.baseUrl }),
        }),
    },
    tools: { standard: () => standardTools() },
  };
  const config = await loadConfig(root, { modelProviders: Object.keys(providers.models) });
  const modelConfig = config.model as NonNullable<typeof config.model>;
  const model = (providers.models[modelConfig.provider] as (m: typeof modelConfig) => never)(
    modelConfig,
  );
  const server = await createMcpServer({ workspaceRoot: root, tools: providers.tools });
  const client = await connectInMemory(server);
  const session = await createSession(client, { model, config });
  const reply = await session.turn("receipts を集計して");
  const store = new WorkStore(root);
  const work = (await store.list()).works.find((w) => w.type !== "session");
  if (!work) throw new Error("no work was created");
  const done = await store.get(work.id);
  const events = await store.events(work.id);
  const summary = await readFile(join(root, "summary.md"), "utf8");
  return { done, events, summary, bodies: wire.bodies, reply };
}

const shape = (events: AnyEvent[]) => events.map((e) => e.type);

describe("the same work through either provider", () => {
  test("completes with the same events and the same artifact when only the config's model changes", async () => {
    const anthropic = await runScript("anthropic");
    const openai = await runScript("openai-compatible");

    for (const run of [anthropic, openai]) {
      expect(run.done.status).toBe("completed");
      expect(run.summary).toBe("# 合計 350\n");
      expect(run.done.outcome?.summary).toBe("summary.md に合計 350 を書きました");
    }
    expect(shape(anthropic.events)).toEqual(shape(openai.events));
    expect(anthropic.done.outcome?.artifacts).toEqual(openai.done.outcome?.artifacts);
    expect(anthropic.bodies).toHaveLength(5);
    expect(openai.bodies).toHaveLength(5);
    expect(anthropic.reply.reply).toBe("summary.md に合計 350 を書きました");
  });

  test("hands each provider the tool results in its own wire format", async () => {
    const anthropic = await runScript("anthropic");
    const openai = await runScript("openai-compatible");

    const anthropicTurn2 = (anthropic.bodies[2]?.messages ?? []) as {
      role: string;
      content: unknown[];
    }[];
    expect(anthropicTurn2.at(-2)?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "c1",
    });
    const openaiTurn2 = (openai.bodies[2]?.messages ?? []) as {
      role: string;
      tool_call_id?: string;
    }[];
    expect(openaiTurn2.some((m) => m.role === "tool" && m.tool_call_id === "c1")).toBe(true);
  });
});
