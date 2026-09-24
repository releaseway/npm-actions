import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import { loadConfig } from "./config/load.ts";
import {
  buildWorkspaceDependencyGraph,
  type WorkspaceDependencyGraph,
} from "./graph/dependencies.ts";
import { topologicalPublishOrder } from "./graph/topo.ts";
import { augmentNativeArtifact } from "./native/augment.ts";
import {
  NativeReleaseResolver,
  type VerifiedNativeRelease,
} from "./native/release.ts";
import {
  validateNativeDistribution,
  type ValidatedNativeDistribution,
} from "./native/validate.ts";
import {
  packAllPackages,
  resolvePackCommand,
} from "./pack/index.ts";
import {
  inspectPackedTarball,
  type PackedArtifact,
} from "./pack/inspect.ts";
import {
  assertTrustedPublishingEnvironment,
} from "./publish/environment.ts";
import {
  publishPackage,
  type PublishedState,
} from "./publish/index.ts";
import { derivePublishOptions } from "./publish/options.ts";
import {
  NpmRegistryClient,
  type RegistryReconciliation,
} from "./registry/client.ts";
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

export interface PackageResult {
  name: string;
  version: string;
  state: "published" | "staged" | "existing";
}

interface PreparedPackage {
  pkg: PublishablePackage;
  artifact: PackedArtifact;
  reconciliation: RegistryReconciliation;
}

export interface PreparedRelease {
  packages: PublishablePackage[];
  prepared: Map<string, PreparedPackage>;
  graph: WorkspaceDependencyGraph;
  existingOrder: string[];
  publishOrder: string[];
  toolchain: ReleasewayToolchain;
  runRoot: string;
}

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
  registryClient?: NpmRegistryClient;
  publish?: typeof publishPackage;
  validatePublishEnvironment?: typeof assertTrustedPublishingEnvironment;
}

function defaultRunRoot(context: OrchestrationContext): string {
  return resolve(context.env.RUNNER_TEMP ?? tmpdir());
}

async function launcherBundles(actionPath: string): Promise<{
  cjs: Buffer;
  esm: Buffer;
}> {
  const [cjs, esm] = await Promise.all([
    readFile(resolve(actionPath, "dist", "native-launcher.cjs")),
    readFile(resolve(actionPath, "dist", "native-launcher.mjs")),
  ]);
  if (cjs.byteLength === 0 || esm.byteLength === 0) {
    throw new Error("Releaseway native launcher bundles are missing or empty");
  }
  return { cjs, esm };
}

function rootManifest(
  discovered: readonly DiscoveredPackage[],
  workspace: string,
): DiscoveredPackage {
  const root = discovered.find(
    (pkg) => resolve(pkg.directory) === resolve(workspace),
  );
  if (!root) {
    throw new Error("Workspace discovery did not return the repository root package");
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

  const launchers = await launcherBundles(context.actionPath);
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
      launchers,
      { tempRoot: runRoot },
    );
    artifacts.set(pkg.name, await inspect(outputPath));
  }
}

function preflightPublishOptions(
  packages: readonly PublishablePackage[],
  artifacts: ReadonlyMap<string, PackedArtifact>,
  reconciliations: ReadonlyMap<string, RegistryReconciliation>,
): void {
  for (const pkg of packages) {
    const reconciliation = reconciliations.get(pkg.name);
    if (!reconciliation || reconciliation.state !== "candidate") {
      continue;
    }
    const artifact = artifacts.get(pkg.name);
    if (!artifact) {
      throw new Error(`Missing final artifact for ${pkg.name}`);
    }

    derivePublishOptions(
      artifact.manifest,
      pkg.version,
      reconciliation.latestVersion,
    );
  }
}

