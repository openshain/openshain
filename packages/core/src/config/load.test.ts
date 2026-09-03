import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenshainError } from "../errors.ts";
import { loadConfig, parseConfig } from "./load.ts";

const example = `version: 1
company:
  name: サンプル株式会社
principal:
  id: alice
  name: Alice
profession:
  id: generic
  instructions: |
    あなたはこの会社の事務担当です。
model:
  provider: anthropic
  model: claude-opus-5
  api_key_env: ANTHROPIC_API_KEY
tools:
  - provider: standard
    allow: [fs_list, fs_read]
  - module: ./tools/my-tool.ts
limits:
  max_model_calls: 30
  max_tool_calls: 100
  max_output_tokens: 16000
`;

const minimal = `version: 1
company:
  name: Minimal Inc.
principal:
  id: bob
  name: Bob
profession:
  id: generic
  instructions: Do the work.
model:
  provider: openai-compatible
  model: gpt-5
  api_key_env: OPENAI_API_KEY
  base_url: http://localhost:11434/v1
`;

function configError(text: string, options?: Parameters<typeof parseConfig>[1]): OpenshainError {
  try {
    parseConfig(text, options);
  } catch (err) {
    expect(err).toBeInstanceOf(OpenshainError);
    return err as OpenshainError;
  }
  throw new Error("expected parseConfig to throw");
}

describe("parseConfig", () => {
  test("parses the documented example into camelCase config", () => {
    const config = parseConfig(example);

    expect(config.version).toBe(1);
    expect(config.company).toEqual({ name: "サンプル株式会社" });
    expect(config.principal).toEqual({ id: "alice", name: "Alice" });
    expect(config.profession.instructions).toBe("あなたはこの会社の事務担当です。\n");
    expect(config.model).toEqual({
      provider: "anthropic",
      model: "claude-opus-5",
      apiKeyEnv: "ANTHROPIC_API_KEY",
      baseUrl: undefined,
      options: undefined,
    });
    expect(config.tools).toEqual([
      { provider: "standard", allow: ["fs_list", "fs_read"] },
      { module: "./tools/my-tool.ts", allow: undefined },
    ]);
    expect(config.limits).toEqual({ maxModelCalls: 30, maxToolCalls: 100, maxOutputTokens: 16000 });
    expect(config.debug).toEqual({ persistRaw: false });
  });

  test("fills defaults for tools, limits and debug when they are omitted", () => {
    const config = parseConfig(minimal);

    expect(config.tools).toEqual([{ provider: "standard", allow: undefined }]);
    expect(config.limits).toEqual({ maxModelCalls: 30, maxToolCalls: 100, maxOutputTokens: 16000 });
    expect(config.debug).toEqual({ persistRaw: false });
    expect(config.model.baseUrl).toBe("http://localhost:11434/v1");
  });

  test("reports a missing api_key_env at the model block", () => {
    const text = example.replace("  api_key_env: ANTHROPIC_API_KEY\n", "");

    const err = configError(text);

    expect(err.code).toBe("config");
    expect(err.message).toMatch(/^openshain\.yaml:12:\d+ model\.api_key_env: /m);
  });

  test("rejects an unknown model provider when the known providers are given", () => {
    const text = example.replace("provider: anthropic", "provider: nope");

    const err = configError(text, { modelProviders: ["anthropic", "openai-compatible"] });

    expect(err.message).toMatch(
      /^openshain\.yaml:12:\d+ model\.provider: unknown provider "nope"/m,
    );
    expect(err.message).toContain("anthropic, openai-compatible");
  });

  test("accepts any provider name when the known providers are not given", () => {
    const text = example.replace("provider: anthropic", "provider: my-gateway");

    expect(parseConfig(text).model.provider).toBe("my-gateway");
  });

  test("reports a non-string entry in allow at its own line", () => {
    const text = example.replace("allow: [fs_list, fs_read]", "allow: [fs_list, 42]");

    const err = configError(text);

    expect(err.message).toMatch(/^openshain\.yaml:17:\d+ tools\.0\.allow\.1: /m);
  });

  test("reports every problem at once", () => {
    const text = example
      .replace("  api_key_env: ANTHROPIC_API_KEY\n", "")
      .replace("max_tool_calls: 100", "max_tool_calls: -1");

    const err = configError(text);

    expect(err.message).toContain("model.api_key_env");
    expect(err.message).toContain("limits.max_tool_calls");
  });

  test("reports YAML syntax errors with a position", () => {
    const err = configError("version: 1\nmodel: [\n");

    expect(err.code).toBe("config");
    expect(err.message).toMatch(/^openshain\.yaml:\d+:\d+ /m);
  });

  test("rejects unknown top-level keys", () => {
    const err = configError(`${example}extra: 1\n`);

    expect(err.message).toContain("extra");
  });

  test("rejects a tools entry that names neither a provider nor a module", () => {
    const text = example.replace("  - module: ./tools/my-tool.ts\n", "  - allow: [fs_read]\n");

    const err = configError(text);

    expect(err.message).toMatch(/^openshain\.yaml:18:\d+ tools\.1/m);
  });

  test("uses the given file name in messages", () => {
    const err = configError("version: 2\n", { fileName: "/srv/acme/openshain.yaml" });

    expect(err.message).toMatch(/^\/srv\/acme\/openshain\.yaml:1:/m);
  });
});

describe("loadConfig", () => {
  test("reads openshain.yaml from the workspace root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshain-config-"));
    await writeFile(join(dir, "openshain.yaml"), example);

    const config = await loadConfig(dir);

    expect(config.company.name).toBe("サンプル株式会社");
  });

  test("fails with a config error when the file is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openshain-config-"));

    const promise = loadConfig(dir);

    await expect(promise).rejects.toBeInstanceOf(OpenshainError);
    await promise.catch((err: OpenshainError) => {
      expect(err.code).toBe("config");
      expect(err.message).toContain("openshain.yaml");
    });
  });
});

describe("parseConfig hardening", () => {
  test("reports an alias bomb as a config error with the file name", () => {
    const bomb = `a: &a ["x","x","x","x","x","x","x","x","x"]
b: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a]
c: &c [*b,*b,*b,*b,*b,*b,*b,*b,*b]
d: &d [*c,*c,*c,*c,*c,*c,*c,*c,*c]
e: &e [*d,*d,*d,*d,*d,*d,*d,*d,*d]
version: 1
company: { name: *e }
`;

    const err = configError(bomb);

    expect(err.code).toBe("config");
    expect(err.message).toContain("openshain.yaml");
  });

  test("rejects a base_url that carries credentials", () => {
    const text = example.replace(
      "  api_key_env: ANTHROPIC_API_KEY\n",
      "  api_key_env: ANTHROPIC_API_KEY\n  base_url: https://svc:hunter2@gateway.internal/v1\n",
    );

    const err = configError(text);

    expect(err.message).toMatch(/model\.base_url: .*credentials/);
  });

  test("rejects instructions beyond the length limit", () => {
    const text = example.replace(
      "  instructions: |\n    あなたはこの会社の事務担当です。\n",
      `  instructions: "${"あ".repeat(100_001)}"\n`,
    );

    const err = configError(text);

    expect(err.message).toContain("profession.instructions");
  });
});
