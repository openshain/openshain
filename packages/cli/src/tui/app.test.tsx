import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "./app.tsx";
import type { Controller, ControllerState, Entry } from "./controller.ts";

function fakeController(entries?: Entry[]) {
  const submitted: string[] = [];
  const decided: string[] = [];
  const listeners = new Set<() => void>();
  const state: ControllerState = {
    entries: entries ?? [
      { id: 1, kind: "user", text: "やあ" },
      { id: 2, kind: "assistant", text: "こんにちは" },
      { id: 3, kind: "progress", text: "csv_read receipts/2026-07.csv" },
    ],
    busy: false,
    closed: false,
    queued: [],
    status: {
      company: "サンプル株式会社",
      model: "fake/fake-1",
      agentName: "みなと",
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
    moveApproval(delta) {
      const approval = state.approval;
      if (!approval) return;
      const count = approval.choices.length;
      state.approval = { ...approval, at: (approval.at + delta + count) % count };
      for (const l of listeners) l();
    },
    decideApproval(choice) {
      decided.push(choice ?? state.approval?.choices[state.approval.at]?.key ?? "reject");
      delete state.approval;
      for (const l of listeners) l();
    },
    async close() {
      state.closed = true;
      for (const l of listeners) l();
    },
  };
  const add = (entry: Entry) => {
    state.entries = [...state.entries, entry];
    for (const l of listeners) l();
  };
  return { controller, submitted, decided, state, add };
}

const tick = () => new Promise((r) => setTimeout(r, 30));

describe("the screen", () => {
  test("shows the header, the conversation with its markers, the input box and the status line", () => {
    const { controller } = fakeController();

    const { lastFrame } = render(<App controller={controller} />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("openshain · サンプル株式会社 · 社員エージェント みなと · fake/fake-1");
    expect(frame).toContain("> やあ");
    expect(frame).toContain("⏺ こんにちは");
    expect(frame).toContain("⎿ csv_read receipts/2026-07.csv");
    expect(frame).toContain("╭");
    expect(frame).toContain("model 1 回、入力 10、出力 5 トークン");
  });

  test("shows a reply with its markdown drawn, not with its marks", async () => {
    const { controller, add } = fakeController([]);
    const { lastFrame } = render(<App controller={controller} />);
    add({
      id: 9,
      kind: "assistant",
      text: "## 集計\n\n**合計** は `123` 円です。\n\n- 領収書を読む",
    });
    await tick();

    const frame = lastFrame() ?? "";
    expect(frame).toContain("⏺ 集計");
    expect(frame).toContain("合計 は 123 円です。");
    expect(frame).toContain("• 領収書を読む");
    expect(frame).not.toContain("**");
    expect(frame).not.toContain("## ");
  });

  test("draws the wordmark with its gradient and the banner rows", () => {
    const { controller } = fakeController([
      { id: 1, kind: "logo", text: " ╔═╗ ╔═╗" },
      { id: 2, kind: "banner", text: "openshain 0.1.0" },
      { id: 3, kind: "banner", text: "/home/alice/sample-company" },
    ]);

    const { lastFrame } = render(<App controller={controller} />);

    const frame = lastFrame() ?? "";
    expect(frame).toContain(" ╔═╗ ╔═╗");
    expect(frame).toContain("openshain 0.1.0");
    expect(frame).toContain("/home/alice/sample-company");
  });

  test("shows a line that arrives after the first render, such as the reply", async () => {
    const { controller, add } = fakeController();

    const { lastFrame } = render(<App controller={controller} />);
    await tick();
    add({ id: 4, kind: "assistant", text: "集計しました。" });
    await tick();

    expect(lastFrame()).toContain("⏺ 集計しました。");
  });

  test("keeps the newest rows in view when the conversation overflows, and PageUp scrolls back", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      kind: "line" as const,
      text: `行${i + 1}`,
    }));
    const { controller } = fakeController(many);

    const { stdin, lastFrame } = render(<App controller={controller} />);
    await tick();
    expect(lastFrame()).toContain("行40");
    expect(lastFrame()).not.toMatch(/行1(?!\d)/);

    stdin.write("\x1b[5~");
    await tick();
    expect(lastFrame()).toContain("行上を表示中");
    expect(lastFrame()).not.toContain("行40");

    stdin.write("\x1b[6~");
    await tick();
    expect(lastFrame()).toContain("行40");
  });

  test("the cursor moves in the input, and typing, Backspace and Delete act where it is", async () => {
    const { controller, submitted } = fakeController();

    const { stdin, lastFrame } = render(<App controller={controller} />);
    await tick();
    stdin.write("abc");
    await tick();
    stdin.write("\x1b[D");
    await tick();
    stdin.write("\x1b[D");
    await tick();
    stdin.write("X");
    await tick();
    expect(lastFrame()).toContain("> aXbc");
    stdin.write("\x1b[H");
    await tick();
    stdin.write("Y");
    await tick();
    stdin.write("\x1b[F");
    await tick();
    stdin.write("\x7f");
    await tick();
    stdin.write("\x1b[H");
    await tick();
    stdin.write("\x1b[3~");
    await tick();
    stdin.write("\r");
    await tick();

    expect(submitted).toEqual(["aXb"]);
  });

  test("the up and down arrows recall the lines sent before, with the new line at the bottom", async () => {
    const { controller, submitted } = fakeController();

    const { stdin, lastFrame } = render(<App controller={controller} />);
    await tick();
    stdin.write("最初\r");
    await tick();
    stdin.write("二番目\r");
    await tick();
    stdin.write("途中");
    await tick();
    stdin.write("\x1b[A");
    await tick();
    expect(lastFrame()).toContain("> 二番目▌");
    stdin.write("\x1b[A");
    await tick();
    expect(lastFrame()).toContain("> 最初▌");
    stdin.write("\x1b[A");
    await tick();
    expect(lastFrame()).toContain("> 最初▌");
    stdin.write("\x1b[B");
    await tick();
    expect(lastFrame()).toContain("> 二番目▌");
    stdin.write("\x1b[B");
    await tick();
    expect(lastFrame()).toContain("> 途中▌");
    stdin.write("\x1b[B");
    await tick();
    expect(lastFrame()).toContain("> 途中▌");

    expect(submitted).toEqual(["最初", "二番目"]);
  });

  test("the mouse wheel scrolls the conversation and leaves the input alone", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: i + 1,
      kind: "line" as const,
      text: `行${i + 1}`,
    }));
    const { controller } = fakeController(many);

    const { stdin, lastFrame } = render(<App controller={controller} />);
    await tick();
    stdin.write("\x1b[<64;10;5M");
    await tick();
    expect(lastFrame()).toContain("↑ 3 行上を表示中");
    expect(lastFrame()).toContain("> ▌");
    stdin.write("\x1b[<65;10;5M\x1b[<65;10;5M");
    await tick();
    expect(lastFrame()).toContain("行40");
    expect(lastFrame()).not.toContain("[<");
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

