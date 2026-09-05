import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isOpenshainError, OpenshainError } from "../errors.ts";
import { newWorkId, parseWorkId, type WorkId } from "../ids.ts";
import { EventLog, type NewEvent } from "./event-log.ts";
import type { AnyEvent, Event, EventType } from "./events.ts";
import { acquireLock, type Lock } from "./lock.ts";
import { reduceWork, transition, type Work, type WorkStatus, workToFile } from "./work.ts";

export const WORK_DIR_NAME = "work";
export const WORK_FILE_NAME = "work.json";

export interface CreateWorkInput {
  objective: string;
  principal: string;
  profession: string;
  /** Kind of work, for example "request" or "month_end_close". Defaults to "request". */
  type?: string;
  /** The work this one is started from, such as a session. */
  parent?: string;
  /** The name the model goes by in this work. */
  agentName?: string;
}

export interface ListResult {
  works: Work[];
  /** Work directories that could not be read. Reported, never hidden. */
  problems: { id: string; error: OpenshainError }[];
}

/**
 * Write access to one work. Holds the work's lock from open() until close(),
 * so there is exactly one writer at a time.
 */
export interface WorkHandle {
  readonly id: WorkId;
  current(): Promise<Work>;
  events(): Promise<AnyEvent[]>;
  append<T extends EventType>(event: NewEvent<T>): Promise<Event<T>>;
  /** Records a status change after checking it is allowed. Completion and failure go through their own events. */
  transition(to: WorkStatus, reason: string): Promise<Event<"work.status_changed">>;
  close(): Promise<void>;
}

/** Works of one workspace, stored under work/<id>/. Reads need no lock; writes go through a handle. */
export class WorkStore {
  constructor(private readonly root: string) {}

  async create(input: CreateWorkInput): Promise<Work> {
    const id = newWorkId();
    const dir = this.dir(id);
    const lock = await acquireLock(dir);
    try {
      const log = await EventLog.open(dir, id);
      await log.append({
        type: "work.created",
        payload: {
          objective: input.objective,
          principal: input.principal,
          profession: input.profession,
          type: input.type ?? "request",
          ...(input.parent !== undefined && { parent: input.parent }),
          ...(input.agentName !== undefined && { agentName: input.agentName }),
        },
      });
      return await this.snapshot(id, await log.read());
    } finally {
      await lock.release();
    }
  }

  async get(id: WorkId): Promise<Work> {
    return reduceWork(await this.events(id));
  }

  async list(): Promise<ListResult> {
    let names: string[];
    try {
      names = await readdir(join(this.root, WORK_DIR_NAME));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return { works: [], problems: [] };
      throw err;
    }
    const result: ListResult = { works: [], problems: [] };
    for (const name of names.sort()) {
      let id: WorkId;
      try {
        id = parseWorkId(name);
      } catch {
        continue; // not a work directory
      }
      try {
        result.works.push(await this.get(id));
      } catch (error) {
        if (!isOpenshainError(error)) throw error;
        result.problems.push({ id, error });
      }
    }
    return result;
  }

  async events(id: WorkId): Promise<AnyEvent[]> {
    const dir = await this.existingDir(id);
    const log = await EventLog.open(dir, id);
    return log.read();
  }

  /** Takes the work's lock. Call close() when done, or use append()/transition() for a single write. */
  async open(id: WorkId): Promise<WorkHandle> {
    const dir = await this.existingDir(id);
    const lock = await acquireLock(dir);
    let log: EventLog;
    try {
      log = await EventLog.open(dir, id);
    } catch (err) {
      await lock.release();
      throw err;
    }
    return this.handle(id, log, lock);
  }

  /** Opens, appends one event, refreshes work.json and closes. */
  async append<T extends EventType>(id: WorkId, event: NewEvent<T>): Promise<Event<T>> {
    const handle = await this.open(id);
    try {
      return await handle.append(event);
    } finally {
      await handle.close();
    }
  }

  /** Opens, records one status change and closes. */
  async transition(
    id: WorkId,
    to: WorkStatus,
    reason: string,
  ): Promise<Event<"work.status_changed">> {
    const handle = await this.open(id);
    try {
      return await handle.transition(to, reason);
    } finally {
      await handle.close();
    }
  }

  private handle(id: WorkId, log: EventLog, lock: Lock): WorkHandle {
    const store = this;
    let open = true;
    const assertOpen = () => {
      if (!open) throw new OpenshainError("lock_held", `work ${id} handle is closed`);
    };
    const handle: WorkHandle = {
      id,
      async current() {
        return reduceWork(await log.read());
      },
      events() {
        return log.read();
      },
      async append(event) {
        assertOpen();
        const appended = await log.append(event);
        await store.snapshot(id, await log.read());
        return appended;
      },
      async transition(to, reason) {
        assertOpen();
        if (to === "completed" || to === "failed") {
          throw new OpenshainError(
            "invalid_transition",
            `use work.${to} to move a work to ${to}; status changes cannot end a work`,
          );
        }
        const work = reduceWork(await log.read());
        transition(work.status, to);
        return handle.append({
          type: "work.status_changed",
          payload: { from: work.status, to, reason },
        });
      },
      async close() {
        if (!open) return;
        open = false;
        await lock.release();
      },
    };
    return handle;
  }

  private dir(id: WorkId): string {
    return join(this.root, WORK_DIR_NAME, parseWorkId(id));
  }

  private async existingDir(id: WorkId): Promise<string> {
    const dir = this.dir(id);
    try {
      await stat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new OpenshainError("not_found", `work ${id} does not exist in ${this.root}`);
      }
      throw err;
    }
    return dir;
  }

  private async snapshot(id: WorkId, events: AnyEvent[]): Promise<Work> {
    const work = reduceWork(events);
    await writeFile(
      join(this.dir(id), WORK_FILE_NAME),
      `${JSON.stringify(workToFile(work), null, 2)}\n`,
      "utf8",
    );
    return work;
  }
}
