import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RuntimeProviders } from "@openshain/core";
import { createMcpServer } from "@openshain/mcp";

export interface McpOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
}

/**
 * Serves the workspace over MCP on stdin and stdout until the client hangs up. Nothing else may
 * be written to stdout while it runs; the protocol owns it.
 */
export async function mcp({ workspaceRoot, providers }: McpOptions): Promise<void> {
  const server = await createMcpServer({ workspaceRoot, tools: providers.tools });
  const transport = new StdioServerTransport();
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    server.connect(transport).catch(() => resolve());
  });
}
