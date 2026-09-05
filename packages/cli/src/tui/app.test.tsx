import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./app.tsx";
import type { Controller, ControllerState } from "./controller.ts";

function fakeController() {
  const submitted: string[] = [];
  const listeners = new Set<() => void>();
  const state: ControllerState = {
    settled: [
      { id: 1, kind: "user", text: "やあ" },
      { id: 2, kind: "assistant", text: "こんにちは" },
    ],
    live: [{ id: 3, kind: "progress", text: "  csv_read receipts/2026-07.csv" }],
    busy: false,
    closed: false,
    status: {
      company: "サンプル株式会社",
      model: "fake/fake-1",
      usage: { modelCalls: 1, inputTokens: 10, outputTokens: 5 },
    },
  };
  const controller: Controller = {
    sessionId: "work_test" as never,
    state: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async submit(line) {
      submitted.push(line);
    },
    interrupt: () => false,
    async close() {
      state.closed = true;
      for (const l of listeners) l();
    },
  };
  return { controller, submitted, state };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("the screen", () => {
  test("shows the conversation, the progress and the status line", () => {
    const { controller } = fakeController();

    const { lastFrame } = render(<App controller={controller} />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("> やあ");
    expect(frame).toContain("こんにちは");
    expect(frame).toContain("csv_read receipts/2026-07.csv");
    expect(frame).toContain("サンプル株式会社 | fake/fake-1");
    expect(frame).toContain("model 1 回、入力 10、出力 5 トークン");
  });

  test("echoes what is typed and hands the line to the controller on Enter", async () => {
    const { controller, submitted } = fakeController();

    const { stdin, lastFrame } = render(<App controller={controller} />);
    await tick();
    stdin.write("集計");
    await tick();
    expect(lastFrame()).toContain("> 集計");
    stdin.write("\x7f");
    await tick();
    expect(lastFrame()).not.toContain("> 集計");
    stdin.write("計して");
    await tick();
    stdin.write("\r");
    await tick();

    expect(submitted).toEqual(["集計して"]);
  });

  test("Ctrl-C with nothing running closes the screen", async () => {
    const { controller, state } = fakeController();

    const { stdin } = render(<App controller={controller} />);
    await tick();
    stdin.write("\x03");
    await tick();

    expect(state.closed).toBe(true);
  });
});
