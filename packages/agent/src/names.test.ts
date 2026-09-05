import { describe, expect, test } from "bun:test";
import { AGENT_NAMES, pickAgentName } from "./names.ts";

describe("agent names", () => {
  test("picks from the company's language, skipping the names open sessions use", () => {
    const [first, second] = AGENT_NAMES.ja as [string, string];

    expect(pickAgentName("ja", [], () => 0)).toBe(first);
    expect(pickAgentName("ja", [first], () => 0)).toBe(second);
    expect(pickAgentName("ja", AGENT_NAMES.ja, () => 0)).toBe(first);
    expect(pickAgentName("ja", [], () => 0.999)).toBe(
      AGENT_NAMES.ja[AGENT_NAMES.ja.length - 1] as string,
    );
    expect(pickAgentName("en", [], () => 0)).toBe(AGENT_NAMES.en[0] as string);
  });

  test("thirty distinct names per language, kana for Japanese and letters for English, frozen", () => {
    for (const language of ["ja", "en"] as const) {
      const names = AGENT_NAMES[language];
      expect(names).toHaveLength(30);
      expect(new Set(names).size).toBe(30);
      expect(Object.isFrozen(names)).toBe(true);
    }
    for (const name of AGENT_NAMES.ja) expect(name).toMatch(/^[ぁ-ん]+$/);
    for (const name of AGENT_NAMES.en) expect(name).toMatch(/^[A-Z][a-z]+$/);
  });
});
