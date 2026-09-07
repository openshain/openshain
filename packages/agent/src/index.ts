// @openshain/agent: The conversation loop that drives the runtime as an MCP client, and the model providers (bring your own key)

export { type ClientResult, connectInMemory, jsonOf, type RuntimeClient, wrap } from "./client.ts";
export { AGENT_NAMES, pickAgentName } from "./names.ts";
export {
  ANTHROPIC_PROVIDER_ID,
  AnthropicProvider,
  type AnthropicProviderOptions,
  anthropicProvider,
} from "./providers/anthropic.ts";
export {
  OPENAI_COMPATIBLE_PROVIDER_ID,
  OpenAICompatibleProvider,
  type OpenAICompatibleProviderOptions,
  openaiCompatibleProvider,
} from "./providers/openai-compatible.ts";
export {
  createSession,
  type Session,
  type SessionOptions,
  TURN_LIMITS,
  type TurnResult,
  type TurnStop,
} from "./session.ts";
