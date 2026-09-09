import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseYamlFile } from "../config/yaml.ts";
import { isOpenshainError } from "../errors.ts";
import { readWorkspaceTextIfAny } from "../tool/files.ts";
import { resolveWorkspacePath } from "../tool/paths.ts";
import {
  type LoadedRule,
  RulesFileSchema,
  type Scope,
  type Source,
  SourceFrontMatterSchema,
} from "./schema.ts";

/**
 * Reading and checking what a person wrote under `knowledge/`. Every problem is collected, never
 * thrown at the first one: a person fixing a set of files should see all of it in one pass.
 */

export const KNOWLEDGE_DIR_NAME = "knowledge";

/** How much a build reads in total, and how many files it reads, whatever is in the folder. */
export const MAX_KNOWLEDGE_FILES = 2000;
export const MAX_KNOWLEDGE_BYTES = 64 * 1024 * 1024;
const RULES_DIR = "rules";
const SOURCES_DIR = "sources";

export interface Checked {
  rules: LoadedRule[];
  sources: Source[];
  /** Everything wrong with what was read, each as `file:line:col field: message` or `file: message`. */
  problems: string[];
}

/** True when the workspace has a `knowledge/` directory to read at all. */
export async function hasKnowledge(workspaceRoot: string): Promise<boolean> {
  try {
    await readdir(join(workspaceRoot, KNOWLEDGE_DIR_NAME));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads `knowledge/rules/*.yaml` and `knowledge/sources/*.md` and checks them against each other.
 * The rules that come back are the ones a build would index; when `problems` is not empty, nothing
 * should be written.
 */
export async function checkKnowledge(
  workspaceRoot: string,
  options: {
    /**
     * Rules to check as though they were already written, with the file they would go in. A
     * command that adds one asks this first, so that a rule which does not hold up is never
     * written at all.
     */
    adding?: LoadedRule[];
  } = {},
): Promise<Checked> {
  const dir = join(workspaceRoot, KNOWLEDGE_DIR_NAME);
  const problems: string[] = [];
  const budget = { files: MAX_KNOWLEDGE_FILES, bytes: MAX_KNOWLEDGE_BYTES };
  const rules = [...(await readRules(dir, problems, budget)), ...(options.adding ?? [])];
  const sources = await readSources(dir, problems, budget);

  await checkPaths(workspaceRoot, sources, problems);
  crossCheck(rules, sources, problems);
  return { rules, sources, problems: problems.sort() };
}

/** Files of a directory in code point order; an unreadable directory is simply empty. */
async function filesOf(dir: string, extension: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((name) => name.endsWith(extension) && !name.startsWith("."))
      .sort();
  } catch {
    return [];
  }
}

/** What a read may still take. A build reads a bounded amount, whatever the folder holds. */
interface Budget {
  files: number;
  bytes: number;
}

/** The text of a file, or a reason it was not read. Spends the budget as it goes. */
async function within(
  dir: string,
  relative: string,
  file: string,
  budget: Budget,
  problems: string[],
): Promise<string | undefined> {
  if (budget.files <= 0 || budget.bytes <= 0) {
    problems.push(`${file}: not read; a build reads at most ${MAX_KNOWLEDGE_FILES} files`);
    return undefined;
  }
  budget.files -= 1;
  const text = await readWorkspaceTextIfAny(dir, relative);
  if (text === undefined) {
    problems.push(`${file}: cannot read the file`);
    return undefined;
  }
  budget.bytes -= Buffer.byteLength(text, "utf8");
  return text;
}

async function readRules(dir: string, problems: string[], budget: Budget): Promise<LoadedRule[]> {
  const rules: LoadedRule[] = [];
  for (const name of await filesOf(join(dir, RULES_DIR), ".yaml")) {
    const file = `${KNOWLEDGE_DIR_NAME}/${RULES_DIR}/${name}`;
    const text = await within(dir, join(RULES_DIR, name), file, budget, problems);
    if (text === undefined) continue;
    try {
      const { data } = parseYamlFile(text, RulesFileSchema, file);
      for (const rule of data.rules) rules.push({ ...rule, file });
    } catch (err) {
      problems.push(...messageOf(err, file));
    }
  }
  return rules;
}

async function readSources(dir: string, problems: string[], budget: Budget): Promise<Source[]> {
  const sources: Source[] = [];
  for (const name of await filesOf(join(dir, SOURCES_DIR), ".md")) {
    const file = `${KNOWLEDGE_DIR_NAME}/${SOURCES_DIR}/${name}`;
    const text = await within(dir, join(SOURCES_DIR, name), file, budget, problems);
    if (text === undefined) continue;
    const split = frontMatter(text);
    if (!split) {
      problems.push(`${file}: the file must start with front matter between --- lines`);
      continue;
    }
    try {
      const { data } = parseYamlFile(split.head, SourceFrontMatterSchema, file);
      sources.push({ ...data, body: split.body, file });
    } catch (err) {
      problems.push(...messageOf(err, file));
    }
  }
  return sources;
}

/** The YAML between the opening `---` and the next one, and everything after it. */
function frontMatter(text: string): { head: string; body: string } | undefined {
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.indexOf("---", 1);
  if (end < 0) return undefined;
  return {
    head: lines.slice(1, end).join("\n"),
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

function messageOf(err: unknown, file: string): string[] {
  if (isOpenshainError(err)) return err.message.split("\n");
  return [`${file}: ${err instanceof Error ? err.message : String(err)}`];
}

/**
 * A source that names a file names it inside the company folder. The guard the tools run under
 * answers this, so a source cannot pull `authority/`, a principal's record or anything outside
 * the folder into the index.
 */
async function checkPaths(
  workspaceRoot: string,
  sources: Source[],
  problems: string[],
): Promise<void> {
  for (const source of sources) {
    if (source.path === undefined) continue;
    try {
      await resolveWorkspacePath(workspaceRoot, source.path);
    } catch (err) {
      problems.push(
        `${source.file}: ${source.id} points at ${source.path}, which the runtime does not read (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
}

/** The checks that need more than one file: references, scope, effective days. */
function crossCheck(rules: LoadedRule[], sources: Source[], problems: string[]): void {
  const byId = new Map(sources.map((source) => [source.id, source]));
  for (const source of duplicates(sources)) {
    problems.push(`${source.file}: source ${source.id} is defined more than once`);
  }
  for (const rule of duplicates(rules)) {
    problems.push(`${rule.file}: rule ${rule.id} is defined more than once`);
  }
  for (const item of [...sources, ...rules]) endsAfterItStarts(item, problems);
  for (const rule of rules) againstItsSource(rule, byId.get(rule.source.id), problems);
  overlaps(rules, problems);
}

/** A day of the calendar comes before another; a rule or a source that ends first says nothing. */
function endsAfterItStarts(
  item: { id: string; file: string; effective_from: string; effective_to: string | null },
  problems: string[],
): void {
  if (item.effective_to !== null && item.effective_to < item.effective_from) {
    problems.push(`${item.file}: ${item.id} ends before it starts`);
  }
}

/**
 * A rule stands on the source it cites, so it may not exist without it, outlive it, begin before
 * it, or be read by people who may not read it.
 */
function againstItsSource(rule: LoadedRule, source: Source | undefined, problems: string[]): void {
  if (!source) {
    problems.push(`${rule.file}: ${rule.id} cites ${rule.source.id}, which no source declares`);
    return;
  }
  if (rule.effective_from < source.effective_from) {
    problems.push(
      `${rule.file}: ${rule.id} starts before ${source.id}, the source it cites, is in effect`,
    );
  }
  if (source.effective_to !== null && (rule.effective_to ?? FOREVER) > source.effective_to) {
    problems.push(
      `${rule.file}: ${rule.id} outlives ${source.id}, the source it cites; close it on ${source.effective_to} or cite a newer source`,
    );
  }
  if (!covers(source.scope, rule.scope)) {
    problems.push(
      `${rule.file}: ${rule.id} may be read by more people than ${source.id}, the source it cites; its citation would name a source they cannot read`,
    );
  }
}

/** A day later than any a person would write, for a rule or a source with no end. */
const FOREVER = "9999-12-31";

/** The items whose id was already taken by an earlier item. */
function duplicates<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const again: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) again.push(item);
    else seen.add(item.id);
  }
  return again;
}

/** The people a scope names, and how it names them. Company-wide names everyone. */
function named(scope: Scope | undefined): {
  kind: "everyone" | "principals" | "roles";
  who: string[];
} {
  if (scope === undefined || "visibility" in scope) return { kind: "everyone", who: [] };
  if ("principals" in scope) return { kind: "principals", who: scope.principals };
  return { kind: "roles", who: scope.roles };
}

/** Whether everyone who may read `inner` may also read `outer`. */
function covers(outer: Scope | undefined, inner: Scope | undefined): boolean {
  const wider = named(outer);
  const narrower = named(inner);
  if (wider.kind === "everyone") return true;
  if (narrower.kind === "everyone") return false;
  // Two lists of different kinds cannot be compared without knowing who holds which role.
  if (wider.kind !== narrower.kind) return false;
  const allowed = new Set(wider.who);
  return narrower.who.every((name) => allowed.has(name));
}

/**
 * Two rules drawn from the very same passage, both in effect, are two answers to one question
 * unless one says it replaces the other or they are for different people or professions.
 *
 * The passage, not the document: one policy document backs many rules — receipts over one
 * amount, an approval over another — and that is how a company writes. Only rules that name the
 * same section of the same source are compared, so ordinary writing is never refused.
 */
function overlaps(rules: LoadedRule[], problems: string[]): void {
  const replaced = new Set(rules.map((rule) => rule.supersedes).filter(Boolean));
  for (const [i, rule] of rules.entries()) {
    for (const other of rules.slice(i + 1)) {
      if (rule.source.id !== other.source.id) continue;
      if (rule.source.section === undefined || rule.source.section !== other.source.section) {
        continue;
      }
      if (replaced.has(rule.id) || replaced.has(other.id)) continue;
      if (!inEffectTogether(rule, other)) continue;
      if (disjoint(rule, other)) continue;
      problems.push(
        `${other.file}: ${other.id} and ${rule.id} both cite ${rule.source.id} の ${rule.source.section} and are in effect at the same time; close one with effective_to, or say supersedes`,
      );
    }
  }
}

function inEffectTogether(a: LoadedRule, b: LoadedRule): boolean {
  const end = (rule: LoadedRule) => rule.effective_to ?? FOREVER;
  return a.effective_from <= end(b) && b.effective_from <= end(a);
}

/** Rules that no one person and no one profession sees together do not contradict each other. */
function disjoint(a: LoadedRule, b: LoadedRule): boolean {
  const professions = (rule: LoadedRule) => rule.applies_to?.profession;
  const pa = professions(a);
  const pb = professions(b);
  if (pa && pb && !pa.some((name) => pb.includes(name))) return true;
  return !covers(a.scope, b.scope) && !covers(b.scope, a.scope);
}
