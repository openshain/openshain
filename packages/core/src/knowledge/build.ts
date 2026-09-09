import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readdir, realpath, rename } from "node:fs/promises";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import { readWorkspaceTextIfAny } from "../tool/files.ts";
import type { Checked } from "./check.ts";
import { KNOWLEDGE_DIR_NAME } from "./check.ts";
import type { LoadedRule, Scope, Source } from "./schema.ts";

/**
 * Turning what a person wrote into the index the runtime serves. The index is a build artifact:
 * the same input always makes the same bytes, and the manifest says which input it came from and
 * what the index itself hashes to, so a rewritten index is not served.
 */

/** Raised when the index is read by a runtime that indexes differently than the one that wrote it. */
export const INDEX_FORMAT_VERSION = 1;

/** An index this large was not built from a company's knowledge; it is not read. */
const MAX_INDEX_BYTES = 64 * 1024 * 1024;

const BUILD_DIR = "build";
const INDEX_FILE = "index.json";
const MANIFEST_FILE = "manifest.json";

/** One thing the search can return: a rule, or one section of a source. */
export interface IndexUnit {
  /** `rule:<id>` or `source:<id>#<heading>`; unique in the index. */
  key: string;
  kind: "rule" | "source";
  /** The id a person wrote, which citations name. */
  ref: string;
  heading: string;
  /** What the unit says: the statement of a rule, or the text of a section. */
  text: string;
  scope: Scope | null;
  expertise: string;
  from: string;
  to: string | null;
  /** For a rule, the source it cites. */
  source?: { id: string; section?: string };
  /** For a source, where it came from. */
  provenance?: { publisher: string; title: string; version?: string; retrieved_at: string };
}

export interface KnowledgeIndex {
  format: number;
  units: IndexUnit[];
  /** Grams of two and three characters to the units that contain them. */
  postings: { "2": Record<string, number[]>; "3": Record<string, number[]> };
  /** How many distinct three-character grams each unit has, for the length correction. */
  sizes: number[];
}

export interface Manifest {
  format: number;
  input_sha256: string;
  index_sha256: string;
  units: number;
  rules: number;
  sources: number;
  built_at: string;
}

/** Text as the index compares it: full width and half width alike, one case, no spaces. */
export function normalize(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/gu, "");
}

/** The distinct groups of `n` characters in the text. */
export function grams(text: string, n: number): Set<string> {
  const chars = [...normalize(text)];
  const out = new Set<string>();
  for (let i = 0; i + n <= chars.length; i++) out.add(chars.slice(i, i + n).join(""));
  return out;
}

/**
 * The index of a checked set. A rule that another rule replaces is closed the day before the
 * newer one starts, so the two are never in effect together.
 */
export function buildIndex(checked: Checked): KnowledgeIndex {
  const closed = closeSuperseded(checked.rules);
  const units: IndexUnit[] = [
    ...closed.map(ruleUnit),
    ...checked.sources.flatMap((source) => sectionUnits(source)),
  ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const postings: KnowledgeIndex["postings"] = { "2": {}, "3": {} };
  const sizes: number[] = [];
  for (const [at, unit] of units.entries()) {
    // What a unit is matched on: its own words, and its heading when that is not the words
    // themselves. The id is left out; it would only make a unit look longer than it reads.
    // Aliases are already part of a rule's text, and nothing else bridges words that share no
    // characters with it.
    const matter = unit.heading === unit.text ? unit.text : `${unit.text} ${unit.heading}`;
    for (const n of [2, 3] as const) {
      const list = postings[String(n) as "2" | "3"];
      for (const gram of grams(matter, n)) {
        const units = list[gram];
        if (units) units.push(at);
        else list[gram] = [at];
      }
    }
    sizes.push(grams(matter, 3).size);
  }
  for (const n of ["2", "3"] as const) {
    postings[n] = Object.fromEntries(
      Object.entries(postings[n])
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([gram, list]) => [gram, [...list].sort((x, y) => x - y)]),
    );
  }
  return { format: INDEX_FORMAT_VERSION, units, postings, sizes };
}

