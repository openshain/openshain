import { describe, expect, test } from "bun:test";
import { plain } from "../format.ts";
import { markdownRows, type Span } from "./markdown.ts";

/** The rows as plain characters, which is what the reader sees without the styling. */
const rowsOf = (source: string, width = 40) =>
  markdownRows(source, width).map((row) => row.map((s) => s.text).join(""));

/** The pieces of one row, with only the styles that were set. */
const styles = (source: string, row = 0, width = 40) =>
  (markdownRows(source, width)[row] ?? []).map((s: Span) => {
    const { text, ...rest } = s;
    return { text, ...rest };
  });

describe("a reply drawn from its markdown", () => {
  test("plain text is left as it is", () => {
    expect(rowsOf("完了しました。")).toEqual(["完了しました。"]);
    expect(rowsOf("完了しました。\n296 件です。")).toEqual(["完了しました。", "296 件です。"]);
    expect(rowsOf("")).toEqual([""]);
  });

  test("a heading loses its marks and is drawn in bold", () => {
    expect(rowsOf("## 7 月の集計")).toEqual(["7 月の集計"]);
    expect(styles("## 7 月の集計")).toEqual([{ text: "7 月の集計", bold: true, color: "cyan" }]);
  });

  test("emphasis and inline code are styled, and their marks are not shown", () => {
    expect(rowsOf("**合計** は `123` 円、~~取消~~ と *強調* です。")).toEqual([
      "合計 は 123 円、取消 と 強調 です。",
    ]);
    expect(styles("**合計** は `123` 円")).toEqual([
      { text: "合計", bold: true },
      { text: " は " },
      { text: "123", color: "green" },
      { text: " 円" },
    ]);
    expect(styles("~~取消~~ と *強調*")).toMatchObject([
      { text: "取消", strikethrough: true },
      { text: " と " },
      { text: "強調", italic: true },
    ]);
  });

  test("a link shows its label and where it goes, and a bare address is not repeated", () => {
    expect(rowsOf("[docs](https://openshain.jp/docs) を確認します。", 60)).toEqual([
      "docs (https://openshain.jp/docs) を確認します。",
    ]);
    expect(rowsOf("https://openshain.jp を確認します。", 60)).toEqual([
      "https://openshain.jp を確認します。",
    ]);
  });

  test("list items get a marker, and what wraps is indented under it", () => {
    expect(rowsOf("- 領収書を読む\n- 台帳に追記する")).toEqual([
      "• 領収書を読む",
      "• 台帳に追記する",
    ]);
    expect(rowsOf("1. まず確認\n2. つぎに記録")).toEqual(["1. まず確認", "2. つぎに記録"]);
    expect(rowsOf("- 長い項目を折り返して確認します。", 20)).toEqual([
      "• 長い項目を折り返し",
      "  て確認します。",
    ]);
  });

  test("a nested list is drawn under its parent with a marker of its own", () => {
    expect(rowsOf("- 台帳に追記する\n  - 摘要をそろえる")).toEqual([
      "• 台帳に追記する",
      "  ◦ 摘要をそろえる",
    ]);
  });

  test("a code block keeps its content as written, behind a bar", () => {
    expect(rowsOf("```bash\nopenshain work list\nopenshain work show w1\n```")).toEqual([
      "│ openshain work list",
      "│ openshain work show w1",
    ]);
    // The marks around a code block are never taken as emphasis inside it.
    expect(rowsOf("```\n**そのまま**\n```")).toEqual(["│ **そのまま**"]);
  });

  test("a quote is drawn behind a bar and a rule fills the width", () => {
    expect(rowsOf("> 原本は変更しません。")).toEqual(["▎ 原本は変更しません。"]);
    expect(rowsOf("---", 8)).toEqual(["────────"]);
  });

  test("a table is shown as it was written, so nothing in it is lost", () => {
    expect(rowsOf("| 科目 | 金額 |\n|---|---|\n| 交通費 | 1,200 |", 60)).toEqual([
      "| 科目 | 金額 |",
      "|---|---|",
      "| 交通費 | 1,200 |",
    ]);
  });

  test("blocks are separated by one blank row, with none at either end", () => {
    expect(rowsOf("## 見出し\n\n本文です。\n\n- 項目")).toEqual([
      "見出し",
      "",
      "本文です。",
      "",
      "• 項目",
    ]);
  });

  test("what a model writes cannot reach the terminal as an escape sequence", () => {
    // The text is cleaned once, where it is added to the conversation. Nothing here may put a
    // control character back: an entity stays the characters it was written as.
    const written = "&#27;[2J と `&#x1b;[31m` と [x](https://x.test/&#x1b;[2J)";
    expect(rowsOf(plain(written), 80).join("")).toBe(
      "&#27;[2J と &#x1b;[31m と x (https://x.test/&#x1b;[2J)",
    );
    for (const row of markdownRows("&#27;[2J&#x1b;]0;title&#7;", 60)) {
      for (const span of row) {
        expect([...span.text].every((c) => (c.codePointAt(0) ?? 0) >= 0x20)).toBe(true);
      }
    }
  });

  test("a reply too long to read as markdown is shown whole, as it was written", () => {
    const long = `**強調**${"あ".repeat(20_000)}`;

    const rows = markdownRows(long, 40);

    expect(
      rows
        .flat()
        .map((s) => s.text)
        .join(""),
    ).toBe(long);
    expect(rows.every((row) => row.every((span) => span.bold === undefined))).toBe(true);
  });

  test("Japanese wraps at the display width, counting a character as two columns", () => {
    expect(rowsOf("領収書を集計しました", 6)).toEqual(["領収書", "を集計", "しまし", "た"]);
  });
});
