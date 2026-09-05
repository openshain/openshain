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
  await waitUntilExit();
  await controller.close();
  return 0;
}
