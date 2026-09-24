import { spawnSync } from "node:child_process";
import { access, mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import process from "node:process";

import type { PackageManagerCommand, ReleasewayToolchain } from "../toolchain/bootstrap.ts";
import {
  provisionPackageManager,
  releasewayNpmCommand,
} from "../toolchain/bootstrap.ts";
import type { PublishablePackage } from "../workspace/discover.ts";
import { inspectPackedTarball, type PackedArtifact } from "./inspect.ts";
import {
  assertSourceStateUnchanged,
  snapshotSourceState,
} from "./source-state.ts";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type RunManager = (
  command: PackageManagerCommand,
  args: readonly string[],
  cwd: string,
) => RunResult;

const defaultRunManager: RunManager = (command, args, cwd) => {
  const result = spawnSync(
    command.executable,
    [...command.argsPrefix, ...args],
    {
      cwd,
      env: command.env,
      encoding: "utf8",
    },
  );
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function resolvePackCommand(
  rootManifest: { packageManager?: string },
  toolchain: ReleasewayToolchain,
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<PackageManagerCommand> {
  if (rootManifest.packageManager) {
    return provisionPackageManager(
      rootManifest.packageManager,
      toolchain,
      workspaceRoot,
      env,
    );
  }

  const [pnpmWorkspace, pnpmLock, yarnLock] = await Promise.all([
    pathExists(resolve(workspaceRoot, "pnpm-workspace.yaml")),
    pathExists(resolve(workspaceRoot, "pnpm-lock.yaml")),
    pathExists(resolve(workspaceRoot, "yarn.lock")),
  ]);

  if (pnpmWorkspace || pnpmLock) {
    throw new Error(
      "pnpm projects require an exact root package.json packageManager version",
    );
  }
  if (yarnLock) {
    throw new Error(
      "Yarn projects require an exact root package.json packageManager version",
    );
  }

  return releasewayNpmCommand(toolchain, env);
}

function packArguments(
  command: PackageManagerCommand,
  outputDirectory: string,
): { args: string[]; fixedOutput?: string } {
  if (command.name === "yarn") {
    const fixedOutput = join(outputDirectory, "package.tgz");
    return {
      args: ["pack", "--out", fixedOutput],
      fixedOutput,
    };
  }

  return {
    args: ["pack", "--pack-destination", outputDirectory],
  };
}

async function findSingleTarball(outputDirectory: string): Promise<string> {
  const files = (await readdir(outputDirectory))
    .filter((name) => name.endsWith(".tgz"))
    .sort();

  if (files.length !== 1) {
    throw new Error(
      `Expected exactly one packed tarball in ${outputDirectory}, found ${files.length}`,
    );
  }

  return resolve(outputDirectory, files[0]);
}

export async function packPackage(
  pkg: PublishablePackage,
  command: PackageManagerCommand,
  outputRoot: string,
  runManager: RunManager = defaultRunManager,
): Promise<PackedArtifact> {
  const outputDirectory = resolve(outputRoot, encodeURIComponent(pkg.name));
  await mkdir(outputDirectory, { recursive: true });

  const invocation = packArguments(command, outputDirectory);
  const result = runManager(command, invocation.args, pkg.directory);
  if (result.status !== 0) {
    throw new Error(
      `${command.name} pack failed for ${pkg.name}: ${result.stderr.trim() || result.stdout.trim() || "<no output>"}`,
    );
  }

  const tarballPath =
    invocation.fixedOutput ?? (await findSingleTarball(outputDirectory));
  const artifact = await inspectPackedTarball(tarballPath);

  if (
    artifact.manifest.name !== pkg.name ||
    artifact.manifest.version !== pkg.version
  ) {
    throw new Error(
      `Packed identity mismatch for ${pkg.name}@${pkg.version}: got ${String(artifact.manifest.name)}@${String(artifact.manifest.version)}`,
    );
  }

  return artifact;
}

export async function packAllPackages(
  workspaceRoot: string,
  packages: readonly PublishablePackage[],
  command: PackageManagerCommand,
  outputRoot: string,
  runManager: RunManager = defaultRunManager,
): Promise<PackedArtifact[]> {
  const before = await snapshotSourceState(workspaceRoot);
  const artifacts: PackedArtifact[] = [];

  for (const pkg of packages) {
    artifacts.push(
      await packPackage(pkg, command, outputRoot, runManager),
    );

    const afterPackage = await snapshotSourceState(workspaceRoot);
    assertSourceStateUnchanged(before, afterPackage);
  }

  return artifacts;
}
