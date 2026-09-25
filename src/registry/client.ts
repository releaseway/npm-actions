import { valid } from "semver";
import { immutableJson } from "../immutable.ts";
import type { PackageManifest } from "../workspace/discover.ts";
import {
  hasValidSha512Integrity,
  integrityContainsExactSha512,
} from "./integrity.ts";

export const NPM_REGISTRY = "https://registry.npmjs.org";
export interface RegistryPackageSnapshot {
  readonly name: string;
  readonly versions: Readonly<Record<string, PackageManifest>>;
  readonly latestVersion?: string;
}
export type RegistryVersionLookup = {
  readonly name: string;
  readonly version: string;
  readonly snapshot: RegistryPackageSnapshot;
} & (
  | { readonly state: "already-published"; readonly manifest: PackageManifest }
  | { readonly state: "not-published" }
);
export interface RegistryReadOptions {
  signal?: AbortSignal;
}
export interface RegistryReader {
  lookupVersion(
    name: string,
    version: string,
    options?: RegistryReadOptions,
  ): Promise<RegistryVersionLookup>;
  verifyPublishedArtifact(
    name: string,
    version: string,
    expectedIntegrity: string,
    options?: RegistryReadOptions,
  ): Promise<"matched" | "not-published">;
}
export interface NpmRegistryClientOptions {
  fetchImpl?: typeof fetch;
  readToken?: string;
  requestTimeoutMs?: number;
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " must be a mapping");
  return value as Record<string, unknown>;
}
export function parseRegistrySnapshot(
  name: string,
  raw: unknown,
): RegistryPackageSnapshot {
  const metadata = record(raw, "npm registry package metadata");
  if (metadata.name !== name)
    throw new Error(
      "npm registry package identity mismatch: expected " +
        name +
        ", got " +
        String(metadata.name),
    );
  const rawVersions = record(metadata.versions, name + " registry versions");
  const versions: Record<string, PackageManifest> = Object.create(null);
  for (const [version, rawManifest] of Object.entries(rawVersions)) {
    if (valid(version) !== version)
      throw new Error(
        name + " registry has an invalid version key: " + version,
      );
    const manifest = record(
      rawManifest,
      name + "@" + version + " registry manifest",
    );
    if (manifest.name !== name || manifest.version !== version)
      throw new Error(
        "npm registry version identity mismatch for " + name + "@" + version,
      );
    versions[version] = manifest as PackageManifest;
  }
  let latestVersion: string | undefined;
  if (metadata["dist-tags"] !== undefined) {
    const tags = record(metadata["dist-tags"], name + " registry dist-tags");
    for (const [tag, version] of Object.entries(tags)) {
      if (
        typeof version !== "string" ||
        valid(version) !== version ||
        !Object.hasOwn(versions, version)
      )
        throw new Error(
          name +
            " registry dist-tag " +
            tag +
            " does not identify a live version",
        );
    }
    if (Object.hasOwn(tags, "latest")) latestVersion = tags.latest as string;
  }
  return immutableJson({ name, versions, latestVersion });
}
export function verifyRegistryIntegrity(
  manifest: PackageManifest,
  expectedIntegrity: string,
): void {
  if (!hasValidSha512Integrity(expectedIntegrity))
    throw new Error("Expected artifact integrity must be SHA-512 SRI");
  const identity = String(manifest.name) + "@" + String(manifest.version);
  const dist = record(manifest.dist, identity + " registry dist");
  if (
    typeof dist.integrity !== "string" ||
    !hasValidSha512Integrity(dist.integrity)
  )
    throw new Error(
      identity + " registry dist.integrity has no valid SHA-512 value",
    );
  if (!integrityContainsExactSha512(dist.integrity, expectedIntegrity))
    throw new Error(
      identity + " is live with different package artifact integrity",
    );
}
export class NpmRegistryClient implements RegistryReader {
  readonly #fetchImpl: typeof fetch;
  readonly #readToken?: string;
  readonly #requestTimeoutMs: number;
  constructor(options: NpmRegistryClientOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#readToken = options.readToken;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }
  async lookupVersion(
    name: string,
    version: string,
    options: RegistryReadOptions = {},
  ): Promise<RegistryVersionLookup> {
    if (valid(version) !== version)
      throw new Error("Package version must be exact semver: " + version);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "releaseway-npm-actions",
    };
    if (this.#readToken) headers.Authorization = "Bearer " + this.#readToken;
    const timeout = AbortSignal.timeout(this.#requestTimeoutMs);
    const signal = options.signal
      ? AbortSignal.any([timeout, options.signal])
      : timeout;
    const response = await this.#fetchImpl(
      NPM_REGISTRY + "/" + encodeURIComponent(name),
      { headers, signal },
    );
    if (response.status === 404)
      throw new Error(
        name +
          " does not exist in the npm registry; maintainer bootstrap and Trusted Publisher configuration are required",
      );
    if (!response.ok)
      throw new Error(
        "npm registry metadata request failed for " +
          name +
          ": HTTP " +
          response.status,
      );
    const snapshot = parseRegistrySnapshot(name, await response.json());
    signal.throwIfAborted();
    if (Object.hasOwn(snapshot.versions, version))
      return {
        state: "already-published",
        name,
        version,
        snapshot,
        manifest: snapshot.versions[version],
      };
    // Public absence is not evidence that a version number is unreserved.
    return { state: "not-published", name, version, snapshot };
  }
  async verifyPublishedArtifact(
    name: string,
    version: string,
    expectedIntegrity: string,
    options: RegistryReadOptions = {},
  ): Promise<"matched" | "not-published"> {
    if (!hasValidSha512Integrity(expectedIntegrity))
      throw new Error("Expected artifact integrity must be SHA-512 SRI");
    const lookup = await this.lookupVersion(name, version, options);
    if (lookup.state === "not-published") return "not-published";
    verifyRegistryIntegrity(lookup.manifest, expectedIntegrity);
    return "matched";
  }
}
