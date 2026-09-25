import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import { runRelease } from "../src/orchestrate.ts";
import { inspectPackedTarball } from "../src/pack/inspect.ts";
import { assertPreparedTarball } from "../src/publish/index.ts";
import { NpmRegistryClient } from "../src/registry/client.ts";

// Real npm pack, worktree mutation checks, augmentation, tarball inspection and
// orchestration. Only remote metadata and registry writes are substituted.
test("registry-first flow packs and augments only new versions with real npm artifacts", async () => {
  const npmCli = process.env.npm_execpath;
  assert.ok(npmCli, "Run this integration test through npm test");
  const root = await mkdtemp(join(tmpdir(), "rw-first-e2e-"));
  const workspace = join(root, "workspace");
  const sourceSha = "b".repeat(40);
  try {
    await mkdir(join(workspace, ".github/npm"), { recursive: true });
    const initialized = spawnSync("git", ["init", "--quiet", workspace], {
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(
      join(workspace, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/*"] }),
    );
    const packages = [
      {
        name: "@integration/a-old",
        version: "1.0.0",
        bin: { old: "bin/old.cjs" },
      },
      {
        name: "@integration/b-native",
        version: "2.0.0",
        bin: { native: "bin/native.cjs" },
      },
      {
        name: "@integration/c-library",
        version: "1.0.0",
        dependencies: { renamed: "npm:@integration/b-native@2.0.0" },
      },
    ];
    for (let index = 0; index < packages.length; index++) {
      const directory = join(workspace, "packages", String(index));
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify({
          repository: "releaseway/example",
          files: ["index.js"],
          ...packages[index],
        }),
      );
      await writeFile(join(directory, "index.js"), "module.exports = 1;\n");
    }
    await writeFile(
      join(workspace, ".github/npm/packages.yml"),
      [
        "schema: 1",
        "publish:",
        "  mode: direct",
        "packages:",
        ...packages
          .slice(0, 2)
          .flatMap((p) => [
            "  " + JSON.stringify(p.name) + ":",
            "    distribution:",
            "      type: github-release",
            "      tag: v{version}",
            "      targets:",
            "        linux-x64-gnu:",
            "          asset: native.tar.gz",
            "          executable: bin/tool",
          ]),
        "",
      ].join("\n"),
    );
    const registryDocs = new Map(
      packages.map((p) => [p.name, { name: p.name, versions: {} }]),
    );
    registryDocs.get(packages[0].name).versions["1.0.0"] = {
      name: packages[0].name,
      version: "1.0.0",
    };
    const registry = new NpmRegistryClient({
      fetchImpl: async (url) => {
        const name = decodeURIComponent(new URL(url).pathname.slice(1));
        return new Response(JSON.stringify(registryDocs.get(name)));
      },
    });
    const nativeCalls = [];
    const publications = [];
    const results = await runRelease(
      {
        workspace,
        repository: "releaseway/example",
        sha: sourceSha,
        actionPath: resolve("."),
        env: {
          ...process.env,
          RUNNER_TEMP: join(root, "run"),
          GITHUB_ACTIONS: "true",
          RUNNER_ENVIRONMENT: "github-hosted",
          ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
          ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
        },
      },
      {
        verifySource() {},
        bootstrapToolchain: async () => ({
          root: join(root, "toolchain"),
          npmCli,
          corepackCli: "/unused",
          corepackHome: "/unused",
        }),
        registryClient: registry,
        nativeResolver: {
          async resolve(repository, version, sha, distribution) {
            nativeCalls.push(version);
            assert.equal(version, "2.0.0");
            assert.equal(sha, sourceSha);
            return {
              repository,
              version,
              tag: distribution.tag,
              targets: {
                "linux-x64-gnu": {
                  asset: "native.tar.gz",
                  executable: "bin/tool",
                  sha256: "a".repeat(64),
                },
              },
            };
          },
        },
        async publish(_toolchain, request) {
          await assertPreparedTarball(request);
          const artifact = await inspectPackedTarball(request.tarballPath);
          assert.equal(artifact.manifest.name, request.name);
          assert.equal(artifact.manifest.version, request.version);
          const paths = artifact.entries.map((entry) => entry.path);
          if (request.name === packages[1].name) {
            for (const file of [
              "package/bin/native.cjs",
              "package/.releaseway/native.json",
              "package/.releaseway/runtime.cjs",
            ])
              assert.ok(paths.includes(file), file);
          } else {
            assert.equal(
              paths.some((path) => path.startsWith("package/.releaseway/")),
              false,
            );
            assert.equal(
              artifact.manifest.dependencies.renamed,
              "npm:@integration/b-native@2.0.0",
            );
          }
          registryDocs.get(request.name).versions[request.version] = {
            ...artifact.manifest,
            dist: { integrity: request.integrity },
          };
          publications.push(request.name);
          return "direct-accepted";
        },
      },
    );
    assert.deepEqual(
      results.map((result) => result.state),
      ["already-published", "published", "published"],
    );
    assert.deepEqual(nativeCalls, ["2.0.0"]);
    assert.deepEqual(publications, [packages[1].name, packages[2].name]);
    assert.equal(
      await readFile(join(workspace, "packages/0/index.js"), "utf8"),
      "module.exports = 1;\n",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
