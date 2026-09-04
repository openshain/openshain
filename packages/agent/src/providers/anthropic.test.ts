import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ModelRequest, OpenshainError } from "@openshain/core";
import { AnthropicProvider, anthropicProvider } from "./anthropic.ts";

const fixtures = join(import.meta.dir, "..", "..", "fixtures", "anthropic");

async function fixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(join(fixtures, `${name}.json`), "utf8"));
}

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * A provider whose HTTP calls are answered with one recorded response, and remembered. The
 * response asks the SDK to retry at once, so a test of a retried status stays fast.
 */
function recorded(status: number, body: unknown, options: { baseUrl?: string; raw?: string } = {}) {
  const calls: Recorded[] = [];
  const stub = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(options.raw ?? JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "request-id": "req_01",
        "retry-after-ms": "1",
      },
    });
  };
  const provider = new AnthropicProvider({
    model: "claude-opus-5",
    apiKey: "test-key",
    fetch: stub,
    ...(options.baseUrl && { baseUrl: options.baseUrl }),
  });
  return { calls, provider };
}

const request: ModelRequest = {
  system: "あなたは経理担当です。",
  messages: [{ role: "user", content: [{ type: "text", text: "7月の経費を集計して" }] }],
  tools: [
    {
      name: "csv_read",
      description: "Read a CSV file.",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      effect: "observe",
    },
  ],
  maxOutputTokens: 4000,
};

