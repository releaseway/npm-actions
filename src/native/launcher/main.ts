#!/usr/bin/env node
import { runNativeLauncher } from "./runtime.ts";

void runNativeLauncher()
  .then((status) => {
    process.exitCode = status;
  })
  .catch((error) => {
    const message =
      error instanceof Error ? error.stack ?? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
