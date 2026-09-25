# Registry-first publication implementation

This document maps the canonical DESIGN.md contract to implementation and validation boundaries.

## Data flow

Discover identities → read registry snapshots → classify already-public versions and candidates → pack candidates → augment native candidates → freeze artifacts/options → plan dependency availability → execute verified artifacts.

## Registry reads and artifact checks

src/registry/client.ts owns RegistryReader, RegistryPackageSnapshot and RegistryVersionLookup. lookupVersion(name, version) validates public metadata without requiring a tarball. verifyPublishedArtifact(name, version, expectedIntegrity) refetches live state and performs the prepared-artifact SHA-512 check. Public absence is not proof that a version is unreserved. Package-level 404 remains a bootstrap error.

Registry snapshots are copied and frozen. Read requests have a 30-second timeout and accept a caller deadline signal. HTTP and metadata errors propagate; they are never normalized to absence. src/registry/integrity.ts streams local files and retains exact SHA-512 SRI comparison.

## Preparation and immutable plan

src/orchestrate.ts has distinct noop and ready PreparedRelease variants. Noop contains already-published results and has no toolchain/run directory. Ready contains a bound source identity, immutable ordered publications, the provisioned toolchain and owned run directory.

prepareRelease classifies the entire workspace first. Only candidates reach resolvePackCommand, packAllPackages and applyNativeAugmentation. Final identity, repository, publish policy and SHA-512 are validated before freezing the plan. src/immutable.ts owns copied JSON freezing so pack adapter objects cannot mutate prepared metadata after the fact.

The plan records derived tag/access options rather than recalculating them in the publisher. The normal default tag is frozen as latest. All deterministic candidate validation and dependency planning complete before executePreparedRelease can mutate npm.

## Dependency graph

src/graph/dependencies.ts resolves npm package specs through npm-package-arg. Alias install names never stand in for the actual registry identity. For a managed SemVer range, choose a satisfying registry version first, then a compatible candidate. Required direct dependencies reject staged-only resolutions. Optional declarations override duplicate dependency keys; peer validation remains range-only.

The candidate graph carries exact selected dependency versions and live/candidate provenance. src/graph/topo.ts orders candidate edges deterministically and rejects unresolved cycles. Published local manifests are not evaluated. The executor rechecks required selected live identities immediately before direct writes.

## Publication

src/publish/index.ts accepts a prepared PublishRequest with expected integrity and fixed publishOptions. It checks tarball integrity, creates an isolated publisher context and invokes the pinned npm CLI with the exact tarball and disabled lifecycle scripts. Successful submissions return direct-accepted or staged. Nonzero subprocess status is PublishCommandError; scan-pending text never becomes an acceptance result by itself.

executePreparedRelease checks every prepared file before the first write. Candidate races and post-error recovery use verifyPublishedArtifact. Direct scan-pending conflicts may be observed until the live deadline; unresolved stage conflicts propagate without approval or mode conversion. waitForDirectLive checks the overall deadline before accepting even a late matching response and reuses the frozen expected digest.

Package output states are already-published, published and staged. Published means the planned artifact was confirmed live, including an identical concurrent writer. The already-published result deliberately makes no source-equivalence assertion.

## Tests and ownership

The registry, graph, publisher and orchestration tests verify both successful and failing transitions. Existing native/runtime/install tests continue to cover the unchanged installed runtime. Documentation tests guard the current contract and examples. Rebuild dist/main.js after source or dependency changes and verify it matches a fresh build.

Required local checks are npm test, npm run typecheck, npm run verify:dist, npm run verify:toolchain, npm run verify:pack, npm run verify:yarn-corepack, npm run verify:native-runtime and npm run verify:native-install. A passed local suite does not assert real OIDC publication or cross-platform execution in an unavailable environment.

The separate fixture should be pinned to the commit that ships this implementation before running live verification. Its rerun assertions use already-published. Do not publish packages, change remote tags or dispatch the fixture merely to run local implementation tests.
