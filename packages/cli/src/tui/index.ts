import type { RuntimeProviders } from "@openshain/core";
import { render } from "ink";
import React from "react";
import { App } from "./app.tsx";
import { createController } from "./controller.ts";

export interface TuiOptions {
  workspaceRoot: string;
  providers: RuntimeProviders;
}

/** Opens the conversation screen and returns when the person leaves it. */
export async function startTui(options: TuiOptions): Promise<number> {
  const controller = await createController(options);
  // A closed terminal or a stop signal still ends the session in the record.
  const closeAndExit = () => {
    controller.close().finally(() => process.exit(0));
  };
  process.once("SIGHUP", closeAndExit);
  process.once("SIGTERM", closeAndExit);
  const { waitUntilExit } = render(React.createElement(App, { controller }), {
    exitOnCtrlC: false,
  });
  await waitUntilExit();
  await controller.close();
  return 0;
}
