import { describe, expect, test } from "bun:test";
import { describeInput, displayWidth, padDisplay, plain, truncate } from "./format.ts";

describe("display width", () => {
  test("counts Japanese characters as two columns", () => {
    expect(displayWidth("abc")).toBe(3);
    expect(displayWidth("完了")).toBe(4);
    expect(displayWidth("Work 1")).toBe(6);
  });

  test("pads to a display width so mixed columns line up", () => {
    expect(padDisplay("完了", 6)).toBe("完了  ");
    expect(padDisplay("queued", 6)).toBe("queued");
    expect(padDisplay("利用者の入力待ち", 8)).toBe("利用者の入力待ち");
  });
});

describe("tool inputs on one line", () => {
  test("shows the path, hides a question, and shortens anything else", () => {
    expect(describeInput({ path: "a.md", content: "x" })).toBe("a.md");
    expect(describeInput({ question: "どの月?" })).toBe("");
    expect(describeInput({ rows: [1, 2] })).toBe('{"rows":[1,2]}');
    expect(truncate("x".repeat(100))).toHaveLength(80);
  });
});

describe("text for the terminal", () => {
  test("drops escape sequences and other control characters, keeping newlines and tabs", () => {
    expect(plain("\x1b[2J\x1b]0;title\x07完了\r")).toBe("完了");
    expect(plain("\x1b[31m赤\x1b[0m \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\")).toBe(
      "赤 link",
    );
    expect(plain("\x1b(B\x1b7a\x9b1;2Hb\x1b")).toBe("ab");
    expect(plain("a\tb\nc\x7f\x9b")).toBe("a\tb\nc");
    expect(plain("受領書 2026-07.csv")).toBe("受領書 2026-07.csv");
  });
});
