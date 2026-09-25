import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import { loadConfig } from "./config/load.ts";
import {
  buildWorkspaceDependencyGraph,
  type DependencyRequirement,
} from "./graph/dependencies.ts";
import { topologicalPublishOrder } from "./graph/topo.ts";
import { immutableJson } from "./immutable.ts";
import { augmentNativeArtifact } from "./native/augment.ts";
import {
  NativeReleaseResolver,
  type VerifiedNativeRelease,
} from "./native/release.ts";
import {
  validateNativeDistribution,
  type ValidatedNativeDistribution,
} from "./native/validate.ts";
import { packAllPackages, resolvePackCommand } from "./pack/index.ts";
import { inspectPackedTarball, type PackedArtifact } from "./pack/inspect.ts";
import { assertTrustedPublishingEnvironment } from "./publish/environment.ts";
import {
  publishPackage,
  assertPreparedTarball,
  PublishCommandError,
  isPendingRegistryScanConflict,
  type PublishRequest,
} from "./publish/index.ts";
import { derivePublishOptions } from "./publish/options.ts";
import {
  NpmRegistryClient,
  type RegistryReader,
  type RegistryPackageSnapshot,
} from "./registry/client.ts";
import { sha512Integrity } from "./registry/integrity.ts";
import {
  bootstrapReleasewayToolchain,
  type ReleasewayToolchain,
} from "./toolchain/bootstrap.ts";
import { packageOperationEnvironment } from "./toolchain/environment.ts";
import {
  discoverWorkspace,
  selectPublishablePackages,
  type DiscoveredPackage,
  type PublishablePackage,
} from "./workspace/discover.ts";
import {
  type GithubContext,
  verifySourceIdentity,
} from "./workspace/identity.ts";
import {
  parseGitHubRepository,
  repositoryFullName,
} from "./workspace/repository.ts";

export interface PackageResult {
  readonly name: string;
  readonly version: string;
  readonly state: "already-published" | "published" | "staged";
}
export interface PlannedPublication {
  readonly request: PublishRequest;
  readonly manifest: PackedArtifact["manifest"];
  readonly requirements: readonly DependencyRequirement[];
}
interface ReleaseBase {
  readonly alreadyPublished: readonly PackageResult[];
}
export type PreparedRelease =
  | (ReleaseBase & { readonly kind: "noop" })
  | (ReleaseBase & {
      readonly kind: "ready";
      readonly source: GithubContext;
      readonly publications: readonly PlannedPublication[];
      readonly toolchain: ReleasewayToolchain;
      readonly registryClient: RegistryReader;
      readonly runRoot: string;
    });
export interface OrchestrationContext extends GithubContext {
  actionPath: string;
  env: NodeJS.ProcessEnv;
}
export interface OrchestrationDependencies {
  verifySource?: typeof verifySourceIdentity;
  loadRepositoryConfig?: typeof loadConfig;
  discover?: typeof discoverWorkspace;
  selectPackages?: typeof selectPublishablePackages;
  bootstrapToolchain?: typeof bootstrapReleasewayToolchain;
  packAll?: typeof packAllPackages;
  inspect?: typeof inspectPackedTarball;
  nativeResolver?: NativeReleaseResolver;
  registryClient?: RegistryReader;
  publish?: typeof publishPackage;
  waitForDirectLive?: typeof waitForDirectLive;
  validatePublishEnvironment?: typeof assertTrustedPublishingEnvironment;
}

/** Poll only registry bytes; the expected digest was fixed before any mutation. */
export async function waitForDirectLive(
  registry: RegistryReader,
  name: string,
  version: string,
  expectedIntegrity: string,
  options: {
    pollMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<void> {
  const pollMs = options.pollMs ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 20 * 60_000;
  if (
    !Number.isFinite(pollMs) ||
    pollMs <= 0 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0
  )
    throw new Error("Registry polling budgets must be positive finite numbers");
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = now();
  const expired = () =>
    new Error(
      name +
        "@" +
        version +
        " is not verified live within the visibility budget; publish-time scanning or a pending stage may require maintainer review",
    );
  while (true) {
    const remaining = timeoutMs - (now() - started);
    if (remaining <= 0) throw expired();
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(remaining)));
    const result = await registry.verifyPublishedArtifact(
      name,
      version,
      expectedIntegrity,
      { signal },
    );
    if (now() - started >= timeoutMs) throw expired();
    if (result === "matched") return;
    await sleep(Math.min(pollMs, timeoutMs - (now() - started)));
  }
}

