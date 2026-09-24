import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, join, posix, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as tar from "tar";

import type { PackedArtifact } from "../pack/inspect.ts";
import type { PublishablePackage } from "../workspace/discover.ts";
import type { VerifiedNativeRelease } from "./release.ts";
import type { ValidatedNativeDistribution } from "./validate.ts";

export const NATIVE_MANIFEST_PATH = ".releaseway/native.json";

export interface LauncherBundles {
  cjs: Uint8Array;
  esm: Uint8Array;
}

export interface NativeAugmentOptions {
  tempRoot?: string;
}

export interface GeneratedNativeManifest {
  repository: string;
  version: string;
  tag: string;
  targets: Record<
    string,
    {
      asset: string;
      executable: string;
      sha256: string;
    }
  >;
}

function packageEntryPath(relativePath: string): string {
  return `package/${relativePath}`;
}

export function selectLauncherKind(
  manifest: Record<string, unknown>,
  binPath: string,
): "cjs" | "esm" {
  const extension = extname(binPath).toLowerCase();

  if (extension === ".mjs") {
    return "esm";
  }
  if (extension === ".cjs") {
    return "cjs";
  }
  if (extension !== "" && extension !== ".js") {
    throw new Error(
      `Native npm bin path must be extensionless or end in .js, .mjs, or .cjs: ${binPath}`,
    );
  }

  return manifest.type === "module" ? "esm" : "cjs";
}

export function buildNativeManifest(
  release: VerifiedNativeRelease,
): GeneratedNativeManifest {
  const targets: GeneratedNativeManifest["targets"] = {};

  for (const target of Object.keys(release.targets).sort()) {
    const value = release.targets[target];
    targets[target] = {
      asset: value.asset,
      executable: value.executable,
      sha256: value.sha256,
    };
  }

  return {
    repository: release.repository,
    version: release.version,
    tag: release.tag,
    targets,
  };
}

async function assertInjectionParentsSafe(
  packageRoot: string,
  relativePath: string,
): Promise<void> {
  const parts = relativePath.split("/");
  let current = packageRoot;

  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        throw new Error(
          `Native injection parent must be a real directory: ${relativePath}`,
        );
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }
  }
}

async function collectArchiveEntries(
  root: string,
  relativePath = "package",
): Promise<string[]> {
  const absolute = resolve(root, relativePath);
  const entries = await readdir(absolute, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const child = posix.join(relativePath.replaceAll("\\", "/"), entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await collectArchiveEntries(root, child)));
    } else {
      paths.push(child);
    }
  }

  return paths.sort();
}

function assertReservedPathsAvailable(
  artifact: PackedArtifact,
  binPath: string,
): void {
  const reserved = new Set([
    packageEntryPath(binPath),
    packageEntryPath(NATIVE_MANIFEST_PATH),
  ]);

  for (const entry of artifact.entries) {
    const normalized = entry.path.replace(/\/$/, "");
    if (reserved.has(normalized)) {
      throw new Error(
        `Native publication cannot overwrite packed caller content at ${normalized}`,
      );
    }
  }
}

export async function augmentNativeArtifact(
  pkg: PublishablePackage,
  artifact: PackedArtifact,
  distribution: ValidatedNativeDistribution,
  release: VerifiedNativeRelease,
  outputPath: string,
  launchers: LauncherBundles,
  options: NativeAugmentOptions = {},
): Promise<{
  tarballPath: string;
  manifest: GeneratedNativeManifest;
  launcherKind: "cjs" | "esm";
}> {
  if (
    release.repository.length === 0 ||
    release.version !== pkg.version ||
    release.tag !== distribution.tag
  ) {
    throw new Error(`Verified native release does not match ${pkg.name}@${pkg.version}`);
  }

  assertReservedPathsAvailable(artifact, distribution.bin.path);

  const root = await mkdtemp(
    join(options.tempRoot ?? tmpdir(), "releaseway-native-augment-"),
  );

  try {
    await tar.x({
      cwd: root,
      file: artifact.tarballPath,
      strict: true,
      preservePaths: false,
    });

    const packageRoot = join(root, "package");
    const packageStat = await lstat(packageRoot);
    if (!packageStat.isDirectory() || packageStat.isSymbolicLink()) {
      throw new Error("Packed package root must be a real directory");
    }

    await assertInjectionParentsSafe(packageRoot, distribution.bin.path);
    await assertInjectionParentsSafe(packageRoot, NATIVE_MANIFEST_PATH);

    const launcherKind = selectLauncherKind(
      artifact.manifest,
      distribution.bin.path,
    );
    const launcher =
      launcherKind === "esm" ? launchers.esm : launchers.cjs;
    if (launcher.byteLength === 0) {
      throw new Error(`Generated ${launcherKind} native launcher is empty`);
    }

    const launcherPath = join(packageRoot, ...distribution.bin.path.split("/"));
    await mkdir(dirname(launcherPath), { recursive: true });
    await writeFile(launcherPath, launcher);
    await chmod(launcherPath, 0o755);

    const generatedManifest = buildNativeManifest(release);
    const manifestPath = join(
      packageRoot,
      ...NATIVE_MANIFEST_PATH.split("/"),
    );
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify(generatedManifest, null, 2) + "\n",
      { encoding: "utf8", mode: 0o644 },
    );

    const output = resolve(outputPath);
    await mkdir(dirname(output), { recursive: true });
    const entries = await collectArchiveEntries(root);

    await tar.c(
      {
        cwd: root,
        file: output,
        gzip: { level: 9 },
        portable: true,
        mtime: new Date(0),
        noDirRecurse: true,
        strict: true,
      },
      entries,
    );

    await readFile(output);

    return {
      tarballPath: output,
      manifest: generatedManifest,
      launcherKind,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
