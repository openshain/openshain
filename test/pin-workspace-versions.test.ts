import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pinWorkspaceVersions } from "../scripts/pin-workspace-versions.ts";

describe("pin-workspace-versions", () => {
  test("replaces workspace:* with the version and leaves other ranges alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-pin-"));
    await mkdir(join(root, "packages", "a"), { recursive: true });
    await mkdir(join(root, "packages", "b"), { recursive: true });
    await writeFile(
      join(root, "packages", "a", "package.json"),
      JSON.stringify({ name: "a", dependencies: { b: "workspace:*", zod: "^4.0.0" } }),
    );
    await writeFile(join(root, "packages", "b", "package.json"), JSON.stringify({ name: "b" }));

    const changed = await pinWorkspaceVersions(root, "1.2.3");

    expect(changed).toEqual(["a"]);
    const a = JSON.parse(await readFile(join(root, "packages", "a", "package.json"), "utf8"));
    expect(a.dependencies).toEqual({ b: "1.2.3", zod: "^4.0.0" });
    await expect(pinWorkspaceVersions(root, "latest")).rejects.toThrow(/not a version/);
  });
});
