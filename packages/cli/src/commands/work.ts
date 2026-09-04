import {
  type AnyEvent,
  createRuntime,
  type Event,
  isTerminal,
  parseWorkId,
  type RuntimeProviders,
  type Work,
  WorkStore,
} from "@openshain/core";
import { failureLabel, statusLabel } from "../labels.ts";
import { formatUsage, summarizeUsage } from "../usage.ts";
import { type DriveOptions, drive, nextActor, pendingQuestions } from "./run.ts";

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
    `状態      ${statusLabel(work.status)}(${work.status})`,
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
  if (work.failure) {
    lines.push(`失敗      ${failureLabel(work.failure.reason)}。${work.failure.detail}`);
  }
  if (work.status === "waiting_input") {
    for (const question of pendingQuestions(events)) lines.push(`質問      ${question}`);
  }

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

export interface WorkResumeOptions extends DriveOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
  id: string;
}

/** Continues a work that stopped before its end, answering its questions when the caller can. */
export async function workResume(options: WorkResumeOptions): Promise<number> {
  const runtime = await createRuntime({
    workspaceRoot: options.workspaceRoot,
    providers: options.providers,
  });
  const workId = parseWorkId(options.id);
  const work = await runtime.works.get(workId);
  if (isTerminal(work.status)) {
    options.write(`${work.id} は${statusLabel(work.status)}です。再開できません。`);
    return 1;
  }
  options.write(`${work.id} を再開`);
  return drive(runtime, workId, options);
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
