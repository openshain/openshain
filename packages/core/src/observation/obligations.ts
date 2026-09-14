import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { parseYamlFile } from "../config/yaml.ts";
import type { Observation } from "./observations.ts";

/**
 * What the company should carry out when something happens. Written by a person, the way the
 * rules in authority/ are: an agent that could write these would be deciding what its own work
 * is. This version knows one kind of trigger, the one an observation pulls.
 */

export const OBLIGATIONS_DIR_NAME = "obligations";

const identifier = z
  .string()
  .regex(/^[a-z][a-z0-9_.-]*$/)
  .max(100);

export const ObligationSchema = z.strictObject({
  id: identifier,
  trigger: z.strictObject({
    /** The type of observation that pulls this. The only trigger this version has. */
    event: identifier,
  }),
  profession: identifier,
  create_work: z.strictObject({
    type: identifier,
    objective: z.string().min(1).max(10_000),
  }),
});

export const ObligationsFileSchema = z.strictObject({
  version: z.literal(1),
  obligations: z.array(ObligationSchema).max(200),
});

export type Obligation = z.infer<typeof ObligationSchema>;

/** Everything under obligations/, in the order the files and their entries are written. */
export async function readObligations(root: string): Promise<Obligation[]> {
  const dir = join(root, OBLIGATIONS_DIR_NAME);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const found: Obligation[] = [];
  for (const name of names.filter((n) => n.endsWith(".yaml") || n.endsWith(".yml")).sort()) {
    const where = `${OBLIGATIONS_DIR_NAME}/${name}`;
    const { data } = parseYamlFile(
      await readFile(join(dir, name), "utf8"),
      ObligationsFileSchema,
      where,
    );
    found.push(...data.obligations);
  }
  return found;
}

/**
 * The obligations this observation pulls. A profession that is not the workspace's own does not
 * match: an accounting obligation is not the company's to carry out while it works as something
 * else. Several may match, and each is a work of its own.
 */
export function pulledBy(
  obligations: readonly Obligation[],
  observation: Observation,
): Obligation[] {
  return obligations.filter(
    (each) =>
      each.trigger.event === observation.type && each.profession === observation.scope.profession,
  );
}
