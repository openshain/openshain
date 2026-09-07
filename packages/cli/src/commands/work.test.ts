import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FakeModelProvider } from "@openshain/agent/testing";
import { OpenshainError, type RuntimeProviders, WorkStore } from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { workList, workShow } from "./work.ts";

function io() {
  const lines: string[] = [];
  return { lines, write: (line: string) => void lines.push(line), text: () => lines.join("\n") };
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "openshain-cli-work-"));
  await writeFile(join(root, "openshain.yaml"), "version: 1\n");
  return { root, store: new WorkStore(root) };
}

const request = { principal: "alice", profession: "generic" };

async function _fakeWorkspace(model: FakeModelProvider) {
  const root = await mkdtemp(join(tmpdir(), "openshain-cli-work-"));
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
  const providers: RuntimeProviders = {
    models: { fake: () => model },
    tools: { standard: () => standardTools() },
  };
  return { root, providers };
}

describe("work list", () => {
  test("prints one line per work, oldest first, with status and objective", async () => {
    const { root, store } = await workspace();
    const first = await store.create({ ...request, objective: "7月の証憑を照合して" });
    const second = await store.create({ ...request, objective: "請求書を作って" });
    await store.transition(second.id, "in_progress", "run");
    const out = io();

    await workList({ workspaceRoot: root, write: out.write });

    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toContain(first.id);
    expect(out.lines[0]).toContain("未着手");
    expect(out.lines[0]).toContain("7月の証憑を照合して");
    expect(out.lines[1]).toContain("進行中");
  });

  test("says so when there is no work yet", async () => {
    const { root } = await workspace();
    const out = io();

    await workList({ workspaceRoot: root, write: out.write });

    expect(out.text()).toContain("Work はまだありません");
  });

  test("reports a work it cannot read without hiding the others", async () => {
    const { root, store } = await workspace();
    const healthy = await store.create({ ...request, objective: "ok" });
    const brokenDir = join(root, "work", "work_0192a3b4-c5d6-7e8f-8a9b-0c1d2e3f4a5b");
    await mkdir(brokenDir, { recursive: true });
    await writeFile(join(brokenDir, "events.jsonl"), "garbage\n");
    const out = io();

    await workList({ workspaceRoot: root, write: out.write });

    expect(out.text()).toContain(healthy.id);
    expect(out.text()).toMatch(/読めない\(壊れた Work の記録\)/);
  });
});

describe("work show", () => {
  test("shows the state, the outcome, the usage totals and who acts next", async () => {
    const { root, store } = await workspace();
    const work = await store.create({ ...request, objective: "集計して" });
    const handle = await store.open(work.id);
    await handle.transition("in_progress", "run");
    await handle.append({
      type: "usage.recorded",
      payload: {
        kind: "model_inference",
        provider: "fake",
        model: "fake-1",
        usage: { inputTokens: 30, outputTokens: 5 },
      },
    });
    await handle.append({
      type: "tool.called",
      payload: {
        callId: "c1",
        provider: "standard",
        name: "fs_write",
        input: { path: "summary.md" },
      },
    });
    await handle.append({
      type: "tool.completed",
      payload: {
        callId: "c1",
        content: [],
        isError: false,
        after: [{ path: "summary.md", sha256: "abc" }],
      },
    });
    await handle.append({
      type: "usage.recorded",
      payload: {
        kind: "model_inference",
        provider: "fake",
        model: "fake-1",
        usage: { inputTokens: 40, outputTokens: 10, cachedInputTokens: 25 },
      },
    });
    await handle.append({
      type: "evidence.recorded",
      payload: { claim: "done", refs: [], artifacts: [{ path: "summary.md", sha256: "abc" }] },
    });
    await handle.append({ type: "work.completed", payload: { summary: "summary.md を作成" } });
    await handle.close();
    const out = io();

    await workShow({ workspaceRoot: root, id: work.id, write: out.write });

    const text = out.text();
    expect(text).toContain(work.id);
    expect(text).toContain("completed");
    expect(text).toContain("summary.md を作成");
    expect(text).toContain("入力 70 トークン(うちキャッシュ 25)");
    expect(text).toContain("出力 15 トークン");
    expect(text).toContain("fs_write summary.md");
    expect(text).toContain("次に動く人はいません");
  });

  test("says the person is next when the work waits for input", async () => {
    const { root, store } = await workspace();
    const work = await store.create({ ...request, objective: "x" });
    const handle = await store.open(work.id);
    await handle.transition("in_progress", "run");
    await handle.append({
      type: "human.input_requested",
      payload: { callId: "q1", question: "どの月?" },
    });
    await handle.transition("waiting_input", "asked");
    await handle.close();
    const out = io();

    await workShow({ workspaceRoot: root, id: work.id, write: out.write });

    expect(out.text()).toContain(`/work resume ${work.id}`);
    expect(out.text()).toContain("どの月?");
  });

  test("rejects an id that is not a work id", async () => {
    const { root } = await workspace();

    await expect(
      workShow({ workspaceRoot: root, id: "../etc", write: () => {} }),
    ).rejects.toBeInstanceOf(OpenshainError);
  });
});

describe("work show and tool outcomes", () => {
  test("marks calls that were rejected or failed, in the order they happened", async () => {
    const { root, store } = await workspace();
    const work = await store.create({ ...request, objective: "x" });
    const handle = await store.open(work.id);
    await handle.transition("in_progress", "run");
    await handle.append({
      type: "tool.rejected",
      payload: { callId: "c1", name: "csv_read", code: "not_allowed", reason: "no" },
    });
    await handle.append({
      type: "tool.called",
      payload: { callId: "c2", provider: "standard", name: "fs_read", input: { path: "a.md" } },
    });
    await handle.append({
      type: "tool.completed",
      payload: { callId: "c2", content: [{ type: "text", text: "cannot read" }], isError: true },
    });
    await handle.close();
    const out = io();

    await workShow({ workspaceRoot: root, id: work.id, write: out.write });

    const tool = out.lines.indexOf("Tool");
    expect(out.lines[tool + 1]).toBe("  csv_read  拒否(この workspace では不許可)");
    expect(out.lines[tool + 2]).toBe("  fs_read a.md  失敗");
  });
});
