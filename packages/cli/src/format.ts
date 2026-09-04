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
