import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import { newWorkId, parseEventId } from "../ids.ts";
import { EventLog } from "./event-log.ts";

async function freshLog() {
  const dir = await mkdtemp(join(tmpdir(), "openshain-events-"));
  const workId = newWorkId();
  const log = await EventLog.open(join(dir, "work", workId), workId);
  return { dir, workId, log };
}

describe("EventLog", () => {
  test("starts empty and creates the directory on first append", async () => {
    const { dir, workId, log } = await freshLog();

    expect(await log.read()).toEqual([]);
    await log.append({ type: "work.completed", payload: { summary: "ok" } });

    const text = await readFile(join(dir, "work", workId, "events.jsonl"), "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n").filter(Boolean)).toHaveLength(1);
  });

  test("assigns ids, increasing seq, timestamps and v on append", async () => {
    const { workId, log } = await freshLog();

    const first = await log.append({ type: "work.completed", payload: { summary: "one" } });
    const second = await log.append({
      type: "work.failed",
      payload: { reason: "limit_reached", detail: "x" },
      occurredAt: "2026-09-10T00:00:00.000Z",
    });

    expect(first.v).toBe(1);
    expect(first.workId).toBe(workId);
    expect(parseEventId(first.id)).toBe(first.id);
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect(second.occurredAt).toBe("2026-09-10T00:00:00.000Z");
    expect(Date.parse(first.recordedAt)).toBeGreaterThanOrEqual(Date.parse(first.occurredAt));
    expect(await log.read()).toEqual([first, second]);
  });

  test("writes one snake_case JSON object per line", async () => {
    const { dir, workId, log } = await freshLog();
    await log.append({ type: "human.input_requested", payload: { question: "which month?" } });

    const [line] = (await readFile(join(dir, "work", workId, "events.jsonl"), "utf8")).split("\n");
    const parsed = JSON.parse(line ?? "");

    expect(parsed.work_id).toBe(workId);
    expect(parsed.occurred_at).toBeDefined();
    expect(parsed).not.toHaveProperty("workId");
  });

  test("continues seq after reopening an existing log", async () => {
    const { dir, workId, log } = await freshLog();
    await log.append({ type: "work.completed", payload: { summary: "a" } });
    await log.append({ type: "work.completed", payload: { summary: "b" } });

    const reopened = await EventLog.open(join(dir, "work", workId), workId);
    const third = await reopened.append({ type: "work.completed", payload: { summary: "c" } });

    expect(third.seq).toBe(3);
    expect((await reopened.read()).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("refuses to read or reopen a log with a corrupt last line", async () => {
    const { dir, workId, log } = await freshLog();
    await log.append({ type: "work.completed", payload: { summary: "a" } });
    await appendFile(join(dir, "work", workId, "events.jsonl"), '{"v":1,"id":"evt_', "utf8");

    await expect(log.read()).rejects.toBeInstanceOf(OpenshainError);
    await log.read().catch((err: OpenshainError) => {
      expect(err.code).toBe("corrupt_log");
      expect(err.message).toContain("line 2");
    });
    await expect(EventLog.open(join(dir, "work", workId), workId)).rejects.toBeInstanceOf(
      OpenshainError,
    );
  });

  test("refuses a line whose work_id belongs to another work", async () => {
    const { dir, workId, log } = await freshLog();
    const stray = await log.append({ type: "work.completed", payload: { summary: "a" } });
    const other = newWorkId();
    const line = JSON.stringify({
      v: 1,
      id: stray.id,
      work_id: other,
      seq: 2,
      type: "work.completed",
      occurred_at: stray.occurredAt,
      recorded_at: stray.recordedAt,
      payload: { summary: "b" },
    });
    await appendFile(join(dir, "work", workId, "events.jsonl"), `${line}\n`, "utf8");

    await expect(log.read()).rejects.toBeInstanceOf(OpenshainError);
  });
});
