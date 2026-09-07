// @openshain/agent: Tool loop and model providers (bring your own key)

export { type ClientResult, connectInMemory, jsonOf, type RuntimeClient, wrap } from "./client.ts";
export {
  ASK_USER,
  countToolCalls,
  type FailureReason,
  type PendingQuestion,
  pendingQuestions,
  RUNTIME_PROVIDER_ID,
  type RunWorkOptions,
  runWork,
} from "./loop.ts";
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
