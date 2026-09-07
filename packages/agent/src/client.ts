import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { JsonSchema, ToolContent, ToolDefinition } from "@openshain/core";
import pkg from "../package.json" with { type: "json" };

/** What a tool call returned, as the client sees it: MCP content, and the same as text. */
export interface ClientResult {
  content: ToolContent[];
  isError: boolean;
  text: string;
}

/**
 * The runtime as a client sees it: the tools it offers and a way to call them. The interactive
 * CLI's loop talks to the runtime through this and nothing else, the way Claude Code does over MCP.
 */
export interface RuntimeClient {
  listTools(): Promise<ToolDefinition[]>;
  call(name: string, input: unknown, signal?: AbortSignal): Promise<ClientResult>;
  close(): Promise<void>;
}

/** Connects an MCP client to a server in the same process, over the SDK's in-memory transport. */
export async function connectInMemory(server: Server): Promise<RuntimeClient> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "openshain", version: pkg.version });
  await client.connect(clientTransport);
  return wrap(client);
}

/** Adapts any connected MCP client to the runtime client the loop uses. */
export function wrap(client: Client): RuntimeClient {
  return {
    async listTools() {
      const { tools } = await client.listTools();
      return tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema as JsonSchema,
        effect: tool.annotations?.readOnlyHint === true ? "observe" : "mutate",
      }));
    },
    async call(name, input, signal) {
      const result = await client.callTool(
        { name, arguments: (input ?? {}) as Record<string, unknown> },
        undefined,
        signal ? { signal } : undefined,
      );
      const parts = (result.content ?? []) as { type: string; text?: string }[];
      const content: ToolContent[] = parts.map((part) => ({
        type: "text",
        text: part.type === "text" ? (part.text ?? "") : JSON.stringify(part),
      }));
      return {
        content,
        isError: result.isError === true,
        text: content.map((c) => (c.type === "text" ? c.text : "")).join(""),
      };
    },
    close: () => client.close(),
  };
}

/** Parses a JSON result. Returns undefined when the text is not JSON. */
export function jsonOf(result: ClientResult): unknown {
  try {
    return JSON.parse(result.text);
  } catch {
    return undefined;
  }
}
