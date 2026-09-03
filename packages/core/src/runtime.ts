import { loadConfig } from "./config/load.ts";
import type { Config } from "./config/schema.ts";
import { isOpenshainError, OpenshainError } from "./errors.ts";
import type { ModelProvider } from "./model/types.ts";
import { loadToolModule } from "./tool/load-module.ts";
import { ToolRegistry } from "./tool/registry.ts";
import type { ToolCall, ToolDefinition, ToolProvider, ToolResult } from "./tool/types.ts";
import type { ToolContent } from "./work/events.ts";
import { TOOL_REJECTION_CODES, type ToolRejectionCode } from "./work/events.ts";
import { type WorkHandle, WorkStore } from "./work/store.ts";

export interface RuntimeProviders {
  /** Model providers by the id used in openshain.yaml. */
  models: Record<string, (model: Config["model"]) => ModelProvider>;
  /** Tool providers by the id used in openshain.yaml. Modules are loaded from the config directly. */
  tools: Record<string, () => ToolProvider>;
}

export interface CreateRuntimeOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
}

/** What the outside world learns about a registered tool. Calls go through runtime.tools.call. */
export interface ToolSummary {
  definition: ToolDefinition;
  providerId: string;
}

/** Longer tool output is cut here so that one tool cannot flood the model's context. */
export const MAX_TOOL_TEXT_CHARS = 50_000;

export interface Runtime {
  readonly workspaceRoot: string;
  readonly config: Config;
  readonly model: ModelProvider;
  readonly works: WorkStore;
  readonly tools: {
    list(): ToolSummary[];
    /** Validates, runs and records one tool call for the given work. Never throws for a tool's own failure. */
    call(work: WorkHandle, call: ToolCall): Promise<ToolResult>;
  };
}

/** Builds a runtime for one workspace from its config and the providers the caller knows. */
export async function createRuntime(options: CreateRuntimeOptions): Promise<Runtime> {
  const { workspaceRoot, providers } = options;
  const config = await loadConfig(workspaceRoot, { modelProviders: Object.keys(providers.models) });

  const modelFactory = providers.models[config.model.provider];
  if (!modelFactory) {
    throw new OpenshainError("config", `unknown model provider "${config.model.provider}"`);
  }
  const model = modelFactory(config.model);
  const description = model.describe();
  if (!description.capabilities.tools) {
    throw new OpenshainError(
      "config",
      `model ${description.provider}/${description.model} cannot call tools; openshain needs a model with tool support`,
    );
  }

  const registry = new ToolRegistry();
  for (const entry of config.tools) {
    const registerOptions = entry.allow ? { allow: entry.allow } : {};
    if ("provider" in entry) {
      const factory = providers.tools[entry.provider];
      if (!factory) {
        throw new OpenshainError(
          "config",
          `unknown tool provider "${entry.provider}"; known providers: ${Object.keys(providers.tools).join(", ")}`,
        );
      }
      await registry.register(factory(), registerOptions);
    } else {
      await registry.register(await loadToolModule(workspaceRoot, entry.module), registerOptions);
    }
  }

  const works = new WorkStore(workspaceRoot);
  return {
    workspaceRoot,
    config,
    model,
    works,
    tools: {
      list: () => registry.list().map(({ definition, providerId }) => ({ definition, providerId })),
      call: (work, call) => callTool({ registry, config, workspaceRoot, work, call }),
    },
  };
}

async function callTool(input: {
  registry: ToolRegistry;
  config: Config;
  workspaceRoot: string;
  work: WorkHandle;
  call: ToolCall;
}): Promise<ToolResult> {
  const { registry, config, workspaceRoot, work, call } = input;
  const reject = async (code: ToolRejectionCode, reason: string): Promise<ToolResult> => {
    await work.append({
      type: "tool.rejected",
      payload: { callId: call.id, name: call.name, code, reason },
    });
    return { content: [{ type: "text", text: reason }], isError: true };
  };

  const tool = registry.get(call.name);
  if (!tool) {
    return registry.isHidden(call.name)
      ? reject("not_allowed", `tool "${call.name}" is not allowed in this workspace`)
      : reject("unknown_tool", `unknown tool "${call.name}"`);
  }
  const validation = tool.validate(call.input);
  if (!validation.ok) {
    return reject(
      "schema_mismatch",
      `input does not match the schema of ${call.name}: ${validation.reason}`,
    );
  }

  await work.append({
    type: "tool.called",
    payload: { callId: call.id, provider: tool.providerId, name: call.name, input: call.input },
  });
  const started = performance.now();
  let result: ToolResult;
  try {
    result = await tool.provider.call(call, {
      workId: work.id,
      principalId: config.principal.id,
      workspaceRoot,
    });
  } catch (err) {
    if (isOpenshainError(err) && isRejectionCode(err.code)) return reject(err.code, err.message);
    const message = err instanceof Error ? err.message : String(err);
    result = { content: [{ type: "text", text: message }], isError: true };
  }
  const durationMs = Math.max(0, Math.round(performance.now() - started));
  result = { ...result, content: result.content.map(capContent) };

  await work.append({
    type: "tool.completed",
    payload: {
      callId: call.id,
      content: result.content,
      isError: result.isError ?? false,
      ...(result.observation && { observation: result.observation }),
      ...(result.after && { after: result.after }),
    },
  });
  await work.append({
    type: "usage.recorded",
    payload: { kind: "tool_execution", provider: tool.providerId, usage: { durationMs } },
  });
  return result;
}

function isRejectionCode(code: string): code is ToolRejectionCode {
  return (TOOL_REJECTION_CODES as readonly string[]).includes(code);
}

/** Cuts a content part down to MAX_TOOL_TEXT_CHARS and says so at the end. */
function capContent(part: ToolContent): ToolContent {
  const text = part.type === "text" ? part.text : JSON.stringify(part.value);
  if (text.length <= MAX_TOOL_TEXT_CHARS) return part;
  const cut = text.length - MAX_TOOL_TEXT_CHARS;
  return {
    type: "text",
    text: `${text.slice(0, MAX_TOOL_TEXT_CHARS)}\n…[${cut} characters cut by the runtime]`,
  };
}
