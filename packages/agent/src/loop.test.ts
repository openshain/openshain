import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnyEvent,
  createRuntime,
  type ModelResponse,
  OpenshainError,
  type ToolProvider,
  type WorkHandle,
} from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { ASK_USER, runWork } from "./loop.ts";
import { callTools, FakeModelProvider, type FakeStep, say } from "./testing/fake-model.ts";

const configText = (extra = "") => `version: 1
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
${extra}`;

async function setup(steps: FakeStep[], extra = "") {
  const root = await mkdtemp(join(tmpdir(), "openshain-loop-"));
  await writeFile(join(root, "openshain.yaml"), configText(extra));
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
  const work = await runtime.works.create({
    objective: "receipts を集計して",
    principal: "alice",
    profession: "generic",
  });
  return { root, model, runtime, work };
}

const types = (events: AnyEvent[]) => events.map((e) => e.type);

function payloadOf<T>(event: AnyEvent | undefined): T {
  if (!event) throw new Error("expected an event");
  return event.payload as T;
}

describe("runWork", () => {
  test("reads a CSV, writes a summary and completes with artifacts hashed by the runtime", async () => {
    const { root, model, runtime, work } = await setup([
      callTools({ id: "c1", name: "csv_read", input: { path: "receipts/2026-07.csv" } }),
      callTools({
        id: "c2",
        name: "fs_write",
        input: { path: "summary.md", content: "# 合計 350\n" },
      }),
      say("summary.md に合計 350 を書きました"),
    ]);

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("completed");
    expect(done.outcome?.summary).toBe("summary.md に合計 350 を書きました");
    expect(done.outcome?.artifacts).toEqual([
      { path: "summary.md", sha256: createHash("sha256").update("# 合計 350\n").digest("hex") },
    ]);
    expect(await readFile(join(root, "summary.md"), "utf8")).toBe("# 合計 350\n");
    expect(types(await runtime.works.events(work.id))).toEqual([
      "work.created",
      "work.status_changed",
      "model.requested",
      "model.completed",
      "usage.recorded",
      "tool.called",
      "tool.completed",
      "usage.recorded",
      "model.requested",
      "model.completed",
      "usage.recorded",
      "tool.called",
      "tool.completed",
      "usage.recorded",
      "model.requested",
      "model.completed",
      "usage.recorded",
      "evidence.recorded",
      "work.completed",
    ]);
    expect(model.requests[1]?.messages.at(-2)?.content[0]).toMatchObject({
      type: "tool_result",
      callId: "c1",
    });
    expect(model.requests[0]?.system).toContain("事務担当として働く。");
    expect(model.requests[0]?.tools?.map((t) => t.name)).toContain("fs_write");
  });

  test("puts the results of several tool calls into one message", async () => {
    const { model, runtime, work } = await setup([
      callTools(
        { id: "c1", name: "fs_list", input: { path: "." } },
        { id: "c2", name: "csv_read", input: { path: "receipts/2026-07.csv" } },
      ),
      say("done"),
    ]);

    await runWork(runtime, work.id);

    const last = model.requests[1]?.messages.at(-2);
    expect(last?.role).toBe("user");
    expect(
      last?.content
        .filter((p) => p.type === "tool_result")
        .map((p) => (p as { callId: string }).callId),
    ).toEqual(["c1", "c2"]);
  });

  test("stops with limit_reached when the model calls run out", async () => {
    const { runtime, work } = await setup(
      [
        callTools({ id: "c1", name: "fs_list", input: {} }),
        callTools({ id: "c2", name: "fs_list", input: {} }),
        callTools({ id: "c3", name: "fs_list", input: {} }),
      ],
      "limits:\n  max_model_calls: 2\n",
    );

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    expect(done.failure?.reason).toBe("limit_reached");
    expect(done.failure?.detail).toContain("model");
  });

  test("stops with limit_reached when the tool calls run out", async () => {
    const { runtime, work } = await setup(
      [
        callTools(
          { id: "c1", name: "fs_list", input: {} },
          { id: "c2", name: "fs_list", input: {} },
        ),
        say("never"),
      ],
      "limits:\n  max_tool_calls: 1\n",
    );

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    expect(done.failure?.detail).toContain("tool");
    const events = await runtime.works.events(work.id);
    expect(events.filter((e) => e.type === "tool.called")).toHaveLength(1);
  });

  test("records a refusal as a failed work", async () => {
    const { runtime, work } = await setup([{ ...say("no"), stopReason: "refusal" }]);

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    expect(done.failure?.reason).toBe("model_refusal");
  });

  test("records a truncated answer and fails with limit_reached", async () => {
    const { runtime, work } = await setup([{ ...say("half of the"), stopReason: "max_tokens" }]);

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    expect(done.failure?.reason).toBe("limit_reached");
    const events = await runtime.works.events(work.id);
    const completed = events.find((e) => e.type === "model.completed");
    expect(payloadOf<{ content: { text: string }[] }>(completed).content[0]?.text).toBe(
      "half of the",
    );
  });

  test("records a provider failure as model.failed and fails the work", async () => {
    const { runtime, work } = await setup([
      () => {
        throw new Error("boom");
      },
    ]);

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    expect(done.failure?.reason).toBe("model_error");
    expect(types(await runtime.works.events(work.id))).toContain("model.failed");
  });

  test("keeps going when a tool call is rejected, showing the model the reason", async () => {
    const { model, runtime, work } = await setup([
      callTools({ id: "c1", name: "fs_read", input: { path: "../secret" } }),
      say("gave up"),
    ]);

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("completed");
    const result = model.requests[1]?.messages.at(-2)?.content[0] as {
      isError?: boolean;
      content: string;
    };
    expect(result.isError).toBe(true);
    expect(result.content).toContain("escapes");
  });

  test("passes the remaining budget to the model and records model usage", async () => {
    const { model, runtime, work } = await setup(
      [say("ok")],
      "limits:\n  max_model_calls: 7\n  max_tool_calls: 3\n",
    );

    await runWork(runtime, work.id);

    const line = model.requests[0]?.messages.at(-1)?.content.at(-1) as { text: string };
    expect(line.text).toBe("残り model 呼び出し 7 回、Tool 呼び出し 3 回");
    const usage = (await runtime.works.events(work.id)).find((e) => e.type === "usage.recorded");
    expect(usage?.payload).toMatchObject({
      kind: "model_inference",
      provider: "fake",
      model: "fake-1",
      usage: { inputTokens: 10, outputTokens: 5 },
    });
  });

  test("keeps raw provider output only when the config asks for it", async () => {
    const raw = { id: "msg_1" };
    const withRaw = await setup([{ ...say("ok"), raw }], "debug:\n  persist_raw: true\n");
    const without = await setup([{ ...say("ok"), raw }]);

    await runWork(withRaw.runtime, withRaw.work.id);
    await runWork(without.runtime, without.work.id);

    const completedWith = (await withRaw.runtime.works.events(withRaw.work.id)).find(
      (e) => e.type === "model.completed",
    );
    const completedWithout = (await without.runtime.works.events(without.work.id)).find(
      (e) => e.type === "model.completed",
    );
    expect(payloadOf<{ raw?: unknown }>(completedWith).raw).toEqual(raw);
    expect(payloadOf<{ raw?: unknown }>(completedWithout).raw).toBeUndefined();
  });

  test("refuses to run a work that already ended", async () => {
    const { runtime, work } = await setup([say("ok")]);
    await runWork(runtime, work.id);

    await expect(runWork(runtime, work.id)).rejects.toThrow(/completed/);
  });

  test("uses the model given in the options over the runtime's", async () => {
    const { runtime, work } = await setup([say("from runtime")]);
    const other = new FakeModelProvider([say("from option")]);

    const done = await runWork(runtime, work.id, { model: other });

    expect(done.outcome?.summary).toBe("from option");
  });
});

