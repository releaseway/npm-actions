# releaseway/npm-actions — Design

Status: canonical registry-first design
Updated: 2026-09-25

## 1. Purpose and responsibility

The action publishes new npm versions from a caller-controlled GitHub Actions workflow. Version selection, version bumps, change validation, release triggers and product builds belong to the caller. npm-actions owns registry classification, candidate artifacts, publication planning and submission verification.

The registry is authoritative for public version presence. A local artifact is authoritative for the exact bytes of a prepared candidate. These authorities apply at different phases and must remain separate.

## 2. Public interface

The root JavaScript action runs on GitHub's Node 24 action runtime and has no functional inputs. It reads the checkout at GITHUB_WORKSPACE and the fixed optional configuration .github/npm/packages.yml. npm metadata remains in package.json; schema 1 repository policy defines direct/stage mode and explicit native distribution overrides.

The sole output, packages, is a JSON array of name, version and state. States are:

| State             | Meaning                                                                                                       |
| ----------------- | ------------------------------------------------------------------------------------------------------------- |
| already-published | The exact version was public during initial classification. Current source equivalence is not asserted.       |
| published         | A prepared candidate is confirmed live with the exact frozen SHA-512, including a matching concurrent writer. |
| staged            | The submission succeeded through npm stage publish; public availability is not asserted.                      |

Initially public results are ordered by name, followed by candidate results in publication-plan order. No successful output is written for a failed run. There is one contract, with no historical equality mode or compatibility state alias.

## 3. Discovery and source identity

Discover the root and workspace packages through package.json workspaces or pnpm-workspace.yaml. Exclude private:true packages. Reject duplicate names, stale config selectors, missing identities, invalid registry configuration and repository metadata that does not identify the calling repository.

Checkout HEAD must equal GITHUB_SHA and origin must identify GITHUB_REPOSITORY. Build steps precede the action. Source validation binds this execution; it does not require previously published native assets to use this execution's commit.

## 4. Registry-first classification

Read all selected exact name@version identities before toolchain provisioning, pack or native resolution. Validate registry package and version identity and metadata shape. A registry request failure, unavailable authentication, malformed response or package-level 404 never becomes an absent-version inference. Package bootstrap and Trusted Publisher setup remain prerequisites.

An initially public version is terminal read-only work for this run. Do not pack it, regenerate its native runtime, resolve its old Release, compare it against local files, or mutate its dist-tags or access. An all-public workspace requires no publication authority or temporary toolchain.

A version absent from public metadata becomes a candidate, not a claim that its version number is unreserved. Pending stages may reserve an otherwise invisible version.

Changing local source without a new version is outside the action's change-detection contract. A workflow rerun classifies public versions afresh; it is not a historical build reproduction check.

## 5. Candidate preparation

Provision the pinned npm and userland Corepack toolchain only when candidates exist. Use the root packageManager declaration for candidate packing; retain package-manager-native transforms and verify the exact reported version. A simple npm project may use the action's pinned npm. Do not install or build the product on the caller's behalf.

Pack candidates only, with output in the private run directory. Check source state after each pack operation. Final packed identity and repository must agree with the validated candidate. Derive publication options from the final packed manifest before execution; prereleases and versions below latest require an explicit tag.

For each candidate, freeze its name, version, mode, final tarball path, SHA-512, final manifest, publication tag/access and managed dependency requirements. Copy JSON metadata before freezing it. The prepared plan has no mutable source-manifest dependency. All candidates must pass preparation before any registry mutation.

## 6. Native distribution

Native distribution is explicit, scoped to the caller's public GitHub repository, and retains one npm package and one bin command. A new candidate references a published immutable Release whose tag resolves to the current GITHUB_SHA. Validate unique uploaded assets and valid SHA-256 digests. Apply package-specific target mapping on every resolver call; cache only shared Release snapshots.

The candidate tarball reserves its bin path and .releaseway/native.json plus .releaseway/runtime.cjs for generated content. Thin CJS/ESM wrappers resolve their installed real paths and pass the exact manifest path to the common CJS runtime. Candidate repacking is deterministic; ordinary tarballs remain package-manager-produced.

Supported targets are darwin-arm64, darwin-x64, linux-arm64-gnu, linux-x64-gnu, linux-arm64-musl, linux-x64-musl, win32-arm64 and win32-x64. Configurations name exact .tar.gz or .zip assets and archive-relative executables. No platform package generation or postinstall downloader is introduced.

