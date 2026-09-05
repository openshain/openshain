import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import {
  RESERVED_PATHS,
  resolveWorkspacePath,
  type ToolContext,
  type ToolDefinition,
  type ToolProvider,
  type ToolResult,
} from "@openshain/core";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

/** Files larger than this are not opened at all. What a tool returns is a window, far smaller. */
export const MAX_READ_BYTES = 1024 * 1024;
/** The same limit on writes, so that nothing a tool writes is too large for a tool to open. */
export const MAX_WRITE_BYTES = MAX_READ_BYTES;

/** The window each observing tool returns when the model does not ask for another one. */
export const DEFAULT_WINDOW = {
  fs_list: 200,
  fs_search: 100,
  fs_read: 200,
  csv_read: 50,
  csv_aggregate: 100,
  markdown_read: 100,
} as const;

/** fs_search gives up after this many files so that a huge tree cannot stall a Work. */
const MAX_SEARCH_FILES = 2000;
/** fs_search returns at most this many characters of a matching line. */
const MAX_MATCH_TEXT = 200;

const pathProperty = {
  type: "string",
  description: "Path relative to the workspace root, for example receipts/2026-07.csv.",
};

function offsetProperty(unit: string) {
  return {
    type: "integer",
    minimum: 0,
    default: 0,
    description: `How many ${unit} to skip before the window starts. 0 is the start.`,
  };
}

function limitProperty(unit: string, fallback: number, maximum: number) {
  return {
    type: "integer",
    minimum: 1,
    maximum,
    default: fallback,
    description: `How many ${unit} to return at most (default ${fallback}).`,
  };
}

const definitions: ToolDefinition[] = [
  {
    name: "fs_list",
    description:
      'List one directory inside the workspace ("." is the root). Returns up to limit entries (default 200) with name, type and size in bytes, the total number of entries and whether the list was cut short. pattern keeps only the names matching a glob such as *.csv. Not recursive; to find files by what they contain use fs_search.',
    inputSchema: {
      type: "object",
      properties: {
        path: { ...pathProperty, default: "." },
        pattern: {
          type: "string",
          minLength: 1,
          description:
            "Wildcard on the entry name, for example *.csv or 2026-*. * matches any run of characters and ? one character.",
        },
        limit: limitProperty("entries", DEFAULT_WINDOW.fs_list, 1000),
      },
      additionalProperties: false,
    },
    effect: "observe",
  },
  {
    name: "fs_search",
    description:
      "Search the text files inside the workspace for a pattern. In the pattern, * matches any run of characters and ? one character; everything else matches literally, so it is not a regular expression. Returns up to limit matches (default 100) with the file path, the line number and the matching line, and whether more matches were cut off. path narrows the search to a directory or to a single file. Hidden entries, symlinks, binary files and files over 1 MiB are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          minLength: 1,
          description:
            "Text to look for. * matches any run of characters and ? one character; other characters, including . ( ) [ ] and |, match literally.",
        },
        path: {
          ...pathProperty,
          default: ".",
          description:
            "Directory or file to search, relative to the workspace root. Defaults to the whole workspace.",
        },
        limit: limitProperty("matches", DEFAULT_WINDOW.fs_search, 1000),
      },
      required: ["pattern"],
      additionalProperties: false,
    },
    effect: "observe",
  },
  {
    name: "fs_read",
    description:
      "Read a window of lines from a text file inside the workspace. Returns the window (default the first 200 lines) together with the file's line count and whether more lines remain; move the window with offset. For a CSV file use csv_read, and for totals use csv_aggregate rather than paging through the rows.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProperty,
        offset: offsetProperty("lines"),
        limit: limitProperty("lines", DEFAULT_WINDOW.fs_read, 2000),
      },
      required: ["path"],
      additionalProperties: false,
    },
    effect: "observe",
  },
  {
    name: "fs_write",
    description:
      "Write a text file inside the workspace, creating or replacing it. Up to 1 MiB. Returns the file's path and the hash of its contents.",
    inputSchema: {
      type: "object",
      properties: { path: pathProperty, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
    effect: "mutate",
  },
  {
    name: "csv_read",
    description:
      "Read a CSV file with a header row. Returns the column names, the number of data rows and a window of rows (default the first 50) as one object per row; move the window with offset and limit. Use it to see what a file looks like. For sums, counts, minimums or maximums call csv_aggregate instead of reading every row.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProperty,
        offset: offsetProperty("rows"),
        limit: limitProperty("rows", DEFAULT_WINDOW.csv_read, 500),
      },
      required: ["path"],
      additionalProperties: false,
    },
    effect: "observe",
  },
  {
    name: "csv_aggregate",
    description:
      "Count and total the rows of a CSV file with a header row, over the whole file in one call. group_by names the columns to group by (omit it for a single group), sum names the numeric columns to total, filter keeps only the rows whose columns equal the given values. Returns one entry per group, ordered by the group's values, with its row count and, for each summed column, the sum, min, max, the number of numeric cells and the number of cells skipped as non-numeric. Cells such as 1,200, ¥300 or full-width １２３ count as numbers.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProperty,
        group_by: {
          type: "array",
          items: { type: "string" },
          description: "Columns to group the rows by. Omit to treat the whole file as one group.",
        },
        sum: {
          type: "array",
          items: { type: "string" },
          description: "Numeric columns to total.",
        },
        filter: {
          type: "array",
          items: {
            type: "object",
            properties: { column: { type: "string" }, equals: { type: "string" } },
            required: ["column", "equals"],
            additionalProperties: false,
          },
          description: "Keep only the rows where every listed column equals the given value.",
        },
        limit: limitProperty("groups", DEFAULT_WINDOW.csv_aggregate, 1000),
      },
      required: ["path"],
      additionalProperties: false,
    },
    effect: "observe",
  },
  {
    name: "csv_write",
    description:
      "Write rows to a CSV file with a header row, creating or replacing it. Up to 1 MiB. A cell that starts with =, + or @ gets a leading apostrophe so that a spreadsheet does not run it as a formula. Returns the file's path and the hash of its contents.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProperty,
        rows: {
          type: "array",
          items: { type: "object", additionalProperties: { type: "string" } },
          description: "One object per row. Keys become the header.",
        },
        columns: {
          type: "array",
          items: { type: "string" },
          description: "Column order. Defaults to the keys of the first row.",
        },
      },
      required: ["path", "rows"],
      additionalProperties: false,
    },
    effect: "mutate",
  },
  {
    name: "markdown_read",
    description:
      "Read a Markdown file inside the workspace. Returns the outline of headings with their line numbers and the first lines of the file (default 100). With section set to a heading's text, returns that section instead: from the heading up to the next heading of the same or a higher level. For any other range of lines use fs_read with offset.",
    inputSchema: {
      type: "object",
      properties: {
        path: pathProperty,
        section: {
          type: "string",
          minLength: 1,
          description: "Text of the heading whose section to return.",
        },
        limit: limitProperty("lines", DEFAULT_WINDOW.markdown_read, 2000),
      },
      required: ["path"],
      additionalProperties: false,
    },
    effect: "observe",
  },
];

