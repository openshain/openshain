import {
  type AnyEvent,
  type Artifact,
  ASK_USER_TOOL_NAME,
  type AssistantPart,
  buildProjection,
  compileInputValidator,
  type Event,
  isOpenshainError,
  isTerminal,
  type ModelProvider,
  type ModelResponse,
  OpenshainError,
  type Runtime,
  SESSION_WORK_TYPE,
  type ToolDefinition,
  verifyArtifact,
  type Work,
  type WorkHandle,
  type WorkId,
} from "@openshain/core";

export interface RunWorkOptions {
  /** Defaults to the runtime's model. */
  model?: ModelProvider;
  /**
   * Answers the model's questions to the person. Without it, a question leaves
   * the work waiting for input. If it throws, the question stays recorded and
   * unanswered, so a later run can resume from it.
   */
  onInput?: (question: string) => Promise<string>;
  /** Called after every event is recorded, for progress reporting. */
  onEvent?: (event: AnyEvent) => void;
  signal?: AbortSignal;
}

/** The provider recorded for calls the runtime handles itself. */
export const RUNTIME_PROVIDER_ID = "runtime";

/** The one tool the runtime itself provides: stop and ask the person. */
export const ASK_USER: Readonly<ToolDefinition> = Object.freeze({
  name: ASK_USER_TOOL_NAME,
  description:
    "Ask the person you work for a question when you cannot proceed without their answer. Use it sparingly; prefer the workspace over guessing.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, in the person's language." },
    },
    required: ["question"],
    additionalProperties: false,
  },
  effect: "observe",
});

const validateQuestion = compileInputValidator(ASK_USER.inputSchema);

/**
 * Drives one work from its current state to completion, failure or a wait:
 * build the projection, ask the model, run the tool calls it made, repeat.
 * Every step is recorded in the work's event log before the next one starts.
 */
export async function runWork(
  runtime: Runtime,
  workId: WorkId,
  options: RunWorkOptions = {},
): Promise<Work> {
  const model = options.model ?? runtime.model;
  const opened = await runtime.works.open(workId);
  const handle = options.onEvent ? observed(opened, options.onEvent) : opened;
  try {
    const work = await handle.current();
    if (work.type === SESSION_WORK_TYPE) {
      throw new OpenshainError(
        "invalid_transition",
        `work ${workId} is a conversation; it goes on in the screen that opened it, not through a run`,
      );
    }
    if (isTerminal(work.status)) {
      throw new OpenshainError("invalid_transition", `work ${workId} is already ${work.status}`);
    }
    if (work.status === "queued") await handle.transition("in_progress", "run");
    // A work still in progress was interrupted: close what the last turn left open.
    if (work.status === "in_progress") await closeInterruptedCalls(runtime, handle);
    const events = await handle.events();
    const pending = pendingQuestions(events);
    const asked = lastTurnCallIds(events);
    const ghosts = pending.filter((q) => !asked.has(q.callId));
    if (ghosts.length > 0) {
      throw new OpenshainError(
        "corrupt_log",
        `questions that the model's last turn did not ask: ${ghosts.map((q) => q.callId).join(", ")}`,
      );
    }
    if (work.status === "waiting_input" && pending.length === 0) {
      throw new OpenshainError(
        "corrupt_log",
        `work ${workId} waits for input but no question is pending`,
      );
    }
    if (pending.length > 0) {
      if (work.status !== "waiting_input") {
        await handle.transition("waiting_input", "the model asked the person a question");
      }
      if (!options.onInput) return handle.current();
      await answerAll(handle, pending, options.onInput);
    }
    return await loop(runtime, handle, model, options);
  } finally {
    await handle.close();
  }
}

