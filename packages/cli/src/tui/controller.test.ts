import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_NAMES } from "@openshain/agent";
import { callTools, FakeModelProvider, type FakeStep, say } from "@openshain/agent/testing";
import {
  createRuntime,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type RuntimeProviders,
} from "@openshain/core";
import { standardTools } from "@openshain/tools";
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
  const runtime = await createRuntime({ workspaceRoot: root, providers });
  const controller = await createController({ workspaceRoot: root, providers, runtime });
  return { root, runtime, controller };
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

describe("the screen's controller", () => {
  test("shows what the person says and what the model replies", async () => {
    const { controller } = await setup([say("こんにちは")]);
    const before = controller.state().entries;

    await controller.submit("やあ");

    // A new array each time: the screen's Static only draws items when the array changes.
    expect(controller.state().entries).not.toBe(before);
    expect(controller.state().entries.map((e) => [e.kind, e.text])).toEqual([
      ["user", "やあ"],
      ["assistant", "こんにちは"],
    ]);
    expect(controller.state().busy).toBe(false);
    expect(controller.state().status.usage.modelCalls).toBe(1);
    expect(AGENT_NAMES.ja).toContain(controller.state().status.agentName ?? "");
  });

  test("streams a work's progress and routes its question to the person", async () => {
    const { controller } = await setup([
      callTools({ id: "s1", name: "work_run", input: { objective: "集計して" } }),
      callTools({ id: "c1", name: "csv_read", input: { path: "receipts/2026-07.csv" } }),
      callTools({ id: "c2", name: "ask_user", input: { question: "何月ですか" } }),
      say("7月分は 100 円"),
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

  test("stops a running work on interrupt and resumes it on /work resume", async () => {
    const { controller, runtime } = await setup([
      callTools({ id: "s1", name: "work_run", input: { objective: "集計して" } }),
      callTools({ id: "c1", name: "csv_read", input: { path: "receipts/2026-07.csv" } }),
      say("続きをやりました"),
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

    const child = (await runtime.works.list()).works.find((w) => w.type === "request");
    expect(child?.status).toBe("in_progress");
    expect(texts(controller, "notice").at(-1)).toContain(`/work resume ${child?.id}`);

    await controller.submit(`/work resume ${child?.id}`);

    expect((await runtime.works.get(child?.id as never)).status).toBe("completed");
    expect(texts(controller, "line").some((l) => l.includes("続きをやりました"))).toBe(true);
    expect(controller.interrupt()).toBe(false);
  });

  test("Ctrl-C while a work waits for an answer takes the question back, and /work resume asks again", async () => {
    const { controller, runtime } = await setup([
      callTools({ id: "s1", name: "work_run", input: { objective: "集計して" } }),
      callTools({ id: "c1", name: "ask_user", input: { question: "何月ですか" } }),
      say("7月分は 100 円"),
    ]);

    const turn = controller.submit("集計して");
    await waitFor(() => controller.state().question !== undefined);
    expect(controller.interrupt()).toBe(true);
    await turn;

    expect(controller.state().question).toBeUndefined();
    expect(controller.state().busy).toBe(false);
    const child = (await runtime.works.list()).works.find((w) => w.type === "request");
    expect(child?.status).toBe("waiting_input");
    expect(texts(controller, "notice").at(-1)).toContain(`/work resume ${child?.id}`);

    const resumed = controller.submit(`/work resume ${child?.id}`);
    await waitFor(() => controller.state().question !== undefined);
    await controller.submit("7月");
    await resumed;

    expect((await runtime.works.get(child?.id as never)).status).toBe("completed");
    expect(texts(controller, "line").some((l) => l.includes("7月分は 100 円"))).toBe(true);
  });

  test("Ctrl-C stops a work that /work resume is driving", async () => {
    const { controller, runtime } = await setup([
      callTools({ id: "s1", name: "work_run", input: { objective: "集計して" } }),
      callTools({ id: "c1", name: "csv_read", input: { path: "receipts/2026-07.csv" } }),
      callTools({ id: "c2", name: "csv_read", input: { path: "receipts/2026-07.csv" } }),
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
    const child = (await runtime.works.list()).works.find((w) => w.type === "request");
    expect(child?.status).toBe("in_progress");

    result = stopAtToolLine();
    await controller.submit(`/work resume ${child?.id}`);

    expect(result()).toBe(true);
    expect((await runtime.works.get(child?.id as never)).status).toBe("in_progress");
    expect(texts(controller, "notice").at(-1)).toContain(`/work resume ${child?.id}`);
    expect(controller.state().busy).toBe(false);
    expect(controller.interrupt()).toBe(false);
  });

  test("closing during a turn stops the turn first, then ends the session", async () => {
    const { controller, runtime } = await setup([], new HangingModel());

    const turn = controller.submit("やあ");
    await waitFor(() => controller.state().busy);
    const closed = controller.close();
    await Promise.all([closed, controller.close(), turn]);

    expect(controller.state().closed).toBe(true);
    expect((await runtime.works.get(controller.sessionId)).status).toBe("completed");
    expect(texts(controller, "notice").at(-1)).toBe("止めました。");
  });

  test("keeps control characters out of what the screen shows", async () => {
    const { controller } = await setup([say("\x1b[2J\x1b]0;x\x07こんにちは")]);

    await controller.submit("やあ");

    expect(texts(controller, "assistant")).toEqual(["こんにちは"]);
  });

  test("slash commands print the CLI's own lines, and /quit closes the session", async () => {
    const { controller, runtime } = await setup([]);

    await controller.submit("/help");
    await controller.submit("/work list");
    await controller.submit("/tools");
    await controller.submit("/resume");
    await controller.submit("/nope");
    await controller.submit("/quit");

    const lines = texts(controller, "line");
    expect(lines.some((l) => l.startsWith("/work resume"))).toBe(true);
    expect(lines.some((l) => l.includes(controller.sessionId))).toBe(true);
    expect(lines.some((l) => l.includes("fs_read"))).toBe(true);
    expect(texts(controller, "notice").at(-2)).toContain("/work resume <id>");
    expect(texts(controller, "notice").at(-1)).toContain("/help");
    expect(controller.state().closed).toBe(true);
    expect((await runtime.works.get(controller.sessionId)).status).toBe("completed");
  });

  test("ignores empty lines and refuses a new message while busy", async () => {
    const { controller } = await setup([
      callTools({ id: "s1", name: "work_run", input: { objective: "集計して" } }),
      callTools({ id: "c1", name: "csv_read", input: { path: "receipts/2026-07.csv" } }),
      say("done"),
      say("終わりました"),
    ]);

    await controller.submit("   ");
    expect(controller.state().entries).toHaveLength(0);

    const turn = controller.submit("集計して");
    await waitFor(() => controller.state().busy);
    await controller.submit("もう一つ");
    await turn;

    expect(texts(controller, "notice")).toContain("いま動いています。止めるなら Ctrl-C。");
    expect(texts(controller, "assistant")).toEqual(["終わりました"]);
  });
});
