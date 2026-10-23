import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import * as tar from "tar";
import { importArtifact } from "../src/artifacts/import.ts";
import { bindArtifacts, bytesIntegrity, loadArtifactManifest, parseArtifactManifest } from "../src/artifacts/manifest.ts";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "releaseway-artifact-test-"));
  const context = { workspace: root, repository: "owner/repo", sha: "a".repeat(40) };
  const manifest = { name: "@scope/a", version: "1.2.3", repository: "github:owner/repo" };
  const packageRoot = join(root, "source", "package");
  await mkdir(packageRoot, { recursive: true });
  const make = async (metadata = manifest, paths = ["package"]) => {
    await writeFile(join(packageRoot, "package.json"), JSON.stringify(metadata));
    await writeFile(join(packageRoot, "index.js"), "module.exports = 42;\n");
    const path = join(root, "input.tgz");
    await tar.c({ cwd: join(root, "source"), file: path, gzip: true, portable: true }, paths);
    return { name: manifest.name, version: manifest.version, tarball: "input.tgz", integrity: bytesIntegrity(await readFile(path)) };
  };
  const document = entry => ({ schema: 1, source: { repository: context.repository, commit: context.sha }, packages: [entry] });
  try { await run({ root, context, manifest, make, document, output: join(root, "owned", "0.tgz") }); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test("artifact manifest binds the original checkout even with a verified release marker", async () => fixture(async h => {
  const entry = await h.make();
  const path = join(h.root, "artifacts.json");
  await writeFile(path, JSON.stringify(h.document(entry)));
  const loaded = await loadArtifactManifest("artifacts.json", h.context, {});
  const packages = [{ name: entry.name, version: entry.version }];
  bindArtifacts(loaded, { ...h.context, sha: "b".repeat(40), sourceSha: h.context.sha }, packages, packages);
  assert.equal(loaded.integrity, bytesIntegrity(await readFile(path)));
  assert.ok(Object.isFrozen(loaded.manifest.packages[0]));
  assert.throws(() => bindArtifacts(loaded, { ...h.context, sha: "c".repeat(40) }, packages, packages), /source/);
  assert.throws(() => bindArtifacts(loaded, h.context, [], []), /outside/);
  assert.throws(() => bindArtifacts({ ...loaded, manifest: { ...loaded.manifest, packages: [] } }, h.context, packages, packages), /no artifact/);
}));

test("strict manifest rejects unknown shapes, noncanonical SRI, unsafe paths and duplicate identities", async () => fixture(async h => {
  const entry = await h.make();
  for (const doc of [null, [], { ...h.document(entry), schema: 2 }, { ...h.document(entry), extra: true },
    h.document({ ...entry, version: "v1.2.3" }), h.document({ ...entry, integrity: "sha1-test" }),
    h.document({ ...entry, integrity: entry.integrity + " " }), h.document({ ...entry, extra: true }),
    { ...h.document(entry), packages: [entry, entry] }]) {
    assert.throws(() => parseArtifactManifest(doc));
  }
  // 64 zero bytes have a final canonical 'A'; 'B' decodes to the same bytes but is not canonical.
  assert.throws(() => parseArtifactManifest(h.document({ ...entry, integrity: "sha512-" + "A".repeat(85) + "B==" })));
  for (const tarball of ["", "/a.tgz", "../a.tgz", "a/../a.tgz", "./a.tgz", "a//b.tgz", "a/", "C:/a.tgz", "a\\b.tgz", "https://example/a", "a\u0000.tgz"]) {
    assert.throws(() => parseArtifactManifest(h.document({ ...entry, tarball })));
  }
}));

test("import owns the exact compressed bytes and never follows later input changes", async () => fixture(async h => {
  const entry = await h.make();
  const original = await readFile(join(h.root, entry.tarball));
  const artifact = await importArtifact(h.root, entry, h.output, h.context.repository);
  assert.deepEqual(artifact.manifest, h.manifest);
  assert.deepEqual(await readFile(h.output), original);
  await writeFile(join(h.root, entry.tarball), "changed input");
  assert.deepEqual(await readFile(h.output), original);
  assert.ok(artifact.entries.some(e => e.path === "package/index.js"));
}));

test("digest, identity, duplicate manifest, private and corrupt archives fail and clean owned output", async () => fixture(async h => {
  let entry = await h.make();
  await assert.rejects(importArtifact(h.root, { ...entry, integrity: "sha512-" + Buffer.alloc(64).toString("base64") }, h.output, h.context.repository), /SHA-512/);
  for (const metadata of [{ ...h.manifest, name: "other" }, { ...h.manifest, version: "2.0.0" }, { ...h.manifest, repository: "owner/other" }, { ...h.manifest, private: true }]) {
    entry = await h.make(metadata);
    await assert.rejects(importArtifact(h.root, entry, h.output, h.context.repository), /identity/);
  }
  entry = await h.make(h.manifest, ["package/package.json", "package/package.json"]);
  await assert.rejects(importArtifact(h.root, entry, h.output, h.context.repository), /admission/);
  await writeFile(join(h.root, "input.tgz"), "not gzip");
  entry = { ...entry, integrity: bytesIntegrity(Buffer.from("not gzip")) };
  await assert.rejects(importArtifact(h.root, entry, h.output, h.context.repository), /admission/);
  await assert.rejects(readFile(h.output), { code: "ENOENT" });
}));

test("external manifest and tarball symlinks cannot escape the declared directory", async t => fixture(async h => {
  const entry = await h.make();
  try { await symlink(join(h.root, "input.tgz"), join(h.root, "link.tgz")); }
  catch (error) { if (process.platform === "win32" && error.code === "EPERM") return t.skip("Host disallows symlink creation"); throw error; }
  await assert.rejects(importArtifact(h.root, { ...entry, tarball: "link.tgz" }, h.output, h.context.repository), /regular/);
  await writeFile(join(h.root, "artifacts.json"), JSON.stringify(h.document(entry)));
  await symlink(join(h.root, "artifacts.json"), join(h.root, "link.json"));
  await assert.rejects(loadArtifactManifest("link.json", h.context, {}), /valid artifact manifest/);
  await assert.rejects(loadArtifactManifest(join(h.root, "artifacts.json"), { ...h.context, workspace: join(h.root, "other") }, {}), /valid artifact manifest/);
}));

test("oversized package metadata is rejected before publication", async () => fixture(async h => {
  const entry = await h.make({ ...h.manifest, description: "x".repeat(1024 ** 2) });
  await assert.rejects(importArtifact(h.root, entry, h.output, h.context.repository), /admission/);
}));