/** The tools every workspace gets: files, CSV and Markdown, all confined to the workspace. */
export function standardTools(): ToolProvider {
  return {
    id: "standard",
    listTools: async () => definitions,
    async call(call, ctx) {
      const input = (call.input ?? {}) as Record<string, unknown>;
      const path = typeof input.path === "string" ? input.path : ".";
      switch (call.name) {
        case "fs_list":
          return fsList(
            ctx,
            path,
            nonEmpty(input.pattern),
            count(input.limit, DEFAULT_WINDOW.fs_list),
          );
        case "fs_search":
          return fsSearch(ctx, path, input);
        case "fs_read":
          return fsRead(
            ctx,
            path,
            count(input.offset, 0),
            count(input.limit, DEFAULT_WINDOW.fs_read),
          );
        case "fs_write":
          return fsWrite(ctx, path, String(input.content ?? ""));
        case "csv_read":
          return csvRead(
            ctx,
            path,
            count(input.offset, 0),
            count(input.limit, DEFAULT_WINDOW.csv_read),
          );
        case "csv_aggregate":
          return csvAggregate(ctx, path, input);
        case "csv_write":
          return csvWrite(ctx, path, input.rows, input.columns);
        case "markdown_read":
          return markdownRead(
            ctx,
            path,
            nonEmpty(input.section),
            count(input.limit, DEFAULT_WINDOW.markdown_read),
          );
        default:
          throw new Error(`the standard tools do not provide "${call.name}"`);
      }
    },
  };
}

