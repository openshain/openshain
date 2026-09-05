import { countToolCalls } from "@openshain/agent";
import type { AnyEvent, Event } from "@openshain/core";

export interface UsageSummary {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  /** The part of inputTokens a prompt cache served. */
  cachedInputTokens: number;
  outputTokens: number;
}

/** Totals over a work's events: calls and tokens. */
export function summarizeUsage(events: AnyEvent[]): UsageSummary {
  const summary: UsageSummary = {
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  for (const event of events) {
    if (event.type === "model.requested") summary.modelCalls += 1;
    if (event.type === "usage.recorded") {
      const { payload } = event as Event<"usage.recorded">;
      if (payload.kind === "model_inference") {
        summary.inputTokens += payload.usage.inputTokens;
        summary.cachedInputTokens += payload.usage.cachedInputTokens ?? 0;
        summary.outputTokens += payload.usage.outputTokens;
      }
    }
  }
  summary.toolCalls = countToolCalls(events);
  return summary;
}

export function formatUsage(summary: UsageSummary): string {
  if (summary.modelCalls === 0 && summary.inputTokens === 0 && summary.outputTokens === 0) {
    return `model 呼び出し 0 回、Tool 呼び出し ${summary.toolCalls} 回。model の使用量の記録はない`;
  }
  const cached =
    summary.cachedInputTokens > 0 ? `(うちキャッシュ ${summary.cachedInputTokens})` : "";
  return `model 呼び出し ${summary.modelCalls} 回、Tool 呼び出し ${summary.toolCalls} 回、入力 ${summary.inputTokens} トークン${cached}、出力 ${summary.outputTokens} トークン`;
}
