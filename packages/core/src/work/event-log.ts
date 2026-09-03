import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
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

/**
 * Append-only log of one work's events. The file is the source of truth.
 *
 * Every line is checked on open and on read; a line that cannot be read stops
 * the reader. Every event is checked on append by reading its own line back
 * before it is written, so what is written can always be read. A change to the
 * file by someone else between two operations of this instance is refused.
 */
export class EventLog {
  private constructor(
    private readonly path: string,
    private readonly workId: WorkId,
    private nextSeq: number,
    private size: number,
  ) {}

  /** Opens (creating the directory if needed) and checks the existing log end to end. */
  static async open(dir: string, workId: WorkId): Promise<EventLog> {
    await mkdir(dir, { recursive: true });
    const path = join(dir, EVENTS_FILE_NAME);
    const { events, size } = await readAll(path, workId);
    const last = events.at(-1);
    return new EventLog(path, workId, (last?.seq ?? 0) + 1, size);
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

    const line = `${JSON.stringify(eventToFile(event))}\n`;
    try {
      eventFromFile(JSON.parse(line));
    } catch (cause) {
      throw new OpenshainError(
        "invalid_event",
        `${input.type} event cannot be read back once written: ${(cause as Error).message}`,
        { cause },
      );
    }

    const current = await fileSize(this.path);
    if (current !== this.size) {
      throw new OpenshainError(
        "concurrent_write",
        `${this.path} changed since it was opened (expected ${this.size} bytes, found ${current}); another writer is active`,
      );
    }
    await appendFile(this.path, line, "utf8");
    this.size += Buffer.byteLength(line, "utf8");
    this.nextSeq += 1;
    return event;
  }

  async read(): Promise<AnyEvent[]> {
    return (await readAll(this.path, this.workId)).events;
  }
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

async function readAll(
  path: string,
  workId: WorkId,
): Promise<{ events: AnyEvent[]; size: number }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { events: [], size: 0 };
    throw err;
  }
  const corrupt = (detail: string, cause?: unknown) =>
    new OpenshainError("corrupt_log", `${path}: ${detail}`, { cause });

  if (text.length > 0 && !text.endsWith("\n")) {
    throw corrupt("does not end with a newline; the last write did not complete");
  }

  const events: AnyEvent[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    const lineNo = index + 1;
    if (line === "") {
      if (index === lines.length - 1) return; // trailing newline
      throw corrupt(`line ${lineNo} is empty`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (cause) {
      throw corrupt(`line ${lineNo} is not valid JSON`, cause);
    }
    let event: AnyEvent;
    try {
      event = eventFromFile(parsed);
    } catch (cause) {
      throw corrupt(`line ${lineNo} is not a valid event: ${(cause as Error).message}`, cause);
    }
    if (event.workId !== workId) {
      throw corrupt(`line ${lineNo} belongs to ${event.workId}, expected ${workId}`);
    }
    const expectedSeq = events.length + 1;
    if (event.seq !== expectedSeq) {
      throw corrupt(`line ${lineNo} has seq ${event.seq}, expected ${expectedSeq}`);
    }
    events.push(event);
  });
  return { events, size: Buffer.byteLength(text, "utf8") };
}
