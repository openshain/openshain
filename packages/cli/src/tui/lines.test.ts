import { describe, expect, test } from "bun:test";
import { screenLines, wrapText } from "./lines.ts";

describe("wrapping for the screen", () => {
  test("breaks at the display width, counting Japanese characters as two columns", () => {
    expect(wrapText("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    expect(wrapText("領収書を集計", 6)).toEqual(["領収書", "を集計"]);
    expect(wrapText("一行目\n二行目", 10)).toEqual(["一行目", "二行目"]);
    expect(wrapText("", 10)).toEqual([""]);
  });

  test("marks each kind, indents continuation rows and separates blocks with a blank row", () => {
    const lines = screenLines(
      [
        { id: 1, kind: "user", text: "7月の領収書を集計して" },
        { id: 2, kind: "progress", text: "csv_read receipt/2026-07.csv" },
        { id: 3, kind: "progress", text: "完了。" },
        { id: 4, kind: "assistant", text: "完了しました。\n296 件です。" },
        { id: 5, kind: "user", text: "ありがとう" },
      ],
      40,
    );

    expect(lines.map((l) => l.text)).toEqual([
      "> 7月の領収書を集計して",
      "",
      "  ⎿ csv_read receipt/2026-07.csv",
      "  ⎿ 完了。",
      "",
      "⏺ 完了しました。",
      "  296 件です。",
      "",
      "> ありがとう",
    ]);
    expect(lines[1]?.kind).toBe("blank");
    expect(lines[5]?.kind).toBe("assistant");
  });

  test("wraps a long entry after its marker", () => {
    const lines = screenLines([{ id: 1, kind: "assistant", text: "a".repeat(30) }], 20);

    expect(lines.map((l) => l.text)).toEqual([`⏺ ${"a".repeat(18)}`, `  ${"a".repeat(12)}`]);
  });
});
