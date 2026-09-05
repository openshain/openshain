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
  /** How many model and tool calls the work may still make. Providers may ignore it. */
  budget?: { modelCallsLeft: number; toolCallsLeft: number };
  /** How many leading messages will be sent unchanged next turn. A provider may anchor a prompt cache after them. */
  stableMessages?: number;
}

export interface ModelResponse {
  message: { role: "assistant"; content: AssistantPart[] };
  stopReason: StopReason;
  usage: ModelUsage;
  /** The provider's native response, for debugging only. Not persisted by default. */
  raw?: unknown;
}

export interface ModelDescription {
  /** For display and error messages. The id the log records is ModelProvider.id. */
  provider: string;
  model: string;
  capabilities: { tools: boolean };
}

export interface ModelProvider {
  /** Recorded in the log and used to route opaque parts back. Stable across the provider's models. */
  readonly id: string;
  describe(): ModelDescription;
  generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}
