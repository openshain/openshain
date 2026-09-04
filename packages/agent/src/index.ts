// @openshain/agent: Tool loop and model providers (bring your own key)

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
