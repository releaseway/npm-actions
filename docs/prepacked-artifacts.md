# Publish a previously verified tarball

Use `artifacts-manifest` when a build job has already checked the exact npm archive
and a separate job must publish those same compressed bytes. The action checks
every candidate before its first registry write. Invalid input fails the run;
it never falls back to packing.

This feature requires a supporting action ref. Pin a reviewed immutable commit
containing this contract and its generated bundle. Older releases do not accept
the input. The [two-job example](../examples/prepacked.yml) uses an explicit SHA
placeholder which must be replaced before use.

## Seal and transfer

1. Build and pack using the project's package manager and final publication versions.
2. Verify the tarballs: file layout, exports, dependency rewriting, source maps and
   installation into a consumer. Finish any checks that can modify the files.
3. Record each tarball's SHA-512 SRI and the original checkout repository/commit.
   Upload the manifest and tarballs together from that trusted job.
4. Download that exact artifact ID in the publish job. Check out the same workflow
   source and pass the manifest path to this action.

The publisher job needs the existing npm Trusted Publisher/OIDC setup. The build
job needs no publication authority. The action retains repository policy for
direct/stage and channels; there is no per-run publish-mode override.

## Manifest v1

```json
{
  "schema": 1,
  "source": {
    "repository": "owner/repository",
    "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  },
  "packages": [
    {
      "name": "@scope/library",
      "version": "1.2.3",
      "tarball": "tarballs/library.tgz",
      "integrity": "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
    }
  ]
}
```

Replace example identities and the digest with the actual values. The
[manifest schema](../contracts/npm-artifacts-v1.schema.json) defines the shape;
the action also checks canonical SemVer/SRI, source binding, package coverage,
paths, archive contents and registry state. Unknown fields and schema versions
are rejected. A SHA-512 value must be one canonical base64 SRI token, not hex,
a weaker digest or several tokens.

`source.commit` is the original checkout SHA. With `release-commit`, the existing
same-tree marker checks still apply; the marker is the publication commit and
the parent remains the manifest's source commit. A matching tree alone does not
permit a different arbitrary source commit.

Every unpublished selected package needs exactly one entry. Independent package
versions remain independent. With git-tag version policy, pack the selected final
version before sealing; the action does not rewrite the tarball. Entries cannot
add packages, change versions or override policy. Final packed dependencies and
`publishConfig` retain their existing authority, including package-manager
workspace transformations and tag/access validation.

## File lifetime and limits

Relative manifest paths start at the workspace. Absolute manifest paths must be
under the workspace or `RUNNER_TEMP`. Tarball paths are portable relative POSIX
paths inside the manifest directory. Absolute paths, URLs, traversal, backslashes,
drive/ADS syntax, symlinks and nonregular candidate files are rejected.

The action streams each candidate into its own temporary directory and hashes
the copy. Only that admitted copy is published. It checks all prepared files
before publication and checks the current file again before submission. Changing
an input path after import cannot change the owned copy; changing the copy makes
verification fail. The action leaves producer files intact and removes its own
temporary files on completion or controlled failure.

The archive must contain one unambiguous regular `package/package.json` and only
files/directories under `package/`. Duplicate paths, links, special files,
unsafe effective PAX paths, ignored metadata and damaged archives fail admission.
Manifest and package metadata limits are 1 MiB each; compressed bytes are limited
to 1 GiB, the expanded gzip stream to 4 GiB, and payload entries to 100,000.
Copying has a 240-second budget and inspection a 120-second budget per file.
These are action admission limits, not npm registry size or performance promises.

Unpublished packages with Releaseway native `distribution` augmentation are
unsupported in this mode because augmentation changes bytes. They fail before
any package is written. Already-public native packages retain skip behavior;
the existing automatic packing/native path remains available without this input.

## Retry and evidence

Retain the original manifest and remaining tarballs after partial publication.
On retry, a supplied already-public version is skipped only after its registry
SHA-512 matches the original expected digest. Its local file is not needed.
Other already-public packages outside the manifest retain the existing existence
skip. Even an all-public run checks supplied digests before completing, without
packing, provisioning a toolchain or requiring publish OIDC.

All supplied versions receive a fresh registry check before the first mutation
of a prepared release. Subsequent races or service failures can still leave a
partially published workspace. Packages are not published atomically.

`staged` means accepted for staging, not publicly verified. Pending stages are
not already-public versions, and the action does not approve stages, change mode,
repair old dist-tags or retry a write automatically. Inspect uncertain outcomes
against the original SRI before running again.

The new `artifact-report-path` output points to the separate
[artifact report v1](../contracts/npm-artifact-report-v1.schema.json), including
controlled failures and partial results. It separates supplied coverage, local
digest checks, public digest observations and publication states. `unknown` means
a request may have reached the registry without a confirmed outcome. Existing
`packages`, `report-path`, diagnostics schemas and `already-published` meanings
remain unchanged. Report files depend on writable runner storage and survive as
runner-local files; upload them with `if: always()` when needed beyond the job.

SHA-512 proves equality to the supplied digest, not trusted build provenance.
The caller must select a trusted producer, successful run/attempt, original head
SHA and exact artifact ID. GitHub artifact ZIP digests cover a different object
from npm tarball SRI; download digest warnings do not replace the action's checks.
For cross-run delivery, existing checkout identity rules must still pass. Do not
override GitHub source context to accept an arbitrary workflow-run artifact.
