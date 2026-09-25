# releaseway/npm-actions

Publish npm packages from GitHub Actions with deterministic packaging, exact registry reconciliation, and npm Trusted Publishing.

`releaseway/npm-actions` discovers every publishable package in the checked-out repository, creates the package artifact with the repository's own package manager, verifies the complete release state, and only then performs `npm publish` or `npm stage publish`.

The action has no functional inputs. npm package metadata stays in `package.json`; Releaseway-only policy lives in `.github/npm/packages.yml` when additional policy is needed.

## Requirements

Before using the action:

- the package must already exist on the public npm registry;
- npm Trusted Publishing must be configured for the calling GitHub workflow;
- the publish job must run on a GitHub-hosted runner;
- the job must grant `contents: read` and `id-token: write`;
- every publishable package must declare repository metadata that resolves to the current GitHub repository;
- caller-owned install/build steps must finish before npm-actions runs.

The publication target is always `https://registry.npmjs.org/`. Other npm-compatible registries are outside the scope of npm-actions.

npm-actions does not accept or fall back to a long-lived npm publish token. An optional read-only `NODE_AUTH_TOKEN` may be supplied when registry metadata requires authentication; it is isolated from the publication subprocess.

## Quick start

For an ordinary package, no Releaseway config file is required.

```yaml
name: Publish

on:
  push:
    tags:
      - "v*"

permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@<checkout-full-commit-sha> # vX.Y.Z

      # Run your install/build steps here when the package needs them.

      - id: npm
        uses: releaseway/npm-actions@<full-commit-sha> # vX.Y.Z

      - run: echo '${{ steps.npm.outputs.packages }}'
```

The action itself runs on GitHub's Node 24 JavaScript-action runtime, so the caller does not need to install Node.js just for npm-actions.

A successful `packages` output is a JSON array:

```json
[
  {"name":"@scope/a","version":"1.2.3","state":"existing"},
  {"name":"@scope/b","version":"2.0.0","state":"published"}
]
```

The stable states are:

- `existing`: the exact `name@version` artifact already exists in npm;
- `published`: the version was published directly during this run;
- `staged`: the version was submitted through npm staged publishing.

## What gets published

`package.json` remains authoritative for npm metadata, including `name`, `version`, `bin`, `files`, `exports`, dependencies, and `publishConfig`.

npm-actions uses package-manager-native packing:

- npm project → `npm pack`;
- pnpm project → the exact pnpm version from the root `packageManager`;
- Yarn project → the exact Yarn version from the root `packageManager`.

pnpm and Yarn projects must declare an exact `packageManager` version. This preserves package-manager-specific publication behavior such as `workspace:` dependency rewriting.

Packages with `private: true` are excluded.

## Monorepos

npm-actions consumes the repository's existing workspace definition instead of adding another package glob system.

It supports:

- npm/Yarn workspace metadata from the root `package.json`;
- pnpm workspace metadata from `pnpm-workspace.yaml`.

The repository root is also considered a package. If it is not `private: true`, it must contain valid publishable package metadata.

Publication selection is registry-based rather than Git-diff-based. For every discovered publishable `name@version`, npm-actions asks the registry whether that immutable version already exists.

Workspace publication ordering uses the packed manifests:

- `dependencies` and `optionalDependencies` create hard ordering edges;
- `peerDependencies` are range-validated but do not create ordering edges;
- `devDependencies` do not affect publication ordering.

Hard dependency cycles fail before publication.

## Exact existing-version reconciliation

npm versions are immutable. npm-actions computes SHA-512 SRI over the exact final `.tgz` it would publish and compares it with the existing version's npm `dist.integrity`.

If the SHA-512 values match, the version is `existing` and no publish operation is performed.

If the version exists but the SHA-512 integrity is missing, malformed, weaker-only, or different, the action fails. It never treats an occupied version as reusable based on unpacked file similarity.

Dist-tags are mutable registry state and are not part of immutable artifact equality. npm-actions does not move or repair dist-tags for versions that already exist.

For a new publication, `publishConfig.tag` and `publishConfig.access` are honored when explicitly declared. A prerelease version, or a version lower than the package's current `latest`, must declare an explicit `publishConfig.tag`; npm-actions will not accidentally move `latest` backward.

## Direct and staged publishing

Staged publishing is the repository default:

```yaml
schema: 1

publish:
  mode: stage
```

Direct publishing is an explicit repository or package-level opt-in:

```yaml
schema: 1

publish:
  mode: stage

packages:
  "@scope/conventional":
    publish:
      mode: direct
```

A Trusted Publisher connection always allows `npm stage publish`. A repository that opts into `direct` must also enable `Allow npm publish` for that Trusted Publisher in npm.

The config path is fixed:

```text
.github/npm/packages.yml
```

There is no per-run publish-mode input.

`direct` submits the verified tarball through `npm publish`, then waits for npm's publish-time malware scan to expose the exact version in the live registry. A successful subprocess is not enough: npm-actions reports `published` only after the live `dist.integrity` exactly matches the final local tarball. The default wait is 20 minutes with 10-second polling. A scan-pending `Cannot publish over previously staged version` retry enters the same wait instead of immediately failing.

