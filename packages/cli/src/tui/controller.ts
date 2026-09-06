import { createSession, type Session, type TurnResult } from "@openshain/agent";
import {
  type AnyEvent,
  createRuntime,
  type Event,
  type Runtime,
  type RuntimeProviders,
  type WorkId,
} from "@openshain/core";
import { progressLine, report } from "../commands/run.ts";
import { toolsList } from "../commands/tools.ts";
import { workList, workResume, workShow } from "../commands/work.ts";
import { plain } from "../format.ts";
import { statusLabel } from "../labels.ts";
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
  /** Stops whatever is running, then ends the session. A second call waits for the same close. */
  close(): Promise<void>;
}

export interface ControllerOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
  runtime?: Runtime;
}

const HELP = [
  "/work list         Work の一覧",
  "/work show <id>    Work の詳細",
  "/work resume <id>  止まった Work を続ける",
  "/tools             使える Tool",
  "/quit              終わる",
  "↑ ↓                前に送った行を入力欄に呼び戻す。いちばん下は新しい入力",
  "← → Home End       入力欄でカーソルを動かす。Backspace と Delete はカーソルの位置で消す",
  "ホイール、PageUp/PageDown  会話を遡る。送ると最新に戻る",
  "Ctrl-C             動いている Work を止める。質問待ちなら質問を取り下げる。何も動いていなければ終わる",
];

/** What the session's model hears when the person stops a work that waits for their answer. */
const QUESTION_WITHDRAWN =
  "the person stopped the work while it waited for their answer; the question is still pending and the work can be resumed";

/** The state behind the screen: a session, the works it starts, and the lines to show. */
export async function createController(options: ControllerOptions): Promise<Controller> {
  const runtime =
    options.runtime ??
    (await createRuntime({ workspaceRoot: options.workspaceRoot, providers: options.providers }));
  const listeners = new Set<() => void>();
  let nextId = 1;
  const state: ControllerState = {
    entries: [],
    busy: false,
    closed: false,
    status: {
      company: runtime.config.company.name,
      model: `${runtime.config.model.provider}/${runtime.config.model.model}`,
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
  let aborter: AbortController | undefined;
  let running: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  /** The child work of the current turn while it is unfinished. */
  let lastWorkId: WorkId | undefined;
  const names = new Map<string, string>();

  const ask = (workId: WorkId, question: string): Promise<string> => {
    state.question = question;
    push("question", `${question}(${workId})`);
    return new Promise((resolve, reject) => {
      pending = { resolve, reject };
    });
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
    for (const line of await workReport(runtime, workId)) push("progress", line.trimStart());
  };

  const onWorkEvent = (workId: WorkId, event: AnyEvent): void | Promise<void> => {
    lastWorkId = workId;
    if (event.type === "work.status_changed") {
      state.status.work = {
        id: workId,
        status: (event as Event<"work.status_changed">).payload.to,
      };
    } else if (event.type === "work.completed" || event.type === "work.failed") {
      lastWorkId = undefined;
      state.status.work = {
        id: workId,
        status: event.type === "work.completed" ? "completed" : "failed",
      };
      return closingLines(workId);
    }
    const line = progressLine(event, names);
    if (line) push("progress", line);
    else notify();
  };

  const session: Session = await createSession(runtime, {
    onEvent: (event) => {
      if (event.type === "usage.recorded") {
        const { payload } = event as Event<"usage.recorded">;
        if (payload.kind === "model_inference") {
          state.status.usage.modelCalls += 1;
          state.status.usage.inputTokens += payload.usage.inputTokens;
          state.status.usage.outputTokens += payload.usage.outputTokens;
          notify();
        }
      }
    },
    onWorkEvent,
    onInput: ask,
  });
  state.status.agentName = session.agentName;
  for (const row of LOGO_ROWS) push("logo", row);
  push("banner", `openshain ${VERSION}`);
  push("banner", runtime.workspaceRoot);

  const stopped = (workId: string | undefined) =>
    workId
      ? `止めました。${workId} は途中のまま残っています。/work resume ${workId} で再開します。`
      : "止めました。";

  const explain = (result: TurnResult) => {
    switch (result.stopped) {
      case "turn_limit":
        return "社員エージェントが 1 回の返答でできる回数を超えたので、ここで止めました。続きは改めて依頼してください。";
      case "aborted":
        return stopped(lastWorkId);
      case "max_tokens":
        return "返答が長さの上限で切れました。";
      case "refusal":
        return "社員エージェントが続けられないと言っています。";
      case "model_error":
        return `model の呼び出しに失敗しました。${result.detail ?? ""}`.trim();
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
    else if (name === "work" && sub === "list")
      await capture((write) => workList({ workspaceRoot: options.workspaceRoot, write }));
    else if (name === "work" && (sub === "show" || sub === "resume") && !args[1])
      push("notice", `/work ${sub} には Work の id が要ります。/work list で確かめてください。`);
    else if (name === "work" && sub === "show" && id)
      await capture((write) => workShow({ workspaceRoot: options.workspaceRoot, id, write }));
    else if (name === "work" && sub === "resume" && id) {
      await stoppable(async (signal) => {
        try {
          await workResume({
            workspaceRoot: options.workspaceRoot,
            providers: options.providers,
            id,
            signal,
            write: (text) => push("line", text),
            ask: (q) => ask(id as WorkId, q),
          });
        } catch (err) {
          if (!signal.aborted) push("notice", message(err));
        }
        if (signal.aborted) push("notice", stopped(id));
      });
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
      await running;
      await session.close();
      state.closed = true;
      notify();
    })();
    return closing;
  }

  return {
    sessionId: session.id,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submit(line) {
      const text = line.trim();
      if (text === "" || closing) return;
      if (pending) {
        push("user", text);
        // Everything typed answers the question, except leaving: that takes the question back.
        if (text === "/quit" || text === "/exit") await close();
        else settleQuestion(text);
        return;
      }
      if (state.busy) {
        push("notice", "いま動いています。止めるなら Ctrl-C。");
        return;
      }
      if (text.startsWith("/")) {
        push("user", text);
        await command(text);
        return;
      }
      push("user", text);
      await stoppable(async (signal) => {
        try {
          const result = await session.turn(text, { signal });
          if (result.reply) push("assistant", result.reply);
          const note = explain(result);
          if (note) push("notice", note);
        } catch (err) {
          push("notice", message(err));
        }
      });
    },
    interrupt() {
      if (!aborter) return false;
      aborter.abort();
      settleQuestion();
      return true;
    },
    close,
  };
}

/** Lines that close a work in the screen: the CLI's closing lines without the summary, which the clerk relays. */
export async function workReport(runtime: Runtime, workId: WorkId): Promise<string[]> {
  const work = await runtime.works.get(workId);
  const events = await runtime.works.events(workId);
  const lines = report(work, events);
  return work.status === "completed" ? ["完了。", ...lines.slice(1)] : lines;
}

export { statusLabel };
