import {
  type AnyEvent,
  ASK_USER_TOOL_NAME,
  type AssistantPart,
  buildProjection,
  type Config,
  type Event,
  type EventPayloads,
  type EventType,
  eventToFile,
  isTerminal,
  type ModelProvider,
  type ModelResponse,
  newEventId,
  SESSION_WORK_TYPE,
  type ToolDefinition,
  type Work,
  type WorkId,
} from "@openshain/core";
import { type ClientResult, jsonOf, type RuntimeClient } from "./client.ts";
import { pickAgentName } from "./names.ts";

/** How much one turn of the conversation may do before it stops and the person is told. */
export const TURN_LIMITS = { modelCalls: 5, toolCalls: 10 } as const;

/** The tools of the runtime that the loop itself drives; the model never sees them. */
const LOOP_ONLY_TOOLS: ReadonlySet<string> = new Set(["work_record", "work_answer"]);

const ROLE =
  "あなたはこの会社の社員エージェントとして、受付の役で、この人と話す。作業が要るときは work_create で Work を作り(objective は人の言葉で書き、会話で分かった前提を添える)、その Work の中で Tool を呼び、終わったら work_complete で summary を人の言葉で書いて閉じる。会話の中では Tool を呼べないので、ファイルの中身を見ないと答えられない質問も Work を作って調べる。件数や金額は Tool が返した値をそのまま書き、計算し直さない。/work resume で候補として示された Work は、人の依頼がその objective に沿うときだけ work_select で続ける。沿わなければ続けず、その旨を伝えて新しい Work を作るか work_list で探し直す。返答は端末の画面に出るので、Markdown の記法や絵文字は使わず、短い文で書く。過去の作業は work_list と work_get で答える。";

export interface SessionOptions {
  /** The model the conversation runs on. The client owns it; the runtime never calls one. */
  model: ModelProvider;
  /** The workspace's configuration, for the prompt, the limits and the provider options. */
  config: Pick<Config, "company" | "principal" | "profession" | "limits" | "model" | "debug">;
  /** The name the agent goes by. Picked from the list, avoiding open sessions' names, when omitted. */
  agentName?: string;
  /** Called for every event the session records or sees: the session's own and the works'. A returned promise is awaited. */
  onEvent?: (workId: WorkId, event: AnyEvent) => void | Promise<void>;
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
  /** The work the turn left open, when it stopped inside one. It can be continued with select. */
  work?: WorkId;
}

export interface Session {
  readonly id: WorkId;
  /** The name the agent goes by in this conversation and in the works it starts. */
  readonly agentName: string;
  /** Records what the person said and runs the model until it replies or the turn stops. */
  turn(text: string, options?: { signal?: AbortSignal }): Promise<TurnResult>;
  /** Names a stopped work as the candidate for the next request. The model decides whether to continue it. */
  select(workId: WorkId): Promise<Work>;
  /** The work the model is on right now, if any. */
  currentWork(): WorkId | undefined;
  /** Ends the conversation. The record stays; a work left in progress stays in progress. */
  close(): Promise<Work>;
}

interface TaskState {
  id: WorkId;
  modelCalls: number;
  /** Ids of the calls the model made inside this work, to fold their results away when it closes. */
  callIds: Set<string>;
}

/**
 * Opens a conversation, recorded as a work of type "session", between the person and the model.
 * The loop is a client of the runtime: it creates works, calls tools and closes works through
 * the same MCP tools any other agent uses, and records its own model calls with work_record.
 */
