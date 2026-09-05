import {
  type AnyEvent,
  type AssistantPart,
  buildProjection,
  compileInputValidator,
  type Event,
  type InputValidation,
  isOpenshainError,
  isTerminal,
  type ModelProvider,
  type ModelResponse,
  parseWorkId,
  type Runtime,
  SESSION_WORK_TYPE,
  type ToolContent,
  type ToolDefinition,
  type Work,
  type WorkHandle,
  type WorkId,
} from "@openshain/core";
import { countToolCalls, pendingQuestions, RUNTIME_PROVIDER_ID, runWork } from "./loop.ts";

/** How much one turn of a session may do before the person hears back. */
export const TURN_LIMITS = { modelCalls: 5, toolCalls: 10 } as const;

/** What the session's model may do: hand work out and look work up. It never touches files itself. */
export const SESSION_TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    name: "work_run",
    description:
      "Start a work for the person's request and drive it until it completes, fails or stops to ask the person a question. Write the objective in the person's own words and add what the conversation established that the work needs to know. Returns the work's id, status, summary, artifacts and usage, or the question it is waiting on.",
    inputSchema: {
      type: "object",
      properties: {
        objective: {
          type: "string",
          minLength: 1,
          description: "The request, in the person's words.",
        },
        type: {
          type: "string",
          description: "A short label for the kind of work. Defaults to request.",
        },
      },
      required: ["objective"],
      additionalProperties: false,
    },
    effect: "mutate",
  },
  {
    name: "work_list",
    description: "The most recent works in this workspace, newest first, without sessions.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    effect: "observe",
  },
  {
    name: "work_show",
    description: "One work by id: its status, summary, artifacts, usage, and who has to act next.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    },
    effect: "observe",
  },
]);

const validators = new Map(
  SESSION_TOOLS.map((tool) => [tool.name, compileInputValidator(tool.inputSchema)] as const),
);

const ROLE =
  "あなたは受付として、この人と話す。作業が要るときは work_run に objective を渡して Work にする。objective は人の言葉で書き、会話で分かった前提を添える。会社のファイルは自分では触らない。作業の結果は要約して伝える。過去の作業は work_list と work_show で答える。";

export interface SessionOptions {
  /** Defaults to the runtime's model, for the session and for the works it starts. */
  model?: ModelProvider;
  /** Called after every event the session records. */
  onEvent?: (event: AnyEvent) => void;
  /** Called after every event a work started from this session records. */
  onWorkEvent?: (workId: WorkId, event: AnyEvent) => void;
  /** Answers a question a work asks the person. Without it, the work waits for input. */
  onInput?: (workId: WorkId, question: string) => Promise<string>;
}

export type TurnStop = "turn_limit" | "aborted" | "max_tokens" | "refusal" | "model_error";

export interface TurnResult {
  /** What the model said to the person, possibly empty when the turn stopped early. */
  reply: string;
  /** Why the turn ended before the model replied, if it did. */
  stopped?: TurnStop;
  detail?: string;
}

export interface Session {
  readonly id: WorkId;
  /** Records what the person said and runs the model until it replies or the turn stops. */
  turn(text: string, options?: { signal?: AbortSignal }): Promise<TurnResult>;
  /** Ends the conversation. The record stays. */
  close(): Promise<Work>;
}

/** Opens a conversation, recorded as a work of type "session", between the person and the model. */
export async function createSession(
  runtime: Runtime,
  options: SessionOptions = {},
): Promise<Session> {
  const model = options.model ?? runtime.model;
  const { principal, profession } = runtime.config;
  const created = await runtime.works.create({
    objective: "会話",
    principal: principal.id,
    profession: profession.id,
    type: SESSION_WORK_TYPE,
  });
  await withHandle(runtime, created.id, options, (handle) =>
    handle.transition("in_progress", "session opened"),
  );

  return {
    id: created.id,
    turn: (text, turnOptions = {}) =>
      withHandle(runtime, created.id, options, async (handle) => {
        await handle.append({ type: "human.message", payload: { text } });
        return runTurn(runtime, handle, model, options, turnOptions.signal);
      }),
    close: () =>
      withHandle(runtime, created.id, options, async (handle) => {
        if (isTerminal((await handle.current()).status)) return handle.current();
        await handle.append({
          type: "evidence.recorded",
          payload: { claim: "会話を終了", refs: [], artifacts: [] },
        });
        await handle.append({ type: "work.completed", payload: { summary: "会話を終了" } });
        return handle.current();
      }),
  };
}

