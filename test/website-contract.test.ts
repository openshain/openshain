import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The official website builds from this repository at a release commit and reads the paths listed
 * in docs/website-integration.md. These tests keep that table and the files in step.
 */
const root = fileURLToPath(new URL("..", import.meta.url));
const contract = readFileSync(join(root, "docs", "website-integration.md"), "utf8");

/** The first backticked path of every row in the "サイトが読む path" table, the first table of the document. */
const table = (contract.split("## サイトが読む path")[1] ?? "").split("\n## ")[0] ?? "";
const listedPaths = table
  .split("\n")
  .filter((line) => /^\| `[^`]+` \|/.test(line))
  .map((line) => /^\| `([^`]+)` \|/.exec(line)?.[1])
  .filter((path): path is string => Boolean(path));

const brand = [
  "assets/openshain_wordmark_color.svg",
  "assets/openshain_logomark_color.svg",
  "assets/openshain_horizontal_lockup_color.svg",
  "assets/favicon.svg",
  "assets/favicon.ico",
];

describe("website contract", () => {
  test("the table lists the brand files, the version file, docs and spec", () => {
    for (const path of [...brand, "packages/cli/package.json", "docs/", "spec/", "CHANGELOG.md"]) {
      expect(listedPaths).toContain(path);
    }
  });

  test.each(listedPaths)("%s exists", (path: string) => {
    const full = join(root, path);
    expect(existsSync(full)).toBe(true);
    if (path.endsWith("/")) expect(statSync(full).isDirectory()).toBe(true);
    else expect(statSync(full).isFile()).toBe(true);
  });

  test("the CLI version is a stable semver and every package carries the same one", () => {
    const version = JSON.parse(
      readFileSync(join(root, "packages", "cli", "package.json"), "utf8"),
    ).version;
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    for (const name of ["core", "agent", "tools", "mcp"]) {
      const pkg = JSON.parse(readFileSync(join(root, "packages", name, "package.json"), "utf8"));
      expect(pkg.version).toBe(version);
    }
  });

  test("docs and spec have their index pages and the generated schemas are there", () => {
    for (const path of ["docs/design/README.md", "spec/README.md", "spec/schemas"]) {
      expect(existsSync(join(root, path))).toBe(true);
    }
  });
});
