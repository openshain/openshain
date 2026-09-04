import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bin = join(import.meta.dir, "bin.ts");

async function openshain(...args: string[]) {
  return openshainWith({}, ...args);
}

async function openshainWith(env: Record<string, string | undefined>, ...args: string[]) {
  const proc = Bun.spawn(["bun", bin, ...args], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
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

  test("an option without its value exits with 2 and says the arguments could not be read", async () => {
    const { code, stdout } = await openshain("run", "x", "--workspace");

    expect(code).toBe(2);
    expect(stdout).toContain("引数を解釈できません");
  });

  test("work without a subcommand prints the usage and exits with 2", async () => {
    const { code, stdout } = await openshain("work");

    expect(code).toBe(2);
    expect(stdout).toContain("使い方");
  });

  test("run without the API key in the environment is a config error that names the variable", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-bin-"));
    await openshain("init", "--workspace", root);

    const { code, stderr } = await openshainWith(
      { ANTHROPIC_API_KEY: undefined },
      "run",
      "x",
      "--workspace",
      root,
    );

    expect(code).toBe(1);
    expect(stderr).toContain("ANTHROPIC_API_KEY");
  });

  test("a directory without a config is a config error with exit 1", async () => {
    const root = await mkdtemp(join(tmpdir(), "openshain-bin-"));

    const { code, stderr } = await openshain("tools", "list", "--workspace", root);

    expect(code).toBe(1);
    expect(stderr).toContain("エラー(config) 設定の問題。");
    expect(stderr).toContain("openshain.yaml が見つかりません");
  });
});
