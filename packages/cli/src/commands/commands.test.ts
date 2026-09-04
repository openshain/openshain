import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTools, FakeModelProvider, say } from "@openshain/agent/testing";
import { OpenshainError, type RuntimeProviders } from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { findWorkspace } from "../workspace.ts";
import { init } from "./init.ts";
import { run } from "./run.ts";
import { toolsList } from "./tools.ts";

function io() {
  const lines: string[] = [];
  return { lines, write: (line: string) => void lines.push(line) };
}

async function tmp() {
  return mkdtemp(join(tmpdir(), "openshain-cli-"));
}

async function fakeWorkspace(model: FakeModelProvider, extra = "") {
  const root = await tmp();
  await writeFile(
    join(root, "openshain.yaml"),
    `version: 1
company:
  name: サンプル株式会社
principal:
  id: alice
  name: Alice
profession:
  id: generic
  instructions: 事務担当として働く。
model:
  provider: fake
  model: fake-1
  api_key_env: FAKE_API_KEY
tools:
  - provider: standard
${extra}`,
  );
  await mkdir(join(root, "receipts"));
  await writeFile(join(root, "receipts", "2026-07.csv"), "date,amount\n2026-07-01,100\n");
  const providers: RuntimeProviders = {
    models: { fake: () => model },
    tools: { standard: () => standardTools() },
  };
  return { root, providers };
}

describe("init", () => {
  test("writes a config template the runtime accepts, and refuses to overwrite it", async () => {
    const root = await tmp();
    const out = io();

    await init({ workspaceRoot: root, write: out.write });

    const text = await readFile(join(root, "openshain.yaml"), "utf8");
    expect(text).toContain("version: 1");
    expect(text).toContain("api_key_env: ANTHROPIC_API_KEY");
    expect(out.lines.join("\n")).toContain("openshain.yaml");
    await expect(init({ workspaceRoot: root, write: out.write })).rejects.toBeInstanceOf(
      OpenshainError,
    );
  });

  test("names the directory when it does not exist", async () => {
    const root = await tmp();
    const missing = join(root, "missing");

    const err = await init({ workspaceRoot: missing, write: () => {} }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(OpenshainError);
    expect((err as OpenshainError).code).toBe("config");
    expect((err as OpenshainError).message).toContain(missing);
  });
});

describe("findWorkspace", () => {
  test("walks up from a nested directory to the directory holding openshain.yaml", async () => {
    const root = await tmp();
    await writeFile(join(root, "openshain.yaml"), "version: 1\n");
    await mkdir(join(root, "a", "b"), { recursive: true });

    expect(await findWorkspace(join(root, "a", "b"))).toBe(root);
  });

  test("fails with a config error when no workspace is found", async () => {
    const root = await tmp();

    await expect(findWorkspace(root)).rejects.toBeInstanceOf(OpenshainError);
  });
});

describe("run", () => {
  test("runs a request to completion and reports each tool call, the outcome and the usage", async () => {
    const model = new FakeModelProvider([
      callTools({ id: "c1", name: "csv_read", input: { path: "receipts/2026-07.csv" } }),
      callTools({ id: "c2", name: "fs_write", input: { path: "summary.md", content: "# 100\n" } }),
      say("summary.md に書きました"),
    ]);
    const { root, providers } = await fakeWorkspace(model);
    const out = io();

    const code = await run({
      workspaceRoot: root,
      providers,
      objective: "集計して",
      write: out.write,
      ask: async () => "",
    });

    expect(code).toBe(0);
    const text = out.lines.join("\n");
    expect(text).toContain("csv_read receipts/2026-07.csv");
    expect(text).toContain("fs_write summary.md");
    expect(text).toContain("summary.md に書きました");
    expect(text).toMatch(/model 呼び出し 3 回/);
    expect(text).toMatch(/Tool 呼び出し 2 回/);
    expect(text).toContain("完了");
    expect(await readFile(join(root, "summary.md"), "utf8")).toBe("# 100\n");
  });

  test("asks the person on the terminal and continues with the answer", async () => {
    const model = new FakeModelProvider([
      callTools({ id: "q1", name: "ask_user", input: { question: "どの月?" } }),
      say("7月分を集計しました"),
    ]);
    const { root, providers } = await fakeWorkspace(model);
    const out = io();
    const asked: string[] = [];

    const code = await run({
      workspaceRoot: root,
      providers,
      objective: "集計して",
      write: out.write,
      ask: async (q) => {
        asked.push(q);
        return "7月";
      },
    });

    expect(code).toBe(0);
    expect(asked).toEqual(["どの月?"]);
    expect(out.lines.join("\n")).toContain("7月分を集計しました");
  });

  test("reports a failed work with the reason and exits non-zero", async () => {
    const model = new FakeModelProvider([{ ...say("no"), stopReason: "refusal" }]);
    const { root, providers } = await fakeWorkspace(model);
    const out = io();

    const code = await run({
      workspaceRoot: root,
      providers,
      objective: "x",
      write: out.write,
      ask: async () => "",
    });

    expect(code).toBe(1);
    expect(out.lines.join("\n")).toContain("model が拒否した");
  });

  test("prints a line for a tool call that failed", async () => {
    const model = new FakeModelProvider([
      callTools({ id: "c1", name: "fs_read", input: { path: "missing.csv" } }),
      say("見つかりませんでした"),
    ]);
    const { root, providers } = await fakeWorkspace(model);
    const out = io();

    await run({
      workspaceRoot: root,
      providers,
      objective: "x",
      write: out.write,
      ask: async () => "",
    });

    expect(out.lines.join("\n")).toMatch(/^fs_read は失敗しました。.+$/m);
  });

  test("without a way to ask, leaves the work waiting and shows the question", async () => {
    const model = new FakeModelProvider([
      callTools({ id: "q1", name: "ask_user", input: { question: "どの月?" } }),
      say("never"),
    ]);
    const { root, providers } = await fakeWorkspace(model);
    const out = io();

    const code = await run({
      workspaceRoot: root,
      providers,
      objective: "集計して",
      write: out.write,
    });

    expect(code).toBe(1);
    const text = out.lines.join("\n");
    expect(text).toContain("利用者の入力を待っています。");
    expect(text).toContain("  質問 どの月?");
    expect(text).toContain("次は利用者の番です");
  });
});

describe("tools list", () => {
  test("shows every tool with its provider and effect, and the ones an allow list hides", async () => {
    const model = new FakeModelProvider([]);
    const { root, providers } = await fakeWorkspace(model, "    allow: [fs_read, fs_write]\n");
    const out = io();

    await toolsList({ workspaceRoot: root, providers, write: out.write });

    const text = out.lines.join("\n");
    expect(text).toMatch(/fs_read\s+standard\s+observe/);
    expect(text).toMatch(/fs_write\s+standard\s+mutate/);
    expect(text).toContain("ask_user");
    expect(text).toMatch(/csv_read.*許可されていない/);
  });
});

describe("tools list without a model provider", () => {
  test("lists the tools even when no model provider is wired", async () => {
    const model = new FakeModelProvider([]);
    const { root } = await fakeWorkspace(model);
    const providers: RuntimeProviders = { models: {}, tools: { standard: () => standardTools() } };
    const out = io();

    await toolsList({ workspaceRoot: root, providers, write: out.write });

    expect(out.lines.join("\n")).toMatch(/fs_read\s+standard\s+observe/);
  });
});
