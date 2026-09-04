import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ModelRequest, OpenshainError } from "@openshain/core";
import { OpenAICompatibleProvider, openaiCompatibleProvider } from "./openai-compatible.ts";

const fixtures = join(import.meta.dir, "..", "..", "fixtures", "openai");

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
function recorded(
  status: number,
  body: unknown,
  options: { baseUrl?: string; raw?: string; tools?: boolean } = {},
) {
  const calls: Recorded[] = [];
  const stub = async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    return new Response(options.raw ?? JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", "retry-after-ms": "1" },
    });
  };
  const provider = new OpenAICompatibleProvider({
    model: "gpt-5",
    apiKey: "test-key",
    fetch: stub,
    ...(options.baseUrl && { baseUrl: options.baseUrl }),
    ...(options.tools === false && { tools: false }),
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

describe("OpenAICompatibleProvider", () => {
  test("describes itself, with tool support unless told otherwise", () => {
    expect(recorded(200, {}).provider.describe()).toEqual({
      provider: "openai-compatible",
      model: "gpt-5",
      capabilities: { tools: true },
    });
    expect(recorded(200, {}, { tools: false }).provider.describe().capabilities.tools).toBe(false);
  });

  test("turns a text answer into an end_turn response with the usage, cached tokens included", async () => {
    const { calls, provider } = recorded(200, await fixture("text-only"));

    const response = await provider.generate(request);

    expect(response.stopReason).toBe("end_turn");
    expect(response.message.content).toEqual([{ type: "text", text: "7月の経費は 350 円です。" }]);
    expect(response.usage).toEqual({
      inputTokens: 1200,
      outputTokens: 25,
      cachedInputTokens: 1000,
      reasoningTokens: 0,
    });
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]?.headers.authorization).toBe("Bearer test-key");
  });

  test("sends the system prompt first, the tools as functions and the limit as max_completion_tokens", async () => {
    const { calls, provider } = recorded(200, await fixture("text-only"));

    await provider.generate(request);

    const body = calls[0]?.body ?? {};
    expect(body.model).toBe("gpt-5");
    expect(body.max_completion_tokens).toBe(4000);
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "system", content: "あなたは経理担当です。" },
      { role: "user", content: "7月の経費を集計して" },
    ]);
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "csv_read",
          description: "Read a CSV file.",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      },
    ]);
  });

  test("puts providerOptions on the request and lets max_tokens replace max_completion_tokens", async () => {
    const { calls, provider } = recorded(200, await fixture("text-only"));

    await provider.generate({
      ...request,
      providerOptions: { reasoning_effort: "high", max_tokens: 500, tools: false, model: "other" },
    });

    const body = calls[0]?.body ?? {};
    expect(body.reasoning_effort).toBe("high");
    expect(body.max_tokens).toBe(500);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.model).toBe("gpt-5");
    expect((body.tools as unknown[]).length).toBe(1);
  });

  test("never streams, even when the options ask for it", async () => {
    const { calls, provider } = recorded(200, await fixture("text-only"));

    const response = await provider.generate({ ...request, providerOptions: { stream: true } });

    expect(response.stopReason).toBe("end_turn");
    expect(calls[0]?.body.stream).toBe(false);
  });

  test("joins content that a server returns as text parts", async () => {
    const parts = (await fixture("text-only")) as { choices: { message: { content: unknown } }[] };
    if (parts.choices[0]) {
      parts.choices[0].message.content = [
        { type: "text", text: "7月の経費は " },
        { type: "text", text: "350 円です。" },
      ];
    }
    const { provider } = recorded(200, parts);

    const response = await provider.generate(request);

    expect(response.message.content).toEqual([{ type: "text", text: "7月の経費は 350 円です。" }]);
  });

  test("sends requests to the base URL from the config", async () => {
    const { calls, provider } = recorded(200, await fixture("text-only"), {
      baseUrl: "http://localhost:11434/v1",
    });

    await provider.generate(request);

    expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
  });

  test("turns tool calls into tool_call parts, keeps the server's extra fields opaque, and sends both back", async () => {
    const { calls, provider } = recorded(200, await fixture("tool-calls"));

    const response = await provider.generate(request);

    expect(response.stopReason).toBe("tool_call");
    expect(response.message.content).toEqual([
      {
        type: "tool_call",
        id: "call_01",
        name: "csv_read",
        input: { path: "receipts/2026-07.csv" },
      },
      {
        type: "opaque",
        provider: "openai-compatible",
        data: { reasoning_content: "まず CSV を読む。" },
      },
    ]);
    expect(response.usage.reasoningTokens).toBe(120);

    await provider.generate({
      ...request,
      messages: [
        ...request.messages,
        response.message,
        {
          role: "user",
          content: [
            { type: "tool_result", callId: "call_01", content: "date,amount", isError: false },
          ],
        },
      ],
    });

    const messages = (calls[1]?.body.messages ?? []) as Record<string, unknown>[];
    expect(messages[2]).toEqual({
      role: "assistant",
      reasoning_content: "まず CSV を読む。",
      tool_calls: [
        {
          id: "call_01",
          type: "function",
          function: { name: "csv_read", arguments: '{"path":"receipts/2026-07.csv"}' },
        },
      ],
    });
    expect(messages[3]).toEqual({ role: "tool", tool_call_id: "call_01", content: "date,amount" });
  });

  test("passes arguments that are not JSON on as text, so the schema check can report them", async () => {
    const broken = (await fixture("tool-calls")) as {
      choices: { message: { tool_calls: { function: { arguments: string } }[] } }[];
    };
    const call = broken.choices[0]?.message.tool_calls[0];
    if (call) call.function.arguments = "{not json";
    const { provider } = recorded(200, broken);

    const response = await provider.generate(request);

    expect(response.message.content[0]).toMatchObject({ type: "tool_call", input: "{not json" });
  });

  test("treats tool calls as tool calls even when the server says it stopped", async () => {
    const said = (await fixture("tool-calls")) as { choices: { finish_reason: string }[] };
    if (said.choices[0]) said.choices[0].finish_reason = "stop";
    const { provider } = recorded(200, said);

    expect((await provider.generate(request)).stopReason).toBe("tool_call");
  });

  test("reports length as max_tokens and a content filter as a refusal", async () => {
    const cut = recorded(200, await fixture("length"));
    const filtered = recorded(200, await fixture("content-filter"));

    expect((await cut.provider.generate(request)).stopReason).toBe("max_tokens");
    const refusal = await filtered.provider.generate(request);
    expect(refusal.stopReason).toBe("refusal");
    expect(refusal.message.content).toEqual([]);
  });

  test("turns an authentication failure into an auth error, and a rate limit into rate_limit after retries", async () => {
    const denied = recorded(401, await fixture("auth-error"));
    const limited = recorded(429, { error: { message: "slow down", type: "rate_limit_error" } });

    const auth = await denied.provider.generate(request).catch((e: unknown) => e);
    const limit = await limited.provider.generate(request).catch((e: unknown) => e);

    expect(auth).toBeInstanceOf(OpenshainError);
    expect((auth as OpenshainError).code).toBe("auth");
    expect((limit as OpenshainError).code).toBe("rate_limit");
    expect(limited.calls.length).toBeGreaterThan(1);
  });

  test("reports a completion without choices as an invalid response", async () => {
    const { provider } = recorded(200, { id: "x", object: "chat.completion", choices: [] });

    const err = await provider.generate(request).catch((e: unknown) => e);

    expect((err as OpenshainError).code).toBe("invalid_response");
  });
});

describe("openaiCompatibleProvider from the config", () => {
  const model = {
    provider: "openai-compatible",
    model: "gpt-5",
    apiKeyEnv: "MY_KEY",
    baseUrl: "http://localhost:11434/v1",
    options: undefined,
  };

  test("reads the key from the named environment variable and refuses to start without it", () => {
    expect(openaiCompatibleProvider(model, { MY_KEY: "k" }).describe().model).toBe("gpt-5");

    const err = (() => {
      try {
        openaiCompatibleProvider(model, {});
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect((err as OpenshainError).code).toBe("config");
    expect((err as OpenshainError).message).toContain("MY_KEY");
  });

  test("declares an endpoint without tool support from options.tools: false", () => {
    const provider = openaiCompatibleProvider(
      { ...model, options: { tools: false } },
      { MY_KEY: "k" },
    );

    expect(provider.describe().capabilities.tools).toBe(false);
  });
});
