import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import { newWorkId, type WorkId } from "../ids.ts";
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

  test("create records the parent when a work is started from another", async () => {
    const { root, store } = await freshStore();
    const session = await store.create({ ...request, type: "session", objective: "会話" });

    const child = await store.create({ ...request, parent: session.id });

    expect(child.parent).toBe(session.id);
    expect((await store.get(child.id)).parent).toBe(session.id);
    expect(
      JSON.parse(await readFile(join(root, "work", child.id, "work.json"), "utf8")).parent,
    ).toBe(session.id);
  });

  test("create records the agent's name, and the events and work.json both carry it", async () => {
    const { root, store } = await freshStore();

    const work = await store.create({ ...request, agentName: "みなと" });

    expect(work.agentName).toBe("みなと");
    expect((await store.get(work.id)).agentName).toBe("みなと");
    const first = (await store.events(work.id))[0];
    expect((first?.payload as { agentName?: string } | undefined)?.agentName).toBe("みなと");
    expect(
      JSON.parse(await readFile(join(root, "work", work.id, "work.json"), "utf8")).agent_name,
    ).toBe("みなと");
    expect(
      JSON.parse(
        (await readFile(join(root, "work", work.id, "events.jsonl"), "utf8")).split("\n")[0] ?? "",
      ).payload.agent_name,
    ).toBe("みなと");
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

    const { works, problems } = await store.list();
    expect(works.map((w) => w.id)).toEqual([first.id, second.id]);
    expect(problems).toEqual([]);
  });

  test("list is empty when the work directory does not exist", async () => {
    const { store } = await freshStore();

    expect(await store.list()).toEqual({ works: [], problems: [] });
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

describe("WorkStore hardening", () => {
  test("refuses an id that is not a work id, so nothing can escape work/", async () => {
    const { root, store } = await freshStore();
    const crafted = `${"../".repeat(6)}tmp/elsewhere` as WorkId;

    await expect(store.get(crafted)).rejects.toBeInstanceOf(OpenshainError);
    await store.get(crafted).catch((err: OpenshainError) => expect(err.code).toBe("invalid_id"));
    await expect(
      store.append(crafted, { type: "work.completed", payload: { summary: "x" } }),
    ).rejects.toBeInstanceOf(OpenshainError);
    await expect(stat(join(root, "work"))).rejects.toThrow();
  });

  test("list reports a broken work directory instead of failing altogether", async () => {
    const { root, store } = await freshStore();
    const healthy = await store.create(request);
    const broken = newWorkId();
    await mkdir(join(root, "work", broken), { recursive: true });
    await writeFile(join(root, "work", broken, "events.jsonl"), "not json\n");

    const { works, problems } = await store.list();

    expect(works.map((w) => w.id)).toEqual([healthy.id]);
    expect(problems.map((p) => [p.id, p.error.code])).toEqual([[broken, "corrupt_log"]]);
  });

  test("a second writer is refused while a handle is open", async () => {
    const { store } = await freshStore();
    const work = await store.create(request);
    const handle = await store.open(work.id);

    await expect(store.open(work.id)).rejects.toBeInstanceOf(OpenshainError);
    await store
      .transition(work.id, "in_progress", "run")
      .catch((err: OpenshainError) => expect(err.code).toBe("lock_held"));

    await handle.close();
    await store.transition(work.id, "in_progress", "run");
    expect((await store.get(work.id)).status).toBe("in_progress");
  });

  test("a handle appends several events under one lock and refreshes the snapshot", async () => {
    const { root, store } = await freshStore();
    const work = await store.create(request);
    const handle = await store.open(work.id);

    await handle.transition("in_progress", "run");
    await handle.append({ type: "work.completed", payload: { summary: "done" } });
    const current = await handle.current();
    await handle.close();

    expect(current.status).toBe("completed");
    const snapshot = JSON.parse(await readFile(join(root, "work", work.id, "work.json"), "utf8"));
    expect(snapshot.status).toBe("completed");
    await expect(stat(join(root, "work", work.id, "lock"))).rejects.toThrow();
  });

  test("a closed handle cannot write", async () => {
    const { store } = await freshStore();
    const work = await store.create(request);
    const handle = await store.open(work.id);
    await handle.close();

    await expect(
      handle.append({ type: "work.completed", payload: { summary: "x" } }),
    ).rejects.toBeInstanceOf(OpenshainError);
  });

  test("transition refuses to end a work; completion and failure have their own events", async () => {
    const { store } = await freshStore();
    const work = await store.create(request);
    await store.transition(work.id, "in_progress", "run");

    const promise = store.transition(work.id, "completed", "shortcut");

    await expect(promise).rejects.toBeInstanceOf(OpenshainError);
    await promise.catch((err: OpenshainError) => expect(err.code).toBe("invalid_transition"));
    expect((await store.get(work.id)).status).toBe("in_progress");
  });
});