async function fsList(
  ctx: ToolContext,
  path: string,
  pattern: string | undefined,
  limit: number,
): Promise<ToolResult> {
  const resolved = await resolveWorkspacePath(ctx.workspaceRoot, path);
  const root = await resolveWorkspacePath(ctx.workspaceRoot, ".");
  const matches = pattern === undefined ? () => true : wildcardMatcher(pattern);
  const entries = (await readdir(resolved, { withFileTypes: true }))
    .filter((entry) => visible(entry.name, resolved === root))
    .filter((entry) => matches(entry.name))
    .sort(byName);
  const window = await Promise.all(
    entries.slice(0, limit).map(async (entry) => {
      if (entry.isDirectory()) return { name: entry.name, type: "directory" };
      if (!entry.isFile()) return { name: entry.name, type: "other" };
      const { size } = await stat(join(resolved, entry.name));
      return { name: entry.name, type: "file", size };
    }),
  );
  return json(
    { path, entries: window, total: entries.length, truncated: window.length < entries.length },
    path,
  );
}

async function fsSearch(
  ctx: ToolContext,
  path: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const pattern = text(input.pattern) ?? "";
  if (pattern === "") return failure("pattern must not be empty");
  const limit = count(input.limit, DEFAULT_WINDOW.fs_search);
  const test = /[*?]/.test(pattern)
    ? wildcardMatcher(`*${pattern}*`)
    : (line: string) => line.includes(pattern);

  const resolved = await resolveWorkspacePath(ctx.workspaceRoot, path);
  const root = await resolveWorkspacePath(ctx.workspaceRoot, ".");
  const matches: { path: string; line: number; text: string }[] = [];
  let filesSearched = 0;
  let filesSkipped = 0;
  let truncated = false;
  const files = (await stat(resolved)).isFile() ? [resolved] : walk(resolved, root);
  search: for await (const file of files) {
    if (filesSearched + filesSkipped >= MAX_SEARCH_FILES) {
      truncated = true;
      break;
    }
    if ((await stat(file)).size > MAX_READ_BYTES || (await looksBinary(file))) {
      filesSkipped += 1;
      continue;
    }
    filesSearched += 1;
    const lines = splitLines(await readFile(file, "utf8"));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      if (!test(line)) continue;
      if (matches.length >= limit) {
        truncated = true;
        break search;
      }
      matches.push({ path: relative(root, file), line: i + 1, text: clip(line) });
    }
  }
  return json({ pattern, path, matches, filesSearched, filesSkipped, truncated }, path);
}

async function fsRead(
  ctx: ToolContext,
  path: string,
  offset: number,
  limit: number,
): Promise<ToolResult> {
  const content = await readText(ctx, path);
  const lines = splitLines(content);
  const window = lines.slice(offset, offset + limit);
  return {
    content: [
      {
        type: "json",
        value: {
          path,
          offset,
          returned: window.length,
          lines: lines.length,
          truncated: offset + window.length < lines.length,
          bytes: Buffer.byteLength(content, "utf8"),
        },
      },
      { type: "text", text: joinLines(window) },
    ],
    observation: observed(path),
  };
}

async function fsWrite(ctx: ToolContext, path: string, content: string): Promise<ToolResult> {
  const after = await writeText(ctx, path, content);
  return { content: [{ type: "text", text: `wrote ${after.path}` }], after: [after] };
}

async function csvRead(
  ctx: ToolContext,
  path: string,
  offset: number,
  limit: number,
): Promise<ToolResult> {
  const { columns, rows } = await readCsv(ctx, path);
  const window = rows.slice(offset, offset + limit);
  return json(
    {
      path,
      columns,
      rowCount: rows.length,
      offset,
      returned: window.length,
      truncated: offset + window.length < rows.length,
      rows: window,
    },
    path,
  );
}

interface Totals {
  sum: number;
  min: number | null;
  max: number | null;
  count: number;
  skipped: number;
}

