import { describe, expect, test } from "bun:test";
import { cp, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import { acquireLock, LOCK_FILE_NAME } from "./lock.ts";

async function freshDir() {
  return mkdtemp(join(tmpdir(), "openshain-lock-"));
}

async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  await proc.exited;
  return proc.pid;
}

describe("acquireLock", () => {
  test("writes the pid and start time into the lock file", async () => {
    const dir = await freshDir();

    const lock = await acquireLock(dir);

    const file = JSON.parse(await readFile(join(dir, "lock"), "utf8"));
    expect(file.pid).toBe(process.pid);
    expect(typeof file.started_at).toBe("string");
    await lock.release();
  });

  test("refuses a second holder while the first process is alive", async () => {
    const dir = await freshDir();
    const lock = await acquireLock(dir);

    const promise = acquireLock(dir);

    await expect(promise).rejects.toBeInstanceOf(OpenshainError);
    await promise.catch((err: OpenshainError) => {
      expect(err.code).toBe("lock_held");
      expect(err.message).toContain(String(process.pid));
    });
    await lock.release();
  });

  test("release removes the file so the next holder can take it", async () => {
    const dir = await freshDir();
    const lock = await acquireLock(dir);

    await lock.release();

    await expect(stat(join(dir, "lock"))).rejects.toThrow();
    const again = await acquireLock(dir);
    await again.release();
  });

  test("takes over a lock whose process is gone", async () => {
    const dir = await freshDir();
    await writeFile(
      join(dir, "lock"),
      JSON.stringify({ pid: await deadPid(), started_at: "2026-09-10T00:00:00.000Z" }),
    );

    const lock = await acquireLock(dir);

    expect(JSON.parse(await readFile(join(dir, "lock"), "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  test("takes over a lock that was copied here from somewhere else", async () => {
    // A sync service copies the company folder while a session has a work open. The lock comes
    // along, and the process it names is the one still running back in the original folder.
    const original = await freshDir();
    const held = await acquireLock(original);
    const carried = await freshDir();
    await cp(join(original, LOCK_FILE_NAME), join(carried, LOCK_FILE_NAME));

    const taken = await acquireLock(carried);

    const holder = JSON.parse(await readFile(join(carried, LOCK_FILE_NAME), "utf8"));
    expect(holder.pid).toBe(process.pid);
    expect(holder.dir).toBe(await realpath(carried));
    await taken.release();
    await held.release();
  });

  test("a lock written before it recorded where it was taken still holds", async () => {
    // An older workspace: the file names a live process and nothing else. Nothing about it says
    // it was copied, so it is left alone.
    const dir = await freshDir();
    await writeFile(
      join(dir, LOCK_FILE_NAME),
      JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
    );

    expect(acquireLock(dir)).rejects.toBeInstanceOf(OpenshainError);
  });

  test("takes over a lock file it cannot parse", async () => {
    const dir = await freshDir();
    await writeFile(join(dir, "lock"), "garbage");

    const lock = await acquireLock(dir);

    expect(JSON.parse(await readFile(join(dir, "lock"), "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  test("release is safe to call twice", async () => {
    const dir = await freshDir();
    const lock = await acquireLock(dir);
    await lock.release();

    await expect(lock.release()).resolves.toBeUndefined();
  });
});

describe("acquireLock hardening", () => {
  test.each([0, -1, 1.5])("treats a lock recorded with pid %p as stale", async (pid) => {
    const dir = await freshDir();
    await writeFile(
      join(dir, "lock"),
      JSON.stringify({ pid, started_at: "2026-09-03T00:00:00.000Z" }),
    );

    const lock = await acquireLock(dir);

    expect(JSON.parse(await readFile(join(dir, "lock"), "utf8")).pid).toBe(process.pid);
    await lock.release();
  });

  test("release leaves a lock that another holder took over", async () => {
    const dir = await freshDir();
    const stale = await acquireLock(dir);
    await writeFile(
      join(dir, "lock"),
      JSON.stringify({ pid: 999999, started_at: "2026-09-03T00:00:00.000Z" }),
    );

    await stale.release();

    expect(JSON.parse(await readFile(join(dir, "lock"), "utf8")).pid).toBe(999999);
  });

  test("reports a work directory that is a file as an invalid path", async () => {
    const root = await freshDir();
    const fakeDir = join(root, "work_x");
    await writeFile(fakeDir, "not a directory");

    try {
      await acquireLock(fakeDir);
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(OpenshainError);
      expect((err as OpenshainError).code).toBe("invalid_path");
    }
  });
});
