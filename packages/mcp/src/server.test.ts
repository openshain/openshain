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

async function connected() {
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
`,
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
  test("offers the work tools and the workspace's tools, but not ask_user", async () => {
    const { client } = await connected();

    const names = (await client.listTools()).tools.map((t) => t.name);

    expect(names).toEqual(
      expect.arrayContaining(["work_create", "work_complete", "fs_read", "csv_read"]),
    );
    expect(names).not.toContain("ask_user");
  });

  test("a tool call without a current work says how to get one", async () => {
    const { call } = await connected();

    const result = await call("fs_list", {});

    expect(result.isError).toBe(true);
    expect(result.text).toContain("work_create");
  });

  test("work_create refuses the type that records conversations", async () => {
    const { call, store } = await connected();

    const result = await call("work_create", { objective: "x", type: "session" });

    expect(result.isError).toBe(true);
    expect(result.text).toContain("reserved");
    expect((await store.list()).works).toHaveLength(0);
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
