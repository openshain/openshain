import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectNotices, renderNotices } from "../scripts/third-party-notices.ts";

/** Writes a package into `dir`, the way an installed dependency looks. */
async function pkg(
  dir: string,
  manifest: Record<string, unknown>,
  license?: { file: string; text: string },
) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(manifest));
  if (license) await writeFile(join(dir, license.file), license.text);
}

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "openshain-notices-"));
  const store = join(root, "node_modules", ".store");
  await pkg(join(root, "packages", "cli"), {
    name: "@openshain/cli",
    dependencies: { "@openshain/core": "workspace:*", ink: "7.1.1", gone: "1.0.0" },
    devDependencies: { biome: "2.0.0" },
  });
  await pkg(join(root, "packages", "core"), {
    name: "@openshain/core",
    dependencies: { yaml: "2.9.0" },
  });
  await pkg(join(store, "ink", "node_modules", "ink"), {
    name: "ink",
    version: "7.1.1",
    license: "MIT",
    dependencies: { chalk: "5.6.2" },
  });
  await pkg(
    join(store, "ink", "node_modules", "chalk"),
    { name: "chalk", version: "5.6.2", license: "MIT" },
    { file: "license", text: "Copyright (c) Sindre Sorhus\n" },
  );
  await pkg(
    join(store, "yaml", "node_modules", "yaml"),
    { name: "yaml", version: "2.9.0", license: "ISC", homepage: "https://eemeli.org/yaml/" },
    { file: "LICENSE", text: "ISC License\n" },
  );
  await pkg(join(store, "biome", "node_modules", "biome"), {
    name: "biome",
    version: "2.0.0",
    license: "MIT",
  });
  // Installed packages are symlinked into place, as the package manager leaves them.
  await mkdir(join(root, "packages", "cli", "node_modules"), { recursive: true });
  await mkdir(join(root, "packages", "core", "node_modules"), { recursive: true });
  await symlink(
    join(store, "ink", "node_modules", "ink"),
    join(root, "packages", "cli", "node_modules", "ink"),
  );
  await symlink(
    join(store, "yaml", "node_modules", "yaml"),
    join(root, "packages", "core", "node_modules", "yaml"),
  );
  return root;
}

describe("third-party notices", () => {
  test("collects the production closure, follows the links, and leaves development tools out", async () => {
    const notices = await collectNotices(await workspace());

    expect(notices.map((n) => `${n.name}@${n.version}`)).toEqual([
      "chalk@5.6.2",
      "ink@7.1.1",
      "yaml@2.9.0",
    ]);
    expect(notices.find((n) => n.name === "chalk")?.text).toBe("Copyright (c) Sindre Sorhus");
    // ink ships no license file of its own, so the reader is sent to where its terms are.
    expect(notices.find((n) => n.name === "ink")).toMatchObject({ license: "MIT", text: "" });
  });

  test("refuses a package that declares no license", async () => {
    const root = await workspace();
    await pkg(join(root, "node_modules", ".store", "ink", "node_modules", "chalk"), {
      name: "chalk",
      version: "5.6.2",
    });

    await expect(collectNotices(root)).rejects.toThrow(/chalk@5.6.2 declares no license/);
  });

  test("writes every name, version and license text, and says where a missing one is published", () => {
    const text = renderNotices([
      { name: "chalk", version: "5.6.2", license: "MIT", text: "Copyright (c) Sindre Sorhus" },
      { name: "ink", version: "7.1.1", license: "MIT", text: "", home: "https://example.test/ink" },
    ]);

    expect(text).toContain("2 packages:");
    expect(text).toContain("  chalk 5.6.2 (MIT)");
    expect(text).toContain("Copyright (c) Sindre Sorhus");
    expect(text).toContain("This package ships no license file. It declares MIT.");
    expect(text).toContain("https://example.test/ink");
    expect(text.endsWith("\n")).toBe(true);
  });

  test("the same dependencies always give the same file", () => {
    const notices = [
      { name: "b", version: "1.0.0", license: "MIT", text: "b" },
      { name: "a", version: "1.0.0", license: "ISC", text: "a" },
    ];
    expect(renderNotices(notices)).toBe(renderNotices(notices));
  });
});