describe("runWork with ask_user", () => {
  const ask = (id: string, question: string) =>
    callTools({ id, name: "ask_user", input: { question } });

  test("asks the person, records the answer as the tool result and goes on", async () => {
    const { model, runtime, work } = await setup([
      ask("q1", "どの月ですか?"),
      say("7月分を集計しました"),
    ]);
    const questions: string[] = [];

    const done = await runWork(runtime, work.id, {
      onInput: async (question) => {
        questions.push(question);
        return "7月";
      },
    });

    expect(done.status).toBe("completed");
    expect(questions).toEqual(["どの月ですか?"]);
    const events = await runtime.works.events(work.id);
    expect(types(events).slice(5)).toEqual([
      "tool.called",
      "human.input_requested",
      "work.status_changed",
      "human.input_provided",
      "tool.completed",
      "work.status_changed",
      "model.requested",
      "model.completed",
      "usage.recorded",
      "evidence.recorded",
      "work.completed",
    ]);
    expect(events.find((e) => e.type === "human.input_requested")?.payload).toEqual({
      callId: "q1",
      question: "どの月ですか?",
    });
    const answer = model.requests[1]?.messages.at(-2)?.content[0];
    expect(answer).toEqual({ type: "tool_result", callId: "q1", content: "7月", isError: false });
  });

  test("offers ask_user to the model next to the workspace tools", async () => {
    const { model, runtime, work } = await setup([say("ok")]);

    await runWork(runtime, work.id);

    const names = model.requests[0]?.tools?.map((t) => t.name) ?? [];
    expect(names).toContain("ask_user");
    expect(names).toContain("fs_read");
  });

  test("without a way to ask, leaves the work waiting for input and resumes later", async () => {
    const { runtime, work } = await setup([ask("q1", "どの月ですか?"), say("8月分を集計しました")]);

    const waiting = await runWork(runtime, work.id);

    expect(waiting.status).toBe("waiting_input");
    const done = await runWork(runtime, work.id, { onInput: async () => "8月" });

    expect(done.status).toBe("completed");
    expect(done.outcome?.summary).toBe("8月分を集計しました");
    const events = await runtime.works.events(work.id);
    expect(events.filter((e) => e.type === "human.input_provided")).toHaveLength(1);
  });

  test("a question counts as a tool call for the budget", async () => {
    const { runtime, work } = await setup(
      [ask("q1", "a?"), ask("q2", "b?"), say("never")],
      "limits:\n  max_tool_calls: 1\n",
    );

    const done = await runWork(runtime, work.id, { onInput: async () => "x" });

    expect(done.status).toBe("failed");
    expect(done.failure?.reason).toBe("limit_reached");
  });

  test("evidence refs point at the events that wrote the artifacts", async () => {
    const { runtime, work } = await setup([
      callTools({ id: "c1", name: "fs_write", input: { path: "a.md", content: "a" } }),
      callTools({ id: "c2", name: "fs_list", input: {} }),
      say("done"),
    ]);

    await runWork(runtime, work.id);

    const events = await runtime.works.events(work.id);
    const evidence = events.find((e) => e.type === "evidence.recorded");
    const writeEvent = events.find(
      (e) => e.type === "tool.completed" && (e.payload as { callId: string }).callId === "c1",
    );
    if (!writeEvent) throw new Error("expected the write event");
    expect(payloadOf<{ refs: string[] }>(evidence).refs).toEqual([writeEvent.id]);
    expect(payloadOf<{ artifacts: unknown[] }>(evidence).artifacts).toHaveLength(1);
  });

  test("runs the other calls of the turn before waiting, and answers them together", async () => {
    const { model, runtime, work } = await setup([
      callTools(
        { id: "q1", name: "ask_user", input: { question: "どの月ですか?" } },
        { id: "c2", name: "fs_list", input: {} },
      ),
      say("済み"),
    ]);

    const waiting = await runWork(runtime, work.id);

    expect(waiting.status).toBe("waiting_input");
    const before = types(await runtime.works.events(work.id));
    expect(before.indexOf("tool.completed")).toBeGreaterThan(-1);
    expect(before.indexOf("tool.completed")).toBeLessThan(before.indexOf("human.input_requested"));

    const done = await runWork(runtime, work.id, { onInput: async () => "7月" });

    expect(done.status).toBe("completed");
    const results = (model.requests[1]?.messages.at(-2)?.content ?? []).flatMap((p) =>
      p.type === "tool_result" ? [p.callId] : [],
    );
    expect(results.sort()).toEqual(["c2", "q1"]);
  });

  test("rejects a question that does not match the schema and lets the model try again", async () => {
    const { model, runtime, work } = await setup([
      callTools({ id: "q1", name: "ask_user", input: {} }),
      say("済み"),
    ]);
    const asked: string[] = [];

    const done = await runWork(runtime, work.id, {
      onInput: async (question) => {
        asked.push(question);
        return "x";
      },
    });

    expect(done.status).toBe("completed");
    expect(asked).toEqual([]);
    const events = await runtime.works.events(work.id);
    expect(events.some((e) => e.type === "human.input_requested")).toBe(false);
    expect(payloadOf<{ code: string }>(events.find((e) => e.type === "tool.rejected")).code).toBe(
      "schema_mismatch",
    );
    expect(model.requests[1]?.messages.at(-2)?.content[0]).toMatchObject({
      type: "tool_result",
      callId: "q1",
      isError: true,
    });
  });

  test("answers every question of a turn when the work resumes", async () => {
    const { runtime, work } = await setup([
      callTools(
        { id: "q1", name: "ask_user", input: { question: "どの月ですか?" } },
        { id: "q2", name: "ask_user", input: { question: "どの部署ですか?" } },
      ),
      say("済み"),
    ]);

    const waiting = await runWork(runtime, work.id);

    expect(waiting.status).toBe("waiting_input");
    const asked: string[] = [];
    const done = await runWork(runtime, work.id, {
      onInput: async (question) => {
        asked.push(question);
        return "a";
      },
    });

    expect(asked).toEqual(["どの月ですか?", "どの部署ですか?"]);
    expect(done.status).toBe("completed");
    const events = await runtime.works.events(work.id);
    expect(events.filter((e) => e.type === "work.status_changed")).toHaveLength(3);
  });

  test("the ask_user definition cannot be changed by its users", () => {
    expect(Object.isFrozen(ASK_USER)).toBe(true);
  });
});

