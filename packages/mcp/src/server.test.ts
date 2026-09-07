import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { WorkStore } from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { createMcpServer } from "./server.ts";

async function connected(extraYaml = "") {
  const root = await mkdtemp(join(tmpdir(), "openshain-mcp-"));
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
  provider: anthropic
  model: claude-opus-5
  api_key_env: ANTHROPIC_API_KEY
tools:
  - provider: standard
${extraYaml}`,
  );
  await mkdir(join(root, "receipts"));
  await writeFile(
    join(root, "receipts", "2026-07.csv"),
    "date,amount\n2026-07-01,100\n2026-07-02,250\n",
  );
  const server = await createMcpServer({
    workspaceRoot: root,
    tools: { standard: () => standardTools() },
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientTransport);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text?: string }[])
      .map((c) => c.text ?? "")
      .join("");
    return { isError: result.isError === true, text, json: () => JSON.parse(text) };
  };
  return { root, client, call, store: new WorkStore(root) };
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("openshain over MCP", () => {
  test("offers the work tools, ask_user, work_answer, work_record and the workspace's tools", async () => {
    const { client } = await connected();

    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "work_create",
        "work_complete",
        "ask_user",
        "work_answer",
        "work_record",
        "fs_read",
        "csv_read",
      ]),
    );
  });

  test("a tool call without a current work says how to get one", async () => {
    const { call } = await connected();

    const result = await call("fs_list", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("work_create");
  });

  test("a session is a work that runs no tools; the work under it carries parent", async () => {
    const { call, store } = await connected();

    const session = await call("work_create", { objective: "会話", type: "session" });
    expect(session.isError).toBe(false);
    const sessionId = session.json().id as string;

    const inSession = await call("fs_list", { path: "." });
    expect(inSession.isError).toBe(true);
    expect(inSession.text).toContain("parent");

    const closed = await call("work_complete", { summary: "会話を終了" });
    expect(closed.json().status).toBe("completed");

    const child = await call("work_create", { objective: "集計", parent: sessionId });
    expect(child.isError).toBe(false);
    expect(child.json().parent).toBe(sessionId);
    expect((await store.get(child.json().id)).parent).toBe(sessionId);

    const orphan = await call("work_fail", { reason: "test" });
    expect(orphan.isError).toBe(false);
    const missingParent = await call("work_create", { objective: "x", parent: "work_nope" });
    expect(missingParent.isError).toBe(true);
  });

  test("ask_user makes the work wait, work_answer records the answer and resumes it, history shows both", async () => {
    const { call, store } = await connected();
    const id = (await call("work_create", { objective: "x" })).json().id as string;
    await call("fs_list", { path: "." });

    const asked = await call("ask_user", { question: "どの月ですか" });
    expect(asked.isError).toBe(false);
    expect(asked.json()).toMatchObject({ pending: true, question: "どの月ですか" });
    const callId = asked.json().call_id as string;
    expect((await store.get(id as never)).status).toBe("waiting_input");

    const twice = await call("ask_user", { question: "もう一つ" });
    expect(twice.isError).toBe(true);
    expect(twice.text).toContain("work_answer");
    const blocked = await call("fs_list", { path: "." });
    expect(blocked.isError).toBe(true);

    const waiting = await call("work_get", { history: true });
    expect(waiting.json().history.pending).toEqual([{ callId, question: "どの月ですか" }]);
    expect(waiting.json().history.calls.map((c: { name: string }) => c.name)).toEqual([
      "fs_list",
      "ask_user",
    ]);

    const wrong = await call("work_answer", { call_id: "call_x", answer: "7 月" });
    expect(wrong.isError).toBe(true);
    const answered = await call("work_answer", { call_id: callId, answer: "7 月" });
    expect(answered.isError).toBe(false);
    expect(answered.json().status).toBe("in_progress");

    const types = (await store.events(id as never)).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining(["human.input_requested", "human.input_provided", "tool.completed"]),
    );
    const after = await call("work_get", { history: true });
    expect(after.json().history.pending).toEqual([]);
    expect(after.json().history.unfinished).toEqual([]);
  });

  test("a pending question survives a model turn the client recorded, and a nested session is refused", async () => {
    const { call, store } = await connected();
    const sessionId = (await call("work_create", { objective: "会話", type: "session" })).json()
      .id as string;
    const nested = await call("work_create", {
      objective: "x",
      type: "session",
      parent: sessionId,
    });
    expect(nested.isError).toBe(true);
    const id = (await call("work_create", { objective: "x", parent: sessionId })).json()
      .id as string;
    const asked = await call("ask_user", { question: "どれ？" });
    const callId = asked.json().call_id as string;
    await call("work_record", {
      work_id: id,
      type: "model.completed",
      payload: { stop_reason: "end_turn", content: [{ type: "text", text: "..." }] },
    });

    const history = (await call("work_get", { id, history: true })).json().history;
    expect(history.pending).toEqual([{ callId, question: "どれ？" }]);
    expect(history.modelCalls).toBe(0);
    const answered = await call("work_answer", { call_id: callId, answer: "これ" });
    expect(answered.isError).toBe(false);
    expect((await store.get(id as never)).status).toBe("in_progress");
  });

  test("work_record accepts the client's own events, checks their payload, and refuses the rest", async () => {
    const { call, store } = await connected();
    const id = (await call("work_create", { objective: "会話", type: "session" })).json()
      .id as string;

    const said = await call("work_record", {
      work_id: id,
      type: "human.message",
      payload: { text: "7 月を集計して" },
    });
    expect(said.isError).toBe(false);
    expect(said.json().seq).toBeGreaterThan(1);

    const usage = await call("work_record", {
      work_id: id,
      type: "usage.recorded",
      payload: {
        kind: "model_inference",
        provider: "anthropic",
        model: "m",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    });
    expect(usage.isError).toBe(false);

    const toolUsage = await call("work_record", {
      work_id: id,
      type: "usage.recorded",
      payload: { kind: "tool_execution", provider: "standard", usage: { duration_ms: 1 } },
    });
    expect(toolUsage.isError).toBe(true);
    const bad = await call("work_record", {
      work_id: id,
      type: "human.message",
      payload: { nope: 1 },
    });
    expect(bad.isError).toBe(true);
    const runtimeOnly = await call("work_record", {
      work_id: id,
      type: "tool.called",
      payload: { call_id: "c", provider: "standard", name: "fs_list", input: {} },
    });
    expect(runtimeOnly.isError).toBe(true);

    const types = (await store.events(id as never)).map((e) => e.type);
    expect(types).toEqual([
      "work.created",
      "work.status_changed",
      "human.message",
      "usage.recorded",
    ]);
  });

  test("rejects tool calls past max_tool_calls with limit_reached and keeps the work open", async () => {
    const { call, store } = await connected("limits:\n  max_tool_calls: 1\n");
    const id = (await call("work_create", { objective: "x" })).json().id as string;

    expect((await call("fs_list", { path: "." })).isError).toBe(false);
    const over = await call("fs_list", { path: "." });

    expect(over.isError).toBe(true);
    expect(over.text).toContain("limit_reached");
    const events = await store.events(id as never);
    expect(events.filter((e) => e.type === "tool.rejected")).toHaveLength(1);
    expect((await store.get(id as never)).status).toBe("in_progress");
  });

  test("drives a work from creation to completion, recording the calls and the evidence", async () => {
    const { root, call, store } = await connected();

    const created = await call("work_create", { objective: "receipts を集計して" });
    expect(created.isError).toBe(false);
    const id = created.json().id as string;
    expect(created.json().status).toBe("in_progress");

    const rows = await call("csv_read", { path: "receipts/2026-07.csv" });
    expect(rows.isError).toBe(false);
    expect(rows.json()).toMatchObject({
      columns: ["date", "amount"],
      rowCount: 2,
      rows: [
        { date: "2026-07-01", amount: "100" },
        { date: "2026-07-02", amount: "250" },
      ],
    });
    const written = await call("fs_write", { path: "summary.md", content: "# 合計 350\n" });
    expect(written.isError).toBe(false);

    const done = await call("work_complete", { summary: "summary.md に合計 350 を書きました" });

    expect(done.isError).toBe(false);
    expect(done.json().status).toBe("completed");
    expect(done.json().outcome.artifacts).toEqual([
      { path: "summary.md", sha256: sha256("# 合計 350\n") },
    ]);
    const events = await store.events(id as never);
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === "tool.called")).toHaveLength(2);
    expect(types).toContain("evidence.recorded");
    expect(types.at(-1)).toBe("work.completed");
    expect(types.filter((t) => t === "usage.recorded")).toHaveLength(2);
    expect(await readFile(join(root, "summary.md"), "utf8")).toBe("# 合計 350\n");
  });

  test("keeps the runtime's hash when the agent misreports an artifact, and marks one it never wrote", async () => {
    const { call } = await connected();
    await call("work_create", { objective: "x" });
    await call("fs_write", { path: "summary.md", content: "a" });

    const done = await call("work_complete", {
      summary: "done",
      artifacts: [
        { path: "summary.md", sha256: "0".repeat(64) },
        { path: "ghost.md", sha256: "1".repeat(64) },
      ],
    });

    expect(done.json().outcome.artifacts).toEqual([
      { path: "summary.md", sha256: sha256("a") },
      { path: "ghost.md", sha256: "1".repeat(64), missing: true, claimed: true },
    ]);
  });

  test("records a failure with the agent's reason and ends the current work", async () => {
    const { call } = await connected();
    await call("work_create", { objective: "x" });

    const failed = await call("work_fail", {
      reason: "agent_error",
      detail: "the data was not there",
    });
    const after = await call("fs_list", {});

    expect(failed.json().status).toBe("failed");
    expect(failed.json().failure).toEqual({
      reason: "agent_error",
      detail: "the data was not there",
    });
    expect(after.isError).toBe(true);
  });

  test("lists, selects and shows works, and refuses to select a finished one", async () => {
    const { call } = await connected();
    const first = (await call("work_create", { objective: "one" })).json().id as string;
    await call("work_complete", { summary: "done" });
    const second = (await call("work_create", { objective: "two" })).json().id as string;

    const list = (await call("work_list")).json();
    expect(list.works.map((w: { id: string }) => w.id)).toEqual([first, second]);
    expect((await call("work_get")).json().id).toBe(second);
    expect((await call("work_get", { id: first })).json().status).toBe("completed");
    expect((await call("work_select", { id: first })).isError).toBe(true);
    expect((await call("work_select", { id: second })).isError).toBe(false);
  });

  test("rejects a bad work id and a tool the workspace does not have", async () => {
    const { call } = await connected();
    await call("work_create", { objective: "x" });

    const bad = await call("work_get", { id: "nope" });
    const unknown = await call("no_such_tool", {});

    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("invalid_id");
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toContain("unknown tool");
  });
});

describe("openshain over MCP, under pressure", () => {
  test("runs parallel calls one after another instead of fighting over the lock", async () => {
    const { call } = await connected();
    await call("work_create", { objective: "x" });

    const results = await Promise.all([
      call("fs_list", {}),
      call("fs_list", {}),
      call("fs_list", {}),
    ]);

    expect(results.map((r) => r.isError)).toEqual([false, false, false]);
  });

  test("refuses tool calls on a work that ended elsewhere, and forgets it", async () => {
    const { call, store } = await connected();
    const id = (await call("work_create", { objective: "x" })).json().id as string;
    const handle = await store.open(id as never);
    await handle.append({ type: "work.completed", payload: { summary: "done elsewhere" } });
    await handle.close();

    const listed = await call("fs_list", {});
    const then = await call("work_get", {});

    expect(listed.isError).toBe(true);
    expect(listed.text).toContain("already completed");
    expect(then.isError).toBe(true);
    expect((await store.events(id as never)).at(-1)?.type).toBe("work.completed");
  });

  test("reports inputs that do not match a work tool's schema in the same words as any tool", async () => {
    const { call } = await connected();

    const created = await call("work_create", {});
    const finished = await call("work_complete", { summary: "s", artifacts: [{ path: 3 }] });

    expect(created.isError).toBe(true);
    expect(created.text).toContain("schema_mismatch");
    expect(finished.text).toContain("schema_mismatch");
  });

  test("refuses artifacts outside the workspace and records nothing", async () => {
    const { call } = await connected();
    await call("work_create", { objective: "x" });

    const done = await call("work_complete", {
      summary: "s",
      artifacts: [{ path: "../etc/passwd" }],
    });

    expect(done.isError).toBe(true);
    expect(done.text).toContain("outside_workspace");
    expect((await call("work_get", {})).json().status).toBe("in_progress");
  });

  test("refuses to start a new work while the current one is unfinished", async () => {
    const { call } = await connected();
    await call("work_create", { objective: "one" });

    const second = await call("work_create", { objective: "two" });

    expect(second.isError).toBe(true);
    expect(second.text).toContain("work_complete or work_fail");
  });

  test("marks a file the agent names but no tool of the work wrote as claimed, with the runtime's hash", async () => {
    const { root, call } = await connected();
    await call("work_create", { objective: "x" });
    await call("fs_write", { path: "summary.md", content: "a" });

    const done = await call("work_complete", {
      summary: "done",
      artifacts: [{ path: "receipts/2026-07.csv", sha256: "0".repeat(64) }],
    });

    const csv = new Bun.CryptoHasher("sha256")
      .update(await readFile(join(root, "receipts", "2026-07.csv")))
      .digest("hex");
    expect(done.json().outcome.artifacts).toEqual([
      { path: "summary.md", sha256: expect.any(String) },
      { path: "receipts/2026-07.csv", sha256: csv, claimed: true },
    ]);
  });
});
