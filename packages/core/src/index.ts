// @openshain/core: Contracts (provider interfaces), fundamental objects, and the work runtime
export {
  CONFIG_FILE_NAME,
  loadConfig,
  type ParseConfigOptions,
  parseConfig,
} from "./config/load.ts";
export type { Config, ToolProviderRef } from "./config/schema.ts";
export { ERROR_CODES, type ErrorCode, isOpenshainError, OpenshainError } from "./errors.ts";
export {
  type EventId,
  newEventId,
  newWorkId,
  parseEventId,
  parseWorkId,
  type WorkId,
} from "./ids.ts";
