import { describe, expect, test } from "bun:test";
import { OpenshainError } from "../errors.ts";
import { newEventId, newWorkId } from "../ids.ts";
import { canonical, type Event, eventFromFile, eventToFile } from "./events.ts";

const base = {
  v: 1 as const,
  id: newEventId(),
  workId: newWorkId(),
  seq: 3,
  occurredAt: "2026-09-10T01:23:45.000Z",
  recordedAt: "2026-09-10T01:23:45.100Z",
};

const samples: Event[] = [
  {
    ...base,
    type: "work.created",
    payload: { objective: "集計して", principal: "alice", profession: "generic", type: "request" },
  },
  {
    ...base,
    type: "work.status_changed",
    payload: { from: "queued", to: "in_progress", reason: "run" },
  },
  {
    ...base,
    type: "model.requested",
    payload: {
      provider: "anthropic",
      model: "claude-opus-5",
      messageCount: 3,
      toolNames: ["fs_read"],
    },
  },
  {
    ...base,
    type: "model.completed",
    payload: {
      stopReason: "tool_call",
      content: [
        { type: "text", text: "読みます" },
        { type: "tool_call", id: "call_1", name: "fs_read", input: { path: "a.csv" } },
        { type: "opaque", provider: "anthropic", data: { signature: "x" } },
      ],
    },
  },
  { ...base, type: "model.failed", payload: { code: "rate_limit", message: "slow down" } },
  {
    ...base,
    type: "tool.called",
    payload: { callId: "call_1", provider: "standard", name: "fs_read", input: { path: "a.csv" } },
  },
  {
    ...base,
    type: "tool.completed",
    payload: {
      callId: "call_1",
      content: [{ type: "text", text: "a,b\n1,2" }],
      isError: false,
      observation: { source: "a.csv", retrievedAt: "2026-09-10T01:23:45.050Z" },
      after: [{ path: "out.md", sha256: "abc" }],
    },
  },
  {
    ...base,
    type: "tool.rejected",
    payload: {
      callId: "call_2",
      name: "fs_write",
      code: "outside_workspace",
      reason: "path escapes the workspace",
    },
  },
  { ...base, type: "human.input_requested", payload: { callId: "call_3", question: "どの月?" } },
  { ...base, type: "human.input_provided", payload: { callId: "call_3", answer: "7月" } },
  {
    ...base,
    type: "usage.recorded",
    payload: {
      kind: "model_inference",
      provider: "anthropic",
      model: "claude-opus-5",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 80,
        cacheWriteTokens: 10,
        reasoningTokens: 5,
      },
    },
  },
  {
    ...base,
    type: "model.completed",
    payload: {
      stopReason: "end_turn",
      content: [{ type: "text", text: "done" }],
      raw: { id: "msg_1" },
    },
  },
  {
    ...base,
    type: "usage.recorded",
    payload: { kind: "tool_execution", provider: "standard", usage: { durationMs: 12 } },
  },
  {
    ...base,
    type: "evidence.recorded",
    payload: {
      claim: "summary.md を作成",
      refs: ["evt_x"],
      artifacts: [{ path: "summary.md", sha256: "abc" }],
    },
  },
  { ...base, type: "work.completed", payload: { summary: "done" } },
  { ...base, type: "work.failed", payload: { reason: "limit_reached", detail: "30 model calls" } },
];

