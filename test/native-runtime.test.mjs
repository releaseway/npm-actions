import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import test from "node:test";
import * as tar from "tar";
import yazl from "yazl";

import {
  extractTarGzExecutable,
  extractZipExecutable,
  normalizeArchivePath,
} from "../src/native/launcher/archive.ts";
import {
  nativeCacheRoot,
  prepareNativeExecutable,
} from "../src/native/launcher/cache.ts";
import {
  releaseAssetUrl,
  verifySha256,
} from "../src/native/launcher/download.ts";
import {
  loadNativeManifest,
  parseNativeManifest,
} from "../src/native/launcher/manifest.ts";
import { runNativeLauncher } from "../src/native/launcher/runtime.ts";
import {
  detectLinuxLibc,
  detectNativeTarget,
} from "../src/native/launcher/target.ts";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function makeTarGz(root, entries) {
  const source = join(root, "tar-source");
  await mkdir(source, { recursive: true });

  for (const entry of entries) {
    const path = join(source, entry.path);
    await mkdir(join(path, ".."), { recursive: true });
    if (entry.type === "symlink") {
      await symlink(entry.target, path);
    } else {
      await writeFile(path, entry.contents);
    }
  }

  const archive = join(root, "fixture.tar.gz");
  await tar.c(
    {
      cwd: source,
      file: archive,
      gzip: true,
      portable: true,
    },
    ["."],
  );
  return archive;
}

async function makeZip(root, configure) {
  await mkdir(root, { recursive: true });
  const archive = join(root, "fixture.zip");
  const zip = new yazl.ZipFile();
  configure(zip);
  const writing = pipeline(zip.outputStream, createWriteStream(archive));
  zip.end();
  await writing;
  return archive;
}

function runtimeManifest(target) {
  return {
    repository: "releaseway/example",
    version: "1.2.3",
    tag: "v1.2.3",
    targets: {
      "linux-x64-gnu": target,
    },
  };
}

test("target detection covers supported OS/architecture/libc combinations", () => {
  assert.equal(
    detectNativeTarget({ platform: "darwin", arch: "arm64" }),
    "darwin-arm64",
  );
  assert.equal(
    detectNativeTarget({ platform: "win32", arch: "x64" }),
    "win32-x64",
  );
  assert.equal(
    detectNativeTarget({
      platform: "linux",
      arch: "x64",
      report: () => ({ header: { glibcVersionRuntime: "2.39" } }),
    }),
    "linux-x64-gnu",
  );
  assert.equal(
    detectNativeTarget({
      platform: "linux",
      arch: "arm64",
      report: () => ({ header: {} }),
      runLdd: () => ({ stdout: "", stderr: "musl libc (aarch64)" }),
    }),
    "linux-arm64-musl",
  );

  assert.equal(
    detectLinuxLibc({
      report: () => ({ header: {} }),
      runLdd: () => ({ stdout: "ldd (GNU libc) 2.39", stderr: "" }),
    }),
    "gnu",
  );

  assert.throws(
    () =>
      detectNativeTarget({
        platform: "linux",
        arch: "x64",
        report: () => ({ header: {} }),
        runLdd: () => ({ stdout: "unknown", stderr: "" }),
      }),
    /Unable to determine Linux libc/,
  );
  assert.throws(
    () => detectNativeTarget({ platform: "freebsd", arch: "x64" }),
    /Unsupported native platform/,
  );
  assert.throws(
    () => detectNativeTarget({ platform: "darwin", arch: "ia32" }),
    /Unsupported native architecture/,
  );
});

