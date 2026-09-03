import { pathToFileURL } from "node:url";
import { OpenshainError } from "../errors.ts";
import { resolveWorkspacePath } from "./paths.ts";
import type { ToolProvider } from "./types.ts";

/**
 * Loads a third-party tool provider from a module inside the workspace.
 * The module's default export must be a ToolProvider.
 */
export async function loadToolModule(
  workspaceRoot: string,
  modulePath: string,
): Promise<ToolProvider> {
  let file: string;
  try {
    file = await resolveWorkspacePath(workspaceRoot, modulePath);
  } catch (cause) {
    throw new OpenshainError(
      "config",
      `tool module "${modulePath}" must be inside the workspace: ${(cause as Error).message}`,
      { cause },
    );
  }
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(file).href);
  } catch (cause) {
    throw new OpenshainError(
      "config",
      `cannot load tool module "${modulePath}": ${(cause as Error).message}`,
      { cause },
    );
  }
  const candidate = (loaded as { default?: unknown }).default;
  if (!isToolProvider(candidate)) {
    throw new OpenshainError(
      "config",
      `tool module "${modulePath}" must default-export a ToolProvider with id, listTools and call`,
    );
  }
  return candidate;
}

function isToolProvider(value: unknown): value is ToolProvider {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.id === "string" && typeof v.listTools === "function" && typeof v.call === "function"
  );
}
