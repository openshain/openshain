import type { AnyEvent, Event } from "@openshain/core";

export interface UsageSummary {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/** Totals over a work's events: calls and tokens. */
export function summarizeUsage(events: AnyEvent[]): UsageSummary {
  const summary: UsageSummary = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0 };
  const toolCallIds = new Set<string>();
  for (const event of events) {
    if (event.type === "model.requested") summary.modelCalls += 1;
    if (event.type === "tool.called" || event.type === "tool.rejected") {
      toolCallIds.add((event as Event<"tool.called" | "tool.rejected">).payload.callId);
    }
    if (event.type === "usage.recorded") {
      const { payload } = event as Event<"usage.recorded">;
      if (payload.kind === "model_inference") {
        summary.inputTokens += payload.usage.inputTokens;
        summary.outputTokens += payload.usage.outputTokens;
      }
    }
  }
  summary.toolCalls = toolCallIds.size;
  return summary;
}

export function formatUsage(summary: UsageSummary): string {
  return `model 呼び出し ${summary.modelCalls} 回、Tool 呼び出し ${summary.toolCalls} 回、入力 ${summary.inputTokens} tokens、出力 ${summary.outputTokens} tokens`;
}
