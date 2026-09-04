import type { WorkId } from "../ids.ts";
import type { Artifact, ToolContent } from "../work/events.ts";

/** A JSON Schema (draft 2020-12) object. Validated by ajv at registration. */
export type JsonSchema = Record<string, unknown>;

export type ToolEffect = "observe" | "mutate";

export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** The tool the runtime itself provides. No provider may define it. */
export const ASK_USER_TOOL_NAME = "ask_user";
export const RESERVED_TOOL_NAMES: readonly string[] = [ASK_USER_TOOL_NAME];

export interface ToolDefinition {
  /** Unique across all providers. Matches TOOL_NAME_PATTERN. */
  name: string;
  description: string;
  inputSchema: JsonSchema;
  effect: ToolEffect;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolContext {
  workId: WorkId;
  principalId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
}

export interface ToolResult {
  content: ToolContent[];
  isError?: boolean;
  /** Where the observation came from and when it was retrieved. */
  observation?: { source: string; retrievedAt: string };
  /** For mutate tools: the files as they are after the call. */
  after?: Artifact[];
}

export interface ToolProvider {
  readonly id: string;
  listTools(): Promise<ToolDefinition[]>;
  call(call: ToolCall, ctx: ToolContext): Promise<ToolResult>;
}
