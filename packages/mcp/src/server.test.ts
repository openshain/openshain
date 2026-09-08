import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { businessDate, WorkStore } from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { createMcpServer } from "./server.ts";

async function connected(extraYaml = "", existingRoot?: string) {
  const root = existingRoot ?? (await mkdtemp(join(tmpdir(), "openshain-mcp-")));
  if (!existingRoot)
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
  if (!existingRoot) {
    await mkdir(join(root, "receipts"));
    await writeFile(
      join(root, "receipts", "2026-07.csv"),
      "date,amount\n2026-07-01,100\n2026-07-02,250\n",
    );
  }
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

  test("context tells where and when, and is recorded on the current work, a session included", async () => {
    const { call, store } = await connected();

    const outside = await call("context", {});
    expect(outside.isError).toBe(false);
    expect(outside.json()).toMatchObject({
      timezone: expect.any(String),
      company: "サンプル株式会社",
      principal: { id: "alice", name: "Alice" },
      profession: "generic",
      work: null,
    });
    expect(outside.json().now).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    expect(outside.json().business_date).toBe(outside.json().now.slice(0, 10));

    const id = (await call("work_create", { objective: "会話", type: "session" })).json()
      .id as string;
    const inside = await call("context", {});
    expect(inside.isError).toBe(false);
    expect(inside.json().work).toBe(id);
    const types = (await store.events(id as never)).map((e) => e.type);
    expect(types.filter((t) => t === "tool.called")).toHaveLength(1);
    expect(types.filter((t) => t === "tool.completed")).toHaveLength(1);
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

  test("the business date a delegation is judged against is the company's, not the machine's", async () => {
    // Two timezones 25 hours apart never share a date, so the delegation that is valid today
    // in one is not yet valid in the other, whatever time the test runs at.
    const early = businessDate("Pacific/Kiritimati");
    const yaml = (timezone: string) =>
      `company:\n  name: サンプル株式会社\n  timezone: ${timezone}\n`;

    for (const [timezone, allowed] of [
      ["Pacific/Kiritimati", true],
      ["Pacific/Niue", false],
    ] as const) {
      const root = await mkdtemp(join(tmpdir(), "openshain-tz-"));
      await writeFile(
        join(root, "openshain.yaml"),
        `version: 1\n${yaml(timezone)}principal:\n  id: alice\n  name: Alice\nprofession:\n  id: generic\n  instructions: 事務担当として働く。\ntools:\n  - provider: standard\n`,
      );
      await mkdir(join(root, "authority"));
      await writeFile(
        join(root, "authority", "delegations.yaml"),
        `version: 1\ndelegations:\n  - principal: alice\n    profession: generic\n    valid_from: ${early}\n`,
      );
      await writeFile(
        join(root, "authority", "policy.yaml"),
        "version: 1\ndefault: allow\nrules: []\n",
      );
      const { call } = await connected(undefined, root);
      await call("work_create", { objective: "一覧" });

      const listed = await call("fs_list", { path: "." });

      expect({ timezone, ok: !listed.isError }).toEqual({ timezone, ok: allowed });
      if (!allowed) expect(listed.text).toContain("no delegation");
    }
  });

  test("context reports the company's clock, not the machine's", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-tz-ctx-"));
    await writeFile(
      join(root, "openshain.yaml"),
      "version: 1\ncompany:\n  name: サンプル株式会社\n  timezone: Pacific/Kiritimati\nprincipal:\n  id: alice\n  name: Alice\nprofession:\n  id: generic\n  instructions: 事務担当として働く。\ntools:\n  - provider: standard\n",
    );
    const { call } = await connected(undefined, root);

    const info = (await call("context", {})).json() as {
      timezone: string;
      business_date: string;
      now: string;
    };

    expect(info.timezone).toBe("Pacific/Kiritimati");
    expect(info.business_date).toBe(businessDate("Pacific/Kiritimati"));
    expect(info.now).toContain("+14:00");
  });

  test("a review holds the call, the package is recorded, the decision is written, and the next call cites it", async () => {
    const { root } = await connected();
    await mkdir(join(root, "authority"));
    await mkdir(join(root, "ledger"));
    await writeFile(
      join(root, "authority", "delegations.yaml"),
      "version: 1\ndelegations:\n  - principal: alice\n    profession: generic\n",
    );
    await writeFile(
      join(root, "authority", "policy.yaml"),
      `version: 1
default: allow
rules:
  - id: tax-treatment-needs-review
    match: { tool: csv_write, path: "ledger/**" }
    decision: review_required
    reviewer: { role: tax-accountant }
    reason: 税務上の取扱いを確認してください
`,
    );
    const { call, store } = await connected(undefined, root);
    const id = (await call("work_create", { objective: "7 月の帳簿" })).json().id as string;
    await call("csv_read", { path: "receipts/2026-07.csv" });

    const held = await call("csv_write", {
      path: "ledger/2026-07.csv",
      rows: [{ date: "2026-07-01", amount: "100" }],
    });

    expect(held.isError).toBe(false);
    expect(held.json()).toMatchObject({
      pending: "review",
      rule_id: "tax-treatment-needs-review",
      reviewer: { role: "tax-accountant" },
    });
    const approvalId = held.json().approval_id as string;
    expect((await store.get(id as never)).status).toBe("waiting_approval");
    const requested = (await store.events(id as never)).find((e) => e.type === "review.requested");
    expect(
      (requested as { payload: { package: Record<string, unknown> } }).payload.package,
    ).toMatchObject({
      action: { tool: "csv_write" },
      facts: ["csv_read receipts/2026-07.csv"],
      question: "税務上の取扱いを確認してください",
      requestedBy: "alice",
    });

    // A person cannot stand in for the reviewer.
    const wrongDoor = await call("approval_decide", {
      approval_id: approvalId,
      decision: "approve",
    });
    expect(wrongDoor.isError).toBe(true);
    expect(wrongDoor.text).toContain("review_decide");
    const noWords = await call("review_decide", {
      approval_id: approvalId,
      decision: "approve",
      reviewer: { name: "田中", role: "tax-accountant" },
    });
    expect(noWords.isError).toBe(true);
    expect(noWords.text).toContain("interpretation");

    const wrongRole = await call("review_decide", {
      approval_id: approvalId,
      decision: "approve",
      reviewer: { name: "誰か", role: "reviewer" },
      interpretation: "よい",
    });
    expect(wrongRole.isError).toBe(true);
    expect(wrongRole.text).toContain("asks for a tax-accountant");

    const decided = await call("review_decide", {
      approval_id: approvalId,
      decision: "approve",
      reviewer: { name: "田中 太郎", role: "tax-accountant", qualification: "税理士(会社の申告)" },
      interpretation: "この処理で進めてよい",
      applies_to: { path: "ledger/**" },
    });

    expect(decided.isError).toBe(false);
    expect(decided.json().result.isError).toBe(false);
    const decisionId = decided.json().decision_id as string;
    expect(decided.json().decision_file).toBe(join("authority", "decisions", `${decisionId}.yaml`));
    // The package the person sends to the reviewer sits next to the work's own record.
    const copy = JSON.parse(
      await readFile(join(root, "work", id, "review", `${approvalId}.json`), "utf8"),
    );
    expect(copy).toMatchObject({ approvalId, action: { tool: "csv_write" } });
    expect(await readFile(join(root, "ledger", "2026-07.csv"), "utf8")).toContain("2026-07-01");
    expect((await store.get(id as never)).status).toBe("in_progress");
    const types = (await store.events(id as never)).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "review.requested",
        "approval.decided",
        "review.decided",
      ]),
    );

    // With the decision written, a rule that cites it lets the same call run without a review.
    await writeFile(
      join(root, "authority", "policy.yaml"),
      `version: 1
default: allow
rules:
  - id: tax-treatment-decided
    match: { tool: csv_write, path: "ledger/**" }
    decision: decision_backed
    decision_id: ${decisionId}
`,
    );
    const { call: after } = await connected(undefined, root);
    const second = (await after("work_create", { objective: "8 月の帳簿" })).json().id as string;
    const ran = await after("csv_write", {
      path: "ledger/2026-08.csv",
      rows: [{ date: "2026-08-01", amount: "200" }],
    });

    expect(ran.isError).toBe(false);
    const applied = (await store.events(second as never)).find(
      (e) => e.type === "decision.applied",
    );
    expect((applied as { payload: { decisionId: string } }).payload.decisionId).toBe(decisionId);
  });

  test("an ill-formed decision changes nothing, and a decided approval cannot be decided twice", async () => {
    const { root } = await connected();
    await mkdir(join(root, "authority"));
    await mkdir(join(root, "ledger"));
    await writeFile(
      join(root, "authority", "delegations.yaml"),
      "version: 1\ndelegations:\n  - principal: alice\n    profession: generic\n",
    );
    await writeFile(
      join(root, "authority", "policy.yaml"),
      "version: 1\ndefault: allow\nrules:\n  - id: needs-review\n    match: { tool: fs_write }\n    decision: review_required\n    reviewer: { role: tax-accountant }\n",
    );
    const { call, store } = await connected(undefined, root);
    const id = (await call("work_create", { objective: "x" })).json().id as string;
    const held = await call("fs_write", { path: "ledger/x.csv", content: "a\n" });
    const approvalId = held.json().approval_id as string;
    const reviewer = { name: "田中", role: "tax-accountant" };

    // A date the decision refuses: the approval must stay pending and decidable.
    const malformed = await call("review_decide", {
      approval_id: approvalId,
      decision: "approve",
      reviewer,
      interpretation: "よい",
      effective_from: "2026/09/08",
    });
    expect(malformed.isError).toBe(true);
    expect(malformed.text).toContain("not well formed");
    expect((await store.get(id as never)).status).toBe("waiting_approval");
    expect((await call("approval_list", {})).json().approvals).toHaveLength(1);

    const decided = await call("review_decide", {
      approval_id: approvalId,
      decision: "approve",
      reviewer,
      interpretation: "よい",
    });
    expect(decided.isError).toBe(false);

    const again = await call("review_decide", {
      approval_id: approvalId,
      decision: "approve",
      reviewer,
      interpretation: "もう一度",
    });
    expect(again.isError).toBe(true);
    const decisions = (await store.events(id as never)).filter((e) => e.type === "review.decided");
    expect(decisions).toHaveLength(1);
  });

  test("a modified call must touch the path that was held", async () => {
    const { root } = await connected();
    await mkdir(join(root, "authority"));
    await mkdir(join(root, "ledger"));
    await writeFile(
      join(root, "authority", "delegations.yaml"),
      "version: 1\ndelegations:\n  - principal: alice\n    profession: generic\n",
    );
    await writeFile(
      join(root, "authority", "policy.yaml"),
      "version: 1\ndefault: allow\nrules:\n  - id: needs-review\n    match: { tool: fs_write }\n    decision: review_required\n    reviewer: { role: tax-accountant }\n",
    );
    const { call, store } = await connected(undefined, root);
    const id = (await call("work_create", { objective: "x" })).json().id as string;
    const held = await call("fs_write", { path: "ledger/x.csv", content: "a\n" });
    const reviewer = { name: "田中", role: "tax-accountant" };

    const elsewhere = await call("review_decide", {
      approval_id: held.json().approval_id,
      decision: "modify",
      reviewer,
      interpretation: "別の場所に書かせる",
      modified_input: { path: "ledger/other.csv", content: "b\n" },
    });

    expect(elsewhere.isError).toBe(true);
    expect(elsewhere.text).toContain("same path");
    expect(existsSync(join(root, "ledger", "other.csv"))).toBe(false);

    const corrected = await call("review_decide", {
      approval_id: held.json().approval_id,
      decision: "modify",
      reviewer,
      interpretation: "中身だけ直す",
      modified_input: { path: "ledger/x.csv", content: "直した\n" },
    });

    expect(corrected.text).not.toContain("same path");
    expect(corrected.isError).toBe(false);
    expect(await readFile(join(root, "ledger", "x.csv"), "utf8")).toBe("直した\n");
    // What the reviewer changed is in the record, not only in the file.
    const decided = (await store.events(id as never)).find((e) => e.type === "approval.decided");
    expect(
      (decided as { payload: { modifiedInput?: { content?: string } } }).payload.modifiedInput,
    ).toMatchObject({ content: "直した\n" });
  });

  test("a rejected review refuses the call and the work goes on", async () => {
    const { root } = await connected();
    await mkdir(join(root, "authority"));
    await mkdir(join(root, "ledger"));
    await writeFile(
      join(root, "authority", "delegations.yaml"),
      "version: 1\ndelegations:\n  - principal: alice\n    profession: generic\n",
    );
    await writeFile(
      join(root, "authority", "policy.yaml"),
      "version: 1\ndefault: allow\nrules:\n  - id: needs-review\n    match: { tool: fs_write }\n    decision: review_required\n    reviewer: { role: tax-accountant }\n",
    );
    const { call, store } = await connected(undefined, root);
    const id = (await call("work_create", { objective: "x" })).json().id as string;
    const held = await call("fs_write", { path: "ledger/x.csv", content: "a\n" });

    const rejected = await call("review_decide", {
      approval_id: held.json().approval_id,
      decision: "reject",
      reviewer: { name: "田中", role: "tax-accountant" },
      interpretation: "この処理は認められない",
    });

    expect(rejected.isError).toBe(false);
    expect(existsSync(join(root, "ledger", "x.csv"))).toBe(false);
    expect((await store.get(id as never)).status).toBe("in_progress");
    const decided = (await store.events(id as never)).find((e) => e.type === "review.decided");
    expect((decided as { payload: { decisionId?: string } }).payload.decisionId).toBeUndefined();
    const refusal = (await store.events(id as never))
      .filter((e) => e.type === "tool.rejected")
      .at(-1);
    expect((refusal as { payload: { reason: string } }).payload.reason).toBe(
      "この処理は認められない",
    );
  });

  test("caps the size of what a client can record and the length of the names it can set", async () => {
    const { call } = await connected();
    const id = (await call("work_create", { objective: "会話", type: "session" })).json()
      .id as string;

    const huge = await call("work_record", {
      work_id: id,
      type: "human.message",
      payload: { text: "あ".repeat(300_000) },
    });
    expect(huge.isError).toBe(true);
    expect(huge.text).toContain("larger");

    const longName = await call("work_create", { objective: "x", agent_name: "a".repeat(101) });
    expect(longName.isError).toBe(true);
    expect(longName.text).toContain("schema_mismatch");
    const longQuestion = await call("ask_user", { question: "?".repeat(10_001) });
    expect(longQuestion.isError).toBe(true);
  });

  test("authority/ judges tool calls: a denied write is recorded and not run, principals/ and authority/ are reserved", async () => {
    const { root, call, store } = await connected();
    await mkdir(join(root, "authority"));
    await writeFile(
      join(root, "authority", "delegations.yaml"),
      "version: 1\ndelegations:\n  - principal: alice\n    profession: generic\n",
    );
    await writeFile(
      join(root, "authority", "policy.yaml"),
      `version: 1
default: allow
rules:
  - id: receipts-are-read-only
    match: { effect: mutate, path: "receipts/**" }
    decision: deny
    reason: 領収書は変更しません
  - id: ledger-needs-approval
    match: { tool: fs_write, path: "ledger/**" }
    decision: approval_required
    approvers: [alice]
`,
    );
    const { call: judged } = await connected(undefined, root);
    void call;
    const id = (await judged("work_create", { objective: "x" })).json().id as string;

    const read = await judged("csv_read", { path: "receipts/2026-07.csv" });
    expect(read.isError).toBe(false);
    const denied = await judged("fs_write", { path: "receipts/2026-07.csv", content: "x" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain("領収書は変更しません");
    expect(await readFile(join(root, "receipts", "2026-07.csv"), "utf8")).toContain("2026-07-01");
    const reserved = await judged("fs_read", { path: "authority/policy.yaml" });
    expect(reserved.isError).toBe(true);
    const events = await store.events(id as never);
    const rejected = events.filter((e) => e.type === "tool.rejected");
    expect(rejected.map((e) => (e as { payload: { code: string } }).payload.code)).toEqual([
      "denied",
      "reserved_path",
    ]);
  });

  test("a call the policy holds waits for approval; approve runs it, reject refuses it, and the work goes on", async () => {
    const { root, call } = await connected();
    await mkdir(join(root, "authority"));
    await mkdir(join(root, "ledger"));
    await writeFile(
      join(root, "authority", "delegations.yaml"),
      "version: 1\ndelegations:\n  - principal: alice\n    profession: generic\n",
    );
    await writeFile(
      join(root, "authority", "policy.yaml"),
      `version: 1
default: allow
rules:
  - id: ledger-needs-approval
    match: { tool: fs_write, path: "ledger/**" }
    decision: approval_required
    approvers: [alice]
`,
    );
    const { call: judged, store } = await connected(undefined, root);
    void call;
    const id = (await judged("work_create", { objective: "帳簿" })).json().id as string;

    const held = await judged("fs_write", { path: "ledger/2026-07.csv", content: "a,b\n" });
    expect(held.isError).toBe(false);
    expect(held.json()).toMatchObject({ pending: "approval", rule_id: "ledger-needs-approval" });
    const approvalId = held.json().approval_id as string;
    expect((await store.get(id as never)).status).toBe("waiting_approval");
    expect(existsSync(join(root, "ledger", "2026-07.csv"))).toBe(false);

    const blocked = await judged("fs_list", { path: "." });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toContain("approval_decide");

    const listed = await judged("approval_list", {});
    expect(listed.json().approvals).toHaveLength(1);
    expect(listed.json().approvals[0]).toMatchObject({ approvalId, work_id: id, kind: "approval" });
    const history = (await judged("work_get", { id, history: true })).json().history;
    expect(history.approvals).toHaveLength(1);

    const unknown = await judged("approval_decide", {
      approval_id: "apr_nope",
      decision: "approve",
    });
    expect(unknown.isError).toBe(true);

    const approved = await judged("approval_decide", {
      approval_id: approvalId,
      decision: "approve",
    });
    expect(approved.isError).toBe(false);
    expect(approved.json().result.isError).toBe(false);
    expect(await readFile(join(root, "ledger", "2026-07.csv"), "utf8")).toBe("a,b\n");
    expect((await store.get(id as never)).status).toBe("in_progress");
    const types = (await store.events(id as never)).map((e) => e.type);
    expect(types).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "approval.decided",
        "tool.called",
        "tool.completed",
      ]),
    );
    expect((await judged("approval_list", {})).json().approvals).toHaveLength(0);

    const heldAgain = await judged("fs_write", { path: "ledger/2026-08.csv", content: "x" });
    const secondId = heldAgain.json().approval_id as string;
    const rejected = await judged("approval_decide", {
      approval_id: secondId,
      decision: "reject",
      comment: "まだ早い",
    });
    expect(rejected.isError).toBe(false);
    expect(existsSync(join(root, "ledger", "2026-08.csv"))).toBe(false);
    expect((await store.get(id as never)).status).toBe("in_progress");
    const last = (await store.events(id as never)).filter((e) => e.type === "tool.rejected").at(-1);
    expect((last as { payload: { code: string; reason: string } }).payload).toMatchObject({
      code: "rejected_by_person",
      reason: "まだ早い",
    });
    const done = await judged("work_complete", { summary: "帳簿を更新" });
    expect(done.json().outcome.artifacts.map((a: { path: string }) => a.path)).toEqual([
      "ledger/2026-07.csv",
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
