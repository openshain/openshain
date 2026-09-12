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
      // A row starts with no prototype. A column headed __proto__ would otherwise set nothing at
      // all on a plain object, and the whole column would be gone with no error anywhere.
      const out: Record<string, string | number | boolean> = Object.create(null);
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

/** End of central directory, central directory entry: the two records this reads. */
const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
/** A .xlsx is small; a zip's end record sits within this of the end unless it has a comment. */
const END_SEARCH_BYTES = 64 * 1024 + 22;

/**
 * The largest a part of this zip says it expands to. The directory is walked from the end record
 * that points at it, entry by entry, rather than by looking for the entry signature anywhere in
 * the file: a workbook carries a thumbnail, and four bytes of a picture read as that signature
 * often enough to refuse a file that is perfectly fine.
 *
 * A bomb declares its true size, because a reader has to allocate it. One that declares less than
 * it holds is left to the reader, which stops at what it was told and reports a file that ends
 * too early.
 */
function declaredSize(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = endRecord(view, bytes.length);
  if (!end) throw new Error("this is not a .xlsx: no zip directory in it");
  let at = end.offset;
  let largest = 0;
  for (let n = 0; n < end.entries; n += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== DIRECTORY_ENTRY) {
      throw new Error("this .xlsx has a damaged directory and is not read");
    }
    largest = Math.max(largest, view.getUint32(at + 24, true));
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  return largest;
}

/** Where the zip says its directory is, and how many entries it holds. */
function endRecord(
  view: DataView,
  length: number,
): { offset: number; entries: number } | undefined {
  for (let at = length - 22; at >= 0 && at > length - END_SEARCH_BYTES; at -= 1) {
    if (view.getUint32(at, true) !== END_OF_DIRECTORY) continue;
    const entries = view.getUint16(at + 10, true);
    const offset = view.getUint32(at + 16, true);
    // The sentinels mean the real numbers are in a zip64 record. A workbook that needs one holds
    // more than four gigabytes, which is over any limit this would apply anyway.
    if (entries === 0xffff || offset === 0xffffffff) {
      throw new Error("this .xlsx is a zip64 archive, far over the size a workbook may hold");
    }
    return { offset, entries };
  }
  return undefined;
}
