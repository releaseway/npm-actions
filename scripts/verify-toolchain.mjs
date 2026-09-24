import { spawnSync } from "node:child_process";
import { rm } from "node:fs/promises";
import process from "node:process";

import validationVersions from "../validation-versions.json" with { type: "json" };
import toolchainLock from "../toolchain.lock.json" with { type: "json" };

import {
  bootstrapReleasewayToolchain,
  provisionPackageManager,
  releasewayNpmCommand,
} from "../src/toolchain/bootstrap.ts";

function run(command, args = []) {
  const result = spawnSync(command.executable, [...command.argsPrefix, ...args], {
    cwd: process.cwd(),
    env: command.env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }

  return (result.stdout ?? "").trim();
}

const toolchain = await bootstrapReleasewayToolchain();

try {
  const npm = releasewayNpmCommand(toolchain, {
    ...process.env,
    PATH: "/releaseway/path-must-not-be-used",
  });
  if (run(npm, ["--version"]) !== toolchainLock.npm.version) {
    throw new Error("Pinned npm executable did not report " + toolchainLock.npm.version);
  }

  const pnpm = provisionPackageManager(
    "pnpm@" + validationVersions.pnpm,
    toolchain,
    process.cwd(),
    {
      ...process.env,
      PATH: "/releaseway/path-must-not-be-used",
    },
  );
  if (run(pnpm, ["--version"]) !== validationVersions.pnpm) {
    throw new Error("Pinned Corepack did not execute pnpm " + validationVersions.pnpm);
  }
} finally {
  await rm(toolchain.root, { recursive: true, force: true });
}
