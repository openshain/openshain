import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  type AnyEvent,
  type Artifact,
  type AssistantPart,
  buildProjection,
  type Event,
  isOpenshainError,
  isTerminal,
  type ModelProvider,
  type ModelResponse,
  OpenshainError,
  type Runtime,
  resolveWorkspacePath,
  type Work,
  type WorkHandle,
  type WorkId,
} from "@openshain/core";

export interface RunWorkOptions {
  /** Defaults to the runtime's model. */
  model?: ModelProvider;
  signal?: AbortSignal;
}

/**
 * Drives one work from its current state to completion or failure:
 * build the projection, ask the model, run the tool calls it made, repeat.
 * Every step is recorded in the work's event log before the next one starts.
 */
export async function runWork(
  runtime: Runtime,
  workId: WorkId,
  options: RunWorkOptions = {},
): Promise<Work> {
  const model = options.model ?? runtime.model;
  const handle = await runtime.works.open(workId);
  try {
    const work = await handle.current();
    if (isTerminal(work.status)) {
      throw new OpenshainError("invalid_transition", `work ${workId} is already ${work.status}`);
    }
    if (work.status === "queued") await handle.transition("in_progress", "run");
    return await loop(runtime, handle, model, options);
  } finally {
    await handle.close();
  }
}

async function loop(
  runtime: Runtime,
  handle: WorkHandle,
  model: ModelProvider,
  options: RunWorkOptions,
): Promise<Work> {
  const { limits } = runtime.config;
  const tools = runtime.tools.list().map((t) => t.definition);
  const description = model.describe();

  for (;;) {
    const events = await handle.events();
    const modelCalls = events.filter((e) => e.type === "model.requested").length;
    const toolCalls = countToolCalls(events);
    if (modelCalls >= limits.maxModelCalls) {
      return fail(handle, "limit_reached", `model calls exhausted (${limits.maxModelCalls})`);
    }

    const projection = buildProjection({
      events,
      config: runtime.config,
      tools,
      providerId: model.id,
      budget: {
        modelCallsLeft: limits.maxModelCalls - modelCalls,
        toolCallsLeft: limits.maxToolCalls - toolCalls,
      },
    });
    await handle.append({
      type: "model.requested",
      payload: {
        provider: model.id,
        model: description.model,
        messageCount: projection.messages.length,
        toolNames: tools.map((t) => t.name),
      },
    });

    let response: ModelResponse;
    try {
      response = await model.generate(
        {
          system: projection.system,
          messages: projection.messages,
          tools: projection.tools,
          maxOutputTokens: limits.maxOutputTokens,
          ...(runtime.config.model.options && { providerOptions: runtime.config.model.options }),
        },
        options.signal,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await handle.append({
        type: "model.failed",
        payload: { code: isOpenshainError(err) ? err.code : "model_error", message },
      });
      return fail(handle, "model_error", message);
    }

    await handle.append({
      type: "model.completed",
      payload: {
        stopReason: response.stopReason,
        content: response.message.content,
        ...(runtime.config.debug.persistRaw && response.raw !== undefined && { raw: response.raw }),
      },
    });
    await handle.append({
      type: "usage.recorded",
      payload: {
        kind: "model_inference",
        provider: model.id,
        model: description.model,
        usage: response.usage,
      },
    });

    switch (response.stopReason) {
      case "end_turn":
        return complete(runtime, handle, response.message.content);
      case "tool_call": {
        const calls = response.message.content.filter((p) => p.type === "tool_call");
        if (calls.length === 0) {
          return fail(handle, "model_error", "the model stopped for a tool call but made none");
        }
        let used = toolCalls;
        for (const call of calls) {
          if (used >= limits.maxToolCalls) {
            return fail(handle, "limit_reached", `tool calls exhausted (${limits.maxToolCalls})`);
          }
          await runtime.tools.call(handle, { id: call.id, name: call.name, input: call.input });
          used += 1;
        }
        break;
      }
      case "max_tokens":
        return fail(
          handle,
          "limit_reached",
          `the answer was cut off at max_output_tokens (${limits.maxOutputTokens})`,
        );
      case "refusal":
        return fail(handle, "model_refusal", "the model refused to continue");
      default:
        return fail(handle, "model_error", `unexpected stop reason "${response.stopReason}"`);
    }
  }
}

/** Distinct tool calls the model made, whether they ran or were rejected. */
function countToolCalls(events: AnyEvent[]): number {
  const ids = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.called" || event.type === "tool.rejected") {
      ids.add((event as Event<"tool.called" | "tool.rejected">).payload.callId);
    }
  }
  return ids.size;
}

/** Why a work failed, as recorded in `work.failed`. */
type FailureReason = "limit_reached" | "model_refusal" | "model_error";

async function fail(handle: WorkHandle, reason: FailureReason, detail: string): Promise<Work> {
  await handle.append({ type: "work.failed", payload: { reason, detail } });
  return handle.current();
}

async function complete(
  runtime: Runtime,
  handle: WorkHandle,
  content: AssistantPart[],
): Promise<Work> {
  const summary = content
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n")
    .trim();
  const events = await handle.events();
  const writes = events.filter(
    (e): e is Event<"tool.completed"> =>
      e.type === "tool.completed" && !(e as Event<"tool.completed">).payload.isError,
  );
  const refs: string[] = [];
  const byPath = new Map<string, string>();
  for (const event of writes) {
    if (!event.payload.after) continue;
    refs.push(event.id);
    for (const { path, sha256 } of event.payload.after) byPath.set(path, sha256);
  }
  const artifacts: Artifact[] = [];
  for (const [path, recorded] of byPath) {
    artifacts.push({ path, sha256: await currentHash(runtime.workspaceRoot, path, recorded) });
  }
  await handle.append({ type: "evidence.recorded", payload: { claim: summary, refs, artifacts } });
  await handle.append({ type: "work.completed", payload: { summary } });
  return handle.current();
}

/**
 * The hash of the file as it is now, computed by the runtime rather than taken from the tool.
 * When the file can no longer be read, because a later call moved or deleted it, the hash the
 * tool reported is recorded instead.
 */
async function currentHash(root: string, path: string, recorded: string): Promise<string> {
  try {
    const resolved = await resolveWorkspacePath(root, path);
    return createHash("sha256")
      .update(await readFile(resolved))
      .digest("hex");
  } catch {
    return recorded;
  }
}
