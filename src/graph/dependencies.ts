import npa from "npm-package-arg";
import { rsort, satisfies, validRange } from "semver";

import type { PackedArtifact } from "../pack/inspect.ts";
import type { RegistryPackageSnapshot } from "../registry/client.ts";
import type { PublishablePackage } from "../workspace/discover.ts";

export type DependencyField =
  "dependencies" | "optionalDependencies" | "peerDependencies";
export interface DependencyRequirement {
  readonly field: DependencyField;
  readonly installName: string;
  readonly name: string;
  readonly range: string;
  readonly version: string;
  readonly source: "live" | "candidate";
}
export interface WorkspaceDependencyGraph {
  packages: Map<string, PublishablePackage>;
  hardDependencies: Map<string, Set<string>>;
  requirements: Map<string, readonly DependencyRequirement[]>;
}
function dependencyMap(
  manifest: Record<string, unknown>,
  field: DependencyField,
  packageName: string,
): Record<string, string> {
  const value = manifest[field];
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(packageName + " packed " + field + " must be a mapping");
  const result: Record<string, string> = Object.create(null);
  for (const [name, range] of Object.entries(value)) {
    if (typeof range !== "string" || range.length === 0)
      throw new Error(
        packageName +
          " packed " +
          field +
          "." +
          name +
          " must be a non-empty string",
      );
    result[name] = range;
  }
  return result;
}

/** Only candidate manifests are evaluated; published local source is never reinterpreted. */
export function buildWorkspaceDependencyGraph(
  packages: readonly PublishablePackage[],
  artifacts: ReadonlyMap<string, PackedArtifact>,
  snapshots: ReadonlyMap<string, RegistryPackageSnapshot>,
): WorkspaceDependencyGraph {
  const managed = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const candidates = new Map(
    packages
      .filter((pkg) => artifacts.has(pkg.name))
      .map((pkg) => [pkg.name, pkg]),
  );
  const hardDependencies = new Map<string, Set<string>>();
  const requirements = new Map<string, readonly DependencyRequirement[]>();
  for (const [name, pkg] of candidates) {
    const artifact = artifacts.get(name)!;
    const dependencies = dependencyMap(artifact.manifest, "dependencies", name);
    const optional = dependencyMap(
      artifact.manifest,
      "optionalDependencies",
      name,
    );
    // npm optionalDependencies overrides the same install name in dependencies.
    for (const installName of Object.keys(optional))
      delete dependencies[installName];
    const peers = dependencyMap(artifact.manifest, "peerDependencies", name);
    const hard = new Set<string>();
    const required: DependencyRequirement[] = [];
    for (const [field, mapping] of [
      ["dependencies", dependencies],
      ["optionalDependencies", optional],
      ["peerDependencies", peers],
    ] as const) {
      for (const [installName, spec] of Object.entries(mapping)) {
        const parsed = npa.resolve(installName, spec);
        const target = parsed.type === "alias" ? parsed.subSpec : parsed;
        if (!target.name || !managed.has(target.name)) continue;
        if (
          (target.type !== "range" && target.type !== "version") ||
          !target.fetchSpec ||
          validRange(target.fetchSpec) === null
        ) {
          throw new Error(
            name +
              " packed " +
              field +
              "." +
              installName +
              " must resolve to a registry SemVer range for managed package " +
              target.name,
          );
        }
        const snapshot = snapshots.get(target.name);
        if (!snapshot)
          throw new Error("Missing registry snapshot for " + target.name);
        const range = target.fetchSpec;
        const liveVersion = rsort(
          Object.keys(snapshot.versions).filter((version) =>
            satisfies(version, range),
          ),
        )[0];
        const candidate = candidates.get(target.name);
        const candidateMatches =
          candidate !== undefined && satisfies(candidate.version, range);
        if (!liveVersion && !candidateMatches) {
          throw new Error(
            name +
              " packed " +
              field +
              " " +
              installName +
              " (" +
              target.name +
              "@" +
              range +
              ") has no satisfying live version or planned candidate",
          );
        }
        if (
          !liveVersion &&
          field === "dependencies" &&
          pkg.publishMode === "direct" &&
          candidate!.publishMode !== "direct"
        ) {
          throw new Error(
            name +
              " cannot publish directly: required " +
              target.name +
              "@" +
              range +
              " is only a staged candidate and has no satisfying live version",
          );
        }
        const requirement: DependencyRequirement = {
          field,
          installName,
          name: target.name,
          range,
          version: liveVersion ?? candidate!.version,
          source: liveVersion ? "live" : "candidate",
        };
        required.push(Object.freeze(requirement));
        if (!liveVersion && field !== "peerDependencies") hard.add(target.name);
      }
    }
    hardDependencies.set(name, hard);
    requirements.set(name, Object.freeze(required));
  }
  return { packages: candidates, hardDependencies, requirements };
}
