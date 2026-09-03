import type { Config } from "../config/schema.ts";
import type { ModelMessage, UserPart } from "../model/types.ts";
import type { ToolDefinition } from "../tool/types.ts";
import type { AnyEvent, Event, ToolContent } from "./events.ts";

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
}

/**
 * What the model sees. Built from the event log alone, in order, and therefore
 * the same bytes every time for the same events. Nothing is rewritten: the
 * budget line is appended to the last user message only.
 */
export function buildProjection(input: ProjectionInput): Projection {
  const { config } = input;
  const system = [
    config.profession.instructions.trim(),
    `会社: ${config.company.name}`,
    `代理する人: ${config.principal.name} (${config.principal.id})`,
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
      case "model.completed": {
        const content = (event as Event<"model.completed">).payload.content.filter(
          (part) => part.type !== "opaque" || part.provider === input.providerId,
        );
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

  pushUserPart({
    type: "text",
    text: `残り: model 呼び出し ${input.budget.modelCallsLeft} 回、Tool 呼び出し ${input.budget.toolCallsLeft} 回`,
  });

  return { system, messages, tools: input.tools };
}

function renderContent(content: ToolContent[]): string {
  return content
    .map((part) => (part.type === "text" ? part.text : JSON.stringify(part.value)))
    .join("\n");
}
