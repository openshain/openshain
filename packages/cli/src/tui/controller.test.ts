import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_NAMES } from "@openshain/agent";
import { callTools, FakeModelProvider, type FakeStep, say } from "@openshain/agent/testing";
import {
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type RuntimeProviders,
  WorkStore,
} from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { LOGO_ROWS, VERSION } from "./banner.ts";
import { type Controller, type ControllerState, createController } from "./controller.ts";

/** A model that never answers, until the call is stopped. */
class HangingModel implements ModelProvider {
  readonly id = "fake";
  describe() {
    return { provider: "fake", model: "fake-1", capabilities: { tools: true } };
  }
  generate(_request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    return new Promise((_, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
    });
  }
}

async function setup(
  steps: FakeStep[],
  given?: ModelProvider,
  options: { authority?: boolean; review?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "openshain-tui-"));
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
  await writeFile(join(root, "receipts", "2026-07.csv"), "date,amount\n2026-07-01,100\n");
  if (options.authority) {
    await mkdir(join(root, "authority"));
    await mkdir(join(root, "ledger"));
    await writeFile(
      join(root, "authority", "delegations.yaml"),
      "version: 1\ndelegations:\n  - principal: alice\n    profession: generic\n",
    );
    await writeFile(
      join(root, "authority", "policy.yaml"),
      options.review
        ? `version: 1
default: allow
rules:
  - id: ledger-needs-review
    match: { tool: fs_write, path: "ledger/**" }
    decision: review_required
    reviewer: { role: tax-accountant }
`
        : `version: 1
default: allow
rules:
  - id: ledger-needs-approval
    match: { tool: fs_write, path: "ledger/**" }
    decision: approval_required
    approvers: [alice]
`,
    );
  }
  const model = given ?? new FakeModelProvider(steps);
  const providers: RuntimeProviders = {
    models: { fake: () => model },
    tools: { standard: () => standardTools() },
  };
  const store = new WorkStore(root);
  const controller = await createController({ workspaceRoot: root, providers });
  return { root, store, controller };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const texts = (c: Controller, kind?: string) =>
  c
    .state()
    .entries.filter((e) => !kind || e.kind === kind)
    .map((e) => e.text);

/** The entries of the conversation itself, without the rows the screen shows when it opens. */
const conversation = (c: Controller) =>
  c.state().entries.filter((e) => e.kind !== "logo" && e.kind !== "banner");

const workCreate = (id: string, objective: string) =>
  callTools({ id, name: "work_create", input: { objective } });
const workComplete = (id: string, summary: string) =>
  callTools({ id, name: "work_complete", input: { summary } });
const csvRead = (id: string) =>
  callTools({ id, name: "csv_read", input: { path: "receipts/2026-07.csv" } });
/** The model continues the candidate work: it must have been told about it. */
const selectCandidate = (id: string) => (request: ModelRequest) => {
  const note = JSON.stringify(request.messages.at(-2));
  const match = /work_[0-9a-f-]+/.exec(note);
  if (!note.includes("候補の Work") || !match) throw new Error("no candidate in the prompt");
  return callTools({ id, name: "work_select", input: { id: match[0] } });
};
const requestWork = async (store: WorkStore) =>
  (await store.list()).works.find((w) => w.type === "request");

