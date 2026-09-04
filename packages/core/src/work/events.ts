import { z } from "zod";
import { OpenshainError } from "../errors.ts";
import type { EventId, WorkId } from "../ids.ts";

// ---------------------------------------------------------------------------
// Code-side types (camelCase)
// ---------------------------------------------------------------------------

export type StopReason = "end_turn" | "tool_call" | "max_tokens" | "refusal" | "other";

export type AssistantPart =
  | { type: "text"; text: string }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "opaque"; provider: string; data: unknown };

export type ToolContent = { type: "text"; text: string } | { type: "json"; value: unknown };

/** A file a work produced. `missing` means the runtime could not read it when the work ended; the hash is then the tool's report. */
export type Artifact = { path: string; sha256: string; missing?: true };

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export const TOOL_REJECTION_CODES = [
  "schema_mismatch",
  "unknown_tool",
  "not_allowed",
  "reserved_path",
  "outside_workspace",
  "invalid_path",
] as const;

export type ToolRejectionCode = (typeof TOOL_REJECTION_CODES)[number];

export interface EventPayloads {
  "work.created": { objective: string; principal: string; profession: string; type: string };
  "work.status_changed": { from: string; to: string; reason: string };
  "model.requested": { provider: string; model: string; messageCount: number; toolNames: string[] };
  "model.completed": { stopReason: StopReason; content: AssistantPart[]; raw?: unknown };
  "model.failed": { code: string; message: string };
  "tool.called": { callId: string; provider: string; name: string; input: unknown };
  "tool.completed": {
    callId: string;
    content: ToolContent[];
    isError: boolean;
    observation?: { source: string; retrievedAt: string };
    after?: Artifact[];
  };
  "tool.rejected": { callId: string; name: string; code: ToolRejectionCode; reason: string };
  "human.input_requested": { callId: string; question: string };
  "human.input_provided": { callId: string; answer: string };
  "usage.recorded":
    | { kind: "model_inference"; provider: string; model: string; usage: ModelUsage }
    | { kind: "tool_execution"; provider: string; usage: { durationMs: number } };
  "evidence.recorded": { claim: string; refs: string[]; artifacts: Artifact[] };
  "work.completed": { summary: string };
  "work.failed": { reason: string; detail: string };
}

export type EventType = keyof EventPayloads;

interface Envelope {
  v: 1;
  id: EventId;
  workId: WorkId;
  seq: number;
  occurredAt: string;
  recordedAt: string;
}

export type Event<T extends EventType = EventType> = T extends EventType
  ? Envelope & { type: T; payload: EventPayloads[T] }
  : never;

/** An event whose type this version of the runtime does not know. Kept, not validated. */
export type UnknownEvent = Envelope & { type: string; payload: unknown };

export type AnyEvent = Event | UnknownEvent;

// ---------------------------------------------------------------------------
// File-side schemas (snake_case). These are the on-disk contract.
// ---------------------------------------------------------------------------

