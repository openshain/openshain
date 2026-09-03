import type { ErrorObject } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import safeRegex from "safe-regex2";
import { OpenshainError } from "../errors.ts";
import type { JsonSchema } from "./types.ts";

export type InputValidation = { ok: true } | { ok: false; reason: string };

/**
 * Compiles a tool's input schema once. Unknown keywords are tolerated because
 * third-party schemas may carry vendor extensions; the schema itself must be
 * valid, must describe an object, and may not contain a regular expression
 * that can be made to backtrack catastrophically (the model controls the input).
 */
export function compileInputValidator(schema: JsonSchema): (input: unknown) => InputValidation {
  if (schema.type !== "object") {
    throw new OpenshainError("invalid_tool", 'input schema must have "type": "object"');
  }
  const unsafe = findUnsafePattern(schema);
  if (unsafe !== undefined) {
    throw new OpenshainError(
      "invalid_tool",
      `input schema contains a regular expression that can backtrack catastrophically: ${unsafe}`,
    );
  }
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

/** Walks the schema and returns the first `pattern` or `patternProperties` key that is unsafe. */
function findUnsafePattern(node: unknown): string | undefined {
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findUnsafePattern(item);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (node === null || typeof node !== "object") return undefined;
  for (const [key, value] of Object.entries(node)) {
    if (key === "pattern" && typeof value === "string" && !safeRegex(value)) return value;
    if (key === "patternProperties" && value !== null && typeof value === "object") {
      for (const pattern of Object.keys(value)) {
        if (!safeRegex(pattern)) return pattern;
      }
    }
    const found = findUnsafePattern(value);
    if (found !== undefined) return found;
  }
  return undefined;
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
