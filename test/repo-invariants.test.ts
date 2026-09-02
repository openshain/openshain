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
    expect(pkg.exports?.["."]).toBe("./src/index.ts");
    expect(existsSync(join(packagesDir, name, "src", "index.ts"))).toBe(true);
  });

  test("nothing under packages/ imports from packs/ or examples/", () => {
    const forbidden = /(from\s+|import\()\s*["'][^"']*\/(packs|examples)\//;
    const offenders = [...sourceFiles(packagesDir)].filter((file) =>
      forbidden.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
