import type { WorkId } from "@openshain/core";

/** What one connection remembers: the work the agent is on, and the order of its calls. */
export class Session {
  private currentId: WorkId | undefined;
  private queue: Promise<unknown> = Promise.resolve();

  get current(): WorkId | undefined {
    return this.currentId;
  }

  select(id: WorkId): void {
    this.currentId = id;
  }

  clear(): void {
    this.currentId = undefined;
  }

  /** Runs one call after the previous one finished, so calls the agent makes in parallel do not fight over the work's lock. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
