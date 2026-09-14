import { loadConfig, observe } from "@openshain/core";

export interface ObserveOptions {
  workspaceRoot: string;
  /** What happened, in the company's own word. An obligation names the same one. */
  type: string;
  source: string;
  /** When it happened, if that is earlier than now. */
  at?: string | undefined;
  /** Where the thing itself is, inside the company folder. */
  ref?: string | undefined;
  as?: string | undefined;
  write: (line: string) => void;
}

/**
 * Writes down something that happened, and starts whatever the company said should follow. The
 * source of the fact is whatever ran this: a script watching a mailbox, a folder, or a person
 * typing it. openshain records that it happened, and the obligations decide what that means.
 */
export async function observeCommand(options: ObserveOptions): Promise<number> {
  const { workspaceRoot, type, source, at, ref, as, write } = options;
  const config = await loadConfig(workspaceRoot, { ...(as !== undefined && { as }) });
  const { observation, works } = await observe(workspaceRoot, config.principal.id, {
    type,
    source,
    scope: { profession: config.profession.id },
    ...(at !== undefined && { observedAt: at }),
    ...(ref !== undefined && { payloadRef: ref }),
  });
  write(`${observation.id} ${observation.type}(${observation.source})`);
  if (works.length === 0) {
    write("  この観測に当たる義務はありません。記録だけ残しました");
    return 0;
  }
  for (const id of works) write(`  Work を作りました ${id}`);
  return 0;
}
