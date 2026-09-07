import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AnyEvent, type Event, loadConfig, type WorkId, WorkStore } from "@openshain/core";
import { createMcpServer } from "@openshain/mcp";
import { standardTools } from "@openshain/tools";
import { connectInMemory } from "./client.ts";
import { AGENT_NAMES } from "./names.ts";
import { createSession, type SessionOptions } from "./session.ts";
import { callTools, FakeModelProvider, type FakeStep, say } from "./testing/fake-model.ts";

async function setup(steps: FakeStep[]) {
  const root = await mkdtemp(join(tmpdir(), "openshain-session-"));
  await writeFile(
    join(root, "openshain.yaml"),
    `version: 1
company:
  name: サンプル株式会社
principal:
  id: alice
  name: Alice
profession:
  id: generic
  instructions: 事務担当として働く。
model:
  provider: fake
  model: fake-1
  api_key_env: FAKE_API_KEY
tools:
  - provider: standard
limits:
  max_model_calls: 3
`,
  );
  await mkdir(join(root, "receipts"));
  await writeFile(
    join(root, "receipts", "2026-07.csv"),
    "date,amount\n2026-07-01,100\n2026-07-02,250\n",
  );
  const model = new FakeModelProvider(steps);
  const server = await createMcpServer({
    workspaceRoot: root,
    tools: { standard: () => standardTools() },
  });
  const client = await connectInMemory(server);
  const config = await loadConfig(root, { modelProviders: ["fake"] });
  const store = new WorkStore(root);
  const open = (options: Partial<SessionOptions> = {}) =>
    createSession(client, { model, config, ...options });
  return { root, model, client, config, store, open };
}

const types = (events: AnyEvent[]) => events.map((e) => e.type);
const workCreate = (id: string, objective: string) =>
  callTools({ id, name: "work_create", input: { objective } });
const workComplete = (id: string, summary: string) =>
  callTools({ id, name: "work_complete", input: { summary } });

