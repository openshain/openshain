import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AnyEvent, type Event, loadConfig, type WorkId, WorkStore } from "@openshain/core";
import { createMcpServer } from "@openshain/mcp";
import { standardTools } from "@openshain/tools";
import { connectInMemory } from "./client.ts";
import { AGENT_NAMES } from "./names.ts";
import { createSession, type SessionOptions, TURN_LIMITS } from "./session.ts";
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

  test("the conversation's own rules reach the model as sections, after the profession's", async () => {
    const { model, open } = await setup([say("はい")]);
    const session = await open();

    await session.turn("やあ");

    const system = model.requests[0]?.system ?? "";
    expect(system.indexOf("事務担当として働く。")).toBeLessThan(system.indexOf("# 画面"));
    for (const heading of ["# 画面", "# 返答の書き方", "# 仕事の進め方", "# 承認と資格者の判断"]) {
      expect(system).toContain(heading);
    }
    // The screen draws markdown, so the prompt says what to use, not what to avoid.
    expect(system).not.toContain("Markdown の記法や絵文字は使わず");
    expect(system).toContain(
      "Tool が返した中身と、work_complete に書いた summary は人には見えない",
    );
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
  test("with a way to ask, the person decides in the turn and the work goes on", async () => {
    const { store, open, root } = await setup(
      [
        workCreate("c1", "帳簿を更新"),
        callTools({
          id: "c2",
          name: "fs_write",
          input: { path: "ledger/2026-07.csv", content: "a,b\n" },
        }),
        callTools({
          id: "c3",
          name: "fs_write",
          input: { path: "ledger/2026-08.csv", content: "c,d\n" },
        }),
        workComplete("c4", "2 か月分を書きました"),
        say("書きました。"),
      ],
      { authority: true },
    );
    const asked: string[] = [];
    const session = await open({
      onApproval: async (held) => {
        asked.push(`${held.name} ${(held.input as { path: string }).path} ${held.ruleId}`);
        // The first answer stands for the rest of the conversation, so the second call is silent.
        return { choice: "always" };
      },
    });

    const result = await session.turn("7 月と 8 月の帳簿を書いて");

    expect(result.reply).toBe("書きました。");
    expect(result.stopped).toBeUndefined();
    expect(asked).toEqual(["fs_write ledger/2026-07.csv ledger-needs-approval"]);
    expect(await readFile(join(root, "ledger", "2026-08.csv"), "utf8")).toBe("c,d\n");
    const work = (await store.list()).works.find((w) => w.type !== "session");
    expect(work?.status).toBe("completed");
    const decided = (await store.events(work?.id as WorkId)).filter(
      (e) => e.type === "approval.decided",
    );
    expect(decided).toHaveLength(2);
  });

  test("a call held beside others leaves every call with a result, so the next turn still builds", async () => {
    const { store, open } = await setup(
      [
        workCreate("c1", "帳簿"),
        callTools(
          { id: "c2", name: "fs_write", input: { path: "ledger/2026-07.csv", content: "a\n" } },
          { id: "c3", name: "fs_list", input: { path: "." } },
        ),
        say("承認が済んだので続けます。"),
      ],
      { authority: true },
    );
    const session = await open();

    const stopped = await session.turn("7 月の帳簿を書いて");
    expect(stopped.stopped).toBe("approval");

    // The sibling call got a result, so the conversation can go on.
    const next = await session.turn("ではあとで");
    expect(next.reply).toBe("承認が済んだので続けます。");
    expect((await store.get(stopped.approval?.workId as WorkId)).status).toBe("waiting_approval");
  });

  test("a turn stopped part way through leaves no call without a result", async () => {
    const controller = new AbortController();
    const many = Array.from({ length: TURN_LIMITS.toolCalls + 1 }, (_, i) => ({
      id: `t${i}`,
      name: "fs_list",
      input: { path: "." },
    }));
    const { store, open } = await setup([
      // The person interrupts while the model is answering.
      () => {
        controller.abort();
        return callTools(
          { id: "a1", name: "fs_list", input: { path: "." } },
          { id: "a2", name: "fs_list", input: { path: "." } },
        );
      },
      workCreate("c1", "一覧"),
      callTools(...many),
      say("止めました。"),
    ]);
    const session = await open();

    const aborted = await session.turn("一覧を出して", { signal: controller.signal });
    expect(aborted.stopped).toBe("aborted");

    // The next turn builds the conversation from the same log: no call is left open.
    const limited = await session.turn("では全部");
    expect(limited.stopped).toBe("turn_limit");
    expect(limited.detail).toBe(`tool calls in one turn (${TURN_LIMITS.toolCalls})`);
    const said = await session.turn("わかりました");
    expect(said.reply).toBe("止めました。");
    const events = await store.events(session.id);
    const called = events.filter((e) => e.type === "tool.called").length;
    expect(called).toBeGreaterThan(0);
  });

  test("a person who leaves the call undecided keeps the work waiting and ends the turn", async () => {
    const { store, open } = await setup(
      [
        workCreate("c1", "帳簿"),
        callTools(
          {
            id: "c2",
            name: "fs_write",
            input: { path: "ledger/2026-07.csv", content: "a\n" },
          },
          { id: "c3", name: "fs_list", input: { path: "." } },
        ),
        say("あとで続けます。"),
      ],
      { authority: true },
    );
    const session = await open({
      onApproval: async () => {
        throw new Error("the screen closed before an answer");
      },
    });

    const result = await session.turn("7 月の帳簿を書いて");

    expect(result.stopped).toBe("approval");
    const work = (await store.list()).works.find((w) => w.type !== "session");
    expect((await store.get(work?.id as WorkId)).status).toBe("waiting_approval");
    const next = await session.turn("続けて");
    expect(next.reply).toBe("あとで続けます。");
  });

  test("stops the turn on each of the model's stop reasons, including the unnamed one", async () => {
    const stopped = (stopReason: string) => ({
      message: { role: "assistant" as const, content: [{ type: "text" as const, text: "途中" }] },
      stopReason: stopReason as "max_tokens",
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const { open } = await setup([stopped("max_tokens"), stopped("refusal"), stopped("other")]);
    const session = await open();

    expect(await session.turn("長い話")).toMatchObject({ reply: "途中", stopped: "max_tokens" });
    expect(await session.turn("次")).toMatchObject({ reply: "途中", stopped: "refusal" });
    const other = await session.turn("その次");
    expect(other.stopped).toBe("model_error");
    expect(other.detail).toContain("other");
  });

  test("a decision that lands elsewhere first leaves the call held and the turn stopped", async () => {
    const { client, store, open } = await setup(
      [
        workCreate("c1", "帳簿"),
        callTools({
          id: "c2",
          name: "fs_write",
          input: { path: "ledger/2026-07.csv", content: "a\n" },
        }),
        say("書きました。"),
      ],
      { authority: true },
    );
    const session = await open({
      onApproval: async (held) => {
        // Someone approved it on another screen while this one was asking.
        await client.call("approval_decide", {
          approval_id: held.approvalId,
          decision: "approve",
        });
        return { choice: "approve" };
      },
    });

    const result = await session.turn("7 月の帳簿を書いて");

    expect(result.stopped).toBe("approval");
    expect(result.approval?.name).toBe("fs_write");
    const work = (await store.list()).works.find((w) => w.type !== "session");
    expect(
      (await store.events(work?.id as WorkId)).filter((e) => e.type === "approval.decided"),
    ).toHaveLength(1);
  });

  test("a rejected call comes back to the model as an error, and the work stays open", async () => {
    const { store, open, root } = await setup(
      [
        workCreate("c1", "帳簿を更新"),
        callTools({
          id: "c2",
          name: "fs_write",
          input: { path: "ledger/2026-07.csv", content: "a,b\n" },
        }),
        (request) => {
          const back = JSON.stringify(request.messages.at(-2));
          expect(back).toContain("refused this call");
          expect(back).toContain("先に規程を直したい");
          return say("承認されなかったので書きませんでした。");
        },
      ],
      { authority: true },
    );
    const session = await open({
      onApproval: async () => ({ choice: "reject", comment: "先に規程を直したい" }),
    });

    const result = await session.turn("7 月の帳簿を書いて");

    expect(result.reply).toBe("承認されなかったので書きませんでした。");
    expect(existsSync(join(root, "ledger", "2026-07.csv"))).toBe(false);
    const work = (await store.list()).works.find((w) => w.type !== "session");
    expect(work?.status).toBe("in_progress");
    const decided = (await store.events(work?.id as WorkId)).find(
      (e) => e.type === "approval.decided",
    );
    expect((decided as { payload: { comment?: string } }).payload.comment).toBe(
      "先に規程を直したい",
    );
  });

  test("without a way to ask, the held call ends the turn; approve runs it and the work comes back as the candidate", async () => {
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
    // context, the approval, the candidate work, and the note that closes the work.
    expect(sessionTypes.filter((t) => t === "prompt.expanded")).toHaveLength(4);
    const notes = (await store.events(session.id))
      .filter((e) => e.type === "prompt.expanded")
      .map((e) => (e as Event<"prompt.expanded">).payload.text);
    expect(notes.at(-1)).toContain("人の画面には出ない");
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
    const { store, open, model } = await setup([
      callTools({ id: "c1", name: "work_complete", input: { summary: "勝手に" } }),
      callTools({
        id: "c2",
        name: "work_record",
        input: { work_id: "work_x", type: "human.message", payload: { text: "偽" } },
      }),
      callTools({ id: "c3", name: "work_answer", input: { call_id: "x", answer: "y" } }),
      callTools({
        id: "c4",
        name: "approval_decide",
        input: { approval_id: "apr_x", decision: "approve" },
      }),
      say("やめておきます。"),
      say("まだ話せます。"),
    ]);
    const seen: AnyEvent[] = [];
    const session = await open({ onEvent: async (_id, event) => void seen.push(event) });

    const first = await session.turn("何かして");
    expect(first.reply).toBe("やめておきます。");
    // The screen is told about a refused call before its result, so no result stands on its own.
    const refused = seen.filter((e) => e.type === "tool.called" || e.type === "tool.completed");
    expect(
      refused.map(
        (e) =>
          `${(e.payload as { callId: string }).callId} ${e.type === "tool.called" ? "→" : "←"}`,
      ),
    ).toEqual(["c1 →", "c1 ←", "c2 →", "c2 ←", "c3 →", "c3 ←", "c4 →", "c4 ←"]);
    expect((await store.get(session.id)).status).toBe("in_progress");
    const second = await session.turn("続き");
    expect(second.reply).toBe("まだ話せます。");
    const calls = (await store.events(session.id)).filter((e) => e.type === "tool.called");
    expect(calls.map((e) => (e as Event<"tool.called">).payload.name)).toEqual(["context"]);
    const names = model.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(names).not.toContain("approval_decide");
    expect(names).not.toContain("review_decide");
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
