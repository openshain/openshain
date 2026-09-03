// @openshain/core: Contracts (provider interfaces), fundamental objects, and the work runtime
export { ERROR_CODES, type ErrorCode, isOpenshainError, OpenshainError } from "./errors.ts";
export {
  type EventId,
  newEventId,
  newWorkId,
  parseEventId,
  parseWorkId,
  type WorkId,
} from "./ids.ts";
