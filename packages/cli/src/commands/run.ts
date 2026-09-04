import { runWork } from "@openshain/agent";
import {
  type AnyEvent,
  createRuntime,
  type Event,
  type RuntimeProviders,
  type ToolContent,
  type Work,
} from "@openshain/core";
import { formatUsage, summarizeUsage } from "../usage.ts";

export interface RunOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
  objective: string;
  write: (line: string) => void;
  /** Answers the model's questions. Without it, a question leaves the work waiting and the run ends. */
  ask?: (question: string) => Promise<string>;
}

/** Why a work failed, in the person's words. The log keeps the original code. */
const FAILURE_LABELS: Record<string, string> = {
  limit_reached: "上限に達した",
  model_refusal: "model が拒否した",
  model_error: "model のエラー",
};

/** Why a tool call was rejected, in the person's words. */
const REJECTION_LABELS: Record<string, string> = {
  schema_mismatch: "入力が schema に合わない",
  unknown_tool: "知らない Tool",
  not_allowed: "この workspace では許可されていない",
  reserved_path: "予約されたパス",
  outside_workspace: "workspace の外",
  invalid_path: "不正なパス",
};

const STATUS_LABELS: Record<string, string> = {
  queued: "未着手",
  in_progress: "進行中",
  waiting_input: "利用者の入力待ち",
  waiting_approval: "承認待ち",
  waiting_external: "外部の応答待ち",
  completed: "完了",
  failed: "失敗",
  cancelled: "取り消し",
};

/** Creates a work for the request and drives it, printing one line per tool call. Exit code 0 when the work completed. */
export async function run(options: RunOptions): Promise<number> {
  const runtime = await createRuntime({
    workspaceRoot: options.workspaceRoot,
    providers: options.providers,
  });
  const work = await runtime.works.create({
    objective: options.objective,
    principal: runtime.config.principal.id,
    profession: runtime.config.profession.id,
  });
  options.write(`${work.id} を開始`);

  const names = new Map<string, string>();
  const done = await runWork(runtime, work.id, {
    ...(options.ask && { onInput: options.ask }),
    onEvent: (event) => {
      const line = describe(event, names);
      if (line) options.write(line);
    },
  });
  const events = await runtime.works.events(work.id);
  for (const line of report(done, events)) options.write(line);
  return done.status === "completed" ? 0 : 1;
}

/** One line for a tool call, a rejection or a failure; nothing for the other events. `names` maps call ids to tool names. */
function describe(event: AnyEvent, names: Map<string, string>): string | undefined {
  switch (event.type) {
    case "tool.called": {
      const { callId, name, input } = (event as Event<"tool.called">).payload;
      names.set(callId, name);
      return `${name} ${describeInput(input)}`.trimEnd();
    }
    case "tool.rejected": {
      const { name, code, reason } = (event as Event<"tool.rejected">).payload;
      return `${name} は拒否されました。${REJECTION_LABELS[code] ?? code}。${reason}`;
    }
    case "tool.completed": {
      const { callId, content, isError } = (event as Event<"tool.completed">).payload;
      if (!isError) return undefined;
      return `${names.get(callId) ?? callId} は失敗しました。${truncate(firstLine(content))}`;
    }
    default:
      return undefined;
  }
}

function describeInput(input: unknown): string {
  if (input && typeof input === "object") {
    if ("path" in input) return String((input as { path: unknown }).path);
    if ("question" in input) return "";
  }
  return truncate(JSON.stringify(input) ?? "");
}

function firstLine(content: ToolContent[]): string {
  for (const part of content) {
    if (part.type === "text") return part.text.split("\n")[0] ?? "";
  }
  return "";
}

function truncate(text: string): string {
  return text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

/** The closing lines: what happened, what it cost, and who acts next. */
export function report(work: Work, events: AnyEvent[]): string[] {
  const lines: string[] = [];
  switch (work.status) {
    case "completed":
      lines.push(`完了。${work.outcome?.summary ?? ""}`.trimEnd());
      for (const artifact of work.outcome?.artifacts ?? [])
        lines.push(`  書き込み ${artifact.path}`);
      break;
    case "failed": {
      const reason = work.failure?.reason;
      const label = reason ? (FAILURE_LABELS[reason] ?? reason) : "理由は不明";
      lines.push(`失敗。${label}。${work.failure?.detail ?? ""}`.trimEnd());
      break;
    }
    case "waiting_input":
      lines.push("利用者の入力を待っています。");
      for (const question of pendingQuestions(events)) lines.push(`  質問 ${question}`);
      break;
    default:
      lines.push(`状態は ${STATUS_LABELS[work.status] ?? work.status} です。`);
  }
  lines.push(formatUsage(summarizeUsage(events)));
  lines.push(nextActor(work));
  return lines;
}

/** The questions the model asked that have no answer yet. */
function pendingQuestions(events: AnyEvent[]): string[] {
  const answered = new Set(
    events
      .filter((e): e is Event<"human.input_provided"> => e.type === "human.input_provided")
      .map((e) => e.payload.callId),
  );
  return events
    .filter((e): e is Event<"human.input_requested"> => e.type === "human.input_requested")
    .filter((e) => !answered.has(e.payload.callId))
    .map((e) => e.payload.question);
}

export function nextActor(work: Work): string {
  switch (work.status) {
    case "completed":
    case "cancelled":
      return "次に動く人はいません。";
    case "waiting_input":
      return "次は利用者の番です。質問に答えると続きます。";
    case "waiting_approval":
      return "次は利用者の番です。承認が要ります。";
    case "failed":
      return "次は利用者の番です。原因を直して、もう一度依頼してください。";
    default:
      return "次は model の番です。";
  }
}
