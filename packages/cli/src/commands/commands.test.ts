import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeModelProvider } from "@openshain/agent/testing";
import { OpenshainError, parseConfig, type RuntimeProviders } from "@openshain/core";
import { standardTools } from "@openshain/tools";
import { findWorkspace } from "../workspace.ts";
import { configTemplate, detectLanguage, init } from "./init.ts";
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
    const config = parseConfig(text, { modelProviders: ["anthropic"] });
    expect(config.model?.apiKeyEnv).toBe("ANTHROPIC_API_KEY");
    expect(config.limits.maxModelCalls).toBe(30);
    expect(out.lines.join("\n")).toContain("openshain.yaml");
    const mcp = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.openshain).toEqual({ command: "openshain", args: ["mcp"] });
    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toContain("work_create");
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
    await expect(init({ workspaceRoot: root, write: out.write })).rejects.toBeInstanceOf(
      OpenshainError,
    );
  });

  test("reads the company's language for the template from the OS locale", () => {
    expect(detectLanguage({ LANG: "ja_JP.UTF-8" })).toBe("ja");
    expect(detectLanguage({ LANG: "en_US.UTF-8" })).toBe("en");
    expect(detectLanguage({ LANG: "de_DE.UTF-8", LC_ALL: "ja_JP.UTF-8" })).toBe("ja");
    expect(detectLanguage({ LANG: "C.UTF-8" })).toBe("ja");
    expect(detectLanguage({})).toBe("ja");
    expect(detectLanguage({ LANG: "fr_FR.UTF-8" })).toBe("en");
    expect(configTemplate("en")).toContain("language: en");
  });

  test("keeps an AGENTS.md that is already there", async () => {
    const root = await tmp();
    await writeFile(join(root, "AGENTS.md"), "# mine\n");
    const out = io();

    await init({ workspaceRoot: root, write: out.write });

    expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe("# mine\n");
    expect(out.lines.join("\n")).toContain("AGENTS.md はすでにあるので変更しません");
    expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe("@AGENTS.md\n");
  });

  test("adds openshain to a .mcp.json that already lists other servers, and leaves one that has it", async () => {
    const root = await tmp();
    await writeFile(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { other: { command: "other-mcp" } }, unrelated: 1 }, null, 2),
    );
    const out = io();

    await init({ workspaceRoot: root, write: out.write });

    const merged = JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"));
    expect(merged.mcpServers.other).toEqual({ command: "other-mcp" });
    expect(merged.mcpServers.openshain).toEqual({ command: "openshain", args: ["mcp"] });
    expect(merged.unrelated).toBe(1);
    expect(out.lines.join("\n")).toContain("openshain を追加しました");

    const again = io();
    await expect(init({ workspaceRoot: root, write: again.write })).rejects.toThrow(/上書き/);
  });

  test("leaves a .mcp.json it cannot read as JSON, and says so", async () => {
    const root = await tmp();
    await writeFile(join(root, ".mcp.json"), "{ not json");
    const out = io();

    await init({ workspaceRoot: root, write: out.write });

    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe("{ not json");
    expect(out.lines.join("\n")).toContain("JSON として読めない");
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

describe("tools list", () => {
  test("shows every tool with its provider and effect, and the ones an allow list hides", async () => {
    const model = new FakeModelProvider([]);
    const { root, providers } = await fakeWorkspace(model, "    allow: [fs_read, fs_write]\n");
    const out = io();

    await toolsList({ workspaceRoot: root, providers, write: out.write });

    const text = out.lines.join("\n");
    expect(text).toMatch(/fs_read\s+standard\s+observe\s+許可/);
    expect(text).toMatch(/fs_write\s+standard\s+mutate\s+許可/);
    expect(text).toMatch(/ask_user\s+runtime\s+observe\s+許可/);
    expect(text).toMatch(/csv_read\s+standard\s+observe\s+不許可/);
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
