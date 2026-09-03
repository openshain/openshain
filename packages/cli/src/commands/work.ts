import { type AnyEvent, type Event, parseWorkId, type Work, WorkStore } from "@openshain/core";
import { formatUsage, summarizeUsage } from "../usage.ts";
import { nextActor } from "./run.ts";

export interface WorkListOptions {
  workspaceRoot: string;
  write: (line: string) => void;
}

/** One line per work, oldest first. Works that cannot be read are reported, not hidden. */
export async function workList({ workspaceRoot, write }: WorkListOptions): Promise<void> {
  const { works, problems } = await new WorkStore(workspaceRoot).list();
  if (works.length === 0 && problems.length === 0) {
    write('Work はまだありません。openshain run "<依頼>" で始められます。');
    return;
  }
  for (const work of works) {
    write(
      `${work.id}  ${work.status.padEnd(16)}  ${work.createdAt.slice(0, 16)}  ${shorten(work.objective)}`,
    );
  }
  for (const { id, error } of problems) write(`${id}  読めない(${error.code})  ${error.message}`);
}

export interface WorkShowOptions {
  workspaceRoot: string;
  id: string;
  write: (line: string) => void;
}

/** Everything about one work: state, outcome, what the tools did, the usage, and who acts next. */
export async function workShow({ workspaceRoot, id, write }: WorkShowOptions): Promise<void> {
  const store = new WorkStore(workspaceRoot);
  const workId = parseWorkId(id);
  const work = await store.get(workId);
  const events = await store.events(workId);
  for (const line of describeWork(work, events)) write(line);
}

export function describeWork(work: Work, events: AnyEvent[]): string[] {
  const lines = [
    `${work.id}`,
    `状態      ${work.status}`,
    `依頼      ${work.objective}`,
    `作成      ${work.createdAt}`,
  ];
  if (work.startedAt) lines.push(`開始      ${work.startedAt}`);
  if (work.completedAt) lines.push(`終了      ${work.completedAt}`);
  if (work.outcome) {
    lines.push(`結果      ${work.outcome.summary}`);
    for (const artifact of work.outcome.artifacts)
      lines.push(`  書き込み ${artifact.path}  ${artifact.sha256.slice(0, 12)}`);
  }
  if (work.failure) lines.push(`失敗      ${work.failure.reason}。${work.failure.detail}`);
  const pending = pendingQuestion(events);
  if (work.status === "waiting_input" && pending) lines.push(`質問      ${pending}`);

  const calls = events.filter((e): e is Event<"tool.called"> => e.type === "tool.called");
  if (calls.length > 0) {
    lines.push("Tool");
    for (const call of calls)
      lines.push(`  ${call.payload.name} ${describeInput(call.payload.input)}`.trimEnd());
  }
  lines.push(formatUsage(summarizeUsage(events)));
  lines.push(nextActor(work));
  return lines;
}

function pendingQuestion(events: AnyEvent[]): string | undefined {
  const answered = new Set(
    events
      .filter((e): e is Event<"human.input_provided"> => e.type === "human.input_provided")
      .map((e) => e.payload.callId),
  );
  return events
    .filter((e): e is Event<"human.input_requested"> => e.type === "human.input_requested")
    .filter((e) => !answered.has(e.payload.callId))
    .at(-1)?.payload.question;
}

function describeInput(input: unknown): string {
  if (input && typeof input === "object" && "path" in input)
    return String((input as { path: unknown }).path);
  return "";
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine;
}
