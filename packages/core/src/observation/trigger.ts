import type { WorkId } from "../ids.ts";
import { WorkStore } from "../work/store.ts";
import { pulledBy, readObligations } from "./obligations.ts";
import { type NewObservation, type Observation, recordObservation } from "./observations.ts";

/**
 * Noticing something, and starting whatever the company said should follow. The fact is written
 * first and always: a workspace with no obligations still keeps a record of what happened, and
 * one whose obligations are wrong loses nothing. Work comes second, and only from what a person
 * wrote beforehand.
 */
export interface Observed {
  observation: Observation;
  /** The works the obligations asked for. Empty when nothing matched. */
  works: WorkId[];
}

export async function observe(
  root: string,
  principal: string,
  input: NewObservation,
): Promise<Observed> {
  const observation = await recordObservation(root, input);
  const obligations = pulledBy(await readObligations(root), observation);
  const store = new WorkStore(root);
  const works: WorkId[] = [];
  for (const obligation of obligations) {
    const work = await store.create({
      objective: obligation.create_work.objective,
      principal,
      profession: obligation.profession,
      type: obligation.create_work.type,
      observation: observation.id,
      obligation: obligation.id,
    });
    works.push(work.id);
  }
  return { observation, works };
}
