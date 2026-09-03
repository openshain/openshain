import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import { OpenshainError } from "../errors.ts";
import type { JsonSchema } from "./types.ts";

export type InputValidation = { ok: true } | { ok: false; reason: string };

/**
 * Compiles a tool's input schema once. Unknown keywords are tolerated because
 * third-party schemas may carry vendor extensions; the schema itself must be valid.
 */
export function compileInputValidator(schema: JsonSchema): (input: unknown) => InputValidation {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  let validate: ReturnType<typeof ajv.compile>;
  try {
    validate = ajv.compile(schema);
  } catch (cause) {
    throw new OpenshainError(
      "invalid_tool",
      `input schema does not compile: ${(cause as Error).message}`,
      { cause },
    );
  }
  return (input) =>
    validate(input) ? { ok: true } : { ok: false, reason: describe(validate.errors ?? []) };
}

function describe(errors: ErrorObject[]): string {
  return errors
    .map((error) => {
      const where = error.instancePath || "/";
      const params = error.params as Record<string, unknown>;
      const detail =
        error.keyword === "additionalProperties"
          ? ` (${String(params.additionalProperty)})`
          : error.keyword === "required"
            ? ` (${String(params.missingProperty)})`
            : "";
      return `${where} ${error.message ?? error.keyword}${detail}`;
    })
    .join("; ");
}
