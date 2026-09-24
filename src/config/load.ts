import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

import {
  DEFAULT_CONFIG,
  type GithubReleaseDistribution,
  type NativeTargetPolicy,
  type PackagePolicy,
  type PublishMode,
  type ReleasewayConfig,
} from "./types.ts";

const CONFIG_PATH = ".github/npm/packages.yml";

function assertRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a mapping`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} has unsupported keys: ${unknown.join(", ")}`);
  }
}

function readMode(value: unknown, label: string): PublishMode {
  if (value !== "direct" && value !== "stage") {
    throw new Error(`${label} must be direct or stage`);
  }
  return value;
}

function readPublish(value: unknown, label: string): { mode: PublishMode } {
  const mapping = assertRecord(value, label);
  assertKnownKeys(mapping, ["mode"], label);
  if (!("mode" in mapping)) {
    throw new Error(`${label}.mode is required`);
  }
  return { mode: readMode(mapping.mode, `${label}.mode`) };
}

function readTarget(value: unknown, label: string): NativeTargetPolicy {
  const mapping = assertRecord(value, label);
  assertKnownKeys(mapping, ["asset", "executable"], label);

  if (typeof mapping.asset !== "string" || mapping.asset.length === 0) {
    throw new Error(`${label}.asset must be a non-empty string`);
  }
  if (
    typeof mapping.executable !== "string" ||
    mapping.executable.length === 0
  ) {
    throw new Error(`${label}.executable must be a non-empty string`);
  }

  return {
    asset: mapping.asset,
    executable: mapping.executable,
  };
}

function readDistribution(
  value: unknown,
  label: string,
): GithubReleaseDistribution {
  const mapping = assertRecord(value, label);
  assertKnownKeys(mapping, ["type", "tag", "targets"], label);

  if (mapping.type !== "github-release") {
    throw new Error(`${label}.type must be github-release`);
  }
  if (typeof mapping.tag !== "string" || mapping.tag.length === 0) {
    throw new Error(`${label}.tag must be a non-empty string`);
  }

  const targetsMapping = assertRecord(mapping.targets, `${label}.targets`);
  const entries = Object.entries(targetsMapping);
  if (entries.length === 0) {
    throw new Error(`${label}.targets must not be empty`);
  }

  const targets: Record<string, NativeTargetPolicy> = {};
  for (const [target, targetValue] of entries) {
    targets[target] = readTarget(targetValue, `${label}.targets.${target}`);
  }

  return {
    type: "github-release",
    tag: mapping.tag,
    targets,
  };
}

function readPackagePolicy(value: unknown, label: string): PackagePolicy {
  const mapping = assertRecord(value, label);
  assertKnownKeys(mapping, ["publish", "distribution"], label);

  const policy: PackagePolicy = {};
  if ("publish" in mapping) {
    policy.publish = readPublish(mapping.publish, `${label}.publish`);
  }
  if ("distribution" in mapping) {
    policy.distribution = readDistribution(
      mapping.distribution,
      `${label}.distribution`,
    );
  }
  return policy;
}

export function parseConfig(source: string): ReleasewayConfig {
  const document = parseDocument(source, {
    uniqueKeys: true,
    strict: true,
  });

  if (document.errors.length > 0) {
    throw new Error(
      `Invalid Releaseway config: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const raw = document.toJS();
  const root = assertRecord(raw, "config");
  assertKnownKeys(root, ["schema", "publish", "packages"], "config");

  if (root.schema !== 1) {
    throw new Error("config.schema must be 1");
  }

  const publish =
    "publish" in root
      ? readPublish(root.publish, "config.publish")
      : DEFAULT_CONFIG.publish;

  const packages: Record<string, PackagePolicy> = {};
  if ("packages" in root) {
    const packageMapping = assertRecord(root.packages, "config.packages");
    for (const [name, policy] of Object.entries(packageMapping)) {
      if (!name) {
        throw new Error("config.packages keys must be npm package names");
      }
      packages[name] = readPackagePolicy(
        policy,
        `config.packages.${name}`,
      );
    }
  }

  return {
    schema: 1,
    publish: { ...publish },
    packages,
  };
}

export async function loadConfig(
  workspaceRoot: string,
): Promise<ReleasewayConfig> {
  const path = resolve(workspaceRoot, CONFIG_PATH);
  try {
    return parseConfig(await readFile(path, "utf8"));
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return {
        schema: 1,
        publish: { ...DEFAULT_CONFIG.publish },
        packages: {},
      };
    }
    throw error;
  }
}

export { CONFIG_PATH };
