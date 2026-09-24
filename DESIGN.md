# releaseway/npm-actions — Design

Status: canonical design baseline
Updated: 2026-09-24

## 1. Purpose

`releaseway/npm-actions` is a GitHub Action for publishing npm packages through one release engine.

It supports ordinary JavaScript/TypeScript packages, Node CLIs, and packages that distribute native executables. Native distribution is an optional capability of the same publish engine, not a separate product or workflow.

Version selection, version bumping, changelog policy, and product build ordering remain caller responsibilities.

## 2. Sources of truth

npm-native package metadata remains in `package.json`.

Releaseway does not duplicate fields that npm already owns, including:

- `name`
- `version`
- `bin`
- `files`
- `exports`
- `publishConfig`
- dependency declarations

Releaseway-specific persistent policy belongs in one repository-level config file:

```text
.github/npm/packages.yml
```

The config augments `package.json`; it does not replace it.

Ordinary npm packages do not need an entry in the config. An entry is required only when a package uses Releaseway-specific policy such as native GitHub Release distribution or a package-level publish-mode override.

## 3. Repository config

The config is repository-scoped and package overrides are keyed by npm package name, not filesystem path.

Package-name keys are selectors for applying Releaseway policy. They are not a second declaration of package identity.

A package that is absent from `packages.yml` is still publishable.

Baseline shape:

```yaml
schema: 1

publish:
  mode: direct

packages:
  "@scope/cli":
    publish:
      mode: stage

    distribution:
      type: github-release
      tag: "v{version}"

      targets:
        darwin-arm64:
          asset: cli_darwin_arm64.tar.gz
          executable: cli
        darwin-x64:
          asset: cli_darwin_x64.tar.gz
          executable: cli
        linux-arm64-gnu:
          asset: cli_linux_arm64.tar.gz
          executable: cli
        linux-x64-gnu:
          asset: cli_linux_x64.tar.gz
          executable: cli
        win32-x64:
          asset: cli_windows_x64.zip
          executable: cli.exe
```

Moving a package directory does not require changing its config key. Renaming the npm package does, because the npm identity changed.

## 4. Workspace discovery

Releaseway consumes package-manager-native workspace metadata instead of defining a second package glob system.

Workspace discovery uses the repository's existing package-manager metadata, including root `package.json` workspace metadata where applicable and `pnpm-workspace.yaml` for pnpm workspaces.

The repository root package is part of the discovered package set when it is itself publishable.

Packages with `private: true` are excluded from publication.

The resulting package set is determined from package manifests and workspace metadata, not Git diff, commit range, or changeset presence.

## 5. Publication selection

Publication is registry-reconciliation based.

For each publishable package, `package.json.name` and `package.json.version` define the intended npm identity.

For each `name@version`:

```text
registry version absent
  -> publication candidate

registry version present
  -> compare exact package artifact
       identical -> existing / no-op
       different -> fail closed
```

### 5.1 Exact artifact equality

Registry reconciliation uses the immutable tarball bytes as the equality contract.

Releaseway computes an SRI SHA-512 digest over the exact `.tgz` artifact that it would publish and compares it with the existing version's npm registry `dist.integrity`.

An existing version is accepted only when `dist.integrity` contains a valid SHA-512 value that exactly matches the local artifact. A missing, unparsable, weaker-only, or different remote integrity value fails closed.

Releaseway does not download and heuristically compare unpacked package contents when the registry integrity is available.

### 5.2 Mutable registry state

Dist-tags are not part of immutable `name@version` equality.

For a new publication, Releaseway honors `publishConfig.tag` when declared and otherwise uses npm's normal default tag behavior. It does not invent a tag for prerelease or non-latest versions.

After a version already exists, npm-actions does not add, move, or reconcile dist-tags. A later change to `latest`, `next`, or another tag therefore does not make an old exact version fail reconciliation.

Remote mutable package-level state, including the package's current access setting, is not separately reconciled when deciding whether an existing immutable version is the same artifact. Changes inside the packed `package.json` still change the tarball integrity and therefore fail exact-artifact reconciliation.

A rerun after a partial failure verifies already-published packages and continues with only the remaining candidates.

Version bumping and deciding which version should exist are outside npm-actions.

## 6. Package manager and pack boundary

Packaging semantics belong to the project's package manager.

The publication pipeline is:

```text
project package manager
        |
        v
       pack
        |
        v
package-manager-produced tarball
        |
        +-- ordinary package -> unchanged
        |
        +-- native distribution
        |      -> deterministic Releaseway launcher/manifest augmentation
        |
        v
exact final .tgz artifact
        |
        v
Releaseway inspection and reconciliation
        |
        v
Releaseway-controlled npm publication
```