async function nativeRuntimeBundle(actionPath: string): Promise<{
  runtime: Buffer;
}> {
  const runtime = await readFile(
    resolve(actionPath, "dist", "native-runtime.cjs"),
  );
  if (runtime.byteLength === 0) {
    throw new Error("Releaseway native runtime bundle is missing or empty");
  }
  return { runtime };
}

function rootManifest(
  discovered: readonly DiscoveredPackage[],
  workspace: string,
): DiscoveredPackage {
  const root = discovered.find(
    (pkg) => resolve(pkg.directory) === resolve(workspace),
  );
  if (!root) {
    throw new Error(
      "Workspace discovery did not return the repository root package",
    );
  }
  return root;
}

function artifactMap(
  packages: readonly PublishablePackage[],
  artifacts: readonly PackedArtifact[],
): Map<string, PackedArtifact> {
  if (packages.length !== artifacts.length) {
    throw new Error(
      `Packed artifact count mismatch: expected ${packages.length}, got ${artifacts.length}`,
    );
  }

  return new Map(
    packages.map((pkg, index) => {
      const artifact = artifacts[index];
      if (!artifact) {
        throw new Error(`Missing packed artifact for ${pkg.name}`);
      }
      return [pkg.name, artifact] as const;
    }),
  );
}

async function applyNativeAugmentation(
  context: OrchestrationContext,
  packages: readonly PublishablePackage[],
  artifacts: Map<string, PackedArtifact>,
  runRoot: string,
  inspect: typeof inspectPackedTarball,
  resolver: NativeReleaseResolver,
): Promise<void> {
  const nativePackages = packages.filter((pkg) => pkg.policy?.distribution);
  if (nativePackages.length === 0) {
    return;
  }

  const runtimeBundle = await nativeRuntimeBundle(context.actionPath);
  const outputRoot = join(runRoot, "final-native");
  await mkdir(outputRoot, { recursive: true });

  for (const pkg of nativePackages) {
    const artifact = artifacts.get(pkg.name);
    if (!artifact) {
      throw new Error(`Missing packed artifact for native package ${pkg.name}`);
    }

    const distribution: ValidatedNativeDistribution =
      validateNativeDistribution(pkg, artifact);
    const release: VerifiedNativeRelease = await resolver.resolve(
      context.repository,
      pkg.version,
      context.sha,
      distribution,
    );
    const outputPath = join(
      outputRoot,
      encodeURIComponent(pkg.name) + "-" + pkg.version + ".tgz",
    );

    await augmentNativeArtifact(
      pkg,
      artifact,
      distribution,
      release,
      outputPath,
      runtimeBundle,
      { tempRoot: runRoot },
    );
    artifacts.set(pkg.name, await inspect(outputPath));
  }
}

