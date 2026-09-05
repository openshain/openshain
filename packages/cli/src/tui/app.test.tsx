import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./app.tsx";
import type { Controller, ControllerState, Entry } from "./controller.ts";

function fakeController() {
  const submitted: string[] = [];
  const listeners = new Set<() => void>();
  const state: ControllerState = {
    entries: [
      { id: 1, kind: "user", text: "やあ" },
      { id: 2, kind: "assistant", text: "こんにちは" },
      { id: 3, kind: "progress", text: "  csv_read receipts/2026-07.csv" },
    ],
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
  const add = (entry: Entry) => {
    state.entries = [...state.entries, entry];
    for (const l of listeners) l();
  };
  return { controller, submitted, state, add };
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

  test("shows a line that arrives after the first render, such as the reply", async () => {
    const { controller, add } = fakeController();

    const { frames } = render(<App controller={controller} />);
    await tick();
    add({ id: 4, kind: "assistant", text: "集計しました。" });
    await tick();

    expect(frames.join("\n")).toContain("集計しました。");
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

  test("a chunk that ends in a newline, such as a pasted line, is submitted as one line", async () => {
    const { controller, submitted } = fakeController();

    const { stdin, lastFrame } = render(<App controller={controller} />);
    await tick();
    stdin.write("集計して\r");
    await tick();
    stdin.write("続き\r\n残り");
    await tick();

    expect(submitted).toEqual(["集計して", "続き"]);
    expect(lastFrame()).toContain("> 残り");
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
