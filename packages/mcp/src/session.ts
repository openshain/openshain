import type { WorkId } from "@openshain/core";

/** What one connection remembers: the work the agent is on. */
export class Session {
  private currentId: WorkId | undefined;

  get current(): WorkId | undefined {
    return this.currentId;
  }

  select(id: WorkId): void {
    this.currentId = id;
  }

  clear(): void {
    this.currentId = undefined;
  }
}
