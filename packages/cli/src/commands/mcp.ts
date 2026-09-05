import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RuntimeProviders } from "@openshain/core";
import { createMcpServer } from "@openshain/mcp";

export interface McpOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
  /** Receives the line that says the server is up. Defaults to stderr; stdout belongs to the protocol. */
  log?: (line: string) => void;
}

/**
 * Serves the workspace over MCP on stdin and stdout until the client hangs up. Nothing else may
 * be written to stdout while it runs; the protocol owns it, so the one line that reports the
 * start goes to stderr.
 */
export async function mcp({ workspaceRoot, providers, log }: McpOptions): Promise<void> {
  const report = log ?? ((line: string) => console.error(line));
  const server = await createMcpServer({ workspaceRoot, tools: providers.tools });
  const transport = new StdioServerTransport();
  await new Promise<void>((resolve) => {
    server.onclose = () => resolve();
    server.connect(transport).then(
      () =>
        report(
          `MCP server を起動しました。workspace: ${workspaceRoot}。接続が閉じるまで待ちます。`,
        ),
      (err: unknown) => {
        report(err instanceof Error ? err.message : String(err));
        resolve();
      },
    );
  });
}
