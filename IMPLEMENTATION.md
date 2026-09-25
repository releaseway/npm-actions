# releaseway/npm-actions — Implementation Plan

Status: ready for implementation
Design source: `DESIGN.md`
Updated: 2026-09-24

## 1. Implementation strategy

Implement npm-actions as one bundled GitHub JavaScript action plus one generated native-runtime launcher.

The public action has no functional inputs:

```yaml
- uses: releaseway/npm-actions@<full-commit-sha>
```

The action executes with GitHub's `node24` JavaScript-action runtime. Consumer workflows do not install Node.js for npm-actions itself.

All package discovery, packing, validation, registry reconciliation, native artifact generation, and publication logic lives in this repository and is bundled into `dist/main.js`.

Native packages receive a generated launcher in their final npm tarball. The launcher implementation is built from this repository and bundled without runtime npm dependencies.

The implementation uses a strict preflight barrier:

```text
discover
  -> parse config
  -> verify source identity
  -> provision pack toolchain
  -> pack every publishable package
  -> augment native artifacts
  -> inspect every final artifact
  -> validate dependency graph
  -> validate native release provenance
  -> inspect npm registry state
  -> verify every package can be published or accepted as existing
  -> ONLY THEN perform the first npm mutation
```

Any deterministic/configuration/provenance failure must therefore happen before a package is newly published whenever possible.

Network publication can still fail partway through a topological publish sequence. Reruns reconcile exact live artifacts and continue with the remaining versions.

## 2. Repository shape

Create this baseline layout:

```text
.
├── .github/
│   └── workflows/
│       ├── check.yml
│       └── release.yml
├── dist/
│   ├── main.js
│   └── native-runtime.cjs
├── scripts/
│   ├── build.mjs
│   ├── update-toolchain.mjs
│   ├── verify-dist.mjs
│   └── verify-native-install.mjs
├── src/
│   ├── main.ts
│   ├── errors.ts
│   ├── output.ts
│   ├── github-context.ts
│   ├── config/
│   │   ├── load.ts
│   │   ├── schema.ts
│   │   └── types.ts
│   ├── workspace/
│   │   ├── discover.ts
│   │   ├── repository.ts
│   │   └── identity.ts
│   ├── toolchain/
│   │   ├── bootstrap.ts
│   │   ├── corepack.ts
│   │   └── lock.ts
│   ├── pack/
│   │   ├── index.ts
│   │   ├── npm.ts
│   │   ├── pnpm.ts
│   │   ├── yarn.ts
│   │   └── inspect.ts
│   ├── graph/
│   │   ├── dependencies.ts
│   │   └── topo.ts
│   ├── registry/
│   │   ├── client.ts
│   │   ├── integrity.ts
│   │   └── reconcile.ts
│   ├── publish/
│   │   ├── environment.ts
│   │   ├── direct.ts
│   │   └── stage.ts
│   └── native/
│       ├── validate.ts
│       ├── release.ts
│       ├── augment.ts
│       ├── deterministic-tar.ts
│       └── launcher/
│           ├── target.ts
│           ├── cache.ts
│           ├── download.ts
│           ├── archive.ts
│           ├── manifest.ts
│           ├── runtime.ts
│           └── wrapper.ts
├── test/
│   ├── fixtures/
│   ├── unit/
│   ├── integration/
│   └── runtime/
├── action.yml
├── DESIGN.md
├── IMPLEMENTATION.md
├── package.json
├── package-lock.json
└── tsconfig.json
```

## 3. Repository development toolchain

Use npm for this repository itself.

Baseline development dependencies:

- TypeScript for source/type checking;
- esbuild for the committed action/runtime bundles;
- YAML parser for `.github/npm/packages.yml`;
- glob implementation for workspace expansion;
- semver implementation for dependency range validation;
- tar/gzip and zip readers/writers needed for deterministic native augmentation and runtime extraction.

