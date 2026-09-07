import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Replaces every `workspace:*` dependency under packages/ with the given version, so that
 * `npm publish` (which does not understand the workspace protocol) publishes packages that
 * depend on the versions released together. Run on the CI runner just before publishing;
 * the change is not meant to be committed.
 */
export async function pinWorkspaceVersions(root: string, version: string): Promise<string[]> {
  if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`not a version: ${version}`);
  }
  const changed: string[] = [];
  const packagesDir = join(root, "packages");
  for (const name of await readdir(packagesDir)) {
    const file = join(packagesDir, name, "package.json");
    const pkg = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    let touched = false;
    for (const field of ["dependencies", "devDependencies", "peerDependencies"]) {
      const deps = pkg[field] as Record<string, string> | undefined;
      if (!deps) continue;
      for (const dep of Object.keys(deps)) {
        if (deps[dep] === "workspace:*") {
          deps[dep] = version;
          touched = true;
        }
      }
    }
    if (touched) {
      await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
      changed.push(name);
    }
  }
  return changed;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: bun scripts/pin-workspace-versions.ts <version>");
    process.exit(2);
  }
  const root = new URL("..", import.meta.url).pathname;
  const changed = await pinWorkspaceVersions(root, version);
  console.log(`pinned workspace dependencies to ${version} in: ${changed.join(", ") || "nothing"}`);
}
