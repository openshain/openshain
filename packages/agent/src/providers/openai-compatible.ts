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
import OpenAI, { type ClientOptions } from "openai";
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

export const OPENAI_COMPATIBLE_PROVIDER_ID = "openai-compatible";

/** Used when the request names no output limit. The config's limit normally does. */
const DEFAULT_MAX_TOKENS = 16_000;

type ModelSection = Parameters<RuntimeProviders["models"][string]>[0];

export interface OpenAICompatibleProviderOptions {
  model: string;
  apiKey: string;
  /** The API root including its version segment, for example http://localhost:11434/v1. */
  baseUrl?: string;
  /** False for an endpoint that cannot call tools. The runtime then refuses to start. */
  tools?: boolean;
  /** Replaces the global fetch. Tests answer through it with recorded responses. */
  fetch?: NonNullable<ClientOptions["fetch"]>;
}

/**
 * Builds the provider from the model section of openshain.yaml. The key comes from the environment
 * variable the config names; `options: { tools: false }` declares an endpoint without tool support.
 */
export function openaiCompatibleProvider(
  model: ModelSection,
  env: Record<string, string | undefined> = process.env,
): OpenAICompatibleProvider {
  const apiKey = env[model.apiKeyEnv];
  if (!apiKey) {
    throw new OpenshainError(
      "config",
      `environment variable ${model.apiKeyEnv} is not set; it should hold the API key`,
    );
  }
  return new OpenAICompatibleProvider({
    model: model.model,
    apiKey,
    ...(model.baseUrl && { baseUrl: model.baseUrl }),
    ...(model.options?.tools === false && { tools: false }),
  });
}

/** Any chat completions endpoint with function calling: OpenAI, a local server, or another vendor's compatible API. */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly id = OPENAI_COMPATIBLE_PROVIDER_ID;
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly tools: boolean;

  constructor(options: OpenAICompatibleProviderOptions) {
    this.model = options.model;
    this.tools = options.tools ?? true;
    this.client = new OpenAI({
      apiKey: options.apiKey.trim(),
      ...(options.baseUrl && { baseURL: options.baseUrl }),
      ...(options.fetch && { fetch: options.fetch }),
    });
  }

  describe(): ModelDescription {
    return {
      provider: OPENAI_COMPATIBLE_PROVIDER_ID,
      model: this.model,
      capabilities: { tools: this.tools },
    };
  }

  async generate(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    const params = toParams(request, this.model);
    try {
      const completion = await this.client.chat.completions.create(params, {
        ...(signal && { signal }),
      });
      return fromCompletion(completion);
    } catch (err) {
      throw toError(err);
    }
  }
}

/**
 * The request as chat completions take it. providerOptions land on the body as they are
 * (reasoning_effort, temperature, and so on); the model, the limit, the messages, the tools and
 * the choice not to stream come from the runtime. The limit is sent as max_completion_tokens; a
 * max_tokens in the options only asks for that older name, which some servers still expect,
 * and its value is ignored. A `tools` flag in the options is the provider's, not the request's.
 */
export function toParams(
  request: ModelRequest,
  model: string,
): ChatCompletionCreateParamsNonStreaming {
  const {
    tools: _flag,
    model: _model,
    messages: _messages,
    stream: _stream,
    max_completion_tokens: _limit,
    max_tokens: legacy,
    ...extra
  } = request.providerOptions ?? {};
  const limit = request.maxOutputTokens ?? DEFAULT_MAX_TOKENS;
  const messages: ChatCompletionMessageParam[] = [];
  if (request.system) messages.push({ role: "system", content: request.system });
  for (const message of request.messages) messages.push(...toMessages(message));
  return {
    ...extra,
    model,
    stream: false,
    ...(legacy !== undefined ? { max_tokens: limit } : { max_completion_tokens: limit }),
    messages,
    ...(request.tools && request.tools.length > 0 && { tools: request.tools.map(toTool) }),
  } as ChatCompletionCreateParamsNonStreaming;
}

function toTool(tool: ToolDefinition): ChatCompletionTool {
  return {
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  };
}

/** One contract message becomes one or more chat messages: every tool result is a message of its own. */
function toMessages(message: ModelMessage): ChatCompletionMessageParam[] {
  if (message.role === "user") {
    const out: ChatCompletionMessageParam[] = [];
    const texts: string[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        if (part.text !== "") texts.push(part.text);
      } else {
        out.push({ role: "tool", tool_call_id: part.callId, content: part.content });
      }
    }
    if (texts.length > 0) out.push({ role: "user", content: texts.join("\n") });
    return out;
  }
  const texts: string[] = [];
  const toolCalls: NonNullable<
    Extract<ChatCompletionMessageParam, { role: "assistant" }>["tool_calls"]
  > = [];
  let opaque: Record<string, unknown> = {};
  for (const part of message.content) {
    if (part.type === "text") {
      if (part.text !== "") texts.push(part.text);
    } else if (part.type === "tool_call") {
      toolCalls.push({
        id: part.id,
        type: "function",
        function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) },
      });
    } else if (part.provider === OPENAI_COMPATIBLE_PROVIDER_ID) {
      opaque = { ...opaque, ...(part.data as Record<string, unknown>) };
    }
  }
  const { unsupported_tool_calls: _unsupported, ...sent } = opaque;
  if (texts.length === 0 && toolCalls.length === 0 && Object.keys(sent).length === 0) {
    throw new OpenshainError(
      "invalid_response",
      "an assistant message has nothing this provider can send; it may belong to another provider",
    );
  }
  return [
    {
      ...sent,
      role: "assistant",
      content: texts.length > 0 ? texts.join("\n") : null,
      ...(toolCalls.length > 0 && { tool_calls: toolCalls }),
    },
  ];
}

