import { marked, type Token, type Tokens } from "marked";
import { displayWidth } from "../format.ts";

/** A piece of a row that carries one style. A row is a list of these, drawn left to right. */
export interface Span {
  text: string;
  color?: string;
  bold?: boolean;
  italic?: boolean;
  dim?: boolean;
  strikethrough?: boolean;
}

/** What each part of a reply looks like on the screen. */
const STYLE = {
  heading: { bold: true, color: "cyan" },
  code: { color: "green" },
  link: { color: "blue" },
  quote: { dim: true },
  rule: { dim: true },
} as const;

const QUOTE_MARKER = "▎ ";
const CODE_MARKER = "│ ";
const BULLETS = ["•", "◦", "‣"] as const;

function styled(text: string, style: Omit<Span, "text">): Span {
  return { text, ...style };
}

/** The inline tokens of one block, flattened into styled pieces. */
function inline(tokens: Token[] | undefined, style: Omit<Span, "text">): Span[] {
  if (!tokens) return [];
  const spans: Span[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "strong":
        spans.push(...inline(token.tokens, { ...style, bold: true }));
        break;
      case "em":
        spans.push(...inline(token.tokens, { ...style, italic: true }));
        break;
      case "del":
        spans.push(...inline(token.tokens, { ...style, strikethrough: true }));
        break;
      case "codespan":
        spans.push(styled((token as Tokens.Codespan).text, { ...style, ...STYLE.code }));
        break;
      case "link": {
        const link = token as Tokens.Link;
        spans.push(...inline(link.tokens, style));
        // The label alone hides where the link goes, so the address follows it.
        if (link.href && link.href !== textOf(link.tokens)) {
          spans.push(styled(` (${link.href})`, { ...style, ...STYLE.link }));
        }
        break;
      }
      case "br":
        spans.push(styled("\n", style));
        break;
      case "escape":
      case "text":
        spans.push(
          ...((token as Tokens.Text).tokens
            ? inline((token as Tokens.Text).tokens, style)
            : [styled((token as Tokens.Text).text, style)]),
        );
        break;
      default:
        spans.push(styled((token as { raw: string }).raw, style));
    }
  }
  return spans;
}

function textOf(tokens: Token[] | undefined): string {
  return inline(tokens, {})
    .map((s) => s.text)
    .join("");
}

/**
 * Breaks styled pieces into rows no wider than `width` display columns, the way the rest of the
 * screen breaks plain text: at the character, so Japanese wraps where it should. Rows after the
 * first start with `hanging`, which keeps a list item under its own marker.
 */
function wrap(spans: Span[], width: number, hanging = ""): Span[][] {
  const limit = Math.max(4, width);
  const rows: Span[][] = [];
  let row: Span[] = [];
  let used = 0;
  const indent = () => (hanging === "" ? [] : [{ text: hanging }]);
  const start = () => {
    rows.push(row);
    row = indent();
    used = displayWidth(hanging);
  };
  for (const span of spans) {
    for (const [i, part] of span.text.split("\n").entries()) {
      // A line break inside a block starts a row of its own.
      if (i > 0) start();
      let piece = "";
      for (const ch of part) {
        const w = displayWidth(ch);
        if (used + w > limit && (row.length > 0 || piece !== "")) {
          if (piece !== "") row.push({ ...span, text: piece });
          piece = "";
          start();
        }
        piece += ch;
        used += w;
      }
      if (piece !== "") row.push({ ...span, text: piece });
    }
  }
  rows.push(row);
  return rows;
}

/** Puts `prefix` in front of every row, for a quote bar or a code bar. */
function prefixed(rows: Span[][], prefix: Span): Span[][] {
  return rows.map((row) => [prefix, ...row]);
}

function blockRows(tokens: Token[], width: number): Span[][] {
  const rows: Span[][] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        rows.push([]);
        break;
      case "heading":
        rows.push(...wrap(inline(token.tokens, STYLE.heading), width));
        break;
      case "paragraph":
      case "text":
        rows.push(...wrap(inline(token.tokens ?? [], {}), width));
        break;
      case "code": {
        const marker = styled(CODE_MARKER, STYLE.quote);
        const body = (token as Tokens.Code).text.split("\n");
        for (const line of body) {
          rows.push(...prefixed(wrap([styled(line, STYLE.code)], width - 2), marker));
        }
        break;
      }
      case "blockquote": {
        const inner = blockRows((token as Tokens.Blockquote).tokens ?? [], width - 2);
        rows.push(...prefixed(inner, styled(QUOTE_MARKER, STYLE.quote)));
        break;
      }
      case "list":
        rows.push(...listRows(token as Tokens.List, width, 0));
        break;
      case "hr":
        rows.push([styled("─".repeat(Math.max(4, width)), STYLE.rule)]);
        break;
      case "table":
        // Aligning columns is its own piece of work; until then the source rows are shown as
        // they were written, so nothing the model put in the table is lost.
        for (const line of (token as Tokens.Table).raw.trimEnd().split("\n")) {
          rows.push(...wrap([{ text: line }], width));
        }
        break;
      default:
        for (const line of ((token as { raw?: string }).raw ?? "").trimEnd().split("\n")) {
          rows.push(...wrap([{ text: line }], width));
        }
    }
  }
  return rows;
}

function listRows(list: Tokens.List, width: number, depth: number): Span[][] {
  const rows: Span[][] = [];
  let number = Number(list.start || 1);
  for (const item of list.items) {
    const marker = list.ordered ? `${number++}. ` : `${BULLETS[depth % BULLETS.length]} `;
    const indent = " ".repeat(displayWidth(marker));
    const inner: Span[][] = [];
    for (const token of item.tokens) {
      if (token.type === "list") {
        inner.push(...listRows(token as Tokens.List, width - displayWidth(marker), depth + 1));
      } else {
        inner.push(...blockRows([token], width - displayWidth(marker)));
      }
    }
    for (const [i, row] of inner.entries()) {
      rows.push([{ text: i === 0 ? marker : indent }, ...row]);
    }
  }
  return rows;
}

/**
 * A reply as rows of styled pieces. The model writes markdown, so the screen shows the emphasis
 * and the structure instead of the characters that mark them. What this does not draw yet is
 * shown as it was written, never dropped.
 */
export function markdownRows(source: string, width: number): Span[][] {
  const rows = blockRows(marked.lexer(source), width);
  while (rows.length > 0 && (rows[0]?.length ?? 0) === 0) rows.shift();
  while (rows.length > 0 && (rows.at(-1)?.length ?? 0) === 0) rows.pop();
  return rows.length > 0 ? rows : [[]];
}