`stage` submits the verified tarball through `npm stage publish`. Inspection, approval, and rejection of a pending staged version remain maintainer operations in npm's staged-publishing flow and require the applicable npm 2FA approval. npm-actions does not inspect, approve, reject, replace, or silently convert a conflicting pending stage.

## Package bootstrap

Brand-new npm packages are outside npm-actions.

A maintainer must first create the package on npm and configure its Trusted Publisher for the GitHub workflow. After that bootstrap, npm-actions manages subsequent automated direct or staged releases.

If a discovered publishable package does not exist in npm, the action fails before any package is published.

## Native CLI distribution

A package may publish a small npm launcher while keeping platform-native executables in the same repository's public immutable GitHub Release.

Native distribution is explicit configuration:

```yaml
schema: 1

publish:
  mode: stage

packages:
  "@scope/tool":
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

A native package must declare exactly one npm `bin` command. The package-manager-produced tarball must leave that packed bin target available for a generated thin Releaseway wrapper and must not occupy the Releaseway-owned `.releaseway/native.json` or `.releaseway/runtime.cjs` paths. The bin path must be extensionless or end in `.js`, `.mjs`, or `.cjs`. `.mjs` uses an ESM wrapper, `.cjs` uses CommonJS, and `.js` or extensionless paths follow the packed package's `type` field. Both wrapper forms resolve their installed real path, load the same bundled CommonJS runtime, and pass that runtime the exact generated manifest path rather than searching parent directories.

Supported runtime targets are:

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

Supported assets are `.tar.gz` and `.zip`. Each target declares the exact asset name and the exact archive-relative executable path.

For native publication, npm-actions verifies that:

- the GitHub repository is public;
- the referenced same-repository Release exists and is published;
- the Release is immutable;
- the configured tag resolves to the exact checked-out `GITHUB_SHA`;
- every configured asset exists exactly once and is uploaded;
- every configured asset exposes a valid GitHub SHA-256 digest.

The digest is embedded into the generated npm runtime metadata. Users do not copy digests into `packages.yml`.

Private GitHub Release-backed native assets are not supported.

## Native runtime behavior

Installing the npm package does not download a native binary. npm-actions does not add a `postinstall` downloader, so installation remains compatible with `npm install --ignore-scripts`.

On first CLI execution, the generated wrapper loads `.releaseway/runtime.cjs`, which:

1. detects the current OS, CPU architecture, and Linux libc variant;
2. selects exactly one configured target;
3. checks a user-scoped SHA-256-keyed cache;
4. downloads the public GitHub Release asset on cache miss;
5. verifies the complete archive SHA-256 before extraction;
6. extracts only the configured regular executable;
7. atomically promotes the verified executable into the cache;
8. executes it with the original arguments and inherited stdio.

The launcher rejects traversal paths, absolute paths, symbolic links, hard links, device entries, unsupported archive types, digest mismatches, and undeclared runtime targets.

Cache locations follow the platform and use a versioned content-addressed layout:

```text
Linux   $XDG_CACHE_HOME/releaseway/npm-actions/native/v2/sha256/<archive-digest>/
        or ~/.cache/releaseway/npm-actions/native/v2/sha256/<archive-digest>/

macOS   ~/Library/Caches/releaseway/npm-actions/native/v2/sha256/<archive-digest>/

Windows %LOCALAPPDATA%\releaseway\npm-actions\native\v2\sha256\<archive-digest>\
```

Each archive digest directory stores one verified `archive.bin` plus independent executable entries under `executables/<sha256(normalized executable path)>/`. Packages that select different executable paths from the same archive therefore share one archive download without overwriting each other's executable cache. Corrupt executable content rebuilds only that executable entry; corrupt archive content refreshes only the archive files and leaves other verified executable entries intact.

## Read-only npm authentication

Most public npm metadata reads need no token.

When a workflow needs authenticated read access, provide a read-only token only on the npm-actions step:

```yaml
- id: npm
  uses: releaseway/npm-actions@<full-commit-sha> # vX.Y.Z
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_READ_TOKEN }}
```

npm-actions removes token-bearing environment and npm authentication configuration before invoking the publish CLI. Publication still succeeds only through the GitHub Actions OIDC exchange with npm Trusted Publishing.

## Retry behavior

The action completes all deterministic preflight work before the first npm mutation: source identity, workspace/config validation, toolchain provisioning, packing, native provenance, final artifact construction, dependency validation, registry reconciliation, and publish-option/OIDC checks.

A network or registry write can still fail partway through a monorepo release. The error identifies packages that completed before the failure.

On rerun, already-live versions are accepted only when their exact SHA-512 artifact integrity matches. Those packages become `existing`, and npm-actions continues with the remaining candidates.

A pending staged-version conflict is not automatically reconciled; it fails so a maintainer can inspect the staged state explicitly.

## Scope

npm-actions owns npm publication automation after package bootstrap.

It does not choose versions, bump versions, generate changelogs, decide release triggers, perform product builds, create GitHub Release assets, approve npm staged releases, or publish to non-npmjs registries.