/**
 * The completion in the contract's terms. Fields of the assistant message beyond content and
 * tool calls, such as a server's reasoning, are kept opaque and go back with the message. Tool
 * calls that are not function calls are kept opaque too, but never sent back. A refusal's text
 * becomes text, so the log says why. A response whose shape is not a completion is an invalid
 * response.
 */
export function fromCompletion(completion: ChatCompletion): ModelResponse {
  const choice = completion?.choices?.[0];
  if (!choice?.message) {
    throw new OpenshainError("invalid_response", "the completion has no message");
  }
  const { role: _role, content: rawContent, tool_calls, refusal, ...rest } = choice.message;
  const content: AssistantPart[] = [];
  const text = joinContent(rawContent);
  if (text) content.push({ type: "text", text });
  if (refusal) content.push({ type: "text", text: refusal });
  const calls = (tool_calls ?? []).filter((call) => call.type === "function");
  for (const call of calls) {
    content.push({
      type: "tool_call",
      id: call.id,
      name: call.function.name,
      input: parseArguments(call.function.arguments),
    });
  }
  const unsupported = (tool_calls ?? []).filter((call) => call.type !== "function");
  const opaque: Record<string, unknown> = Object.fromEntries(
    Object.entries(rest).filter(([key, value]) => key !== "annotations" && value != null),
  );
  if (unsupported.length > 0) opaque.unsupported_tool_calls = unsupported;
  if (Object.keys(opaque).length > 0) {
    content.push({ type: "opaque", provider: OPENAI_COMPATIBLE_PROVIDER_ID, data: opaque });
  }
  return {
    message: { role: "assistant", content },
    stopReason: toStopReason(choice.finish_reason, calls.length > 0),
    usage: toUsage(completion.usage),
    raw: completion,
  };
}

/** Content is a string, but some servers return text parts; those are joined. */
function joinContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" ? (part as { text?: unknown }).text : undefined,
    )
    .filter((text): text is string => typeof text === "string")
    .join("");
}

/** Tool arguments arrive as a JSON string. One that does not parse is passed on as it is, so the schema check reports it. */
function parseArguments(args: string): unknown {
  if (args.trim() === "") return {};
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

const STOP_REASONS: Record<string, StopReason> = {
  stop: "end_turn",
  tool_calls: "tool_call",
  length: "max_tokens",
  content_filter: "refusal",
};

/** Some servers say `stop` even when they made tool calls; the function calls decide either way. */
function toStopReason(reason: string | null, hasToolCalls: boolean): StopReason {
  if (hasToolCalls && reason !== "length") return "tool_call";
  if (reason === "tool_calls" && !hasToolCalls) return "other";
  return (reason && STOP_REASONS[reason]) || "other";
}

function toUsage(usage: ChatCompletion["usage"]): ModelUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens;
  const reasoning = usage?.completion_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    ...(cached != null && { cachedInputTokens: cached }),
    ...(reasoning != null && { reasoningTokens: reasoning }),
  };
}

/** The SDK's typed errors as the codes the runtime records. Anything else means the response could not be read. */
function toError(err: unknown): OpenshainError {
  if (err instanceof OpenshainError) return err;
  if (err instanceof OpenAI.APIUserAbortError) return wrap("network", err);
  if (err instanceof OpenAI.AuthenticationError) return wrap("auth", err);
  if (err instanceof OpenAI.PermissionDeniedError) return wrap("auth", err);
  if (err instanceof OpenAI.RateLimitError) return wrap("rate_limit", err);
  if (err instanceof OpenAI.BadRequestError) return wrap("config", err);
  if (err instanceof OpenAI.NotFoundError) return wrap("config", err);
  if (err instanceof OpenAI.APIConnectionError) return wrap("network", err);
  if (err instanceof OpenAI.InternalServerError) return wrap("network", err);
  if (err instanceof OpenAI.APIError) return wrap("invalid_response", err);
  return wrap("invalid_response", err instanceof Error ? err : new Error(String(err)));
}

function wrap(code: ErrorCode, err: Error): OpenshainError {
  return new OpenshainError(code, `chat completions: ${err.message}`, { cause: err });
}