describe("a session", () => {
  test("replies to the person, sees the runtime's tools, and is recorded as a session work", async () => {
    const { model, store, open } = await setup([say("こんにちは。何をしましょう。")]);
    const seen: [WorkId, AnyEvent][] = [];
    const session = await open({
      onEvent: (workId, e) => {
        seen.push([workId, e]);
      },
    });

    const result = await session.turn("やあ");

    expect(result).toEqual({ reply: "こんにちは。何をしましょう。" });
    const names = model.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(names).toEqual(expect.arrayContaining(["work_create", "work_complete", "fs_read"]));
    expect(names).not.toContain("work_record");
    expect(names).not.toContain("work_answer");
    expect(model.requests[0]?.system).toContain("受付");
    expect(model.requests[0]?.messages.at(-2)).toEqual({
      role: "user",
      content: [{ type: "text", text: "やあ" }],
    });
    const recorded = await store.events(session.id);
    expect(types(recorded)).toEqual([
      "work.created",
      "work.status_changed",
      "human.message",
      "model.requested",
      "model.completed",
      "usage.recorded",
    ]);
    const work = await store.get(session.id);
    expect(work.type).toBe("session");
    expect(work.agentName).toBe(session.agentName);
    expect(seen.map(([id, e]) => [id === session.id, e.type])).toEqual([
      [true, "human.message"],
      [true, "model.requested"],
      [true, "model.completed"],
      [true, "usage.recorded"],
    ]);
  });

  test("creates a work under the session, runs tools inside it, closes it, and keeps only the summary", async () => {
    const { model, store, open } = await setup([
      workCreate("c1", "7 月の合計"),
      callTools({ id: "c2", name: "csv_read", input: { path: "receipts/2026-07.csv" } }),
      workComplete("c3", "合計は 350 円です"),
      say("7 月の合計は 350 円です。"),
    ]);
    const session = await open();

    const result = await session.turn("7 月の領収書の合計は？");

    expect(result.reply).toBe("7 月の合計は 350 円です。");
    const { works } = await store.list();
    const task = works.find((w) => w.type !== "session");
    expect(task?.parent).toBe(session.id);
    expect(task?.agentName).toBe(session.agentName);
    expect(task?.status).toBe("completed");
    expect(task?.outcome?.summary).toBe("合計は 350 円です");
    const taskTypes = types(await store.events(task?.id as WorkId));
    expect(taskTypes.filter((t) => t === "tool.called")).toHaveLength(1);
    expect(taskTypes.filter((t) => t === "model.requested")).toHaveLength(2);
    expect(taskTypes.filter((t) => t === "usage.recorded")).toHaveLength(3);
    expect(taskTypes.at(-1)).toBe("work.completed");
    expect(session.currentWork()).toBeUndefined();
    const sessionTypes = types(await store.events(session.id));
    expect(sessionTypes.filter((t) => t === "model.requested")).toHaveLength(4);
    expect(sessionTypes).not.toContain("tool.called");
    // The csv_read result is folded away once the work is closed; the summary stays.
    const lastRequest = model.requests.at(-1);
    const text = JSON.stringify(lastRequest?.messages);
    expect(text).toContain("省略");
    expect(text).not.toContain("2026-07-02");
    expect(text).toContain("合計は 350 円です");
  });

  test("asks the person when a work asks a question, records the answer, and hands it to the model", async () => {
    const { model, store, open } = await setup([
      workCreate("c1", "確認"),
      callTools({ id: "c2", name: "ask_user", input: { question: "どの月ですか" } }),
      (request) => {
        const answer = JSON.stringify(request.messages.at(-2));
        expect(answer).toContain("7 月");
        return workComplete("c3", "7 月と確認");
      },
      say("7 月ですね。"),
    ]);
    const asked: [WorkId, string][] = [];
    const session = await open({
      onInput: async (workId, question) => {
        asked.push([workId, question]);
        return "7 月";
      },
    });

    const result = await session.turn("集計して");

    expect(result.reply).toBe("7 月ですね。");
    expect(asked).toEqual([[expect.stringMatching(/^work_/), "どの月ですか"]]);
    const { works } = await store.list();
    const task = works.find((w) => w.type !== "session");
    const taskTypes = types(await store.events(task?.id as WorkId));
    expect(taskTypes).toEqual(
      expect.arrayContaining(["human.input_requested", "human.input_provided", "work.completed"]),
    );
    expect(model.requests).toHaveLength(4);
  });

  test("a withdrawn question stops the turn and leaves the work waiting", async () => {
    const { store, open } = await setup([
      workCreate("c1", "確認"),
      callTools({ id: "c2", name: "ask_user", input: { question: "どの月ですか" } }),
    ]);
    const session = await open({
      onInput: () => Promise.reject(new Error("withdrawn")),
    });

    const result = await session.turn("集計して");

    expect(result.stopped).toBe("aborted");
    const { works } = await store.list();
    const task = works.find((w) => w.type !== "session");
    expect(task?.status).toBe("waiting_input");
    expect(result.work).toBe(task?.id);
    expect(session.currentWork()).toBeUndefined();
  });

  test("continues a selected work when the request fits it, and leaves it alone when it does not", async () => {
    const { store, open, config } = await setup([
      (request) => {
        expect(JSON.stringify(request.messages.at(-2))).toContain("候補の Work");
        return say("それは別件なので、その Work は続けません。");
      },
      (request) => {
        expect(JSON.stringify(request.messages.at(-2))).toContain("候補の Work");
        return callTools({
          id: "c1",
          name: "work_select",
          input: { id: request.messages.length > 0 ? stopped : "" },
        });
      },
      workComplete("c2", "続きを終えました"),
      say("続きを終えました。"),
    ]);
    const created = await store.create({
      objective: "8 月の集計",
      principal: config.principal.id,
      profession: config.profession.id,
    });
    await store.transition(created.id, "in_progress", "test");
    const stopped = created.id;
    const session = await open();

    await session.select(stopped);
    const unrelated = await session.turn("今日の天気は？");
    expect(unrelated.reply).toContain("続けません");
    expect((await store.get(stopped)).status).toBe("in_progress");
    expect(session.currentWork()).toBeUndefined();

    await session.select(stopped);
    const related = await session.turn("8 月の集計の続きをお願い");
    expect(related.reply).toBe("続きを終えました。");
    expect((await store.get(stopped)).status).toBe("completed");
    await expect(session.select(stopped)).rejects.toThrow(/completed/);
  });

  test("stops a turn that calls the model too often, and the session goes on", async () => {
    const { open } = await setup([
      ...Array.from({ length: 5 }, (_, i) =>
        callTools({ id: `c${i}`, name: "work_list", input: {} }),
      ),
      say("やっと。"),
    ]);
    const session = await open();

    const first = await session.turn("何度も調べて");
    expect(first.stopped).toBe("turn_limit");

    const second = await session.turn("もう一度");
    expect(second.reply).toBe("やっと。");
  });

  test("fails a work that used more model calls than the limit allows", async () => {
    const { store, open } = await setup([
      workCreate("c1", "長い作業"),
      callTools({ id: "c2", name: "work_list", input: {} }),
      callTools({ id: "c3", name: "work_list", input: {} }),
      callTools({ id: "c4", name: "work_list", input: {} }),
      callTools({ id: "c5", name: "work_list", input: {} }),
    ]);
    const session = await open();

    const result = await session.turn("やって");

    expect(result.stopped).toBe("turn_limit");
    const { works } = await store.list();
    const task = works.find((w) => w.type !== "session");
    expect(task?.status).toBe("failed");
    expect(task?.failure?.reason).toBe("limit_reached");
  });

  test("picks a name from the list, records it, and avoids the ones open sessions use", async () => {
    const { store, open } = await setup([]);
    const first = await open();
    const second = await open();

    expect(AGENT_NAMES.ja).toContain(first.agentName);
    expect(second.agentName).not.toBe(first.agentName);
    expect((await store.get(first.id)).agentName).toBe(first.agentName);
    const named = await open({ agentName: "みなと" });
    expect(named.agentName).toBe("みなと");
  });

  test("close ends the conversation and leaves an unfinished work in progress", async () => {
    const { store, open } = await setup([workCreate("c1", "途中"), say("始めました。")]);
    const session = await open();
    const started = await session.turn("始めて");
    const taskId = started.work as WorkId;

    const closed = await session.close();

    expect(closed.status).toBe("completed");
    expect(closed.outcome?.summary).toBe("会話を終了");
    expect((await store.get(taskId)).status).toBe("in_progress");
    const events = await store.events(session.id);
    expect((events.at(-1) as Event<"work.completed">).type).toBe("work.completed");
  });
});

describe("the agent package as a client", () => {
  test("reaches the runtime only through the MCP client: no store or registry imports", async () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const offenders: string[] = [];
    for (const name of await readdir(dir, { recursive: true })) {
      if (!/\.tsx?$/.test(name) || /\.test\.tsx?$/.test(name)) continue;
      const text = await readFile(join(dir, name), "utf8");
      if (
        /\b(Runtime|WorkHandle|WorkStore|ToolRegistry|createRuntime|createToolCaller|createToolRegistry)\b/.test(
          text,
        )
      ) {
        offenders.push(name);
      }
    }
    expect(offenders).toEqual(["loop.ts"]);
  });
});
