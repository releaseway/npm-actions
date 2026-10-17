import { posix } from "node:path";

import type { GithubReleaseDistribution } from "../config/types.ts";
import type { PackedArtifact } from "../pack/inspect.ts";
import type { PublishablePackage } from "../workspace/discover.ts";

export const SUPPORTED_NATIVE_TARGETS = new Set([
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64-gnu",
  "linux-x64-gnu",
  "linux-arm64-musl",
  "linux-x64-musl",
  "win32-arm64",
  "win32-x64",
]);

export interface NativeBinContract {
  commands: string[];
  path: string;
}

export interface ValidatedNativeDistribution {
  bin: NativeBinContract;
  tag: string;
  cacheEnv?: string;
  targets: GithubReleaseDistribution["targets"];
}

function safePackagePath(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.startsWith("/") ||
    value.includes("\0")
  ) {
    throw new Error(`${label} must be a safe relative POSIX path`);
  }

  const normalized = posix.normalize(value.replace(/^\.\//, ""));
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(normalized)
  ) {
    throw new Error(`${label} must be a safe relative POSIX path`);
  }
  return normalized;
}

function normalizeBin(
  packageName: string,
  value: unknown,
): NativeBinContract {
  if (typeof value === "string") {
    return {
      commands: [packageName.includes("/")
        ? packageName.slice(packageName.lastIndexOf("/") + 1)
        : packageName],
      path: safePackagePath(value, `${packageName} bin`),
    };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(
      `${packageName} native distribution requires at least one npm bin entry`,
    );
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([, path]) => typeof path !== "string")) {
    throw new Error(
      `${packageName} native distribution requires at least one npm bin entry with string paths`,
    );
  }

  const paths = new Set(entries.map(([command, path]) =>
    safePackagePath(path as string, `${packageName} bin.${command}`),
  ));
  if (paths.size !== 1) {
    throw new Error(`${packageName} native bin commands must share one launcher path`);
  }
  if (entries.length > 1) {
    const shimOwners = new Map<string, string>();
    for (const [command] of entries) {
      if (
        !/^[A-Za-z0-9]/.test(command) || /[^A-Za-z0-9._+-]/.test(command) ||
        command.endsWith(".") ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(command)
      ) {
        throw new Error(`${packageName} bin.${command} must be a portable command basename`);
      }
      for (const shim of [command, `${command}.cmd`, `${command}.ps1`]) {
        const folded = shim.toLowerCase();
        const owner = shimOwners.get(folded);
        if (owner !== undefined) {
          throw new Error(`${packageName} bin.${command} conflicts with command ${owner} at ${shim}`);
        }
        shimOwners.set(folded, command);
      }
    }
  }
  return {
    commands: entries.map(([command]) => command).sort(),
    path: paths.values().next().value!,
  };
}

export function expandVersionTemplate(
  template: string,
  version: string,
  label: string,
): string {
  const placeholders = template.match(/\{[^}]*\}/g) ?? [];
  if (placeholders.some((placeholder) => placeholder !== "{version}")) {
    throw new Error(`${label} contains an unsupported template placeholder`);
  }
  if (template.includes("{") || template.includes("}")) {
    const withoutSupported = template.replaceAll("{version}", "");
    if (withoutSupported.includes("{") || withoutSupported.includes("}")) {
      throw new Error(`${label} contains malformed template syntax`);
    }
  }

  const result = template.replaceAll("{version}", version);
  if (!result) {
    throw new Error(`${label} expands to an empty value`);
  }
  return result;
}

export function expandReleaseTag(template: string, version: string): string {
  return expandVersionTemplate(template, version, "distribution.tag");
}

export function validateNativeDistribution(
  pkg: PublishablePackage,
  artifact: PackedArtifact,
): ValidatedNativeDistribution {
  const distribution = pkg.policy?.distribution;
  if (!distribution) {
    throw new Error(`${pkg.name} does not declare native distribution policy`);
  }

  const bin = normalizeBin(pkg.name, artifact.manifest.bin);
  const targets: GithubReleaseDistribution["targets"] = {};

  for (const [target, targetPolicy] of Object.entries(distribution.targets)) {
    if (!SUPPORTED_NATIVE_TARGETS.has(target)) {
      throw new Error(`${pkg.name} has unsupported native target ${target}`);
    }

    const asset = expandVersionTemplate(
      targetPolicy.asset,
      pkg.version,
      `${pkg.name} native asset for ${target}`,
    );
    if (!asset.endsWith(".tar.gz") && !asset.endsWith(".zip")) {
      throw new Error(
        `${pkg.name} native asset ${asset} must be .tar.gz or .zip`,
      );
    }

    const executable = safePackagePath(
      targetPolicy.executable,
      `${pkg.name} native executable for ${target}`,
    );
    targets[target] = { asset, executable };
  }

  return {
    bin,
    tag: expandReleaseTag(distribution.tag, pkg.version),
    ...(distribution.cacheEnv === undefined
      ? {}
      : { cacheEnv: distribution.cacheEnv }),
    targets,
  };
}
