import { spawnSync } from "node:child_process";
import process from "node:process";

import { prepareNativeExecutable } from "./cache.ts";
import {
  findNativeManifest,
  type RuntimeNativeManifest,
} from "./manifest.ts";
import {
  detectNativeTarget,
  type SupportedNativeTarget,
} from "./target.ts";

interface RuntimeOptions {
  launcherPath?: string;
  args?: readonly string[];
  target?: SupportedNativeTarget;
  prepare?: typeof prepareNativeExecutable;
  spawn?: typeof spawnSync;
}

export async function resolveLauncherExecutable(
  launcherPath: string,
  target?: SupportedNativeTarget,
  prepare: typeof prepareNativeExecutable = prepareNativeExecutable,
): Promise<{
  executable: string;
  manifest: RuntimeNativeManifest;
  target: SupportedNativeTarget;
}> {
  const located = await findNativeManifest(launcherPath);
  const selected = target ?? detectNativeTarget();
  const targetPolicy = located.manifest.targets[selected];
  if (!targetPolicy) {
    throw new Error(
      `Native package does not support runtime target ${selected}`,
    );
  }

  const executable = await prepare(located.manifest, targetPolicy);
  return {
    executable,
    manifest: located.manifest,
    target: selected,
  };
}

export async function runNativeLauncher(
  options: RuntimeOptions = {},
): Promise<number> {
  const launcherPath = options.launcherPath ?? process.argv[1];
  if (!launcherPath) {
    throw new Error("Unable to determine native launcher path");
  }

  const resolved = await resolveLauncherExecutable(
    launcherPath,
    options.target,
    options.prepare,
  );
  const runner = options.spawn ?? spawnSync;
  const result = runner(
    resolved.executable,
    [...(options.args ?? process.argv.slice(2))],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(
      `Native executable terminated by signal ${result.signal}`,
    );
  }
  if (result.status === null) {
    throw new Error("Native executable terminated without an exit status");
  }
  return result.status;
}
