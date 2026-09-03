import { describe, expect, test } from "bun:test";
import { compileInputValidator } from "./validate.ts";

const schema = {
  type: "object",
  properties: {
    path: { type: "string", minLength: 1 },
    rows: { type: "array", items: { type: "object" } },
  },
  required: ["path"],
  additionalProperties: false,
};

describe("compileInputValidator", () => {
  test("accepts input that matches the schema", () => {
    const validate = compileInputValidator(schema);

    expect(validate({ path: "a.csv", rows: [{ a: 1 }] })).toEqual({ ok: true });
  });

  test("names the missing field", () => {
    const validate = compileInputValidator(schema);

    const result = validate({ rows: [] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("path");
  });

  test("names the field with the wrong type and its location", () => {
    const validate = compileInputValidator(schema);

    const result = validate({ path: "a.csv", rows: [1] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("/rows/0");
  });

  test("rejects unknown fields when the schema says so", () => {
    const validate = compileInputValidator(schema);

    const result = validate({ path: "a.csv", extra: true });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("extra");
  });

  test("rejects input that is not an object", () => {
    const validate = compileInputValidator(schema);

    expect(validate("a.csv").ok).toBe(false);
    expect(validate(null).ok).toBe(false);
  });

  test("tolerates keywords it does not know, as third-party schemas may carry them", () => {
    const validate = compileInputValidator({ ...schema, "x-openshain-hint": "internal" });

    expect(validate({ path: "a.csv" })).toEqual({ ok: true });
  });

  test("throws for a schema that cannot be compiled", () => {
    expect(() => compileInputValidator({ type: "object", properties: 5 })).toThrow();
  });
});

describe("compileInputValidator hardening", () => {
  test("rejects a schema that does not describe an object", () => {
    expect(() => compileInputValidator({})).toThrow(/"type": "object"/);
    expect(() => compileInputValidator({ type: "string" })).toThrow(/"type": "object"/);
  });

  test("rejects a pattern that can backtrack catastrophically", () => {
    expect(() =>
      compileInputValidator({
        type: "object",
        properties: { value: { type: "string", pattern: "^([a-zA-Z]+)+$" } },
      }),
    ).toThrow(/backtrack/);
  });

  test("rejects an unsafe key in patternProperties, even when nested", () => {
    expect(() =>
      compileInputValidator({
        type: "object",
        properties: {
          rows: { type: "array", items: { type: "object", patternProperties: { "(a+)+$": {} } } },
        },
      }),
    ).toThrow(/backtrack/);
  });

  test("accepts ordinary patterns", () => {
    const validate = compileInputValidator({
      type: "object",
      properties: { path: { type: "string", pattern: "^[a-z0-9/._-]+\\.csv$" } },
      required: ["path"],
    });

    expect(validate({ path: "receipts/2026-07.csv" })).toEqual({ ok: true });
    expect(validate({ path: "../x" }).ok).toBe(false);
  });
});
