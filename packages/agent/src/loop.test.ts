import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AnyEvent, createRuntime } from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { runWork } from "./loop.ts";
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
    expect(model.requests[1]?.messages.at(-1)?.content[0]).toMatchObject({
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

    const last = model.requests[1]?.messages.at(-1);
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
    const result = model.requests[1]?.messages.at(-1)?.content[0] as {
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
