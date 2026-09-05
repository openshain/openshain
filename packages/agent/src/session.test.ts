import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyEvent, createRuntime, type WorkId } from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { createSession, SESSION_TOOLS, type SessionOptions } from "./session.ts";
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
`,
  );
  await mkdir(join(root, "receipts"));
  await writeFile(
    join(root, "receipts", "2026-07.csv"),
    "date,amount\n2026-07-01,100\n2026-07-02,250\n",
  );
  const model = new FakeModelProvider(steps);
  const runtime = await createRuntime({
    workspaceRoot: root,
    providers: { models: { fake: () => model }, tools: { standard: () => standardTools() } },
  });
  return { root, model, runtime };
}

const types = (events: AnyEvent[]) => events.map((e) => e.type);

describe("a session", () => {
  test("replies to the person and offers the model only the session's tools", async () => {
    const { model, runtime } = await setup([say("こんにちは。何をしましょう。")]);
    const events: AnyEvent[] = [];
    const session = await createSession(runtime, { onEvent: (e) => events.push(e) });

    const result = await session.turn("やあ");

    expect(result).toEqual({ reply: "こんにちは。何をしましょう。" });
    expect(model.requests[0]?.tools?.map((t) => t.name)).toEqual(SESSION_TOOLS.map((t) => t.name));
    expect(model.requests[0]?.tools?.some((t) => t.name.startsWith("fs_"))).toBe(false);
    expect(model.requests[0]?.system).toContain("受付");
    expect(model.requests[0]?.messages.at(-2)).toEqual({
      role: "user",
      content: [{ type: "text", text: "やあ" }],
    });
    expect(types(events)).toEqual([
      "work.status_changed",
      "human.message",
      "model.requested",
      "model.completed",
      "usage.recorded",
    ]);
    const work = await runtime.works.get(session.id);
    expect(work.type).toBe("session");
    expect(work.status).toBe("in_progress");
  });

  test("runs a work for the person through work_run and reports its outcome", async () => {
    const { runtime } = await setup([
      callTools({ id: "s1", name: "work_run", input: { objective: "receipts を集計して" } }),
      callTools({ id: "c1", name: "csv_read", input: { path: "receipts/2026-07.csv" } }),
      say("合計は 350 です"),
      say("集計しました。合計は 350 円です。"),
    ]);
    const childEvents: { workId: WorkId; type: string }[] = [];
    const session = await createSession(runtime, {
      onWorkEvent: (workId, e) => childEvents.push({ workId, type: e.type }),
    });

    const result = await session.turn("領収書を集計して");

    expect(result).toEqual({ reply: "集計しました。合計は 350 円です。" });
    const { works } = await runtime.works.list();
    const child = works.find((w) => w.type === "request");
    expect(child?.parent).toBe(session.id);
    expect(child?.status).toBe("completed");
    expect(child?.outcome?.summary).toBe("合計は 350 です");
    expect(childEvents.some((e) => e.workId === child?.id && e.type === "tool.called")).toBe(true);
    const events = await runtime.works.events(session.id);
    const called = events.find((e) => e.type === "tool.called");
    expect(called?.payload).toMatchObject({ provider: "runtime", name: "work_run" });
    const done = events.find((e) => e.type === "tool.completed")?.payload as
      | { content: { value: { status: string; summary: string } }[] }
      | undefined;
    expect(done?.content[0]?.value).toMatchObject({
      status: "completed",
      summary: "合計は 350 です",
    });
  });

  test("passes a work's question to the person and the answer to the work", async () => {
    const { runtime } = await setup([
      callTools({ id: "s1", name: "work_run", input: { objective: "集計して" } }),
      callTools({ id: "c1", name: "ask_user", input: { question: "何月ですか" } }),
      say("7月分を集計しました"),
      say("7月分を集計しました。"),
    ]);
    const asked: string[] = [];
    const session = await createSession(runtime, {
      onInput: async (_workId, question) => {
        asked.push(question);
        return "7月";
      },
    });

    const result = await session.turn("集計して");

    expect(asked).toEqual(["何月ですか"]);
    expect(result.reply).toBe("7月分を集計しました。");
    const child = (await runtime.works.list()).works.find((w) => w.type === "request");
    const events = await runtime.works.events(child?.id as WorkId);
    expect(events.find((e) => e.type === "human.input_provided")?.payload).toMatchObject({
      answer: "7月",
    });
  });

  test("leaves a work the person asked to stop in progress, so it can be resumed", async () => {
    const { runtime } = await setup([
      callTools({ id: "s1", name: "work_run", input: { objective: "集計して" } }),
      callTools({ id: "c1", name: "csv_read", input: { path: "receipts/2026-07.csv" } }),
      say("never reached"),
    ]);
    const controller = new AbortController();
    const session = await createSession(runtime, {
      onWorkEvent: (_id, e) => {
        if (e.type === "tool.completed") controller.abort();
      },
    });

    const result = await session.turn("集計して", { signal: controller.signal });

    expect(result.stopped).toBe("aborted");
    const child = (await runtime.works.list()).works.find((w) => w.type === "request");
    expect(child?.status).toBe("in_progress");
    const done = (await runtime.works.events(session.id)).find((e) => e.type === "tool.completed")
      ?.payload as { content: { value: { interrupted?: string } }[] } | undefined;
    expect(done?.content[0]?.value.interrupted).toBeDefined();
  });

  test("stops a turn that calls the model too often, and the session goes on", async () => {
    const { runtime } = await setup([
      ...Array.from({ length: 6 }, (_, i) =>
        callTools({ id: `l${i}`, name: "work_list", input: {} }),
      ),
      say("やっと返事"),
    ]);
    const session = await createSession(runtime);

    const first = await session.turn("何度も確認して");
    const second = await session.turn("それで?");

    expect(first.stopped).toBe("turn_limit");
    expect(second).toEqual({ reply: "やっと返事" });
  });

  test("rejects a tool the session does not offer, and input that does not fit", async () => {
    const { runtime } = await setup([
      callTools(
        { id: "x1", name: "fs_read", input: { path: "receipts/2026-07.csv" } },
        { id: "x2", name: "work_show", input: {} },
      ),
      say("できません"),
    ]);
    const session = await createSession(runtime);

    await session.turn("ファイルを読んで");

    const rejected = (await runtime.works.events(session.id)).filter(
      (e) => e.type === "tool.rejected",
    );
    expect(rejected.map((e) => (e.payload as { code: string }).code)).toEqual([
      "unknown_tool",
      "schema_mismatch",
    ]);
  });

  test("refuses to start a work of the type that records conversations", async () => {
    const { runtime } = await setup([
      callTools({ id: "s1", name: "work_run", input: { objective: "集計して", type: "session" } }),
      say("できません"),
    ]);
    const session = await createSession(runtime);

    const result = await session.turn("集計して");

    expect(result.reply).toBe("できません");
    const done = (await runtime.works.events(session.id)).find((e) => e.type === "tool.completed");
    expect((done?.payload as { isError?: boolean } | undefined)?.isError).toBe(true);
    expect((await runtime.works.list()).works.map((w) => w.type)).toEqual(["session"]);
  });

  test("answers about earlier works from the records", async () => {
    const { runtime } = await setup([
      callTools({ id: "s1", name: "work_run", input: { objective: "集計して" } }),
      say("done"),
      say("終わりました"),
      callTools({ id: "s2", name: "work_list", input: {} }),
      say("1 件あります"),
    ]);
    const session = await createSession(runtime);
    await session.turn("集計して");

    const result = await session.turn("今までの作業は?");

    expect(result.reply).toBe("1 件あります");
    const listed = (await runtime.works.events(session.id))
      .filter((e) => e.type === "tool.completed")
      .at(-1);
    const payload = listed?.payload as
      | { content: { value: { works: { type: string }[] } }[] }
      | undefined;
    const value = payload?.content[0]?.value;
    expect(value?.works).toHaveLength(1);
    expect(value?.works[0]?.type).toBe("request");
  });

  test("close ends the conversation and keeps the record", async () => {
    const { runtime } = await setup([say("では")]);
    const session = await createSession(runtime);
    await session.turn("おわり");

    const closed = await session.close();

    expect(closed.status).toBe("completed");
    expect(closed.outcome?.summary).toBe("会話を終了");
    expect(types(await runtime.works.events(session.id)).at(-1)).toBe("work.completed");
  });
});

describe("session options", () => {
  test("a session without onInput leaves a questioning work waiting and tells the model", async () => {
    const { runtime } = await setup([
      callTools({ id: "s1", name: "work_run", input: { objective: "集計して" } }),
      callTools({ id: "c1", name: "ask_user", input: { question: "何月ですか" } }),
      say("聞いておきます"),
    ]);
    const options: SessionOptions = {};
    const session = await createSession(runtime, options);

    await session.turn("集計して");

    const child = (await runtime.works.list()).works.find((w) => w.type === "request");
    expect(child?.status).toBe("waiting_input");
    const done = (await runtime.works.events(session.id)).find((e) => e.type === "tool.completed")
      ?.payload as { content: { value: { waitingFor: string[] } }[] } | undefined;
    expect(done?.content[0]?.value.waitingFor).toEqual(["何月ですか"]);
  });
});
