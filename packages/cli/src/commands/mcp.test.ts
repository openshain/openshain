import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { connectInMemory, createSession } from "@openshain/agent";
import { callTools, FakeModelProvider, say } from "@openshain/agent/testing";
import { loadConfig, type RuntimeProviders, WorkStore } from "@openshain/core";
import { createMcpServer } from "@openshain/mcp";
import { standardTools } from "@openshain/tools";
import { toolsList } from "./tools.ts";

const bin = join(import.meta.dir, "..", "bin.ts");
const echoExample = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "..",
  "examples",
  "tools",
  "echo",
  "tool.ts",
);

/** A workspace whose config loads the echo example as a tool module. */
async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "openshain-echo-"));
  await mkdir(join(root, "tools", "echo"), { recursive: true });
  await copyFile(echoExample, join(root, "tools", "echo", "tool.ts"));
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
  - module: ./tools/echo/tool.ts
`,
  );
  return root;
}

function io() {
  const lines: string[] = [];
  return { lines, write: (line: string) => void lines.push(line), text: () => lines.join("\n") };
}

describe("a tool provider from a module in the workspace", () => {
  test("appears in tools list", async () => {
    const root = await workspace();
    const providers: RuntimeProviders = { models: {}, tools: { standard: () => standardTools() } };
    const out = io();

    await toolsList({ workspaceRoot: root, providers, write: out.write });

    expect(out.text()).toMatch(/echo\s+echo\s+observe\s+許可/);
  });

  test("is called by the model from the interactive session", async () => {
    const root = await workspace();
    const model = new FakeModelProvider([
      callTools({ id: "c0", name: "work_create", input: { objective: "echo を試して" } }),
      callTools({ id: "c1", name: "echo", input: { text: "こんにちは" } }),
      callTools({ id: "c2", name: "work_complete", input: { summary: "echo は動きました" } }),
      say("echo は動きました"),
    ]);
    const providers: RuntimeProviders = {
      models: { fake: () => model },
      tools: { standard: () => standardTools() },
    };
    const config = await loadConfig(root, { modelProviders: ["fake"] });
    const server = await createMcpServer({ workspaceRoot: root, tools: providers.tools });
    const session = await createSession(await connectInMemory(server), { model, config });

    const result = await session.turn("echo を試して");

    expect(result.reply).toBe("echo は動きました");
    const echoed = model.requests[2]?.messages.at(-2)?.content[0];
    expect(echoed).toMatchObject({ type: "tool_result", callId: "c1", content: "こんにちは" });
  });

  test("is offered and callable over MCP through openshain mcp on stdio", async () => {
    const root = await workspace();
    const transport = new StdioClientTransport({
      command: "bun",
      args: [bin, "mcp", "--workspace", root],
      stderr: "pipe",
    });
    const client = new Client({ name: "test", version: "0" });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain("echo");
      expect(names).toContain("work_create");

      const created = await client.callTool({
        name: "work_create",
        arguments: { objective: "echo を試して" },
      });
      const id = JSON.parse((created.content as { text: string }[])[0]?.text ?? "{}").id as string;
      const echoed = await client.callTool({ name: "echo", arguments: { text: "こんにちは" } });
      expect(echoed.isError).toBeFalsy();
      expect((echoed.content as { text: string }[])[0]?.text).toBe("こんにちは");
      const done = await client.callTool({
        name: "work_complete",
        arguments: { summary: "echo は動きました" },
      });
      expect(JSON.parse((done.content as { text: string }[])[0]?.text ?? "{}").status).toBe(
        "completed",
      );

      const events = await new WorkStore(root).events(id as never);
      expect(events.map((e) => e.type)).toContain("tool.called");
      expect(events.at(-1)?.type).toBe("work.completed");
    } finally {
      await client.close();
    }
  }, 30_000);
});
