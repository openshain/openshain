import { describe, expect, test } from "bun:test";
import { uuidv7 } from "./uuid.ts";

const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  test("has the v7 shape and carries the timestamp in the first 48 bits", () => {
    const at = 1_800_000_000_000;
    const id = uuidv7(at);
    expect(id).toMatch(shape);
    expect(Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(at);
  });

  test("ids made in the same millisecond keep their order", () => {
    const at = Date.now() + 10_000;
    const ids = Array.from({ length: 50 }, () => uuidv7(at));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(50);
  });

  test("a later call never sorts before an earlier one, even if the clock goes back", () => {
    const first = uuidv7(Date.now() + 20_000);
    const second = uuidv7(Date.now());
    expect(second > first).toBe(true);
  });
});
