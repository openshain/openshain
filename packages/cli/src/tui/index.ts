import type { RuntimeProviders } from "@openshain/core";
import { render } from "ink";
import React from "react";
import { App } from "./app.tsx";
import { createController } from "./controller.ts";

export interface TuiOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
}

/** The alternate screen, cleared, with the mouse wheel sending arrow keys where the terminal supports it. */
const ENTER_SCREEN = "\x1b[?1049h\x1b[H\x1b[2J\x1b[?1007h";
const LEAVE_SCREEN = "\x1b[?1007l\x1b[?1049l";

/** Opens the conversation screen and returns when the person leaves it. */
export async function startTui(options: TuiOptions): Promise<number> {
  const controller = await createController(options);
  process.stdout.write(ENTER_SCREEN);
  const { waitUntilExit } = render(React.createElement(App, { controller }), {
    exitOnCtrlC: false,
  });
  // A closed terminal or a stop signal stops what runs and still ends the session in the record.
  // Registered after render: Ink's own signal handling re-raises a signal when it thinks nobody
  // else listens.
  const closeAndExit = () => {
    controller.close().finally(() => {
      process.stdout.write(LEAVE_SCREEN);
      process.exit(0);
    });
  };
  for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.once(signal, closeAndExit);
  await waitUntilExit();
  await controller.close();
  process.stdout.write(LEAVE_SCREEN);
  console.log(`会話を終えました。記録は openshain work show ${controller.sessionId} で読めます。`);
  return 0;
}
