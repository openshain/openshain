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
  const { waitUntilExit } = render(React.createElement(App, { controller }), {
    exitOnCtrlC: false,
  });
  // A closed terminal or a stop signal still ends the session in the record. Registered after
  // render: Ink's own signal handling re-raises a signal when it thinks nobody else listens.
  const closeAndExit = () => {
    controller.close().finally(() => process.exit(0));
  };
  process.once("SIGHUP", closeAndExit);
  process.once("SIGTERM", closeAndExit);
  await waitUntilExit();
  await controller.close();
  return 0;
}