describe("the screen's controller", () => {
  test("shows what the person says and what the model replies", async () => {
    const { controller, root } = await setup([say("こんにちは")]);
    const before = controller.state().entries;

    expect(texts(controller, "logo")).toEqual([...LOGO_ROWS]);
    expect(texts(controller, "banner")).toEqual([`openshain ${VERSION}`, root]);

    await controller.submit("やあ");

    // A new array each time: the screen redraws from the array it is handed.
    expect(controller.state().entries).not.toBe(before);
    expect(conversation(controller).map((e) => [e.kind, e.text])).toEqual([
      ["user", "やあ"],
      ["assistant", "こんにちは"],
    ]);
    expect(controller.state().busy).toBe(false);
    expect(controller.state().status.usage.modelCalls).toBe(1);
    expect(AGENT_NAMES.ja).toContain(controller.state().status.agentName ?? "");
  });

  test("streams a work's progress and routes its question to the person", async () => {
    const { controller } = await setup([
      workCreate("c1", "集計して"),
      csvRead("c2"),
      callTools({ id: "c3", name: "ask_user", input: { question: "何月ですか" } }),
      workComplete("c4", "7月分は 100 円"),
      say("7月分は 100 円でした。"),
    ]);

    const turn = controller.submit("集計して");
    await waitFor(() => controller.state().question !== undefined);
    expect(controller.state().question).toBe("何月ですか");
    await controller.submit("7月");
    await turn;

    expect(texts(controller, "progress")).toContain("csv_read receipts/2026-07.csv");
    expect(texts(controller, "progress")).toContain("完了。");
    expect(texts(controller, "progress").some((l) => l.startsWith("model 呼び出し"))).toBe(true);
    const entries = controller.state().entries;
    expect(entries.findIndex((e) => e.text === "完了。")).toBeLessThan(
      entries.findIndex((e) => e.kind === "assistant"),
    );
    expect(texts(controller, "question")[0]).toContain("何月ですか");
    expect(texts(controller, "user")).toEqual(["集計して", "7月"]);
    expect(texts(controller, "assistant")).toEqual(["7月分は 100 円でした。"]);
    expect(controller.state().status.work?.status).toBe("completed");
  });

  test("a turn that ends with nothing said shows the work's own summary", async () => {
    // Some models put the result in the work's summary and say nothing to the person. The
    // answer must still reach the screen.
    const { controller } = await setup([
      workCreate("c1", "集計して"),
      csvRead("c2"),
      workComplete("c3", "7月分は 296 件、合計 100 円でした。"),
      say("   "),
    ]);

    await controller.submit("集計して");

    expect(texts(controller, "assistant")).toEqual(["7月分は 296 件、合計 100 円でした。"]);
  });

  test("what the agent says stands on its own; the summary is not repeated under it", async () => {
    const { controller } = await setup([
      workCreate("c1", "集計して"),
      csvRead("c2"),
      workComplete("c3", "7月分は 100 円"),
      say("7月分は 100 円でした。"),
    ]);

    await controller.submit("集計して");

    expect(texts(controller, "assistant")).toEqual(["7月分は 100 円でした。"]);
  });

  test("stops a running work on interrupt; /work resume makes it the candidate and the next request continues it", async () => {
    const { controller, store } = await setup([
      workCreate("c1", "集計して"),
      csvRead("c2"),
      selectCandidate("c3"),
      workComplete("c4", "続きをやりました"),
      say("続きをやりました。"),
    ]);

    // Stop at the first progress line, inside the notification, before the fake model can answer again.
    let stopped: boolean | undefined;
    const unsubscribe = controller.subscribe(() => {
      if (stopped === undefined && controller.state().entries.some((e) => e.kind === "progress")) {
        stopped = controller.interrupt();
      }
    });
    await controller.submit("集計して");
    unsubscribe();
    expect(stopped).toBe(true);

    const child = await requestWork(store);
    expect(child?.status).toBe("in_progress");
    expect(texts(controller, "notice").at(-1)).toContain(`/work resume ${child?.id}`);

    await controller.submit(`/work resume ${child?.id}`);
    expect(texts(controller, "notice").at(-1)).toContain("候補にしました");
    await controller.submit("集計の続きをお願い");

    expect((await store.get(child?.id as never)).status).toBe("completed");
    expect(texts(controller, "assistant").at(-1)).toBe("続きをやりました。");
    expect(controller.interrupt()).toBe(false);
  });

  test("Ctrl-C while a work waits for an answer takes the question back; continuing it asks again", async () => {
    const { controller, store } = await setup([
      workCreate("c1", "集計して"),
      callTools({ id: "c2", name: "ask_user", input: { question: "何月ですか" } }),
      selectCandidate("c3"),
      workComplete("c4", "7月分は 100 円"),
      say("7月分は 100 円です。"),
    ]);

    const turn = controller.submit("集計して");
    await waitFor(() => controller.state().question !== undefined);
    expect(controller.interrupt()).toBe(true);
    await turn;

    expect(controller.state().question).toBeUndefined();
    expect(controller.state().busy).toBe(false);
    const child = await requestWork(store);
    expect(child?.status).toBe("waiting_input");
    expect(texts(controller, "notice").at(-1)).toContain(`/work resume ${child?.id}`);

    await controller.submit(`/work resume ${child?.id}`);
    const resumed = controller.submit("集計の続きを");
    await waitFor(() => controller.state().question !== undefined);
    expect(controller.state().question).toBe("何月ですか");
    await controller.submit("7月");
    await resumed;

    expect((await store.get(child?.id as never)).status).toBe("completed");
    expect(texts(controller, "assistant").at(-1)).toBe("7月分は 100 円です。");
  });

  test("Ctrl-C stops a continued work as well, and it stays in progress", async () => {
    const { controller, store } = await setup([
      workCreate("c1", "集計して"),
      csvRead("c2"),
      selectCandidate("c3"),
      csvRead("c4"),
      say("never reached"),
    ]);
    // Stop at the next line about a tool call, inside the notification, before the model answers again.
    const stopAtToolLine = () => {
      const seen = controller.state().entries.filter((e) => e.text.includes("csv_read")).length;
      let stopped: boolean | undefined;
      const unsubscribe = controller.subscribe(() => {
        if (
          stopped === undefined &&
          controller.state().entries.filter((e) => e.text.includes("csv_read")).length > seen
        )
          stopped = controller.interrupt();
      });
      return () => {
        unsubscribe();
        return stopped;
      };
    };

    let result = stopAtToolLine();
    await controller.submit("集計して");
    expect(result()).toBe(true);
    const child = await requestWork(store);
    expect(child?.status).toBe("in_progress");

    await controller.submit(`/work resume ${child?.id}`);
    result = stopAtToolLine();
    await controller.submit("続けて");

    expect(result()).toBe(true);
    expect((await store.get(child?.id as never)).status).toBe("in_progress");
    expect(texts(controller, "notice").at(-1)).toContain(`/work resume ${child?.id}`);
    expect(controller.state().busy).toBe(false);
    expect(controller.interrupt()).toBe(false);
  });

  test("closing during a turn stops the turn first, then ends the session", async () => {
    const { controller, store } = await setup([], new HangingModel());

    const turn = controller.submit("やあ");
    await waitFor(() => controller.state().busy);
    const closed = controller.close();
    await Promise.all([closed, controller.close(), turn]);

    expect(controller.state().closed).toBe(true);
    expect((await store.get(controller.sessionId)).status).toBe("completed");
    expect(texts(controller, "notice").at(-1)).toBe("止めました。");
  });

  test("keeps control characters out of what the screen shows", async () => {
    const { controller } = await setup([say("\x1b[2J\x1b]0;x\x07こんにちは")]);

    await controller.submit("やあ");

    expect(texts(controller, "assistant")).toEqual(["こんにちは"]);
  });

  test("tells the screen when a turn ends, with busy off, and when a question is taken back", async () => {
    const { controller, store } = await setup([
      workCreate("c1", "集計して"),
      callTools({ id: "c2", name: "ask_user", input: { question: "何月ですか" } }),
      say("済み"),
    ]);
    const seen: { busy: boolean; question: string | undefined }[] = [];
    controller.subscribe(() => {
      const s = controller.state();
      seen.push({ busy: s.busy, question: s.question });
    });

    const turn = controller.submit("集計して");
    await waitFor(() => controller.state().question !== undefined);
    controller.interrupt();
    await turn;

    expect(seen.at(-1)).toEqual({ busy: false, question: undefined });
    expect(seen.some((s) => s.question === "何月ですか")).toBe(true);
    expect((await requestWork(store))?.status).toBe("waiting_input");
  });

  test("/quit while a work waits for an answer takes the question back and closes", async () => {
    const { controller, store } = await setup([
      workCreate("c1", "集計して"),
      callTools({ id: "c2", name: "ask_user", input: { question: "何月ですか" } }),
      say("never reached"),
    ]);

    const turn = controller.submit("集計して");
    await waitFor(() => controller.state().question !== undefined);
    await controller.submit("/quit");
    await turn;

    expect(controller.state().closed).toBe(true);
    expect((await store.get(controller.sessionId)).status).toBe("completed");
    expect((await requestWork(store))?.status).toBe("waiting_input");
  });

  test("slash commands print the CLI's own lines, and /quit closes the session", async () => {
    const { controller, store } = await setup([]);

    await controller.submit("/help");
    await controller.submit("/work list");
    await controller.submit("/tools");
    await controller.submit("/resume");
    await controller.submit("/work show");
    await controller.submit("/work resume work_nope");
    await controller.submit("/nope");
    await controller.submit("/quit");

    const lines = texts(controller, "line");
    expect(lines.some((l) => l.startsWith("/work resume"))).toBe(true);
    expect(lines.some((l) => l.includes(controller.sessionId))).toBe(true);
    expect(lines.some((l) => l.includes("fs_read"))).toBe(true);
    expect(texts(controller, "notice").at(-4)).toContain("/work resume <id>");
    expect(texts(controller, "notice").at(-3)).toContain("id が要ります");
    expect(texts(controller, "notice").at(-2)).toContain("work_nope");
    expect(texts(controller, "notice").at(-1)).toContain("/help");
    expect(controller.state().closed).toBe(true);
    expect((await store.get(controller.sessionId)).status).toBe("completed");
  });

  test("a held call opens the palette with the diff; approving runs it and the turn goes on", async () => {
    const { controller, store, root } = await setup(
      [
        workCreate("c1", "帳簿を更新"),
        callTools({
          id: "c2",
          name: "fs_write",
          input: { path: "ledger/2026-07.csv", content: "a,b\n1,2\n" },
        }),
        workComplete("c3", "更新しました"),
        say("帳簿を更新しました。"),
      ],
      undefined,
      { authority: true },
    );

    const turn = controller.submit("7 月の帳簿を書いて");
    await waitFor(() => controller.state().approval !== undefined);
    const approval = controller.state().approval as NonNullable<ControllerState["approval"]>;
    expect(approval.title).toBe("fs_write ledger/2026-07.csv");
    expect(approval.ruleId).toBe("ledger-needs-approval");
    expect(approval.choices.map((c) => c.key)).toEqual([
      "approve",
      "always",
      "reject",
      "reject_with_reason",
    ]);
    expect(approval.preview.map((l) => `${l.kind}:${l.text}`)).toEqual([
      "note:ledger/2026-07.csv を新しく作ります(3 行)",
      "added:a,b",
      "added:1,2",
      "added:",
    ]);
    expect(texts(controller, "progress")).toContain("+ a,b");
    // While the palette is up, typing says to decide first.
    await controller.submit("なにか");
    expect(texts(controller, "notice").at(-1)).toContain("承認を先に決めてください");

    controller.moveApproval(1);
    expect(controller.state().approval?.at).toBe(1);
    controller.moveApproval(-1);
    controller.decideApproval();
    await turn;

    expect(controller.state().approval).toBeUndefined();
    expect(texts(controller, "line")).toContain("> はい。実行する");
    expect(texts(controller, "assistant").at(-1)).toBe("帳簿を更新しました。");
    expect(await readFile(join(root, "ledger", "2026-07.csv"), "utf8")).toBe("a,b\n1,2\n");
    const work = (await requestWork(store)) as { status: string };
    expect(work.status).toBe("completed");
  });

  test("a call that needs a reviewer stops the turn and is recorded with /review", async () => {
    const { controller, store, root } = await setup(
      [
        workCreate("c1", "帳簿を更新"),
        callTools({
          id: "c2",
          name: "fs_write",
          input: { path: "ledger/2026-07.csv", content: "a\n" },
        }),
        selectCandidate("c3"),
        workComplete("c4", "更新しました"),
        say("記録しました。"),
      ],
      undefined,
      { authority: true, review: true },
    );

    await controller.submit("7 月の帳簿を書いて");

    // The palette never opens: a person cannot stand in for a qualified reviewer.
    expect(controller.state().approval).toBeUndefined();
    const notice = texts(controller, "notice").at(-1) ?? "";
    expect(notice).toContain("tax-accountantの判断が要ります");
    const approvalId = /apr_[0-9a-f-]+/.exec(notice)?.[0] as string;
    expect(notice).toContain(`/review ${approvalId}`);
    const work = (await requestWork(store)) as { status: string };
    expect(work.status).toBe("waiting_approval");
    expect(existsSync(join(root, "ledger", "2026-07.csv"))).toBe(false);

    await controller.submit("/review");
    expect(texts(controller, "notice").at(-1)).toContain("approve か");

    const recording = controller.submit(`/review ${approvalId} approve`);
    await waitFor(() => controller.state().question !== undefined);

    expect(texts(controller, "question").at(-1)).toContain("tax-accountant の名前");
    await controller.submit("田中 太郎 / 税理士");
    await waitFor(() => (texts(controller, "question").at(-1) ?? "").includes("判断の本文"));
    await controller.submit("この処理で進めてよい");
    await recording;

    expect(texts(controller, "line").at(-1)).toContain("田中 太郎");
    expect(await readFile(join(root, "ledger", "2026-07.csv"), "utf8")).toBe("a\n");
    const decided = (await store.events((await requestWork(store))?.id as never)).find(
      (e) => e.type === "review.decided",
    );
    expect((decided as { payload: { decisionId?: string } }).payload.decisionId).toMatch(/^dec_/);

    await controller.submit("続けて");
    expect(texts(controller, "assistant").at(-1)).toBe("記録しました。");
  });

  test("no, and tell the agent why: the reason is recorded and reaches the model", async () => {
    const { controller, store, root } = await setup(
      [
        workCreate("c1", "帳簿を更新"),
        callTools({
          id: "c2",
          name: "fs_write",
          input: { path: "ledger/2026-07.csv", content: "a\n" },
        }),
        (request) => {
          expect(JSON.stringify(request.messages.at(-2))).toContain("先に規程を直したい");
          return say("わかりました。規程を直してからにします。");
        },
      ],
      undefined,
      { authority: true },
    );

    const turn = controller.submit("7 月の帳簿を書いて");
    await waitFor(() => controller.state().approval !== undefined);
    controller.decideApproval("reject_with_reason");
    await waitFor(() => controller.state().reason !== undefined);
    expect(controller.state().approval).toBeUndefined();
    expect(texts(controller, "question").at(-1)).toContain("実行しない理由");

    await controller.submit("先に規程を直したい");
    await turn;

    expect(controller.state().reason).toBeUndefined();
    expect(existsSync(join(root, "ledger", "2026-07.csv"))).toBe(false);
    expect(texts(controller, "assistant").at(-1)).toBe("わかりました。規程を直してからにします。");
    const work = await requestWork(store);
    const decided = (await store.events(work?.id as never)).find(
      (e) => e.type === "approval.decided",
    );
    expect((decided as { payload: { comment?: string } }).payload.comment).toBe(
      "先に規程を直したい",
    );
  });

  test("always approves the rest of the conversation for that rule, and reject stops the call", async () => {
    const write = (id: string, month: string) =>
      callTools({
        id,
        name: "fs_write",
        input: { path: `ledger/2026-${month}.csv`, content: "a\n" },
      });
    const { controller, store, root } = await setup(
      [
        workCreate("c1", "帳簿"),
        write("c2", "07"),
        write("c3", "08"),
        workComplete("c4", "2 か月分"),
        say("2 か月分を書きました。"),
        workCreate("d1", "拒否される帳簿"),
        write("d2", "09"),
        say("書きませんでした。"),
      ],
      undefined,
      { authority: true },
    );

    const first = controller.submit("7 月と 8 月を書いて");
    await waitFor(() => controller.state().approval !== undefined);
    controller.decideApproval("always");
    await first;

    // The second write of the same rule never asked again.
    expect(await readFile(join(root, "ledger", "2026-08.csv"), "utf8")).toBe("a\n");
    expect(texts(controller, "assistant").at(-1)).toBe("2 か月分を書きました。");
    const decided = (await store.events((await requestWork(store))?.id as never)).filter(
      (e) => e.type === "approval.decided",
    );
    expect(decided).toHaveLength(2);
    expect((decided[0] as { payload: { comment?: string } }).payload.comment).toContain("常に承認");

    // A new work is a new rule match, but the standing yes covers it too: reject needs a new rule.
    const { controller: second, root: secondRoot } = await setup(
      [workCreate("e1", "帳簿"), write("e2", "09"), say("書きませんでした。")],
      undefined,
      { authority: true },
    );
    const turn = second.submit("9 月を書いて");
    await waitFor(() => second.state().approval !== undefined);
    second.decideApproval("reject");
    await turn;

    expect(existsSync(join(secondRoot, "ledger", "2026-09.csv"))).toBe(false);
    expect(texts(second, "line")).toContain("> いいえ。実行しない");
    expect(second.state().approval).toBeUndefined();
  });

  test("ignores empty lines and queues what is typed while busy, then sends it", async () => {
    const { controller } = await setup([
      workCreate("c1", "集計して"),
      csvRead("c2"),
      workComplete("c3", "done"),
      say("終わりました"),
      say("はい"),
    ]);

    await controller.submit("   ");
    expect(conversation(controller)).toHaveLength(0);

    const turn = controller.submit("集計して");
    await waitFor(() => controller.state().busy);
    await controller.submit("もう一つ");
    expect(controller.state().queued).toEqual(["もう一つ"]);
    expect(texts(controller, "notice").at(-1)).toBe("順番待ち(1 件): もう一つ");
    await turn;

    // The queued line is sent once the turn ends, and the queue empties.
    expect(controller.state().queued).toEqual([]);
    expect(texts(controller, "user")).toEqual(["集計して", "もう一つ"]);
    expect(texts(controller, "assistant")).toEqual(["終わりました", "はい"]);
  });
});
