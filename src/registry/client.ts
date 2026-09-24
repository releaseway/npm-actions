import {
  hasValidSha512Integrity,
  integrityContainsExactSha512,
  sha512Integrity,
} from "./integrity.ts";

const REGISTRY = "https://registry.npmjs.org";

type FetchLike = typeof fetch;

export type RegistryReconciliation =
  | {
      state: "candidate";
      name: string;
      version: string;
      integrity: string;
      latestVersion?: string;
    }
  | {
      state: "existing";
      name: string;
      version: string;
      integrity: string;
    };

export interface NpmRegistryClientOptions {
  fetchImpl?: FetchLike;
  readToken?: string;
}

function versionMetadata(
  metadata: unknown,
  version: string,
): Record<string, unknown> | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("npm registry package metadata is malformed");
  }

  const versions = (metadata as Record<string, unknown>).versions;
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
    throw new Error("npm registry package metadata lacks versions");
  }

  const value = (versions as Record<string, unknown>)[version];
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`npm registry metadata for version ${version} is malformed`);
  }
  return value as Record<string, unknown>;
}

export class NpmRegistryClient {
  readonly #fetchImpl: FetchLike;
  readonly #readToken?: string;

  constructor(options: NpmRegistryClientOptions = {}) {
    this.#fetchImpl = options.fetchImpl ?? fetch;
    this.#readToken = options.readToken;
  }

  async reconcile(
    name: string,
    version: string,
    tarballPath: string,
  ): Promise<RegistryReconciliation> {
    const localIntegrity = await sha512Integrity(tarballPath);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": "releaseway-npm-actions",
    };
    if (this.#readToken) {
      headers.Authorization = `Bearer ${this.#readToken}`;
    }

    const response = await this.#fetchImpl(
      `${REGISTRY}/${encodeURIComponent(name)}`,
      { headers },
    );

    if (response.status === 404) {
      throw new Error(
        `${name} does not exist in the npm registry; maintainer bootstrap and Trusted Publisher configuration are required`,
      );
    }
    if (!response.ok) {
      throw new Error(
        `npm registry metadata request failed for ${name}: HTTP ${response.status}`,
      );
    }

    const metadata = await response.json();
    const metadataRecord = metadata as Record<string, unknown>;
    const distTags = metadataRecord["dist-tags"];
    const latestVersion =
      distTags &&
      typeof distTags === "object" &&
      !Array.isArray(distTags) &&
      typeof (distTags as Record<string, unknown>).latest === "string"
        ? String((distTags as Record<string, unknown>).latest)
        : undefined;

    const existing = versionMetadata(metadata, version);
    if (!existing) {
      return {
        state: "candidate",
        name,
        version,
        integrity: localIntegrity,
        latestVersion,
      };
    }

    const dist = existing.dist;
    if (!dist || typeof dist !== "object" || Array.isArray(dist)) {
      throw new Error(`${name}@${version} registry metadata lacks dist`);
    }
    const remoteIntegrity = (dist as Record<string, unknown>).integrity;
    if (typeof remoteIntegrity !== "string") {
      throw new Error(
        `${name}@${version} registry metadata lacks dist.integrity`,
      );
    }
    if (!hasValidSha512Integrity(remoteIntegrity)) {
      throw new Error(
        `${name}@${version} registry dist.integrity has no valid SHA-512 value`,
      );
    }
    if (!integrityContainsExactSha512(remoteIntegrity, localIntegrity)) {
      throw new Error(
        `${name}@${version} already exists with different package artifact integrity`,
      );
    }

    return {
      state: "existing",
      name,
      version,
      integrity: localIntegrity,
    };
  }
}

export { REGISTRY as NPM_REGISTRY };
