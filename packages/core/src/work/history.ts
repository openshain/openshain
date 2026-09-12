import type { AnyEvent, Event } from "./events.ts";

/** Why a client gives up on a work, as recorded in `work.failed`. */
export type FailureReason = "limit_reached" | "model_refusal" | "model_error";

/**
 * Counts the tool calls of a work the way the limits do: every call the runtime started, plus
 * every rejection that never became a call. A rejection of a started call is not a second call.
 */
export function countToolCalls(events: readonly AnyEvent[]): number {
  let count = 0;
  let started = new Set<string>();
  for (const event of events) {
    if (event.type === "model.completed") started = new Set();
    else if (event.type === "tool.called") {
      started.add((event as Event<"tool.called">).payload.callId);
      count += 1;
    } else if (event.type === "tool.rejected") {
      if (!started.has((event as Event<"tool.rejected">).payload.callId)) count += 1;
    }
  }
  return count;
}

export interface PendingQuestion {
  callId: string;
  question: string;
}

/**
 * The questions of the work that have no answer yet, oldest first. Call ids of questions are
 * minted by the runtime, so the whole log is searched: a client recording its own model turns
 * must not hide a question.
 */
export function pendingQuestions(events: readonly AnyEvent[]): PendingQuestion[] {
  const answered = new Set(
    events
      .filter((e): e is Event<"human.input_provided"> => e.type === "human.input_provided")
      .map((e) => e.payload.callId),
  );
  return events
    .filter((e): e is Event<"human.input_requested"> => e.type === "human.input_requested")
    .filter((e) => !answered.has(e.payload.callId))
    .map((e) => ({ callId: e.payload.callId, question: e.payload.question }));
}

export interface PendingApproval {
  approvalId: string;
  call: { callId: string; name: string; input: unknown };
  /** Where the call led when the rule judged it, for the run to check against. */
  judgedPath?: string;
  /** What that file held when the rule judged it, for the run to check against. */
  base?: string | null;
  ruleId: string;
  kind: "approval" | "review";
  approvers?: string[];
  reviewer?: { role: string; name?: string };
}

/** The approvals of the work that have no decision yet, oldest first. */
export function pendingApprovals(events: readonly AnyEvent[]): PendingApproval[] {
  const decided = new Set(
    events
      .filter((e): e is Event<"approval.decided"> => e.type === "approval.decided")
      .map((e) => e.payload.approvalId),
  );
  return events
    .filter((e): e is Event<"approval.requested"> => e.type === "approval.requested")
    .filter((e) => !decided.has(e.payload.approvalId))
    .map((e) => ({ ...e.payload }));
}

export interface HistoryCall {
  callId: string;
  name: string;
  /** The path the call named, when its input had one. */
  path?: string;
  /** Present once the call has a result; absent while it is still open. */
  isError?: boolean;
  rejected?: string;
}

export interface WorkHistory {
  calls: HistoryCall[];
  /** Calls that were started but have no result: the work stopped while they ran. */
  unfinished: HistoryCall[];
  pending: PendingQuestion[];
  /** Calls held for approval that nobody has decided on yet. */
  approvals: PendingApproval[];
  toolCalls: number;
  /** Model calls recorded on the work, for a client that counts them against a limit. */
  modelCalls: number;
}

/** What a client needs to pick a work up where it stopped. Built from the log alone. */
export function workHistory(events: readonly AnyEvent[]): WorkHistory {
  const calls: HistoryCall[] = [];
  const byId = new Map<string, HistoryCall>();
  for (const event of events) {
    if (event.type === "tool.called") {
      const { callId, name, input } = (event as Event<"tool.called">).payload;
      const path = (input as { path?: unknown } | null)?.path;
      const call: HistoryCall = { callId, name, ...(typeof path === "string" && { path }) };
      calls.push(call);
      byId.set(callId, call);
    } else if (event.type === "tool.completed") {
      const { callId, isError } = (event as Event<"tool.completed">).payload;
      const call = byId.get(callId);
      if (call) call.isError = isError;
    } else if (event.type === "tool.rejected") {
      const { callId, name, code } = (event as Event<"tool.rejected">).payload;
      const call = byId.get(callId);
      if (call) call.rejected = code;
      else calls.push({ callId, name, rejected: code });
    }
  }
  return {
    calls,
    unfinished: calls.filter((c) => c.isError === undefined && c.rejected === undefined),
    pending: pendingQuestions(events),
    approvals: pendingApprovals(events),
    toolCalls: countToolCalls(events),
    modelCalls: events.filter((e) => e.type === "model.requested").length,
  };
}

/**
 * The files this work has looked at or written, as the paths the calls named. A work that has
 * neither read nor written a file has no business replacing it: what is in there now came from
 * somewhere else, and nobody in this work has seen it.
 */
export function filesKnown(events: readonly AnyEvent[]): Set<string> {
  const known = new Set<string>();
  for (const event of events) {
    if (event.type !== "tool.completed") continue;
    const { observation, after } = (event as Event<"tool.completed">).payload;
    for (const seen of observation ?? []) known.add(seen.source);
    for (const wrote of after ?? []) known.add(wrote.path);
  }
  return known;
}