The expected pack commands are conceptually:

```text
npm project  -> npm pack
pnpm project -> pnpm pack
Yarn project -> yarn pack
```

This preserves package-manager-specific publication transforms such as workspace dependency rewriting.

The registry mutation step remains under Releaseway control and uses npm publication commands against the verified tarball rather than delegating the whole release lifecycle to the project package manager.

If the repository-root `package.json.packageManager` is present, it is authoritative for selecting the package manager and version used for packing.

For pnpm or Yarn projects, `packageManager` is required and must identify an exact version. Tags and version ranges are not accepted because they do not define a reproducible pack toolchain. A Corepack integrity suffix may be present.

A simple npm project does not need to declare `packageManager`; Releaseway uses its own pinned npm toolchain for packing in that case.

### 6.1 Releaseway toolchain

The action runs as a GitHub JavaScript action with the GitHub-managed `node24` action runtime.

Releaseway does not depend on whatever `node`, `npm`, or `corepack` executable happens to be first on the caller runner's PATH.

Releaseway exactly pins the npm CLI and userland Corepack releases used by the action, including the expected npm registry integrity of those tool artifacts. They are bootstrapped into an isolated temporary toolchain using the JavaScript action runtime.

The pinned npm CLI used for registry mutation must satisfy both npm Trusted Publishing and staged-publishing requirements. It is separate from the package manager used to create the tarball.

When an exact `packageManager` is declared, Releaseway provisions that npm, pnpm, or Yarn version through its pinned userland Corepack and uses it only for package-manager-owned operations such as `pack`.

After provisioning, the reported package-manager version must match the exact declared version. A project-local override that causes a different package-manager version to execute fails closed.

A declared package-manager version must be executable on the Node.js 24 action runtime. An incompatible version fails rather than causing Releaseway to substitute another package-manager version.

Releaseway does not rely on Node.js-bundled Corepack.

## 7. Workspace dependency ordering

Releaseway builds an internal graph among publish candidates.

Ordering edges:

```text
dependencies         -> hard ordering edge
optionalDependencies -> hard ordering edge
peerDependencies     -> range validation only; no ordering edge
devDependencies      -> excluded from publication ordering
```

Only dependencies between packages participating in the current workspace publication are relevant to topological ordering.

A hard-edge cycle fails. Releaseway does not choose an arbitrary publication order for a cyclic graph.

Independent-version and lockstep-version monorepos are both supported by the same reconciliation model.

## 8. Publish mode

Supported publish modes are:

```text
direct
stage
```

There is no `auto` publish mode.

The repository default is:

```yaml
publish:
  mode: direct
```

A package may override the repository default.

Publish mode is persistent repository policy in `.github/npm/packages.yml`, not a per-run workflow input.

### 8.1 Direct

`direct` publishes the verified tarball directly to the live npm registry.

It is the default because it preserves the conventional meaning of npm publication for ordinary packages.

### 8.2 Stage

`stage` uses npm staged publishing and requires explicit opt-in.

Releaseway does not silently fall back from `stage` to `direct`.

A package that does not yet exist in the npm registry cannot be published by npm-actions in either mode because npm Trusted Publishing cannot be configured until the package exists.

Brand-new package bootstrap is outside npm-actions. After bootstrap and Trusted Publisher configuration, the package may use either `direct` or `stage` according to repository policy.

### 8.3 Mode reconciliation

Conceptually:

```text
package identity
        |
        +-- package does not exist in npm registry
        |      -> fail: maintainer bootstrap required
        |
        +-- package exists
               |
               v
        expected name@version
               |
               +-- live version exists
               |      +-- exact SHA-512 artifact match -> existing
               |      +-- mismatch -> fail
               |
               +-- live version absent
                      |
                      +-- mode: direct -> direct publish
                      |
                      +-- mode: stage  -> stage publish
```

Releaseway does not use a long-lived publish credential to inspect or reconcile pending staged versions.

A staged-publish conflict reported by npm is a failure. Releaseway does not repair it by approving, rejecting, replacing, or silently switching publication mode.

Stage inspection, approval, and rejection remain outside npm-actions and are performed through npm's staged-publishing lifecycle.

## 9. Publish authentication

Publish authority is OIDC-only.

Releaseway exposes no publish-auth selection input and does not support a long-lived npm publish token as a publication fallback.

The publish path requires a GitHub-hosted runner supported by npm Trusted Publishing.

The caller workflow grants GitHub Actions OIDC permission:

```yaml
permissions:
  contents: read
  id-token: write
```

The package must have an npm Trusted Publisher configured for the calling workflow.

Releaseway invokes npm publication commands and relies on npm CLI Trusted Publishing for the short-lived publish credential.

### 9.1 Supported registry

The publication target is the public npm registry, `https://registry.npmjs.org/`.

Other npm-compatible registries are outside the scope of npm-actions. If package publication resolves to another registry, npm-actions fails closed.

### 9.2 Read authentication is separate

OIDC publish authority does not replace credentials required to install private dependencies or read protected registry metadata.

When such read access is needed, the caller may provide a read-only npm credential through the standard `NODE_AUTH_TOKEN` environment variable on the npm-actions step.

A caller-owned read credential is not publish authority and must not be treated by npm-actions as a fallback publication credential.

Registry inspection may consume that read credential. Releaseway materializes any required read authentication only in an isolated read configuration.

The publication subprocess runs from a separate temporary context with token-bearing environment and npm authentication configuration removed. Token-bearing npm configuration, including authentication material embedded in publish-time config, is rejected rather than allowed to become a fallback credential. Publication succeeds only through the Trusted Publishing OIDC exchange.

### 9.3 Package bootstrap

Initial creation of a package on npm is outside npm-actions.

A maintainer first creates the package through npm's account-level or interactive bootstrap path, then configures the Trusted Publisher for the repository workflow.

After that bootstrap, npm-actions owns subsequent automated publication.

This boundary also means a package configured with `publish.mode: stage` must already exist in the registry.

### 9.4 Staged-publishing lifecycle

OIDC authority is used to submit `npm stage publish`.

Pending-stage inspection, approval, and rejection are not npm-actions responsibilities.

Those operations remain maintainer-controlled and use npm's staged-publishing and 2FA flow.

npm-actions therefore does not claim idempotent equality reconciliation for an already-pending stage. If npm rejects a stage submission because the version is already staged or otherwise conflicts with staged state, the action fails closed.

## 10. Native distribution activation

Native distribution is explicit configuration, not heuristic detection.

A package is treated as a native GitHub Release-backed distribution when its package override declares `distribution`.

Releaseway does not infer native intent from a missing `bin` target, asset filenames, or the mere existence of GitHub Release assets.


## 11. Native package shape

A multi-platform native CLI is still published as one npm package.

Do not create platform-specific npm packages such as:

```text
@scope/tool-darwin-arm64
@scope/tool-darwin-x64
@scope/tool-linux-arm64
@scope/tool-linux-x64
@scope/tool-win32-x64
```

Do not place every platform binary into one npm tarball.

The npm package contains the launcher and Releaseway-generated runtime metadata needed to locate the correct native asset.

Actual native executables remain GitHub Release assets.

## 12. Native target mapping

Native target mapping is explicit and deterministic.

A native distribution supports exactly one npm `bin` command and one native executable per runtime target.

The package must declare exactly one `bin` entry. Its packed target path is reserved for the Releaseway launcher. The bin path must be extensionless or end in `.js`, `.mjs`, or `.cjs`; other extensions fail closed because Node cannot reliably execute the generated JavaScript launcher through them. `.mjs` always receives the ESM launcher, `.cjs` always receives the CommonJS launcher, and `.js` or an extensionless path follows the packed package's `type` (`module` -> ESM, otherwise CommonJS). If the package-manager-produced artifact already contains a regular file at that path, native publication fails rather than overwriting caller content.

The repository config declares:

- the distribution backend;
- the release-tag template;
- the supported target set;
- the exact asset name for each target;
- the exact archive-relative executable path for each target.

Example:

```yaml
distribution:
  type: github-release
  tag: "v{version}"
  targets:
    darwin-arm64:
      asset: tool_darwin_arm64.tar.gz
      executable: tool
    linux-x64-gnu:
      asset: tool_linux_x64.tar.gz
      executable: tool
    win32-x64:
      asset: tool_windows_x64.zip
      executable: tool.exe
```

Supported runtime target identifiers are:

```text
darwin-arm64
darwin-x64
linux-arm64-gnu
linux-x64-gnu
linux-arm64-musl
linux-x64-musl
win32-arm64
win32-x64
```

Linux target selection includes libc detection. If the runtime cannot determine whether the system is GNU libc or musl, it fails rather than selecting a Linux target heuristically.

A package may declare any subset of the supported targets. Runtime execution fails clearly when the current target is not declared.

Releaseway does not infer target identity, asset name, or executable path from filenames.

The supported asset formats are `.tar.gz` and `.zip`. Bare executable assets and other archive formats are outside the native distribution contract.

