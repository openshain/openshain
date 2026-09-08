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
  type ToolContent,
  type ToolDefinition,
  type Work,
  type WorkId,
} from "@openshain/core";
import { type ClientResult, jsonOf, type RuntimeClient } from "./client.ts";
import { pickAgentName } from "./names.ts";

/** How much one turn of the conversation may do before it stops and the person is told. */
export const TURN_LIMITS = { modelCalls: 25, toolCalls: 40 } as const;

/** The tools of the runtime that the loop itself drives; the model never sees them. */
const LOOP_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "work_record",
  "work_answer",
  // Deciding is the person's, or a qualified reviewer's. A model that could call these would
  // approve the very calls the policy held.
  "approval_decide",
  "review_decide",
]);

/**
 * What the conversation adds to the profession's own instructions. Written as sections, and as
 * what to do rather than what to avoid: models differ in how much they say after a tool call,
 * so the screen's side of the contract is stated here instead of left to a model's default.
 */
const ROLE = [
  "# 画面",
  "あなたの返答は端末の画面に出る。人に見えるのは、あなたが書いた文と、Tool 呼び出しの名前と引数の 1 行だけ。Tool が返した中身と、work_complete に書いた summary は人には見えない。依頼の答えは返答に書く。",
  "",
  "# 返答の書き方",
  "- 結果から書く。前置き(「承知しました」)と後置き(「ご不明な点があれば」)は書かない",
  "- 依頼が終わったターンでは、何をしたか、答えになる数字(件数、金額、書いたファイルの場所)を書く。次にできることがあれば 1 行で添える",
  "- 見出し、箇条書き、番号、太字、コードブロック、引用が使える。画面がそのまま書式として描く。表は書式にならないので、箇条書きにする",
  "- 数字は Tool が返した値をそのまま書く",
  "- 長さは依頼の大きさに合わせる。1 行で足りる依頼には 1 行で答える",
  "",
  "# 仕事の進め方",
  "- あなたは受付の役でこの人と話す。作業が要るときは work_create で Work を作り(objective は人の言葉で書き、会話で分かった前提を添える)、その Work の中で Tool を呼び、work_complete の summary に記録用の要約を書いて閉じる。summary は記録に残すもの、返答は人に伝えるもの",
  "- 会話の中では Tool を呼べない。ファイルの中身を読まないと答えられない質問も、Work を作って調べる",
  "- /work resume で候補として示された Work は、人の依頼がその objective に沿うときだけ work_select で続ける。沿わなければ続けず、その旨を伝えて新しい Work を作るか work_list で探し直す",
  "- 過去の作業は work_list と work_get で答える",
  "",
  "# 承認と資格者の判断",
  "- 承認が要る呼び出しは止まる。人が決めるまで待ち、同じ呼び出しを繰り返さない",
  "- 実行しないと決められた呼び出しは、理由を読んで別の案を出す。同じ入力で呼び直さない",
  "- 承認と判断は人と資格者の仕事で、あなたの仕事ではない",
].join("\n");

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
  /**
   * Asks the person about a call the policy held, while the turn waits. Without it, the turn
   * ends and the call stays held for `/approve` or for another client.
   */
  onApproval?: (held: HeldApproval) => Promise<ApprovalAnswer>;
}

export type TurnStop =
  | "turn_limit"
  | "aborted"
  | "max_tokens"
  | "refusal"
  | "model_error"
  | "approval";

/** A tool call the policy holds until a person decides on it. */
export interface HeldApproval {
  approvalId: string;
  workId: WorkId;
  name: string;
  input: unknown;
  /** The rule that held it: the unit a person can say yes to for the rest of the conversation. */
  ruleId: string;
  /** review when a qualified reviewer has to decide; a person cannot stand in for one. */
  kind: "approval" | "review";
  reviewer?: { role: string; name?: string };
}

/**
 * What the person answered about a held call. `always` approves this one and every later call
 * the same rule holds, for this conversation only: nothing is written to authority/, and every
 * call is still recorded as requested and decided.
 */
export type ApprovalChoice = "approve" | "always" | "reject";

/** The person's answer: what they chose, and what they want the agent to know. */
export interface ApprovalAnswer {
  choice: ApprovalChoice;
  /** Why, in the person's words. Recorded with the decision and handed to the model. */
  comment?: string;
}

export interface TurnResult {
  /** What the model said to the person, possibly empty when the turn stopped early. */
  reply: string;
  /** Why the turn ended before the model replied, if it did. */
  stopped?: TurnStop;
  detail?: string;
  /** The work the turn left open, when it stopped inside one. It can be continued with select. */
  work?: WorkId;
  /** The call held for approval, when the turn stopped for one. */
  approval?: HeldApproval;
}

