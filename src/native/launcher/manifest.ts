import { readFile } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

import { SUPPORTED_NATIVE_TARGETS } from "../validate.ts";

export interface RuntimeNativeTarget {
  asset: string;
  executable: string;
  sha256: string;
}

export interface RuntimeNativeManifest {
  repository: string;
  version: string;
  tag: string;
  targets: Record<string, RuntimeNativeTarget>;
}

function requiredString(
  value: unknown,
  label: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

export function parseNativeManifest(
  value: unknown,
): RuntimeNativeManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native runtime manifest must be an object");
  }
  const root = value as Record<string, unknown>;

  const repository = requiredString(root.repository, "manifest.repository");
  if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
    throw new Error("manifest.repository must be owner/repo");
  }

  const version = requiredString(root.version, "manifest.version");
  const tag = requiredString(root.tag, "manifest.tag");

  if (!root.targets || typeof root.targets !== "object" || Array.isArray(root.targets)) {
    throw new Error("manifest.targets must be a mapping");
  }

  const targets: Record<string, RuntimeNativeTarget> = {};
  for (const [target, raw] of Object.entries(
    root.targets as Record<string, unknown>,
  )) {
    if (!SUPPORTED_NATIVE_TARGETS.has(target)) {
      throw new Error(`manifest contains unsupported native target ${target}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`manifest.targets.${target} must be an object`);
    }
    const mapping = raw as Record<string, unknown>;
    const asset = requiredString(
      mapping.asset,
      `manifest.targets.${target}.asset`,
    );
    if (!asset.endsWith(".tar.gz") && !asset.endsWith(".zip")) {
      throw new Error(`manifest target ${target} has unsupported archive format`);
    }
    const executable = requiredString(
      mapping.executable,
      `manifest.targets.${target}.executable`,
    );
    const sha256 = requiredString(
      mapping.sha256,
      `manifest.targets.${target}.sha256`,
    ).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) {
      throw new Error(`manifest target ${target} has invalid SHA-256`);
    }

    targets[target] = { asset, executable, sha256 };
  }

  if (Object.keys(targets).length === 0) {
    throw new Error("manifest.targets must not be empty");
  }

  return { repository, version, tag, targets };
}

export async function findNativeManifest(
  launcherPath: string,
): Promise<{ packageRoot: string; manifest: RuntimeNativeManifest }> {
  let current = dirname(resolve(launcherPath));

  while (true) {
    const manifestPath = resolve(current, ".releaseway", "native.json");
    try {
      const source = await readFile(manifestPath, "utf8");
      return {
        packageRoot: current,
        manifest: parseNativeManifest(JSON.parse(source)),
      };
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        const parent = dirname(current);
        if (parent === current) {
          break;
        }
        current = parent;
        continue;
      }
      throw new Error(
        `Failed to read native runtime manifest ${manifestPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(
    `Unable to locate .releaseway/native.json above launcher ${launcherPath}`,
  );
}
