import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import fg from "fast-glob";
import { parseDocument } from "yaml";

import type {
  PackagePolicy,
  PublishMode,
  ReleasewayConfig,
} from "../config/types.ts";
import {
  parseGitHubRepository,
  repositoryFullName,
} from "./repository.ts";

export interface PackageManifest {
  name?: string;
  version?: string;
  private?: boolean;
  repository?: unknown;
  packageManager?: string;
  workspaces?: unknown;
  publishConfig?: unknown;
  [key: string]: unknown;
}

export interface DiscoveredPackage {
  directory: string;
  relativeDirectory: string;
  manifestPath: string;
  manifest: PackageManifest;
}

export interface PublishablePackage extends DiscoveredPackage {
  name: string;
  version: string;
  publishMode: PublishMode;
  policy?: PackagePolicy;
}

async function readJsonManifest(path: string): Promise<PackageManifest> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(
      `Failed to read package manifest ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Package manifest must contain a JSON object: ${path}`);
  }
  return parsed as PackageManifest;
}

function packageJsonWorkspacePatterns(manifest: PackageManifest): string[] {
  const value = manifest.workspaces;
  if (value === undefined) {
    return [];
  }
  if (Array.isArray(value)) {
    if (!value.every((entry) => typeof entry === "string")) {
      throw new Error("package.json workspaces must contain only strings");
    }
    return [...value];
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const packages = (value as Record<string, unknown>).packages;
    if (
      !Array.isArray(packages) ||
      !packages.every((entry) => typeof entry === "string")
    ) {
      throw new Error(
        "package.json workspaces.packages must contain only strings",
      );
    }
    return [...packages];
  }
  throw new Error("package.json workspaces must be an array or mapping");
}

async function pnpmWorkspacePatterns(
  workspaceRoot: string,
): Promise<string[] | undefined> {
  const path = resolve(workspaceRoot, "pnpm-workspace.yaml");
  let source: string;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }

  const document = parseDocument(source, {
    uniqueKeys: true,
    strict: true,
  });
  if (document.errors.length > 0) {
    throw new Error(
      `Invalid pnpm-workspace.yaml: ${document.errors.map((error) => error.message).join("; ")}`,
    );
  }

  const raw = document.toJS();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("pnpm-workspace.yaml must contain a mapping");
  }

  const packages = (raw as Record<string, unknown>).packages;
  if (packages === undefined) {
    return ["**"];
  }
  if (
    !Array.isArray(packages) ||
    !packages.every((entry) => typeof entry === "string")
  ) {
    throw new Error("pnpm-workspace.yaml packages must contain only strings");
  }

  return [...packages];
}

function packageManifestPatterns(patterns: readonly string[]): string[] {
  return patterns.map((pattern) => {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    const trimmed = body.replace(/\/+$/, "");
    const packagePattern =
      trimmed === "" || trimmed === "."
        ? "package.json"
        : `${trimmed}/package.json`;
    return negated ? `!${packagePattern}` : packagePattern;
  });
}

function assertWithinWorkspace(workspace: string, candidate: string): void {
  const rel = relative(workspace, candidate);
  if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error(`Workspace package escapes GITHUB_WORKSPACE: ${candidate}`);
  }
}

export async function discoverWorkspace(
  workspaceRoot: string,
): Promise<DiscoveredPackage[]> {
  const root = await realpath(resolve(workspaceRoot));
  const rootManifestPath = resolve(root, "package.json");
  const rootManifest = await readJsonManifest(rootManifestPath);

  const pnpmPatterns = await pnpmWorkspacePatterns(root);
  const patterns =
    pnpmPatterns ?? packageJsonWorkspacePatterns(rootManifest);

  const manifestPaths = new Set<string>([rootManifestPath]);
  if (patterns.length > 0) {
    const matches = await fg(packageManifestPatterns(patterns), {
      cwd: root,
      absolute: true,
      onlyFiles: true,
      unique: true,
      followSymbolicLinks: false,
      ignore: ["**/node_modules/**", "**/.git/**"],
    });
    for (const match of matches) {
      manifestPaths.add(resolve(match));
    }
  }

  const discovered: DiscoveredPackage[] = [];
  for (const manifestPath of [...manifestPaths].sort()) {
    const directory = await realpath(dirname(manifestPath));
    assertWithinWorkspace(root, directory);
    const relativeDirectory = relative(root, directory) || ".";
    discovered.push({
      directory,
      relativeDirectory,
      manifestPath,
      manifest: await readJsonManifest(manifestPath),
    });
  }

  return discovered.sort((a, b) => {
    if (a.relativeDirectory === ".") return -1;
    if (b.relativeDirectory === ".") return 1;
    return a.relativeDirectory.localeCompare(b.relativeDirectory);
  });
}

function normalizeRegistry(value: string): string {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) {
      return value;
    }
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return value;
  }
}

function validateRegistry(manifest: PackageManifest, packageName: string): void {
  const value = manifest.publishConfig;
  if (value === undefined) {
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${packageName} publishConfig must be a mapping`);
  }

  const registry = (value as Record<string, unknown>).registry;
  if (registry === undefined) {
    return;
  }
  if (typeof registry !== "string") {
    throw new Error(`${packageName} publishConfig.registry must be a string`);
  }
  if (normalizeRegistry(registry) !== "https://registry.npmjs.org") {
    throw new Error(
      `${packageName} resolves publication to unsupported registry ${registry}`,
    );
  }
}

function validatePackageRepository(
  manifest: PackageManifest,
  packageName: string,
  expectedRepository: string,
): void {
  const actual = repositoryFullName(
    parseGitHubRepository(manifest.repository),
  );
  if (actual.toLowerCase() !== expectedRepository.toLowerCase()) {
    throw new Error(
      `${packageName} repository ${actual} does not match ${expectedRepository}`,
    );
  }
}

export function selectPublishablePackages(
  discovered: readonly DiscoveredPackage[],
  config: ReleasewayConfig,
  expectedRepository: string,
): PublishablePackage[] {
  const names = new Map<string, DiscoveredPackage>();
  for (const pkg of discovered) {
    if (typeof pkg.manifest.name !== "string" || pkg.manifest.name.length === 0) {
      continue;
    }
    const existing = names.get(pkg.manifest.name);
    if (existing) {
      throw new Error(
        `Duplicate workspace package name ${pkg.manifest.name}: ${existing.relativeDirectory}, ${pkg.relativeDirectory}`,
      );
    }
    names.set(pkg.manifest.name, pkg);
  }

  for (const selector of Object.keys(config.packages)) {
    if (!names.has(selector)) {
      throw new Error(
        `Releaseway config package selector does not match a discovered package: ${selector}`,
      );
    }
  }

  const publishable: PublishablePackage[] = [];
  for (const pkg of discovered) {
    if (pkg.manifest.private === true) {
      continue;
    }

    const name = pkg.manifest.name;
    const version = pkg.manifest.version;
    if (typeof name !== "string" || name.length === 0) {
      throw new Error(
        `Publishable package at ${pkg.relativeDirectory} is missing package.json.name`,
      );
    }
    if (typeof version !== "string" || version.length === 0) {
      throw new Error(`${name} is missing package.json.version`);
    }

    validateRegistry(pkg.manifest, name);
    validatePackageRepository(pkg.manifest, name, expectedRepository);

    const policy = config.packages[name];
    publishable.push({
      ...pkg,
      name,
      version,
      policy,
      publishMode: policy?.publish?.mode ?? config.publish.mode,
    });
  }

  return publishable.sort((a, b) => a.name.localeCompare(b.name));
}
