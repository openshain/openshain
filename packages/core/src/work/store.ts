import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import { newWorkId, parseWorkId, type WorkId } from "../ids.ts";
import { EventLog, type NewEvent } from "./event-log.ts";
import type { AnyEvent, Event, EventType } from "./events.ts";
import { reduceWork, transition, type Work, type WorkStatus, workToFile } from "./work.ts";

export const WORK_DIR_NAME = "work";
export const WORK_FILE_NAME = "work.json";

export interface CreateWorkInput {
  objective: string;
  principal: string;
  profession: string;
  /** Kind of work, for example "request" or "month_end_close". Defaults to "request". */
  type?: string;
}

/** Works of one workspace, stored under work/<id>/. */
export class WorkStore {
  constructor(private readonly root: string) {}

  async create(input: CreateWorkInput): Promise<Work> {
    const id = newWorkId();
    const log = await EventLog.open(this.dir(id), id);
    await log.append({
      type: "work.created",
      payload: {
        objective: input.objective,
        principal: input.principal,
        profession: input.profession,
        type: input.type ?? "request",
      },
    });
    return this.snapshot(id, await log.read());
  }

  async get(id: WorkId): Promise<Work> {
    return reduceWork(await this.events(id));
  }

  async list(): Promise<Work[]> {
    let names: string[];
    try {
      names = await readdir(join(this.root, WORK_DIR_NAME));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const works: Work[] = [];
    for (const name of names.sort()) {
      let id: WorkId;
      try {
        id = parseWorkId(name);
      } catch {
        continue; // not a work directory
      }
      works.push(await this.get(id));
    }
    return works;
  }

  async events(id: WorkId): Promise<AnyEvent[]> {
    const dir = this.dir(id);
    try {
      await stat(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new OpenshainError("not_found", `work ${id} does not exist in ${this.root}`);
      }
      throw err;
    }
    const log = await EventLog.open(dir, id);
    return log.read();
  }

  /** Appends an event and refreshes work.json from the full log. */
  async append<T extends EventType>(id: WorkId, event: NewEvent<T>): Promise<Event<T>> {
    await this.events(id); // existence check
    const log = await EventLog.open(this.dir(id), id);
    const appended = await log.append(event);
    await this.snapshot(id, await log.read());
    return appended;
  }

  /** Records a status change after checking it is allowed from the current status. */
  async transition(
    id: WorkId,
    to: WorkStatus,
    reason: string,
  ): Promise<Event<"work.status_changed">> {
    const work = await this.get(id);
    transition(work.status, to);
    return this.append(id, {
      type: "work.status_changed",
      payload: { from: work.status, to, reason },
    });
  }

  private dir(id: WorkId): string {
    return join(this.root, WORK_DIR_NAME, id);
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
