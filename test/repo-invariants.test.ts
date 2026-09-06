import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const packagesDir = join(root, "packages");
const packages = readdirSync(packagesDir).filter((name) =>
  statSync(join(packagesDir, name)).isDirectory(),
);

function* sourceFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(path);
    else if (/\.(ts|tsx|js|mjs)$/.test(entry.name)) yield path;
  }
}

describe("packages", () => {
  test.each(packages)("%s declares name, license and a src entry point", (name: string) => {
    const pkg = JSON.parse(readFileSync(join(packagesDir, name, "package.json"), "utf8"));
    expect(pkg.name).toBeTruthy();
    expect(pkg.license).toBe("Apache-2.0");
    expect(pkg.exports?.["."]).toEqual({
      bun: "./src/index.ts",
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
    });
    expect(pkg.engines).toEqual({ node: ">=22", bun: ">=1.3" });
    expect(existsSync(join(packagesDir, name, "src", "index.ts"))).toBe(true);
  });

  test("bun.lock records the version each workspace package declares", () => {
    // bun publish and bun pm pack take workspace versions from the lockfile, so a stale
    // lockfile publishes a package that depends on the previous release.
    const lock = readFileSync(join(root, "bun.lock"), "utf8");
    for (const name of packages) {
      const declared = JSON.parse(
        readFileSync(join(packagesDir, name, "package.json"), "utf8"),
      ).version;
      const entry = new RegExp(
        `"packages/${name}": \\{\\s*"name": "[^"]+",\\s*"version": "([^"]+)"`,
      ).exec(lock);
      expect(entry?.[1]).toBe(declared);
    }
  });

  test("runtime code uses no Bun-only API, so the published packages run on Node", () => {
    const offenders = [...sourceFiles(packagesDir)].filter(
      (file) => !/\.test\.tsx?$/.test(file) && /\bBun\.[a-zA-Z]/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  test("nothing under packages/ imports from packs/ or examples/", () => {
    const forbidden = /(from\s+|import\()\s*["'][^"']*\/(packs|examples)\//;
    const offenders = [...sourceFiles(packagesDir)].filter((file) =>
      forbidden.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
