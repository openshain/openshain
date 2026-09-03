import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";

export const LOCK_FILE_NAME = "lock";

export interface Lock {
  release(): Promise<void>;
}

/**
 * Takes the single-writer lock of a work directory. A lock left behind by a
 * process that no longer exists, or one that cannot be read, is taken over.
 */
export async function acquireLock(dir: string): Promise<Lock> {
  await mkdir(dir, { recursive: true });
  const path = join(dir, LOCK_FILE_NAME);
  const content = JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() });

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, content, { flag: "wx" });
      return lockHandle(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
    const holder = await readHolder(path);
    if (holder && isAlive(holder.pid)) {
      throw new OpenshainError(
        "lock_held",
        `${dir} is locked by process ${holder.pid} since ${holder.startedAt}`,
      );
    }
    await rm(path, { force: true });
  }
  throw new OpenshainError("lock_held", `${dir}: could not take the lock`);
}

async function readHolder(path: string): Promise<{ pid: number; startedAt: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      pid?: unknown;
      started_at?: unknown;
    };
    if (typeof parsed.pid !== "number") return undefined;
    return { pid: parsed.pid, startedAt: String(parsed.started_at ?? "unknown") };
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function lockHandle(path: string): Lock {
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      await rm(path, { force: true });
    },
  };
}