describe("runWork after an interrupted run", () => {
  async function interruptedAt(steps: FakeStep[], record: (h: WorkHandle) => Promise<void>) {
    const ctx = await setup(steps);
    const handle = await ctx.runtime.works.open(ctx.work.id);
    await handle.transition("in_progress", "run");
    await handle.append({
      type: "model.requested",
      payload: { provider: "fake", model: "fake-1", messageCount: 1, toolNames: ["fs_list"] },
    });
    await record(handle);
    await handle.close();
    return ctx;
  }

  test("tells the model that a tool call never finished, then goes on", async () => {
    const { model, runtime, work } = await interruptedAt([say("済み")], async (h) => {
      await h.append({
        type: "model.completed",
        payload: {
          stopReason: "tool_call",
          content: [{ type: "tool_call", id: "c1", name: "fs_list", input: {} }],
        },
      });
      await h.append({
        type: "tool.called",
        payload: { callId: "c1", provider: "standard", name: "fs_list", input: {} },
      });
    });

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("completed");
    const result = model.requests[0]?.messages.at(-2)?.content[0];
    expect(result).toMatchObject({ type: "tool_result", callId: "c1", isError: true });
    const events = await runtime.works.events(work.id);
    const closed = events.find(
      (e) => e.type === "tool.completed" && (e.payload as { callId: string }).callId === "c1",
    );
    expect(payloadOf<{ isError: boolean }>(closed).isError).toBe(true);
  });

  test("records the call itself when the run stopped before recording it", async () => {
    const { runtime, work } = await interruptedAt([say("済み")], async (h) => {
      await h.append({
        type: "model.completed",
        payload: {
          stopReason: "tool_call",
          content: [{ type: "tool_call", id: "c1", name: "fs_list", input: {} }],
        },
      });
    });

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("completed");
    const events = await runtime.works.events(work.id);
    const called = events.find((e) => e.type === "tool.called");
    expect(payloadOf<{ callId: string; provider: string }>(called)).toMatchObject({
      callId: "c1",
      provider: "standard",
    });
  });

  test("treats a question recorded before the work could wait as pending", async () => {
    const { runtime, work } = await interruptedAt([say("7月分を集計しました")], async (h) => {
      await h.append({
        type: "model.completed",
        payload: {
          stopReason: "tool_call",
          content: [
            { type: "tool_call", id: "q1", name: "ask_user", input: { question: "どの月?" } },
          ],
        },
      });
      await h.append({
        type: "tool.called",
        payload: {
          callId: "q1",
          provider: "runtime",
          name: "ask_user",
          input: { question: "どの月?" },
        },
      });
      await h.append({
        type: "human.input_requested",
        payload: { callId: "q1", question: "どの月?" },
      });
    });
    const asked: string[] = [];

    const waiting = await runWork(runtime, work.id);
    expect(waiting.status).toBe("waiting_input");
    const done = await runWork(runtime, work.id, {
      onInput: async (question) => {
        asked.push(question);
        return "7月";
      },
    });

    expect(asked).toEqual(["どの月?"]);
    expect(done.status).toBe("completed");
  });
});