/** A rule replaced by another ends the day before that one begins. */
function closeSuperseded(rules: LoadedRule[]): LoadedRule[] {
  const replacedBy = new Map<string, LoadedRule>();
  for (const rule of rules) if (rule.supersedes) replacedBy.set(rule.supersedes, rule);
  return rules.map((rule) => {
    const next = replacedBy.get(rule.id);
    if (!next) return rule;
    const end = dayBefore(next.effective_from);
    return {
      ...rule,
      effective_to: rule.effective_to === null ? end : minDay(rule.effective_to, end),
    };
  });
}

function dayBefore(day: string): string {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() - 1);
  return at.toISOString().slice(0, 10);
}

const minDay = (a: string, b: string) => (a < b ? a : b);

function ruleUnit(rule: LoadedRule): IndexUnit {
  return {
    key: `rule:${rule.id}`,
    kind: "rule",
    ref: rule.id,
    heading: rule.statement,
    text: [rule.statement, ...(rule.aliases ?? [])].join(" "),
    scope: rule.scope ?? null,
    expertise: rule.expertise,
    from: rule.effective_from,
    to: rule.effective_to,
    source: {
      id: rule.source.id,
      ...(rule.source.section !== undefined && { section: rule.source.section }),
    },
  };
}

/** A source becomes one unit per heading; a source with no heading becomes one unit. */
function sectionUnits(source: Source): IndexUnit[] {
  const provenance = {
    publisher: source.publisher,
    title: source.title,
    ...(source.version !== undefined && { version: source.version }),
    retrieved_at: source.retrieved_at,
  };
  const common = {
    kind: "source" as const,
    ref: source.id,
    scope: source.scope ?? null,
    expertise: source.expertise,
    from: source.effective_from,
    to: source.effective_to,
    provenance,
  };
  const sections = split(source.body);
  if (sections.length === 0) {
    return [{ ...common, key: `source:${source.id}#`, heading: source.title, text: source.body }];
  }
  // Two sections of one document may carry the same heading. A key names one unit, so the
  // second one of a name says which it is.
  const seen = new Map<string, number>();
  return sections.map((section) => {
    const nth = (seen.get(section.heading) ?? 0) + 1;
    seen.set(section.heading, nth);
    return {
      ...common,
      key: `source:${source.id}#${section.heading}${nth === 1 ? "" : ` (${nth})`}`,
      heading: section.heading,
      text: section.text,
    };
  });
}

/** The body cut at its markdown headings. Text before the first heading joins the first section. */
function split(body: string): { heading: string; text: string }[] {
  const lines = body.split("\n");
  const sections: { heading: string; text: string[] }[] = [];
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) sections.push({ heading: heading[2] as string, text: [] });
    else sections.at(-1)?.text.push(line);
  }
  return sections.map((section) => ({
    heading: section.heading,
    text: section.text.join("\n").trim(),
  }));
}

