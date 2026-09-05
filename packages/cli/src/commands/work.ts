import { pendingQuestions } from "@openshain/agent";
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
import { describeInput, padDisplay } from "../format.ts";
import { errorLabel, failureLabel, rejectionLabel, statusLabel } from "../labels.ts";
import { formatUsage, summarizeUsage } from "../usage.ts";
import { type DriveOptions, drive, nextActor } from "./run.ts";

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
      `${work.id}  ${padDisplay(statusLabel(work.status), 16)}  ${work.createdAt.slice(0, 16)}  ${shorten(work.objective)}`,
    );
  }
  for (const { id, error } of problems) {
    write(`${id}  読めない(${errorLabel(error.code) ?? error.code})  ${error.message}`);
  }
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
      lines.push(
        `  書き込み ${artifact.path}  ${artifact.sha256.slice(0, 12)}${artifact.missing ? "  完了時には読めなかった" : ""}${artifact.claimed ? "  Agent の申告(この Work の Tool は書いていない)" : ""}`,
      );
  }
  if (work.failure) {
    lines.push(`失敗      ${failureLabel(work.failure.reason)}。${work.failure.detail}`);
  }
  if (work.status === "waiting_input") {
    for (const { question } of pendingQuestions(events)) lines.push(`質問      ${question}`);
  }

  const calls = toolLines(events);
  if (calls.length > 0) {
    lines.push("Tool");
    for (const line of calls) lines.push(line);
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
  const workId = parseWorkId(options.id);
  const work = await new WorkStore(options.workspaceRoot).get(workId);
  if (isTerminal(work.status)) {
    options.write(`${work.id} は${statusLabel(work.status)}のため、再開できません。`);
    return 1;
  }
  const runtime = await createRuntime({
    workspaceRoot: options.workspaceRoot,
    providers: options.providers,
  });
  return drive(runtime, workId, options);
}

/** One line per tool call, in log order, with its outcome when it was rejected or failed. */
function toolLines(events: AnyEvent[]): string[] {
  const lines = new Map<string, string>();
  for (const event of events) {
    if (event.type === "tool.called") {
      const { callId, name, input } = (event as Event<"tool.called">).payload;
      lines.set(callId, `  ${name} ${describeInput(input)}`.trimEnd());
    } else if (event.type === "tool.rejected") {
      const { callId, name, code } = (event as Event<"tool.rejected">).payload;
      lines.set(callId, `${lines.get(callId) ?? `  ${name}`}  拒否(${rejectionLabel(code)})`);
    } else if (event.type === "tool.completed") {
      const { callId, isError } = (event as Event<"tool.completed">).payload;
      if (isError) lines.set(callId, `${lines.get(callId) ?? `  ${callId}`}  失敗`);
    }
  }
  return [...lines.values()];
}

function shorten(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine;
}
