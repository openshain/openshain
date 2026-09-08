import { displayWidth } from "../format.ts";
import { logoSegments } from "./banner.ts";
import type { Entry, EntryKind } from "./controller.ts";
import { markdownRows, type Span } from "./markdown.ts";

export interface ScreenLine {
  kind: EntryKind | "blank";
  /** The row as plain characters, marker included. */
  text: string;
  /** The row as styled pieces: a logo row, or a reply the screen drew from its markdown. */
  spans?: Span[];
}

/** What starts a line of each kind. The continuation lines of a wrapped entry are indented to match. */
const MARKERS: Record<EntryKind, string> = {
  user: "> ",
  assistant: "⏺ ",
  progress: "  ⎿ ",
  notice: "! ",
  question: "? ",
  line: "  ",
  logo: "",
  banner: "",
};

/** Breaks text into lines no wider than `width` display columns, counting East Asian wide characters as two. */
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let used = 0;
    for (const ch of paragraph) {
      const w = displayWidth(ch);
      if (used + w > width && line !== "") {
        out.push(line);
        line = "";
        used = 0;
      }
      line += ch;
      used += w;
    }
    out.push(line);
  }
  return out;
}

/**
 * The rows of one reply, kept until the entry goes or the width changes. The screen redraws
 * every entry whenever a line is added, and reading markdown is the expensive part of that.
 */
const drawn = new WeakMap<Entry, { width: number; rows: Span[][] }>();

export function rowsFor(entry: Entry, width: number): Span[][] {
  const held = drawn.get(entry);
  if (held && held.width === width) return held.rows;
  const rows = markdownRows(entry.text, width);
  drawn.set(entry, { width, rows });
  return rows;
}

/** A blank row goes before an entry that starts something new: a message, a reply, a notice, a question. */
function startsBlock(kind: EntryKind, previous: EntryKind | undefined): boolean {
  if (previous === undefined) return false;
  if (kind === "logo" || kind === "banner") return false;
  if (kind === "progress") return previous === "user";
  if (kind === "line") return previous !== "line";
  return true;
}

/** The rows the screen shows for the entries, wrapped to the width, with markers and blank rows between blocks. */
export function screenLines(entries: readonly Entry[], width: number): ScreenLine[] {
  const lines: ScreenLine[] = [];
  let previous: EntryKind | undefined;
  for (const entry of entries) {
    if (startsBlock(entry.kind, previous)) lines.push({ kind: "blank", text: "" });
    if (entry.kind === "logo") {
      // Never wrapped: a cut row of the wordmark reads better than a broken one.
      lines.push({ kind: "logo", text: entry.text, spans: logoSegments(entry.text) });
      previous = entry.kind;
      continue;
    }
    const marker = MARKERS[entry.kind];
    const indent = " ".repeat(displayWidth(marker));
    const room = Math.max(8, width - displayWidth(marker));
    if (entry.kind === "assistant") {
      // The reply is written in markdown; the screen draws it rather than showing its marks.
      for (const [i, row] of rowsFor(entry, room).entries()) {
        // A row with nothing on it is drawn as an empty one: no marker, no indent, no pieces.
        if (row.length === 0) {
          lines.push({ kind: entry.kind, text: "" });
          continue;
        }
        const spans = [{ text: i === 0 ? marker : indent }, ...row];
        lines.push({ kind: entry.kind, text: spans.map((s) => s.text).join(""), spans });
      }
      previous = entry.kind;
      continue;
    }
    for (const [i, text] of wrapText(entry.text, room).entries()) {
      lines.push({ kind: entry.kind, text: (i === 0 ? marker : indent) + text });
    }
    previous = entry.kind;
  }
  return lines;
}
