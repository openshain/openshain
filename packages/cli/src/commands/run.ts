import { pendingQuestions, runWork } from "@openshain/agent";
import {
  type AnyEvent,
  createRuntime,
  type Event,
  type Runtime,
  type RuntimeProviders,
  type ToolContent,
  type Work,
  type WorkId,
} from "@openshain/core";
import { describeInput, truncate } from "../format.ts";
import { failureLabel, rejectionLabel, statusLabel } from "../labels.ts";
import { formatUsage, summarizeUsage } from "../usage.ts";

export interface DriveOptions {
  write: (line: string) => void;
  /** Answers the model's questions. Without it, a question leaves the work waiting and the run ends. */
  ask?: (question: string) => Promise<string>;
  /** Stops the run. The work stays where it is and can be resumed. */
  signal?: AbortSignal;
}

export interface RunOptions extends DriveOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
  objective: string;
}

/** Creates a work for the request and drives it. Exit code 0 when the work completed. */
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
  return drive(runtime, work.id, options);
}

/** Drives a work from its current state, printing one line per tool call, and closes with the report. */
export async function drive(
  runtime: Runtime,
  workId: WorkId,
  options: DriveOptions,
): Promise<number> {
  const names = new Map<string, string>();
  const done = await runWork(runtime, workId, {
    ...(options.ask && { onInput: options.ask }),
    ...(options.signal && { signal: options.signal }),
    onEvent: (event) => {
      const line = progressLine(event, names);
      if (line) options.write(line);
    },
  });
  const events = await runtime.works.events(workId);
  for (const line of report(done, events)) options.write(line);
  return done.status === "completed" ? 0 : 1;
}

/** One line for a tool call, a rejection or a failure; nothing for the other events. `names` maps call ids to tool names. */
export function progressLine(event: AnyEvent, names: Map<string, string>): string | undefined {
  switch (event.type) {
    case "tool.called": {
      const { callId, name, input } = (event as Event<"tool.called">).payload;
      names.set(callId, name);
      return `${name} ${describeInput(input)}`.trimEnd();
    }
    case "tool.rejected": {
      const { name, code, reason } = (event as Event<"tool.rejected">).payload;
      return `${name} は拒否されました。${rejectionLabel(code)}。${reason}`;
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

function firstLine(content: ToolContent[]): string {
  for (const part of content) {
    if (part.type === "text") return part.text.split("\n")[0] ?? "";
  }
  return "";
}

/** The closing lines: what happened, what it cost, and who acts next. */
export function report(work: Work, events: AnyEvent[]): string[] {
  const lines: string[] = [];
  switch (work.status) {
    case "completed":
      lines.push(`完了。${work.outcome?.summary ?? ""}`.trimEnd());
      for (const artifact of work.outcome?.artifacts ?? []) {
        lines.push(
          `  書き込み ${artifact.path}${artifact.missing ? "  完了時には読めなかった" : ""}${artifact.claimed ? "  エージェントの申告(この Work の Tool は書いていない)" : ""}`,
        );
      }
      break;
    case "failed":
      lines.push(
        `失敗。${failureLabel(work.failure?.reason)}。${work.failure?.detail ?? ""}`.trimEnd(),
      );
      break;
    case "waiting_input":
      lines.push("利用者の入力を待っています。");
      for (const { question } of pendingQuestions(events)) lines.push(`  質問 ${question}`);
      break;
    default:
      lines.push(`状態は ${statusLabel(work.status)} です。`);
  }
  lines.push(formatUsage(summarizeUsage(events)));
  lines.push(nextActor(work));
  return lines;
}

export function nextActor(work: Work): string {
  switch (work.status) {
    case "completed":
    case "cancelled":
      return "次に動く人はいません。";
    case "waiting_input":
      return `次は利用者の番です。openshain work resume ${work.id} で質問に答えると続きます。`;
    case "waiting_approval":
      return "次は利用者の番です。承認が要ります。";
    case "failed":
      return "次は利用者の番です。原因を修正して、もう一度依頼してください。";
    default:
      return "次は model の番です。";
  }
}
