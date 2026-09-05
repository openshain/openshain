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
import { statusLabel } from "../labels.ts";

export type EntryKind = "user" | "assistant" | "progress" | "notice" | "question" | "line";

export interface Entry {
  id: number;
  kind: EntryKind;
  text: string;
}

export interface ControllerState {
  /** Finished entries, in order. They never change once added. */
  settled: Entry[];
  /** What the current turn has produced so far. */
  live: Entry[];
  busy: boolean;
  /** A question a work is asking; the next line the person types answers it. */
  question?: string;
  closed: boolean;
  status: {
    company: string;
    model: string;
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
  /** Ctrl-C: stops the running work and says so; false when nothing was running. */
  interrupt(): boolean;
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
  "/resume <id>       止まった Work を続ける",
  "/tools             使える Tool",
  "/quit              終わる",
  "Ctrl-C             動いている Work を止める。何も動いていなければ終わる",
];

/** The state behind the screen: a session, the works it starts, and the lines to show. */
export async function createController(options: ControllerOptions): Promise<Controller> {
  const runtime =
    options.runtime ??
    (await createRuntime({ workspaceRoot: options.workspaceRoot, providers: options.providers }));
  const listeners = new Set<() => void>();
  let nextId = 1;
  const state: ControllerState = {
    settled: [],
    live: [],
    busy: false,
    closed: false,
    status: {
      company: runtime.config.company.name,
      model: `${runtime.config.model.provider}/${runtime.config.model.model}`,
      usage: { modelCalls: 0, inputTokens: 0, outputTokens: 0 },
    },
  };
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const push = (kind: EntryKind, text: string, where: "settled" | "live" = "live") => {
    state[where].push({ id: nextId++, kind, text });
    notify();
  };
  const settle = () => {
    state.settled.push(...state.live);
    state.live = [];
    notify();
  };

  let pendingAnswer: ((text: string) => void) | undefined;
  let aborter: AbortController | undefined;
  let lastWorkId: WorkId | undefined;
  const names = new Map<string, string>();

  const ask = (workId: WorkId, question: string): Promise<string> => {
    state.question = question;
    push("question", `${question}(${workId})`);
    return new Promise((resolve) => {
      pendingAnswer = (text) => {
        pendingAnswer = undefined;
        delete state.question;
        resolve(text);
      };
    });
  };

  const onWorkEvent = (workId: WorkId, event: AnyEvent) => {
    lastWorkId = workId;
    if (event.type === "work.status_changed") {
      state.status.work = {
        id: workId,
        status: (event as Event<"work.status_changed">).payload.to,
      };
    } else if (event.type === "work.completed" || event.type === "work.failed") {
      state.status.work = {
        id: workId,
        status: event.type === "work.completed" ? "completed" : "failed",
      };
    }
    const line = progressLine(event, names);
    if (line) push("progress", `  ${line}`);
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

  const explain = (result: TurnResult) => {
    switch (result.stopped) {
      case "turn_limit":
        return "担当が 1 回の返答でできる回数を超えたので、ここで止めました。続きを頼めます。";
      case "aborted":
        return lastWorkId
          ? `止めました。${lastWorkId} は途中のまま残っています。/resume ${lastWorkId} で続けられます。`
          : "止めました。";
      case "max_tokens":
        return "返答が長さの上限で切れました。";
      case "refusal":
        return "担当が続けられないと言っています。";
      case "model_error":
        return `model の呼び出しに失敗しました。${result.detail ?? ""}`.trim();
      default:
        return undefined;
    }
  };

  const capture = async (fn: (write: (line: string) => void) => Promise<unknown>) => {
    try {
      await fn((line) => push("line", line));
    } catch (err) {
      push("notice", err instanceof Error ? err.message : String(err));
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
    else if (name === "work" && sub === "show" && id)
      await capture((write) => workShow({ workspaceRoot: options.workspaceRoot, id, write }));
    else if (name === "resume" && id) {
      state.busy = true;
      notify();
      await capture((write) =>
        workResume({
          workspaceRoot: options.workspaceRoot,
          providers: options.providers,
          id,
          write,
          ask: (q) => ask(id as WorkId, q),
        }),
      );
      state.busy = false;
    } else {
      push("notice", `分からないコマンドです。/help で一覧が出ます。`);
    }
    settle();
  };

  async function close() {
    if (state.closed) return;
    state.closed = true;
    await session.close();
    notify();
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
      if (text === "") return;
      if (pendingAnswer) {
        push("user", text);
        pendingAnswer(text);
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
      state.busy = true;
      push("user", text);
      aborter = new AbortController();
      const result = await session.turn(text, { signal: aborter.signal });
      aborter = undefined;
      if (result.reply) push("assistant", result.reply);
      const note = explain(result);
      if (note) push("notice", note);
      state.busy = false;
      settle();
    },
    interrupt() {
      if (!aborter) return false;
      aborter.abort();
      return true;
    },
    close,
  };
}

/** Lines that close a work in the screen, the same as the CLI prints. */
export async function workReport(runtime: Runtime, workId: WorkId): Promise<string[]> {
  const work = await runtime.works.get(workId);
  const events = await runtime.works.events(workId);
  return report(work, events);
}

export { statusLabel };
