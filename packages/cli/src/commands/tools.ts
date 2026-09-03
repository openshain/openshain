import { ASK_USER, RUNTIME_PROVIDER_ID } from "@openshain/agent";
import { createRuntime, type RuntimeProviders } from "@openshain/core";

export interface ToolsListOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
  write: (line: string) => void;
}

/** Every tool the model can call in this workspace, and the ones the allow lists hide. */
export async function toolsList({
  workspaceRoot,
  providers,
  write,
}: ToolsListOptions): Promise<void> {
  const runtime = await createRuntime({ workspaceRoot, providers });
  const rows: [string, string, string][] = runtime.tools
    .list()
    .map((t) => [t.definition.name, t.providerId, t.definition.effect]);
  rows.push([ASK_USER.name, RUNTIME_PROVIDER_ID, ASK_USER.effect]);
  for (const hidden of runtime.tools.hidden()) {
    rows.push([hidden.name, hidden.providerId, "許可されていない"]);
  }
  const width = Math.max(...rows.map(([name]) => name.length));
  const providerWidth = Math.max(...rows.map(([, provider]) => provider.length));
  for (const [name, provider, effect] of rows) {
    write(`${name.padEnd(width)}  ${provider.padEnd(providerWidth)}  ${effect}`);
  }
}
