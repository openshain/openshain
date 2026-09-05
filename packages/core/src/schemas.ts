import { z } from "zod";
import { ConfigFileSchema } from "./config/schema.ts";
import type { JsonSchema } from "./tool/types.ts";
import { EventFileSchema, payloadFileSchemas } from "./work/events.ts";
import { WorkFileSchema } from "./work/work.ts";

export type SchemaName = "config.v1" | "events.v1" | "work.v1";

/**
 * The JSON Schemas (draft 2020-12) of the files openshain reads and writes, derived from the zod
 * schemas that validate them. `spec/schemas/` holds this output; `bun run schemas` regenerates it.
 * Conditions zod expresses as refinements, such as "provider or module, not both", have no JSON
 * Schema form and are absent here.
 */
export function jsonSchemas(): Record<SchemaName, JsonSchema> {
  return {
    "config.v1": describe(
      ConfigFileSchema,
      "openshain.yaml",
      "The company workspace manifest as written on disk.",
    ),
    "events.v1": eventsSchema(),
    "work.v1": describe(
      WorkFileSchema,
      "work.json",
      "The state of a work as projected from its event log. Never the source of truth.",
    ),
  };
}

/**
 * One line of events.jsonl: the strict envelope with the payload of its type. A type this
 * version does not know is accepted with any payload, as the runtime accepts it, so that a log
 * written by a newer runtime still validates.
 */
function eventsSchema(): JsonSchema {
  const known = Object.keys(payloadFileSchemas);
  const options = Object.entries(payloadFileSchemas).map(([type, payload]) =>
    EventFileSchema.extend({ type: z.literal(type), payload }),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]];
  const { $schema, oneOf } = toJsonSchema(z.discriminatedUnion("type", options)) as {
    $schema: string;
    oneOf: JsonSchema[];
  };
  const unknownType = toJsonSchema(EventFileSchema) as {
    $schema?: string;
    properties: Record<string, JsonSchema>;
  };
  delete unknownType.$schema;
  unknownType.properties.type = { type: "string", not: { enum: known } };
  return {
    $schema,
    title: "events.jsonl line",
    description:
      "One line of work/<id>/events.jsonl: the envelope, which is strict, and the payload of its type, which may carry fields this version does not know. An unknown type is accepted with any payload.",
    oneOf: [...oneOf, unknownType],
  };
}

function describe(schema: z.ZodType, title: string, description: string): JsonSchema {
  const { $schema, ...rest } = toJsonSchema(schema);
  return { $schema, title, description, ...rest };
}

function toJsonSchema(schema: z.ZodType): JsonSchema {
  // The input shape: a field with a default is optional in the file, and the reader fills it in.
  return z.toJSONSchema(schema, { target: "draft-2020-12", io: "input" }) as JsonSchema;
}
