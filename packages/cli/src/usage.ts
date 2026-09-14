import type { UsageSummary } from "@openshain/core";

export function formatUsage(summary: UsageSummary): string {
  if (summary.modelCalls === 0 && summary.inputTokens === 0 && summary.outputTokens === 0) {
    return `model 呼び出し 0 回、Tool 呼び出し ${summary.toolCalls} 回。model の使用量の記録はない`;
  }
  const cached =
    summary.cachedInputTokens > 0 ? `(うちキャッシュ ${summary.cachedInputTokens})` : "";
  return `model 呼び出し ${summary.modelCalls} 回、Tool 呼び出し ${summary.toolCalls} 回、入力 ${summary.inputTokens} トークン${cached}、出力 ${summary.outputTokens} トークン`;
}
