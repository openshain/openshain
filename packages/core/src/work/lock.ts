import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";

export const LOCK_FILE_NAME = "lock";

export interface Lock {
  release(): Promise<void>;
}

interface Holder {
  pid: number;
  startedAt: string;
  /** The directory the lock was taken on. Absent in a lock written before this was recorded. */
  dir?: string;
}

/**
 * Takes the single-writer lock of a work directory. A lock left behind by a
 * process that no longer exists, one that cannot be read, or one that was
 * copied here from another folder, is taken over. Release only removes the file
 * while it still records this holder.
 *
 * A lock says who holds it and where they took it. The second is what makes a
 * company folder something you can carry: a sync service copies the folder while
 * a session has a work open, the lock travels with it, and the process it names
 * is alive back where it came from. A lock that names another folder says
 * nothing about this one.
 *
 * Known limit: liveness is judged by pid. A pid reused by an unrelated process
 * keeps the lock held until that process ends or the file is removed by hand.
 */
export async function acquireLock(dir: string): Promise<Lock> {
  try {
    await mkdir(dir, { recursive: true });
  } catch (cause) {
    throw new OpenshainError("invalid_path", `cannot create the work directory ${dir}`, { cause });
  }
  const path = join(dir, LOCK_FILE_NAME);
  const here = await realpath(dir);
  const holder: Holder = { pid: process.pid, startedAt: new Date().toISOString(), dir: here };
  const content = JSON.stringify({ pid: holder.pid, started_at: holder.startedAt, dir: here });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, content, { flag: "wx" });
      return lockHandle(path, holder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new OpenshainError("invalid_path", `cannot write the lock file ${path}`, {
          cause: err,
        });
      }
    }
    const current = await readHolder(path);
    const elsewhere = current?.dir !== undefined && current.dir !== here;
    if (current && !elsewhere && isAlive(current.pid)) {
      throw new OpenshainError(
        "lock_held",
        `${dir} is locked by process ${current.pid} since ${current.startedAt}`,
      );
    }
    await rm(path, { force: true });
  }
  throw new OpenshainError("lock_held", `${dir}: could not take the lock`);
}

async function readHolder(path: string): Promise<Holder | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      pid?: unknown;
      started_at?: unknown;
      dir?: unknown;
    };
    if (typeof parsed.pid !== "number") return undefined;
    return {
      pid: parsed.pid,
      startedAt: String(parsed.started_at ?? "unknown"),
      ...(typeof parsed.dir === "string" && { dir: parsed.dir }),
    };
  } catch {
    return undefined;
  }
}

/** Only real process ids count. 0 and negatives address process groups and would always "exist". */
function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockHandle(path: string, holder: Holder): Lock {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      const current = await readHolder(path);
      if (current && (current.pid !== holder.pid || current.startedAt !== holder.startedAt)) {
        return; // someone else holds it now; not ours to remove
      }
      await rm(path, { force: true });
    },
  };
}
