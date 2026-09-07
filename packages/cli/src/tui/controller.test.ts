import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
import { type Controller, createController } from "./controller.ts";

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

async function setup(steps: FakeStep[], given?: ModelProvider) {
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

  test("ignores empty lines and refuses a new message while busy", async () => {
    const { controller } = await setup([
      workCreate("c1", "集計して"),
      csvRead("c2"),
      workComplete("c3", "done"),
      say("終わりました"),
    ]);

    await controller.submit("   ");
    expect(conversation(controller)).toHaveLength(0);

    const turn = controller.submit("集計して");
    await waitFor(() => controller.state().busy);
    await controller.submit("もう一つ");
    await turn;

    expect(texts(controller, "notice")).toContain("いま動いています。止めるなら Ctrl-C。");
    expect(texts(controller, "assistant")).toEqual(["終わりました"]);
  });
});