export async function prepareRelease(
  context: OrchestrationContext,
  dependencies: OrchestrationDependencies = {},
): Promise<PreparedRelease> {
  (dependencies.verifySource ?? verifySourceIdentity)(context);
  const [config, discovered] = await Promise.all([
    (dependencies.loadRepositoryConfig ?? loadConfig)(context.workspace),
    (dependencies.discover ?? discoverWorkspace)(context.workspace),
  ]);
  const packages = immutableJson(
    (dependencies.selectPackages ?? selectPublishablePackages)(
      discovered,
      config,
      context.repository,
    ),
  );
  if (packages.length === 0)
    throw new Error("No publishable npm packages were discovered");
  const registry =
    dependencies.registryClient ??
    new NpmRegistryClient({ readToken: context.env.NODE_AUTH_TOKEN });
  const snapshots = new Map<string, RegistryPackageSnapshot>();
  const candidates: PublishablePackage[] = [];
  const alreadyPublished: PackageResult[] = [];
  // Classification must finish for the complete workspace before any package-manager work.
  for (const pkg of packages) {
    const lookup = await registry.lookupVersion(pkg.name, pkg.version);
    snapshots.set(pkg.name, lookup.snapshot);
    if (lookup.state === "already-published")
      alreadyPublished.push({
        name: pkg.name,
        version: pkg.version,
        state: "already-published",
      });
    else candidates.push(pkg);
  }
  const skipped = immutableJson(
    alreadyPublished.sort((a, b) => a.name.localeCompare(b.name)),
  );
  if (candidates.length === 0)
    return Object.freeze({ kind: "noop", alreadyPublished: skipped });
  (
    dependencies.validatePublishEnvironment ??
    assertTrustedPublishingEnvironment
  )(context.env);
  const root = rootManifest(discovered, context.workspace);
  const base = resolve(context.env.RUNNER_TEMP ?? tmpdir());
  await mkdir(base, { recursive: true });
  const runRoot = await mkdtemp(join(base, "releaseway-npm-actions-run-"));
  try {
    const toolchain = await (
      dependencies.bootstrapToolchain ?? bootstrapReleasewayToolchain
    )({ rootBase: runRoot });
    const command = await resolvePackCommand(
      { packageManager: root.manifest.packageManager },
      toolchain,
      context.workspace,
      packageOperationEnvironment(context.env),
    );
    const packed = await (dependencies.packAll ?? packAllPackages)(
      context.workspace,
      candidates,
      command,
      join(runRoot, "packed"),
    );
    const artifacts = artifactMap(candidates, packed);
    await applyNativeAugmentation(
      context,
      candidates,
      artifacts,
      runRoot,
      dependencies.inspect ?? inspectPackedTarball,
      dependencies.nativeResolver ?? new NativeReleaseResolver(),
    );
    const requests = new Map<string, PublishRequest>();
    for (const pkg of candidates) {
      const artifact = artifacts.get(pkg.name)!;
      if (
        artifact.manifest.name !== pkg.name ||
        artifact.manifest.version !== pkg.version ||
        artifact.manifest.private === true
      )
        throw new Error(
          "Final packed identity is not publishable: " +
            pkg.name +
            "@" +
            pkg.version,
        );
      if (
        repositoryFullName(
          parseGitHubRepository(artifact.manifest.repository),
        ).toLowerCase() !== context.repository.toLowerCase()
      )
        throw new Error(
          "Final packed repository does not match source for " + pkg.name,
        );
      const publishOptions = derivePublishOptions(
        artifact.manifest,
        pkg.version,
        snapshots.get(pkg.name)!.latestVersion,
      );
      requests.set(
        pkg.name,
        immutableJson({
          name: pkg.name,
          version: pkg.version,
          mode: pkg.publishMode,
          tarballPath: resolve(artifact.tarballPath),
          integrity: await sha512Integrity(artifact.tarballPath),
          publishOptions: {
            ...publishOptions,
            tag: publishOptions.tag ?? "latest",
          },
        }),
      );
    }
    const graph = buildWorkspaceDependencyGraph(packages, artifacts, snapshots);
    const order = topologicalPublishOrder(
      graph,
      new Set(candidates.map((pkg) => pkg.name)),
    );
    const publications = immutableJson(
      order.map((name) => ({
        request: requests.get(name)!,
        manifest: artifacts.get(name)!.manifest,
        requirements: graph.requirements.get(name)!,
      })),
    );
    return Object.freeze({
      kind: "ready",
      alreadyPublished: skipped,
      publications,
      source: immutableJson({
        repository: context.repository,
        sha: context.sha,
        workspace: context.workspace,
      }),
      toolchain: Object.freeze({ ...toolchain }),
      registryClient: registry,
      runRoot,
    });
  } catch (error) {
    await rm(runRoot, { recursive: true, force: true });
    throw error;
  }
}