export async function createSession(
  client: RuntimeClient,
  options: SessionOptions,
): Promise<Session> {
  const { model, config } = options;
  const agentName =
    options.agentName ?? pickAgentName(config.company.language, await namesInUse(client));
  const opened = await client.call("work_create", {
    objective: "会話",
    type: SESSION_WORK_TYPE,
    agent_name: agentName,
  });
  if (opened.isError) throw new Error(`could not open a session: ${opened.text}`);
  const session = jsonOf(opened) as Work;
  const id = session.id;

  /** The session's events as the projection needs them, kept in memory; the runtime holds the record. */
  const events: AnyEvent[] = [];
  let seq = 0;
  const local = <T extends EventType>(type: T, payload: EventPayloads[T]): Event<T> => {
    const now = new Date().toISOString();
    seq += 1;
    return {
      v: 1,
      id: newEventId(),
      workId: id,
      seq,
      type,
      payload,
      occurredAt: now,
      recordedAt: now,
    } as Event<T>;
  };
  events.push(
    local("work.created", {
      objective: "会話",
      principal: config.principal.id,
      profession: config.profession.id,
      type: SESSION_WORK_TYPE,
      agentName,
    }),
  );
  let task: TaskState | undefined;
  let candidate: { id: WorkId; objective: string; status: string } | undefined;

  /** Records one of the client's own events on a work through the runtime, and reports it. */
  const record = async <T extends EventType>(
    workId: WorkId,
    type: T,
    payload: EventPayloads[T],
  ): Promise<void> => {
    const event = local(type, payload);
    const file = eventToFile({ ...event, workId });
    const result = await client.call("work_record", {
      work_id: workId,
      type,
      payload: file.payload,
    });
    if (result.isError) throw new Error(`work_record failed: ${result.text}`);
    await options.onEvent?.(workId, { ...event, workId });
  };
  /** Records a model event on the session and, while a work is open, on that work as well. */
  const recordModelEvent = async <T extends EventType>(type: T, payload: EventPayloads[T]) => {
    events.push(local(type, payload));
    await record(id, type, payload);
    if (task) await record(task.id, type, payload);
  };

  const describedTools = async (): Promise<ToolDefinition[]> =>
    (await client.listTools()).filter((t) => !LOOP_ONLY_TOOLS.has(t.name));

  const promptConfig = {
    ...config,
    profession: {
      ...config.profession,
      instructions: `${config.profession.instructions.trim()}\n\n${ROLE}`,
    },
  };

  async function runTurn(signal: AbortSignal | undefined): Promise<TurnResult> {
    const description = model.describe();
    const tools = await describedTools();
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
      const projection = buildProjection({
        events,
        config: promptConfig,
        tools,
        providerId: model.id,
        budget: {
          modelCallsLeft: TURN_LIMITS.modelCalls - modelCalls,
          toolCallsLeft: TURN_LIMITS.toolCalls - toolCalls,
        },
      });
      await recordModelEvent("model.requested", {
        provider: model.id,
        model: description.model,
        messageCount: projection.messages.length,
        toolNames: tools.map((t) => t.name),
      });
      modelCalls += 1;
      if (task) task.modelCalls += 1;

      let response: ModelResponse;
      try {
        response = await model.generate(
          {
            system: projection.system,
            messages: projection.messages,
            tools: projection.tools,
            maxOutputTokens: config.limits.maxOutputTokens,
            budget: projection.budget,
            stableMessages: projection.messages.length - 1,
            ...(config.model?.options && { providerOptions: config.model.options }),
          },
          signal,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await recordModelEvent("model.failed", { code: "model_error", message });
        return { reply: "", stopped: signal?.aborted ? "aborted" : "model_error", detail: message };
      }
      await recordModelEvent("model.completed", {
        stopReason: response.stopReason,
        content: response.message.content,
        ...(config.debug?.persistRaw && response.raw !== undefined && { raw: response.raw }),
      });
      await recordModelEvent("usage.recorded", {
        kind: "model_inference",
        provider: model.id,
        model: description.model,
        usage: response.usage,
      });
      if (task && task.modelCalls > config.limits.maxModelCalls) {
        await callTool(
          {
            id: `call_limit_${task.id}`,
            name: "work_fail",
            input: {
              reason: "limit_reached",
              detail: `${config.limits.maxModelCalls} model calls`,
            },
          },
          signal,
        );
        return {
          reply: textOf(response.message.content),
          stopped: "turn_limit",
          detail: `model calls in one work (${config.limits.maxModelCalls})`,
        };
      }

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
            const outcome = await callTool(call, signal);
            if (outcome === "withdrawn") return { reply: text, stopped: "aborted" };
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
    }
  }

  /**
   * One tool call of the model, through the runtime. Keeps track of the work the model is on,
   * asks the person when the runtime says a question is pending, and mirrors the call and its
   * result into the session's projection.
   */
  async function callTool(
    call: { id: string; name: string; input: unknown },
    signal: AbortSignal | undefined,
  ): Promise<"done" | "withdrawn"> {
    const workId = task?.id ?? id;
    events.push(
      local("tool.called", {
        callId: call.id,
        provider: "runtime",
        name: call.name,
        input: call.input,
      }),
    );
    await options.onEvent?.(workId, events.at(-1) as AnyEvent);
    const input =
      call.name === "work_create" && call.input && typeof call.input === "object"
        ? { ...(call.input as Record<string, unknown>), parent: id, agent_name: agentName }
        : call.input;
    let result: ClientResult;
    try {
      result = await client.call(call.name, input, signal);
    } catch (err) {
      result = {
        content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
        isError: true,
        text: "",
      };
    }
    task?.callIds.add(call.id);
    const data = result.isError
      ? undefined
      : (jsonOf(result) as Record<string, unknown> | undefined);

    if (
      !result.isError &&
      (call.name === "work_create" || call.name === "work_select") &&
      data?.id
    ) {
      const workId = data.id as WorkId;
      task = { id: workId, modelCalls: 0, callIds: new Set([call.id]) };
      candidate = undefined;
      await options.onEvent?.(
        workId,
        local("work.status_changed", {
          from: "queued",
          to: String(data.status ?? "in_progress"),
          reason: call.name,
        }),
      );
      // A selected work that waits for an answer gets it now, oldest question first.
      if (call.name === "work_select" && data.status === "waiting_input") {
        const answered = await answerPending(workId, signal);
        if (answered === "withdrawn") {
          finish(call.id, result);
          return "withdrawn";
        }
        if (answered.length > 0) {
          result = {
            ...result,
            text: "",
            content: [
              ...result.content,
              { type: "text", text: `answers recorded: ${JSON.stringify(answered)}` },
            ],
          };
        }
      }
    }
    if (!result.isError && call.name === ASK_USER_TOOL_NAME && data?.pending === true && task) {
      const asked = task.id;
      const question = String(data.question ?? "");
      if (!options.onInput) {
        result = {
          ...result,
          text: "",
          content: [
            {
              type: "text",
              text: "the work waits for the person's answer; it can be resumed later",
            },
          ],
        };
      } else {
        let answer: string;
        try {
          answer = await options.onInput(asked, question);
        } catch {
          // The person took the question back: the work stays waiting_input.
          finish(call.id, {
            content: [{ type: "text", text: "the person withdrew the question; the work waits" }],
            isError: true,
            text: "",
          });
          return "withdrawn";
        }
        const answered = await client.call(
          "work_answer",
          { call_id: data.call_id, answer },
          signal,
        );
        result = answered.isError
          ? answered
          : { content: [{ type: "text", text: answer }], isError: false, text: answer };
      }
    }
    finish(call.id, result);
    if (!result.isError && (call.name === "work_complete" || call.name === "work_fail") && task) {
      const closed = task;
      task = undefined;
      foldAway(closed, call.id);
      await options.onEvent?.(
        closed.id,
        local(
          call.name === "work_complete" ? "work.completed" : "work.failed",
          call.name === "work_complete"
            ? { summary: String((call.input as { summary?: unknown })?.summary ?? "") }
            : { reason: String((call.input as { reason?: unknown })?.reason ?? ""), detail: "" },
        ) as AnyEvent,
      );
    }
    return "done";
  }

  /** Asks the person every question the work still waits on and records the answers. */
  async function answerPending(
    workId: WorkId,
    signal: AbortSignal | undefined,
  ): Promise<{ question: string; answer: string }[] | "withdrawn"> {
    if (!options.onInput) return [];
    const got = await client.call("work_get", { id: workId, history: true }, signal);
    const history = (
      jsonOf(got) as { history?: { pending?: { callId: string; question: string }[] } }
    )?.history;
    const answers: { question: string; answer: string }[] = [];
    for (const { callId, question } of history?.pending ?? []) {
      let answer: string;
      try {
        answer = await options.onInput(workId, question);
      } catch {
        return "withdrawn";
      }
      const recorded = await client.call("work_answer", { call_id: callId, answer }, signal);
      if (recorded.isError) throw new Error(recorded.text);
      answers.push({ question, answer });
    }
    return answers;
  }

  function finish(callId: string, result: ClientResult): void {
    const event = local("tool.completed", {
      callId,
      content: result.content,
      isError: result.isError,
    });
    events.push(event);
    void options.onEvent?.(task?.id ?? id, event);
  }

  /** Once a work is closed, only its summary stays in the conversation: the tool results are folded away. */
  function foldAway(closed: TaskState, closingCallId: string): void {
    for (const event of events) {
      if (event.type !== "tool.completed") continue;
      const payload = (event as Event<"tool.completed">).payload;
      if (!closed.callIds.has(payload.callId) || payload.callId === closingCallId) continue;
      payload.content = [
        {
          type: "text",
          text: `(この結果は Work ${closed.id} を閉じたので省略。要点は work_complete の summary にある)`,
        },
      ];
    }
  }

  return {
    id,
    agentName,
    async turn(text, turnOptions = {}) {
      events.push(local("human.message", { text }));
      await record(id, "human.message", { text });
      if (candidate) {
        const note = `候補の Work: ${candidate.id}(status: ${candidate.status}、objective: ${candidate.objective})。この依頼がその objective に沿うなら work_select で続ける。沿わなければ続けず、その旨を伝えて新しい Work を作るか work_list で探し直す。`;
        events.push(
          local("prompt.expanded", { name: "work resume", source: "builtin", text: note }),
        );
        await record(id, "prompt.expanded", { name: "work resume", source: "builtin", text: note });
      }
      const result = await runTurn(turnOptions.signal);
      if (!task) return result;
      // The turn stopped inside a work. The next turn starts from the conversation again; the
      // work stays as it is and comes back as a candidate through select.
      const left = task.id;
      task = undefined;
      await client.call("work_select", { id });
      return { ...result, work: left };
    },
    async select(workId) {
      const got = await client.call("work_get", { id: workId });
      if (got.isError) throw new Error(got.text);
      const work = jsonOf(got) as Work;
      if (isTerminal(work.status))
        throw new Error(`${work.id} は ${work.status} で、続けられません`);
      candidate = { id: work.id, objective: work.objective, status: work.status };
      return work;
    },
    currentWork: () => task?.id,
    async close() {
      const selected = await client.call("work_select", { id });
      if (selected.isError) {
        const got = await client.call("work_get", { id });
        return jsonOf(got) as Work;
      }
      const closed = await client.call("work_complete", { summary: "会話を終了" });
      if (closed.isError) throw new Error(closed.text);
      return jsonOf(closed) as Work;
    },
  };
}

/** The names of the sessions still open, so two people talking at once do not get the same one. */
async function namesInUse(client: RuntimeClient): Promise<string[]> {
  const listed = await client.call("work_list", {});
  if (listed.isError) return [];
  const { works } = jsonOf(listed) as {
    works: { type: string; status: string; agentName?: string }[];
  };
  return works
    .filter((w) => w.type === SESSION_WORK_TYPE && !isTerminal(w.status as Work["status"]))
    .flatMap((w) => (w.agentName ? [w.agentName] : []));
}

function textOf(content: AssistantPart[]): string {
  return content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
}
