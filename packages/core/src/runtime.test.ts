import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenshainError } from "./errors.ts";
import type { ModelProvider } from "./model/types.ts";
import { createRuntime, type RuntimeProviders } from "./runtime.ts";
import type { ToolDefinition, ToolProvider } from "./tool/types.ts";
import type { AnyEvent } from "./work/events.ts";

function payloadOf<T>(event: AnyEvent | undefined): T {
  if (!event) throw new Error("expected an event");
  return event.payload as T;
}

const config = `version: 1
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
  - provider: fake
    allow: [echo, write_note]
`;

function fakeModel(supportsTools = true): ModelProvider {
  return {
    id: "fake",
    describe: () => ({ provider: "fake", model: "fake-1", capabilities: { tools: supportsTools } }),
    generate: async () => ({
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      stopReason: "end_turn",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  };
}

const echo: ToolDefinition = {
  name: "echo",
  description: "returns its input",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  effect: "observe",
};
const writeNote: ToolDefinition = { ...echo, name: "write_note", effect: "mutate" };
const hidden: ToolDefinition = { ...echo, name: "hidden_tool" };

function fakeTools(): ToolProvider {
  return {
    id: "fake",
    listTools: async () => [echo, writeNote, hidden],
    call: async (call, ctx) => {
      const input = call.input as { text: string };
      if (input.text === "throw") throw new Error("tool blew up");
      if (input.text === "huge") return { content: [{ type: "text", text: "x".repeat(60_000) }] };
      if (input.text === "escape") {
        throw new OpenshainError("outside_workspace", 'path escapes the workspace: "../x"');
      }
      return {
        content: [{ type: "text", text: `${input.text} for ${ctx.principalId}` }],
        ...(call.name === "write_note" && { after: [{ path: "note.md", sha256: "abc" }] }),
      };
    },
  };
}

function providers(model = fakeModel()): RuntimeProviders {
  return { models: { fake: () => model }, tools: { fake: () => fakeTools() } };
}

async function workspace(text = config) {
  const root = await mkdtemp(join(tmpdir(), "openshain-runtime-"));
  await writeFile(join(root, "openshain.yaml"), text);
  return root;
}

describe("createRuntime", () => {
  test("wires the config, the model and the allowed tools", async () => {
    const root = await workspace();

    const runtime = await createRuntime({ workspaceRoot: root, providers: providers() });

    expect(runtime.config.company.name).toBe("サンプル株式会社");
    expect(runtime.model.describe().model).toBe("fake-1");
    expect(runtime.tools.list().map((t) => t.definition.name)).toEqual(["echo", "write_note"]);
    expect(runtime.workspaceRoot).toBe(root);
  });

  test("refuses a model provider the config names but nobody registered", async () => {
    const root = await workspace(
      config.replace("provider: fake\n  model", "provider: nope\n  model"),
    );

    const promise = createRuntime({ workspaceRoot: root, providers: providers() });

    await expect(promise).rejects.toBeInstanceOf(OpenshainError);
    await promise.catch((err: OpenshainError) => {
      expect(err.code).toBe("config");
      expect(err.message).toContain('unknown provider "nope"');
    });
  });

  test("refuses a model that cannot call tools", async () => {
    const root = await workspace();

    const promise = createRuntime({ workspaceRoot: root, providers: providers(fakeModel(false)) });

    await expect(promise).rejects.toBeInstanceOf(OpenshainError);
    await promise.catch((err: OpenshainError) => {
      expect(err.code).toBe("config");
      expect(err.message).toContain("tool");
    });
  });

  test("refuses a tool provider the config names but nobody registered", async () => {
    const root = await workspace(
      config.replace("  - provider: fake\n    allow", "  - provider: other\n    allow"),
    );

    const promise = createRuntime({ workspaceRoot: root, providers: providers() });

    await expect(promise).rejects.toBeInstanceOf(OpenshainError);
    await promise.catch((err: OpenshainError) => expect(err.message).toContain('"other"'));
  });

  test("loads a third-party tool provider from a module path in the config", async () => {
    const root = await workspace(`${config}  - module: ./tools/shout.ts\n`);
    await Bun.write(
      join(root, "tools", "shout.ts"),
      `export default {
  id: "shout",
  listTools: async () => [{ name: "shout", description: "upper case", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] }, effect: "observe" }],
  call: async (call) => ({ content: [{ type: "text", text: String(call.input.text).toUpperCase() }] }),
};
`,
    );

    const runtime = await createRuntime({ workspaceRoot: root, providers: providers() });

    expect(runtime.tools.list().map((t) => [t.providerId, t.definition.name])).toContainEqual([
      "shout",
      "shout",
    ]);
  });

  test("refuses a module that does not export a tool provider", async () => {
    const root = await workspace(`${config}  - module: ./tools/bad.ts\n`);
    await Bun.write(join(root, "tools", "bad.ts"), "export default { id: 'bad' };\n");

    const promise = createRuntime({ workspaceRoot: root, providers: providers() });

    await expect(promise).rejects.toBeInstanceOf(OpenshainError);
    await promise.catch((err: OpenshainError) => {
      expect(err.code).toBe("config");
      expect(err.message).toContain("tools/bad.ts");
    });
  });

  test("refuses a module that fails while loading", async () => {
    const root = await workspace(`${config}  - module: ./tools/boom.ts\n`);
    await Bun.write(join(root, "tools", "boom.ts"), "throw new Error('boom');\n");

    const promise = createRuntime({ workspaceRoot: root, providers: providers() });

    await expect(promise).rejects.toBeInstanceOf(OpenshainError);
    await promise.catch((err: OpenshainError) => {
      expect(err.code).toBe("config");
      expect(err.message).toContain("tools/boom.ts");
    });
  });

  test("refuses a module path outside the workspace", async () => {
    const root = await workspace(`${config}  - module: ../outside.ts\n`);

    await expect(
      createRuntime({ workspaceRoot: root, providers: providers() }),
    ).rejects.toBeInstanceOf(OpenshainError);
  });
});

describe("runtime.tools.call", () => {
  async function started() {
    const root = await workspace();
    const runtime = await createRuntime({ workspaceRoot: root, providers: providers() });
    const work = await runtime.works.create({
      objective: "test",
      principal: "alice",
      profession: "generic",
    });
    const handle = await runtime.works.open(work.id);
    return { runtime, handle };
  }

  test("validates, runs the tool and records the call, the result and the usage", async () => {
    const { runtime, handle } = await started();

    const result = await runtime.tools.call(handle, {
      id: "c1",
      name: "echo",
      input: { text: "hi" },
    });
    await handle.close();

    expect(result.content).toEqual([{ type: "text", text: "hi for alice" }]);
    expect(result.isError).toBeFalsy();
    const events = await runtime.works.events(handle.id);
    expect(events.map((e) => e.type)).toEqual([
      "work.created",
      "tool.called",
      "tool.completed",
      "usage.recorded",
    ]);
    const usage = events[3];
    expect(usage?.payload).toMatchObject({ kind: "tool_execution", provider: "fake" });
    expect(
      payloadOf<{ usage: { durationMs: number } }>(usage).usage.durationMs,
    ).toBeGreaterThanOrEqual(0);
    expect(payloadOf<{ provider: string }>(events[1]).provider).toBe("fake");
  });

  test("keeps the after list of a mutate tool in the result and the event", async () => {
    const { runtime, handle } = await started();

    const result = await runtime.tools.call(handle, {
      id: "c1",
      name: "write_note",
      input: { text: "x" },
    });
    await handle.close();

    expect(result.after).toEqual([{ path: "note.md", sha256: "abc" }]);
    const completed = (await runtime.works.events(handle.id))[2];
    expect(payloadOf<{ after: unknown }>(completed).after).toEqual([
      { path: "note.md", sha256: "abc" },
    ]);
  });

  test("rejects input that does not match the schema before running anything", async () => {
    const { runtime, handle } = await started();

    const result = await runtime.tools.call(handle, { id: "c1", name: "echo", input: { text: 5 } });
    await handle.close();

    expect(result.isError).toBe(true);
    const events = await runtime.works.events(handle.id);
    expect(events.map((e) => e.type)).toEqual(["work.created", "tool.rejected"]);
    expect(events[1]?.payload).toMatchObject({
      callId: "c1",
      name: "echo",
      code: "schema_mismatch",
    });
  });

  test("rejects a tool the allow list hides as not_allowed, and one nobody has as unknown_tool", async () => {
    const { runtime, handle } = await started();

    const hiddenResult = await runtime.tools.call(handle, {
      id: "c1",
      name: "hidden_tool",
      input: { text: "x" },
    });
    const unknownResult = await runtime.tools.call(handle, { id: "c2", name: "nope", input: {} });
    await handle.close();

    expect(hiddenResult.isError).toBe(true);
    expect(unknownResult.isError).toBe(true);
    const rejected = (await runtime.works.events(handle.id)).filter(
      (e) => e.type === "tool.rejected",
    );
    expect(rejected.map((e) => (e.payload as { code: string }).code)).toEqual([
      "not_allowed",
      "unknown_tool",
    ]);
  });

  test("records a path rejection thrown by the tool as tool.rejected", async () => {
    const { runtime, handle } = await started();

    const result = await runtime.tools.call(handle, {
      id: "c1",
      name: "echo",
      input: { text: "escape" },
    });
    await handle.close();

    expect(result.isError).toBe(true);
    const events = await runtime.works.events(handle.id);
    expect(events.map((e) => e.type)).toEqual(["work.created", "tool.called", "tool.rejected"]);
    expect(events[2]?.payload).toMatchObject({ code: "outside_workspace" });
  });

  test("turns any other failure of the tool into an error result the model can see", async () => {
    const { runtime, handle } = await started();

    const result = await runtime.tools.call(handle, {
      id: "c1",
      name: "echo",
      input: { text: "throw" },
    });
    await handle.close();

    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: "text", text: "tool blew up" });
    const events = await runtime.works.events(handle.id);
    expect(events.map((e) => e.type)).toEqual([
      "work.created",
      "tool.called",
      "tool.completed",
      "usage.recorded",
    ]);
    expect(payloadOf<{ isError: boolean }>(events[2]).isError).toBe(true);
  });
});

describe("runtime.tools.call output cap", () => {
  test("cuts a huge tool result and says so, in the result and in the event", async () => {
    const root = await workspace();
    const runtime = await createRuntime({ workspaceRoot: root, providers: providers() });
    const work = await runtime.works.create({
      objective: "t",
      principal: "alice",
      profession: "generic",
    });
    const handle = await runtime.works.open(work.id);

    const result = await runtime.tools.call(handle, {
      id: "c1",
      name: "echo",
      input: { text: "huge" },
    });
    await handle.close();

    const text = (result.content[0] as { text: string }).text;
    expect(text.length).toBeLessThan(60_000);
    expect(text).toContain("characters cut by the runtime");
    const completed = (await runtime.works.events(work.id))[2];
    expect(
      (payloadOf<{ content: { text: string }[] }>(completed).content[0]?.text ?? "").length,
    ).toBe(text.length);
  });
});
