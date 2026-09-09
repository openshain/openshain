import { grams, type IndexUnit, type KnowledgeIndex, normalize } from "./build.ts";

/**
 * Finding a unit by the characters it shares with a question. There is no embedding and no
 * outside search engine: the index is groups of two and three characters, and the score is how
 * much of the question a unit accounts for.
 */

export interface Hit {
  unit: IndexUnit;
  /** Between 0 and 1. The share of the question's grams the unit holds, corrected for length. */
  score: number;
}

/** The shortest question the index can answer. One character matches almost everything. */
export const MIN_QUERY_LENGTH = 2;

export interface SearchOptions {
  /** How many hits to return. */
  limit?: number;
  /** Only these units are searched. Everything else is invisible, count included. */
  allowed?: (unit: IndexUnit) => boolean;
}

/**
 * The best units for a question, most fitting first. Two hits with the same score keep the order
 * of their keys, so the same index and question always answer the same way.
 */
export function search(index: KnowledgeIndex, query: string, options: SearchOptions = {}): Hit[] {
  const text = normalize(query);
  if (text.length < MIN_QUERY_LENGTH) return [];
  // A question of two characters has no group of three, and two-character words are ordinary in
  // Japanese business writing, so the shorter grams answer it.
  const n = text.length < 3 ? 2 : 3;
  const wanted = grams(query, n);
  if (wanted.size === 0) return [];
  const postings = n === 2 ? index.postings.pairs : index.postings.triples;

  const allowed = options.allowed ?? (() => true);
  // Narrow before scoring: what a person may not read costs nothing to rank, and the time a
  // search takes then says nothing about how much of it there is.
  const visible = new Set<number>();
  for (const [at, unit] of index.units.entries()) if (allowed(unit)) visible.add(at);

  const matched = new Map<number, number>();
  for (const gram of wanted) {
    for (const at of postings[gram] ?? []) {
      if (visible.has(at)) matched.set(at, (matched.get(at) ?? 0) + 1);
    }
  }

  const hits: Hit[] = [];
  for (const [at, count] of matched) {
    const unit = index.units[at];
    if (!unit) continue;
    hits.push({ unit, score: (count / wanted.size) * lengthCorrection(index.sizes[at] ?? 0) });
  }
  hits.sort((a, b) => b.score - a.score || (a.unit.key < b.unit.key ? -1 : 1));
  return hits.slice(0, options.limit ?? 5);
}

/**
 * A long document holds more groups of characters and so matches more questions by size alone.
 * The correction keeps a short rule from losing to a page of prose that happens to contain the
 * same words; it lowers a long unit's score without ever ruling it out.
 */
function lengthCorrection(size: number): number {
  return 1 / (1 + Math.log10(1 + size / 40));
}

/** Whether a unit is in effect on a day. */
export function inEffect(unit: IndexUnit, day: string): boolean {
  return unit.from <= day && (unit.to === null || day <= unit.to);
}
