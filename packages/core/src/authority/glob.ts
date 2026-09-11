/**
 * Matching a path against the shape a person wrote. One spelling for both sides: macOS and
 * Windows hold `HR/` and `hr/` as the same directory, and Japanese names arrive composed either
 * way, so a rule written one way has to hold for the other.
 */

/**
 * Matches a workspace-relative path against a glob: `*` stands for part of one segment, `**`
 * for any number of whole segments. No other syntax. `ledger/**` matches everything under
 * ledger/, `*.csv` a CSV at the root, `**\/*.csv` a CSV anywhere.
 */
export function matchGlob(pattern: string, path: string): boolean {
  // Repeated `**` means the same as one, and collapsing them keeps the match linear.
  const parts = folded(pattern)
    .split("/")
    .filter((part, i, all) => part !== "**" || all[i - 1] !== "**");
  return matchSegments(parts, folded(path).split("/"));
}

/**
 * One spelling for both sides of the comparison. macOS and Windows hold `HR/` and `hr/` as the
 * same directory, and Japanese names can arrive composed either way, so a rule written in one
 * spelling has to hold for the other. The reserved paths are compared this way already.
 */
function folded(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

function matchSegments(pattern: string[], path: string[]): boolean {
  if (pattern.length === 0) return path.length === 0;
  const [head, ...rest] = pattern as [string, ...string[]];
  if (head === "**") {
    for (let i = 0; i <= path.length; i++) {
      if (matchSegments(rest, path.slice(i))) return true;
    }
    return false;
  }
  if (path.length === 0) return false;
  const [segment, ...remaining] = path as [string, ...string[]];
  return matchSegment(head, segment) && matchSegments(rest, remaining);
}

function matchSegment(pattern: string, segment: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === segment;
  let position = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (i === 0) {
      if (!segment.startsWith(part)) return false;
      position = part.length;
    } else if (i === parts.length - 1) {
      return segment.slice(position).endsWith(part);
    } else {
      const found = segment.indexOf(part, position);
      if (found === -1) return false;
      position = found + part.length;
    }
  }
  return true;
}

/**
 * Whether anything inside this directory could match the pattern. Used to stay out of a folder
 * altogether: walking into one only to drop everything it holds costs time and, on a slow disk,
 * says by its own delay that something is there.
 */
export function reaches(pattern: string, dir: string): boolean {
  if (matchGlob(pattern, dir)) return true;
  const parts = pattern.split("/");
  const segments = dir === "" || dir === "." ? [] : dir.split("/");
  for (let i = 0; i < segments.length; i++) {
    const part = parts[i];
    if (part === undefined) return false;
    if (part === "**") return true;
    if (!matchGlob(part, segments[i] as string)) return false;
  }
  return true;
}