describe("runWork against a hostile model", () => {
  test("fails the work when the model's answer cannot be recorded", async () => {
    const broken = { ...say("x"), stopReason: "banana" } as unknown as ModelResponse;
    const { runtime, work } = await setup([broken]);

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    expect(done.failure?.reason).toBe("model_error");
    const events = await runtime.works.events(work.id);
    expect(payloadOf<{ code: string }>(events.find((e) => e.type === "model.failed")).code).toBe(
      "invalid_response",
    );
  });

  test("fails the work when the raw answer refers to itself", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const { runtime, work } = await setup(
      [{ ...say("x"), raw: circular }],
      "debug:\n  persist_raw: true\n",
    );

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    expect(done.failure?.reason).toBe("model_error");
  });

  test("fails the work when the model uses one tool call id twice in a turn", async () => {
    const { runtime, work } = await setup([
      callTools(
        { id: "dup", name: "fs_list", input: {} },
        { id: "dup", name: "fs_list", input: {} },
      ),
      say("never"),
    ]);

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    expect(done.failure?.detail).toContain('"dup"');
    const events = await runtime.works.events(work.id);
    expect(events.filter((e) => e.type === "tool.called")).toHaveLength(0);
  });

  test("keeps going when a server reuses a call id from an earlier turn, and still counts every call", async () => {
    const { runtime, work } = await setup(
      [
        callTools({ id: "c1", name: "fs_list", input: {} }),
        callTools({ id: "c1", name: "fs_list", input: {} }),
        callTools({ id: "c1", name: "fs_list", input: {} }),
        say("never"),
      ],
      "limits:\n  max_tool_calls: 2\n",
    );

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    expect(done.failure?.reason).toBe("limit_reached");
    const events = await runtime.works.events(work.id);
    expect(events.filter((e) => e.type === "tool.called")).toHaveLength(2);
  });

  test("refuses to answer a question the model's last turn did not ask", async () => {
    const { runtime, work } = await setup([say("never")]);
    const handle = await runtime.works.open(work.id);
    await handle.transition("in_progress", "run");
    await handle.append({
      type: "tool.called",
      payload: { callId: "ghost", provider: "runtime", name: "ask_user", input: { question: "?" } },
    });
    await handle.append({
      type: "human.input_requested",
      payload: { callId: "ghost", question: "?" },
    });
    await handle.transition("waiting_input", "asked");
    await handle.close();
    let asked = 0;

    const err = await runWork(runtime, work.id, {
      onInput: async () => {
        asked += 1;
        return "x";
      },
    }).catch((e: unknown) => e);

    expect(asked).toBe(0);
    expect((err as { code?: string }).code).toBe("corrupt_log");
  });

  test("marks an artifact the tool reported but never wrote as missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-loop-"));
    await writeFile(join(root, "openshain.yaml"), configText());
    const model = new FakeModelProvider([
      callTools({ id: "c1", name: "ghost_write", input: { path: "ghost.md" } }),
      say("書きました"),
    ]);
    const liar: ToolProvider = {
      id: "standard",
      listTools: async () => [
        {
          name: "ghost_write",
          description: "claims to write",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
          effect: "mutate",
        },
      ],
      call: async () => ({
        content: [{ type: "text", text: "wrote ghost.md" }],
        after: [{ path: "ghost.md", sha256: "0".repeat(64) }],
      }),
    };
    const runtime = await createRuntime({
      workspaceRoot: root,
      providers: { models: { fake: () => model }, tools: { standard: () => liar } },
    });
    const work = await runtime.works.create({
      objective: "x",
      principal: "alice",
      profession: "generic",
    });

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("completed");
    expect(done.outcome?.artifacts).toEqual([
      { path: "ghost.md", sha256: "0".repeat(64), missing: true },
    ]);
  });
});

