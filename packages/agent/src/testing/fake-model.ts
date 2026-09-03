import type { AssistantPart, ModelProvider, ModelRequest, ModelResponse } from "@openshain/core";

export type FakeStep = ModelResponse | ((request: ModelRequest) => ModelResponse);

/**
 * A model that answers from a script, one response per call, and remembers
 * every request it saw. For tests and for trying tools without a real model.
 */
export class FakeModelProvider implements ModelProvider {
  readonly id = "fake";
  readonly requests: ModelRequest[] = [];
  private readonly steps: FakeStep[];

  constructor(steps: FakeStep[]) {
    this.steps = [...steps];
  }

  describe() {
    return { provider: "fake", model: "fake-1", capabilities: { tools: true } };
  }

  async generate(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const step = this.steps.shift();
    if (!step) throw new Error("the fake model ran out of scripted responses");
    return typeof step === "function" ? step(request) : step;
  }
}

/** A response that ends the turn with text. */
export function say(text: string): ModelResponse {
  return {
    message: { role: "assistant", content: [{ type: "text", text }] },
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

/** A response that asks for one or more tool calls. */
export function callTools(...calls: { id: string; name: string; input: unknown }[]): ModelResponse {
  const content: AssistantPart[] = calls.map((c) => ({ type: "tool_call", ...c }));
  return {
    message: { role: "assistant", content },
    stopReason: "tool_call",
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}
