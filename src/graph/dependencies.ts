import { satisfies } from "semver";

import type { PackedArtifact } from "../pack/inspect.ts";
import type { PublishablePackage } from "../workspace/discover.ts";

export interface WorkspaceDependencyGraph {
  packages: Map<string, PublishablePackage>;
  hardDependencies: Map<string, Set<string>>;
}

type DependencyField =
  | "dependencies"
  | "optionalDependencies"
  | "peerDependencies";

function dependencyMap(
  manifest: Record<string, unknown>,
  field: DependencyField,
  packageName: string,
): Record<string, string> {
  const value = manifest[field];
  if (value === undefined) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${packageName} packed ${field} must be a mapping`);
  }

  const result: Record<string, string> = {};
  for (const [name, range] of Object.entries(value as Record<string, unknown>)) {
    if (typeof range !== "string" || range.length === 0) {
      throw new Error(
        `${packageName} packed ${field}.${name} must be a non-empty string`,
      );
    }
    result[name] = range;
  }
  return result;
}

function validateInternalRange(
  packageName: string,
  field: DependencyField,
  dependencyName: string,
  range: string,
  dependencyVersion: string,
): void {
  if (!satisfies(dependencyVersion, range)) {
    throw new Error(
      `${packageName} packed ${field} range ${dependencyName}@${range} does not accept workspace version ${dependencyVersion}`,
    );
  }
}

export function buildWorkspaceDependencyGraph(
  packages: readonly PublishablePackage[],
  artifacts: ReadonlyMap<string, PackedArtifact>,
): WorkspaceDependencyGraph {
  const packageMap = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const hardDependencies = new Map<string, Set<string>>();

  for (const pkg of packages) {
    const artifact = artifacts.get(pkg.name);
    if (!artifact) {
      throw new Error(`Missing packed artifact for ${pkg.name}`);
    }

    const hard = new Set<string>();
    for (const field of [
      "dependencies",
      "optionalDependencies",
      "peerDependencies",
    ] as const) {
      const dependencies = dependencyMap(
        artifact.manifest,
        field,
        pkg.name,
      );

      for (const [dependencyName, range] of Object.entries(dependencies)) {
        const workspaceDependency = packageMap.get(dependencyName);
        if (!workspaceDependency) {
          continue;
        }

        validateInternalRange(
          pkg.name,
          field,
          dependencyName,
          range,
          workspaceDependency.version,
        );

        if (field !== "peerDependencies") {
          hard.add(dependencyName);
        }
      }
    }

    hardDependencies.set(pkg.name, hard);
  }

  return {
    packages: packageMap,
    hardDependencies,
  };
}