async function csvAggregate(
  ctx: ToolContext,
  path: string,
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const groupBy = strings(input.group_by);
  const sums = strings(input.sum);
  const filters = Array.isArray(input.filter)
    ? (input.filter as { column: unknown; equals: unknown }[]).map((f) => ({
        column: String(f.column),
        equals: String(f.equals),
      }))
    : [];
  const limit = count(input.limit, DEFAULT_WINDOW.csv_aggregate);
  const { columns, rows } = await readCsv(ctx, path);
  for (const column of [...groupBy, ...sums, ...filters.map((f) => f.column)]) {
    if (!columns.includes(column)) {
      return failure(`"${path}" has no column "${column}"; its columns are ${columns.join(", ")}`);
    }
  }

  const matched = rows.filter((row) => filters.every((f) => (row[f.column] ?? "") === f.equals));
  const groups = new Map<
    string,
    { values: string[]; rows: number; totals: Record<string, Totals> }
  >();
  for (const row of matched) {
    const values = groupBy.map((column) => row[column] ?? "");
    const key = JSON.stringify(values);
    let group = groups.get(key);
    if (!group) {
      group = {
        values,
        rows: 0,
        totals: Object.fromEntries(
          sums.map((column) => [column, { sum: 0, min: null, max: null, count: 0, skipped: 0 }]),
        ),
      };
      groups.set(key, group);
    }
    group.rows += 1;
    for (const column of sums) {
      const totals = group.totals[column];
      if (totals) accumulate(totals, row[column] ?? "");
    }
  }

  const sorted = [...groups.values()].sort((a, b) => compareValues(a.values, b.values));
  const window = sorted.slice(0, limit).map((group) => ({
    group: Object.fromEntries(groupBy.map((column, i) => [column, group.values[i] ?? ""])),
    rows: group.rows,
    totals: Object.fromEntries(
      Object.entries(group.totals).map(([column, t]) => [column, { ...t, sum: tidy(t.sum) }]),
    ),
  }));
  return json(
    {
      path,
      rowCount: rows.length,
      matched: matched.length,
      groupCount: sorted.length,
      groups: window,
      truncated: window.length < sorted.length,
    },
    path,
  );
}

async function csvWrite(
  ctx: ToolContext,
  path: string,
  rows: unknown,
  columns: unknown,
): Promise<ToolResult> {
  if (!Array.isArray(rows)) throw new Error("rows must be an array of objects");
  const safeRows = (rows as Record<string, unknown>[]).map((row) =>
    Object.fromEntries(Object.entries(row).map(([key, value]) => [key, neutralizeFormula(value)])),
  );
  const content = stringify(safeRows, {
    header: true,
    ...(Array.isArray(columns) && { columns: columns as string[] }),
  });
  const after = await writeText(ctx, path, content);
  return {
    content: [{ type: "text", text: `wrote ${rows.length} rows to ${after.path}` }],
    after: [after],
  };
}

async function markdownRead(
  ctx: ToolContext,
  path: string,
  section: string | undefined,
  limit: number,
): Promise<ToolResult> {
  const lines = splitLines(await readText(ctx, path));
  const headings = outline(lines);
  let from = 0;
  let end = lines.length;
  let picked: { text: string; level: number; line: number; lines: number } | undefined;
  if (section !== undefined) {
    const heading =
      headings.find((h) => h.text === section) ?? headings.find((h) => h.text.includes(section));
    if (!heading) {
      const known = headings.map((h) => h.text).join(", ");
      return failure(`"${path}" has no heading matching "${section}"; its headings are: ${known}`);
    }
    const next = headings.find((h) => h.line > heading.line && h.level <= heading.level);
    from = heading.line - 1;
    end = next ? next.line - 1 : lines.length;
    picked = { text: heading.text, level: heading.level, line: heading.line, lines: end - from };
  }
  const window = lines.slice(from, Math.min(end, from + limit));
  return {
    content: [
      {
        type: "json",
        value: {
          path,
          lines: lines.length,
          headings,
          ...(picked && { section: picked }),
          offset: from,
          returned: window.length,
          truncated: from + window.length < end,
        },
      },
      { type: "text", text: joinLines(window) },
    ],
    observation: observed(path),
  };
}

/** Headings outside fenced code blocks, with 1-based line numbers. */
function outline(lines: string[]): { level: number; text: string; line: number }[] {
  const headings: { level: number; text: string; line: number }[] = [];
  let fence: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ level: match[1]?.length ?? 1, text: match[2] ?? "", line: i + 1 });
  }
  return headings;
}

async function readCsv(
  ctx: ToolContext,
  path: string,
): Promise<{ columns: string[]; rows: Record<string, string>[] }> {
  const content = await readText(ctx, path);
  const records = parse(content, { bom: true, skip_empty_lines: true }) as string[][];
  const [header, ...body] = records;
  const columns = header ?? [];
  const rows = body.map((cells) =>
    Object.fromEntries(columns.map((column, i) => [column, cells[i] ?? ""])),
  );
  return { columns, rows };
}

async function readText(ctx: ToolContext, path: string): Promise<string> {
  const resolved = await resolveWorkspacePath(ctx.workspaceRoot, path);
  let size: number;
  try {
    size = (await stat(resolved)).size;
  } catch (err) {
    throw new Error(`cannot read "${path}": ${(err as NodeJS.ErrnoException).code ?? "error"}`);
  }
  if (size > MAX_READ_BYTES) {
    throw new Error(`"${path}" is too large to read (${size} bytes, limit ${MAX_READ_BYTES})`);
  }
  return readFile(resolved, "utf8");
}