Ambiguous, duplicate, incomplete, or unsupported target mappings fail closed.

## 13. GitHub Release provenance

Before an npm artifact can reference a GitHub Release-backed native asset, Releaseway verifies the release and referenced assets.

The native distribution precondition includes:

- the expected release exists;
- the release is published;
- the release is immutable;
- the configured release tag resolves to the expected source commit;
- every configured asset name resolves uniquely;
- every referenced asset is in uploaded state;
- every referenced asset has a valid SHA-256 digest.

The exact digest is obtained from the release state and pinned into Releaseway-generated runtime metadata.

The user does not manually duplicate asset digests into `packages.yml`.

### 13.1 Native release scope

A `github-release` distribution always refers to the same GitHub.com repository that is running npm-actions. The config does not accept another repository identifier.

Native distribution requires the repository and its referenced Release assets to be publicly downloadable without credentials.

Private GitHub Release-backed native distribution is not supported because installed npm packages must be able to resolve their native executable without inheriting repository credentials.

Ordinary npm packages may still be published from private source repositories when npm Trusted Publishing permits it; the public-repository requirement applies specifically to GitHub Release-backed native runtime assets.

The configured release tag must resolve to the checked-out source commit, and the checkout must represent the caller workflow's source commit.

## 14. Generated native runtime metadata

Releaseway may modify only the publication artifact when it needs to add a launcher or generated native manifest.

The source repository does not need to contain generated per-platform npm packages or generated digest metadata.

Conceptually, the generated metadata contains an exact mapping such as:

```json
{
  "repository": "owner/repo",
  "version": "1.2.3",
  "tag": "v1.2.3",
  "targets": {
    "darwin-arm64": {
      "asset": "tool_darwin_arm64.tar.gz",
      "executable": "tool",
      "sha256": "..."
    },
    "linux-x64-gnu": {
      "asset": "tool_linux_x64.tar.gz",
      "executable": "tool",
      "sha256": "..."
    }
  }
}
```

This is an internal publication artifact, not user-authored configuration.

## 15. Native runtime behavior

Native binaries are not downloaded during package installation.

Releaseway does not require or inject a `postinstall` downloader.

The runtime flow is:

```text
npm install
    |
    v
no native download
    |
    v
CLI invocation
    |
    v
resolve current OS / architecture / Linux libc target
    |
    v
select exactly one configured asset
    |
    v
resolve digest-keyed cache
    |
    +-- valid cached executable -> execute
    |
    +-- cache miss/corruption
           |
           v
       download asset anonymously
           |
           v
       verify release SHA-256
           |
           v
       safely extract declared executable
           |
           v
       atomically populate cache
           |
           v
       execute native binary
```

This remains compatible with installations performed using `npm install --ignore-scripts`.

A digest mismatch discards the downloaded asset and fails execution.

No fallback to another target is permitted.

### 15.1 Cache contract

The native cache is user-scoped and keyed by the verified GitHub Release asset SHA-256, not by mutable tags or asset URLs.

Default cache roots are platform-native:

```text
Linux   -> $XDG_CACHE_HOME/releaseway/npm-actions/native/sha256/<digest>/
           or ~/.cache/releaseway/npm-actions/native/sha256/<digest>/ when XDG_CACHE_HOME is unset
macOS   -> ~/Library/Caches/releaseway/npm-actions/native/sha256/<digest>/
Windows -> %LOCALAPPDATA%\releaseway\npm-actions\native\sha256\<digest>\
```

On a cache miss, the launcher downloads and prepares content in a unique temporary location. It verifies the archive SHA-256 before extraction, records a digest for the extracted executable, and atomically promotes the completed cache entry.

Concurrent first runs do not share a partially populated directory. If another process wins the atomic promotion race, the losing process discards its temporary entry, validates the completed cache entry, and uses it.

A cache hit validates the recorded executable digest before execution. Missing or corrupt cache content is discarded and rebuilt from the immutable release asset.

### 15.2 Archive safety

Archive extraction is limited to the explicitly configured executable path.

Archive entries with absolute paths, parent-directory traversal, duplicate target paths, symbolic links, hard links, device entries, or other non-regular executable targets are rejected.

The launcher never extracts arbitrary archive paths into a caller-controlled working directory.

## 16. Fail-closed rules

Releaseway prefers failure over inference or mutation when the intended state is ambiguous.

Examples include:

- package-manager identity required for reproducible packing is missing;
- workspace dependency ordering contains a hard-edge cycle;
- an existing `name@version` has missing, invalid, or different SHA-512 artifact integrity;
- npm reports that a direct or staged publication conflicts with existing staged state;
- a discovered publishable package does not yet exist in the npm registry and therefore has no Trusted Publisher bootstrap;
- publication resolves to a registry other than `https://registry.npmjs.org/`;
- the caller workflow cannot obtain npm Trusted Publishing authority through OIDC;
- native target mapping is ambiguous or incomplete;
- a configured native asset is missing or duplicated;
- GitHub Release provenance does not match the expected source;
- asset state or SHA-256 validation fails.

Releaseway does not silently repair these states.

## 17. Action shape

The public entry point is a root JavaScript action:

```yaml
runs:
  using: node24
  main: dist/main.js
```

The caller workflow owns the release job and invokes `releaseway/npm-actions` directly.

This keeps publication in the caller workflow context rather than hiding npm publication behind a separate reusable workflow identity. The caller does not need to install Node.js for the action itself.

### 17.1 Public interface

The action has no functional inputs.

It operates on the repository checked out at `GITHUB_WORKSPACE`, discovers the repository-level package set, and reads Releaseway policy only from the fixed `.github/npm/packages.yml` path when that file exists.

There is no `package-path`, package selector, registry, publish-mode, auth, or config-path input.

The checkout HEAD must equal `GITHUB_SHA`, and the checkout repository identity must match `GITHUB_REPOSITORY`. Any checkout that cannot be bound exactly to those caller-context identities fails closed.

Every publishable package must have npm repository metadata that resolves to the same GitHub repository, as required by npm Trusted Publishing.

The action fails when no publishable packages are discovered. Duplicate discovered npm package names and config entries that do not select a discovered package also fail.

The action exposes one output:

```text
packages
```

`packages` is a JSON array ordered by publication execution order. Each element contains:

```json
{
  "name": "@scope/package",
  "version": "1.2.3",
  "state": "published"
}
```

The stable state values are:

```text
published  -> newly published through direct mode
staged     -> newly submitted through staged mode
existing   -> exact name@version artifact already live
```

Manifests excluded by publication policy, including `private: true`, are not included in the output.

## 18. Responsibility boundaries

Caller responsibilities:

- version selection;
- version bumping;
- changelog and release-trigger policy;
- source build steps;
- producing GitHub Release assets when native distribution is used;
- running publication on a GitHub-hosted runner supported by npm Trusted Publishing;
- granting the workflow `id-token: write`;
- configuring the npm Trusted Publisher for the calling workflow;
- enabling direct publication in npm publisher settings when `publish.mode: direct` requires it;
- bootstrapping a package before npm-actions manages subsequent releases;
- supplying read-only registry credentials when private dependency or metadata access is required;
- inspecting, approving, or rejecting pending staged publications.

npm-actions responsibilities:

- workspace discovery;
- publishable-package filtering;
- package-manager selection;
- deterministic packing;
- artifact inspection;
- live-registry reconciliation;
- workspace dependency ordering;
- enforcement of the public npm registry (`https://registry.npmjs.org/`) as the publication target;
- direct or staged publication through npm Trusted Publishing and GitHub Actions OIDC;
- never treating caller-owned read credentials as publish authority;
- native distribution config validation;
- GitHub Release provenance and digest verification;
- generation of native launcher/runtime metadata when required;
- idempotent no-op behavior for matching live-published versions;
- fail-closed behavior for pending-stage conflicts and other ambiguous state.

## 19. Design summary

```text
repository
|
+-- package.json / workspace metadata
|     -> npm identity and package semantics
|
+-- .github/npm/packages.yml
      -> Releaseway-only persistent policy

               |
               v

workspace discovery
        |
        v
publishable package set
        |
        v
dependency graph
        |
        v
package-manager-native pack
        |
        v
verified package artifacts
        |
        v
npm package identity
        |
        +-- package absent -> fail; maintainer bootstrap required
        |
        +-- package exists
               |
               v
        live version reconciliation
               |
               +-- identical SHA-512 artifact -> no-op
               |
               +-- conflicting live version -> fail
               |
               +-- version absent
                      |
                      +-- direct -> OIDC -> npm publish
                      |
                      +-- stage  -> OIDC -> npm stage publish
                                          |
                                          +-- pending-stage conflict -> fail
                                          +-- approval/rejection -> maintainer

Native package override:

packages.yml distribution
        |
        v
explicit target -> GitHub Release asset mapping
        |
        v
published immutable release + source provenance
        |
        v
asset SHA-256 pinning
        |
        v
generated launcher / manifest in npm artifact
        |
        v
runtime downloads exactly one target on demand
```