describe("runWork tells the model its budget", () => {
  test("passes the remaining model and tool calls with every request", async () => {
    const { model, runtime, work } = await setup(
      [callTools({ id: "c1", name: "fs_list", input: {} }), say("済み")],
      "limits:\n  max_model_calls: 5\n  max_tool_calls: 3\n",
    );

    await runWork(runtime, work.id);

    expect(model.requests[0]?.budget).toEqual({ modelCallsLeft: 5, toolCallsLeft: 3 });
    expect(model.requests[1]?.budget).toEqual({ modelCallsLeft: 4, toolCallsLeft: 2 });
  });
});

describe("runWork and the model's stop reasons", () => {
  test("fails with model_error when the model stops for an unexpected reason", async () => {
    const { runtime, work } = await setup([{ ...say("x"), stopReason: "other" }]);

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    expect(done.failure?.reason).toBe("model_error");
    expect(done.failure?.detail).toContain("other");
  });

  test("fails with model_error when the model stops for a tool call but makes none", async () => {
    const { runtime, work } = await setup([{ ...say("x"), stopReason: "tool_call" }]);

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    expect(done.failure?.detail).toContain("none");
  });

  test("keeps the provider's error code in model.failed", async () => {
    const { runtime, work } = await setup([
      () => {
        throw new OpenshainError("rate_limit", "slow down");
      },
    ]);

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("failed");
    const events = await runtime.works.events(work.id);
    expect(payloadOf<{ code: string }>(events.find((e) => e.type === "model.failed")).code).toBe(
      "rate_limit",
    );
  });
});

