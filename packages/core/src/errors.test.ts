import { describe, expect, test } from "bun:test";
import { isOpenshainError, OpenshainError } from "./errors.ts";

describe("OpenshainError", () => {
  test("carries a machine-readable code and a message", () => {
    const err = new OpenshainError("config", "api_key_env is required");

    expect(err.code).toBe("config");
    expect(err.message).toBe("api_key_env is required");
    expect(err.name).toBe("OpenshainError");
    expect(err).toBeInstanceOf(Error);
  });

  test("keeps the underlying cause", () => {
    const cause = new Error("ECONNRESET");

    const err = new OpenshainError("network", "connection reset", { cause });

    expect(err.cause).toBe(cause);
  });

  test("isOpenshainError narrows unknown values", () => {
    expect(isOpenshainError(new OpenshainError("auth", "bad key"))).toBe(true);
    expect(isOpenshainError(new Error("plain"))).toBe(false);
    expect(isOpenshainError("string")).toBe(false);
    expect(isOpenshainError(null)).toBe(false);
  });

  test("rejects codes outside the known set at compile time", () => {
    // @ts-expect-error "nope" is not an ErrorCode
    const err = new OpenshainError("nope", "unknown code");
    expect(err).toBeInstanceOf(OpenshainError);
  });
});
