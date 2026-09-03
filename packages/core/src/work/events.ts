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

export interface Artifact {
  path: string;
  sha256: string;
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
}

export interface EventPayloads {
  "work.created": { objective: string; principal: string; profession: string; type: string };
  "work.status_changed": { from: string; to: string; reason: string };
  "model.requested": { provider: string; model: string; messageCount: number; toolNames: string[] };
  "model.completed": { stopReason: StopReason; content: AssistantPart[] };
  "model.failed": { code: string; message: string };
  "tool.called": { callId: string; provider: string; name: string; input: unknown };
  "tool.completed": {
    callId: string;
    content: ToolContent[];
    isError: boolean;
    observation?: { source: string; retrievedAt: string };
    after?: Artifact[];
  };
  "tool.rejected": { callId: string; name: string; reason: string };
  "human.input_requested": { question: string };
  "human.input_provided": { answer: string };
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

const textPart = z.strictObject({ type: z.literal("text"), text: z.string() });
const toolCallPart = z.strictObject({
  type: z.literal("tool_call"),
  id: z.string(),
  name: z.string(),
  input: z.unknown(),
});
const opaquePart = z.strictObject({
  type: z.literal("opaque"),
  provider: z.string(),
  data: z.unknown(),
});
const jsonPart = z.strictObject({ type: z.literal("json"), value: z.unknown() });
const artifact = z.strictObject({ path: z.string(), sha256: z.string() });

export const payloadFileSchemas = {
  "work.created": z.strictObject({
    objective: z.string(),
    principal: z.string(),
    profession: z.string(),
    type: z.string(),
  }),
  "work.status_changed": z.strictObject({ from: z.string(), to: z.string(), reason: z.string() }),
  "model.requested": z.strictObject({
    provider: z.string(),
    model: z.string(),
    message_count: z.int().nonnegative(),
    tool_names: z.array(z.string()),
  }),
  "model.completed": z.strictObject({
    stop_reason: z.enum(["end_turn", "tool_call", "max_tokens", "refusal", "other"]),
    content: z.array(z.discriminatedUnion("type", [textPart, toolCallPart, opaquePart])),
  }),
  "model.failed": z.strictObject({ code: z.string(), message: z.string() }),
  "tool.called": z.strictObject({
    call_id: z.string(),
    provider: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  "tool.completed": z.strictObject({
    call_id: z.string(),
    content: z.array(z.discriminatedUnion("type", [textPart, jsonPart])),
    is_error: z.boolean(),
    observation: z.strictObject({ source: z.string(), retrieved_at: z.iso.datetime() }).optional(),
    after: z.array(artifact).optional(),
  }),
  "tool.rejected": z.strictObject({ call_id: z.string(), name: z.string(), reason: z.string() }),
  "human.input_requested": z.strictObject({ question: z.string() }),
  "human.input_provided": z.strictObject({ answer: z.string() }),
  "usage.recorded": z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("model_inference"),
      provider: z.string(),
      model: z.string(),
      usage: z.strictObject({
        input_tokens: z.int().nonnegative(),
        output_tokens: z.int().nonnegative(),
        cached_input_tokens: z.int().nonnegative().optional(),
        reasoning_tokens: z.int().nonnegative().optional(),
      }),
    }),
    z.strictObject({
      kind: z.literal("tool_execution"),
      provider: z.string(),
      usage: z.strictObject({ duration_ms: z.int().nonnegative() }),
    }),
  ]),
  "evidence.recorded": z.strictObject({
    claim: z.string(),
    refs: z.array(z.string()),
    artifacts: z.array(artifact),
  }),
  "work.completed": z.strictObject({ summary: z.string() }),
  "work.failed": z.strictObject({ reason: z.string(), detail: z.string() }),
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
  return {
    v: event.v,
    id: event.id,
    work_id: event.workId,
    seq: event.seq,
    type: event.type,
    occurred_at: event.occurredAt,
    recorded_at: event.recordedAt,
    payload: isKnownType(event.type)
      ? payloadToFile(event.type, event.payload as EventPayloads[EventType])
      : event.payload,
  };
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

