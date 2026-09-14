import type { AnyEvent, Event } from "./events.ts";
import { countToolCalls } from "./history.ts";
import type { Work, WorkStatus } from "./work.ts";

/**
 * What one work cost and what it asked of a person, read off its own record. Every number here
 * comes from an event that was written when the thing happened; nothing is estimated. What the
 * record does not hold is left out rather than written as zero, because zero says it did not
 * happen and the truth is that nobody knows.
 */

export interface UsageSummary {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  /** The part of inputTokens a prompt cache served. */
  cachedInputTokens: number;
  outputTokens: number;
  /** How long the tools ran, added up. */
  toolMs: number;
}

export interface WorkMeasures {
  /** Whether it finished, whether it finished without calling on anyone, and how long it took. */
  coverage: { status: WorkStatus; finished: boolean; unaided: boolean; seconds?: number };
  /** Every point where the work needed a person. */
  intervention: { clarification: number; approval: number; expertReview: number };
  /** What had to be put right, and what the rules did not let through. */
  quality: { corrected: number; stoppedByRule: number };
  cost: UsageSummary;
  /** How many times the work called on a person at all. The guardrail is that this falls. */
  attention: { calls: number };
}

/** Totals over a work's events: calls, tokens and time. */
export function summarizeUsage(events: readonly AnyEvent[]): UsageSummary {
  const summary: UsageSummary = {
    modelCalls: 0,
    toolCalls: countToolCalls(events),
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    toolMs: 0,
  };
  for (const event of events) {
    if (event.type === "model.requested") summary.modelCalls += 1;
    if (event.type !== "usage.recorded") continue;
    const { payload } = event as Event<"usage.recorded">;
    if (payload.kind === "model_inference") {
      summary.inputTokens += payload.usage.inputTokens;
      summary.cachedInputTokens += payload.usage.cachedInputTokens ?? 0;
      summary.outputTokens += payload.usage.outputTokens;
    } else {
      summary.toolMs += payload.usage.durationMs;
    }
  }
  return summary;
}

/** The five groups, for one work. */
export function measureWork(work: Work, events: readonly AnyEvent[]): WorkMeasures {
  let clarification = 0;
  let approval = 0;
  let expertReview = 0;
  let corrected = 0;
  let stoppedByRule = 0;
  for (const event of events) {
    switch (event.type) {
      case "human.input_requested":
        clarification += 1;
        break;
      case "approval.decided":
        approval += 1;
        break;
      case "review.decided": {
        expertReview += 1;
        if ((event as Event<"review.decided">).payload.decision === "modify") corrected += 1;
        break;
      }
      case "tool.rejected":
        if ((event as Event<"tool.rejected">).payload.code === "denied") stoppedByRule += 1;
        break;
      default:
        break;
    }
  }
  const calls = clarification + approval + expertReview;
  const finished = work.status === "completed";
  const took = seconds(work);
  return {
    coverage: {
      status: work.status,
      finished,
      unaided: finished && calls === 0,
      ...(took !== undefined && { seconds: took }),
    },
    intervention: { clarification, approval, expertReview },
    quality: { corrected, stoppedByRule },
    cost: summarizeUsage(events),
    attention: { calls },
  };
}

/** How long the work took, once it has both ends. */
function seconds(work: Work): number | undefined {
  const from = work.startedAt ?? work.createdAt;
  if (!work.completedAt || !from) return undefined;
  const took = Date.parse(work.completedAt) - Date.parse(from);
  return Number.isFinite(took) ? Math.round(took / 1000) : undefined;
}
