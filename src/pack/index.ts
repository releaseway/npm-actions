import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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

async function materializePackageVersions(
  packages: readonly PublishablePackage[],
): Promise<(originalError?: unknown) => Promise<void>> {
  const originals = new Map<string, Buffer>();
  const restore = async (originalError?: unknown): Promise<void> => {
    const failures: Array<{ path: string; source: Buffer; error: unknown }> = [];
    for (const [path, source] of originals) {
      try { await writeFile(path, source); }
      catch (error) { failures.push({ path, source, error }); }
    }
    if (!failures.length) return;
    // Outside the run's disposable output tree: orchestration must not erase recovery data.
    let recoveryDirectory: string | undefined;
    const errors = [...(originalError === undefined ? [] : [originalError]), ...failures.map(f => f.error)];
    try {
      recoveryDirectory = await mkdtemp(join(tmpdir(), "releaseway-npm-recovery-"));
      const index = failures.map((failure, i) => ({ path: failure.path, backup: `${i}.json` }));
      await writeFile(join(recoveryDirectory, "recovery.json"), JSON.stringify(index, null, 2) + "\n", { mode: 0o600 });
      for (const [i, failure] of failures.entries()) {
        try { await writeFile(join(recoveryDirectory, index[i]!.backup), failure.source, { mode: 0o600 }); }
        catch (error) { errors.push(error); }
      }
    } catch (error) { errors.push(error); }
    const error = new AggregateError(errors,
      `Manifest restoration failed for ${failures.map(f => f.path).join(", ")}; recovery data: ${recoveryDirectory ?? "could not be saved"}${errors.length > failures.length + (originalError === undefined ? 0 : 1) ? " (backup errors; inspect nested errors)" : ""}`);
    throw Object.assign(error, { recoveryDirectory });
  };

  try {
    for (const pkg of packages) {
      if (pkg.manifest.version === pkg.version) {
        continue;
      }
      const source = await readFile(pkg.manifestPath);
      originals.set(pkg.manifestPath, source);
      const manifest = JSON.parse(source.toString("utf8")) as Record<string, unknown>;
      manifest.version = pkg.version;
      await writeFile(
        pkg.manifestPath,
        JSON.stringify(manifest, null, 2) + "\n",
        { encoding: "utf8" },
      );
    }
  } catch (error) {
    await restore(error);
    throw error;
  }
  return restore;
}

export async function packAllPackages(
  workspaceRoot: string,
  packages: readonly PublishablePackage[],
  command: PackageManagerCommand,
  outputRoot: string,
  runManager: RunManager = defaultRunManager,
  versionPackages: readonly PublishablePackage[] = packages,
): Promise<PackedArtifact[]> {
  const original = await snapshotSourceState(workspaceRoot);
  const restore = await materializePackageVersions(versionPackages);
  let operationError: unknown;
  try {
    const materialized = await snapshotSourceState(workspaceRoot);
    const artifacts: PackedArtifact[] = [];

    for (const pkg of packages) {
      artifacts.push(
        await packPackage(pkg, command, outputRoot, runManager),
      );

      const afterPackage = await snapshotSourceState(workspaceRoot);
      assertSourceStateUnchanged(materialized, afterPackage);
    }

    return artifacts;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    await restore(operationError);
    try {
      const restored = await snapshotSourceState(workspaceRoot);
      assertSourceStateUnchanged(original, restored);
    } catch (error) {
      if (operationError !== undefined) throw new AggregateError([operationError, error],
        `Packing failed: ${operationError instanceof Error ? operationError.message : String(operationError)}; package manager mutated the source worktree`);
      throw error;
    }
  }
}
