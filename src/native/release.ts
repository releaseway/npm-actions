import type { NativeTargetPolicy } from "../config/types.ts";
import type { ValidatedNativeDistribution } from "./validate.ts";

const API_VERSION = "2026-03-10";

interface GithubAsset {
  name?: unknown;
  state?: unknown;
  digest?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  draft?: unknown;
  immutable?: unknown;
  published_at?: unknown;
  assets?: unknown;
}

interface GithubRefObject {
  type?: unknown;
  sha?: unknown;
}

interface GithubRef {
  object?: unknown;
}

interface GithubTag {
  object?: unknown;
}

export interface VerifiedNativeTarget {
  asset: string;
  executable: string;
  sha256: string;
}

export interface VerifiedNativeRelease {
  repository: string;
  version: string;
  tag: string;
  targets: Record<string, VerifiedNativeTarget>;
}

interface GithubReleaseSnapshot {
  repository: string;
  tag: string;
  sourceCommit: string;
  assets: readonly unknown[];
}

type FetchLike = typeof fetch;

async function apiJson(
  repository: string,
  path: string,
  fetchImpl: FetchLike,
): Promise<unknown> {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}${path}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": API_VERSION,
        "User-Agent": "releaseway-npm-actions",
      },
    },
  );

  if (!response.ok) {
    throw new Error(
      `GitHub public API request failed for ${repository}${path}: HTTP ${response.status}`,
    );
  }
  return response.json();
}

function refObject(value: unknown, label: string): GithubRefObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is malformed`);
  }
  const object = value as GithubRefObject;
  if (
    (object.type !== "commit" && object.type !== "tag") ||
    typeof object.sha !== "string" ||
    !/^[0-9a-f]{40}$/i.test(object.sha)
  ) {
    throw new Error(`${label} is malformed`);
  }
  return object;
}

async function resolveTagCommit(
  repository: string,
  tag: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const refRaw = (await apiJson(
    repository,
    `/git/ref/tags/${encodeURIComponent(tag)}`,
    fetchImpl,
  )) as GithubRef;
  let current = refObject(refRaw?.object, `Git tag ref ${tag}`);

  const seen = new Set<string>();
  for (let depth = 0; depth < 16; depth += 1) {
    if (current.type === "commit") {
      return String(current.sha).toLowerCase();
    }

    const sha = String(current.sha).toLowerCase();
    if (seen.has(sha)) {
      throw new Error(`Annotated tag ${tag} contains a cycle`);
    }
    seen.add(sha);

    const tagRaw = (await apiJson(
      repository,
      `/git/tags/${sha}`,
      fetchImpl,
    )) as GithubTag;
    current = refObject(tagRaw?.object, `Annotated tag object ${sha}`);
  }

  throw new Error(`Annotated tag ${tag} exceeds the supported peel depth`);
}

function releaseObject(value: unknown): GithubRelease {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub Release response is malformed");
  }
  return value as GithubRelease;
}

function validateAsset(
  assets: readonly unknown[],
  expected: NativeTargetPolicy,
  label: string,
): VerifiedNativeTarget {
  const matching = assets.filter(
    (asset) =>
      asset &&
      typeof asset === "object" &&
      !Array.isArray(asset) &&
      (asset as GithubAsset).name === expected.asset,
  ) as GithubAsset[];

  if (matching.length !== 1) {
    throw new Error(
      `${label} must resolve to exactly one uploaded GitHub Release asset; found ${matching.length}`,
    );
  }

  const asset = matching[0];
  if (asset.state !== "uploaded") {
    throw new Error(`${label} asset state must be uploaded`);
  }
  if (
    typeof asset.digest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/i.test(asset.digest)
  ) {
    throw new Error(`${label} asset must expose a valid SHA-256 digest`);
  }

  return {
    asset: expected.asset,
    executable: expected.executable,
    sha256: asset.digest.slice("sha256:".length).toLowerCase(),
  };
}

async function loadReleaseSnapshot(
  repository: string,
  tag: string,
  fetchImpl: FetchLike,
): Promise<GithubReleaseSnapshot> {
  const repoRaw = await apiJson(repository, "", fetchImpl);
  if (
    !repoRaw ||
    typeof repoRaw !== "object" ||
    Array.isArray(repoRaw) ||
    (repoRaw as Record<string, unknown>).private !== false
  ) {
    throw new Error(
      `Native distribution repository ${repository} must be public`,
    );
  }

  const release = releaseObject(
    await apiJson(
      repository,
      `/releases/tags/${encodeURIComponent(tag)}`,
      fetchImpl,
    ),
  );

  if (release.tag_name !== tag) {
    throw new Error(
      `GitHub Release tag does not match expected ${tag}`,
    );
  }
  if (release.draft !== false || typeof release.published_at !== "string") {
    throw new Error(`GitHub Release ${tag} must be published`);
  }
  if (release.immutable !== true) {
    throw new Error(`GitHub Release ${tag} must be immutable`);
  }
  if (!Array.isArray(release.assets)) {
    throw new Error(`GitHub Release ${tag} assets are malformed`);
  }

  return {
    repository,
    tag,
    sourceCommit: await resolveTagCommit(repository, tag, fetchImpl),
    assets: release.assets,
  };
}

function materializeVerifiedRelease(
  snapshot: GithubReleaseSnapshot,
  version: string,
  sourceCommit: string,
  distribution: ValidatedNativeDistribution,
): VerifiedNativeRelease {
  if (snapshot.tag !== distribution.tag) {
    throw new Error(
      `Cached GitHub Release tag ${snapshot.tag} does not match expected ${distribution.tag}`,
    );
  }

  const expectedCommit = sourceCommit.toLowerCase();
  if (snapshot.sourceCommit !== expectedCommit) {
    throw new Error(
      `GitHub Release tag ${distribution.tag} resolves to ${snapshot.sourceCommit}, expected ${expectedCommit}`,
    );
  }

  const targets: Record<string, VerifiedNativeTarget> = {};
  for (const [target, targetPolicy] of Object.entries(
    distribution.targets,
  )) {
    targets[target] = validateAsset(
      snapshot.assets,
      targetPolicy,
      `${distribution.tag} ${target}`,
    );
  }

  return {
    repository: snapshot.repository,
    version,
    tag: snapshot.tag,
    targets,
  };
}

export class NativeReleaseResolver {
  readonly #fetchImpl: FetchLike;
  readonly #snapshotCache = new Map<string, Promise<GithubReleaseSnapshot>>();

  constructor(fetchImpl: FetchLike = fetch) {
    this.#fetchImpl = fetchImpl;
  }

  async resolve(
    repository: string,
    version: string,
    sourceCommit: string,
    distribution: ValidatedNativeDistribution,
  ): Promise<VerifiedNativeRelease> {
    const snapshot = await this.#snapshot(repository, distribution.tag);
    return materializeVerifiedRelease(
      snapshot,
      version,
      sourceCommit,
      distribution,
    );
  }

  async #snapshot(
    repository: string,
    tag: string,
  ): Promise<GithubReleaseSnapshot> {
    const key = `${repository}\0${tag}`;
    const existing = this.#snapshotCache.get(key);
    if (existing) {
      return existing;
    }

    const pending = loadReleaseSnapshot(
      repository,
      tag,
      this.#fetchImpl,
    );
    this.#snapshotCache.set(key, pending);

    try {
      return await pending;
    } catch (error) {
      if (this.#snapshotCache.get(key) === pending) {
        this.#snapshotCache.delete(key);
      }
      throw error;
    }
  }
}