Prefer Node's built-in `node:test`, `assert`, `fetch`, `crypto`, `fs`, and process APIs instead of adding framework dependencies when they are sufficient.

`package.json` for npm-actions itself is `private: true`.

The committed `dist/` directory is part of the GitHub Action release artifact. CI must rebuild it and fail if the committed bundle differs.

## 4. GitHub Action dependency policy — actions-up is mandatory

All third-party GitHub Actions used anywhere in the repository are pinned to full commit SHAs with adjacent release-version comments.

Do not manually retain old major-version pins.

Use `actions-up` both to generate/update those pins and to enforce freshness in CI.

At the time this plan was written, the npm registry reports:

```text
actions-up 1.21.0
```

Implementation must begin with a fresh registry check:

```sh
npm view actions-up version
```

The implementation must use the returned latest stable version. If it is no longer `1.21.0`, replace every `1.21.0` command below with the new latest version before continuing.

After authoring or changing any workflow/action dependency, apply current pins:

```sh
npm exec --yes actions-up@1.21.0 -- \
  --dir .github \
  --recursive \
  --mode major \
  --style sha \
  --prefer-tags \
  --min-age 0 \
  --yes
```

The CI pin gate performs the same latest-version self-check, then runs report mode:

```sh
latest_actions_up=$(npm view actions-up version)
test "$latest_actions_up" = "1.21.0"

npm exec --yes actions-up@1.21.0 -- \
  --dir .github \
  --recursive \
  --dry-run \
  --json \
  --mode major \
  --style sha \
  --prefer-tags \
  --min-age 0
```

CI parses the JSON and requires:

```text
summary.totalUpdates == 0
summary.totalBlockedByMode == 0
summary.totalBlockedByAge == 0
```

The `--mode major` policy is intentional: a new stable major GitHub Action release is considered an update that must be reviewed and pinned, not silently ignored.

The `--min-age 0` policy is also intentional: npm-actions does not intentionally lag GitHub Action releases.

Initial workflow authoring may use the current documented major tags only as temporary input to `actions-up`. The resulting committed files must contain full SHAs.

## 5. Work items

### WI-001 — Bootstrap the JavaScript action repository

Create:

- `package.json`, `package-lock.json`, `tsconfig.json`;
- root `action.yml`;
- minimal `src/main.ts`;
- build scripts;
- committed `dist/main.js`;
- `.github/workflows/check.yml`.

`action.yml` contract:

```yaml
runs:
  using: node24
  main: dist/main.js
```

It declares no inputs and declares one `packages` output.

The initial `main` implementation only proves context access and output writing; it does not publish.

Add a distribution check that rebuilds `dist/` and fails on drift.

Run `actions-up` in apply mode after the workflow is authored so all external `uses:` references are current full-SHA pins.

Acceptance:

- `npm ci` succeeds from a clean checkout;
- typecheck succeeds;
- build succeeds;
- `dist/main.js` is reproducible from source;
- `action.yml` is a valid Node 24 JavaScript action;
- actions-up reports zero pending/blocked action updates after apply.

