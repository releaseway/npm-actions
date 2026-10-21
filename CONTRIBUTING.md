# Develop npm-actions

Clone this repository and use a Node.js version supported by
[`package.json`](package.json). With Corepack on `PATH`, it selects the pnpm version in the
`packageManager` field. Consumers call the [GitHub Action](README.md); they do not
need this repository's development dependencies.

## Validate a change

From the repository root:

```sh
corepack pnpm install --frozen-lockfile
corepack pnpm run verify:versions
corepack pnpm run typecheck
corepack pnpm test
corepack pnpm run verify:dist
```

`verify:versions` checks dependency pins, lockfile consistency, SHA-512 integrity
format, toolchain identities and full-SHA workflow refs without querying upstream
latest versions. `verify:dist` independently rebuilds the checked-in bundles and
compares their bytes. See [IMPLEMENTATION.md](IMPLEMENTATION.md#tests-and-ownership)
for toolchain, packing and native integration checks and their environment needs.

The [CI workflow](.github/workflows/check.yml) defines the platform/runtime matrix
and required checks. Local checks do not establish real npm OIDC publication or
execution on other operating systems.

## Maintain dependencies

`corepack pnpm run verify:latest` also compares pins with compatible upstream
releases. The weekly or manually dispatched `Dependency maintenance` workflow runs
it. New upstream releases produce warnings; invalid pins, lockfile mismatches,
integrity errors and failed registry requests fail validation. Toolchain integration
checks downloaded bytes against the pinned SHA-512 digests.

## Approve an automation release

Repository releases require exact-SHA push CI and two fresh `acceptance-runs`:
staged submission and direct native publication. At least one exercises tag-derived
prereleases. Direct acceptance compares planned SHA-512 with installed bytes and
runs the required Node consumer matrix. See the
[candidate guide](https://github.com/releaseway/release-fixture#candidate-release-readiness)
for retention, read permissions and retries.

The repository release workflow preserves approval in an immutable
`releaseway-evidence.json` asset. This is approval for the npm-actions automation
release, separate from a product's npm publication. See
[archive authentication, offline replay and recovery](https://github.com/releaseway/actions/blob/main/docs/release-evidence.md).
Historical approvals retain their original identities and policy.

## Profile source-state checks

Mutation checks inspect the whole worktree after every pack, including ignored
build outputs, symlinks and modes. Files larger than 1 MiB are hashed as a stream.
Compare with a saved baseline implementation using the same supported Node runtime:

```sh
node --experimental-strip-types scripts/benchmark-source-state.mjs /path/to/baseline.ts
```

The baseline needs the same `fast-glob` dependency. Results include elapsed time,
peak RSS, digest and regular-file payload bytes. Compare matched workloads and
verify equal digests; the benchmark retains the snapshot checks.
