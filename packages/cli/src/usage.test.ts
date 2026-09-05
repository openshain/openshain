import { describe, expect, test } from "bun:test";
import { formatUsage } from "./usage.ts";

describe("formatUsage", () => {
  test("prints the token totals when the runtime called the model", () => {
    const line = formatUsage({
      modelCalls: 2,
      toolCalls: 3,
      inputTokens: 70,
      cachedInputTokens: 25,
      outputTokens: 9,
    });

    expect(line).toBe(
      "model 呼び出し 2 回、Tool 呼び出し 3 回、入力 70 トークン(うちキャッシュ 25)、出力 9 トークン",
    );
  });

  test("says that no model usage was recorded when an outside agent drove the work", () => {
    const line = formatUsage({
      modelCalls: 0,
      toolCalls: 5,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
    });

    expect(line).toBe("model 呼び出し 0 回、Tool 呼び出し 5 回。model の使用量の記録はない");
  });
});
