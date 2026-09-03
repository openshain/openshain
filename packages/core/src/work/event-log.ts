import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import { newEventId, type WorkId } from "../ids.ts";
import {
  type AnyEvent,
  type Event,
  type EventPayloads,
  type EventType,
  eventFromFile,
  eventToFile,
} from "./events.ts";

export const EVENTS_FILE_NAME = "events.jsonl";

export interface NewEvent<T extends EventType = EventType> {
  type: T;
  payload: EventPayloads[T];
  /** When the thing happened. Defaults to the time of recording. */
  occurredAt?: string;
}

/** Append-only log of one work's events. The file is the source of truth. */
export class EventLog {
  private constructor(
    private readonly path: string,
    private readonly workId: WorkId,
    private nextSeq: number,
  ) {}

  /** Opens (creating the directory if needed) and checks the existing log end to end. */
  static async open(dir: string, workId: WorkId): Promise<EventLog> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, EVENTS_FILE_NAME);
    const existing = await readAll(path, workId);
    const last = existing.at(-1);
    return new EventLog(path, workId, (last?.seq ?? 0) + 1);
  }

  async append<T extends EventType>(input: NewEvent<T>): Promise<Event<T>> {
    const now = new Date().toISOString();
    const event = {
      v: 1 as const,
      id: newEventId(),
      workId: this.workId,
      seq: this.nextSeq,
      type: input.type,
      occurredAt: input.occurredAt ?? now,
      recordedAt: now,
      payload: input.payload,
    } as Event<T>;
    await appendFile(this.path, `${JSON.stringify(eventToFile(event))}\n`, "utf8");
    this.nextSeq += 1;
    return event;
  }

  read(): Promise<AnyEvent[]> {
    return readAll(this.path, this.workId);
  }
}

async function readAll(path: string, workId: WorkId): Promise<AnyEvent[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const events: AnyEvent[] = [];
  const lines = text.split("\n");
  const corrupt = (lineNo: number, detail: string, cause?: unknown) =>
    new OpenshainError("corrupt_log", `${path}: line ${lineNo} ${detail}`, { cause });

  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (line === "") {
      if (index === lines.length - 1) return; // trailing newline
      throw corrupt(lineNo, "is empty");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      throw corrupt(lineNo, "is not valid JSON", cause);
    }
    let event: AnyEvent;
    try {
      event = eventFromFile(parsed);
    } catch (cause) {
      throw corrupt(lineNo, `is not a valid event: ${(cause as Error).message}`, cause);
    }
    if (event.workId !== workId) {
      throw corrupt(lineNo, `belongs to ${event.workId}, expected ${workId}`);
    }
    const expectedSeq = events.length + 1;
    if (event.seq !== expectedSeq) {
      throw corrupt(lineNo, `has seq ${event.seq}, expected ${expectedSeq}`);
    }
    events.push(event);
  });
  return events;
}
