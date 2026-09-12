import { getDocumentProxy, getResolvedPDFJS } from "unpdf";

/**
 * The words of a PDF. A company's evidence arrives as PDF more than as anything else: invoices
 * from suppliers, statements, contracts. Only the words are taken. Images are not read and no
 * text is guessed from them, so a page that was photographed stays unreadable and says so.
 *
 * The file comes from outside the company, so the work done on it is kept to the pages asked
 * for. Reading one page of a document with ten thousand of them parses one page.
 */

/** Why a PDF gave nothing back. The two have different answers, so they are told apart. */
export type PdfProblem =
  /** No text-drawing instruction anywhere in these pages: a scan, or a page of pictures. */
  | "no_text"
  /** Text is drawn, but its fonts cannot be mapped to characters. openshain's limit, not the file's. */
  | "unreadable_fonts";

export interface PdfPages {
  /** The text of the pages asked for, one string per page, in order. */
  window: string[];
  /** How many pages the document has. */
  total: number;
}

type Document = Awaited<ReturnType<typeof getDocumentProxy>>;

/**
 * How pdf.js is opened. Quiet, because its warnings would land on the screen and in the MCP
 * stream, and without the eval path, because the fonts and functions it would compile come from
 * a file somebody else wrote.
 */
const OPENING = { verbosity: 0, isEvalSupported: false } as const;

/**
 * The text of a range of pages. A document whose window holds no words comes back as the reason
 * rather than as empty strings: "this is a scan" and "these fonts are beyond us" lead the person
 * to different places, and an empty page would read as neither.
 */
export async function readPdf(
  bytes: Uint8Array,
  offset: number,
  limit: number,
): Promise<PdfPages | { problem: PdfProblem }> {
  const document = await getDocumentProxy(bytes, OPENING);
  const total = document.numPages;
  const window: string[] = [];
  for (let page = offset + 1; page <= Math.min(offset + limit, total); page += 1) {
    window.push((await textOfPage(document, page)).trim());
  }
  if (window.some((page) => page !== "")) return { window, total };
  return {
    problem: (await drawsText(document, offset, window.length)) ? "unreadable_fonts" : "no_text",
  };
}

/** One page's words, in the order the page draws them. */
async function textOfPage(document: Document, page: number): Promise<string> {
  const { items } = await (await document.getPage(page)).getTextContent();
  return items
    .filter((item): item is typeof item & { str: string } => "str" in item && item.str != null)
    .map((item) => item.str + ("hasEOL" in item && item.hasEOL ? "\n" : ""))
    .join("");
}

/**
 * Whether these pages ask for any text to be drawn. A page of a scan asks for none; a page whose
 * fonts we cannot map asks for plenty and yields no characters. That is the whole difference.
 */
async function drawsText(document: Document, offset: number, pages: number): Promise<boolean> {
  const { OPS } = await getResolvedPDFJS();
  const showing = new Set<number>([
    OPS.showText,
    OPS.showSpacedText,
    OPS.nextLineShowText,
    OPS.nextLineSetSpacingShowText,
  ]);
  for (let page = offset + 1; page <= offset + pages; page += 1) {
    const { fnArray } = await (await document.getPage(page)).getOperatorList();
    if (fnArray.some((fn: number) => showing.has(fn))) return true;
  }
  return false;
}