Validation:

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run verify:dist
```

### WI-002 — Implement isolated Releaseway toolchain bootstrap

Create a checked-in internal toolchain lock containing exact npm and userland Corepack versions plus their npm registry SRI values.

Initial implementation should resolve current stable versions. At plan time:

```text
npm      12.1.0
corepack 0.36.0
```

Do not assume those versions are still latest when implementation starts; `scripts/update-toolchain.mjs` resolves and records the selected exact versions and registry integrity.

Bootstrap behavior:

1. fetch npm package metadata directly with the Node 24 action runtime;
2. fetch the pinned tarball;
3. verify SRI before extraction;
4. extract into a unique `RUNNER_TEMP` toolchain root;
5. execute the pinned npm CLI by absolute path;
6. repeat for pinned userland Corepack;
7. never select `npm` or `corepack` from caller PATH for publication/toolchain provisioning.

For a root `packageManager` declaration:

- require exact `name@version`;
- allow Corepack's integrity suffix;
- reject tags/ranges;
- provision through pinned Corepack;
- verify the executable-reported version equals the declared version.

Acceptance:

- corrupted downloaded npm/Corepack tarballs fail before execution;
- the action ignores fake/stale npm/corepack binaries injected at the front of PATH;
- exact pnpm/Yarn/npm packageManager versions are honored;
- package-manager version mismatch fails.

### WI-003 — Implement config, workspace discovery, and repository identity

Implement fixed-path config loading:

```text
.github/npm/packages.yml
```

No file is valid and means repository defaults.

Implement strict schema validation:

- `schema: 1`;
- repository `publish.mode`;
- package-name keyed overrides;
- optional package `publish.mode`;
- optional `distribution: github-release`;
- target `asset` + `executable`;
- reject unknown keys.

Workspace discovery:

- root package always participates in discovery;
- `package.json.workspaces` array/object forms;
- `pnpm-workspace.yaml` package globs including exclusions;
- no second Releaseway workspace glob field;
- do not follow workspace symlink escapes;
- normalize package paths within `GITHUB_WORKSPACE`.

Package filtering/validation:

- `private: true` -> excluded;
- missing name/version on an otherwise publishable manifest -> fail;
- duplicate npm package names -> fail;
- config selector that does not match a discovered package -> fail;
- publication registry must resolve to `https://registry.npmjs.org/`;
- package repository metadata must resolve to `GITHUB_REPOSITORY`.

Source identity:

- repository checkout matches `GITHUB_REPOSITORY`;
- HEAD equals `GITHUB_SHA`;
- source mismatch fails before packing.

Acceptance fixtures:

- single npm package;
- npm workspace;
- pnpm workspace with negated glob;
- Yarn workspace;
- private root + public children;
- duplicate names;
- stale config selector;
- repository mismatch;
- non-npm registry.

### WI-004 — Implement package-manager-native packing

Create adapters for npm, pnpm, and Yarn.

Rules:

- simple npm repository with no `packageManager` uses pinned Releaseway npm;
- declared packageManager uses exact Corepack-provisioned manager;
- pack into Releaseway-owned temporary directories;
- capture exact output tarball path;
- never publish directly through pnpm/Yarn.

Before the first pack, snapshot Git worktree state. After all packs, require that source state is byte-for-byte/status equivalent to the baseline. Caller-preexisting build artifacts are allowed; new pack-time source mutations are not.

This enforces the existing responsibility boundary that caller build steps complete before npm-actions.

Pack every publishable package before any registry mutation.

Inspect each packed tarball and capture:

- packed `package/package.json`;
- package name/version;
- final dependencies/optionalDependencies/peerDependencies after workspace protocol rewriting;
- `publishConfig`;
- `bin`;
- file inventory and modes.

Acceptance:

- npm/pnpm/Yarn fixtures produce valid inspectable tarballs;
- `workspace:` dependencies are observed in their packed form;
- pack scripts that mutate the checkout cause a preflight failure;
- malformed tarballs fail before registry access.

### WI-005 — Implement native config validation and GitHub Release provenance

For packages with `distribution.type: github-release`:

- require exactly one npm `bin` entry;
- validate supported target identifiers;
- validate safe POSIX archive-relative executable paths;
- validate only `.tar.gz` and `.zip` assets;
- reject duplicate asset mappings;
- require public same-repository GitHub.com release distribution.

Resolve `tag` using only the supported `{version}` placeholder.

Use GitHub's public REST API for the public native repository and cache one raw validated Release snapshot by `repository + expanded tag` during an action run. The snapshot contains the resolved tag commit and raw Release asset inventory only. Apply the expected source commit and each package's target/asset/executable mapping on every resolver call, returning a fresh package-specific verified result. Failed snapshot loads are evicted so transient read failures do not poison the rest of the action run.

Verify before artifact augmentation:

