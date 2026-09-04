import { access } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { CONFIG_FILE_NAME, OpenshainError } from "@openshain/core";

/** The nearest directory at or above `start` that holds openshain.yaml. */
export async function findWorkspace(start: string): Promise<string> {
  let dir = resolve(start);
  for (;;) {
    try {
      await access(join(dir, CONFIG_FILE_NAME));
      return dir;
    } catch {
      const parent = dirname(dir);
      if (parent === dir) {
        throw new OpenshainError(
          "config",
          `${CONFIG_FILE_NAME} が見つかりません。${resolve(start)} から上に向かって探しました。openshain init で作れます。`,
        );
      }
      dir = parent;
    }
  }
}
