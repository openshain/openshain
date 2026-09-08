import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

/** One dependency that goes into the binary, with the notice its license asks to carry. */
export interface Notice {
  name: string;
  version: string;
  license: string;
  /** The package's own license file, or an empty string when it ships none. */
  text: string;
  /** Where the package is published, for one that ships no license file. */
  home?: string;
}

/** What npm allows as a package name: an optional scope, then the name. */
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** The files a package puts its license in, in the order they are looked for. */
const LICENSE_FILES = /^(LICEN[CS]E|COPYING|LICEN[CS]E[.-].*)(\.(md|txt))?$/i;

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Finds `name` from `fromDir` the way Node does: the nearest `node_modules` up the tree.
 * The directory is resolved through symlinks, so the walk continues from where the package
 * really is and finds the dependencies installed beside it.
 */
async function resolvePackage(fromDir: string, name: string): Promise<string | undefined> {
  // A dependency names itself, so the name decides which directories are read. Only a real
  // package name is followed; anything else could walk out of the tree.
  if (!PACKAGE_NAME.test(name)) throw new Error(`not a package name: ${name}`);
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    try {
      if ((await stat(join(candidate, "package.json"))).isFile()) return await realpath(candidate);
    } catch {
      // Not here; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function licenseText(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((name) => LICENSE_FILES.test(name)).sort();
  const file = names[0];
  return file ? (await readFile(join(dir, file), "utf8")).trim() : "";
}

function homepageOf(pkg: Record<string, unknown>): string | undefined {
  if (typeof pkg.homepage === "string") return pkg.homepage;
  const repository = pkg.repository;
  if (typeof repository === "string") return repository;
  const url = (repository as { url?: string } | undefined)?.url;
  return typeof url === "string" ? url : undefined;
}

function licenseId(pkg: Record<string, unknown>): string | undefined {
  if (typeof pkg.license === "string") return pkg.license;
  const list = pkg.licenses;
  if (Array.isArray(list)) {
    const types = list.map((l) => (l as { type?: string }).type).filter(Boolean);
    if (types.length > 0) return types.join(" OR ");
  }
  return undefined;
}

/**
 * Every dependency the binary carries: the production dependencies of the workspace packages
 * and, from there, the whole closure. Development dependencies are left out; they are not
 * compiled in. A package whose license the walk cannot name stops the collection, because a
 * binary must not ship code whose terms are unknown.
 */
export async function collectNotices(root: string): Promise<Notice[]> {
  const found = new Map<string, Notice>();
  const missing: string[] = [];
  const queue: { name: string; from: string }[] = [];
  const packagesDir = join(root, "packages");
  for (const name of (await readdir(packagesDir)).sort()) {
    const dir = join(packagesDir, name);
    const pkg = await readJson(join(dir, "package.json"));
    if (!pkg) continue;
    for (const dep of Object.keys((pkg.dependencies as Record<string, string>) ?? {})) {
      // A workspace package is ours; it is covered by the project's own license.
      if (!dep.startsWith("@openshain/")) queue.push({ name: dep, from: dir });
    }
  }
  while (queue.length > 0) {
    const next = queue.shift() as { name: string; from: string };
    const dir = await resolvePackage(next.from, next.name);
    if (!dir) {
      // Not installed, so not compiled in either: an optional dependency for another platform.
      missing.push(next.name);
      continue;
    }
    const pkg = await readJson(join(dir, "package.json"));
    if (!pkg) continue;
    const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
    const key = `${next.name}@${version}`;
    if (found.has(key)) continue;
    const license = licenseId(pkg);
    if (!license) throw new Error(`${key} declares no license; it cannot go into the binary`);
    const text = await licenseText(dir);
    const home = text === "" ? homepageOf(pkg) : undefined;
    found.set(key, { name: next.name, version, license, text, ...(home && { home }) });
    for (const dep of Object.keys((pkg.dependencies as Record<string, string>) ?? {})) {
      queue.push({ name: dep, from: dir });
    }
  }
  if (missing.length > 0)
    console.warn(`not installed, so left out: ${[...new Set(missing)].join(", ")}`);
  return [...found.values()].sort((a, b) =>
    a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name),
  );
}

const RULE = "-".repeat(78);

/** What to write for a package that ships no license file of its own. */
function noFile(notice: Notice): string {
  const where = notice.home ? ` Its terms are published at ${notice.home}.` : "";
  return `This package ships no license file. It declares ${notice.license}.${where}`;
}

/** The file that travels with the binary. The same dependencies always give the same file. */
export function renderNotices(notices: Notice[]): string {
  const head = [
    "openshain third-party notices",
    "",
    "openshain itself is licensed under the Apache License, Version 2.0; see LICENSE.",
    "The single-file executable also carries the open source software listed here, each",
    "under its own license. The notices below are reproduced as their licenses require.",
    "",
    `${notices.length} packages:`,
    ...notices.map((n) => `  ${n.name} ${n.version} (${n.license})`),
    "",
  ];
  const blocks = notices.map((n) =>
    [
      RULE,
      `${n.name} ${n.version}`,
      `License: ${n.license}`,
      RULE,
      "",
      n.text || noFile(n),
      "",
    ].join("\n"),
  );
  return `${[...head, ...blocks].join("\n")}\n`;
}

if (import.meta.main) {
  const root = new URL("..", import.meta.url).pathname;
  const notices = await collectNotices(root);
  process.stdout.write(renderNotices(notices));
}
