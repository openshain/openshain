import {
  type ApprovalAnswer,
  type ApprovalChoice,
  type CompactionOutcome,
  connectInMemory,
  createSession,
  type HeldApproval,
  type Session,
  type TurnResult,
} from "@openshain/agent";
import {
  type Event,
  loadConfig,
  OpenshainError,
  type RuntimeProviders,
  type WorkId,
  WorkStore,
} from "@openshain/core";
import { createMcpServer } from "@openshain/mcp";
import { toolsList } from "../commands/tools.ts";
import { workList, workShow } from "../commands/work.ts";
import { describeInput, plain } from "../format.ts";
import { statusLabel } from "../labels.ts";
import { type PreviewLine, previewCall } from "../preview.ts";
import { progressLine, report } from "../report.ts";
import { LOGO_ROWS, VERSION } from "./banner.ts";

/** logo and banner are the rows shown once when the screen opens: the wordmark, the version, the folder. */
export type EntryKind =
  | "user"
  | "assistant"
  | "progress"
  | "notice"
  | "question"
  | "line"
  | "logo"
  | "banner";

export interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
}

export interface ControllerState {
  /**
   * Everything shown so far, in order. An entry never changes once added, and the array is
   * replaced rather than mutated: the screen tells new entries apart by the array's identity.
   */
  entries: Entry[];
  busy: boolean;
  /** A question a work is asking; the next line the person types answers it. */
  question?: string;
  /** A call held for approval; the person picks one of its choices before the work goes on. */
  approval?: {
    approvalId: string;
    title: string;
    ruleId: string;
    preview: PreviewLine[];
    choices: { key: ApprovalChoice | "reject_with_reason"; label: string }[];
    at: number;
  };
  /** After "no, and tell the agent why": the next line the person types is that reason. */
  reason?: string;
  /** Lines typed while the screen was busy. They are sent in order once it is free. */
  queued: string[];
  closed: boolean;
  status: {
    company: string;
    model: string;
    /** The name the agent goes by in this conversation. */
    agentName?: string;
    work?: { id: string; status: string };
    usage: { modelCalls: number; inputTokens: number; outputTokens: number };
  };
}

export interface Controller {
  readonly sessionId: WorkId;
  state(): ControllerState;
  subscribe(listener: () => void): () => void;
  /** A line the person typed: an answer, a slash command, or something to say. */
  submit(line: string): Promise<void>;
  /** Ctrl-C: stops the running work, taking back a question it waits on; false when nothing was running. */
  interrupt(): boolean;
  /** Moves the highlight in the approval choices. */
  moveApproval(delta: number): void;
  /** Answers the approval being shown: the highlighted choice, or the one given. */
  decideApproval(choice?: ApprovalChoice | "reject_with_reason"): void;
  /** Stops whatever is running, then ends the session. A second call waits for the same close. */
  close(): Promise<void>;
}

export interface ControllerOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
  /** Who this terminal works for, when the person said so. */
  as?: string | undefined;
}

/**
 * What the screen says when the conversation was summarized. The person cannot read the summary
 * itself, so the line carries what they told the agent: that is the part they can check.
 */
export function compactionLine(outcome: CompactionOutcome): string {
  if (!outcome.done) {
    switch (outcome.reason) {
      case "nothing_to_compact":
        return "まだ要約するところがありません。";
      case "no_smaller":
        return "この会話はこれ以上要約できません。いったん終えて、新しく始めるほうが確かです。";
      case "empty":
        return "要約が空だったので、会話はそのままです。";
      case "secret":
        return "要約に鍵らしき文字列が入ったので、記録しませんでした。会話はそのままです。";
      default:
        return `要約に失敗したので、会話はそのままです。${outcome.detail ?? ""}`.trim();
    }
  }
  const assumed = heading(outcome.summary, "人が伝えた前提");
  const kept = assumed ? `。人が伝えた前提: ${assumed}` : "";
  return `会話を要約しました(${outcome.covered} 件を 1 件に)${kept}`;
}

