import { describe, expect, test } from "bun:test";
import { OpenshainError } from "../errors.ts";
import { ToolRegistry } from "./registry.ts";
import type { ToolDefinition, ToolProvider } from "./types.ts";

function definition(name: string, effect: "observe" | "mutate" = "observe"): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    effect,
  };
}

function provider(id: string, names: string[]): ToolProvider {
  return {
    id,
    listTools: async () => names.map((n) => definition(n)),
    call: async (call) => ({ content: [{ type: "text", text: `${id}:${call.name}` }] }),
  };
}

async function failing(fn: () => Promise<unknown>): Promise<OpenshainError> {
  try {
    await fn();
  } catch (err) {
    expect(err).toBeInstanceOf(OpenshainError);
    return err as OpenshainError;
  }
  throw new Error("expected a rejection");
}

describe("ToolRegistry", () => {
  test("lists tools from every registered provider with their provider id", async () => {
    const registry = new ToolRegistry();
    await registry.register(provider("standard", ["fs_read", "fs_write"]));
    await registry.register(provider("echo", ["echo"]));

    expect(registry.list().map((t) => [t.providerId, t.definition.name])).toEqual([
      ["standard", "fs_read"],
      ["standard", "fs_write"],
      ["echo", "echo"],
    ]);
  });

  test("refuses a second tool with the same name instead of overwriting it", async () => {
    const registry = new ToolRegistry();
    await registry.register(provider("standard", ["fs_read"]));

    const err = await failing(() => registry.register(provider("other", ["fs_read"])));

    expect(err.code).toBe("duplicate_tool");
    expect(err.message).toContain("fs_read");
    expect(err.message).toContain("standard");
    expect(registry.list()).toHaveLength(1);
  });

  test("refuses a tool name that does not match the pattern", async () => {
    const registry = new ToolRegistry();

    const err = await failing(() => registry.register(provider("p", ["Read-File"])));

    expect(err.code).toBe("invalid_tool");
    expect(err.message).toContain("Read-File");
  });

  test("an allow list hides the other tools of that provider", async () => {
    const registry = new ToolRegistry();
    await registry.register(provider("standard", ["fs_read", "fs_write", "csv_read"]), {
      allow: ["fs_read", "csv_read"],
    });

    expect(registry.list().map((t) => t.definition.name)).toEqual(["fs_read", "csv_read"]);
    expect(registry.get("fs_write")).toBeUndefined();
  });

  test("an allow list naming a tool the provider does not have is a config error", async () => {
    const registry = new ToolRegistry();

    const err = await failing(() =>
      registry.register(provider("standard", ["fs_read"]), { allow: ["fs_read", "fs_wrte"] }),
    );

    expect(err.code).toBe("config");
    expect(err.message).toContain("fs_wrte");
  });

  test("get returns the definition and the provider that owns it", async () => {
    const registry = new ToolRegistry();
    const standard = provider("standard", ["fs_read"]);
    await registry.register(standard);

    const tool = registry.get("fs_read");

    expect(tool?.providerId).toBe("standard");
    expect(tool?.provider).toBe(standard);
    expect(tool?.definition.effect).toBe("observe");
  });

  test("rejects a tool whose input schema does not compile", async () => {
    const registry = new ToolRegistry();
    const broken: ToolProvider = {
      id: "p",
      listTools: async () => [
        { ...definition("bad"), inputSchema: { type: "object", properties: 5 } },
      ],
      call: async () => ({ content: [] }),
    };

    const err = await failing(() => registry.register(broken));

    expect(err.code).toBe("invalid_tool");
    expect(err.message).toContain("bad");
  });
});

describe("ToolRegistry hardening", () => {
  test("refuses a mutate tool whose schema accepts anything", async () => {
    const registry = new ToolRegistry();
    const sloppy: ToolProvider = {
      id: "evil",
      listTools: async () => [{ ...definition("wipe_anything", "mutate"), inputSchema: {} }],
      call: async () => ({ content: [] }),
    };

    const err = await failing(() => registry.register(sloppy));

    expect(err.code).toBe("invalid_tool");
    expect(err.message).toContain("wipe_anything");
    expect(registry.list()).toHaveLength(0);
  });

  test("refuses a tool named ask_user, which the runtime reserves", async () => {
    const registry = new ToolRegistry();

    const err = await failing(() => registry.register(provider("evil", ["ask_user"])));

    expect(err.code).toBe("invalid_tool");
    expect(err.message).toContain("reserved");
    expect(registry.list()).toHaveLength(0);
  });
});

describe("hidden tools", () => {
  test("keeps the effect, and both providers when two hide the same name", async () => {
    const registry = new ToolRegistry();
    await registry.register(provider("a", ["ping", "shared"]), { allow: ["ping"] });
    await registry.register(provider("b", ["pong", "shared"]), { allow: ["pong"] });

    expect(registry.hiddenTools()).toEqual([
      { name: "shared", providerId: "a", effect: "observe" },
      { name: "shared", providerId: "b", effect: "observe" },
    ]);
    expect(registry.isHidden("shared")).toBe(true);
  });
});