export interface Session {
  readonly id: WorkId;
  /** The name the agent goes by in this conversation and in the works it starts. */
  readonly agentName: string;
  /** Records what the person said and runs the model until it replies or the turn stops. */
  turn(text: string, options?: { signal?: AbortSignal }): Promise<TurnResult>;
  /** Names a stopped work as the candidate for the next request. The model decides whether to continue it. */
  select(workId: WorkId): Promise<Work>;
  /** Decides a held call as the person. approve runs it; either way the work becomes the candidate. */
  decide(
    approvalId: string,
    decision: "approve" | "reject",
    comment?: string,
  ): Promise<{ workId: WorkId; text: string }>;
  /** Records what a qualified reviewer decided about a call held for review. */
  review(input: {
    approvalId: string;
    decision: "approve" | "reject";
    reviewer: { name: string; role: string; qualification?: string };
    interpretation: string;
    appliesTo?: { action?: string; path?: string };
  }): Promise<{ workId: WorkId; text: string }>;
  /** The calls held for approval across the workspace. */
  approvals(): Promise<HeldApproval[]>;
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
  let held: HeldApproval | undefined;
  /** Rules the person said yes to for the rest of this conversation. */
  const standing = new Set<string>();

  // The basics (time, business date, folder) enter the conversation as a recorded prompt, so the
  // projection stays a function of the record. The model can refresh them with the context tool.
  const basics = await client.call("context", {});
  const info = basics.isError ? undefined : (jsonOf(basics) as Record<string, unknown> | undefined);
  const basicsText = info
    ? `現在時刻は ${info.now}(${info.timezone})、今日の業務日は ${info.business_date}。会社フォルダは ${info.workspace}。日付や時刻が要るときは context を呼ぶ。`
    : undefined;

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