/** The same bytes for the same index: keys in a fixed order, two spaces, a newline at the end. */
export function serializeIndex(index: KnowledgeIndex): string {
  const units = index.units.map((unit) => ordered(unit as unknown as Record<string, unknown>));
  const body = {
    format: index.format,
    postings: index.postings,
    sizes: index.sizes,
    units,
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/** An object with its keys in code point order, all the way down. */
function ordered(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const inner = value[key];
    out[key] =
      inner && typeof inner === "object" && !Array.isArray(inner)
        ? ordered(inner as Record<string, unknown>)
        : inner;
  }
  return out;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * The hash of what a person wrote, read from the files themselves rather than from what was
 * parsed out of them. The runtime recomputes this before it trusts an index.
 */
export async function hashKnowledgeInput(workspaceRoot: string): Promise<string> {
  const dir = join(workspaceRoot, KNOWLEDGE_DIR_NAME);
  const parts: string[] = [];
  for (const [sub, extension] of [
    ["rules", ".yaml"],
    ["sources", ".md"],
  ] as const) {
    let names: string[];
    try {
      names = (await readdir(join(dir, sub))).filter((n) => n.endsWith(extension)).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      // The same guarded read the checks use, so hashing and checking see one set of files: a
      // file too large to read, or a link that leads out, is refused here as it is there.
      const text = await readWorkspaceTextIfAny(dir, join(sub, name));
      parts.push(`${sub}/${name}\n${text === undefined ? "unreadable" : sha256(text)}`);
    }
  }
  return sha256(parts.join("\n"));
}

/**
 * Writes the index and then the manifest, each through a temporary file. The manifest lands last
 * and is the mark that the index beside it is whole: a reader that finds a manifest finds an
 * index that was fully written.
 */
export async function writeIndex(
  workspaceRoot: string,
  index: KnowledgeIndex,
  input: { hash: string; rules: number; sources: number },
  now: Date = new Date(),
): Promise<Manifest> {
  const dir = await buildDirectory(workspaceRoot);
  const serialized = serializeIndex(index);
  const manifest: Manifest = {
    format: INDEX_FORMAT_VERSION,
    input_sha256: input.hash,
    index_sha256: sha256(serialized),
    units: index.units.length,
    rules: input.rules,
    sources: input.sources,
    built_at: now.toISOString(),
  };
  await atomicWrite(join(dir, INDEX_FILE), serialized);
  await atomicWrite(join(dir, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/**
 * The directory the build writes into, once it is known to be that directory. `knowledge/` is
 * reserved from the tools, so the runtime writes here itself; a link left in the folder would
 * otherwise send the index, and the text a rule chose, anywhere the person can write.
 */
async function buildDirectory(workspaceRoot: string): Promise<string> {
  const root = await realpath(workspaceRoot);
  const dir = join(root, KNOWLEDGE_DIR_NAME, BUILD_DIR);
  await mkdir(dir, { recursive: true });
  if ((await realpath(dir)) !== dir) {
    throw new OpenshainError(
      "invalid_path",
      `${KNOWLEDGE_DIR_NAME}/${BUILD_DIR} leads out of the company folder; the index is not written`,
    );
  }
  return dir;
}

/**
 * Writes through a temporary file and renames it into place. The name of that file is easy to
 * guess, so it is opened without following a link: a link left there must not carry the write.
 */
async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = `${path}.writing`;
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(temporary, flags, 0o644);
  try {
    await handle.writeFile(text, "utf8");
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

/** What the runtime reads before it serves knowledge, or a reason not to serve any. */
export type IndexState =
  | { ok: true; index: KnowledgeIndex; manifest: Manifest }
  | { ok: false; reason: string };

/**
 * Reads the index only if it is the one the manifest describes and the manifest describes the
 * files that are there now. An index rewritten on its own, a manifest rewritten on its own, and
 * an index built by another version of the runtime all come back as a reason not to serve it.
 */
/**
 * A file of the build output, read from one descriptor that does not follow a link, and only
 * once its size is known. These two files are as writable as any other in the folder.
 */
async function readThere(dir: string, name: string): Promise<string> {
  const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
  const handle = await open(join(dir, name), flags);
  try {
    const { size } = await handle.stat();
    if (size > MAX_INDEX_BYTES) throw new Error(`${name} is too large to be an index`);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function readIndex(workspaceRoot: string): Promise<IndexState> {
  const dir = join(workspaceRoot, KNOWLEDGE_DIR_NAME, BUILD_DIR);
  const stale = {
    ok: false as const,
    reason: "the index does not match the files it was built from; run `openshain knowledge build`",
  };
  let manifest: Manifest;
  let serialized: string;
  try {
    // Read nothing before knowing its size: these two files are as writable as any other in the
    // folder, and an index of a company's knowledge is far below this.
    manifest = JSON.parse(await readThere(dir, MANIFEST_FILE)) as Manifest;
    serialized = await readThere(dir, INDEX_FILE);
  } catch {
    return { ok: false, reason: "there is no index; run `openshain knowledge build`" };
  }
  if (manifest.format !== INDEX_FORMAT_VERSION) {
    return {
      ok: false,
      reason:
        "the index was built by another version of openshain; run `openshain knowledge build`",
    };
  }
  if (sha256(serialized) !== manifest.index_sha256) return stale;
  if ((await hashKnowledgeInput(workspaceRoot)) !== manifest.input_sha256) return stale;
  try {
    return { ok: true, index: JSON.parse(serialized) as KnowledgeIndex, manifest };
  } catch {
    return stale;
  }
}