describe("the approval palette", () => {
  test("shows the choices, moves with the arrows, picks with a number, and rejects with Esc", async () => {
    const { controller, decided, state, add: push } = fakeController();
    state.approval = {
      approvalId: "apr_1",
      title: "fs_write ledger/2026-07.csv",
      ruleId: "ledger-needs-approval",
      preview: [{ kind: "added", text: "a,b" }],
      choices: [
        { key: "approve", label: "はい。実行する" },
        { key: "always", label: "はい。この会話では同じ規則の呼び出しを常に承認する" },
        { key: "reject", label: "いいえ。実行しない" },
        { key: "reject_with_reason", label: "いいえ。理由を伝えて実行しない" },
      ],
      at: 0,
    };
    const { lastFrame, stdin } = render(<App controller={controller} />);
    await tick();

    expect(lastFrame()).toContain("承認が要ります: fs_write ledger/2026-07.csv");
    expect(lastFrame()).toContain("規則 ledger-needs-approval");
    expect(lastFrame()).toContain("❯ 1. はい。実行する");
    expect(lastFrame()).toContain("↑ ↓ と Enter、または数字で選ぶ");

    stdin.write("\u001B[B");
    await tick();
    expect(lastFrame()).toContain("❯ 2.");

    stdin.write("\r");
    await tick();
    expect(decided).toEqual(["always"]);

    state.approval = {
      approvalId: "apr_2",
      title: "fs_write x",
      ruleId: "r",
      preview: [],
      choices: [
        { key: "approve", label: "はい" },
        { key: "always", label: "常に" },
        { key: "reject", label: "いいえ" },
      ],
      at: 0,
    };
    push({ id: 9, kind: "notice", text: "another" });
    await tick();
    stdin.write("\u001B");
    await tick();
    expect(decided).toEqual(["always", "reject"]);
  });

  test("the queued lines are listed under the input box", async () => {
    const { controller, state } = fakeController();
    state.queued = ["あとで集計して", "月末の確認も"];
    const { lastFrame } = render(<App controller={controller} />);
    await tick();

    expect(lastFrame()).toContain("順番待ち 2 件: あとで集計して / 月末の確認も");
  });

  test("typing does not reach the input while the palette is up", async () => {
    const { controller, submitted, state } = fakeController();
    state.approval = {
      approvalId: "apr_1",
      title: "t",
      ruleId: "r",
      preview: [],
      choices: [{ key: "approve", label: "はい" }],
      at: 0,
    };
    const { stdin } = render(<App controller={controller} />);
    await tick();

    stdin.write("abc\r");
    await tick();

    expect(submitted).toEqual([]);
  });
});
