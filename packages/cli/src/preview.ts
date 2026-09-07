import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** How much of a change the screen shows before it says the rest is cut. */
const MAX_LINES = 24;
/** Above this many lines on either side, the diff is replaced by the line counts. */
const MAX_DIFF_LINES = 400;

export interface PreviewLine {
  kind: "added" | "removed" | "context" | "note";
  text: string;
}

/**
 * What a held call would change, for the person about to approve it. A call that writes content
 * to a file is shown as a line diff against the file as it is now; anything else is shown as its
 * input. Reads the file directly: this is the person's own workspace, on their own screen.
 */
export async function previewCall(
  workspaceRoot: string,
  call: { name: string; input: unknown },
): Promise<PreviewLine[]> {
  const input = (call.input ?? {}) as {
    path?: unknown;
    content?: unknown;
    rows?: unknown;
    columns?: unknown;
  };
  const path = typeof input.path === "string" ? input.path : undefined;
  const content =
    typeof input.content === "string"
      ? input.content
      : Array.isArray(input.rows)
        ? csvText(input.rows as Record<string, unknown>[], input.columns)
        : undefined;
  if (path === undefined || content === undefined) {
    return [{ kind: "note", text: JSON.stringify(call.input) }];
  }
  const before = await readFile(join(workspaceRoot, path), "utf8").catch(() => undefined);
  if (before === undefined) {
    const lines = content.split("\n");
    return cap([
      { kind: "note", text: `${path} を新しく作ります(${lines.length} 行)` },
      ...lines.map((text): PreviewLine => ({ kind: "added", text })),
    ]);
  }
  const oldLines = before.split("\n");
  const newLines = content.split("\n");
  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return [
      {
        kind: "note",
        text: `${path} を書き換えます(${oldLines.length} 行 → ${newLines.length} 行。大きいので差分は出しません)`,
      },
    ];
  }
  const body = diff(oldLines, newLines);
  return cap([{ kind: "note", text: `${path} を書き換えます` }, ...body]);
}

/**
 * The rows of a csv_write as the file will read: the header, then one line per row, quoted the
 * way a CSV writer does. Close enough for a person to check what the columns and the numbers are.
 */
function csvText(rows: Record<string, unknown>[], columns: unknown): string {
  const header = Array.isArray(columns)
    ? (columns as unknown[]).map(String)
    : Object.keys(rows[0] ?? {});
  const cell = (value: unknown) => {
    const text = value === undefined || value === null ? "" : String(value);
    return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  return [
    header.map(cell).join(","),
    ...rows.map((row) => header.map((c) => cell(row[c])).join(",")),
  ]
    .join("\n")
    .concat("\n");
}

function cap(lines: PreviewLine[]): PreviewLine[] {
  if (lines.length <= MAX_LINES) return lines;
  const rest = lines.length - MAX_LINES;
  return [...lines.slice(0, MAX_LINES), { kind: "note", text: `ほか ${rest} 行` }];
}

/**
 * A line diff by the longest common subsequence, with the unchanged lines around a change kept
 * as context. Small files only; the caller checks the size first.
 */
function diff(before: string[], after: string[]): PreviewLine[] {
  const table: number[][] = Array.from({ length: before.length + 1 }, () =>
    new Array<number>(after.length + 1).fill(0),
  );
  for (let i = before.length - 1; i >= 0; i--) {
    for (let j = after.length - 1; j >= 0; j--) {
      const row = table[i] as number[];
      const next = table[i + 1] as number[];
      row[j] =
        before[i] === after[j]
          ? (next[j + 1] as number) + 1
          : Math.max(next[j] as number, row[j + 1] as number);
    }
  }
  const all: PreviewLine[] = [];
  let i = 0;
  let j = 0;
  while (i < before.length && j < after.length) {
    if (before[i] === after[j]) {
      all.push({ kind: "context", text: before[i] as string });
      i++;
      j++;
    } else if ((table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0)) {
      all.push({ kind: "removed", text: before[i] as string });
      i++;
    } else {
      all.push({ kind: "added", text: after[j] as string });
      j++;
    }
  }
  for (; i < before.length; i++) all.push({ kind: "removed", text: before[i] as string });
  for (; j < after.length; j++) all.push({ kind: "added", text: after[j] as string });
  return trimContext(all);
}

/** Keeps two unchanged lines on each side of a change and marks what was left out. */
function trimContext(lines: PreviewLine[], keep = 2): PreviewLine[] {
  const wanted = new Set<number>();
  lines.forEach((line, index) => {
    if (line.kind === "context") return;
    for (let k = index - keep; k <= index + keep; k++) wanted.add(k);
  });
  const out: PreviewLine[] = [];
  let skipped = 0;
  lines.forEach((line, index) => {
    if (wanted.has(index)) {
      if (skipped > 0) {
        out.push({ kind: "note", text: `… 変わらない ${skipped} 行 …` });
        skipped = 0;
      }
      out.push(line);
    } else {
      skipped++;
    }
  });
  if (skipped > 0) out.push({ kind: "note", text: `… 変わらない ${skipped} 行 …` });
  return out;
}