test("native manifest parsing and explicit loading are strict", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-native-manifest-"));
  try {
    const manifestPath = join(root, ".releaseway", "native.json");
    await mkdir(join(root, ".releaseway"), { recursive: true });
    const manifest = runtimeManifest({
      asset: "tool.tar.gz",
      executable: "bin/tool",
      sha256: "a".repeat(64),
    });
    await writeFile(manifestPath, JSON.stringify(manifest));

    assert.deepEqual(await loadNativeManifest(manifestPath), manifest);
    await assert.rejects(
      loadNativeManifest(join(root, "missing", "native.json")),
      /Failed to read native runtime manifest/,
    );

    assert.throws(
      () =>
        parseNativeManifest({
          ...manifest,
          targets: {
            "linux-x64": manifest.targets["linux-x64-gnu"],
          },
        }),
      /unsupported native target/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive path normalization rejects traversal and absolute paths", () => {
  assert.equal(normalizeArchivePath("./bin/tool"), "bin/tool");
  for (const invalid of [
    "../tool",
    "bin/../../tool",
    "/absolute/tool",
    "C:/tool.exe",
    "bin\\tool",
  ]) {
    assert.throws(
      () => normalizeArchivePath(invalid),
      /Unsafe archive entry path/,
      invalid,
    );
  }
});

test("tar.gz extraction returns exactly one regular executable and rejects links", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-native-tar-"));
  try {
    const archive = await makeTarGz(root, [
      { type: "file", path: "bin/tool", contents: "binary" },
      { type: "file", path: "README", contents: "docs" },
    ]);
    assert.equal(
      (await extractTarGzExecutable(archive, "bin/tool")).toString(),
      "binary",
    );

    const linked = await makeTarGz(join(root, "linked"), [
      { type: "file", path: "bin/tool", contents: "binary" },
      { type: "symlink", path: "bin/link", target: "tool" },
    ]);
    await assert.rejects(
      extractTarGzExecutable(linked, "bin/tool"),
      /Unsupported non-regular tar entry/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zip extraction returns the configured regular executable and rejects symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-native-zip-"));
  try {
    const archive = await makeZip(root, (zip) => {
      zip.addBuffer(Buffer.from("binary"), "bin/tool.exe");
      zip.addBuffer(Buffer.from("docs"), "README.txt");
    });
    assert.equal(
      (await extractZipExecutable(archive, "bin/tool.exe")).toString(),
      "binary",
    );

    const linked = await makeZip(join(root, "linked"), (zip) => {
      zip.addBuffer(Buffer.from("binary"), "bin/tool");
      zip.addBuffer(Buffer.from("tool"), "bin/link", {
        mode: 0o120777,
      });
    });
    await assert.rejects(
      extractZipExecutable(linked, "bin/tool"),
      /Unsupported non-regular zip entry/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release asset download URL is public and SHA-256 verification is exact", () => {
  assert.equal(
    releaseAssetUrl(
      "releaseway/example",
      "v1.2.3",
      "tool linux.tar.gz",
    ),
    "https://github.com/releaseway/example/releases/download/v1.2.3/tool%20linux.tar.gz",
  );
  const bytes = Buffer.from("asset");
  verifySha256(bytes, sha256(bytes));
  assert.throws(
    () => verifySha256(Buffer.from("other"), sha256(bytes)),
    /digest mismatch/,
  );
});

test("cache roots follow platform-native locations", () => {
  assert.equal(
    nativeCacheRoot({
      platform: "linux",
      env: { XDG_CACHE_HOME: "/cache" },
      home: "/home/user",
    }),
    "/cache/releaseway/npm-actions/native/sha256",
  );
  assert.equal(
    nativeCacheRoot({
      platform: "linux",
      env: {},
      home: "/home/user",
    }),
    "/home/user/.cache/releaseway/npm-actions/native/sha256",
  );
  assert.equal(
    nativeCacheRoot({
      platform: "darwin",
      env: {},
      home: "/Users/user",
    }),
    "/Users/user/Library/Caches/releaseway/npm-actions/native/sha256",
  );
  assert.throws(
    () =>
      nativeCacheRoot({
        platform: "win32",
        env: {},
        home: "C:\\Users\\user",
      }),
    /LOCALAPPDATA is required/,
  );
});

test("native cache handles first run, cache hit, corruption, and concurrent promotion", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-native-cache-test-"));
  try {
    const archivePath = await makeTarGz(root, [
      { type: "file", path: "bin/tool", contents: "native-binary" },
    ]);
    const archiveBytes = await readFile(archivePath);
    const target = {
      asset: "tool.tar.gz",
      executable: "bin/tool",
      sha256: sha256(archiveBytes),
    };
    const manifest = runtimeManifest(target);
    const cacheRoot = join(root, "cache");

    let downloads = 0;
    const download = async () => {
      downloads += 1;
      return archiveBytes;
    };

    const first = await prepareNativeExecutable(manifest, target, {
      root: cacheRoot,
      platform: "linux",
      download,
    });
    assert.equal(await readFile(first, "utf8"), "native-binary");
    assert.equal(downloads, 1);

    const second = await prepareNativeExecutable(manifest, target, {
      root: cacheRoot,
      platform: "linux",
      download,
    });
    assert.equal(second, first);
    assert.equal(downloads, 1);

    await writeFile(first, "corrupt");
    const repaired = await prepareNativeExecutable(manifest, target, {
      root: cacheRoot,
      platform: "linux",
      download,
    });
    assert.equal(repaired, first);
    assert.equal(await readFile(repaired, "utf8"), "native-binary");
    assert.equal(downloads, 2);

    const otherCache = join(root, "concurrent-cache");
    downloads = 0;
    const [a, b] = await Promise.all([
      prepareNativeExecutable(manifest, target, {
        root: otherCache,
        platform: "linux",
        download,
      }),
      prepareNativeExecutable(manifest, target, {
        root: otherCache,
        platform: "linux",
        download,
      }),
    ]);
    assert.equal(a, b);
    assert.equal(await readFile(a, "utf8"), "native-binary");
    assert.equal(downloads, 1);

    await writeFile(a, "corrupt");
    downloads = 0;
    let enteredResolve;
    let releaseResolve;
    const entered = new Promise((resolve) => {
      enteredResolve = resolve;
    });
    const releaseDownload = new Promise((resolve) => {
      releaseResolve = resolve;
    });
    const slowDownload = async () => {
      downloads += 1;
      enteredResolve();
      await releaseDownload;
      return archiveBytes;
    };

    const repairA = prepareNativeExecutable(manifest, target, {
      root: otherCache,
      platform: "linux",
      download: slowDownload,
      lockPollMs: 1,
    });
    await entered;
    const repairB = prepareNativeExecutable(manifest, target, {
      root: otherCache,
      platform: "linux",
      download: slowDownload,
      lockPollMs: 1,
    });
    releaseResolve();

    const [repairedA, repairedB] = await Promise.all([
      repairA,
      repairB,
    ]);
    assert.equal(repairedA, repairedB);
    assert.equal(await readFile(repairedA, "utf8"), "native-binary");
    assert.equal(downloads, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native launcher forwards argv and exit status to selected executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-native-runner-"));
  try {
    const manifestPath = join(root, ".releaseway", "native.json");
    await mkdir(join(root, ".releaseway"), { recursive: true });
    await writeFile(
      manifestPath,
      JSON.stringify(
        runtimeManifest({
          asset: "tool.tar.gz",
          executable: "tool",
          sha256: "a".repeat(64),
        }),
      ),
    );

    const calls = [];
    const status = await runNativeLauncher({
      manifestPath,
      target: "linux-x64-gnu",
      args: ["--version", "value"],
      prepare: async () => "/cache/tool",
      spawn(executable, args, options) {
        calls.push({ executable, args, options });
        return {
          status: 7,
          signal: null,
          error: undefined,
          output: [],
          pid: 1,
          stdout: null,
          stderr: null,
        };
      },
    });

    assert.equal(status, 7);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, "/cache/tool");
    assert.deepEqual(calls[0].args, ["--version", "value"]);
    assert.equal(calls[0].options.stdio, "inherit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