async function withHandle<T>(
  runtime: Runtime,
  id: WorkId,
  options: SessionOptions,
  fn: (handle: WorkHandle) => Promise<T>,
): Promise<T> {
  const opened = await runtime.works.open(id);
  const handle = options.onEvent ? observed(opened, options.onEvent) : opened;
  try {
    return await fn(handle);
  } finally {
    await handle.close();
  }
}

async function runTurn(
  runtime: Runtime,
  handle: WorkHandle,
  model: ModelProvider,
  options: SessionOptions,
  signal: AbortSignal | undefined,
): Promise<TurnResult> {
  const description = model.describe();
  const config = {
    ...runtime.config,
    profession: {
      ...runtime.config.profession,
      instructions: `${runtime.config.profession.instructions.trim()}\n\n${ROLE}`,
    },
  };
  const turnStart = (await handle.events()).length;
  const tools = [...SESSION_TOOLS];
  let modelCalls = 0;
  let toolCalls = 0;

  for (;;) {
    if (signal?.aborted) return { reply: "", stopped: "aborted" };
    if (modelCalls >= TURN_LIMITS.modelCalls) {
      return {
        reply: "",
        stopped: "turn_limit",
        detail: `model calls in one turn (${TURN_LIMITS.modelCalls})`,
      };
    }
    const events = await handle.events();
    const projection = buildProjection({
      events,
      config,
      tools,
      providerId: model.id,
      budget: {
        modelCallsLeft: TURN_LIMITS.modelCalls - modelCalls,
        toolCallsLeft: TURN_LIMITS.toolCalls - toolCalls,
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
    modelCalls += 1;

    let response: ModelResponse;
    try {
      response = await model.generate(
        {
          system: projection.system,
          messages: projection.messages,
          tools: projection.tools,
          maxOutputTokens: runtime.config.limits.maxOutputTokens,
          budget: projection.budget,
          stableMessages: projection.messages.length - 1,
          ...(runtime.config.model.options && { providerOptions: runtime.config.model.options }),
        },
        signal,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await handle.append({
        type: "model.failed",
        payload: { code: isOpenshainError(err) ? err.code : "model_error", message },
      });
      return { reply: "", stopped: signal?.aborted ? "aborted" : "model_error", detail: message };
    }
    await handle.append({
      type: "model.completed",
      payload: {
        stopReason: response.stopReason,
        content: response.message.content,
        ...(runtime.config.debug.persistRaw && response.raw !== undefined && { raw: response.raw }),
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

    const text = textOf(response.message.content);
    switch (response.stopReason) {
      case "end_turn":
        return { reply: text };
      case "tool_call": {
        const calls = response.message.content.filter((p) => p.type === "tool_call");
        for (const call of calls) {
          if (signal?.aborted) return { reply: text, stopped: "aborted" };
          if (toolCalls >= TURN_LIMITS.toolCalls) {
            return {
              reply: text,
              stopped: "turn_limit",
              detail: `tool calls in one turn (${TURN_LIMITS.toolCalls})`,
            };
          }
          toolCalls += 1;
          await callSessionTool(runtime, handle, model, options, signal, call);
        }
        break;
      }
      case "max_tokens":
        return { reply: text, stopped: "max_tokens" };
      case "refusal":
        return { reply: text, stopped: "refusal" };
      default:
        return {
          reply: text,
          stopped: "model_error",
          detail: `unexpected stop reason "${response.stopReason}"`,
        };
    }
    // Nothing of the turn's own events is needed below; the projection rebuilds from the log.
    void turnStart;
  }
}

async function callSessionTool(
  runtime: Runtime,
  handle: WorkHandle,
  model: ModelProvider,
  options: SessionOptions,
  signal: AbortSignal | undefined,
  call: { id: string; name: string; input: unknown },
): Promise<void> {
  const validate = validators.get(call.name);
  if (!validate) {
    await handle.append({
      type: "tool.rejected",
      payload: {
        callId: call.id,
        name: call.name,
        code: "unknown_tool",
        reason: `no tool named "${call.name}"; the session offers ${SESSION_TOOLS.map((t) => t.name).join(", ")}`,
      },
    });
    return;
  }
  const validation: InputValidation = validate(call.input);
  if (!validation.ok) {
    await handle.append({
      type: "tool.rejected",
      payload: {
        callId: call.id,
        name: call.name,
        code: "schema_mismatch",
        reason: `input does not match the schema of ${call.name}: ${validation.reason}`,
      },
    });
    return;
  }
  await handle.append({
    type: "tool.called",
    payload: { callId: call.id, provider: RUNTIME_PROVIDER_ID, name: call.name, input: call.input },
  });
  let result: { content: ToolContent[]; isError?: boolean };
  try {
    result = await runSessionTool(
      runtime,
      handle,
      model,
      options,
      signal,
      call.name,
      call.input as Record<string, unknown>,
    );
  } catch (err) {
    result = {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      isError: true,
    };
  }
  await handle.append({
    type: "tool.completed",
    payload: { callId: call.id, content: result.content, isError: result.isError ?? false },
  });
}

async function runSessionTool(
  runtime: Runtime,
  handle: WorkHandle,
  model: ModelProvider,
  options: SessionOptions,
  signal: AbortSignal | undefined,
  name: string,
  input: Record<string, unknown>,
): Promise<{ content: ToolContent[]; isError?: boolean }> {
  switch (name) {
    case "work_run": {
      const type = typeof input.type === "string" && input.type !== "" ? input.type : "request";
      if (type === SESSION_WORK_TYPE) {
        return {
          content: [
            {
              type: "text",
              text: `type "${SESSION_WORK_TYPE}" is reserved for conversations; use another label, such as request`,
            },
          ],
          isError: true,
        };
      }
      const child = await runtime.works.create({
        objective: String(input.objective),
        principal: runtime.config.principal.id,
        profession: runtime.config.profession.id,
        type,
        parent: handle.id,
      });
      const done = await runWork(runtime, child.id, {
        model,
        ...(options.onInput && {
          onInput: (q: string) => options.onInput?.(child.id, q) as Promise<string>,
        }),
        ...(options.onWorkEvent && {
          onEvent: (e: AnyEvent) => options.onWorkEvent?.(child.id, e),
        }),
        ...(signal && { signal }),
      });
      return {
        content: [
          { type: "json", value: await describeWork(runtime, done, signal?.aborted === true) },
        ],
      };
    }
    case "work_list": {
      const { works } = await runtime.works.list();
      const recent = works
        .filter((w) => w.type !== SESSION_WORK_TYPE)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, 20)
        .map((w) => ({
          id: w.id,
          status: w.status,
          type: w.type,
          objective: w.objective,
          createdAt: w.createdAt,
        }));
      return { content: [{ type: "json", value: { works: recent } }] };
    }
    case "work_show": {
      let id: WorkId;
      try {
        id = parseWorkId(String(input.id));
      } catch {
        return {
          content: [{ type: "text", text: `"${String(input.id)}" is not a work id` }],
          isError: true,
        };
      }
      const work = await runtime.works.get(id);
      return { content: [{ type: "json", value: await describeWork(runtime, work, false) }] };
    }
    default:
      return { content: [{ type: "text", text: `no tool named "${name}"` }], isError: true };
  }
}

/** A work as the session's model needs to see it: outcome, cost, and who acts next. */
async function describeWork(runtime: Runtime, work: Work, interrupted: boolean) {
  const events = await runtime.works.events(work.id);
  const usage = {
    modelCalls: 0,
    toolCalls: countToolCalls(events),
    inputTokens: 0,
    outputTokens: 0,
  };
  for (const event of events) {
    if (event.type === "model.requested") usage.modelCalls += 1;
    if (event.type === "usage.recorded") {
      const { payload } = event as Event<"usage.recorded">;
      if (payload.kind === "model_inference") {
        usage.inputTokens += payload.usage.inputTokens;
        usage.outputTokens += payload.usage.outputTokens;
      }
    }
  }
  const question =
    work.status === "waiting_input" ? pendingQuestions(events).map((q) => q.question) : [];
  return {
    id: work.id,
    status: work.status,
    ...(work.outcome && { summary: work.outcome.summary, artifacts: work.outcome.artifacts }),
    ...(work.failure && { failure: work.failure }),
    ...(question.length > 0 && { waitingFor: question }),
    ...(interrupted &&
      work.status === "in_progress" && {
        interrupted: "the person stopped this work; it can be resumed",
      }),
    nextActor: isTerminal(work.status)
      ? "nobody"
      : work.status === "waiting_input"
        ? "person"
        : "model",
    usage,
  };
}

function textOf(content: AssistantPart[]): string {
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

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