- repository/release is publicly readable;
- release exists;
- release is published;
- release is immutable;
- tag resolves to `GITHUB_SHA`;
- each configured asset name is unique;
- asset state is uploaded;
- GitHub reports a valid SHA-256 digest.

Do not require or propagate a GitHub credential into the installed native runtime.

Acceptance fixtures/fakes:

- mutable release;
- wrong tag commit;
- missing asset;
- duplicate asset;
- non-uploaded asset;
- missing/malformed digest;
- private/unreadable release.

### WI-006 — Implement deterministic native npm artifact augmentation

Native augmentation operates on the package-manager-produced tarball, not on the source repository.

For a native package:

1. inspect the declared packed `bin` path;
2. require that the bin target, `.releaseway/native.json`, and `.releaseway/runtime.cjs` are not occupied by caller content;
3. generate immutable runtime manifest containing repository, version, expanded tag, targets, assets, executable paths, and SHA-256 digests;
4. inject the single bundled CommonJS runtime at `.releaseway/runtime.cjs`;
5. generate a thin CommonJS or ESM wrapper at the declared `bin` target;
6. inject the manifest at `.releaseway/native.json`;
7. repack deterministically.

Build one runtime bundle from `src/native/launcher/runtime.ts`. Generated bin wrappers use Node built-ins only. The CommonJS wrapper resolves `__filename` through `realpathSync()`; the ESM wrapper resolves `import.meta.url` through `fileURLToPath()` and `realpathSync()`, then uses `createRequire(import.meta.url)` to load the shared CommonJS runtime. Both wrappers pass the exact generated manifest path to the runtime.

Choose the wrapper form from the packed package/module/bin context without rewriting the user's npm `bin` identity. Only extensionless, `.js`, `.mjs`, and `.cjs` bin targets are supported; `.mjs` is ESM, `.cjs` is CommonJS, and `.js`/extensionless targets follow the packed package `type` field. The runtime does not search parent directories for a manifest.

Deterministic repack rules:

- stable lexical entry ordering;
- canonical gzip metadata;
- deterministic timestamps;
- deterministic uid/gid/uname/gname;
- preserve semantically required executable/file modes;
- no host-specific absolute paths.

Two identical preflight runs over identical inputs must produce byte-identical final `.tgz` files.

Acceptance:

- same input twice => same SHA-512;
- source checkout remains unchanged;
- occupied bin/runtime/manifest target fails;
- manifest content matches verified GitHub Release state;
- installed CommonJS and ESM bins work through local `.bin`, `npm exec`, `npm run`, and global-prefix shims with `--ignore-scripts`;
- ordinary non-native package tarball remains exactly package-manager-produced.

### WI-007 — Implement dependency validation and topological ordering

Build dependency relationships from the packed manifests, because pnpm/Yarn may transform workspace protocols during pack.

For every internal workspace dependency:

- `dependencies` -> hard edge;
- `optionalDependencies` -> hard edge;
- `peerDependencies` -> range validation only;
- `devDependencies` -> ignored.

Validate that the packed dependency/peer range accepts the referenced workspace package version.

After registry reconciliation, topological ordering only needs hard edges among packages that will actually be newly published/staged; exact-existing packages already satisfy publication ordering.

Cycles among remaining hard edges fail before mutation.

Acceptance:

- independent packages retain deterministic order;
- dependency chain sorts correctly;
- existing dependency removes unnecessary publish edge;
- optional dependency sorts;
- peer-only relation does not create cycle;
- incompatible peer/internal range fails;
- hard cycle fails.

### WI-008 — Implement npm registry reconciliation

Use a dedicated read-only registry client for `https://registry.npmjs.org/`.

Authentication boundary:

- public package metadata is read anonymously;
- optional caller `NODE_AUTH_TOKEN` may be used only by this read client;
- read auth is materialized in isolated state and never reused by the publisher.

For each package identity:

1. query package metadata;
2. 404 package identity -> fail with maintainer-bootstrap-required error;
3. package exists, version absent -> candidate;
4. package/version exists -> require exact SHA-512 `dist.integrity` match with final local tarball;
5. missing, malformed, weaker-only, or different integrity -> fail.

Derive publish-time mutable settings from the packed manifest:

- `publishConfig.tag` when present;
- npm default tag behavior otherwise;
- `publishConfig.access` only when explicitly declared;
- reject non-npm `publishConfig.registry`.

Do not reconcile already-live dist-tags or access state.

Preflight all package registry states before the first mutation.

Acceptance:

- anonymous public metadata;
- authenticated read metadata using fake token;
- package absent;
- version absent;
- exact SHA-512 existing;
- mismatched SHA-512;
- malformed/weaker integrity;
- dist-tag differences do not invalidate existing exact version.

### WI-009 — Implement OIDC-only publisher

Build an isolated publication environment for each candidate.

The publish subprocess:

- executes the pinned Releaseway npm CLI by absolute path;
- runs from a Releaseway temporary working directory, not repository root;
- uses explicit `--registry=https://registry.npmjs.org/`;
- preserves GitHub OIDC environment required by npm Trusted Publishing;
- strips `NODE_AUTH_TOKEN`, `NPM_TOKEN`, token-bearing npm config, and other publish credential fallbacks;
- rejects token-bearing publish-time configuration;
- never invokes npm login/whoami/token fallback.

Direct mode:

```text
npm publish <absolute-final-tgz>
        |
        v
accepted by npm / publish-time malware scan
        |
        v
poll live registry
        |
        +-- exact SHA-512 appears -> published
        +-- different SHA-512 -> fail
        +-- visibility budget expires -> fail, rerunnable
```

A direct retry that receives `Cannot publish over previously staged version` is treated as an already accepted scan-pending publication and enters the same live-registry wait.

Stage mode:

```text
npm stage publish <absolute-final-tgz>
```

Pass explicit `--tag` and `--access` only when derived from the packed manifest.

Preflight tag semantics so prerelease/non-latest versions that require an explicit tag fail before mutation rather than halfway through a monorepo publication.

Map successful outcomes to:

- `published` only after exact live SHA-512 visibility for direct mode;
- `staged` after successful `npm stage publish`.

Treat staged-mode version conflicts as fail-closed. Do not inspect/approve/reject pending human stages.

Acceptance:

- fake publisher records no token env/config;
- OIDC env survives sanitization;
- direct/stage commands use exact final tarball;
- package tag/access flags are correct;
- direct success waits through candidate registry states until exact live integrity;
- direct scan-pending E409 enters reconciliation instead of retrying a replacement;
- direct scan visibility timeout fails clearly and remains rerunnable;
- staged-mode conflict propagates as failure;
- token-only environment cannot publish.

### WI-010 — Implement native runtime launcher

The bundled launcher performs:

1. runtime target detection;
2. Linux GNU/musl detection;
3. manifest target lookup;
4. digest-keyed cache validation;
5. anonymous GitHub asset download on cache miss;
6. archive SHA-256 verification before extraction;
7. safe extraction of exactly the configured executable;
8. extracted executable digest recording;
9. atomic cache promotion;
10. child-process execution with inherited stdio and exact argument forwarding.

Cache contract:

- Linux XDG cache root with `~/.cache` fallback;
- macOS `~/Library/Caches`;
- Windows `%LOCALAPPDATA%`;
- versioned `native/v2/sha256` root so legacy entries never alias v2;
- archive directory key = verified asset SHA-256;
- archive files = `archive.bin` + `archive.json`;
- executable directory key = SHA-256 of the normalized archive-relative executable path;
- archive download lock and executable extraction lock are independent;
- different executable paths in one archive retain independent cache paths even when basenames match;
- executable corruption rebuilds only that executable subtree from the cached archive;
- archive corruption refreshes only archive files without deleting verified executable subtrees;
- concurrent requests share one archive download and converge per executable identity.

