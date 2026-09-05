import cli from "../../package.json" with { type: "json" };

/** The version of the openshain command, from its package.json. */
export const VERSION: string = cli.version;

/**
 * The wordmark as `oh-my-logo "openshain" --filled --block-font chrome` draws it, kept here so the
 * screen needs neither the network nor another dependency to show it.
 */
export const LOGO_ROWS: readonly string[] = Object.freeze([
  " ╔═╗ ╔═╗ ╔═╗ ╔╗╔ ╔═╗ ╦ ╦ ╔═╗ ╦ ╔╗╔",
  " ║ ║ ╠═╝ ║╣  ║║║ ╚═╗ ╠═╣ ╠═╣ ║ ║║║",
  " ╚═╝ ╩   ╚═╝ ╝╚╝ ╚═╝ ╩ ╩ ╩ ╩ ╩ ╝╚╝",
]);

/** oh-my-logo's grad-blue palette, from the left edge of the wordmark to the right. */
const GRADIENT: readonly [readonly [number, number, number], readonly [number, number, number]] = [
  [78, 168, 255],
  [127, 136, 255],
];

export interface Segment {
  text: string;
  color: string;
  /** Position in the row; the screen keys by it. */
  at: number;
}

/** One colored segment per character, so the gradient runs across the row. */
export function logoSegments(row: string): Segment[] {
  const chars = [...row];
  const last = Math.max(1, chars.length - 1);
  return chars.map((text, at) => {
    const t = at / last;
    const [from, to] = GRADIENT;
    const channel = (k: 0 | 1 | 2) => Math.round(from[k] + (to[k] - from[k]) * t);
    const hex = [channel(0), channel(1), channel(2)].map((v) => v.toString(16).padStart(2, "0"));
    return { text, color: `#${hex.join("")}`, at };
  });
}
