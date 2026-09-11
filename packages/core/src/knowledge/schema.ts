import { z } from "zod";
import { PRINCIPAL_ID } from "../authority/principals.ts";

/**
 * What a person writes under `knowledge/`: the company's own rules, and the sources behind them.
 * The shapes only; what makes a set of them consistent is in `check.ts`.
 */

/** An id a person writes: lowercase, and readable as a path of meaning (`expenses.receipt-required`). */
const knowledgeId = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "use lowercase letters, digits, . - or _, starting with a letter or a digit",
  );

/**
 * A date as the company writes it. The runtime compares these as strings, so the form is fixed,
 * and it must be a day that exists: the index closes a superseded rule the day before the next
 * one starts, and `2026-13-45` would end that arithmetic in an error rather than a refusal.
 */
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "write a date as YYYY-MM-DD")
  .refine(isDay, "that day does not exist");

function isDay(text: string): boolean {
  const at = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(at.getTime()) && at.toISOString().startsWith(text);
}

/** A person or a role, written as they are written under `principals/`. */
const personId = z.string().regex(PRINCIPAL_ID, "use lowercase letters, digits, - or _");

/**
 * Who may read it. A company with one principal may leave it out; with two or more it is written,
 * because from then on leaving it out would mean deciding by accident.
 */
export const ScopeSchema = z.union([
  z.strictObject({ visibility: z.literal("company") }),
  z.strictObject({ principals: z.array(personId).min(1) }),
  z.strictObject({ roles: z.array(personId).min(1) }),
]);
export type Scope = z.infer<typeof ScopeSchema>;

/**
 * The professional domain a piece of knowledge belongs to. `none` is the only value core knows;
 * the rest is a string a profession pack or the company defines. Core compares it and holds no
 * list of qualifications (docs/design/core.md, spec/professional-boundary.md).
 */
const expertise = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9-]*$/, "use lowercase letters, digits and -");

export const RuleSchema = z.strictObject({
  id: knowledgeId,
  statement: z.string().min(10).max(240),
  aliases: z.array(z.string().min(1).max(80)).max(20).optional(),
  applies_to: z.strictObject({ profession: z.array(knowledgeId).min(1) }).optional(),
  scope: ScopeSchema.optional(),
  effective_from: day,
  // Written even when there is no end, so that an open-ended rule is a decision, not an omission.
  effective_to: day.nullable(),
  supersedes: knowledgeId.optional(),
  expertise,
  source: z.strictObject({ id: knowledgeId, section: z.string().min(1).max(200).optional() }),
});
export type Rule = z.infer<typeof RuleSchema>;

export const RulesFileSchema = z.strictObject({
  version: z.literal(1),
  rules: z.array(RuleSchema).min(1),
});

/** The front matter of a source document. The body below it is the citation itself. */
export const SourceFrontMatterSchema = z
  .strictObject({
    id: knowledgeId,
    title: z.string().min(1).max(200),
    publisher: z.string().min(1).max(200),
    url: z.url().optional(),
    path: z.string().min(1).max(1000).optional(),
    retrieved_at: day,
    version: z.string().min(1).max(80).optional(),
    effective_from: day,
    effective_to: day.nullable(),
    scope: ScopeSchema.optional(),
    expertise,
  })
  .refine(
    (source) => source.url !== undefined || source.path !== undefined,
    "say where it came from: url or path",
  );
export type SourceFrontMatter = z.infer<typeof SourceFrontMatterSchema>;

/** A source as it was read: its front matter, the body, and the file it came from. */
export interface Source extends SourceFrontMatter {
  body: string;
  file: string;
}

/** A rule as it was read, with the file it came from for the messages. */
export interface LoadedRule extends Rule {
  file: string;
}
