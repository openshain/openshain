import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import { newWorkId } from "../ids.ts";
import { WorkStore } from "./store.ts";

async function freshStore() {
  const root = await mkdtemp(join(tmpdir(), "openshain-store-"));
  return { root, store: new WorkStore(root) };
}

const request = { objective: "集計して", principal: "alice", profession: "generic" };

describe("WorkStore", () => {
  test("create writes the first event and a snapshot under work/<id>/", async () => {
    const { root, store } = await freshStore();

    const work = await store.create(request);

    expect(work.status).toBe("queued");
    expect(work.type).toBe("request");
    const dir = join(root, "work", work.id);
    const lines = (await readFile(join(dir, "events.jsonl"), "utf8")).trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? "").type).toBe("work.created");
    expect(JSON.parse(await readFile(join(dir, "work.json"), "utf8"))).toEqual({
      id: work.id,
      principal: "alice",
      profession: "generic",
      type: "request",
      objective: "集計して",
      status: "queued",
      created_at: work.createdAt,
    });
  });

  test("get rebuilds the work from its events", async () => {
    const { store } = await freshStore();
    const created = await store.create({ ...request, type: "month_end_close" });

    const work = await store.get(created.id);

    expect(work).toEqual(created);
    expect(work.type).toBe("month_end_close");
  });

  test("get fails with not_found for an unknown id", async () => {
    const { store } = await freshStore();

    const promise = store.get(newWorkId());

    await expect(promise).rejects.toBeInstanceOf(OpenshainError);
    await promise.catch((err: OpenshainError) => expect(err.code).toBe("not_found"));
  });

  test("list returns every work, oldest first", async () => {
    const { store } = await freshStore();
    const first = await store.create({ ...request, objective: "one" });
    const second = await store.create({ ...request, objective: "two" });

    expect((await store.list()).map((w) => w.id)).toEqual([first.id, second.id]);
  });

  test("list is empty when the work directory does not exist", async () => {
    const { store } = await freshStore();

    expect(await store.list()).toEqual([]);
  });

  test("append records an event and refreshes the snapshot", async () => {
    const { root, store } = await freshStore();
    const work = await store.create(request);

    await store.transition(work.id, "in_progress", "run");
    await store.append(work.id, {
      type: "work.failed",
      payload: { reason: "limit_reached", detail: "2 model calls" },
    });

    const current = await store.get(work.id);
    expect(current.status).toBe("failed");
    expect(current.failure).toEqual({ reason: "limit_reached", detail: "2 model calls" });
    const snapshot = JSON.parse(await readFile(join(root, "work", work.id, "work.json"), "utf8"));
    expect(snapshot.status).toBe("failed");
    expect(snapshot.completed_at).toBeDefined();
  });

  test("transition refuses an impossible move before writing anything", async () => {
    const { store } = await freshStore();
    const work = await store.create(request);

    await expect(store.transition(work.id, "completed", "skip")).rejects.toBeInstanceOf(
      OpenshainError,
    );
    expect((await store.events(work.id)).map((e) => e.type)).toEqual(["work.created"]);
  });

  test("events returns the raw log in order", async () => {
    const { store } = await freshStore();
    const work = await store.create(request);
    await store.transition(work.id, "in_progress", "run");

    expect((await store.events(work.id)).map((e) => [e.seq, e.type])).toEqual([
      [1, "work.created"],
      [2, "work.status_changed"],
    ]);
  });
});
