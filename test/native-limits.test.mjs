import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as tar from "tar";
import { nativeLimits } from "../src/native/limits.ts";
import { withDeadline } from "../src/native/limits.ts";
import { NativeReleaseResolver } from "../src/native/release.ts";
import { bootstrapReleasewayToolchain } from "../src/toolchain/bootstrap.ts";
import { downloadReleaseAssetToFile } from "../src/native/launcher/download.ts";
import { extractTarGzExecutable, extractZipExecutable } from "../src/native/launcher/archive.ts";
import { prepareNativeExecutable } from "../src/native/launcher/cache.ts";
import yazl from "yazl";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

test("preparation budgets are adjustable positive safe integers", () => {
  assert.equal(nativeLimits({}).downloadTimeoutMs, 240_000);
  assert.equal(nativeLimits({ RELEASEWAY_NATIVE_MAX_ARCHIVE_BYTES: "12" }).maxArchiveBytes, 12);
  for (const value of ["0", "-1", "1.5", "no", "9007199254740992"]) {
    assert.throws(() => nativeLimits({ RELEASEWAY_NATIVE_DOWNLOAD_TIMEOUT_MS: value }), /positive safe integer/);
  }
});

test("API and toolchain header stalls expire and long valid budgets do not overflow timers", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-toolchain-budget-"));
  const stalled = () => new Promise(() => {});
  const env = { RELEASEWAY_NATIVE_API_TIMEOUT_MS: "10", RELEASEWAY_NATIVE_DOWNLOAD_TIMEOUT_MS: "10" };
  try {
    await assert.rejects(new NativeReleaseResolver(stalled, env).resolve("owner/repo", "1.0.0", "a".repeat(40), { tag: "v1.0.0", targets: {} }), /API.*preparation budget/);
    await assert.rejects(bootstrapReleasewayToolchain({ rootBase: root, fetchImpl: stalled, env }), /toolchain.*preparation budget/);
    assert.deepEqual(await readdir(root), []);
    assert.equal(await withDeadline("long budget", 2 ** 31, () => new Promise((done) => setTimeout(() => done("ok"), 10))), "ok");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real HTTP slow headers/body and oversized downloads cancel without a valid cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-http-budget-"));
  const server = createServer((req, res) => {
    if (req.url === "/headers") return;
    if (req.url === "/body") { res.writeHead(200); res.write("x"); return; }
    if (req.url === "/declared") { res.writeHead(200, { "Content-Length": "1000" }); res.end("x"); return; }
    if (req.url === "/stream") { res.write("12345678"); res.end("12345678"); return; }
    res.end("hello");
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  const digest = createHash("sha256").update("hello").digest("hex");
  try {
    for (const [endpoint, message] of [["headers", /preparation budget/], ["body", /preparation budget/], ["declared", /byte limit/], ["stream", /byte limit/]]) {
      await assert.rejects(downloadReleaseAssetToFile("owner/repo", "v1", "asset", join(root, endpoint), digest,
        { RELEASEWAY_NATIVE_DOWNLOAD_TIMEOUT_MS: "80", RELEASEWAY_NATIVE_MAX_ARCHIVE_BYTES: "10" },
        (_url, options) => fetch(url + "/" + endpoint, options)), message);
    }
    await downloadReleaseAssetToFile("owner/repo", "v1", "asset", join(root, "ok"), digest, {}, (_url, options) => fetch(url + "/ok", options));
    assert.equal(await readFile(join(root, "ok"), "utf8"), "hello");
    await assert.rejects(downloadReleaseAssetToFile("owner/repo", "v1", "asset", join(root, "digest"), "0".repeat(64), {}, (_url, options) => fetch(url + "/ok", options)), /digest mismatch/);
  } finally {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    await rm(root, { recursive: true, force: true });
  }
});

test("tar and zip reject oversized executables and total expansion", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-expand-budget-"));
  try {
    await writeFile(join(root, "tool"), "12345678");
    await writeFile(join(root, "other"), "12345678");
    await tar.c({ cwd: root, file: join(root, "asset.tar.gz"), gzip: true }, ["tool", "other"]);
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from("12345678"), "tool");
    zip.addBuffer(Buffer.from("12345678"), "other");
    const writing = pipeline(zip.outputStream, createWriteStream(join(root, "asset.zip")));
    zip.end();
    await writing;
    for (const [asset, extract] of [["asset.tar.gz", extractTarGzExecutable], ["asset.zip", extractZipExecutable]]) {
      await assert.rejects(extract(join(root, asset), "tool", { ...nativeLimits({}), maxExecutableBytes: 4 }), /executable exceeds/);
      await assert.rejects(extract(join(root, asset), "tool", { ...nativeLimits({}), maxExpandedBytes: 12 }), /expanded byte limit/);
      assert.equal((await extract(join(root, asset), "tool")).toString(), "12345678");
    }
    const bytes = await readFile(join(root, "asset.tar.gz"));
    const target = { asset: "asset.tar.gz", executable: "tool", sha256: createHash("sha256").update(bytes).digest("hex") };
    const manifest = { repository: "owner/repo", tag: "v1", version: "1.0.0", targets: { "linux-x64-gnu": target } };
    const cache = join(root, "cache");
    await assert.rejects(prepareNativeExecutable(manifest, target, { root: cache, env: { RELEASEWAY_NATIVE_DOWNLOAD_TIMEOUT_MS: "10" }, download: () => new Promise(() => {}) }), /preparation budget/);
    assert.deepEqual(await readdir(cache), [target.sha256]);
    assert.deepEqual(await readdir(join(cache, target.sha256)), ["executables"]);
    await assert.rejects(prepareNativeExecutable(manifest, target, { root: cache, env: { RELEASEWAY_NATIVE_MAX_EXECUTABLE_BYTES: "4" }, download: async () => bytes }), /executable exceeds/);
    assert.deepEqual(await readdir(join(cache, target.sha256, "executables")), []);
    const executable = await prepareNativeExecutable(manifest, target, { root: cache, download: async () => bytes });
    assert.equal(await readFile(executable, "utf8"), "12345678");
    assert.equal(await prepareNativeExecutable(manifest, target, { root: cache, download: () => { throw new Error("cache must avoid download"); } }), executable);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("extraction timeouts release cache locks and a long download keeps its active lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-extract-timeout-"));
  try {
    await writeFile(join(root, "tool"), randomBytes(2 * 1024 ** 2));
    const archive = join(root, "asset.tar.gz");
    await tar.c({ cwd: root, file: archive, gzip: true }, ["tool"]);
    const bytes = await readFile(archive);
    const target = { asset: "asset.tar.gz", executable: "tool", sha256: createHash("sha256").update(bytes).digest("hex") };
    const manifest = { repository: "owner/repo", version: "1.0.0", tag: "v1", targets: { "linux-x64-gnu": target } };
    const cache = join(root, "timeout-cache");
    await assert.rejects(prepareNativeExecutable(manifest, target, { root: cache, env: { RELEASEWAY_NATIVE_EXTRACT_TIMEOUT_MS: "1" }, download: async () => bytes }), /extraction.*preparation budget/);
    assert.deepEqual(await readdir(join(cache, target.sha256, "executables")), []);
    const recovered = await prepareNativeExecutable(manifest, target, { root: cache, download: () => { throw new Error("reuse verified archive"); } });
    assert.equal((await readFile(recovered)).length, 2 * 1024 ** 2);

    let start;
    const downloading = new Promise((done) => { start = done; });
    let downloads = 0;
    const options = { root: join(root, "heartbeat-cache"), lockStaleMs: 150, lockPollMs: 10, lockTimeoutMs: 2000, download: async () => {
      downloads++;
      start();
      await new Promise((done) => setTimeout(done, 450));
      return bytes;
    } };
    const first = prepareNativeExecutable(manifest, target, options);
    await downloading;
    await new Promise((done) => setTimeout(done, 250));
    const second = prepareNativeExecutable(manifest, target, options);
    const paths = await Promise.all([first, second]);
    assert.equal(paths[0], paths[1]);
    assert.equal(downloads, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