describe("event file mapping", () => {
  test.each(samples.map((e) => [e.type, e] as const))("%s survives a round trip", (_, event) => {
    expect(eventFromFile(eventToFile(event))).toEqual(event);
  });

  test("writes snake_case keys and keeps tool input untouched", () => {
    const event = samples.find((e) => e.type === "tool.completed");
    if (!event) throw new Error("sample missing");

    const file = eventToFile(event) as Record<string, unknown>;
    const payload = file.payload as Record<string, unknown>;

    expect(Object.keys(file)).toEqual([
      "v",
      "id",
      "work_id",
      "seq",
      "type",
      "occurred_at",
      "recorded_at",
      "payload",
    ]);
    expect(payload.call_id).toBe("call_1");
    expect(payload.is_error).toBe(false);
    expect((payload.observation as Record<string, unknown>).retrieved_at).toBe(
      "2026-09-10T01:23:45.050Z",
    );
  });

  test("keeps arbitrary keys inside tool input as written", () => {
    const event: Event = {
      ...base,
      type: "tool.called",
      payload: {
        callId: "c",
        provider: "p",
        name: "t",
        input: { file_name: "x", nested: { camelCase: 1 } },
      },
    };

    expect(eventFromFile(eventToFile(event))).toEqual(event);
  });

  test("writes usage token counts in snake_case", () => {
    const event = samples.find((e) => e.type === "usage.recorded");
    if (!event) throw new Error("sample missing");

    const payload = eventToFile(event).payload as { usage: Record<string, unknown> };

    expect(payload.usage).toEqual({
      cache_write_tokens: 10,
      cached_input_tokens: 80,
      input_tokens: 100,
      output_tokens: 20,
      reasoning_tokens: 5,
    });
  });

  test("passes unknown event types through without validating the payload", () => {
    const file = {
      ...eventToFile(samples[0] as Event),
      type: "plugin.custom",
      payload: { anything: [1, 2] },
    };

    const event = eventFromFile(file);

    expect(event.type).toBe("plugin.custom");
    expect(event.payload).toEqual({ anything: [1, 2] });
  });

  test("rejects a known type whose payload has the wrong shape", () => {
    const file = {
      ...eventToFile(samples[0] as Event),
      type: "tool.called",
      payload: { name: "fs_read" },
    };

    expect(() => eventFromFile(file)).toThrow(OpenshainError);
    try {
      eventFromFile(file);
    } catch (err) {
      expect((err as OpenshainError).code).toBe("corrupt_log");
      expect((err as OpenshainError).message).toContain("call_id");
    }
  });

  test("rejects an envelope with a bad timestamp", () => {
    const file = { ...eventToFile(samples[0] as Event), occurred_at: "yesterday" };

    expect(() => eventFromFile(file)).toThrow(OpenshainError);
  });
});

describe("event file hardening", () => {
  test("keeps a payload field this version does not know, so newer logs stay readable", () => {
    const file = eventToFile(samples[0] as Event);
    const withExtra = { ...file, payload: { ...(file.payload as object), added_later: "x" } };

    const event = eventFromFile(withExtra);

    expect((event.payload as Record<string, unknown>).added_later).toBe("x");
  });

  test("writes undefined inside free-form data as null so the line stays readable", () => {
    const event: Event = {
      ...base,
      type: "tool.completed",
      payload: { callId: "c", content: [{ type: "json", value: undefined }], isError: false },
    };

    const file = eventToFile(event);
    const line = JSON.stringify(file);

    expect(line).toContain('"value":null');
    expect(() => eventFromFile(JSON.parse(line))).not.toThrow();
  });

  test("sorts object keys inside data so equal events are equal bytes", () => {
    const a: Event = {
      ...base,
      type: "tool.called",
      payload: { callId: "c", provider: "p", name: "t", input: { z: 1, a: { d: 1, b: 2 } } },
    };
    const b: Event = {
      ...base,
      type: "tool.called",
      payload: { callId: "c", provider: "p", name: "t", input: { a: { b: 2, d: 1 }, z: 1 } },
    };

    expect(JSON.stringify(eventToFile(a))).toBe(JSON.stringify(eventToFile(b)));
  });

  test("omits raw from model.completed unless it was given", () => {
    const event = samples.find((e) => e.type === "model.completed" && !("raw" in e.payload));
    if (!event) throw new Error("sample missing");

    expect(eventToFile(event).payload).not.toHaveProperty("raw");
  });
});

describe("canonical form and cycles", () => {
  test("refuses a value that refers to itself instead of recursing forever", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => canonical({ raw: circular })).toThrow(OpenshainError);
  });

  test("accepts the same object reached twice without a cycle", () => {
    const shared = { a: 1 };

    expect(canonical({ x: shared, y: shared })).toEqual({ x: { a: 1 }, y: { a: 1 } });
  });
});
