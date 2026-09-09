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
export async function checkKnowledge(workspaceRoot: string): Promise<Checked> {
  const dir = join(workspaceRoot, KNOWLEDGE_DIR_NAME);
  const problems: string[] = [];
  const rules = await readRules(dir, problems);
  const sources = await readSources(dir, problems);

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

async function readRules(dir: string, problems: string[]): Promise<LoadedRule[]> {
  const rules: LoadedRule[] = [];
  for (const name of await filesOf(join(dir, RULES_DIR), ".yaml")) {
    const file = `${KNOWLEDGE_DIR_NAME}/${RULES_DIR}/${name}`;
    const text = await readWorkspaceTextIfAny(dir, join(RULES_DIR, name));
    if (text === undefined) {
      problems.push(`${file}: cannot read the file`);
      continue;
    }
    try {
      const { data } = parseYamlFile(text, RulesFileSchema, file);
      for (const rule of data.rules) rules.push({ ...rule, file });
    } catch (err) {
      problems.push(...messageOf(err, file));
    }
  }
  return rules;
}

async function readSources(dir: string, problems: string[]): Promise<Source[]> {
  const sources: Source[] = [];
  for (const name of await filesOf(join(dir, SOURCES_DIR), ".md")) {
    const file = `${KNOWLEDGE_DIR_NAME}/${SOURCES_DIR}/${name}`;
    const text = await readWorkspaceTextIfAny(dir, join(SOURCES_DIR, name));
    if (text === undefined) {
      problems.push(`${file}: cannot read the file`);
      continue;
    }
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
  for (const source of duplicates(sources.map((s) => ({ id: s.id, file: s.file })))) {
    problems.push(`${source.file}: source ${source.id} is defined more than once`);
  }
  for (const rule of duplicates(rules.map((r) => ({ id: r.id, file: r.file })))) {
    problems.push(`${rule.file}: rule ${rule.id} is defined more than once`);
  }

  for (const source of sources) {
    if (source.effective_to !== null && source.effective_to < source.effective_from) {
      problems.push(`${source.file}: ${source.id} ends before it starts`);
    }
  }

  for (const rule of rules) {
    if (rule.effective_to !== null && rule.effective_to < rule.effective_from) {
      problems.push(`${rule.file}: ${rule.id} ends before it starts`);
    }
    const source = byId.get(rule.source.id);
    if (!source) {
      problems.push(`${rule.file}: ${rule.id} cites ${rule.source.id}, which no source declares`);
      continue;
    }
    if (rule.effective_from < source.effective_from) {
      problems.push(
        `${rule.file}: ${rule.id} starts before ${source.id}, the source it cites, is in effect`,
      );
    }
    if (source.effective_to !== null && (rule.effective_to ?? "9999-12-31") > source.effective_to) {
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

  overlaps(rules, problems);
}

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
 * Two rules that cite the same source and are in effect at once contradict each other unless one
 * says it replaces the other, or they are read by different people or professions.
 */
function overlaps(rules: LoadedRule[], problems: string[]): void {
  const replaced = new Set(rules.map((rule) => rule.supersedes).filter(Boolean));
  for (const [i, rule] of rules.entries()) {
    for (const other of rules.slice(i + 1)) {
      if (rule.source.id !== other.source.id) continue;
      if (replaced.has(rule.id) || replaced.has(other.id)) continue;
      if (!inEffectTogether(rule, other)) continue;
      if (disjoint(rule, other)) continue;
      problems.push(
        `${other.file}: ${other.id} and ${rule.id} both cite ${rule.source.id} and are in effect at the same time; close one with effective_to, or say supersedes`,
      );
    }
  }
}

function inEffectTogether(a: LoadedRule, b: LoadedRule): boolean {
  const end = (rule: LoadedRule) => rule.effective_to ?? "9999-12-31";
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