async function assertDirectDependenciesLive(
  registry: RegistryReader,
  publication: PlannedPublication,
): Promise<void> {
  if (publication.request.mode !== "direct") return;
  for (const dependency of publication.requirements) {
    if (dependency.field !== "dependencies") continue;
    const lookup = await registry.lookupVersion(
      dependency.name,
      dependency.version,
    );
    if (lookup.state !== "already-published")
      throw new Error(
        publication.request.name +
          " required dependency is no longer live: " +
          dependency.name +
          "@" +
          dependency.version,
      );
  }
}

export async function executePreparedRelease(
  context: OrchestrationContext,
  prepared: PreparedRelease,
  dependencies: OrchestrationDependencies = {},
): Promise<PackageResult[]> {
  const results: PackageResult[] = [...prepared.alreadyPublished];
  if (prepared.kind === "noop") return results;
  if (
    context.repository !== prepared.source.repository ||
    context.sha !== prepared.source.sha ||
    resolve(context.workspace) !== resolve(prepared.source.workspace)
  )
    throw new Error("Prepared release source context changed");
  const registry = prepared.registryClient;
  const publisher = dependencies.publish ?? publishPackage;
  const waitForLive = dependencies.waitForDirectLive ?? waitForDirectLive;
  // Detect alteration of any prepared artifact before the first registry mutation.
  for (const publication of prepared.publications)
    await assertPreparedTarball(publication.request);
  const completed: PackageResult[] = [];
  for (const publication of prepared.publications) {
    const request = publication.request;
    try {
      await assertPreparedTarball(request);
      let state: PackageResult["state"];
      if (
        (await registry.verifyPublishedArtifact(
          request.name,
          request.version,
          request.integrity,
        )) === "matched"
      ) {
        state = "published";
      } else {
        await assertDirectDependenciesLive(registry, publication);
        let submitted;
        try {
          submitted = await publisher(prepared.toolchain, request, {
            env: context.env,
            tempRoot: prepared.runRoot,
          });
        } catch (error) {
          // The request may have succeeded remotely before its local failure. Read, never retry the write.
          if (
            (await registry.verifyPublishedArtifact(
              request.name,
              request.version,
              request.integrity,
            )) === "matched"
          ) {
            submitted = "verified-live" as const;
          } else if (
            request.mode === "direct" &&
            error instanceof PublishCommandError &&
            isPendingRegistryScanConflict(error.output)
          ) {
            await waitForLive(
              registry,
              request.name,
              request.version,
              request.integrity,
            );
            submitted = "verified-live" as const;
          } else {
            throw error;
          }
        }
        if (submitted === "direct-accepted") {
          await waitForLive(
            registry,
            request.name,
            request.version,
            request.integrity,
          );
          state = "published";
        } else if (submitted === "verified-live") state = "published";
        else if (submitted === "staged") state = "staged";
        else throw new Error("Unknown publication result");
      }
      const result: PackageResult = {
        name: request.name,
        version: request.version,
        state,
      };
      completed.push(result);
      results.push(result);
    } catch (error) {
      const summary =
        completed
          .map(
            (item) => item.name + "@" + item.version + "(" + item.state + ")",
          )
          .join(", ") || "none";
      throw new Error(
        "Publication failed for " +
          request.name +
          "@" +
          request.version +
          "; completed before failure: " +
          summary +
          "; cause: " +
          (error instanceof Error ? error.message : String(error)),
        { cause: error },
      );
    }
  }
  return results;
}

export async function runRelease(
  context: OrchestrationContext,
  dependencies: OrchestrationDependencies = {},
): Promise<PackageResult[]> {
  const prepared = await prepareRelease(context, dependencies);
  try {
    return await executePreparedRelease(context, prepared, dependencies);
  } finally {
    if (prepared.kind === "ready")
      await rm(prepared.runRoot, { recursive: true, force: true });
  }
}