function payloadToFile<T extends EventType>(type: T, payload: EventPayloads[T]): FilePayload<T> {
  const out = ((): FilePayload<EventType> => {
    switch (type) {
      case "model.requested": {
        const p = payload as EventPayloads["model.requested"];
        return {
          provider: p.provider,
          model: p.model,
          message_count: p.messageCount,
          tool_names: p.toolNames,
        };
      }
      case "model.completed": {
        const p = payload as EventPayloads["model.completed"];
        return { stop_reason: p.stopReason, content: p.content };
      }
      case "tool.called": {
        const p = payload as EventPayloads["tool.called"];
        return { call_id: p.callId, provider: p.provider, name: p.name, input: p.input };
      }
      case "tool.completed": {
        const p = payload as EventPayloads["tool.completed"];
        return {
          call_id: p.callId,
          content: p.content,
          is_error: p.isError,
          ...(p.observation && {
            observation: { source: p.observation.source, retrieved_at: p.observation.retrievedAt },
          }),
          ...(p.after && { after: p.after }),
        };
      }
      case "tool.rejected": {
        const p = payload as EventPayloads["tool.rejected"];
        return { call_id: p.callId, name: p.name, reason: p.reason };
      }
      case "usage.recorded": {
        const p = payload as EventPayloads["usage.recorded"];
        if (p.kind === "tool_execution") {
          return { kind: p.kind, provider: p.provider, usage: { duration_ms: p.usage.durationMs } };
        }
        return {
          kind: p.kind,
          provider: p.provider,
          model: p.model,
          usage: {
            input_tokens: p.usage.inputTokens,
            output_tokens: p.usage.outputTokens,
            ...(p.usage.cachedInputTokens !== undefined && {
              cached_input_tokens: p.usage.cachedInputTokens,
            }),
            ...(p.usage.reasoningTokens !== undefined && {
              reasoning_tokens: p.usage.reasoningTokens,
            }),
          },
        };
      }
      default:
        // Every other payload uses the same field names on disk and in code.
        return payload as FilePayload<EventType>;
    }
  })();
  return out as FilePayload<T>;
}

function payloadFromFile<T extends EventType>(type: T, payload: FilePayload<T>): EventPayloads[T] {
  const out = ((): EventPayloads[EventType] => {
    switch (type) {
      case "model.requested": {
        const p = payload as FilePayload<"model.requested">;
        return {
          provider: p.provider,
          model: p.model,
          messageCount: p.message_count,
          toolNames: p.tool_names,
        };
      }
      case "model.completed": {
        const p = payload as FilePayload<"model.completed">;
        return { stopReason: p.stop_reason, content: p.content as AssistantPart[] };
      }
      case "tool.called": {
        const p = payload as FilePayload<"tool.called">;
        return { callId: p.call_id, provider: p.provider, name: p.name, input: p.input };
      }
      case "tool.completed": {
        const p = payload as FilePayload<"tool.completed">;
        return {
          callId: p.call_id,
          content: p.content as ToolContent[],
          isError: p.is_error,
          ...(p.observation && {
            observation: { source: p.observation.source, retrievedAt: p.observation.retrieved_at },
          }),
          ...(p.after && { after: p.after }),
        };
      }
      case "tool.rejected": {
        const p = payload as FilePayload<"tool.rejected">;
        return { callId: p.call_id, name: p.name, reason: p.reason };
      }
      case "usage.recorded": {
        const p = payload as FilePayload<"usage.recorded">;
        if (p.kind === "tool_execution") {
          return { kind: p.kind, provider: p.provider, usage: { durationMs: p.usage.duration_ms } };
        }
        return {
          kind: p.kind,
          provider: p.provider,
          model: p.model,
          usage: {
            inputTokens: p.usage.input_tokens,
            outputTokens: p.usage.output_tokens,
            ...(p.usage.cached_input_tokens !== undefined && {
              cachedInputTokens: p.usage.cached_input_tokens,
            }),
            ...(p.usage.reasoning_tokens !== undefined && {
              reasoningTokens: p.usage.reasoning_tokens,
            }),
          },
        };
      }
      default:
        return payload as EventPayloads[EventType];
    }
  })();
  return out as EventPayloads[T];
}
