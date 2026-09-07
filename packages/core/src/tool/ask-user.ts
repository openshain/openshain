import { ASK_USER_TOOL_NAME, type ToolDefinition } from "./types.ts";

/** The provider id the runtime records for the tools it runs itself. */
export const RUNTIME_PROVIDER_ID = "runtime";

/** The one tool the runtime itself provides: stop and ask the person. */
export const ASK_USER: Readonly<ToolDefinition> = Object.freeze({
  name: ASK_USER_TOOL_NAME,
  description:
    "Ask the person you work for a question when you cannot proceed without their answer. Use it sparingly; prefer the workspace over guessing. The work waits until the answer is recorded with work_answer.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, in the person's language." },
    },
    required: ["question"],
    additionalProperties: false,
  },
  effect: "observe",
});
