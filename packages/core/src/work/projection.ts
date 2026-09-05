import type { Config } from "../config/schema.ts";
import { OpenshainError } from "../errors.ts";
import type { ModelMessage, UserPart } from "../model/types.ts";
import type { ToolDefinition } from "../tool/types.ts";
import type { AssistantPart } from "./events.ts";
import { type AnyEvent, canonical, type Event, type ToolContent } from "./events.ts";

export interface ProjectionInput {
  events: readonly AnyEvent[];
  config: Pick<Config, "company" | "principal" | "profession">;
  /** Tool definitions the model may call. Already filtered by the allow lists. */
  tools: ToolDefinition[];
  /** Opaque parts are returned only to the provider that produced them. */
  providerId: string;
  budget: { modelCallsLeft: number; toolCallsLeft: number };
}

export interface Projection {
  system: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  budget: { modelCallsLeft: number; toolCallsLeft: number };
}

/**
 * What the model sees. Built from the event log alone, in order, and therefore
 * the same bytes every time for the same events. Nothing is rewritten: the
 * budget line is a user message of its own at the end.
 */
export function buildProjection(input: ProjectionInput): Projection {
  const { config } = input;
  const system = [
    config.profession.instructions.trim(),
    `この会社は ${config.company.name}。`,
    `あなたが代理する人は ${config.principal.name}(${config.principal.id})。`,
    "各ターンの最後に Runtime が「残り model 呼び出し N 回、Tool 呼び出し M 回」という 1 行を user message として足す。これは残量の通知で、返事は要らない。依頼が終わったら、何をしたかを要約して終える。",
  ].join("\n\n");

  const messages: ModelMessage[] = [];
  const pushUserPart = (part: UserPart) => {
    const last = messages.at(-1);
    if (last?.role === "user") last.content.push(part);
    else messages.push({ role: "user", content: [part] });
  };

  for (const event of input.events) {
    switch (event.type) {
      case "work.created":
        pushUserPart({ type: "text", text: (event as Event<"work.created">).payload.objective });
        break;
      case "human.message":
        pushUserPart({ type: "text", text: (event as Event<"human.message">).payload.text });
        break;
      case "model.completed": {
        const content = (event as Event<"model.completed">).payload.content
          .filter((part) => part.type !== "opaque" || part.provider === input.providerId)
          .map((part) => canonical(part) as AssistantPart);
        if (content.length > 0) messages.push({ role: "assistant", content });
        break;
      }
      case "tool.completed": {
        const { payload } = event as Event<"tool.completed">;
        pushUserPart({
          type: "tool_result",
          callId: payload.callId,
          content: renderContent(payload.content),
          isError: payload.isError,
        });
        break;
      }
      case "tool.rejected": {
        const { payload } = event as Event<"tool.rejected">;
        pushUserPart({
          type: "tool_result",
          callId: payload.callId,
          content: payload.reason,
          isError: true,
        });
        break;
      }
      default:
        break;
    }
  }

  checkToolPairs(messages);

  // The budget is a message of its own, so the messages before it keep their bytes from turn to
  // turn and a provider's prompt cache can cover them.
  messages.push({
    role: "user",
    content: [
      {
        type: "text",
        text: `残り model 呼び出し ${input.budget.modelCallsLeft} 回、Tool 呼び出し ${input.budget.toolCallsLeft} 回`,
      },
    ],
  });

  return { system, messages, tools: input.tools, budget: { ...input.budget } };
}

/**
 * Every tool_result must answer a tool_call in the assistant message right
 * before it, and every tool_call must be answered before the conversation goes
 * on. Providers reject anything else, so the log is treated as corrupt.
 */
function checkToolPairs(messages: ModelMessage[]): void {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (!message) continue;
    if (message.role === "assistant") {
      const calls = message.content.filter((p) => p.type === "tool_call").map((p) => p.id);
      if (calls.length === 0) continue;
      const next = messages[i + 1];
      const answered = new Set(
        next?.role === "user"
          ? next.content.filter((p) => p.type === "tool_result").map((p) => p.callId)
          : [],
      );
      const missing = calls.filter((id) => !answered.has(id));
      if (missing.length > 0) {
        throw new OpenshainError(
          "corrupt_log",
          `tool calls without a result before the conversation continues: ${missing.join(", ")}`,
        );
      }
    } else {
      const results = message.content.filter((p) => p.type === "tool_result").map((p) => p.callId);
      if (results.length === 0) continue;
      const previous = messages[i - 1];
      const known = new Set(
        previous?.role === "assistant"
          ? previous.content.filter((p) => p.type === "tool_call").map((p) => p.id)
          : [],
      );
      const orphans = results.filter((id) => !known.has(id));
      if (orphans.length > 0) {
        throw new OpenshainError(
          "corrupt_log",
          `tool results that answer no call in the preceding assistant message: ${orphans.join(", ")}`,
        );
      }
    }
  }
}

function renderContent(content: ToolContent[]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : JSON.stringify(part.value)))
    .join("\n");
}
