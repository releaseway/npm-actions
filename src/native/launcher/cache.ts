import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import { extractExecutable } from "./archive.ts";
import {
  downloadReleaseAsset,
  verifySha256,
} from "./download.ts";
import type {
  RuntimeNativeManifest,
  RuntimeNativeTarget,
} from "./manifest.ts";

interface CacheMetadata {
  schema: 1;
  assetSha256: string;
  executableSha256: string;
  executableFile: string;
  asset: string;
  sourceExecutable: string;
}

interface CacheOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  root?: string;
  download?: (
    repository: string,
    tag: string,
    asset: string,
  ) => Promise<Buffer>;
  lockPollMs?: number;
  lockTimeoutMs?: number;
  lockStaleMs?: number;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function nativeCacheRoot(
  options: Pick<CacheOptions, "env" | "platform" | "home"> = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();

  if (platform === "linux") {
    const base =
      env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0
        ? env.XDG_CACHE_HOME
        : join(home, ".cache");
    return resolve(base, "releaseway", "npm-actions", "native", "sha256");
  }

  if (platform === "darwin") {
    return resolve(
      home,
      "Library",
      "Caches",
      "releaseway",
      "npm-actions",
      "native",
      "sha256",
    );
  }

  if (platform === "win32") {
    if (!env.LOCALAPPDATA) {
      throw new Error("LOCALAPPDATA is required for the native cache on Windows");
    }
    return resolve(
      env.LOCALAPPDATA,
      "releaseway",
      "npm-actions",
      "native",
      "sha256",
    );
  }

  throw new Error(`Unsupported native cache platform: ${platform}`);
}

function cachedExecutableName(target: RuntimeNativeTarget): string {
  const name = posix.basename(target.executable);
  if (!name || name === "." || name === "..") {
    throw new Error(`Invalid cached executable name: ${target.executable}`);
  }
  return name;
}

async function validateCacheEntry(
  directory: string,
  target: RuntimeNativeTarget,
): Promise<string | undefined> {
  try {
    const metadata = JSON.parse(
      await readFile(join(directory, "metadata.json"), "utf8"),
    ) as CacheMetadata;

    if (
      metadata.schema !== 1 ||
      metadata.assetSha256 !== target.sha256 ||
      metadata.asset !== target.asset ||
      metadata.sourceExecutable !== target.executable ||
      typeof metadata.executableSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(metadata.executableSha256) ||
      typeof metadata.executableFile !== "string" ||
      metadata.executableFile !== cachedExecutableName(target)
    ) {
      return undefined;
    }

    const executable = join(directory, metadata.executableFile);
    const bytes = await readFile(executable);
    if (sha256(bytes) !== metadata.executableSha256) {
      return undefined;
    }

    return executable;
  } catch {
    return undefined;
  }
}

interface CacheLockOwner {
  kind: "owner";
  release: () => Promise<void>;
}

interface CacheLockCached {
  kind: "cached";
  executable: string;
}

type CacheLockResult = CacheLockOwner | CacheLockCached;

async function acquireCacheLock(
  root: string,
  finalDirectory: string,
  target: RuntimeNativeTarget,
  options: CacheOptions,
): Promise<CacheLockResult> {
  const lockDirectory = join(root, `.${target.sha256}.lock`);
  const pollMs = options.lockPollMs ?? 50;
  const timeoutMs = options.lockTimeoutMs ?? 5 * 60 * 1000;
  const staleMs = options.lockStaleMs ?? 15 * 60 * 1000;
  const started = Date.now();

  while (true) {
    const cached = await validateCacheEntry(finalDirectory, target);
    if (cached) {
      return { kind: "cached", executable: cached };
    }

    try {
      await mkdir(lockDirectory);
      return {
        kind: "owner",
        release: () => rm(lockDirectory, { recursive: true, force: true }),
      };
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        String(error.code) !== "EEXIST"
      ) {
        throw error;
      }
    }

    try {
      const lockStat = await stat(lockDirectory);
      if (Date.now() - lockStat.mtimeMs > staleMs) {
        await rm(lockDirectory, { recursive: true, force: true });
        continue;
      }
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        String(error.code) === "ENOENT"
      ) {
        continue;
      }
      throw error;
    }

    if (Date.now() - started > timeoutMs) {
      throw new Error(
        `Timed out waiting for native cache lock for ${target.asset}`,
      );
    }
    await delay(pollMs);
  }
}

async function promote(
  temp: string,
  finalDirectory: string,
  target: RuntimeNativeTarget,
): Promise<string | undefined> {
  try {
    await rename(temp, finalDirectory);
    return validateCacheEntry(finalDirectory, target);
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      !["EEXIST", "ENOTEMPTY", "EPERM"].includes(String(error.code))
    ) {
      throw error;
    }

    await rm(temp, { recursive: true, force: true });
    return validateCacheEntry(finalDirectory, target);
  }
}

export async function prepareNativeExecutable(
  manifest: RuntimeNativeManifest,
  target: RuntimeNativeTarget,
  options: CacheOptions = {},
): Promise<string> {
  const root =
    options.root ??
    nativeCacheRoot({
      env: options.env,
      platform: options.platform,
      home: options.home,
    });
  await mkdir(root, { recursive: true });

  const finalDirectory = join(root, target.sha256);
  const existing = await validateCacheEntry(finalDirectory, target);
  if (existing) {
    return existing;
  }

  const lock = await acquireCacheLock(
    root,
    finalDirectory,
    target,
    options,
  );
  if (lock.kind === "cached") {
    return lock.executable;
  }

  try {
    const afterLock = await validateCacheEntry(finalDirectory, target);
    if (afterLock) {
      return afterLock;
    }

    // Only the digest-lock owner may remove an invalid cache entry.
    await rm(finalDirectory, { recursive: true, force: true });

    const temp = await mkdtemp(
      join(root, `.${target.sha256}.tmp-`),
    );

    try {
      const download =
        options.download ??
        ((repository, tag, asset) =>
          downloadReleaseAsset(repository, tag, asset));
      const archiveBytes = await download(
        manifest.repository,
        manifest.tag,
        target.asset,
      );
      verifySha256(archiveBytes, target.sha256);

      const archivePath = join(temp, "asset");
      await writeFile(archivePath, archiveBytes, { mode: 0o600 });
      const executableBytes = await extractExecutable(
        archivePath,
        target.asset,
        target.executable,
      );
      await rm(archivePath, { force: true });

      const executableFile = cachedExecutableName(target);
      const executablePath = join(temp, executableFile);
      await writeFile(executablePath, executableBytes, { mode: 0o755 });
      if ((options.platform ?? process.platform) !== "win32") {
        await chmod(executablePath, 0o755);
      }

      const metadata: CacheMetadata = {
        schema: 1,
        assetSha256: target.sha256,
        executableSha256: sha256(executableBytes),
        executableFile,
        asset: target.asset,
        sourceExecutable: target.executable,
      };
      await writeFile(
        join(temp, "metadata.json"),
        JSON.stringify(metadata, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      const promoted = await promote(temp, finalDirectory, target);
      if (!promoted) {
        throw new Error(
          `Unable to create a valid native cache entry for ${target.asset}`,
        );
      }
      return promoted;
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } finally {
    await lock.release();
  }
}

export async function temporaryNativeCacheRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "releaseway-native-cache-"));
}