describe("runWork reports events", () => {
  test("hands every recorded event to onEvent, in the order of the log", async () => {
    const { runtime, work } = await setup([
      callTools({ id: "c1", name: "fs_list", input: {} }),
      say("済み"),
    ]);
    const reported: AnyEvent[] = [];

    await runWork(runtime, work.id, { onEvent: (event) => void reported.push(event) });

    const events = await runtime.works.events(work.id);
    expect(reported.map((e) => e.id)).toEqual(events.slice(1).map((e) => e.id));
    expect(types(reported)).toContain("tool.completed");
  });

  test("records an interrupted call under the runtime when no provider has the tool", async () => {
    const { runtime, work } = await setup([say("済み")]);
    const handle = await runtime.works.open(work.id);
    await handle.transition("in_progress", "run");
    await handle.append({
      type: "model.completed",
      payload: {
        stopReason: "tool_call",
        content: [{ type: "tool_call", id: "c1", name: "vanished_tool", input: {} }],
      },
    });
    await handle.close();

    const done = await runWork(runtime, work.id);

    expect(done.status).toBe("completed");
    const events = await runtime.works.events(work.id);
    expect(
      payloadOf<{ provider: string }>(events.find((e) => e.type === "tool.called")).provider,
    ).toBe("runtime");
  });
});
