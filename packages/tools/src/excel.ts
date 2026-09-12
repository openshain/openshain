import readXlsxFile from "read-excel-file/node";

/**
 * A workbook, read. The ledger a tax accountant keeps arrives as .xlsx, and so does half of what
 * a supplier sends. Reading it is where two things go silently wrong: Excel keeps a date as a
 * number, and a formula cell holds both the formula and the value it last worked out. Both are
 * turned into what the number means, so nothing that looks like data is really a date serial.
 */

/** The most a workbook's parts may say they expand to. Above it, the file is not opened. */
export const MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

export interface Sheet {
  /** Every sheet in the workbook, in the order the workbook lists them. */
  names: string[];
  /** The sheet that was read. */
  name: string;
  /** The names of the columns, taken from the first row. */
  columns: string[];
  /** Every row under the first, each keyed by the column names. */
  rows: Record<string, string | number | boolean>[];
}

/** The old binary format, which is a compound file rather than a zip. */
const OLD_XLS = [0xd0, 0xcf, 0x11, 0xe0];

/**
 * The rows of one sheet. A workbook that is not a zip, or whose parts claim to expand beyond what
 * is reasonable, is refused before anything is decompressed: a .xlsx under a megabyte can hold
 * hundreds of them, and it arrives from whoever sent the invoice.
 */
export async function readWorkbook(bytes: Buffer, sheet?: string): Promise<Sheet> {
  if (OLD_XLS.every((byte, at) => bytes[at] === byte)) {
    throw new Error("this is an .xls, the old binary format; only .xlsx is read. Save it as .xlsx");
  }
  const declared = declaredSize(bytes);
  if (declared > MAX_UNCOMPRESSED_BYTES) {
    throw new Error(
      `this workbook expands to ${Math.round(declared / 1024 / 1024)} MiB, over the ${MAX_UNCOMPRESSED_BYTES / 1024 / 1024} MiB a workbook may hold`,
    );
  }
  // One pass over the workbook: the names and the rows come out of the same read, so a file is
  // not decompressed twice to answer one call. What that costs is held down by the size above.
  // getSheets asks for every sheet with its name. The option is missing from this version's
  // types, whose return type nevertheless describes the shape it produces with it.
  const book = await readXlsxFile(bytes, { getSheets: true } as Parameters<typeof readXlsxFile>[1]);
  const names = book.map((each) => each.sheet);
  const name = sheet ?? names[0] ?? "";
  const found = book.find((each) => each.sheet === name);
  if (!found) {
    throw new Error(`this workbook has no sheet named "${name}"; it has ${names.join(", ")}`);
  }
  const grid = found.data;
  const columns = headings(grid[0] ?? []);
  return {
    names,
    name,
    columns,
    rows: grid.slice(1).map((row) => {
      const out: Record<string, string | number | boolean> = {};
      for (const [at, column] of columns.entries()) out[column] = plain(row[at]);
      return out;
    }),
  };
}

/**
 * The column names. A heading that is empty, or one already taken by an earlier column, becomes
 * the column's own letter: two columns under one name would put one of them on top of the other,
 * and a row would come back short of what the sheet holds.
 */
function headings(first: readonly unknown[]): string[] {
  const names: string[] = [];
  for (const [at, cell] of first.entries()) {
    const written = typeof cell === "string" ? cell.trim() : "";
    names.push(written !== "" && !names.includes(written) ? written : letter(at));
  }
  return names;
}

/** A column's letter, as the spreadsheet shows it: A, B, ... Z, AA. */
function letter(at: number): string {
  let name = "";
  for (let n = at; n >= 0; n = Math.floor(n / 26) - 1) {
    name = String.fromCharCode(65 + (n % 26)) + name;
  }
  return name;
}

/** One cell as the value it means. A date is the day it names, in the workbook's own terms. */
function plain(cell: unknown): string | number | boolean {
  if (cell === null || cell === undefined) return "";
  // Excel keeps a date as a count of days, and the reader hands it back as midnight UTC. Read in
  // any other zone it would be the day before, so the day is taken from UTC and written plainly.
  if (cell instanceof Date) return cell.toISOString().slice(0, 10);
  if (typeof cell === "number" || typeof cell === "boolean") return cell;
  return String(cell);
}

/**
 * The largest a part of this zip says it expands to, from the central directory. A bomb declares
 * its true size, because a reader has to allocate it; one that lies about it is caught later by
 * the reader itself, which is the case this cannot cover.
 */
function declaredSize(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let largest = 0;
  // Central directory entries begin with PK\x01\x02 and hold the uncompressed size at offset 24.
  for (let at = 0; at + 46 <= bytes.length; at += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) continue;
    largest = Math.max(largest, view.getUint32(at + 24, true));
  }
  return largest;
}
