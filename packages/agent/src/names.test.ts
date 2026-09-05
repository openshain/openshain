import { describe, expect, test } from "bun:test";
import { AGENT_NAMES, pickAgentName } from "./names.ts";

describe("agent names", () => {
  test("picks from the list, skipping the names open sessions use", () => {
    const first = AGENT_NAMES[0] as string;
    const second = AGENT_NAMES[1] as string;

    expect(pickAgentName([], () => 0)).toBe(first);
    expect(pickAgentName([first], () => 0)).toBe(second);
    expect(pickAgentName(AGENT_NAMES, () => 0)).toBe(first);
    expect(pickAgentName([], () => 0.999)).toBe(AGENT_NAMES[AGENT_NAMES.length - 1] as string);
  });

  test("the names are distinct and cannot be changed", () => {
    expect(new Set(AGENT_NAMES).size).toBe(AGENT_NAMES.length);
    expect(Object.isFrozen(AGENT_NAMES)).toBe(true);
  });
});
