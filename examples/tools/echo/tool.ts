import type { ToolProvider } from "@openshain/core";

/**
 * The smallest tool provider: one tool that returns what it was given. Point openshain.yaml at
 * this file with `- module: ./tools/echo/tool.ts` and the tool appears in `openshain tools list`,
 * is callable by the model in `openshain run`, and is offered over MCP, all without any change
 * to the runtime.
 */
const echo: ToolProvider = {
  id: "echo",
  async listTools() {
    return [
      {
        name: "echo",
        description:
          "Returns the text it is given, unchanged. Useful to check that a tool provider is wired.",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string", description: "The text to return." } },
          required: ["text"],
          additionalProperties: false,
        },
        effect: "observe",
      },
    ];
  },
  async call(call) {
    const { text } = call.input as { text: string };
    return { content: [{ type: "text", text }] };
  },
};

export default echo;