Archive rejection:

- absolute paths;
- `..` traversal;
- duplicate configured executable entry;
- symlink;
- hard link;
- device/special file;
- non-regular configured executable;
- unsupported archive type.

Runtime tests should create fixture archives dynamically. On each OS, copy the runner's current Node executable into an archive as the test native executable, then verify the launcher can extract/cache/execute it with `--version`.

Linux musl behavior gets an additional Docker-backed integration using a current Alpine/Node image on the Ubuntu runner.

Acceptance:

- first run downloads and executes;
- second run is cache-only;
- archive digest corruption redownloads the archive without deleting valid executable subtrees;
- executable corruption re-extracts from the cached archive without redownloading;
- two different executable paths from one archive return distinct stable paths and share one download;
- concurrent requests for different executable paths share one archive download;
- concurrent requests for the same executable converge to one valid executable entry;
- malicious archives are rejected;
- process exit status and argv propagate correctly;
- GNU/musl and OS/architecture target selection are covered.

### WI-011 — Implement orchestration and stable action output

Wire all modules into `src/main.ts`.

Execution stages:

```text
context
-> discovery/config
-> toolchain
-> pack all
-> native provenance + augmentation
-> final artifact inspection
-> dependency/range validation
-> registry reconciliation
-> complete preflight barrier
-> topological direct/stage mutations
-> output
```

Output:

```json
[
  {"name":"@scope/a","version":"1.2.3","state":"existing"},
  {"name":"@scope/b","version":"2.0.0","state":"published"},
  {"name":"@scope/c","version":"3.0.0","state":"staged"}
]
```

The JSON array follows deterministic execution order.

On partial mutation failure, do not emit a misleading successful aggregate. The failure log must identify packages already completed before the failing package so a rerun is auditable.

No-publishable-package, duplicate identity, source mismatch, and all other contract failures remain hard failures.

### WI-012 — Complete CI validation matrix

`.github/workflows/check.yml` contains separate gates so failures are attributable:

1. **action-pins**
   - fresh `npm view actions-up version`;
   - exact latest actions-up invocation;
   - recursive dry-run JSON;
   - zero updates/blocks required.

2. **static**
   - npm clean install;
   - compatibility-aware version freshness: exact devDependencies, npm/Corepack tarball+SRI, representative pnpm/Yarn pins, and Node 24 engine compatibility;
   - TypeScript typecheck;
   - build;
   - committed-dist drift check.

3. **unit**
   - config/discovery;
   - repository identity;
   - SRI;
   - semver/dependency graph;
   - deterministic archive rules;
   - publisher environment sanitization.

4. **pack-integration**
   - representative npm;
   - representative exact pnpm via Corepack;
   - representative exact modern Yarn via Corepack;
   - no live publish.

5. **runtime-matrix**
   - `ubuntu-24.04`;
   - `ubuntu-24.04-arm` when repository visibility/runners permit;
   - `macos-15`;
   - `macos-15-intel`;
   - `windows-2025`;
   - Windows ARM coverage may be added only when the repository's hosted-runner entitlement makes the standard ARM runner available; platform selection itself remains unit-covered independently.

6. **musl-runtime**
   - current Alpine Node container on Ubuntu;
   - native launcher target/cache/archive smoke.

7. **end-to-end fake registry**
   - complete action orchestration with fake npm registry and fake publisher process;
   - direct, stage, existing, mismatch, partial failure/rerun scenarios;
   - assert no publication begins before preflight completion.

PR CI performs no live npm mutation.

### WI-013 — Documentation and examples

Write `README.md` only after public behavior passes tests.

Document:

- minimal consumer workflow;
- required `contents: read` and `id-token: write`;
- Trusted Publisher bootstrap prerequisite;
- direct/stage policy config;
- monorepo discovery;
- exact existing-version reconciliation;
- optional read-only `NODE_AUTH_TOKEN`;
- native config;
- supported targets/archive formats;
- public same-repository Release requirement;
- first-run download/cache behavior;
- stage approval being outside npm-actions;
- `packages` output;
- failure/retry semantics.