async function loop(
  runtime: Runtime,
  handle: WorkHandle,
  model: ModelProvider,
  options: RunWorkOptions,
): Promise<Work> {
  const { limits } = runtime.config;
  const tools = [...runtime.tools.list().map((t) => t.definition), ASK_USER];
  const description = model.describe();

  for (;;) {
    // Stopped by the person: leave the work in progress, so a later run can resume it.
    if (options.signal?.aborted) return handle.current();
    const events = await handle.events();
    const modelCalls = events.filter((e) => e.type === "model.requested").length;
    const toolCalls = countToolCalls(events);
    if (modelCalls >= limits.maxModelCalls) {
      return fail(handle, "limit_reached", `model calls exhausted (${limits.maxModelCalls})`);
    }

    const projection = buildProjection({
      events,
      config: runtime.config,
      tools,
      providerId: model.id,
      budget: {
        modelCallsLeft: limits.maxModelCalls - modelCalls,
        toolCallsLeft: limits.maxToolCalls - toolCalls,
      },
    });
    await handle.append({
      type: "model.requested",
      payload: {
        provider: model.id,
        model: description.model,
        messageCount: projection.messages.length,
        toolNames: tools.map((t) => t.name),
      },
    });

    let response: ModelResponse;
    try {
      response = await model.generate(
        {
          system: projection.system,
          messages: projection.messages,
          tools: projection.tools,
          maxOutputTokens: limits.maxOutputTokens,
          budget: projection.budget,
          stableMessages: projection.messages.length - 1,
          ...(runtime.config.model.options && { providerOptions: runtime.config.model.options }),
        },
        options.signal,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await handle.append({
        type: "model.failed",
        payload: { code: isOpenshainError(err) ? err.code : "model_error", message },
      });
      if (options.signal?.aborted) return handle.current();
      return fail(handle, "model_error", message);
    }

    // The answer is third-party data. If it cannot be recorded, the work fails; the run does not.
    try {
      await handle.append({
        type: "model.completed",
        payload: {
          stopReason: response.stopReason,
          content: response.message.content,
          ...(runtime.config.debug.persistRaw &&
            response.raw !== undefined && { raw: response.raw }),
        },
      });
      await handle.append({
        type: "usage.recorded",
        payload: {
          kind: "model_inference",
          provider: model.id,
          model: description.model,
          usage: response.usage,
        },
      });
    } catch (err) {
      if (!isOpenshainError(err) || err.code !== "invalid_event") throw err;
      const message = `the model's answer cannot be recorded: ${err.message}`;
      await handle.append({ type: "model.failed", payload: { code: "invalid_response", message } });
      return fail(handle, "model_error", message);
    }

    switch (response.stopReason) {
      case "end_turn":
        return complete(runtime, handle, response.message.content);
      case "tool_call": {
        const calls = response.message.content.filter((p) => p.type === "tool_call");
        if (calls.length === 0) {
          return fail(handle, "model_error", "the model stopped for a tool call but made none");
        }
        const seen = new Set<string>();
        for (const call of calls) {
          if (seen.has(call.id)) {
            return fail(
              handle,
              "model_error",
              `the model used the tool call id "${call.id}" twice in one turn`,
            );
          }
          seen.add(call.id);
        }
        // Questions go last: the other calls of the turn run before the work waits,
        // and the model gets their results together with the answers.
        const ordered = [
          ...calls.filter((c) => c.name !== ASK_USER.name),
          ...calls.filter((c) => c.name === ASK_USER.name),
        ];
        let used = toolCalls;
        for (const call of ordered) {
          if (options.signal?.aborted) return handle.current();
          if (used >= limits.maxToolCalls) {
            return fail(handle, "limit_reached", `tool calls exhausted (${limits.maxToolCalls})`);
          }
          used += 1;
          if (call.name === ASK_USER.name) {
            await askQuestion(handle, call.id, call.input);
          } else {
            await runtime.tools.call(handle, { id: call.id, name: call.name, input: call.input });
          }
        }
        const pending = pendingQuestions(await handle.events());
        if (pending.length > 0) {
          await handle.transition(
            "waiting_input",
            pending.length === 1
              ? "the model asked the person a question"
              : `the model asked the person ${pending.length} questions`,
          );
          if (!options.onInput) return handle.current();
          await answerAll(handle, pending, options.onInput);
        }
        break;
      }
      case "max_tokens":
        return fail(
          handle,
          "limit_reached",
          `the answer was cut off at max_output_tokens (${limits.maxOutputTokens})`,
        );
      case "refusal":
        return fail(
          handle,
          "model_refusal",
          textOf(response.message.content) || "the model refused to continue",
        );
      default:
        return fail(handle, "model_error", `unexpected stop reason "${response.stopReason}"`);
    }
  }
}

/**
 * How many tool calls the model made: every call that started, plus every rejection of a call
 * that never started. Counted by event, since some servers reuse call ids from turn to turn.
 */
export function countToolCalls(events: AnyEvent[]): number {
  let count = 0;
  let started = new Set<string>();
  for (const event of events) {
    if (event.type === "model.completed") started = new Set();
    else if (event.type === "tool.called") {
      started.add((event as Event<"tool.called">).payload.callId);
      count += 1;
    } else if (event.type === "tool.rejected") {
      if (!started.has((event as Event<"tool.rejected">).payload.callId)) count += 1;
    }
  }
  return count;
}

/** The events since the model's most recent answer. Call ids are only trusted within a turn. */
function currentTurn(events: AnyEvent[]): AnyEvent[] {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === "model.completed") return events.slice(i + 1);
  }
  return events;
}

/** The model's most recent answer, if any. */
function lastModelTurn(events: AnyEvent[]): Event<"model.completed"> | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.type === "model.completed") return event as Event<"model.completed">;
  }
  return undefined;
}

/** The ids of the tool calls in the model's most recent answer. */
function lastTurnCallIds(events: AnyEvent[]): Set<string> {
  const ids = new Set<string>();
  for (const part of lastModelTurn(events)?.payload.content ?? []) {
    if (part.type === "tool_call") ids.add(part.id);
  }
  return ids;
}

