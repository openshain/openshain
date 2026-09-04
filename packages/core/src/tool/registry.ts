import { OpenshainError } from "../errors.ts";
import {
  RESERVED_TOOL_NAMES,
  TOOL_NAME_PATTERN,
  type ToolDefinition,
  type ToolEffect,
  type ToolProvider,
} from "./types.ts";
import { compileInputValidator, type InputValidation } from "./validate.ts";

export interface RegisteredTool {
  definition: ToolDefinition;
  providerId: string;
  provider: ToolProvider;
  validate: (input: unknown) => InputValidation;
}

/** A tool a provider offers that an allow list left out. Not callable; shown so the person knows it exists. */
export interface HiddenTool {
  name: string;
  providerId: string;
  effect: ToolEffect;
}

export interface RegisterOptions {
  /** Only these tools of the provider are registered. Every name must exist. */
  allow?: readonly string[];
}

/** Every tool the runtime can offer, across providers. Names are unique. */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly hidden: HiddenTool[] = [];

  async register(provider: ToolProvider, options: RegisterOptions = {}): Promise<void> {
    const definitions = await provider.listTools();
    const provided = new Set(definitions.map((d) => d.name));
    for (const name of options.allow ?? []) {
      if (!provided.has(name)) {
        throw new OpenshainError(
          "config",
          `provider "${provider.id}" has no tool named "${name}"; it provides: ${[...provided].join(", ")}`,
        );
      }
    }
    const selected = options.allow
      ? definitions.filter((d) => options.allow?.includes(d.name))
      : definitions;

    // Check everything before registering anything, so a bad provider changes nothing.
    const prepared = new Map<string, RegisteredTool>();
    for (const definition of selected) {
      const { name } = definition;
      if (!TOOL_NAME_PATTERN.test(name)) {
        throw new OpenshainError(
          "invalid_tool",
          `tool name "${name}" from provider "${provider.id}" must match ${TOOL_NAME_PATTERN}`,
        );
      }
      if (RESERVED_TOOL_NAMES.includes(name)) {
        throw new OpenshainError(
          "invalid_tool",
          `tool name "${name}" from provider "${provider.id}" is reserved for the runtime`,
        );
      }
      const existing = this.tools.get(name) ?? prepared.get(name);
      if (existing) {
        throw new OpenshainError(
          "duplicate_tool",
          `tool "${name}" is provided by both "${existing.providerId}" and "${provider.id}"`,
        );
      }
      let validate: RegisteredTool["validate"];
      try {
        validate = compileInputValidator(definition.inputSchema);
      } catch (cause) {
        throw new OpenshainError(
          "invalid_tool",
          `tool "${name}" from provider "${provider.id}": ${(cause as Error).message}`,
          { cause },
        );
      }
      prepared.set(name, { definition, providerId: provider.id, provider, validate });
    }
    for (const [name, tool] of prepared) this.tools.set(name, tool);
    for (const definition of definitions) {
      if (!prepared.has(definition.name)) {
        this.hidden.push({
          name: definition.name,
          providerId: provider.id,
          effect: definition.effect,
        });
      }
    }
  }

  /** True for a tool the provider offers but an allow list left out. */
  isHidden(name: string): boolean {
    return !this.tools.has(name) && this.hidden.some((h) => h.name === name);
  }

  /** Tools that providers offer but allow lists left out. */
  hiddenTools(): HiddenTool[] {
    return this.hidden.filter((h) => !this.tools.has(h.name)).map((h) => ({ ...h }));
  }

  list(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }
}
