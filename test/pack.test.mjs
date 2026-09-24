import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import test from "node:test";
import * as tar from "tar";

import {
  packAllPackages,
  packPackage,
  resolvePackCommand,
} from "../src/pack/index.ts";
import { inspectPackedTarball } from "../src/pack/inspect.ts";
import {
  assertSourceStateUnchanged,
  snapshotSourceState,
} from "../src/pack/source-state.ts";

async function makeTarball(path, manifest, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "releaseway-pack-fixture-"));
  try {
    const packageRoot = join(root, "package");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify(manifest, null, 2) + "\n",
    );
    for (const [name, content] of Object.entries(extra)) {
      const target = join(packageRoot, name);
      await mkdir(join(target, ".."), { recursive: true });
      await writeFile(target, content);
    }
    await tar.c(
      { cwd: root, file: path, gzip: true, portable: true },
      ["package"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function packageFixture(directory, name = "@scope/pkg") {
  return {
    directory,
    relativeDirectory: ".",
    manifestPath: join(directory, "package.json"),
    manifest: {
      name,
      version: "1.2.3",
      repository: "releaseway/example",
    },
    name,
    version: "1.2.3",
    publishMode: "direct",
  };
}

function manager(name) {
  return {
    name,
    version: "1.0.0",
    executable: process.execPath,
    argsPrefix: ["/isolated/manager.js"],
    env: {},
  };
}

test("pack adapters use manager-native output options and inspect exact identity", async () => {
  for (const name of ["npm", "pnpm", "yarn"]) {
    const root = await mkdtemp(join(tmpdir(), `releaseway-pack-${name}-`));
    try {
      const pkgDir = join(root, "pkg");
      const outputRoot = join(root, "out");
      await mkdir(pkgDir, { recursive: true });
      const pkg = packageFixture(pkgDir);
      const outputDir = join(outputRoot, encodeURIComponent(pkg.name));
      await mkdir(outputDir, { recursive: true });
      const expectedTarball = join(outputDir, "package.tgz");
      await makeTarball(expectedTarball, {
        name: pkg.name,
        version: pkg.version,
        dependencies: { dep: "^1.0.0" },
      });

      const calls = [];
      const artifact = await packPackage(
        pkg,
        manager(name),
        outputRoot,
        (command, args, cwd) => {
          calls.push({ command, args, cwd });
          return { status: 0, stdout: "", stderr: "" };
        },
      );

      assert.equal(artifact.manifest.name, pkg.name);
      assert.equal(artifact.manifest.version, pkg.version);
      assert.ok(
        artifact.entries.some((entry) => entry.path === "package/package.json"),
      );
      assert.equal(calls.length, 1);
      assert.equal(calls[0].cwd, pkgDir);

      if (name === "yarn") {
        assert.deepEqual(calls[0].args, [
          "pack",
          "--out",
          expectedTarball,
        ]);
      } else {
        assert.deepEqual(calls[0].args, [
          "pack",
          "--pack-destination",
          outputDir,
        ]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("packed identity mismatch fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-pack-mismatch-"));
  try {
    const pkgDir = join(root, "pkg");
    const outputRoot = join(root, "out");
    await mkdir(pkgDir, { recursive: true });
    const pkg = packageFixture(pkgDir);
    const outputDir = join(outputRoot, encodeURIComponent(pkg.name));
    await mkdir(outputDir, { recursive: true });
    await makeTarball(join(outputDir, "package.tgz"), {
      name: "@scope/other",
      version: pkg.version,
    });

    await assert.rejects(
      packPackage(
        pkg,
        manager("npm"),
        outputRoot,
        () => ({ status: 0, stdout: "", stderr: "" }),
      ),
      /Packed identity mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("tarball inspection exposes packed package.json and inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-pack-inspect-"));
  try {
    const archive = join(root, "package.tgz");
    await makeTarball(
      archive,
      { name: "fixture", version: "1.0.0" },
      { "bin/fixture.js": "console.log('ok')\n" },
    );

    const artifact = await inspectPackedTarball(archive);
    assert.equal(artifact.manifest.name, "fixture");
    assert.deepEqual(
      artifact.entries.map((entry) => entry.path).sort(),
      ["package/", "package/bin/", "package/bin/fixture.js", "package/package.json"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("source state detects content and status mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-pack-source-"));
  try {
    const run = (args) =>
      spawnSync("git", args, { cwd: root, encoding: "utf8" });

    assert.equal(run(["init"]).status, 0);
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    await writeFile(join(root, "package.json"), '{"name":"fixture","version":"1.0.0"}\n');
    assert.equal(run(["add", "."]).status, 0);

    const before = await snapshotSourceState(root);
    await writeFile(join(root, "package.json"), '{"name":"fixture","version":"1.0.1"}\n');
    const after = await snapshotSourceState(root);

    assert.throws(
      () => assertSourceStateUnchanged(before, after),
      /mutated the source worktree/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});


test("source state includes gitignored build artifacts but excludes node_modules churn", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-pack-ignored-source-"));
  try {
    const run = (args) =>
      spawnSync("git", args, { cwd: root, encoding: "utf8" });

    assert.equal(run(["init"]).status, 0);
    await mkdir(join(root, "dist"), { recursive: true });
    await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
    await writeFile(
      join(root, ".gitignore"),
      "dist/\nnode_modules/\n",
    );
    await writeFile(
      join(root, "package.json"),
      '{"name":"fixture","version":"1.0.0"}\n',
    );
    await writeFile(join(root, "dist", "bundle.js"), "before\n");
    await writeFile(
      join(root, "node_modules", "fixture", "cache"),
      "before\n",
    );
    assert.equal(run(["add", ".gitignore", "package.json"]).status, 0);

    const before = await snapshotSourceState(root);

    await writeFile(
      join(root, "node_modules", "fixture", "cache"),
      "after\n",
    );
    const nodeModulesOnly = await snapshotSourceState(root);
    assert.doesNotThrow(() =>
      assertSourceStateUnchanged(before, nodeModulesOnly),
    );

    await writeFile(join(root, "dist", "bundle.js"), "after\n");
    const ignoredBuildMutation = await snapshotSourceState(root);
    assert.throws(
      () =>
        assertSourceStateUnchanged(before, ignoredBuildMutation),
      /mutated the source worktree/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("packAllPackages fails when a successful pack mutates source", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-pack-all-"));
  try {
    const run = (args) =>
      spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(run(["init"]).status, 0);

    const pkgDir = root;
    const pkg = packageFixture(pkgDir, "fixture");
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.2.3",
        repository: "releaseway/example",
      }) + "\n",
    );
    assert.equal(run(["add", "package.json"]).status, 0);

    const outputRoot = join(root, ".artifacts");
    const outputDir = join(outputRoot, encodeURIComponent(pkg.name));
    await mkdir(outputDir, { recursive: true });
    await makeTarball(join(outputDir, "package.tgz"), {
      name: pkg.name,
      version: pkg.version,
    });

    await assert.rejects(
      packAllPackages(
        root,
        [pkg],
        manager("npm"),
        outputRoot,
        () => {
          writeFileSync(join(root, "package.json"), '{"name":"mutated","version":"9.9.9"}\n');
          return { status: 0, stdout: "", stderr: "" };
        },
      ),
      /mutated the source worktree/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});



test("packAllPackages checks source state after each package", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-pack-per-package-state-"));
  try {
    const run = (args) =>
      spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(run(["init"]).status, 0);

    const originalRootManifest =
      '{"private":true,"workspaces":["packages/*"]}\n';
    await writeFile(join(root, "package.json"), originalRootManifest);

    const packages = [];
    const outputRoot = join(root, ".artifacts");
    for (const name of ["a", "b"]) {
      const directory = join(root, "packages", name);
      await mkdir(directory, { recursive: true });
      const manifest = {
        name: "@scope/" + name,
        version: "1.0.0",
        repository: "releaseway/example",
      };
      await writeFile(
        join(directory, "package.json"),
        JSON.stringify(manifest) + "\n",
      );
      packages.push({
        directory,
        relativeDirectory: "packages/" + name,
        manifestPath: join(directory, "package.json"),
        manifest,
        name: manifest.name,
        version: manifest.version,
        publishMode: "direct",
      });

      const outputDir = join(outputRoot, encodeURIComponent(manifest.name));
      await mkdir(outputDir, { recursive: true });
      await makeTarball(join(outputDir, "package.tgz"), manifest);
    }
    assert.equal(run(["add", "package.json", "packages"]).status, 0);

    let calls = 0;
    await assert.rejects(
      packAllPackages(
        root,
        packages,
        manager("npm"),
        outputRoot,
        () => {
          calls += 1;
          if (calls === 1) {
            writeFileSync(
              join(root, "package.json"),
              '{"private":false}\n',
            );
          } else {
            writeFileSync(join(root, "package.json"), originalRootManifest);
          }
          return { status: 0, stdout: "", stderr: "" };
        },
      ),
      /mutated the source worktree/,
    );

    assert.equal(calls, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pnpm and Yarn project markers require exact root packageManager", async () => {
  const toolchain = {
    root: "/isolated",
    npmCli: "/isolated/npm/bin/npm-cli.js",
    corepackCli: "/isolated/corepack/dist/corepack.js",
    corepackHome: "/isolated/corepack-home",
  };

  for (const marker of ["pnpm-workspace.yaml", "pnpm-lock.yaml", "yarn.lock"]) {
    const root = await mkdtemp(join(tmpdir(), "releaseway-manager-marker-"));
    try {
      await writeFile(join(root, marker), "");
      await assert.rejects(
        resolvePackCommand({}, toolchain, root, {}),
        /require an exact root package\.json packageManager version/,
        marker,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("simple npm projects without packageManager use Releaseway npm", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-manager-npm-"));
  try {
    const toolchain = {
      root: "/isolated",
      npmCli: "/isolated/npm/bin/npm-cli.js",
      corepackCli: "/isolated/corepack/dist/corepack.js",
      corepackHome: "/isolated/corepack-home",
    };
    const command = await resolvePackCommand(
      {},
      toolchain,
      root,
      { PATH: "/malicious" },
    );

    assert.equal(command.name, "npm");
    assert.equal(command.executable, process.execPath);
    assert.deepEqual(command.argsPrefix, [toolchain.npmCli]);
    assert.equal(command.env.PATH, "/malicious");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
