import { describe, expect, test } from "bun:test";
import { markdownRows, type Span } from "./markdown.ts";

/** The rows as plain characters, which is what the reader sees without the styling. */
const plain = (source: string, width = 40) =>
  markdownRows(source, width).map((row) => row.map((s) => s.text).join(""));

/** The pieces of one row, with only the styles that were set. */
const styles = (source: string, row = 0, width = 40) =>
  (markdownRows(source, width)[row] ?? []).map((s: Span) => {
    const { text, ...rest } = s;
    return { text, ...rest };
  });

describe("a reply drawn from its markdown", () => {
  test("plain text is left as it is", () => {
    expect(plain("完了しました。")).toEqual(["完了しました。"]);
    expect(plain("完了しました。\n296 件です。")).toEqual(["完了しました。", "296 件です。"]);
    expect(plain("")).toEqual([""]);
  });

  test("a heading loses its marks and is drawn in bold", () => {
    expect(plain("## 7 月の集計")).toEqual(["7 月の集計"]);
    expect(styles("## 7 月の集計")).toEqual([{ text: "7 月の集計", bold: true, color: "cyan" }]);
  });

  test("emphasis and inline code are styled, and their marks are not shown", () => {
    expect(plain("**合計** は `123` 円、~~取消~~ と *強調* です。")).toEqual([
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
    expect(plain("[docs](https://openshain.jp/docs) を確認します。", 60)).toEqual([
      "docs (https://openshain.jp/docs) を確認します。",
    ]);
    expect(plain("https://openshain.jp を確認します。", 60)).toEqual([
      "https://openshain.jp を確認します。",
    ]);
  });

  test("list items get a marker, and what wraps is indented under it", () => {
    expect(plain("- 領収書を読む\n- 台帳に追記する")).toEqual([
      "• 領収書を読む",
      "• 台帳に追記する",
    ]);
    expect(plain("1. まず確認\n2. つぎに記録")).toEqual(["1. まず確認", "2. つぎに記録"]);
    expect(plain("- 長い項目を折り返して確認します。", 20)).toEqual([
      "• 長い項目を折り返し",
      "  て確認します。",
    ]);
  });

  test("a nested list is drawn under its parent with a marker of its own", () => {
    expect(plain("- 台帳に追記する\n  - 摘要をそろえる")).toEqual([
      "• 台帳に追記する",
      "  ◦ 摘要をそろえる",
    ]);
  });

  test("a code block keeps its content as written, behind a bar", () => {
    expect(plain("```bash\nopenshain work list\nopenshain work show w1\n```")).toEqual([
      "│ openshain work list",
      "│ openshain work show w1",
    ]);
    // The marks around a code block are never taken as emphasis inside it.
    expect(plain("```\n**そのまま**\n```")).toEqual(["│ **そのまま**"]);
  });

  test("a quote is drawn behind a bar and a rule fills the width", () => {
    expect(plain("> 原本は変更しません。")).toEqual(["▎ 原本は変更しません。"]);
    expect(plain("---", 8)).toEqual(["────────"]);
  });

  test("a table is shown as it was written, so nothing in it is lost", () => {
    expect(plain("| 科目 | 金額 |\n|---|---|\n| 交通費 | 1,200 |", 60)).toEqual([
      "| 科目 | 金額 |",
      "|---|---|",
      "| 交通費 | 1,200 |",
    ]);
  });

  test("blocks are separated by one blank row, with none at either end", () => {
    expect(plain("## 見出し\n\n本文です。\n\n- 項目")).toEqual([
      "見出し",
      "",
      "本文です。",
      "",
      "• 項目",
    ]);
  });

  test("Japanese wraps at the display width, counting a character as two columns", () => {
    expect(plain("領収書を集計しました", 6)).toEqual(["領収書", "を集計", "しまし", "た"]);
  });
});