Repository workflow dependencies are maintained by actions-up. README consumer examples use full-SHA placeholders with adjacent release-version comments until a concrete npm-actions release SHA exists.

### WI-014 — Release workflow and release certification

Create `.github/workflows/release.yml` after check CI is green.

The repository is a GitHub Action repository, not an npm-published implementation package.

Release workflow:

1. verify source is expected release commit;
2. run actions-up freshness and compatibility-aware package/toolchain version freshness gates;
3. run the complete verification suite;
4. rebuild and require clean committed `dist/`;
5. create/publish the GitHub Release using the current full-SHA-pinned `releaseway/actions`;
6. never publish if generated bundles differ from committed source.

Use actions-up to resolve and maintain the `releaseway/actions`, checkout, setup-node, and every other workflow `uses:` reference before the release workflow is accepted.

## 6. Validation architecture

### Deterministic local tests

No network required:

- config schema;
- workspace discovery;
- package identity;
- repository parsing;
- graph/ranges;
- tarball inspection;
- native target validation;
- deterministic repack;
- runtime archive safety;
- cache race behavior;
- registry metadata parser;
- publisher environment sanitization.

### Controlled network tests

Allowed in CI, no external mutation:

- npm/Corepack pinned tool bootstrap;
- compatibility-aware current stable version checks for devDependencies, npm/Corepack, pnpm, and Yarn;
- actions-up current-version check;
- actions-up action-pin report;
- public GitHub Release fixture reads where needed.

Core correctness should still have fake-server coverage so an external outage is distinguishable from a product regression.

### Mutation boundary

PR/test CI never performs a real npm publish or stage publish.

The OIDC exchange and npm registry write path are exercised for the first time only through an explicitly configured real release workflow/package. All command construction, credential stripping, preflight behavior, and error mapping must be deterministically covered before that point.

## 7. Commit/work-item boundaries

Recommended implementation commits follow the work items rather than mixing layers:

```text
1. bootstrap action + CI + actions-up policy
2. toolchain bootstrap
3. config/workspace/source identity
4. pack adapters + artifact inspection
5. native release provenance
6. deterministic native augmentation
7. dependency graph + registry reconciliation
8. OIDC publisher
9. native runtime launcher
10. orchestration/output
11. CI integration matrix
12. docs + release workflow
```

A work item is not complete merely because its code exists. Its targeted validation must pass before moving its dependent work forward.

## 8. Implementation dependency graph

```text
WI-001 bootstrap
   |
   +--> WI-002 toolchain
   |
   +--> WI-003 config/discovery
            |
            +--> WI-004 pack
                     |
                     +--> WI-005 native provenance
                     |        |
                     |        +--> WI-006 native augmentation
                     |
                     +--> WI-007 graph
                     |
                     +--> WI-008 registry
                              |
                              +--> WI-009 publisher

WI-006 native augmentation
   |
   +--> WI-010 native launcher

WI-002..WI-010
   |
   +--> WI-011 orchestration
            |
            +--> WI-012 CI matrix
                     |
                     +--> WI-013 docs
                              |
                              +--> WI-014 release certification
```

## 9. Completion gate

Implementation is ready to release only when all of the following are true:

- design and implementation contain no obsolete auth/native-auto/provider branches;
- no caller publish token can reach npm publication;
- every external GitHub Action pin is a current full SHA according to the latest `actions-up`;
- actions-up itself is verified against `npm view actions-up version`;
- all final npm artifact equality tests use SHA-512 `dist.integrity`;
- ordinary package, npm/pnpm/Yarn workspace, direct, stage, existing, native, cache, race, and malicious-archive paths pass;
- `dist/` rebuild is clean;
- PR CI performs no live npm mutation;
- docs match the verified public action contract.