export async function prepareRelease(
  context: OrchestrationContext,
  dependencies: OrchestrationDependencies = {},
): Promise<PreparedRelease> {
  const verifySource = dependencies.verifySource ?? verifySourceIdentity;
  const loadRepositoryConfig =
    dependencies.loadRepositoryConfig ?? loadConfig;
  const discover = dependencies.discover ?? discoverWorkspace;
  const selectPackages =
    dependencies.selectPackages ?? selectPublishablePackages;
  const bootstrapToolchain =
    dependencies.bootstrapToolchain ?? bootstrapReleasewayToolchain;
  const packAll = dependencies.packAll ?? packAllPackages;
  const inspect = dependencies.inspect ?? inspectPackedTarball;
  const nativeResolver =
    dependencies.nativeResolver ?? new NativeReleaseResolver();
  const registryClient =
    dependencies.registryClient ??
    new NpmRegistryClient({
      readToken: context.env.NODE_AUTH_TOKEN,
    });
  const validatePublishEnvironment =
    dependencies.validatePublishEnvironment ??
    assertTrustedPublishingEnvironment;

  verifySource(context);

  const [config, discovered] = await Promise.all([
    loadRepositoryConfig(context.workspace),
    discover(context.workspace),
  ]);
  const packages = selectPackages(
    discovered,
    config,
    context.repository,
  );
  if (packages.length === 0) {
    throw new Error("No publishable npm packages were discovered");
  }

  const root = rootManifest(discovered, context.workspace);
  const runBase = defaultRunRoot(context);
  await mkdir(runBase, { recursive: true });
  const runRoot = await mkdtemp(
    join(runBase, "releaseway-npm-actions-run-"),
  );

  try {
    const toolchain = await bootstrapToolchain({
      rootBase: runRoot,
    });
    const command = await resolvePackCommand(
      { packageManager: root.manifest.packageManager },
      toolchain,
      context.workspace,
      packageOperationEnvironment(context.env),
    );
    const packed = await packAll(
      context.workspace,
      packages,
      command,
      join(runRoot, "packed"),
    );
    const artifacts = artifactMap(packages, packed);

    await applyNativeAugmentation(
      context,
      packages,
      artifacts,
      runRoot,
      inspect,
      nativeResolver,
    );

    const graph = buildWorkspaceDependencyGraph(packages, artifacts);
    const reconciliations = new Map<string, RegistryReconciliation>();

    for (const pkg of packages) {
      const artifact = artifacts.get(pkg.name);
      if (!artifact) {
        throw new Error(`Missing final artifact for ${pkg.name}`);
      }
      reconciliations.set(
        pkg.name,
        await registryClient.reconcile(
          pkg.name,
          pkg.version,
          artifact.tarballPath,
        ),
      );
    }

    preflightPublishOptions(packages, artifacts, reconciliations);

    const candidates = new Set(
      packages
        .filter(
          (pkg) =>
            reconciliations.get(pkg.name)?.state === "candidate",
        )
        .map((pkg) => pkg.name),
    );
    const existingOrder = packages
      .filter(
        (pkg) =>
          reconciliations.get(pkg.name)?.state === "existing",
      )
      .map((pkg) => pkg.name)
      .sort();

    const publishOrder = topologicalPublishOrder(graph, candidates);
    if (publishOrder.length > 0) {
      validatePublishEnvironment(context.env);
    }

    const prepared = new Map<string, PreparedPackage>();
    for (const pkg of packages) {
      const artifact = artifacts.get(pkg.name);
      const reconciliation = reconciliations.get(pkg.name);
      if (!artifact || !reconciliation) {
        throw new Error(`Incomplete preflight state for ${pkg.name}`);
      }
      prepared.set(pkg.name, { pkg, artifact, reconciliation });
    }

    return {
      packages,
      prepared,
      graph,
      existingOrder,
      publishOrder,
      toolchain,
      runRoot,
    };
  } catch (error) {
    await rm(runRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function executePreparedRelease(
  context: OrchestrationContext,
  prepared: PreparedRelease,
  dependencies: OrchestrationDependencies = {},
): Promise<PackageResult[]> {
  const publisher = dependencies.publish ?? publishPackage;
  const results: PackageResult[] = [];

  for (const name of prepared.existingOrder) {
    const entry = prepared.prepared.get(name);
    if (!entry || entry.reconciliation.state !== "existing") {
      throw new Error(`Invalid existing preflight state for ${name}`);
    }
    results.push({
      name: entry.pkg.name,
      version: entry.pkg.version,
      state: "existing",
    });
  }

  const completed: PackageResult[] = [];
  for (const name of prepared.publishOrder) {
    const entry = prepared.prepared.get(name);
    if (!entry || entry.reconciliation.state !== "candidate") {
      throw new Error(`Invalid candidate preflight state for ${name}`);
    }

    try {
      const state: PublishedState = await publisher(
        prepared.toolchain,
        {
          mode: entry.pkg.publishMode,
          name: entry.pkg.name,
          version: entry.pkg.version,
          tarballPath: entry.artifact.tarballPath,
          manifest: entry.artifact.manifest,
          latestVersion: entry.reconciliation.latestVersion,
        },
        {
          env: context.env,
          tempRoot: prepared.runRoot,
        },
      );

      const result: PackageResult = {
        name: entry.pkg.name,
        version: entry.pkg.version,
        state,
      };
      completed.push(result);
      results.push(result);
    } catch (error) {
      const completedSummary =
        completed.length === 0
          ? "none"
          : completed
              .map(
                (item) =>
                  `${item.name}@${item.version}(${item.state})`,
              )
              .join(", ");
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Publication failed for ${entry.pkg.name}@${entry.pkg.version}; completed before failure: ${completedSummary}; cause: ${message}`,
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
    return await executePreparedRelease(
      context,
      prepared,
      dependencies,
    );
  } finally {
    await rm(prepared.runRoot, { recursive: true, force: true });
  }
}