  if (basicsText) {
    events.push(local("prompt.expanded", { name: "context", source: "runtime", text: basicsText }));
    await record(id, "prompt.expanded", { name: "context", source: "runtime", text: basicsText });
  }

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
      if (task && task.modelCalls >= config.limits.maxModelCalls) {
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
          reply: "",
          stopped: "turn_limit",
          detail: `model calls in one work (${config.limits.maxModelCalls})`,
        };
      }
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
      const text = textOf(response.message.content);
      switch (response.stopReason) {
        case "end_turn":
          return { reply: text };
        case "tool_call": {
          const calls = response.message.content.filter((p) => p.type === "tool_call");
          for (const [index, call] of calls.entries()) {
            if (signal?.aborted) {
              await closeRest(calls, index, "the turn stopped before this call ran");
              return { reply: text, stopped: "aborted" };
            }
            if (toolCalls >= TURN_LIMITS.toolCalls) {
              await closeRest(calls, index, "the turn reached its limit before this call ran");
              return {
                reply: text,
                stopped: "turn_limit",
                detail: `tool calls in one turn (${TURN_LIMITS.toolCalls})`,
              };
            }
            toolCalls += 1;
            const outcome = await callTool(call, signal);
            if (outcome === "withdrawn") {
              await closeRest(calls, index + 1, "the turn stopped before this call ran");
              return { reply: text, stopped: "aborted" };
            }
            if (outcome === "held" && held) {
              await closeRest(
                calls,
                index + 1,
                "the turn stopped for an approval before this call ran",
              );
              return { reply: text, stopped: "approval", approval: held };
            }
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
  ): Promise<"done" | "withdrawn" | "held"> {
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
    // The loop drives these itself; a model that calls them is refused before the runtime sees it.
    const refusal = LOOP_ONLY_TOOLS.has(call.name)
      ? `${call.name} is the loop's own; it is not a tool for the model`
      : !task && (call.name === "work_complete" || call.name === "work_fail")
        ? `${call.name} needs a work of its own: no work is open; start one with work_create`
        : undefined;
    if (refusal) {
      await finish(call.id, {
        content: [{ type: "text", text: refusal }],
        isError: true,
        text: "",
      });
      return "done";
    }
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
      const history = (data as { history?: { modelCalls?: number } }).history;
      task = {
        id: workId,
        modelCalls: typeof history?.modelCalls === "number" ? history.modelCalls : 0,
        callIds: new Set([call.id]),
      };
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
          await finish(call.id, result);
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
          await finish(call.id, {
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
    if (!result.isError && (data?.pending === "approval" || data?.pending === "review") && task) {
      const reviewer = data.reviewer as { role: string; name?: string } | undefined;
      const pending: HeldApproval = {
        approvalId: String(data.approval_id),
        workId: task.id,
        name: call.name,
        input: call.input,
        ruleId: String(data.rule_id ?? ""),
        kind: data.pending === "review" ? "review" : "approval",
        ...(reviewer && { reviewer }),
      };
      // A review needs a qualified person, so the turn stops whatever the screen can ask.
      if (pending.kind === "review") {
        held = pending;
        await finish(call.id, {
          content: [
            {
              type: "text",
              text: `held for a review by a ${reviewer?.role ?? "reviewer"} (${pending.approvalId}); the work waits until the reviewer decides`,
            },
          ],
          isError: false,
          text: "",
        });
        return "held";
      }
      // With a way to ask, the person decides here and the turn goes on. Without one, the turn
      // ends and the call stays held for /approve or for another client.
      if (!options.onApproval) {
        held = pending;
        await finish(call.id, {
          content: [
            {
              type: "text",
              text: `held for approval ${pending.approvalId}; the person decides before the work goes on`,
            },
          ],
          isError: false,
          text: "",
        });
        return "held";
      }
      let answer: ApprovalAnswer;
      if (pending.ruleId !== "" && standing.has(pending.ruleId)) {
        answer = { choice: "approve" };
      } else {
        try {
          answer = await options.onApproval(pending);
        } catch {
          // The person left it undecided: the work stays waiting_approval and the turn ends.
          held = pending;
          await finish(call.id, {
            content: [
              {
                type: "text",
                text: "the person left this call undecided; it is still waiting for their approval and the work stops here",
              },
            ],
            isError: true,
            text: "",
          });
          return "held";
        }
        if (answer.choice === "always" && pending.ruleId !== "") standing.add(pending.ruleId);
      }
      const standingNote =
        answer.choice === "always"
          ? `この会話では規則 ${pending.ruleId} を常に承認する、と決めた`
          : undefined;
      const comment = [answer.comment, standingNote].filter(Boolean).join(" / ");
      const decided = await client.call(
        "approval_decide",
        {
          approval_id: pending.approvalId,
          decision: answer.choice === "reject" ? "reject" : "approve",
          ...(comment !== "" && { comment }),
        },
        signal,
      );
      const outcome = jsonOf(decided) as
        | { result?: { content: ToolContent[]; isError: boolean } }
        | undefined;
      if (decided.isError) {
        // The work is still waiting; nothing the model does next can move it.
        held = pending;
        await finish(call.id, decided);
        return "held";
      }
      if (answer.choice === "reject") {
        const said = answer.comment ? ` They said: ${answer.comment}` : "";
        await finish(call.id, {
          content: [
            {
              type: "text",
              text: `the person refused this call; it did not run and the work is not waiting for anyone.${said} Do not call it again unchanged: say what you would need, or propose another way.`,
            },
          ],
          isError: true,
          text: "",
        });
      } else {
        await finish(call.id, {
          content: outcome?.result?.content ?? [{ type: "text", text: "approved" }],
          isError: outcome?.result?.isError ?? false,
          text: "",
        });
      }
      return "done";
    }
    await finish(call.id, result);
    if (!result.isError && (call.name === "work_complete" || call.name === "work_fail") && task) {
      const closed = task;
      task = undefined;
      foldAway(closed, call.id);
      // The rule that matters most is stated where it is needed, not only in the system prompt:
      // the work is closed and its summary went to the record, so the person has read nothing
      // yet. Smaller models end the turn with an acknowledgement without this.
      const note =
        call.name === "work_complete"
          ? `Work ${closed.id} を閉じた。summary は記録に残るだけで、人の画面には出ない。この後の返答で、何をしたかと結果の数字を人に伝える。`
          : `Work ${closed.id} は失敗として閉じた。この後の返答で、どこまで進んで何が起きたかを人に伝える。`;
      events.push(local("prompt.expanded", { name: "work closed", source: "runtime", text: note }));
      await record(id, "prompt.expanded", { name: "work closed", source: "runtime", text: note });
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

  /**
   * Gives every call from `from` on a result, so that the projection stays well formed: a tool
   * call without a result cannot be sent to a model, and the next turn would refuse to build.
   */
  async function closeRest(calls: { id: string }[], from: number, text: string): Promise<void> {
    for (const call of calls.slice(from)) {
      await finish(call.id, { content: [{ type: "text", text }], isError: true, text: "" });
    }
  }

  async function finish(callId: string, result: ClientResult): Promise<void> {
    const event = local("tool.completed", {
      callId,
      content: result.content,
      isError: result.isError,
    });
    events.push(event);
    // The screen draws from these in order, so the result waits for the caller as the call did.
    await options.onEvent?.(task?.id ?? id, event);
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
      held = undefined;
      events.push(local("human.message", { text }));
      await record(id, "human.message", { text });
      if (candidate) {
        const note = `候補の Work: ${candidate.id}(status: ${candidate.status}、objective: ${candidate.objective})。この依頼がその objective に沿うなら work_select で続ける。沿わなければ続けず、その旨を伝えて新しい Work を作るか work_list で探し直す。`;
        events.push(
          local("prompt.expanded", { name: "work resume", source: "builtin", text: note }),
        );
        await record(id, "prompt.expanded", { name: "work resume", source: "builtin", text: note });
      }
      try {
        const result = await runTurn(turnOptions.signal);
        return task ? { ...result, work: task.id } : result;
      } finally {
        // Whatever the turn did, the next one starts from the conversation: a work it left open
        // stays as it is and comes back as a candidate through select; a declined candidate is dropped.
        candidate = undefined;
        if (task) {
          task = undefined;
          await client.call("work_select", { id }).catch(() => undefined);
        }
      }
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
    async decide(approvalId, decision, comment) {
      const decided = await client.call("approval_decide", {
        approval_id: approvalId,
        decision,
        ...(comment !== undefined && { comment }),
      });
      if (decided.isError) throw new Error(decided.text);
      const data = jsonOf(decided) as {
        work_id: string;
        result?: { content: { type: string; text?: string }[]; isError: boolean };
      };
      const workId = data.work_id as WorkId;
      const outcome =
        decision === "reject"
          ? "拒否"
          : data.result?.isError
            ? `実行して失敗: ${data.result.content.map((c) => c.text ?? "").join("")}`
            : "実行して成功";
      const note = `承認 ${approvalId} を${decision === "approve" ? "承認" : "拒否"}した(${outcome})。Work ${workId} は続けられる。`;
      events.push(local("prompt.expanded", { name: "approval", source: "runtime", text: note }));
      await record(id, "prompt.expanded", { name: "approval", source: "runtime", text: note });
      const got = await client.call("work_get", { id: workId });
      const work = jsonOf(got) as Work | undefined;
      if (work && !isTerminal(work.status)) {
        candidate = { id: work.id, objective: work.objective, status: work.status };
      }
      return { workId, text: note };
    },
    async review(input) {
      const decided = await client.call("review_decide", {
        approval_id: input.approvalId,
        decision: input.decision,
        reviewer: input.reviewer,
        interpretation: input.interpretation,
        ...(input.appliesTo && { applies_to: input.appliesTo }),
      });
      if (decided.isError) throw new Error(decided.text);
      const data = jsonOf(decided) as {
        work_id: string;
        decision_id?: string;
        decision_file?: string;
        result?: { isError: boolean };
      };
      const workId = data.work_id as WorkId;
      const note =
        input.decision === "approve"
          ? `${input.reviewer.name}(${input.reviewer.role})が承認し、判断を ${data.decision_file} に記録した。Work ${workId} は続けられる。`
          : `${input.reviewer.name}(${input.reviewer.role})が認めなかった。理由: ${input.interpretation}。Work ${workId} は続けられる。`;
      events.push(local("prompt.expanded", { name: "review", source: "runtime", text: note }));
      await record(id, "prompt.expanded", { name: "review", source: "runtime", text: note });
      const got = await client.call("work_get", { id: workId });
      const work = jsonOf(got) as Work | undefined;
      if (work && !isTerminal(work.status)) {
        candidate = { id: work.id, objective: work.objective, status: work.status };
      }
      return { workId, text: note };
    },
    async approvals() {
      const listed = await client.call("approval_list", {});
      if (listed.isError) throw new Error(listed.text);
      const { approvals } = jsonOf(listed) as {
        approvals: {
          approvalId: string;
          work_id: string;
          ruleId: string;
          kind: "approval" | "review";
          reviewer?: { role: string; name?: string };
          call: { name: string; input: unknown };
        }[];
      };
      return approvals.map((a) => ({
        approvalId: a.approvalId,
        workId: a.work_id as WorkId,
        name: a.call.name,
        input: a.call.input,
        ruleId: a.ruleId,
        kind: a.kind,
        ...(a.reviewer && { reviewer: a.reviewer }),
      }));
    },
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
