import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dir, "bin.ts");

async function openshain(...args: string[]) {
  const proc = Bun.spawn(["bun", bin, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("openshain", () => {
  test("--help prints the usage and exits with 0", async () => {
    const { code, stdout } = await openshain("--help");

    expect(code).toBe(0);
    expect(stdout).toContain("使い方");
  });

  test("no command prints the usage and exits with 2", async () => {
    const { code, stdout } = await openshain();

    expect(code).toBe(2);
    expect(stdout).toContain("使い方");
  });

  test("an unknown command exits with 2", async () => {
    const { code, stdout } = await openshain("bogus");

    expect(code).toBe(2);
    expect(stdout).toContain("不明なコマンド bogus");
  });

  test("an unknown option exits with 2 instead of crashing", async () => {
    const { code, stdout, stderr } = await openshain("run", "--foo", "x");

    expect(code).toBe(2);
    expect(stdout).toContain("不明なオプション --foo");
    expect(stderr).toBe("");
  });

  test("work without a subcommand prints the usage and exits with 2", async () => {
    const { code, stdout } = await openshain("work");

    expect(code).toBe(2);
    expect(stdout).toContain("使い方");
  });

  test("a directory without a config is a config error with exit 1", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-bin-"));

    const { code, stderr } = await openshain("tools", "list", "--workspace", root);

    expect(code).toBe(1);
    expect(stderr).toContain("エラー(config) 設定の問題。");
    expect(stderr).toContain("openshain.yaml が見つかりません");
  });
});
