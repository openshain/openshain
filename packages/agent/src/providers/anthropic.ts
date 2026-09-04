import Anthropic, { type ClientOptions } from "@anthropic-ai/sdk";
import {
  type AssistantPart,
  type ErrorCode,
  type ModelDescription,
  type ModelMessage,
  type ModelProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  OpenshainError,
  type RuntimeProviders,
  type StopReason,
  type ToolDefinition,
} from "@openshain/core";

export const ANTHROPIC_PROVIDER_ID = "anthropic";

/** Used when the request names no output limit. The config's limit normally does. */
const DEFAULT_MAX_TOKENS = 16_000;

type ModelSection = Parameters<RuntimeProviders["models"][string]>[0];

export interface AnthropicProviderOptions {
  model: string;
  apiKey: string;
  baseUrl?: string;
  /** Replaces the global fetch. Tests answer through it with recorded responses. */
  fetch?: NonNullable<ClientOptions["fetch"]>;
}

/** Builds the provider from the model section of openshain.yaml. The key comes from the environment variable the config names. */
export function anthropicProvider(
  model: ModelSection,
  env: Record<string, string | undefined> = process.env,
): AnthropicProvider {
  const apiKey = env[model.apiKeyEnv];
  if (!apiKey) {
    throw new OpenshainError(
      "config",
      `environment variable ${model.apiKeyEnv} is not set; it should hold the Anthropic API key`,
    );
  }
  return new AnthropicProvider({
    model: model.model,
    apiKey,
    ...(model.baseUrl && { baseUrl: model.baseUrl }),
  });
}

/** Claude through the Messages API. Thinking blocks travel as opaque parts and go back unchanged. */
export class AnthropicProvider implements ModelProvider {
  readonly id = ANTHROPIC_PROVIDER_ID;
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(options: AnthropicProviderOptions) {
    this.model = options.model;
    this.client = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseUrl && { baseURL: options.baseUrl }),
      ...(options.fetch && { fetch: options.fetch }),
    });
  }

  describe(): ModelDescription {
    return { provider: ANTHROPIC_PROVIDER_ID, model: this.model, capabilities: { tools: true } };
  }

  async generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    let message: Anthropic.Message;
    try {
      message = await this.client.messages.create(toParams(request, this.model), {
        ...(signal && { signal }),
      });
    } catch (err) {
      throw toError(err);
    }
    return fromMessage(message);
  }
}

/**
 * The request as the Messages API takes it. providerOptions land on the body as they are, so
 * thinking, output_config and cache_control can be set or overridden from the config; `effort`
 * alone is a shorthand for output_config.effort. The last cacheable block is cached by default.
 */
export function toParams(
  request: ModelRequest,
  model: string,
): Anthropic.MessageCreateParamsNonStreaming {
  const { effort, output_config, ...extra } = request.providerOptions ?? {};
  const outputConfig = {
    ...(output_config as Record<string, unknown> | undefined),
    ...(typeof effort === "string" && { effort }),
  };
  return {
    model,
    max_tokens: request.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
    cache_control: { type: "ephemeral" },
    ...(request.system && { system: request.system }),
    ...(request.tools && request.tools.length > 0 && { tools: request.tools.map(toTool) }),
    messages: request.messages.map(toMessage),
    ...(Object.keys(outputConfig).length > 0 && { output_config: outputConfig }),
    ...extra,
  } as Anthropic.MessageCreateParamsNonStreaming;
}

function toTool(tool: ToolDefinition): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
}

function toMessage(message: ModelMessage): Anthropic.MessageParam {
  const content: Anthropic.ContentBlockParam[] = [];
  if (message.role === "user") {
    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text !== "") content.push({ type: "text", text: part.text });
      } else {
        content.push({
          type: "tool_result",
          tool_use_id: part.callId,
          content: part.content,
          ...(part.isError && { is_error: true }),
        });
      }
    }
    return { role: "user", content };
  }
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text !== "") content.push({ type: "text", text: part.text });
    } else if (part.type === "tool_call") {
      content.push({ type: "tool_use", id: part.id, name: part.name, input: part.input });
    } else if (part.provider === ANTHROPIC_PROVIDER_ID) {
      content.push(part.data as Anthropic.ContentBlockParam);
    }
  }
  return { role: "assistant", content };
}

/** The response in the contract's terms. Every block that is not text or a tool call is kept opaque. */
export function fromMessage(message: Anthropic.Message): ModelResponse {
  const content: AssistantPart[] = [];
  for (const block of message.content) {
    if (block.type === "text") content.push({ type: "text", text: block.text });
    else if (block.type === "tool_use") {
      content.push({ type: "tool_call", id: block.id, name: block.name, input: block.input });
    } else content.push({ type: "opaque", provider: ANTHROPIC_PROVIDER_ID, data: block });
  }
  return {
    message: { role: "assistant", content },
    stopReason: toStopReason(message.stop_reason),
    usage: toUsage(message.usage),
    raw: message,
  };
}

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: "end_turn",
  stop_sequence: "end_turn",
  tool_use: "tool_call",
  max_tokens: "max_tokens",
  refusal: "refusal",
};

function toStopReason(reason: string | null): StopReason {
  return (reason && STOP_REASONS[reason]) || "other";
}

function toUsage(usage: Anthropic.Usage): ModelUsage {
  const thinking = usage.output_tokens_details?.thinking_tokens;
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    ...(usage.cache_read_input_tokens != null && {
      cachedInputTokens: usage.cache_read_input_tokens,
    }),
    ...(usage.cache_creation_input_tokens != null && {
      cacheWriteTokens: usage.cache_creation_input_tokens,
    }),
    ...(thinking != null && { reasoningTokens: thinking }),
  };
}

/** The SDK's typed errors as the codes the runtime records. Anything else passes through. */
function toError(err: unknown): unknown {
  if (err instanceof Anthropic.AuthenticationError) return wrap("auth", err);
  if (err instanceof Anthropic.PermissionDeniedError) return wrap("auth", err);
  if (err instanceof Anthropic.RateLimitError) return wrap("rate_limit", err);
  if (err instanceof Anthropic.BadRequestError) return wrap("config", err);
  if (err instanceof Anthropic.NotFoundError) return wrap("config", err);
  if (err instanceof Anthropic.APIConnectionError) return wrap("network", err);
  if (err instanceof Anthropic.InternalServerError) return wrap("network", err);
  if (err instanceof Anthropic.APIError) return wrap("invalid_response", err);
  return err;
}

function wrap(code: ErrorCode, err: Error): OpenshainError {
  return new OpenshainError(code, `Anthropic: ${err.message}`, { cause: err });
}