/** The text parts of an answer, joined. */
function textOf(content: AssistantPart[]): string {
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

/** Why a work failed, as recorded in `work.failed`. */
export type FailureReason = "limit_reached" | "model_refusal" | "model_error";

async function fail(handle: WorkHandle, reason: FailureReason, detail: string): Promise<Work> {
  await handle.append({ type: "work.failed", payload: { reason, detail } });
  return handle.current();
}

async function complete(
  runtime: Runtime,
  handle: WorkHandle,
  content: AssistantPart[],
): Promise<Work> {
  const summary = textOf(content);
  const events = await handle.events();
  const writes = events.filter(
    (e): e is Event<"tool.completed"> =>
      e.type === "tool.completed" && !(e as Event<"tool.completed">).payload.isError,
  );
  const refs: string[] = [];
  const byPath = new Map<string, string>();
  for (const event of writes) {
    if (!event.payload.after) continue;
    refs.push(event.id);
    for (const { path, sha256 } of event.payload.after) byPath.set(path, sha256);
  }
  const artifacts: Artifact[] = [];
  for (const [path, recorded] of byPath) {
    artifacts.push(await verifyArtifact(runtime.workspaceRoot, path, recorded));
  }
  await handle.append({ type: "evidence.recorded", payload: { claim: summary, refs, artifacts } });
  await handle.append({ type: "work.completed", payload: { summary } });
  return handle.current();
}

/** A handle that reports every event it records. */
function observed(handle: WorkHandle, onEvent: (event: AnyEvent) => void): WorkHandle {
  return {
    ...handle,
    async append(event) {
      const recorded = await handle.append(event);
      onEvent(recorded);
      return recorded;
    },
    async transition(to, reason) {
      const recorded = await handle.transition(to, reason);
      onEvent(recorded);
      return recorded;
    },
  };
}

const INTERRUPTED =
  "the run stopped before this tool call finished; call it again if it is still needed";

/**
 * Gives every tool call of the last turn that has no result an error result, so the
 * conversation can continue after a run was interrupted mid-call. A recorded question
 * that awaits its answer is left alone.
 */
async function closeInterruptedCalls(runtime: Runtime, handle: WorkHandle): Promise<void> {
  const events = await handle.events();
  const last = lastModelTurn(events);
  if (!last) return;
  const answered = new Set<string>();
  const called = new Set<string>();
  for (const event of currentTurn(events)) {
    if (event.type === "tool.completed" || event.type === "tool.rejected") {
      answered.add((event as Event<"tool.completed" | "tool.rejected">).payload.callId);
    }
    if (event.type === "tool.called") called.add((event as Event<"tool.called">).payload.callId);
  }
  const asked = new Set(pendingQuestions(events).map((q) => q.callId));
  for (const part of last.payload.content) {
    if (part.type !== "tool_call" || answered.has(part.id) || asked.has(part.id)) continue;
    if (!called.has(part.id)) {
      const provider =
        runtime.tools.list().find((t) => t.definition.name === part.name)?.providerId ??
        RUNTIME_PROVIDER_ID;
      await handle.append({
        type: "tool.called",
        payload: { callId: part.id, provider, name: part.name, input: part.input },
      });
    }
    await handle.append({
      type: "tool.completed",
      payload: { callId: part.id, content: [{ type: "text", text: INTERRUPTED }], isError: true },
    });
  }
}

/** Records the model's question as a call that waits for the person, or rejects a malformed one. */
async function askQuestion(handle: WorkHandle, callId: string, input: unknown): Promise<void> {
  const validation = validateQuestion(input);
  if (!validation.ok) {
    await handle.append({
      type: "tool.rejected",
      payload: {
        callId,
        name: ASK_USER.name,
        code: "schema_mismatch",
        reason: `input does not match the schema of ${ASK_USER.name}: ${validation.reason}`,
      },
    });
    return;
  }
  const { question } = input as { question: string };
  await handle.append({
    type: "tool.called",
    payload: { callId, provider: RUNTIME_PROVIDER_ID, name: ASK_USER.name, input },
  });
  await handle.append({ type: "human.input_requested", payload: { callId, question } });
}

/** Records each answer as the person's input and as the tool result, then continues the work. */
async function answerAll(
  handle: WorkHandle,
  pending: PendingQuestion[],
  onInput: (question: string) => Promise<string>,
): Promise<void> {
  for (const { callId, question } of pending) {
    const text = await onInput(question);
    await handle.append({ type: "human.input_provided", payload: { callId, answer: text } });
    await handle.append({
      type: "tool.completed",
      payload: { callId, content: [{ type: "text", text }], isError: false },
    });
  }
  await handle.transition("in_progress", "the person answered");
}

export interface PendingQuestion {
  callId: string;
  question: string;
}

/** The questions of the model's most recent turn that have no answer yet, oldest first. */
export function pendingQuestions(events: AnyEvent[]): PendingQuestion[] {
  const turn = currentTurn(events);
  const answered = new Set(
    turn
      .filter((e): e is Event<"human.input_provided"> => e.type === "human.input_provided")
      .map((e) => e.payload.callId),
  );
  return turn
    .filter((e): e is Event<"human.input_requested"> => e.type === "human.input_requested")
    .filter((e) => !answered.has(e.payload.callId))
    .map((e) => ({ callId: e.payload.callId, question: e.payload.question }));
}
