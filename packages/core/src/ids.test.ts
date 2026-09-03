import { describe, expect, test } from "bun:test";
import { OpenshainError } from "./errors.ts";
import { newEventId, newWorkId, parseEventId, parseWorkId } from "./ids.ts";

const uuidV7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

describe("ids", () => {
  test("work ids are work_ followed by a UUID v7", () => {
    expect(newWorkId()).toMatch(new RegExp(`^work_${uuidV7}$`));
  });

  test("event ids are evt_ followed by a UUID v7", () => {
    expect(newEventId()).toMatch(new RegExp(`^evt_${uuidV7}$`));
  });

  test("ids generated later sort after ids generated earlier", () => {
    const ids = Array.from({ length: 1000 }, () => newWorkId());

    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("parseWorkId accepts its own output", () => {
    const id = newWorkId();

    expect(parseWorkId(id)).toBe(id);
  });

  test("parseWorkId rejects other prefixes and malformed uuids", () => {
    for (const bad of [newEventId(), "work_not-a-uuid", "work_", ""]) {
      expect(() => parseWorkId(bad)).toThrow(OpenshainError);
    }
    try {
      parseWorkId("nope");
    } catch (err) {
      expect((err as OpenshainError).code).toBe("invalid_id");
    }
  });

  test("parseEventId mirrors parseWorkId", () => {
    const id = newEventId();

    expect(parseEventId(id)).toBe(id);
    expect(() => parseEventId(newWorkId())).toThrow(OpenshainError);
  });
});
