import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { measureWork } from "./measures.ts";
import { WorkStore } from "./store.ts";

async function work() {
  const root = await mkdtemp(join(tmpdir(), "openshain-measures-"));
  const store = new WorkStore(root);
  const created = await store.create({
    objective: "7月の証憑",
    principal: "alice",
    profession: "generic",
  });
  return { store, id: created.id };
}

describe("what one work cost and asked for", () => {
  test("counts the times it needed a person, and what the rules stopped", async () => {
    const { store, id } = await work();
    const handle = await store.open(id);
    await handle.transition("in_progress", "run");
    await handle.append({
      type: "human.input_requested",
      payload: { callId: "q1", question: "7月でよいですか" },
    });
    await handle.append({
      type: "approval.decided",
      payload: { approvalId: "apr_1", decision: "approve", by: "alice" },
    });
    await handle.append({
      type: "review.decided",
      payload: { approvalId: "apr_2", decision: "modify", decisionId: "dec_1" },
    });
    await handle.append({
      type: "tool.rejected",
      payload: { callId: "c1", name: "fs_write", code: "denied", reason: "領収書は変更しません" },
    });
    await handle.append({
      type: "tool.rejected",
      payload: { callId: "c2", name: "fs_read", code: "out_of_range", reason: "範囲の外" },
    });
    await handle.close();

    const measures = measureWork(await store.get(id), await store.events(id));

    expect(measures.intervention).toEqual({ clarification: 1, approval: 1, expertReview: 1 });
    // A reviewer who rewrote the call corrected it; one who said yes did not.
    expect(measures.quality).toEqual({ corrected: 1, stoppedByRule: 1 });
    // Only what a rule refused counts as stopped: a range or a changed path is not the rules.
    expect(measures.attention).toEqual({ calls: 3 });
    expect(measures.coverage).toMatchObject({ status: "in_progress", finished: false });
  });

  test("a work nobody was asked about, finished, is the one that counts as covered", async () => {
    const { store, id } = await work();
    const handle = await store.open(id);
    await handle.transition("in_progress", "run");
    await handle.append({ type: "work.completed", payload: { summary: "終わりました" } });
    await handle.close();

    const measures = measureWork(await store.get(id), await store.events(id));

    expect(measures.coverage).toMatchObject({ finished: true, unaided: true });
    expect(measures.attention).toEqual({ calls: 0 });
    expect(typeof measures.coverage.seconds).toBe("number");
  });

  test("adds up what the model and the tools took", async () => {
    const { store, id } = await work();
    const handle = await store.open(id);
    await handle.transition("in_progress", "run");
    await handle.append({
      type: "model.requested",
      payload: { provider: "anthropic", model: "m", messageCount: 2, toolNames: [] },
    });
    await handle.append({
      type: "usage.recorded",
      payload: {
        kind: "model_inference",
        provider: "anthropic",
        model: "m",
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 60 },
      },
    });
    await handle.append({
      type: "usage.recorded",
      payload: { kind: "tool_execution", provider: "standard", usage: { durationMs: 12 } },
    });
    await handle.close();

    const { cost } = measureWork(await store.get(id), await store.events(id));

    expect(cost).toEqual({
      modelCalls: 1,
      toolCalls: 0,
      inputTokens: 100,
      cachedInputTokens: 60,
      outputTokens: 20,
      toolMs: 12,
    });
  });
});