/** Writes through a descriptor opened with O_NOFOLLOW, so the final component may not be a symlink. */
async function writeText(
  ctx: ToolContext,
  path: string,
  content: string,
): Promise<{ path: string; sha256: string }> {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WRITE_BYTES) {
    throw new Error(`"${path}" is too large to write (${bytes} bytes, limit ${MAX_WRITE_BYTES})`);
  }
  const resolved = await resolveWorkspacePath(ctx.workspaceRoot, path);
  const root = await resolveWorkspacePath(ctx.workspaceRoot, ".");
  await mkdir(dirname(resolved), { recursive: true });
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(resolved, flags, 0o644);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  return {
    path: relative(root, resolved),
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

/** Regular files below `dir`, in code point order, skipping hidden entries, symlinks and reserved paths. */
async function* walk(dir: string, root: string): AsyncGenerator<string> {
  const entries = (await readdir(dir, { withFileTypes: true }))
    .filter((entry) => visible(entry.name, dir === root))
    .sort(byName);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, root);
    else if (entry.isFile()) yield full;
  }
}

function visible(name: string, atRoot: boolean): boolean {
  if (name.startsWith(".")) return false;
  return (
    !atRoot || !RESERVED_PATHS.some((reserved) => reserved.toLowerCase() === name.toLowerCase())
  );
}

function byName(a: { name: string }, b: { name: string }): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function compareValues(a: string[], b: string[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? "";
    const y = b[i] ?? "";
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * Matches a whole string against a pattern in which `*` stands for any run of characters and `?`
 * for one character; everything else is literal. Takes time proportional to the pattern times the
 * subject, so a pattern the model writes cannot stall the run the way a backtracking regular
 * expression can.
 */
function wildcardMatcher(pattern: string): (subject: string) => boolean {
  const p = [...pattern];
  return (subject) => {
    const s = [...subject];
    let pi = 0;
    let si = 0;
    let starP = -1;
    let starS = 0;
    while (si < s.length) {
      if (pi < p.length && (p[pi] === "?" || p[pi] === s[si])) {
        pi += 1;
        si += 1;
      } else if (pi < p.length && p[pi] === "*") {
        starP = pi;
        starS = si;
        pi += 1;
      } else if (starP >= 0) {
        pi = starP + 1;
        starS += 1;
        si = starS;
      } else {
        return false;
      }
    }
    while (pi < p.length && p[pi] === "*") pi += 1;
    return pi === p.length;
  };
}

/** A NUL byte in the first 8 KiB marks a file the search skips. */
async function looksBinary(file: string): Promise<boolean> {
  const handle = await open(file, "r");
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    return head.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** Cells such as 1,200, ¥300, １２３ or -50.5 are numbers; anything else is skipped. */
function toNumber(cell: string): number | undefined {
  const cleaned = cell.normalize("NFKC").replace(/[,¥$\s]/g, "");
  return /^[-+]?(\d+\.?\d*|\.\d+)$/.test(cleaned) ? Number(cleaned) : undefined;
}

function accumulate(totals: Totals, cell: string): void {
  const value = toNumber(cell);
  if (value === undefined) {
    totals.skipped += 1;
    return;
  }
  totals.sum += value;
  totals.count += 1;
  totals.min = totals.min === null ? value : Math.min(totals.min, value);
  totals.max = totals.max === null ? value : Math.max(totals.max, value);
}

/** Hides the noise of binary floating point in a sum of decimals, such as 0.1 + 0.2. Integers stay exact. */
function tidy(n: number): number {
  return Number.isInteger(n) ? n : Number(n.toPrecision(15));
}

/** Lines of a text, without the empty line a trailing newline would add. */
function splitLines(content: string): string[] {
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

function joinLines(lines: string[]): string {
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function clip(line: string): string {
  const chars = [...line];
  return chars.length > MAX_MATCH_TEXT ? `${chars.slice(0, MAX_MATCH_TEXT).join("")}…` : line;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function count(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function json(value: unknown, path: string): ToolResult {
  return { content: [{ type: "json", value }], observation: observed(path) };
}

function failure(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Spreadsheets run a cell that starts with =, +, @ or - as a formula. A leading apostrophe keeps
 * it text. Negative numbers are left alone.
 */
function neutralizeFormula(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return /^[=+@\t\r]/.test(value) || /^-(?![0-9.])/.test(value) ? `'${value}` : value;
}

function observed(path: string): { source: string; retrievedAt: string } {
  return { source: path, retrievedAt: new Date().toISOString() };
}
