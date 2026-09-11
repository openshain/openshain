import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  type Authority,
  loadAuthority,
  matchGlob,
  mayReachInto,
  mayRead,
  PRINCIPALS_DIR_NAME,
  type Principal,
  RESERVED_PATHS,
  reaches,
} from "@openshain/core";

export interface PrincipalOptions {
  workspaceRoot: string;
  id: string;
  write: (line: string) => void;
}

/** How many matching paths are printed before the rest are counted instead. */
const SHOWN = 20;

/**
 * What one person's employee agent works on, and what it may do. Written by hand, a range and a
 * table of rules are easy to get subtly wrong: a glob that matches nothing, a delegation nobody
 * wrote, a rule that allows a path the range does not cover. Each of those fails quietly, so this
 * command says what the files actually add up to before somebody relies on them.
 */
export async function principalCheck(options: PrincipalOptions): Promise<number> {
  const { workspaceRoot, id, write } = options;
  let authority: Authority;
  try {
    authority = await loadAuthority(workspaceRoot);
  } catch (err) {
    write(err instanceof Error ? err.message : String(err));
    return 1;
  }
  const person = authority.principals.get(id);
  if (!person) {
    const written = [...authority.principals.keys()];
    write(
      written.length === 0
        ? `${PRINCIPALS_DIR_NAME}/ に誰も書かれていません。1 人 1 ファイルで ${PRINCIPALS_DIR_NAME}/<id>.yaml に書きます。`
        : `${id} は ${PRINCIPALS_DIR_NAME}/ にいません。書かれているのは ${written.join("、")} です。`,
    );
    return 1;
  }

  const problems: string[] = [];
  write(`${person.name}(${person.id})`);
  write(`  状態: ${person.status === "active" ? "在籍" : "退任(代理も承認もできません)"}`);
  write(`  役割: ${person.roles.length === 0 ? "なし" : person.roles.join("、")}`);

  const delegations = authority.delegations.filter((d) => d.principal === person.id);
  if (!authority.present) {
    write("  委任: authority/ が無いので、すべて許可です");
  } else if (delegations.length === 0) {
    write("  委任: ありません。この人の代理では何も実行できません");
    problems.push(`${person.id} の委任が authority/delegations.yaml にありません`);
  } else {
    write(`  委任: ${delegations.map((d) => d.profession).join("、")} として`);
  }

  if (person.reads === undefined) {
    write("  働く範囲: 会社フォルダ全体(reads を書いていません)");
  } else {
    write(`  働く範囲: ${person.reads.join("、")}`);
    const matched = await matching(workspaceRoot, person);
    if (matched.length === 0) {
      write("    一致するものがありません");
      problems.push(`${person.id} の reads に一致するファイルもフォルダもありません`);
    } else {
      write(`    一致するもの ${matched.length} 件`);
      for (const path of matched.slice(0, SHOWN)) write(`      ${path}`);
      if (matched.length > SHOWN) write(`      ほか ${matched.length - SHOWN} 件`);
    }
  }

  const byRole = authority.policy.rules.filter((rule) => named(rule.match.role, person.roles));
  if (byRole.length > 0) {
    write("  役割で一致する規則:");
    for (const rule of byRole) write(`    ${rule.id}(${rule.decision})`);
  }

  const outside = person.reads === undefined ? [] : allowedOutside(authority, person);
  if (outside.length > 0) {
    write("  範囲の外を allow している規則:");
    for (const rule of outside) write(`    ${rule}`);
    problems.push(`${person.id} の範囲の外を allow している規則があります。規則は範囲を広げません`);
  }

  if (problems.length === 0) {
    write("問題はありません。");
    return 0;
  }
  for (const problem of problems) write(problem);
  return 1;
}

/** Everything in the company folder this person's agent works on, as workspace-relative paths. */
async function matching(workspaceRoot: string, person: Principal): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(dir, entry.name);
      const path = relative(workspaceRoot, full).split(sep).join("/");
      if (entry.name.startsWith(".")) continue;
      if (dir === workspaceRoot && reserved(entry.name)) continue;
      if (mayRead(person, path)) found.push(path);
      if (entry.isDirectory() && mayReachInto(person, path)) await walk(full);
    }
  };
  await walk(workspaceRoot);
  return found;
}

/** Rules that allow a path the range does not cover: written in hope, and never effective. */
function allowedOutside(authority: Authority, person: Principal): string[] {
  const out: string[] = [];
  for (const rule of authority.policy.rules) {
    const path = rule.match.path;
    if (rule.decision !== "allow" || path === undefined) continue;
    if (rule.match.principal !== undefined && !named(rule.match.principal, [person.id])) continue;
    if (rule.match.role !== undefined && !named(rule.match.role, person.roles)) continue;
    const covered = (person.reads ?? []).some(
      (range) => matchGlob(range, path) || reaches(range, path) || matchGlob(path, range),
    );
    if (!covered) out.push(`${rule.id}(${path})`);
  }
  return out;
}

function named(expected: string | string[] | undefined, actual: readonly string[]): boolean {
  if (expected === undefined) return false;
  const wanted = Array.isArray(expected) ? expected : [expected];
  return wanted.some((one) => actual.includes(one));
}

function reserved(name: string): boolean {
  return (RESERVED_PATHS as readonly string[]).some(
    (path) => path.toLowerCase() === name.toLowerCase(),
  );
}
