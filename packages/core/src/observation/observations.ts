import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { OpenshainError } from "../errors.ts";
import { uuidv7 } from "../uuid.ts";
import { describeIssues } from "../work/events.ts";

/**
 * A fact openshain noticed, inside the company or outside it. Not a work: a work may come of it,
 * through an obligation the company wrote beforehand. An observation is never rewritten, because
 * what happened does not change; noticing that one was wrong means writing another.
 */

export const OBSERVATIONS_DIR_NAME = "observations";

const identifier = /^[a-z][a-z0-9_.-]*$/;

export const ObservationSchema = z.strictObject({
  id: z.string().min(1).max(100),
  /** What happened, in the company's own words. An obligation names the same word. */
  type: z.string().regex(identifier).max(100),
  /** Where it was learned from: a mailbox, a folder, a person. */
  source: z.string().min(1).max(200),
  /** When it happened, and when openshain learned of it. Late news still reads in order. */
  observedAt: z.string().min(1).max(40),
  recordedAt: z.string().min(1).max(40),
  scope: z.strictObject({ profession: z.string().regex(identifier).max(100) }),
  /** Where the thing itself is. The observation records that it happened, not what it holds. */
  payloadRef: z.string().max(1000).optional(),
});

export type Observation = z.infer<typeof ObservationSchema>;

export interface NewObservation {
  type: string;
  source: string;
  scope: { profession: string };
  /** When it happened, if that is known to be earlier than now. */
  observedAt?: string;
  payloadRef?: string;
}

/** Writes one observation. The file is named after it, and a name that exists is never written over. */
export async function recordObservation(root: string, input: NewObservation): Promise<Observation> {
  const now = new Date().toISOString();
  // Whatever noticed this is a script somebody wrote, so what it hands over is said plainly when
  // it does not fit, the way a wrong line in a configuration file is.
  const checked = ObservationSchema.safeParse({
    id: `obs_${uuidv7()}`,
    type: input.type,
    source: input.source,
    observedAt: input.observedAt ?? now,
    recordedAt: now,
    scope: input.scope,
    ...(input.payloadRef !== undefined && { payloadRef: input.payloadRef }),
  });
  if (!checked.success) {
    throw new OpenshainError(
      "config",
      `this is not an observation openshain can record: ${describeIssues(checked.error)}`,
    );
  }
  const observation = checked.data;
  const dir = join(root, OBSERVATIONS_DIR_NAME);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${observation.id}.json`),
    `${JSON.stringify(observation, null, 2)}\n`,
    {
      flag: "wx",
    },
  );
  return observation;
}
