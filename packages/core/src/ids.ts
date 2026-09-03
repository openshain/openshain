import { OpenshainError } from "./errors.ts";

declare const brand: unique symbol;
type Brand<T, Name extends string> = T & { readonly [brand]: Name };

export type WorkId = Brand<string, "WorkId">;
export type EventId = Brand<string, "EventId">;

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function newWorkId(): WorkId {
  return `work_${Bun.randomUUIDv7()}` as WorkId;
}

export function newEventId(): EventId {
  return `evt_${Bun.randomUUIDv7()}` as EventId;
}

export function parseWorkId(value: string): WorkId {
  return parseId(value, "work_") as WorkId;
}

export function parseEventId(value: string): EventId {
  return parseId(value, "evt_") as EventId;
}

function parseId(value: string, prefix: string): string {
  if (!value.startsWith(prefix) || !UUID_V7.test(value.slice(prefix.length))) {
    throw new OpenshainError("invalid_id", `expected ${prefix}<uuid v7>, got "${value}"`);
  }
  return value;
}
