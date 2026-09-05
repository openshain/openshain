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

  test("keeps a logo row whole and colors it from the left edge to the right", () => {
    const [row] = screenLines([{ id: 1, kind: "logo", text: " ╔═╗ ╔═╗" }], 4);

    expect(row?.text).toBe(" ╔═╗ ╔═╗");
    expect(row?.segments?.[0]).toEqual({ text: " ", color: "#4ea8ff", at: 0 });
    expect(row?.segments?.at(-1)).toEqual({ text: "╗", color: "#7f88ff", at: 7 });
  });

  test("shows the banner rows without markers or blank rows between them", () => {
    const lines = screenLines(
      [
        { id: 1, kind: "logo", text: "╔╗" },
        { id: 2, kind: "banner", text: "openshain 0.1.0" },
        { id: 3, kind: "banner", text: "/home/alice/sample-company" },
        { id: 4, kind: "user", text: "やあ" },
      ],
      40,
    );

    expect(lines.map((l) => l.text)).toEqual([
      "╔╗",
      "openshain 0.1.0",
      "/home/alice/sample-company",
      "",
      "> やあ",
    ]);
  });

  test("wraps a long entry after its marker", () => {
    const lines = screenLines([{ id: 1, kind: "assistant", text: "a".repeat(30) }], 20);

    expect(lines.map((l) => l.text)).toEqual([`⏺ ${"a".repeat(18)}`, `  ${"a".repeat(12)}`]);
  });
});
