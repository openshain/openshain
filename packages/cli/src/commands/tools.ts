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
  const rows: [string, string, string, string][] = registry
    .list()
    .map((t) => [t.definition.name, t.providerId, t.definition.effect, "許可"]);
  rows.push([ASK_USER.name, RUNTIME_PROVIDER_ID, ASK_USER.effect, "許可"]);
  for (const hidden of registry.hiddenTools()) {
    rows.push([hidden.name, hidden.providerId, hidden.effect, "不許可"]);
  }
  const width = Math.max(...rows.map(([name]) => name.length));
  const providerWidth = Math.max(...rows.map(([, provider]) => provider.length));
  for (const [name, provider, effect, allowed] of rows) {
    write(
      `${name.padEnd(width)}  ${provider.padEnd(providerWidth)}  ${effect.padEnd(7)}  ${allowed}`,
    );
  }
}
