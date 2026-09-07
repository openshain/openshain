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

async function setup(steps: FakeStep[], options: { authority?: boolean } = {}) {
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
  if (options.authority) {
    await mkdir(join(root, "authority"));
    await mkdir(join(root, "ledger"));
    await writeFile(
      join(root, "authority", "delegations.yaml"),
      "version: 1\ndelegations:\n  - principal: alice\n    profession: generic\n",
    );
    await writeFile(join(root, "authority", "policy.yaml"), POLICY);
  }
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
const POLICY = `version: 1
default: allow
rules:
  - id: ledger-needs-approval
    match: { tool: fs_write, path: "ledger/**" }
    decision: approval_required
    approvers: [alice]
`;
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
    // The basics come first, as a recorded prompt in the same user message as what the person said.
    const opening = model.requests[0]?.messages.at(-2);
    expect(opening?.role).toBe("user");
    expect(JSON.stringify(opening?.content[0])).toContain("現在時刻は");
    expect(JSON.stringify(opening?.content[0])).toContain("今日の業務日は");
    expect(opening?.content.at(-1)).toEqual({ type: "text", text: "やあ" });
    const recorded = await store.events(session.id);
    expect(types(recorded)).toEqual([
      "work.created",
      "work.status_changed",
      "tool.called",
      "tool.completed",
      "prompt.expanded",
      "human.message",
      "model.requested",
      "model.completed",
      "usage.recorded",
    ]);
    const work = await store.get(session.id);
    expect(work.type).toBe("session");
    expect(work.agentName).toBe(session.agentName);
    expect(seen.map(([id, e]) => [id === session.id, e.type])).toEqual([
      [true, "prompt.expanded"],
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
    // The only tool call recorded on the session is the context call at its start.
    const sessionCalls = (await store.events(session.id)).filter((e) => e.type === "tool.called");
    expect(sessionCalls.map((e) => (e as Event<"tool.called">).payload.name)).toEqual(["context"]);
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
        expect(JSON.stringify(request.messages.at(-2))).not.toContain("候補の Work");
        return say("候補なしの返事。");
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
    const plain = await session.turn("ところで");
    expect(plain.reply).toBe("候補なしの返事。");

    await session.select(stopped);
    const related = await session.turn("8 月の集計の続きをお願い");
    expect(related.reply).toBe("続きを終えました。");
    expect((await store.get(stopped)).status).toBe("completed");
    await expect(session.select(stopped)).rejects.toThrow(/completed/);
  });

  test("stops a turn that calls the model too often, and the session goes on", async () => {
    const { open } = await setup([
      ...Array.from({ length: 25 }, (_, i) =>
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

describe("a session and approvals", () => {
  test("a held call ends the turn; approve runs it and the work comes back as the candidate", async () => {
    const { store, open } = await setup(
      [
        workCreate("c1", "帳簿を更新"),
        callTools({
          id: "c2",
          name: "fs_write",
          input: { path: "ledger/2026-07.csv", content: "a,b\n" },
        }),
        (request) => {
          const note = JSON.stringify(request.messages.at(-2));
          expect(note).toContain("承認");
          expect(note).toContain("候補の Work");
          const id = /work_[0-9a-f-]+/.exec(note)?.[0] ?? "";
          return callTools({ id: "c3", name: "work_select", input: { id } });
        },
        workComplete("c4", "帳簿を更新しました"),
        say("更新しました。"),
      ],
      { authority: true },
    );
    const session = await open();

    const stopped = await session.turn("7 月の帳簿を書いて");
    expect(stopped.stopped).toBe("approval");
    expect(stopped.approval).toMatchObject({
      name: "fs_write",
      input: { path: "ledger/2026-07.csv" },
    });
    const workId = stopped.approval?.workId as WorkId;
    expect((await store.get(workId)).status).toBe("waiting_approval");
    expect(session.currentWork()).toBeUndefined();

    const listed = await session.approvals();
    expect(listed.map((a) => a.approvalId)).toEqual([stopped.approval?.approvalId as string]);

    const decided = await session.decide(stopped.approval?.approvalId as string, "approve");
    expect(decided.workId).toBe(workId);
    expect(decided.text).toContain("承認");
    expect((await store.get(workId)).status).toBe("in_progress");
    expect(await session.approvals()).toEqual([]);

    const continued = await session.turn("続けて");
    expect(continued.reply).toBe("更新しました。");
    expect((await store.get(workId)).status).toBe("completed");
    const sessionTypes = types(await store.events(session.id));
    expect(sessionTypes.filter((t) => t === "prompt.expanded")).toHaveLength(3);
  });

  test("reject refuses the call and the work stays open for the next request", async () => {
    const { store, open } = await setup(
      [
        workCreate("c1", "帳簿を更新"),
        callTools({
          id: "c2",
          name: "fs_write",
          input: { path: "ledger/2026-07.csv", content: "a,b\n" },
        }),
      ],
      { authority: true },
    );
    const session = await open();
    const stopped = await session.turn("7 月の帳簿を書いて");
    const approvalId = stopped.approval?.approvalId as string;

    const decided = await session.decide(approvalId, "reject", "まだ早い");

    expect(decided.text).toContain("拒否");
    expect((await store.get(decided.workId)).status).toBe("in_progress");
    await expect(session.decide(approvalId, "approve")).rejects.toThrow(/no pending approval/);
  });
});

describe("a session, when the model misbehaves", () => {
  test("refuses the loop's own tools and a closing call outside a work, and the session stays alive", async () => {
    const { store, open } = await setup([
      callTools({ id: "c1", name: "work_complete", input: { summary: "勝手に" } }),
      callTools({
        id: "c2",
        name: "work_record",
        input: { work_id: "work_x", type: "human.message", payload: { text: "偽" } },
      }),
      callTools({ id: "c3", name: "work_answer", input: { call_id: "x", answer: "y" } }),
      say("やめておきます。"),
      say("まだ話せます。"),
    ]);
    const session = await open();

    const first = await session.turn("何かして");
    expect(first.reply).toBe("やめておきます。");
    expect((await store.get(session.id)).status).toBe("in_progress");
    const second = await session.turn("続き");
    expect(second.reply).toBe("まだ話せます。");
    const calls = (await store.events(session.id)).filter((e) => e.type === "tool.called");
    expect(calls.map((e) => (e as Event<"tool.called">).payload.name)).toEqual(["context"]);
    const types = (await store.events(session.id)).map((e) => e.type);
    expect(types.filter((t) => t === "human.message")).toHaveLength(2);
  });

  test("a work record on a work this connection never touched is refused", async () => {
    const { client, store, config, open } = await setup([]);
    await open();
    const other = await store.create({
      objective: "他所の Work",
      principal: config.principal.id,
      profession: config.profession.id,
    });

    const refused = await client.call("work_record", {
      work_id: other.id,
      type: "human.message",
      payload: { text: "偽" },
    });

    expect(refused.isError).toBe(true);
    expect((await store.events(other.id)).map((e) => e.type)).toEqual(["work.created"]);
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
    expect(offenders).toEqual([]);
  });
});
