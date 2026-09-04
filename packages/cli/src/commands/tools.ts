import { ASK_USER, RUNTIME_PROVIDER_ID } from "@openshain/agent";
import { createToolRegistry, loadConfig, type RuntimeProviders } from "@openshain/core";

export interface ToolsListOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
  write: (line: string) => void;
}

/** Every tool the model can call in this workspace, and the ones the allow lists hide. Needs no model provider. */
export async function toolsList({
  workspaceRoot,
  providers,
  write,
}: ToolsListOptions): Promise<void> {
  const config = await loadConfig(workspaceRoot);
  const registry = await createToolRegistry(workspaceRoot, config, providers.tools);
  const rows: [string, string, string][] = registry
    .list()
    .map((t) => [t.definition.name, t.providerId, t.definition.effect]);
  rows.push([ASK_USER.name, RUNTIME_PROVIDER_ID, ASK_USER.effect]);
  for (const hidden of registry.hiddenTools()) {
    rows.push([hidden.name, hidden.providerId, "許可されていない"]);
  }
  const width = Math.max(...rows.map(([name]) => name.length));
  const providerWidth = Math.max(...rows.map(([, provider]) => provider.length));
  for (const [name, provider, effect] of rows) {
    write(`${name.padEnd(width)}  ${provider.padEnd(providerWidth)}  ${effect}`);
  }
}
