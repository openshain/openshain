import { z } from "zod";
import { OpenshainError } from "../errors.ts";
import type { WorkId } from "../ids.ts";
import type { AnyEvent, Artifact, Event } from "./events.ts";

export const WORK_STATUSES = [
  "queued",
  "in_progress",
  "waiting_input",
  "waiting_approval",
  "waiting_external",
  "completed",
  "failed",
  "cancelled",
] as const;

export const WorkStatus = z.enum(WORK_STATUSES);
export type WorkStatus = z.infer<typeof WorkStatus>;

/**
 * The type of the work that records a conversation. Only a session opens one: its objective is a
 * label that stays out of the projection, and it is not run like other works.
 */
export const SESSION_WORK_TYPE = "session";

const allowed: Record<WorkStatus, readonly WorkStatus[]> = {
  queued: ["in_progress", "cancelled"],
  in_progress: [
    "waiting_input",
    "waiting_approval",
    "waiting_external",
    "completed",
    "failed",
    "cancelled",
  ],
  waiting_input: ["in_progress", "cancelled", "failed"],
  waiting_approval: ["in_progress", "cancelled", "failed"],
  waiting_external: ["in_progress", "cancelled", "failed"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** Throws invalid_transition unless a work may move from one status to the other. */
export function transition(from: WorkStatus, to: WorkStatus): void {
  if (!allowed[from].includes(to)) {
    throw new OpenshainError("invalid_transition", `cannot move work from ${from} to ${to}`);
  }
}

export interface Work {
  id: WorkId;
  principal: string;
  profession: string;
  type: string;
  objective: string;
  /** The work this one was started from, if any. */
  parent?: string;
  status: WorkStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  outcome?: { summary: string; artifacts: Artifact[] };
  failure?: { reason: string; detail: string };
}

/** Rebuilds the current state of a work from its event log. The log is the truth. */
export function reduceWork(events: readonly AnyEvent[]): Work {
  const first = events[0];
  if (first?.type !== "work.created") {
    throw new OpenshainError("corrupt_log", "the first event of a work must be work.created");
  }
  const created = first as Event<"work.created">;
  const work: Work = {
    id: created.workId,
    principal: created.payload.principal,
    profession: created.payload.profession,
    type: created.payload.type,
    objective: created.payload.objective,
    ...(created.payload.parent !== undefined && { parent: created.payload.parent }),
    status: "queued",
    createdAt: created.occurredAt,
  };
  let artifacts: Artifact[] = [];

  for (const event of events.slice(1)) {
    switch (event.type) {
      case "work.status_changed": {
        const { payload } = event as Event<"work.status_changed">;
        const to = WorkStatus.safeParse(payload.to);
        if (!to.success) {
          throw new OpenshainError("corrupt_log", `unknown work status "${payload.to}"`);
        }
        if (to.data === "completed" || to.data === "failed") {
          throw new OpenshainError(
            "corrupt_log",
            `work.status_changed may not move a work to ${to.data}; use work.${to.data}`,
          );
        }
        if (payload.from !== work.status) {
          throw new OpenshainError(
            "corrupt_log",
            `work.status_changed says the work was ${payload.from} but it was ${work.status}`,
          );
        }
        move(work, to.data, event.occurredAt);
        break;
      }
      case "evidence.recorded":
        if (isTerminal(work.status)) {
          throw new OpenshainError(
            "corrupt_log",
            `evidence recorded after the work ${work.status}`,
          );
        }
        artifacts = (event as Event<"evidence.recorded">).payload.artifacts;
        break;
      case "work.completed":
        move(work, "completed", event.occurredAt);
        work.outcome = { summary: (event as Event<"work.completed">).payload.summary, artifacts };
        break;
      case "work.failed": {
        const { payload } = event as Event<"work.failed">;
        move(work, "failed", event.occurredAt);
        work.failure = { reason: payload.reason, detail: payload.detail };
        break;
      }
      default:
        break;
    }
  }
  return work;
}

export function isTerminal(status: WorkStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function move(work: Work, to: WorkStatus, at: string): void {
  transition(work.status, to);
  work.status = to;
  if (to === "in_progress" && work.startedAt === undefined) work.startedAt = at;
  if (isTerminal(to)) work.completedAt = at;
}

const artifactFile = z.strictObject({
  path: z.string(),
  sha256: z.string(),
  missing: z.literal(true).optional(),
  claimed: z.literal(true).optional(),
});

/** Shape of work.json. A projection of the event log, never the source of truth. */
export const WorkFileSchema = z.strictObject({
  id: z.string(),
  principal: z.string(),
  profession: z.string(),
  type: z.string(),
  objective: z.string(),
  parent: z.string().optional(),
  status: WorkStatus,
  created_at: z.iso.datetime(),
  started_at: z.iso.datetime().optional(),
  completed_at: z.iso.datetime().optional(),
  outcome: z.strictObject({ summary: z.string(), artifacts: z.array(artifactFile) }).optional(),
  failure: z.strictObject({ reason: z.string(), detail: z.string() }).optional(),
});

export type WorkFile = z.infer<typeof WorkFileSchema>;

export function workToFile(work: Work): WorkFile {
  return {
    id: work.id,
    principal: work.principal,
    profession: work.profession,
    type: work.type,
    objective: work.objective,
    ...(work.parent !== undefined && { parent: work.parent }),
    status: work.status,
    created_at: work.createdAt,
    ...(work.startedAt !== undefined && { started_at: work.startedAt }),
    ...(work.completedAt !== undefined && { completed_at: work.completedAt }),
    ...(work.outcome && { outcome: work.outcome }),
    ...(work.failure && { failure: work.failure }),
  };
}