/** What one heading of a summary says, in one line and at most this long. */
function heading(summary: string, name: string): string | undefined {
  const lines = summary.split("\n");
  const at = lines.findIndex((line) => line.includes(name));
  if (at < 0) return undefined;
  const said: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const text = line.replace(/^[#\s*-]+/, "").trim();
    if (text === "") continue;
    if (/^#/.test(line) || /^\*\*/.test(line)) break;
    said.push(text);
    if (said.join("、").length > 120) break;
  }
  const all = said.join("、");
  if (all === "" || all === "なし") return undefined;
  return all.length > 120 ? `${all.slice(0, 120)}…` : all;
}

const HELP = [
  "/work list         Work の一覧",
  "/work show <id>    Work の詳細",
  "/work resume <id>  止まった Work を候補にする。次の依頼がそれに沿えば続ける",
  "/approvals         承認待ちの一覧",
  "/approve <id>      承認して実行する。/reject <id> [理由] で拒否する",
  "/review <id> approve|reject  資格者の判断を記録する。名前と本文を順に聞く",
  "/compact           会話を要約して短くする。長い会話は自動でも要約される",
  "/tools             使える Tool",
  "/quit              終わる",
  "↑ ↓                前に送った行を入力欄に呼び戻す。いちばん下は新しい入力",
  "← → Home End       入力欄でカーソルを動かす。Backspace と Delete はカーソルの位置で消す",
  "ホイール、PageUp/PageDown  会話を遡る。送ると最新に戻る",
  "Ctrl-C             動いている Work を止める。質問待ちなら質問を取り下げる。何も動いていなければ終わる",
];

/** The choices the screen offers for a held call, in the order they are shown. */
const APPROVAL_CHOICES: { key: ApprovalChoice | "reject_with_reason"; label: string }[] = [
  { key: "approve", label: "はい。実行する" },
  { key: "always", label: "はい。この会話では同じ規則の呼び出しを常に承認する" },
  { key: "reject", label: "いいえ。実行しない" },
  { key: "reject_with_reason", label: "いいえ。理由を伝えて実行しない" },
];

/** What the session's model hears when the person stops a work that waits for their answer. */
const QUESTION_WITHDRAWN =
  "the person stopped the work while it waited for their answer; the question is still pending and the work can be resumed";

/** What the loop hears when the person leaves a held call undecided. */
const APPROVAL_WITHDRAWN = "the person left the approval undecided";

/**
 * The state behind the screen: a session, the works it starts, and the lines to show. The
 * conversation reaches the runtime only as an MCP client of the workspace's own server, the way
 * any other agent does; the records are read directly for the closing lines.
 */
export async function createController(options: ControllerOptions): Promise<Controller> {
  const { workspaceRoot, providers } = options;
  const config = await loadConfig(workspaceRoot, {
    modelProviders: Object.keys(providers.models),
    as: options.as,
  });
  if (!config.model) {
    throw new OpenshainError(
      "config",
      "対話にはモデルが要ります。openshain.yaml に model を書いてください。Claude Code や Codex から使うだけなら要りません。",
    );
  }
  const modelFactory = Object.hasOwn(providers.models, config.model.provider)
    ? providers.models[config.model.provider]
    : undefined;
  if (!modelFactory) {
    throw new OpenshainError("config", `unknown model provider "${config.model.provider}"`);
  }
  const model = modelFactory(config.model);
  if (!model.describe().capabilities.tools) {
    throw new OpenshainError(
      "config",
      `model ${config.model.provider}/${config.model.model} cannot call tools; openshain needs a model with tool support`,
    );
  }
  const server = await createMcpServer({ workspaceRoot, tools: providers.tools });
  const client = await connectInMemory(server);
  const store = new WorkStore(workspaceRoot);
  const listeners = new Set<() => void>();
  let nextId = 1;
  const state: ControllerState = {
    entries: [],
    busy: false,
    closed: false,
    queued: [],
    status: {
      company: config.company.name,
      model: `${config.model.provider}/${config.model.model}`,
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
    },
  };
  // A listener may act on the controller and cause another notification; those run after this one.
  let notifying = false;
  let again = false;
  const notify = () => {
    if (notifying) {
      again = true;
      return;
    }
    notifying = true;
    try {
      do {
        again = false;
        for (const listener of listeners) listener();
      } while (again);
    } finally {
      notifying = false;
    }
  };
  const push = (kind: EntryKind, text: string) => {
    state.entries = [...state.entries, { id: nextId++, kind, text: plain(text) }];
    notify();
  };

  let pending: { resolve: (text: string) => void; reject: (reason: Error) => void } | undefined;
  let deciding:
    | { resolve: (answer: ApprovalAnswer) => void; reject: (reason: Error) => void }
    | undefined;
  let aborter: AbortController | undefined;
  let running: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  const names = new Map<string, string>();

  /** Asks the person for one line and waits for it. The next line they type is the answer. */
  const askLine = (question: string): Promise<string> => {
    state.question = question;
    push("question", question);
    notify();
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
    });
  };
  const ask = (workId: WorkId, question: string): Promise<string> => {
    state.question = question;
    push("question", `${question}(${workId})`);
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
    });
  };
  /** Shows a held call and waits for the person to pick one of the choices. */
  const askApproval = async (approval: HeldApproval): Promise<ApprovalAnswer> => {
    const preview = await previewCall(workspaceRoot, {
      name: approval.name,
      input: approval.input,
    }).catch((err) => [{ kind: "note", text: message(err) } as PreviewLine]);
    const title = `${approval.name} ${describeInput(approval.input)}`.trimEnd();
    state.approval = {
      approvalId: approval.approvalId,
      title,
      ruleId: approval.ruleId,
      preview,
      choices: APPROVAL_CHOICES,
      at: 0,
    };
    push("question", `承認が要ります: ${title}`);
    for (const line of preview) {
      push(
        "progress",
        `${line.kind === "added" ? "+ " : line.kind === "removed" ? "- " : "  "}${line.text}`,
      );
    }
    return new Promise<ApprovalAnswer>((resolve, reject) => {
      deciding = { resolve, reject };
    });
  };
  /** Settles the approval being shown, or takes it back when there is no choice. */
  const settleApproval = (choice?: ApprovalChoice, comment?: string) => {
    const waiting = deciding;
    deciding = undefined;
    if (state.reason !== undefined) {
      delete state.reason;
      notify();
    }
    if (state.approval !== undefined) {
      const decided = choice ? APPROVAL_CHOICES.find((c) => c.key === choice)?.label : undefined;
      delete state.approval;
      if (decided) push("line", `> ${decided}`);
      notify();
    }
    if (!waiting) return;
    if (choice === undefined) waiting.reject(new Error(APPROVAL_WITHDRAWN));
    else waiting.resolve({ choice, ...(comment !== undefined && comment !== "" && { comment }) });
  };

  /** Answers the pending question, or takes it back when there is no answer. */
  const settleQuestion = (answer?: string) => {
    const waiting = pending;
    pending = undefined;
    if (state.question !== undefined) {
      delete state.question;
      notify();
    }
    if (!waiting) return;
    if (answer === undefined) waiting.reject(new Error(QUESTION_WITHDRAWN));
    else waiting.resolve(answer);
  };

  /** The lines the CLI prints when a work ends, shown among the progress lines. */
  const closingLines = async (workId: WorkId) => {
    for (const line of await workReport(store, workId)) push("progress", line.trimStart());
  };

  let sessionId: WorkId | undefined;
  /** Summaries of the works completed in this turn, until the agent reports them itself. */
  let unreported: string[] = [];
  const session: Session = await createSession(client, {
    model,
    config,
    onEvent: (workId, event) => {
      if (workId === sessionId) {
        if (event.type === "usage.recorded") {
          const { payload } = event as Event<"usage.recorded">;
          if (payload.kind === "model_inference") {
            state.status.usage.modelCalls += 1;
            state.status.usage.inputTokens += payload.usage.inputTokens;
            state.status.usage.outputTokens += payload.usage.outputTokens;
            notify();
          }
        }
        return;
      }
      if (event.type === "work.status_changed") {
        state.status.work = {
          id: workId,
          status: (event as Event<"work.status_changed">).payload.to,
        };
        notify();
        return;
      }
      if (event.type === "work.completed" || event.type === "work.failed") {
        state.status.work = {
          id: workId,
          status: event.type === "work.completed" ? "completed" : "failed",
        };
        if (event.type === "work.completed") {
          // Held, not shown: the agent is the one who tells the person what happened. It is
          // shown only if the turn ends without the agent saying anything (see submit).
          const { summary } = (event as Event<"work.completed">).payload;
          if (summary.trim() !== "") unreported.push(summary.trim());
        }
        return closingLines(workId);
      }
      // The work_* calls are the loop's own bookkeeping; the closing lines already say the work ended.
      if (
        event.type === "tool.called" &&
        (event as Event<"tool.called">).payload.name.startsWith("work_")
      ) {
        names.set(
          (event as Event<"tool.called">).payload.callId,
          (event as Event<"tool.called">).payload.name,
        );
        return;
      }
      const line = progressLine(event, names);
      if (line) push("progress", line);
      else notify();
    },
    onInput: ask,
    onApproval: askApproval,
  });
  sessionId = session.id;
  state.status.agentName = session.agentName;
  for (const row of LOGO_ROWS) push("logo", row);
  push("banner", `openshain ${VERSION}`);
  push("banner", workspaceRoot);
  // Said where it is used, not only in the documentation: the name is a choice, not a check.
  if (options.as) {
    push(
      "banner",
      `${config.principal.name}(${config.principal.id})として実行します。本人確認はしていません`,
    );
  }

  const stopped = (workId: WorkId | undefined) =>
    workId
      ? `止めました。${workId} は途中のまま残っています。/work resume ${workId} で続けられるようにします。`
      : "止めました。";

  const explain = (result: TurnResult) => {
    switch (result.stopped) {
      case "turn_limit":
        return "社員エージェントが 1 回の返答でできる回数を超えたので、ここで止めました。続きは改めて依頼してください。";
      case "aborted":
        return stopped(result.work);
      case "max_tokens":
        return "返答が長さの上限で切れました。";
      case "refusal":
        return "社員エージェントが続けられないと言っています。";
      case "model_error":
        return `model の呼び出しに失敗しました。${result.detail ?? ""}`.trim();
      case "approval": {
        const a = result.approval;
        if (!a) return "承認が要ります。/approvals で確かめてください。";
        if (a.kind === "review") {
          return `${a.reviewer?.role ?? "資格者"}の判断が要ります: ${a.name} ${describeInput(a.input)}(${a.approvalId})。Review Package は work/${a.workId}/review/ にあります。返答が届いたら /review ${a.approvalId} approve か /review ${a.approvalId} reject で記録します。`;
        }
        return `承認が要ります: ${a.name} ${describeInput(a.input)}(${a.approvalId})。/approve ${a.approvalId} で実行、/reject ${a.approvalId} で拒否します。`;
      }
      default:
        return undefined;
    }
  };

  const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

  /** Runs one thing the person can stop with Ctrl-C, and keeps the screen busy meanwhile. */
  const stoppable = async (fn: (signal: AbortSignal) => Promise<void>) => {
    const stopper = new AbortController();
    aborter = stopper;
    state.busy = true;
    notify();
    running = fn(stopper.signal);
    try {
      await running;
    } finally {
      running = undefined;
      aborter = undefined;
      state.busy = false;
      notify();
    }
  };

  /** Sends what the person typed while the agent was working, oldest first. */
  const drainQueue = async () => {
    while (state.queued.length > 0 && !closing) {
      const [next, ...rest] = state.queued as [string, ...string[]];
      state.queued = rest;
      notify();
      await self.submit(next);
    }
  };

  const capture = async (fn: (write: (line: string) => void) => Promise<unknown>) => {
    try {
      await fn((line) => push("line", line));
    } catch (err) {
      push("notice", message(err));
    }
  };

  const command = async (line: string) => {
    const [name, ...args] = line.slice(1).trim().split(/\s+/);
    const sub = args[0] ?? "";
    const id = args[1] ?? args[0] ?? "";
    if (name === "help") for (const h of HELP) push("line", h);
    else if (name === "quit" || name === "exit") await close();
    else if (name === "tools") await capture((write) => toolsList({ ...options, write }));
    else if (name === "compact") {
      const outcome = await session.compact();
      push(outcome.done ? "progress" : "notice", compactionLine(outcome));
    } else if (name === "work" && sub === "list")
      await capture((write) => workList({ workspaceRoot: options.workspaceRoot, write }));
    else if (name === "work" && (sub === "show" || sub === "resume") && !args[1])
      push("notice", `/work ${sub} には Work の id が要ります。/work list で確かめてください。`);
    else if (name === "work" && sub === "show" && id)
      await capture((write) => workShow({ workspaceRoot: options.workspaceRoot, id, write }));
    else if (name === "work" && sub === "resume" && id) {
      try {
        const work = await session.select(id as WorkId);
        push(
          "notice",
          `${work.id}(${statusLabel(work.status)}、${work.objective})を候補にしました。次の依頼がこの Work に沿えば続けます。`,
        );
      } catch (err) {
        push("notice", message(err));
      }
    } else if (name === "approvals") {
      try {
        const held = await session.approvals();
        if (held.length === 0) push("line", "承認待ちはありません。");
        for (const a of held) {
          push("line", `${a.approvalId}  ${a.name} ${describeInput(a.input)}  (${a.workId})`);
        }
      } catch (err) {
        push("notice", message(err));
      }
    } else if ((name === "approve" || name === "reject") && sub) {
      try {
        const comment = args.slice(1).join(" ");
        const { text } = await session.decide(sub, name, comment || undefined);
        push("line", text);
      } catch (err) {
        push("notice", message(err));
      }
    } else if (name === "approve" || name === "reject") {
      push("notice", `/${name} には承認の id が要ります。/approvals で確かめてください。`);
    } else if (name === "review" && sub && (args[1] === "approve" || args[1] === "reject")) {
      const decision = args[1];
      try {
        // The rule already says which role has to decide; the person only says who they are.
        const held = (await session.approvals()).find((a) => a.approvalId === sub);
        if (!held)
          throw new Error(`${sub} は承認待ちにありません。/approvals で確かめてください。`);
        if (held.kind !== "review") {
          throw new Error(`${sub} は人の承認待ちです。/approve か /reject で決めます。`);
        }
        const role = held.reviewer?.role ?? "reviewer";
        const who = await askLine(
          `${role} の名前と資格(例: 田中 太郎 / 税理士)。会社の申告として記録します`,
        );
        const [reviewerName, qualification] = who.split("/").map((part) => part.trim());
        const interpretation = await askLine(
          decision === "approve" ? "判断の本文(そのまま記録します)" : "認めない理由",
        );
        const { text } = await session.review({
          approvalId: sub,
          decision,
          reviewer: {
            name: reviewerName || who,
            role,
            ...(qualification && { qualification }),
          },
          interpretation,
        });
        push("line", text);
      } catch (err) {
        push("notice", message(err));
      }
    } else if (name === "review") {
      push("notice", "/review <id> approve か /review <id> reject の形です。");
    } else if (name === "resume") {
      push(
        "notice",
        "セッションの再開はまだありません。止まった Work を続けるなら /work resume <id> です。",
      );
    } else {
      push("notice", `分からないコマンドです。/help で一覧が表示されます。`);
    }
  };

  function close(): Promise<void> {
    closing ??= (async () => {
      aborter?.abort();
      settleQuestion();
      settleApproval();
      await running;
      try {
        await session.close();
      } catch (err) {
        push("notice", `会話の記録を閉じられませんでした。${message(err)}`);
      } finally {
        await client.close().catch(() => undefined);
        state.closed = true;
        notify();
      }
    })();
    return closing;
  }

  const self: Controller = {
    sessionId: session.id,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submit(line) {
      const text = line.trim();
      if (text === "" || closing) return;
      if (state.approval) {
        push("notice", "承認を先に決めてください。数字か ↑↓ と Enter で選びます。");
        return;
      }
      if (state.reason !== undefined) {
        push("user", text);
        settleApproval("reject", text);
        return;
      }
      if (pending) {
        push("user", text);
        // Everything typed answers the question, except leaving: that takes the question back.
        if (text === "/quit" || text === "/exit") await close();
        else settleQuestion(text);
        return;
      }
      if (state.busy) {
        // Typing while the agent works is not a mistake: the line waits its turn.
        state.queued = [...state.queued, text];
        push("notice", `順番待ち(${state.queued.length} 件): ${text}`);
        notify();
        return;
      }
      if (text.startsWith("/")) {
        push("user", text);
        await command(text);
        return;
      }
      push("user", text);
      unreported = [];
      await stoppable(async (signal) => {
        try {
          const result = await session.turn(text, { signal });
          if (result.compacted) {
            push(result.compacted.done ? "progress" : "notice", compactionLine(result.compacted));
          }
          // What the work recorded is the agent's own writing, so it stands in when the turn
          // ends with nothing said. Without this the person is left with a work that finished
          // and no answer, which is what a model that skips its summary leaves behind.
          const reply = result.reply.trim() === "" ? unreported.join("\n\n") : result.reply;
          if (reply) push("assistant", reply);
          const note = explain(result);
          if (note) push("notice", note);
        } catch (err) {
          push("notice", message(err));
        }
      });
      await drainQueue();
    },
    interrupt() {
      if (!aborter) return false;
      aborter.abort();
      settleQuestion();
      settleApproval();
      return true;
    },
    moveApproval(delta) {
      const approval = state.approval;
      if (!approval) return;
      const count = approval.choices.length;
      state.approval = { ...approval, at: (approval.at + delta + count) % count };
      notify();
    },
    decideApproval(choice) {
      const approval = state.approval;
      if (!approval) return;
      const picked = choice ?? approval.choices[approval.at]?.key ?? "reject";
      if (picked === "reject_with_reason") {
        // The palette closes and the input box takes the reason; the loop still waits.
        const shown = APPROVAL_CHOICES.find((c) => c.key === picked)?.label;
        delete state.approval;
        state.reason = "実行しない理由(社員エージェントに伝わります)";
        if (shown) push("line", `> ${shown}`);
        push("question", state.reason);
        notify();
        return;
      }
      settleApproval(picked);
    },
    close,
  };
  return self;
}

/** Lines that close a work in the screen: the CLI's closing lines without the summary, which the agent relays. */
export async function workReport(store: WorkStore, workId: WorkId): Promise<string[]> {
  const work = await store.get(workId);
  const events = await store.events(workId);
  const lines = report(work, events);
  return work.status === "completed" ? ["完了。", ...lines.slice(1)] : lines;
}

export { statusLabel };
