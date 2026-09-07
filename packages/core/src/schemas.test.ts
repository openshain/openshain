import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { parse as parseYaml } from "yaml";
import { jsonSchemas } from "./schemas.ts";
import { EVENTS_FILE_NAME } from "./work/event-log.ts";
import { payloadFileSchemas } from "./work/events.ts";
import { WORK_DIR_NAME, WorkStore } from "./work/store.ts";
import { workToFile } from "./work/work.ts";

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validate = Object.fromEntries(
  Object.entries(jsonSchemas()).map(([name, schema]) => [name, ajv.compile(schema)]),
);

const CONFIG = `version: 1
company:
  name: サンプル株式会社
principal:
  id: alice
  name: Alice
profession:
  id: generic
  instructions: 事務担当として働く。
model:
  provider: anthropic
  model: claude-opus-5
  api_key_env: ANTHROPIC_API_KEY
tools:
  - provider: standard
    allow: [fs_list, fs_read]
  - module: ./tools/my-tool.ts
limits:
  max_model_calls: 30
`;

/** A work whose log carries every event type once, in a legal order. */
async function logWithEveryType() {
  const root = await mkdtemp(join(tmpdir(), "openshain-schemas-"));
  const store = new WorkStore(root);
  const work = await store.create({
    objective: "集計して",
    principal: "alice",
    profession: "generic",
  });
  const now = new Date().toISOString();
  const handle = await store.open(work.id);
  try {
    await handle.append({
      type: "work.status_changed",
      payload: { from: "queued", to: "in_progress", reason: "test" },
    });
    await handle.append({
      type: "model.requested",
      payload: { provider: "fake", model: "fake-1", messageCount: 1, toolNames: ["fs_list"] },
    });
    await handle.append({
      type: "model.completed",
      payload: {
        stopReason: "tool_call",
        content: [
          { type: "text", text: "見ます" },
          { type: "tool_call", id: "c1", name: "fs_list", input: { path: "." } },
          { type: "opaque", provider: "fake", data: { thinking: "…" } },
        ],
      },
    });
    await handle.append({
      type: "usage.recorded",
      payload: {
        kind: "model_inference",
        provider: "fake",
        model: "fake-1",
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 4 },
      },
    });
    await handle.append({
      type: "tool.called",
      payload: { callId: "c1", provider: "standard", name: "fs_list", input: { path: "." } },
    });
    await handle.append({
      type: "tool.completed",
      payload: {
        callId: "c1",
        content: [
          { type: "json", value: { entries: [] } },
          { type: "text", text: "x" },
        ],
        isError: false,
        observation: { source: ".", retrievedAt: now },
        after: [{ path: "a.md", sha256: "00", claimed: true }],
      },
    });
    await handle.append({
      type: "usage.recorded",
      payload: { kind: "tool_execution", provider: "standard", usage: { durationMs: 3 } },
    });
    await handle.append({
      type: "tool.rejected",
      payload: { callId: "c2", name: "nope", code: "unknown_tool", reason: "no such tool" },
    });
    await handle.append({
      type: "human.input_requested",
      payload: { callId: "c3", question: "どの月?" },
    });
    await handle.append({ type: "human.input_provided", payload: { callId: "c3", answer: "7月" } });
    await handle.append({ type: "human.message", payload: { text: "続きもお願い" } });
    await handle.append({
      type: "prompt.expanded",
      payload: { name: "work resume", source: "builtin", text: "候補の Work" },
    });
    await handle.append({ type: "model.failed", payload: { code: "network", message: "down" } });
    await handle.append({
      type: "evidence.recorded",
      payload: {
        claim: "done",
        refs: [],
        artifacts: [{ path: "a.md", sha256: "00", missing: true }],
      },
    });
    await handle.append({ type: "work.completed", payload: { summary: "done" } });
  } finally {
    await handle.close();
  }
  const failed = await store.create({ objective: "x", principal: "alice", profession: "generic" });
  const second = await store.open(failed.id);
  try {
    await second.append({
      type: "work.status_changed",
      payload: { from: "queued", to: "in_progress", reason: "test" },
    });
    await second.append({ type: "work.failed", payload: { reason: "model_error", detail: "x" } });
  } finally {
    await second.close();
  }
  const lines: Record<string, unknown>[] = [];
  for (const id of [work.id, failed.id]) {
    const text = await readFile(join(root, WORK_DIR_NAME, id, EVENTS_FILE_NAME), "utf8");
    for (const line of text.split("\n")) if (line !== "") lines.push(JSON.parse(line));
  }
  return { store, work, failed, lines };
}

describe("events.v1", () => {
  test("accepts every line the runtime writes, for every event type", async () => {
    const { lines } = await logWithEveryType();

    const types = new Set(lines.map((line) => line.type as string));
    expect([...types].sort()).toEqual(Object.keys(payloadFileSchemas).sort());
    for (const line of lines) {
      expect(validate["events.v1"]?.(line), JSON.stringify(validate["events.v1"]?.errors)).toBe(
        true,
      );
    }
  });

  test("keeps the envelope strict and the payload open, and admits a type it does not know", async () => {
    const { lines } = await logWithEveryType();
    const completed = lines.find((line) => line.type === "work.completed") as Record<
      string,
      unknown
    >;
    const check = (line: unknown) => validate["events.v1"]?.(line) === true;

    expect(check({ ...completed, extra: 1 })).toBe(false);
    expect(check({ ...completed, v: 2 })).toBe(false);
    expect(check({ ...completed, payload: {} })).toBe(false);
    expect(check({ ...completed, payload: { summary: "done", later_field: true } })).toBe(true);
    expect(check({ ...completed, type: "future.event", payload: { anything: [1] } })).toBe(true);
  });
});

describe("config.v1", () => {
  test("accepts a config the runtime accepts and refuses an unknown key", () => {
    const config = parseYaml(CONFIG) as Record<string, unknown>;

    expect(validate["config.v1"]?.(config), JSON.stringify(validate["config.v1"]?.errors)).toBe(
      true,
    );
    expect(validate["config.v1"]?.({ ...config, extra: 1 })).toBe(false);
    expect(validate["config.v1"]?.({ ...config, version: 2 })).toBe(false);
  });
});

describe("work.v1", () => {
  test("accepts work.json for a fresh, a completed and a failed work", async () => {
    const { store, work, failed } = await logWithEveryType();

    for (const id of [work.id, failed.id]) {
      const file = workToFile(await store.get(id));
      expect(validate["work.v1"]?.(file), JSON.stringify(validate["work.v1"]?.errors)).toBe(true);
    }
    expect(validate["work.v1"]?.({ ...workToFile(work), status: "done" })).toBe(false);
  });
});
