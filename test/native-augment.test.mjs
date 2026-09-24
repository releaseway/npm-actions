import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tar from "tar";

import {
  augmentNativeArtifact,
  NATIVE_MANIFEST_PATH,
  selectLauncherKind,
} from "../src/native/augment.ts";
import { validateNativeDistribution } from "../src/native/validate.ts";
import { inspectPackedTarball } from "../src/pack/inspect.ts";

async function makeInputTarball(root, manifest, extra = {}) {
  const source = join(root, "source");
  const packageRoot = join(source, "package");
  const archive = join(root, "input.tgz");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  for (const [relative, contents] of Object.entries(extra)) {
    const target = join(packageRoot, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  await tar.c(
    {
      cwd: source,
      file: archive,
      gzip: { level: 9 },
      portable: true,
      mtime: new Date(0),
    },
    ["package"],
  );
  return archive;
}

function packageModel(manifest) {
  return {
    directory: "/workspace",
    relativeDirectory: ".",
    manifestPath: "/workspace/package.json",
    manifest,
    name: manifest.name,
    version: manifest.version,
    publishMode: "direct",
    policy: {
      distribution: {
        type: "github-release",
        tag: "v{version}",
        targets: {
          "linux-x64-gnu": {
            asset: "tool_linux_x64.tar.gz",
            executable: "tool",
          },
          "darwin-arm64": {
            asset: "tool_darwin_arm64.tar.gz",
            executable: "bin/tool",
          },
        },
      },
    },
  };
}

function verifiedRelease() {
  return {
    repository: "releaseway/example",
    version: "1.2.3",
    tag: "v1.2.3",
    targets: {
      "linux-x64-gnu": {
        asset: "tool_linux_x64.tar.gz",
        executable: "tool",
        sha256: "b".repeat(64),
      },
      "darwin-arm64": {
        asset: "tool_darwin_arm64.tar.gz",
        executable: "bin/tool",
        sha256: "a".repeat(64),
      },
    },
  };
}

const launchers = {
  cjs: Buffer.from("#!/usr/bin/env node\nconsole.log('cjs');\n"),
  esm: Buffer.from("#!/usr/bin/env node\nconsole.log('esm');\n"),
};

test("launcher format follows Node 24 package type and supported bin extensions", () => {
  assert.equal(
    selectLauncherKind({ type: "module" }, "bin/tool"),
    "esm",
  );
  assert.equal(
    selectLauncherKind({ type: "commonjs" }, "bin/tool"),
    "cjs",
  );
  assert.equal(
    selectLauncherKind({}, "bin/tool"),
    "cjs",
  );
  assert.equal(
    selectLauncherKind({ type: "module" }, "bin/tool.js"),
    "esm",
  );
  assert.equal(
    selectLauncherKind({ type: "module" }, "bin/tool.cjs"),
    "cjs",
  );
  assert.equal(
    selectLauncherKind({}, "bin/tool.mjs"),
    "esm",
  );
  assert.throws(
    () => selectLauncherKind({ type: "module" }, "bin/tool.ts"),
    /must be extensionless or end in \.js, \.mjs, or \.cjs/,
  );
});

test("native augmentation is byte-deterministic and injects canonical manifest", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-native-augment-test-"));
  try {
    const manifest = {
      name: "@scope/tool",
      version: "1.2.3",
      bin: {
        tool: "bin/launcher.js",
      },
    };
    const input = await makeInputTarball(root, manifest, {
      "index.js": "export const value = 1;\n",
    });
    const inputBefore = await readFile(input);
    const artifact = await inspectPackedTarball(input);
    const pkg = packageModel(manifest);
    const distribution = validateNativeDistribution(pkg, artifact);

    const first = await augmentNativeArtifact(
      pkg,
      artifact,
      distribution,
      verifiedRelease(),
      join(root, "first.tgz"),
      launchers,
      { tempRoot: root },
    );
    const second = await augmentNativeArtifact(
      pkg,
      artifact,
      distribution,
      verifiedRelease(),
      join(root, "second.tgz"),
      launchers,
      { tempRoot: root },
    );

    assert.deepEqual(await readFile(first.tarballPath), await readFile(second.tarballPath));
    assert.deepEqual(await readFile(input), inputBefore);
    assert.equal(first.launcherKind, "cjs");
    assert.deepEqual(Object.keys(first.manifest.targets), [
      "darwin-arm64",
      "linux-x64-gnu",
    ]);

    const extracted = join(root, "extracted");
    await mkdir(extracted);
    await tar.x({ cwd: extracted, file: first.tarballPath, strict: true });

    assert.equal(
      await readFile(join(extracted, "package", "bin", "launcher.js"), "utf8"),
      launchers.cjs.toString("utf8"),
    );
    const launcherStat = await stat(
      join(extracted, "package", "bin", "launcher.js"),
    );
    assert.notEqual(launcherStat.mode & 0o111, 0);

    const generated = JSON.parse(
      await readFile(
        join(extracted, "package", ...NATIVE_MANIFEST_PATH.split("/")),
        "utf8",
      ),
    );
    assert.deepEqual(generated, first.manifest);
    assert.equal(
      generated.targets["darwin-arm64"].sha256,
      "a".repeat(64),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("type module .js bin receives the ESM launcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-native-esm-test-"));
  try {
    const manifest = {
      name: "@scope/tool",
      version: "1.2.3",
      type: "module",
      bin: {
        tool: "bin/launcher.js",
      },
    };
    const input = await makeInputTarball(root, manifest);
    const artifact = await inspectPackedTarball(input);
    const pkg = packageModel(manifest);
    const distribution = validateNativeDistribution(pkg, artifact);
    const result = await augmentNativeArtifact(
      pkg,
      artifact,
      distribution,
      verifiedRelease(),
      join(root, "output.tgz"),
      launchers,
      { tempRoot: root },
    );

    assert.equal(result.launcherKind, "esm");
    const extracted = join(root, "extracted");
    await mkdir(extracted);
    await tar.x({ cwd: extracted, file: result.tarballPath, strict: true });
    assert.equal(
      await readFile(join(extracted, "package", "bin", "launcher.js"), "utf8"),
      launchers.esm.toString("utf8"),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native augmentation never overwrites caller bin or manifest content", async () => {
  for (const reserved of ["bin/launcher.js", NATIVE_MANIFEST_PATH]) {
    const root = await mkdtemp(join(tmpdir(), "releaseway-native-reserved-"));
    try {
      const manifest = {
        name: "@scope/tool",
        version: "1.2.3",
        bin: {
          tool: "bin/launcher.js",
        },
      };
      const input = await makeInputTarball(root, manifest, {
        [reserved]: "caller content\n",
      });
      const artifact = await inspectPackedTarball(input);
      const pkg = packageModel(manifest);
      const distribution = validateNativeDistribution(pkg, artifact);

      await assert.rejects(
        augmentNativeArtifact(
          pkg,
          artifact,
          distribution,
          verifiedRelease(),
          join(root, "output.tgz"),
          launchers,
          { tempRoot: root },
        ),
        /cannot overwrite packed caller content/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("generated native manifest has a stable digest for identical provenance", () => {
  const release = verifiedRelease();
  const json = JSON.stringify({
    repository: release.repository,
    version: release.version,
    tag: release.tag,
    targets: Object.fromEntries(
      Object.entries(release.targets).sort(([a], [b]) => a.localeCompare(b)),
    ),
  });
  assert.equal(
    createHash("sha256").update(json).digest("hex").length,
    64,
  );
});