At runtime select the exact OS/architecture/libc target, verify the complete archive digest, safely extract only the configured regular executable, and execute with inherited arguments and stdio. Reject unsafe paths, links, unsupported entries, duplicate entries and digest mismatches. Retain the versioned native/v2/sha256 cache: archive digest identifies archive files; normalized executable path identifies independent executable entries. Cache hits validate both digests. Runtime cache policy is unchanged by this publication redesign.

## 7. Dependency availability plan

Build the graph from final candidate manifests. Initially public packages contribute registry version manifests, not current local dependency declarations. The managed set is the discovered publishable package set. Resolve npm aliases using npm package-spec parsing to distinguish install name, target package and SemVer range.

For each managed dependency, choose the highest satisfying live version first. If none is available, the corresponding candidate must satisfy the range. Reject unsupported managed mutable tags or unresolved local protocols rather than inventing a registry target. External dependency deployment and transitive application correctness remain outside the managed graph's guarantee.

Required dependencies and optionalDependencies impose candidate ordering edges only when no live resolution exists. Optional declarations override duplicate install names in dependencies. Peer ranges are checked without ordering edges; devDependencies are ignored. A live resolution can eliminate a candidate cycle; remaining hard cycles fail before publication.

A direct candidate's required internal dependencies must have a live resolution or a preceding direct candidate. A staged candidate cannot unlock required direct publication. Optional dependencies retain ordering without the required live gate; peers retain range-only behavior. A staged consumer may refer to a staged candidate without claiming installability before maintainer approval.

Before each actual direct mutation, recheck the exact selected required versions are still live. The registry is not transactional: later unpublishing and external changes remain possible. Complete preflight prevents deterministic plan errors from causing partial writes; runtime failures still require rerun handling.

## 8. Execution and exact artifact verification

Check all prepared tarball digests before the first mutation, then check the relevant candidate again before submission. Publish the same frozen artifact and options with lifecycle scripts disabled. Never rebuild artifacts during execution or polling.

Immediately before a candidate mutation, check whether it became public. Matching live SHA-512 satisfies that planned candidate; missing, invalid, weaker-only or mismatching integrity fails. Initial public classification deliberately does not require this comparison.

A successful direct subprocess means accepted for processing. Report published only after live metadata exposes the expected identity and frozen SHA-512. Poll using the expected digest, a bounded overall deadline and bounded individual read requests. Stage success reports staged and never releases a direct required dependency gate.

After a failed subprocess, perform a read-only exact-artifact check. A matching live artifact resolves a lost response or concurrent submission. A direct scan-pending conflict may enter bounded live observation, but the conflict itself does not prove acceptance. Other unresolved failures propagate; no write is blindly repeated and no pending stage is approved, inspected, rejected or converted automatically.

## 9. Authentication and security boundaries

Publication uses npm Trusted Publishing OIDC only, on a supported GitHub-hosted runner. Keep the public registry fixed to https://registry.npmjs.org/. Read-only NODE_AUTH_TOKEN may be used for registry metadata and dependency reads; it never becomes publication authority.

Package-manager operations do not receive publish OIDC or publish-token environment. Publication executes outside the checkout using isolated home and npm configuration with token-bearing settings removed. Reject publish-time credentials in the candidate manifest. Already-public no-op runs need no OIDC validation.

The final tarball, manifest and options remain tied to one plan. Runtime metadata and package identities are checked at the relevant trust boundaries. Hashing streams local files; registry verification never reads local files.

## 10. Recovery and observable results

A partial failure reports the candidate that failed and candidates completed beforehand. The cleanup boundary always removes owned temporary state. It does not remove user source, mutate remote staged state or automatically choose a new version.

A whole-workflow rerun prepares a new plan. Versions that became public are already-published, even if the caller changed its toolchain. Remaining candidates are prepared again and verified within their new execution. New runtime fixes require new native npm versions.

Pending-stage equality is not asserted through OIDC. Approval and rejection remain maintainer actions. No-op is a version-presence result; published is an exact planned-artifact result; staged is a submission result.

## 11. Validation contract

Tests must cover all-public no-op without OIDC or native assets; mixed native and ordinary workspaces; candidate-only pack; errors before mutation; alias ranges and cycles; live fallback versus staged-only dependencies; immutable plan metadata; modified tarballs; same and different concurrent artifacts; lost responses; strict visibility deadlines; and whole-workflow reruns.

Local integration tests cover manager-native packing and final installed wrappers. The separate npm-actions-fixture repository covers actual OIDC publication, immutable Release assets and installed first-run/cache-hit behavior. Local tests must not mutate the real registry. Fixture assertions must use this action revision's output contract.
