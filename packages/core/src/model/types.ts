import type { ToolDefinition } from "../tool/types.ts";
import type { AssistantPart, ModelUsage, StopReason } from "../work/events.ts";

export type UserPart =
  | { type: "text"; text: string }
  | { type: "tool_result"; callId: string; content: string; isError?: boolean };

export type ModelMessage =
  | { role: "user"; content: UserPart[] }
  | { role: "assistant"; content: AssistantPart[] };

export interface ModelRequest {
  system?: string;
  messages: ModelMessage[];
  tools?: ToolDefinition[];
  maxOutputTokens?: number;
  /** Passed to the provider as is. The contract does not interpret it. */
  providerOptions?: Record<string, unknown>;
}

export interface ModelResponse {
  message: { role: "assistant"; content: AssistantPart[] };
  stopReason: StopReason;
  usage: ModelUsage;
  /** The provider's native response, for debugging only. Not persisted by default. */
  raw?: unknown;
}

export interface ModelDescription {
  provider: string;
  model: string;
  capabilities: { tools: boolean };
}

export interface ModelProvider {
  readonly id: string;
  describe(): ModelDescription;
  generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
