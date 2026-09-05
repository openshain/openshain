/** Display width in a terminal: East Asian wide and full-width characters take two columns. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += isWide(ch.codePointAt(0) ?? 0) ? 2 : 1;
  return width;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** Pads with spaces to a display width, so columns line up with Japanese text in them. */
export function padDisplay(text: string, width: number): string {
  const missing = width - displayWidth(text);
  return missing > 0 ? text + " ".repeat(missing) : text;
}

/** A tool input on one line: the path when there is one, nothing for a question, otherwise the JSON, shortened. */
export function describeInput(input: unknown): string {
  if (input && typeof input === "object") {
    if ("path" in input) return String((input as { path: unknown }).path);
    if ("question" in input) return "";
  }
  return truncate(JSON.stringify(input) ?? "");
}

export function truncate(text: string, max = 80): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/**
 * Text as it may reach a terminal: escape sequences and other control characters are dropped,
 * newline and tab stay. Nothing a model says or a file contains can then move the cursor,
 * retitle the window or write the clipboard. A scan over the characters, not a regular expression,
 * so the time is linear in the text.
 */
export function plain(text: string): string {
  const chars = [...text];
  let out = "";
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i] as string;
    const code = ch.codePointAt(0) ?? 0;
    if (code === ESC || code === CSI) i = afterSequence(chars, i);
    else {
      if (!isControl(code)) out += ch;
      i += 1;
    }
  }
  return out;
}

const ESC = 0x1b;
const CSI = 0x9b;
const BEL = 0x07;
const ST = 0x9c;

function isControl(code: number): boolean {
  return (code < 0x20 && code !== 0x0a && code !== 0x09) || (code >= 0x7f && code <= 0x9f);
}

/** The index after the escape sequence that starts at `start`. An unfinished one runs to the end. */
function afterSequence(chars: string[], start: number): number {
  const at = (i: number) => chars[i]?.codePointAt(0) ?? -1;
  const end = chars.length;
  const opener = at(start) === CSI ? "[" : chars[start + 1];
  let i = at(start) === CSI ? start + 1 : start + 2;
  if (opener === "[") {
    // CSI: parameter and intermediate bytes, then one final byte.
    while (i < end && at(i) >= 0x20 && at(i) <= 0x3f) i += 1;
    return Math.min(i + 1, end);
  }
  if (opener === "]" || opener === "P" || opener === "X" || opener === "^" || opener === "_") {
    // OSC, DCS, SOS, PM, APC: a string that ends with BEL or ST.
    while (i < end) {
      if (at(i) === BEL || at(i) === ST) return i + 1;
      if (at(i) === ESC && chars[i + 1] === "\\") return i + 2;
      i += 1;
    }
    return end;
  }
  if (at(start + 1) >= 0x20 && at(start + 1) <= 0x2f) {
    // Intermediate bytes, then one final byte.
    while (i < end && at(i) >= 0x20 && at(i) <= 0x2f) i += 1;
    return Math.min(i + 1, end);
  }
  // ESC and one final character.
  return Math.min(i, end);
}
