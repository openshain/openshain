import { describe, expect, test } from "bun:test";
import { newEventId, newWorkId } from "../ids.ts";
import type { ToolDefinition } from "../tool/types.ts";
import type { AnyEvent, Event, EventPayloads, EventType } from "./events.ts";
import { buildProjection, type ProjectionInput } from "./projection.ts";

const workId = newWorkId();
let seq = 0;

function event<T extends EventType>(type: T, payload: EventPayloads[T]): Event<T> {
  seq += 1;
  const at = `2026-09-10T01:00:${String(seq).padStart(2, "0")}.000Z`;
  return {
    v: 1,
    id: newEventId(),
    workId,
    seq,
    type,
    occurredAt: at,
    recordedAt: at,
    payload,
  } as Event<T>;
}

const fsRead: ToolDefinition = {
  name: "fs_read",
  description: "read a file",
  inputSchema: { type: "object" },
  effect: "observe",
};

function input(events: AnyEvent[], overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    events,
    config: {
      company: { name: "サンプル株式会社" },
      principal: { id: "alice", name: "Alice" },
      profession: { id: "generic", instructions: "事務担当として働く。" },
    },
    tools: [fsRead],
    providerId: "anthropic",
    budget: { modelCallsLeft: 29, toolCallsLeft: 100 },
    ...overrides,
  };
}

const created = event("work.created", {
  objective: "receipts/ を集計して",
  principal: "alice",
  profession: "generic",
  type: "request",
});

describe("buildProjection", () => {
  test("puts the instructions, company and principal in the system prompt", () => {
    const projection = buildProjection(input([created]));

    expect(projection.system).toContain("事務担当として働く。");
    expect(projection.system).toContain("サンプル株式会社");
    expect(projection.system).toContain("Alice");
    expect(projection.system).toContain("alice");
  });

  test("starts the conversation with the objective as a user message", () => {
    const projection = buildProjection(input([created]));

    expect(projection.messages[0]?.role).toBe("user");
    expect(projection.messages[0]?.content[0]).toEqual({
      type: "text",
      text: "receipts/ を集計して",
    });
  });

  test("passes the tool definitions through unchanged", () => {
    expect(buildProjection(input([created])).tools).toEqual([fsRead]);
  });

  test("appends the remaining budget to the last user message only", () => {
    const projection = buildProjection(input([created]));

    const last = projection.messages.at(-1);
    expect(last?.role).toBe("user");
    expect(last?.content.at(-1)).toEqual({
      type: "text",
      text: "残り: model 呼び出し 29 回、Tool 呼び出し 100 回",
    });
    expect(projection.messages).toHaveLength(1);
  });

  test("replays assistant output and groups the tool results into one user message", () => {
    const events: AnyEvent[] = [
      created,
      event("model.completed", {
        stopReason: "tool_call",
        content: [
          { type: "text", text: "2 つ読みます" },
          { type: "tool_call", id: "c1", name: "fs_read", input: { path: "a.csv" } },
          { type: "tool_call", id: "c2", name: "fs_read", input: { path: "../x" } },
        ],
      }),
      event("tool.called", {
        callId: "c1",
        provider: "standard",
        name: "fs_read",
        input: { path: "a.csv" },
      }),
      event("tool.completed", {
        callId: "c1",
        content: [{ type: "text", text: "a,b\n1,2" }],
        isError: false,
      }),
      event("tool.rejected", {
        callId: "c2",
        name: "fs_read",
        reason: "path escapes the workspace",
      }),
    ];

    const projection = buildProjection(input(events));

    expect(projection.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(projection.messages[1]?.content).toEqual([
      { type: "text", text: "2 つ読みます" },
      { type: "tool_call", id: "c1", name: "fs_read", input: { path: "a.csv" } },
      { type: "tool_call", id: "c2", name: "fs_read", input: { path: "../x" } },
    ]);
    expect(projection.messages[2]?.content).toEqual([
      { type: "tool_result", callId: "c1", content: "a,b\n1,2", isError: false },
      { type: "tool_result", callId: "c2", content: "path escapes the workspace", isError: true },
      { type: "text", text: "残り: model 呼び出し 29 回、Tool 呼び出し 100 回" },
    ]);
    expect(projection.messages[0]?.content).toHaveLength(1);
  });

  test("renders json tool content as JSON text", () => {
    const events: AnyEvent[] = [
      created,
      event("model.completed", {
        stopReason: "tool_call",
        content: [{ type: "tool_call", id: "c1", name: "fs_read", input: {} }],
      }),
      event("tool.completed", {
        callId: "c1",
        content: [{ type: "json", value: { rows: 2 } }],
        isError: false,
      }),
    ];

    const projection = buildProjection(input(events));

    expect(projection.messages[2]?.content[0]).toEqual({
      type: "tool_result",
      callId: "c1",
      content: '{"rows":2}',
      isError: false,
    });
  });

  test("returns opaque parts to the provider that produced them and to no other", () => {
    const events: AnyEvent[] = [
      created,
      event("model.completed", {
        stopReason: "tool_call",
        content: [
          { type: "opaque", provider: "anthropic", data: { thinking: "…" } },
          { type: "tool_call", id: "c1", name: "fs_read", input: {} },
        ],
      }),
      event("tool.completed", {
        callId: "c1",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    ];

    const same = buildProjection(input(events, { providerId: "anthropic" }));
    const other = buildProjection(input(events, { providerId: "openai-compatible" }));

    expect(same.messages[1]?.content[0]).toEqual({
      type: "opaque",
      provider: "anthropic",
      data: { thinking: "…" },
    });
    expect(other.messages[1]?.content).toEqual([
      { type: "tool_call", id: "c1", name: "fs_read", input: {} },
    ]);
  });

  test("ignores events that carry no conversation content", () => {
    const events: AnyEvent[] = [
      created,
      event("work.status_changed", { from: "queued", to: "in_progress", reason: "run" }),
      event("model.requested", {
        provider: "anthropic",
        model: "m",
        messageCount: 1,
        toolNames: [],
      }),
      event("usage.recorded", {
        kind: "model_inference",
        provider: "anthropic",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
      event("human.input_requested", { question: "どの月?" }),
      { ...event("work.completed", { summary: "x" }), type: "plugin.custom", payload: {} },
    ];

    expect(buildProjection(input(events)).messages).toHaveLength(1);
  });

  test("builds byte-identical output from the same events", () => {
    const events: AnyEvent[] = [
      created,
      event("model.completed", {
        stopReason: "tool_call",
        content: [
          { type: "opaque", provider: "anthropic", data: { b: 1, a: 2 } },
          { type: "tool_call", id: "c1", name: "fs_read", input: { z: 1, a: [1, 2] } },
        ],
      }),
      event("tool.completed", {
        callId: "c1",
        content: [{ type: "text", text: "ok" }],
        isError: false,
      }),
    ];

    const first = JSON.stringify(buildProjection(input(events)));
    const second = JSON.stringify(buildProjection(input(events)));

    expect(first).toBe(second);
  });
});