describe("AnthropicProvider", () => {
  test("describes itself as a tool-capable model", () => {
    const { provider } = recorded(200, {});

    expect(provider.describe()).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      capabilities: { tools: true },
    });
  });

  test("turns a text answer into an end_turn response with the usage, cache reads included", async () => {
    const { calls, provider } = recorded(200, await fixture("text-only"));

    const response = await provider.generate(request);

    expect(response.stopReason).toBe("end_turn");
    expect(response.message.content).toEqual([{ type: "text", text: "7月の経費は 350 円です。" }]);
    expect(response.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 25,
      cachedInputTokens: 1000,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(calls[0]?.headers["x-api-key"]).toBe("test-key");
  });

  test("sends the system prompt, the tools, the limit and the default cache control", async () => {
    const { calls, provider } = recorded(200, await fixture("text-only"));

    await provider.generate(request);

    const body = calls[0]?.body ?? {};
    expect(body.model).toBe("claude-opus-5");
    expect(body.max_tokens).toBe(4000);
    expect(body.system).toBe("あなたは経理担当です。");
    expect(body.cache_control).toEqual({ type: "ephemeral" });
    expect(body.tools).toEqual([
      {
        name: "csv_read",
        description: "Read a CSV file.",
        input_schema: {
          type: "object",
          properties: { path: { type: "string" } },
          required: ["path"],
        },
      },
    ]);
    expect(body.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "7月の経費を集計して" }] },
    ]);
  });

  test("puts providerOptions on the request, with effort as a shorthand for output_config", async () => {
    const { calls, provider } = recorded(200, await fixture("text-only"));

    await provider.generate({
      ...request,
      providerOptions: { effort: "high", thinking: { type: "adaptive" } },
    });

    const body = calls[0]?.body ?? {};
    expect(body.output_config).toEqual({ effort: "high" });
    expect(body.thinking).toEqual({ type: "adaptive" });
    expect(body.effort).toBeUndefined();
  });

  test("turns tool_use into a tool call and keeps thinking as an opaque part that goes back unchanged", async () => {
    const { calls, provider } = recorded(200, await fixture("tool-use"));

    const response = await provider.generate(request);

    expect(response.stopReason).toBe("tool_call");
    expect(response.message.content).toEqual([
      {
        type: "opaque",
        provider: "anthropic",
        data: { type: "thinking", thinking: "", signature: "sig_abc" },
      },
      { type: "text", text: "まず CSV を読みます。" },
      {
        type: "tool_call",
        id: "toolu_01",
        name: "csv_read",
        input: { path: "receipts/2026-07.csv" },
      },
    ]);
    expect(response.usage.reasoningTokens).toBe(120);
    expect(response.usage.cacheWriteTokens).toBe(1200);

    await provider.generate({
      ...request,
      messages: [
        ...request.messages,
        response.message,
        {
          role: "user",
          content: [
            { type: "tool_result", callId: "toolu_01", content: "date,amount", isError: false },
          ],
        },
      ],
    });

    const messages = (calls[1]?.body.messages ?? []) as { role: string; content: unknown[] }[];
    expect(messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig_abc" },
        { type: "text", text: "まず CSV を読みます。" },
        {
          type: "tool_use",
          id: "toolu_01",
          name: "csv_read",
          input: { path: "receipts/2026-07.csv" },
        },
      ],
    });
    expect(messages[2]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "date,amount" }],
    });
  });

  test("marks a failed tool result as an error for the model", async () => {
    const { calls, provider } = recorded(200, await fixture("text-only"));

    await provider.generate({
      ...request,
      messages: [
        ...request.messages,
        {
          role: "assistant",
          content: [{ type: "tool_call", id: "toolu_02", name: "csv_read", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", callId: "toolu_02", content: "no such file", isError: true },
          ],
        },
      ],
    });

    const messages = (calls[0]?.body.messages ?? []) as { content: unknown[] }[];
    expect(messages[2]?.content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "toolu_02",
      content: "no such file",
      is_error: true,
    });
  });

  test("reports max_tokens and refusal as they are", async () => {
    const cut = recorded(200, await fixture("max-tokens"));
    const refused = recorded(200, await fixture("refusal"));

    expect((await cut.provider.generate(request)).stopReason).toBe("max_tokens");
    const refusal = await refused.provider.generate(request);
    expect(refusal.stopReason).toBe("refusal");
    expect(refusal.message.content).toEqual([]);
  });

  test("keeps the runtime's model, limit, tools and messages even when providerOptions name them", async () => {
    const { calls, provider } = recorded(200, await fixture("text-only"));

    await provider.generate({
      ...request,
      providerOptions: { model: "other", max_tokens: 1, messages: [], tools: [], effort: 3 },
    });

    const body = calls[0]?.body ?? {};
    expect(body.model).toBe("claude-opus-5");
    expect(body.max_tokens).toBe(4000);
    expect((body.messages as unknown[]).length).toBe(1);
    expect((body.tools as unknown[]).length).toBe(1);
    expect(body.output_config).toEqual({ effort: 3 });
  });

  test("sends requests under a base URL, with or without its /v1", async () => {
    const withV1 = recorded(200, await fixture("text-only"), {
      baseUrl: "http://localhost:9999/v1",
    });
    const bare = recorded(200, await fixture("text-only"), { baseUrl: "http://localhost:9999" });

    await withV1.provider.generate(request);
    await bare.provider.generate(request);

    expect(withV1.calls[0]?.url).toBe("http://localhost:9999/v1/messages");
    expect(bare.calls[0]?.url).toBe("http://localhost:9999/v1/messages");
  });

  test("reports a rate limit after the SDK's retries, and a server error as a network error", async () => {
    const limited = recorded(429, {
      type: "error",
      error: { type: "rate_limit_error", message: "slow down" },
    });
    const broken = recorded(500, { type: "error", error: { type: "api_error", message: "boom" } });

    const limit = await limited.provider.generate(request).catch((e: unknown) => e);
    const server = await broken.provider.generate(request).catch((e: unknown) => e);

    expect((limit as OpenshainError).code).toBe("rate_limit");
    expect(limited.calls.length).toBeGreaterThan(1);
    expect((server as OpenshainError).code).toBe("network");
  });

  test("reports an aborted request as a network error and an unreadable body as an invalid response", async () => {
    const { provider } = recorded(200, await fixture("text-only"));
    const controller = new AbortController();
    controller.abort();
    const garbled = recorded(200, undefined, { raw: "<html>oops</html>" });

    const aborted = await provider.generate(request, controller.signal).catch((e: unknown) => e);
    const unreadable = await garbled.provider.generate(request).catch((e: unknown) => e);

    expect((aborted as OpenshainError).code).toBe("network");
    expect(unreadable).toBeInstanceOf(OpenshainError);
    expect((unreadable as OpenshainError).code).toBe("invalid_response");
  });

  test("turns an authentication failure into an auth error", async () => {
    const { provider } = recorded(401, await fixture("auth-error"));

    const err = await provider.generate(request).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenshainError);
    expect((err as OpenshainError).code).toBe("auth");
    expect((err as OpenshainError).message).toContain("invalid x-api-key");
  });
});

describe("anthropicProvider from the config", () => {
  const model = {
    provider: "anthropic",
    model: "claude-opus-5",
    apiKeyEnv: "MY_KEY",
    baseUrl: undefined,
    options: undefined,
  };

  test("reads the key from the named environment variable", () => {
    const provider = anthropicProvider(model, { MY_KEY: "k" });

    expect(provider.describe().model).toBe("claude-opus-5");
  });

  test("refuses to start without the key, naming the variable", () => {
    const err = (() => {
      try {
        anthropicProvider(model, {});
        return undefined;
      } catch (e) {
        return e;
      }
    })();

    expect(err).toBeInstanceOf(OpenshainError);
    expect((err as OpenshainError).code).toBe("config");
    expect((err as OpenshainError).message).toContain("MY_KEY");
  });
});
