import { describe, expect, test } from "bun:test";
import { describeInput, displayWidth, padDisplay, truncate } from "./format.ts";

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
