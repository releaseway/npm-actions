import { spawnSync } from "node:child_process";
import process from "node:process";

import { prepareNativeExecutable } from "./cache.ts";
import {
  loadNativeManifest,
  type RuntimeNativeManifest,
} from "./manifest.ts";
import {
  detectNativeTarget,
  type SupportedNativeTarget,
} from "./target.ts";

interface RuntimeOptions {
  manifestPath: string;
  args?: readonly string[];
  target?: SupportedNativeTarget;
  prepare?: typeof prepareNativeExecutable;
  spawn?: typeof spawnSync;
}

export async function resolveLauncherExecutable(
  manifestPath: string,
  target?: SupportedNativeTarget,
  prepare: typeof prepareNativeExecutable = prepareNativeExecutable,
): Promise<{
  executable: string;
  manifest: RuntimeNativeManifest;
  target: SupportedNativeTarget;
}> {
  const manifest = await loadNativeManifest(manifestPath);
  const selected = target ?? detectNativeTarget();
  const targetPolicy = manifest.targets[selected];
  if (!targetPolicy) {
    throw new Error(
      `Native package does not support runtime target ${selected}`,
    );
  }

  const executable = await prepare(manifest, targetPolicy);
  return {
    executable,
    manifest,
    target: selected,
  };
}

export async function runNativeLauncher(
  options: RuntimeOptions,
): Promise<number> {
  const resolved = await resolveLauncherExecutable(
    options.manifestPath,
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

export function main(options: Pick<RuntimeOptions, "manifestPath">): void {
  void runNativeLauncher(options)
    .then((status) => {
      process.exitCode = status;
    })
    .catch((error) => {
      const message =
        error instanceof Error ? error.stack ?? error.message : String(error);
      console.error(message);
      process.exitCode = 1;
    });
}
