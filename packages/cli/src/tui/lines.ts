import { displayWidth } from "../format.ts";
import { logoSegments, type Segment } from "./banner.ts";
import type { Entry, EntryKind } from "./controller.ts";

export interface ScreenLine {
  kind: EntryKind | "blank";
  text: string;
  /** Colored pieces of a logo row; the other rows are one color. */
  segments?: Segment[];
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
      lines.push({ kind: "logo", text: entry.text, segments: logoSegments(entry.text) });
      previous = entry.kind;
      continue;
    }
    const marker = MARKERS[entry.kind];
    const indent = " ".repeat(displayWidth(marker));
    const body = wrapText(entry.text, Math.max(8, width - displayWidth(marker)));
    for (const [i, text] of body.entries()) {
      lines.push({ kind: entry.kind, text: (i === 0 ? marker : indent) + text });
    }
    previous = entry.kind;
  }
  return lines;
}