// Payload schemas are loose: a field added by a newer runtime must not make an
// older runtime refuse the log. Only the envelope is strict; envelope changes bump `v`.
const textPart = z.looseObject({ type: z.literal("text"), text: z.string() });
const toolCallPart = z.looseObject({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const opaquePart = z.looseObject({
  type: z.literal("opaque"),
  provider: z.string(),
  data: z.unknown(),
});
const jsonPart = z.looseObject({ type: z.literal("json"), value: z.unknown() });
const artifact = z.looseObject({
  path: z.string(),
  sha256: z.string(),
  missing: z.literal(true).optional(),
});
const modelUsageFile = z.looseObject({
  input_tokens: z.int().nonnegative(),
  output_tokens: z.int().nonnegative(),
  cached_input_tokens: z.int().nonnegative().optional(),
  cache_write_tokens: z.int().nonnegative().optional(),
  reasoning_tokens: z.int().nonnegative().optional(),
});
type ModelUsageFile = z.infer<typeof modelUsageFile>;

export const payloadFileSchemas = {
  "work.created": z.looseObject({
    objective: z.string(),
    principal: z.string(),
    profession: z.string(),
    type: z.string(),
  }),
  "work.status_changed": z.looseObject({ from: z.string(), to: z.string(), reason: z.string() }),
  "model.requested": z.looseObject({
    provider: z.string(),
    model: z.string(),
    message_count: z.int().nonnegative(),
    tool_names: z.array(z.string()),
  }),
  "model.completed": z.looseObject({
    stop_reason: z.enum(["end_turn", "tool_call", "max_tokens", "refusal", "other"]),
    content: z.array(z.discriminatedUnion("type", [textPart, toolCallPart, opaquePart])),
    raw: z.unknown().optional(),
  }),
  "model.failed": z.looseObject({ code: z.string(), message: z.string() }),
  "tool.called": z.looseObject({
    call_id: z.string(),
    provider: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  "tool.completed": z.looseObject({
    call_id: z.string(),
    content: z.array(z.discriminatedUnion("type", [textPart, jsonPart])),
    is_error: z.boolean(),
    observation: z.looseObject({ source: z.string(), retrieved_at: z.iso.datetime() }).optional(),
    after: z.array(artifact).optional(),
  }),
  "tool.rejected": z.looseObject({
    call_id: z.string(),
    name: z.string(),
    code: z.enum(TOOL_REJECTION_CODES),
    reason: z.string(),
  }),
  "human.input_requested": z.looseObject({ call_id: z.string(), question: z.string() }),
  "human.input_provided": z.looseObject({ call_id: z.string(), answer: z.string() }),
  "usage.recorded": z.discriminatedUnion("kind", [
    z.looseObject({
      kind: z.literal("model_inference"),
      provider: z.string(),
      model: z.string(),
      usage: modelUsageFile,
    }),
    z.looseObject({
      kind: z.literal("tool_execution"),
      provider: z.string(),
      usage: z.looseObject({ duration_ms: z.int().nonnegative() }),
    }),
  ]),
  "evidence.recorded": z.looseObject({
    claim: z.string(),
    refs: z.array(z.string()),
    artifacts: z.array(artifact),
  }),
  "work.completed": z.looseObject({ summary: z.string() }),
  "work.failed": z.looseObject({ reason: z.string(), detail: z.string() }),
} satisfies Record<EventType, z.ZodType>;

export const EventFileSchema = z.strictObject({
  v: z.literal(1),
  id: z.string(),
  work_id: z.string(),
  seq: z.int().positive(),
  type: z.string(),
  occurred_at: z.iso.datetime(),
  recorded_at: z.iso.datetime(),
  payload: z.unknown(),
});

export type EventFile = z.infer<typeof EventFileSchema>;

// ---------------------------------------------------------------------------
// Mapping. The only place where snake_case and camelCase meet.
// ---------------------------------------------------------------------------

export function eventToFile(event: AnyEvent): EventFile {
  const payload = isKnownType(event.type)
    ? payloadToFile(event.type, event.payload as EventPayloads[EventType])
    : event.payload;
  return {
    v: event.v,
    id: event.id,
    work_id: event.workId,
    seq: event.seq,
    type: event.type,
    occurred_at: event.occurredAt,
    recorded_at: event.recordedAt,
    payload: canonical(payload),
  };
}

const DATA_KEYS = new Set(["input", "data", "value", "raw"]);

/**
 * Canonical JSON form: object keys sorted recursively so that equal data is
 * written as equal bytes. Inside the free-form fields (`input`, `data`, `value`,
 * `raw`) `undefined` becomes `null`, because JSON has no `undefined` and a
 * dropped key would make the line unreadable.
 */
export function canonical(
  value: unknown,
  insideData = false,
  seen: WeakSet<object> = new WeakSet(),
): unknown {
  if (value === undefined) return insideData ? null : undefined;
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) {
    throw new OpenshainError("invalid_event", "a value that refers to itself cannot be recorded");
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonical(item, insideData, seen) ?? null);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const inner = insideData || DATA_KEYS.has(key);
      const item = canonical((value as Record<string, unknown>)[key], inner, seen);
      if (item !== undefined) out[key] = item;
      else if (inner) out[key] = null;
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

export function eventFromFile(input: unknown): AnyEvent {
  const parsed = EventFileSchema.safeParse(input);
  if (!parsed.success) {
    throw new OpenshainError("corrupt_log", `event envelope: ${describeIssues(parsed.error)}`);
  }
  const file = parsed.data;
  const envelope: Envelope = {
    v: file.v,
    id: file.id as EventId,
    workId: file.work_id as WorkId,
    seq: file.seq,
    occurredAt: file.occurred_at,
    recordedAt: file.recorded_at,
  };
  if (!isKnownType(file.type)) {
    return { ...envelope, type: file.type, payload: file.payload };
  }
  const payload = payloadFileSchemas[file.type].safeParse(file.payload);
  if (!payload.success) {
    throw new OpenshainError(
      "corrupt_log",
      `${file.type} payload: ${describeIssues(payload.error)}`,
    );
  }
  return {
    ...envelope,
    type: file.type,
    payload: payloadFromFile(file.type, payload.data),
  } as Event;
}

function isKnownType(type: string): type is EventType {
  return Object.hasOwn(payloadFileSchemas, type);
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map(
      (issue) => (issue.path.length ? `${issue.path.map(String).join(".")}: ` : "") + issue.message,
    )
    .join("; ");
}

type FilePayload<T extends EventType> = z.infer<(typeof payloadFileSchemas)[T]>;

interface Codec<T extends EventType> {
  toFile(payload: EventPayloads[T]): FilePayload<T>;
  fromFile(payload: FilePayload<T>): EventPayloads[T];
}

function usageToFile(usage: ModelUsage): ModelUsageFile {
  const out: ModelUsageFile = {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
  };
  if (usage.cachedInputTokens !== undefined) out.cached_input_tokens = usage.cachedInputTokens;
  if (usage.cacheWriteTokens !== undefined) out.cache_write_tokens = usage.cacheWriteTokens;
  if (usage.reasoningTokens !== undefined) out.reasoning_tokens = usage.reasoningTokens;
  return out;
}

function usageFromFile(usage: ModelUsageFile): ModelUsage {
  const out: ModelUsage = { inputTokens: usage.input_tokens, outputTokens: usage.output_tokens };
  if (usage.cached_input_tokens !== undefined) out.cachedInputTokens = usage.cached_input_tokens;
  if (usage.cache_write_tokens !== undefined) out.cacheWriteTokens = usage.cache_write_tokens;
  if (usage.reasoning_tokens !== undefined) out.reasoningTokens = usage.reasoning_tokens;
  return out;
}

/**
 * Event types whose field names differ between code and file. Every other
 * payload uses the same names on both sides and needs no codec.
 */
const codecs: { [T in EventType]?: Codec<T> } = {
  "model.requested": {
    toFile: (p) => ({
      provider: p.provider,
      model: p.model,
      message_count: p.messageCount,
      tool_names: p.toolNames,
    }),
    fromFile: (p) => ({
      provider: p.provider,
      model: p.model,
      messageCount: p.message_count,
      toolNames: p.tool_names,
    }),
  },
  "model.completed": {
    toFile: (p) => {
      const out: FilePayload<"model.completed"> = { stop_reason: p.stopReason, content: p.content };
      if (p.raw !== undefined) out.raw = p.raw;
      return out;
    },
    fromFile: (p) => {
      const out: EventPayloads["model.completed"] = {
        stopReason: p.stop_reason,
        content: p.content as AssistantPart[],
      };
      if (p.raw !== undefined) out.raw = p.raw;
      return out;
    },
  },
  "tool.called": {
    toFile: (p) => ({ call_id: p.callId, provider: p.provider, name: p.name, input: p.input }),
    fromFile: (p) => ({ callId: p.call_id, provider: p.provider, name: p.name, input: p.input }),
  },
  "tool.completed": {
    toFile: (p) => {
      const out: FilePayload<"tool.completed"> = {
        call_id: p.callId,
        content: p.content,
        is_error: p.isError,
      };
      if (p.observation) {
        out.observation = { source: p.observation.source, retrieved_at: p.observation.retrievedAt };
      }
      if (p.after) out.after = p.after;
      return out;
    },
    fromFile: (p) => {
      const out: EventPayloads["tool.completed"] = {
        callId: p.call_id,
        content: p.content as ToolContent[],
        isError: p.is_error,
      };
      if (p.observation) {
        out.observation = { source: p.observation.source, retrievedAt: p.observation.retrieved_at };
      }
      if (p.after) out.after = p.after.map((a) => ({ path: a.path, sha256: a.sha256 }));
      return out;
    },
  },
  "tool.rejected": {
    toFile: (p) => ({ call_id: p.callId, name: p.name, code: p.code, reason: p.reason }),
    fromFile: (p) => ({ callId: p.call_id, name: p.name, code: p.code, reason: p.reason }),
  },
  "human.input_requested": {
    toFile: (p) => ({ call_id: p.callId, question: p.question }),
    fromFile: (p) => ({ callId: p.call_id, question: p.question }),
  },
  "human.input_provided": {
    toFile: (p) => ({ call_id: p.callId, answer: p.answer }),
    fromFile: (p) => ({ callId: p.call_id, answer: p.answer }),
  },
  "usage.recorded": {
    toFile: (p) =>
      p.kind === "tool_execution"
        ? { kind: p.kind, provider: p.provider, usage: { duration_ms: p.usage.durationMs } }
        : { kind: p.kind, provider: p.provider, model: p.model, usage: usageToFile(p.usage) },
    fromFile: (p) =>
      p.kind === "tool_execution"
        ? { kind: p.kind, provider: p.provider, usage: { durationMs: p.usage.duration_ms } }
        : { kind: p.kind, provider: p.provider, model: p.model, usage: usageFromFile(p.usage) },
  },
};

function payloadToFile<T extends EventType>(type: T, payload: EventPayloads[T]): FilePayload<T> {
  const codec = codecs[type] as Codec<T> | undefined;
  return codec ? codec.toFile(payload) : (payload as unknown as FilePayload<T>);
}

function payloadFromFile<T extends EventType>(type: T, payload: FilePayload<T>): EventPayloads[T] {
  const codec = codecs[type] as Codec<T> | undefined;
  return codec ? codec.fromFile(payload) : (payload as unknown as EventPayloads[T]);
}
