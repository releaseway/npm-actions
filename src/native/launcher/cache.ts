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
import { join, posix, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";

import {
  extractExecutable,
  normalizeArchivePath,
} from "./archive.ts";
import {
  downloadReleaseAsset,
  verifySha256,
} from "./download.ts";
import type {
  RuntimeNativeManifest,
  RuntimeNativeTarget,
} from "./manifest.ts";

type ArchiveFormat = "tar.gz" | "zip";

interface ArchiveCacheMetadata {
  schema: 2;
  assetSha256: string;
  archiveFormat: ArchiveFormat;
}

interface ExecutableCacheMetadata {
  schema: 2;
  assetSha256: string;
  sourceExecutable: string;
  executableSha256: string;
  executableFile: string;
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

function archiveFormat(asset: string): ArchiveFormat {
  if (asset.endsWith(".tar.gz")) {
    return "tar.gz";
  }
  if (asset.endsWith(".zip")) {
    return "zip";
  }
  throw new Error(`Unsupported native archive format: ${asset}`);
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
    return resolve(
      base,
      "releaseway",
      "npm-actions",
      "native",
      "v2",
      "sha256",
    );
  }

  if (platform === "darwin") {
    return resolve(
      home,
      "Library",
      "Caches",
      "releaseway",
      "npm-actions",
      "native",
      "v2",
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
      "v2",
      "sha256",
    );
  }

  throw new Error(`Unsupported native cache platform: ${platform}`);
}

function normalizedExecutable(target: RuntimeNativeTarget): string {
  return normalizeArchivePath(target.executable);
}

function cachedExecutableName(executable: string): string {
  const name = posix.basename(executable);
  if (!name || name === "." || name === "..") {
    throw new Error(`Invalid cached executable name: ${executable}`);
  }
  return name;
}

function executableCacheKey(executable: string): string {
  return sha256(Buffer.from(executable, "utf8"));
}

async function validateArchiveCache(
  directory: string,
  target: RuntimeNativeTarget,
): Promise<string | undefined> {
  try {
    const metadata = JSON.parse(
      await readFile(join(directory, "archive.json"), "utf8"),
    ) as ArchiveCacheMetadata;
    if (
      metadata.schema !== 2 ||
      metadata.assetSha256 !== target.sha256 ||
      metadata.archiveFormat !== archiveFormat(target.asset)
    ) {
      return undefined;
    }

    const archive = join(directory, "archive.bin");
    const bytes = await readFile(archive);
    if (sha256(bytes) !== target.sha256) {
      return undefined;
    }
    return archive;
  } catch {
    return undefined;
  }
}

async function validateExecutableCache(
  directory: string,
  target: RuntimeNativeTarget,
  executable: string,
): Promise<string | undefined> {
  try {
    const metadata = JSON.parse(
      await readFile(join(directory, "metadata.json"), "utf8"),
    ) as ExecutableCacheMetadata;
    const executableFile = cachedExecutableName(executable);
    if (
      metadata.schema !== 2 ||
      metadata.assetSha256 !== target.sha256 ||
      metadata.sourceExecutable !== executable ||
      typeof metadata.executableSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(metadata.executableSha256) ||
      metadata.executableFile !== executableFile
    ) {
      return undefined;
    }

    const path = join(directory, executableFile);
    const bytes = await readFile(path);
    if (sha256(bytes) !== metadata.executableSha256) {
      return undefined;
    }
    return path;
  } catch {
    return undefined;
  }
}

interface CacheLockOwner {
  kind: "owner";
  release: () => Promise<void>;
}

interface CacheLockCached<T> {
  kind: "cached";
  value: T;
}

type CacheLockResult<T> = CacheLockOwner | CacheLockCached<T>;

async function acquireCacheLock<T>(
  lockDirectory: string,
  validate: () => Promise<T | undefined>,
  label: string,
  options: CacheOptions,
): Promise<CacheLockResult<T>> {
  const pollMs = options.lockPollMs ?? 50;
  const timeoutMs = options.lockTimeoutMs ?? 5 * 60 * 1000;
  const staleMs = options.lockStaleMs ?? 15 * 60 * 1000;
  const started = Date.now();

  while (true) {
    const cached = await validate();
    if (cached !== undefined) {
      return { kind: "cached", value: cached };
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
      throw new Error(`Timed out waiting for native cache lock for ${label}`);
    }
    await delay(pollMs);
  }
}

async function promoteDirectory(
  temp: string,
  finalDirectory: string,
  validate: () => Promise<string | undefined>,
): Promise<string | undefined> {
  try {
    await rename(temp, finalDirectory);
    return validate();
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
    return validate();
  }
}

async function prepareNativeArchive(
  manifest: RuntimeNativeManifest,
  target: RuntimeNativeTarget,
  root: string,
  options: CacheOptions,
): Promise<string> {
  const directory = join(root, target.sha256);
  const executables = join(directory, "executables");
  await mkdir(executables, { recursive: true });

  const validate = () => validateArchiveCache(directory, target);
  const existing = await validate();
  if (existing) {
    return existing;
  }

  const lock = await acquireCacheLock(
    join(directory, ".archive.lock"),
    validate,
    target.asset,
    options,
  );
  if (lock.kind === "cached") {
    return lock.value;
  }

  try {
    const afterLock = await validate();
    if (afterLock) {
      return afterLock;
    }

    await rm(join(directory, "archive.bin"), { force: true });
    await rm(join(directory, "archive.json"), { force: true });

    const temp = await mkdtemp(
      join(root, `.${target.sha256}.archive.tmp-`),
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

      const tempArchive = join(temp, "archive.bin");
      const tempMetadata = join(temp, "archive.json");
      await writeFile(tempArchive, archiveBytes, { mode: 0o600 });
      const metadata: ArchiveCacheMetadata = {
        schema: 2,
        assetSha256: target.sha256,
        archiveFormat: archiveFormat(target.asset),
      };
      await writeFile(
        tempMetadata,
        JSON.stringify(metadata, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      await rename(tempArchive, join(directory, "archive.bin"));
      await rename(tempMetadata, join(directory, "archive.json"));

      const promoted = await validate();
      if (!promoted) {
        throw new Error(
          `Unable to create a valid native archive cache entry for ${target.asset}`,
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

async function prepareExecutableFromArchive(
  archivePath: string,
  target: RuntimeNativeTarget,
  root: string,
  options: CacheOptions,
): Promise<string> {
  const executable = normalizedExecutable(target);
  const key = executableCacheKey(executable);
  const executables = join(root, target.sha256, "executables");
  const finalDirectory = join(executables, key);
  const validate = () =>
    validateExecutableCache(finalDirectory, target, executable);

  const existing = await validate();
  if (existing) {
    return existing;
  }

  const lock = await acquireCacheLock(
    join(executables, `.${key}.lock`),
    validate,
    executable,
    options,
  );
  if (lock.kind === "cached") {
    return lock.value;
  }

  try {
    const afterLock = await validate();
    if (afterLock) {
      return afterLock;
    }

    await rm(finalDirectory, { recursive: true, force: true });
    const temp = await mkdtemp(join(executables, `.${key}.tmp-`));

    try {
      const executableBytes = await extractExecutable(
        archivePath,
        target.asset,
        executable,
      );
      const executableFile = cachedExecutableName(executable);
      const executablePath = join(temp, executableFile);
      await writeFile(executablePath, executableBytes, { mode: 0o755 });
      if ((options.platform ?? process.platform) !== "win32") {
        await chmod(executablePath, 0o755);
      }

      const metadata: ExecutableCacheMetadata = {
        schema: 2,
        assetSha256: target.sha256,
        sourceExecutable: executable,
        executableSha256: sha256(executableBytes),
        executableFile,
      };
      await writeFile(
        join(temp, "metadata.json"),
        JSON.stringify(metadata, null, 2) + "\n",
        { encoding: "utf8", mode: 0o600 },
      );

      const promoted = await promoteDirectory(
        temp,
        finalDirectory,
        validate,
      );
      if (!promoted) {
        throw new Error(
          `Unable to create a valid native executable cache entry for ${executable}`,
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

  const archivePath = await prepareNativeArchive(
    manifest,
    target,
    root,
    options,
  );
  return prepareExecutableFromArchive(
    archivePath,
    target,
    root,
    options,
  );
}

export async function temporaryNativeCacheRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), "releaseway-native-cache-"));
}
