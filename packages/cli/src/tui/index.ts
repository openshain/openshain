import type { RuntimeProviders } from "@openshain/core";
import { render } from "ink";
import React from "react";
import { App } from "./app.tsx";
import { createController } from "./controller.ts";

export interface TuiOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
}

/** The alternate screen, cleared, with the terminal reporting the mouse (SGR) so the wheel reaches the screen. */
const ENTER_SCREEN = "\x1b[?1049h\x1b[H\x1b[2J\x1b[?1000h\x1b[?1006h";
const LEAVE_SCREEN = "\x1b[?1006l\x1b[?1000l\x1b[?1049l";

/** Opens the conversation screen and returns when the person leaves it. */
export async function startTui(options: TuiOptions): Promise<number> {
  const controller = await createController(options);
  // Whatever ends the process, the terminal gets its screen and its mouse back: an error thrown
  // while drawing, a signal, or a crash. Written once.
  let left = false;
  const leave = () => {
    if (left) return;
    left = true;
    process.stdout.write(LEAVE_SCREEN);
  };
  process.once("exit", leave);
  process.stdout.write(ENTER_SCREEN);
  try {
    const { waitUntilExit } = render(React.createElement(App, { controller }), {
      exitOnCtrlC: false,
    });
    // A closed terminal or a stop signal stops what runs and still ends the session in the record.
    // Registered after render: Ink's own signal handling re-raises a signal when it thinks nobody
    // else listens.
    const closeAndExit = () => {
      controller.close().finally(() => {
        leave();
        process.exit(0);
      });
    };
    for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const)
      process.once(signal, closeAndExit);
    await waitUntilExit();
    await controller.close();
  } finally {
    leave();
  }
  console.log(`会話を終えました。記録は openshain work show ${controller.sessionId} で読めます。`);
  return 0;
}
