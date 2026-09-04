import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative } from "node:path";
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

/** Files larger than this are not read into the model's context. */
export const MAX_READ_BYTES = 1024 * 1024;
/** The same limit on writes, so that nothing a tool writes is too large for a tool to read back. */
export const MAX_WRITE_BYTES = MAX_READ_BYTES;

const pathProperty = {
  type: "string",
  description: "Path relative to the workspace root, for example receipts/2026-07.csv.",
};

const definitions: ToolDefinition[] = [
  {
    name: "fs_list",
    description:
      'List the files and directories at a path inside the workspace. Use "." for the root. Returns each entry with its name and whether it is a file or a directory.',
    inputSchema: {
      type: "object",
      properties: { path: { ...pathProperty, default: "." } },
      additionalProperties: false,
    },
    effect: "observe",
  },
  {
    name: "fs_read",
    description:
      "Read a text file inside the workspace and return its contents. For a CSV file use csv_read; for a Markdown file whose headings you need, use markdown_read.",
    inputSchema: {
      type: "object",
      properties: { path: pathProperty },
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
    description: "Read a CSV file with a header row. Returns one object per row.",
    inputSchema: {
      type: "object",
      properties: { path: pathProperty },
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
    description: "Read a Markdown file. Returns the text and the list of headings.",
    inputSchema: {
      type: "object",
      properties: { path: pathProperty },
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
          return fsList(ctx, path);
        case "fs_read":
          return fsRead(ctx, path);
        case "fs_write":
          return fsWrite(ctx, path, String(input.content ?? ""));
        case "csv_read":
          return csvRead(ctx, path);
        case "csv_write":
          return csvWrite(ctx, path, input.rows, input.columns);
        case "markdown_read":
          return markdownRead(ctx, path);
        default:
          throw new Error(`the standard tools do not provide "${call.name}"`);
      }
    },
  };
}

async function fsList(ctx: ToolContext, path: string): Promise<ToolResult> {
  const resolved = await resolveWorkspacePath(ctx.workspaceRoot, path);
  const root = await resolveWorkspacePath(ctx.workspaceRoot, ".");
  const entries = await readdir(resolved, { withFileTypes: true });
  const visible = entries
    .filter((entry) => !entry.name.startsWith("."))
    .filter(
      (entry) => resolved !== root || !(RESERVED_PATHS as readonly string[]).includes(entry.name),
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((entry) => ({
      name: entry.name,
      type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
    }));
  return { content: [{ type: "json", value: visible }], observation: observed(path) };
}

async function fsRead(ctx: ToolContext, path: string): Promise<ToolResult> {
  const text = await readText(ctx, path);
  return { content: [{ type: "text", text }], observation: observed(path) };
}

async function fsWrite(ctx: ToolContext, path: string, content: string): Promise<ToolResult> {
  const after = await writeText(ctx, path, content);
  return { content: [{ type: "text", text: `wrote ${after.path}` }], after: [after] };
}

async function csvRead(ctx: ToolContext, path: string): Promise<ToolResult> {
  const text = await readText(ctx, path);
  const rows: unknown = parse(text, { columns: true, bom: true, skip_empty_lines: true });
  return { content: [{ type: "json", value: rows }], observation: observed(path) };
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
  const text = stringify(safeRows, {
    header: true,
    ...(Array.isArray(columns) && { columns: columns as string[] }),
  });
  const after = await writeText(ctx, path, text);
  return {
    content: [{ type: "text", text: `wrote ${rows.length} rows to ${after.path}` }],
    after: [after],
  };
}

async function markdownRead(ctx: ToolContext, path: string): Promise<ToolResult> {
  const text = await readText(ctx, path);
  const headings: { level: number; text: string }[] = [];
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1] ?? "";
      if (!fence) fence = marker[0];
      else if (marker[0] === fence) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (match) headings.push({ level: match[1]?.length ?? 1, text: match[2] ?? "" });
  }
  return {
    content: [
      { type: "text", text },
      { type: "json", value: { headings } },
    ],
    observation: observed(path),
  };
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
