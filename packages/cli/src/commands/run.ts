import { runWork } from "@openshain/agent";
import {
  type AnyEvent,
  createRuntime,
  type Event,
  type RuntimeProviders,
  type Work,
} from "@openshain/core";
import { formatUsage, summarizeUsage } from "../usage.ts";

export interface RunOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
  objective: string;
  write: (line: string) => void;
  ask: (question: string) => Promise<string>;
}

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

  const done = await runWork(runtime, work.id, {
    onInput: options.ask,
    onEvent: (event) => {
      const line = describe(event);
      if (line) options.write(line);
    },
  });
  const events = await runtime.works.events(work.id);
  for (const line of report(done, events)) options.write(line);
  return done.status === "completed" ? 0 : 1;
}

function describe(event: AnyEvent): string | undefined {
  switch (event.type) {
    case "tool.called": {
      const { name, input } = (event as Event<"tool.called">).payload;
      return `${name} ${describeInput(input)}`.trimEnd();
    }
    case "tool.rejected": {
      const { name, reason } = (event as Event<"tool.rejected">).payload;
      return `${name} は拒否されました。${reason}`;
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
  const text = JSON.stringify(input) ?? "";
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
    case "failed":
      lines.push(
        `失敗(${work.failure?.reason ?? "unknown"})。${work.failure?.detail ?? ""}`.trimEnd(),
      );
      break;
    case "waiting_input":
      lines.push("利用者の入力を待っています。");
      break;
    default:
      lines.push(`状態は ${work.status} です。`);
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
      return "次は利用者の番です。質問に答えると続きます。";
    case "waiting_approval":
      return "次は利用者の番です。承認が要ります。";
    case "failed":
      return "次は利用者の番です。原因を直して、もう一度依頼してください。";
    default:
      return "次は model の番です。";
  }
}
