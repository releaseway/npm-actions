import { lt, prerelease, valid, validRange } from "semver";

import { NPM_REGISTRY } from "../registry/client.ts";
import type { PackageManifest } from "../workspace/discover.ts";

export type PublishAccess = "public" | "restricted" | "private";

export interface PublishOptions {
  tag?: string;
  access?: PublishAccess;
}

function publishConfig(
  manifest: PackageManifest,
): Record<string, unknown> {
  if (manifest.publishConfig === undefined) {
    return {};
  }
  if (
    !manifest.publishConfig ||
    typeof manifest.publishConfig !== "object" ||
    Array.isArray(manifest.publishConfig)
  ) {
    throw new Error("packed publishConfig must be a mapping");
  }
  return manifest.publishConfig as Record<string, unknown>;
}

function rejectCredentialConfiguration(
  config: Record<string, unknown>,
): void {
  for (const key of Object.keys(config)) {
    if (/(?:auth|token|password|username|otp)/i.test(key)) {
      throw new Error(
        `packed publishConfig contains forbidden publish credential setting: ${key}`,
      );
    }
  }
}

export function derivePublishOptions(
  manifest: PackageManifest,
  version: string,
  latestVersion?: string,
): PublishOptions {
  if (valid(version) !== version) {
    throw new Error(`Package version must be exact semver: ${version}`);
  }

  const config = publishConfig(manifest);
  rejectCredentialConfiguration(config);

  if (
    config.registry !== undefined &&
    config.registry !== NPM_REGISTRY &&
    config.registry !== NPM_REGISTRY + "/"
  ) {
    throw new Error(
      `packed publishConfig.registry must be ${NPM_REGISTRY}/`,
    );
  }

  let tag: string | undefined;
  if (config.tag !== undefined) {
    if (typeof config.tag !== "string" || config.tag.length === 0) {
      throw new Error("packed publishConfig.tag must be a non-empty string");
    }
    if (validRange(config.tag) !== null) {
      throw new Error(
        `packed publishConfig.tag must not be interpretable as a SemVer range: ${config.tag}`,
      );
    }
    tag = config.tag;
  }

  let access: PublishAccess | undefined;
  if (config.access !== undefined) {
    if (
      config.access !== "public" &&
      config.access !== "restricted" &&
      config.access !== "private"
    ) {
      throw new Error(
        "packed publishConfig.access must be public, restricted, or private",
      );
    }
    access = config.access;
  }

  if (!tag && prerelease(version) !== null) {
    throw new Error(
      `${version} is a prerelease and requires explicit publishConfig.tag`,
    );
  }

  if (!tag && latestVersion !== undefined) {
    if (valid(latestVersion) !== latestVersion) {
      throw new Error(
        `npm latest dist-tag is not valid semver: ${latestVersion}`,
      );
    }
    if (lt(version, latestVersion)) {
      throw new Error(
        `${version} is lower than current latest ${latestVersion} and requires explicit publishConfig.tag`,
      );
    }
  }

  return { tag, access };
}
