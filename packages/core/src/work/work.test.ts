import { describe, expect, test } from "bun:test";
import { OpenshainError } from "../errors.ts";
import { newEventId, newWorkId } from "../ids.ts";
import type { AnyEvent, Event, EventPayloads, EventType } from "./events.ts";
import { reduceWork, transition, workToFile } from "./work.ts";

const workId = newWorkId();

function event<T extends EventType>(
  seq: number,
  type: T,
  payload: EventPayloads[T],
  occurredAt = `2026-09-10T01:00:${String(seq).padStart(2, "0")}.000Z`,
): Event<T> {
  return {
    v: 1,
    id: newEventId(),
    workId,
    seq,
    type,
    occurredAt,
    recordedAt: occurredAt,
    payload,
  } as Event<T>;
}

const created = event(1, "work.created", {
  objective: "集計して",
  principal: "alice",
  profession: "generic",
  type: "request",
});
const started = event(2, "work.status_changed", {
  from: "queued",
  to: "in_progress",
  reason: "run",
});

describe("transition", () => {
  test.each([
    ["queued", "in_progress"],
    ["queued", "cancelled"],
    ["in_progress", "waiting_input"],
    ["in_progress", "waiting_approval"],
    ["in_progress", "waiting_external"],
    ["in_progress", "completed"],
    ["in_progress", "failed"],
    ["in_progress", "cancelled"],
    ["waiting_input", "in_progress"],
    ["waiting_input", "cancelled"],
    ["waiting_approval", "in_progress"],
    ["waiting_external", "in_progress"],
  ] as const)("allows %s -> %s", (from, to) => {
    expect(() => transition(from, to)).not.toThrow();
  });

  test.each([
    ["queued", "completed"],
    ["queued", "waiting_input"],
    ["completed", "in_progress"],
    ["failed", "in_progress"],
    ["cancelled", "queued"],
    ["waiting_input", "completed"],
    ["in_progress", "queued"],
  ] as const)("rejects %s -> %s", (from, to) => {
    expect(() => transition(from, to)).toThrow(OpenshainError);
    try {
      transition(from, to);
    } catch (err) {
      expect((err as OpenshainError).code).toBe("invalid_transition");
    }
  });
});

describe("reduceWork", () => {
  test("a created work is queued with the request details", () => {
    expect(reduceWork([created])).toEqual({
      id: workId,
      principal: "alice",
      profession: "generic",
      type: "request",
      objective: "集計して",
      status: "queued",
      createdAt: created.occurredAt,
    });
  });

  test("records start and completion times and the outcome", () => {
    const work = reduceWork([
      created,
      started,
      event(3, "evidence.recorded", {
        claim: "summary.md を作成",
        refs: ["evt_x"],
        artifacts: [{ path: "summary.md", sha256: "abc" }],
      }),
      event(4, "work.completed", { summary: "3 か月分を集計" }),
    ]);

    expect(work.status).toBe("completed");
    expect(work.startedAt).toBe("2026-09-10T01:00:02.000Z");
    expect(work.completedAt).toBe("2026-09-10T01:00:04.000Z");
    expect(work.outcome).toEqual({
      summary: "3 か月分を集計",
      artifacts: [{ path: "summary.md", sha256: "abc" }],
    });
  });

  test("keeps the first start time when work resumes after waiting", () => {
    const work = reduceWork([
      created,
      started,
      event(3, "work.status_changed", { from: "in_progress", to: "waiting_input", reason: "ask" }),
      event(4, "work.status_changed", { from: "waiting_input", to: "in_progress", reason: "ok" }),
    ]);

    expect(work.status).toBe("in_progress");
    expect(work.startedAt).toBe("2026-09-10T01:00:02.000Z");
    expect(work.completedAt).toBeUndefined();
  });

  test("a failed work carries the reason and detail", () => {
    const work = reduceWork([
      created,
      started,
      event(3, "work.failed", { reason: "limit_reached", detail: "30 model calls" }),
    ]);

    expect(work.status).toBe("failed");
    expect(work.failure).toEqual({ reason: "limit_reached", detail: "30 model calls" });
    expect(work.completedAt).toBe("2026-09-10T01:00:03.000Z");
  });

  test("ignores events that do not change the work state", () => {
    const unknown: AnyEvent = {
      ...event(4, "work.completed", { summary: "x" }),
      type: "plugin.custom",
      payload: {},
    };
    const work = reduceWork([
      created,
      started,
      event(3, "tool.called", { callId: "c", provider: "standard", name: "fs_read", input: {} }),
      unknown,
    ]);

    expect(work.status).toBe("in_progress");
  });

  test("rejects a log whose first event is not work.created", () => {
    expect(() => reduceWork([event(1, "work.completed", { summary: "x" })])).toThrow(
      OpenshainError,
    );
    expect(() => reduceWork([])).toThrow(OpenshainError);
  });

  test("rejects a log with an impossible status change", () => {
    expect(() =>
      reduceWork([created, event(2, "work.completed", { summary: "never started" })]),
    ).toThrow(OpenshainError);
  });
});

describe("workToFile", () => {
  test("writes snake_case keys and omits absent optional fields", () => {
    const file = workToFile(reduceWork([created])) as Record<string, unknown>;

    expect(Object.keys(file)).toEqual([
      "id",
      "principal",
      "profession",
      "type",
      "objective",
      "status",
      "created_at",
    ]);
  });

  test("includes outcome, times and failure when present", () => {
    const completed = workToFile(
      reduceWork([
        created,
        started,
        event(3, "evidence.recorded", { claim: "c", refs: [], artifacts: [] }),
        event(4, "work.completed", { summary: "done" }),
      ]),
    ) as Record<string, unknown>;
    const failed = workToFile(
      reduceWork([
        created,
        started,
        event(3, "work.failed", { reason: "model_error", detail: "boom" }),
      ]),
    ) as Record<string, unknown>;

    expect(completed.started_at).toBe("2026-09-10T01:00:02.000Z");
    expect(completed.completed_at).toBe("2026-09-10T01:00:04.000Z");
    expect(completed.outcome).toEqual({ summary: "done", artifacts: [] });
    expect(failed.failure).toEqual({ reason: "model_error", detail: "boom" });
  });
});

describe("reduceWork hardening", () => {
  test("refuses a status change that would end the work", () => {
    expect(() =>
      reduceWork([
        created,
        started,
        event(3, "work.status_changed", {
          from: "in_progress",
          to: "completed",
          reason: "shortcut",
        }),
      ]),
    ).toThrow(/work\.completed/);
    expect(() =>
      reduceWork([
        created,
        started,
        event(3, "work.status_changed", { from: "in_progress", to: "failed", reason: "shortcut" }),
      ]),
    ).toThrow(/work\.failed/);
  });

  test("refuses a status change whose from does not match the work", () => {
    expect(() =>
      reduceWork([
        created,
        started,
        event(3, "work.status_changed", {
          from: "waiting_approval",
          to: "waiting_input",
          reason: "lie",
        }),
      ]),
    ).toThrow(/was waiting_approval but it was in_progress/);
  });

  test("refuses evidence recorded after the work ended", () => {
    expect(() =>
      reduceWork([
        created,
        started,
        event(3, "work.completed", { summary: "done" }),
        event(4, "evidence.recorded", { claim: "late", refs: [], artifacts: [] }),
      ]),
    ).toThrow(/after the work completed/);
  });
});
