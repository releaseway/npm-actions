import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  hasValidSha512Integrity,
  integrityContainsExactSha512,
  sha512Integrity,
} from "../src/registry/integrity.ts";
import {
  NpmRegistryClient,
  NPM_REGISTRY,
  parseRegistrySnapshot,
} from "../src/registry/client.ts";
const sri = (text) =>
  "sha512-" + createHash("sha512").update(text).digest("base64");
const integrity = sri("fixture");
function metadata(name = "pkg", versions = { "1.0.0": {} }, extra = {}) {
  return {
    name,
    versions: Object.fromEntries(
      Object.entries(versions).map(([version, fields]) => [
        version,
        { name, version, ...fields },
      ]),
    ),
    ...extra,
  };
}
const response = (body, status = 200) =>
  new Response(JSON.stringify(body), { status });
const clientFor = (body) =>
  new NpmRegistryClient({ fetchImpl: async () => response(body) });

test("SHA-512 helpers stream the exact file and reject weaker or corrupt values", async () => {
  const root = await mkdtemp(join(tmpdir(), "rw-registry-"));
  try {
    const file = join(root, "artifact.tgz");
    await writeFile(file, "fixture");
    assert.equal(await sha512Integrity(file), integrity);
    assert.ok(hasValidSha512Integrity(integrity));
    assert.ok(
      integrityContainsExactSha512("sha256-YQ== " + integrity, integrity),
    );
    assert.equal(integrityContainsExactSha512(sri("other"), integrity), false);
    assert.equal(hasValidSha512Integrity("sha512-YQ=="), false);
    assert.throws(
      () => integrityContainsExactSha512(integrity, "sha256-YQ=="),
      /must be SHA-512/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lookup uses exact version presence without local files, latest ordering or integrity equality", async () => {
  const client = clientFor(
    metadata(
      "pkg",
      { "1.0.0": {}, "9.0.0": { dist: { integrity: "sha1-legacy" } } },
      { "dist-tags": { latest: "9.0.0" } },
    ),
  );
  const lookup = await client.lookupVersion("pkg", "1.0.0");
  assert.equal(lookup.state, "already-published");
  assert.equal(lookup.manifest.version, "1.0.0");
  assert.equal(
    (await client.lookupVersion("pkg", "2.0.0")).state,
    "not-published",
  );
  assert.equal(
    (await client.lookupVersion("pkg", "9.0.0")).state,
    "already-published",
  );
  assert.equal(client.reconcile, undefined);
});

test("registry snapshots are owned immutable copies", () => {
  const raw = metadata("pkg", { "1.0.0": { dependencies: { dep: "*" } } });
  const snapshot = parseRegistrySnapshot("pkg", raw);
  raw.versions["1.0.0"].dependencies.dep = "mutated";
  assert.equal(snapshot.versions["1.0.0"].dependencies.dep, "*");
  assert.throws(() => {
    snapshot.versions["1.0.0"].version = "2.0.0";
  }, TypeError);
});

test("metadata reads are anonymous by default and propagate a bounded signal", async () => {
  let request;
  const client = new NpmRegistryClient({
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response(metadata("@scope/pkg"));
    },
  });
  await client.lookupVersion("@scope/pkg", "1.0.0");
  assert.equal(
    request.url,
    NPM_REGISTRY + "/" + encodeURIComponent("@scope/pkg"),
  );
  assert.equal(new Headers(request.init.headers).has("authorization"), false);
  assert.ok(request.init.signal instanceof AbortSignal);
});

test("read tokens are attached only to registry metadata requests", async () => {
  const client = new NpmRegistryClient({
    readToken: "read-only",
    fetchImpl: async (_url, init) => {
      assert.equal(
        new Headers(init.headers).get("authorization"),
        "Bearer read-only",
      );
      return response(metadata());
    },
  });
  assert.equal(
    (await client.lookupVersion("pkg", "2.0.0")).state,
    "not-published",
  );
});

test("package absence and HTTP failures never mean a version is available to publish", async () => {
  for (const status of [401, 403, 404, 429, 503]) {
    const client = new NpmRegistryClient({
      fetchImpl: async () => response({}, status),
    });
    await assert.rejects(
      client.lookupVersion("pkg", "1.0.0"),
      status === 404 ? /bootstrap/ : new RegExp("HTTP " + status),
    );
  }
});

test("malformed metadata and mismatched package or version identities fail closed", async () => {
  for (const raw of [
    null,
    [],
    {},
    { name: "pkg", versions: [] },
    metadata("other"),
    metadata("pkg", { "1.0.0": { name: "other" } }),
    metadata("pkg", { "1.0.0": { version: "2.0.0" } }),
    metadata("pkg", { bad: {} }),
    metadata("pkg", {}, { "dist-tags": { latest: "1.0.0" } }),
  ]) {
    await assert.rejects(clientFor(raw).lookupVersion("pkg", "1.0.0"));
  }
});

test("artifact verification compares the frozen expected digest only after lookup", async () => {
  const client = clientFor(
    metadata("pkg", { "1.0.0": { dist: { integrity } } }),
  );
  assert.equal(
    await client.verifyPublishedArtifact("pkg", "1.0.0", integrity),
    "matched",
  );
  assert.equal(
    await client.verifyPublishedArtifact("pkg", "2.0.0", integrity),
    "not-published",
  );
  await assert.rejects(
    client.verifyPublishedArtifact("pkg", "1.0.0", sri("other")),
    /different package artifact/,
  );
  await assert.rejects(
    client.verifyPublishedArtifact("pkg", "1.0.0", "sha256-YQ=="),
    /Expected artifact integrity/,
  );
});

test("prepared artifact verification requires remote SHA-512 even though initial lookup does not", async () => {
  for (const fields of [
    {},
    { dist: {} },
    { dist: { integrity: "sha1-legacy" } },
    { dist: { integrity: "sha512-YQ==" } },
    { dist: { integrity: sri("other") } },
  ]) {
    const client = clientFor(metadata("pkg", { "1.0.0": fields }));
    assert.equal(
      (await client.lookupVersion("pkg", "1.0.0")).state,
      "already-published",
    );
    await assert.rejects(
      client.verifyPublishedArtifact("pkg", "1.0.0", integrity),
    );
  }
});

test("verification refetches metadata rather than reusing the classification snapshot", async () => {
  let live = false;
  const client = new NpmRegistryClient({
    fetchImpl: async () =>
      response(
        metadata("pkg", live ? { "1.0.0": { dist: { integrity } } } : {}),
      ),
  });
  assert.equal(
    (await client.lookupVersion("pkg", "1.0.0")).state,
    "not-published",
  );
  live = true;
  assert.equal(
    await client.verifyPublishedArtifact("pkg", "1.0.0", integrity),
    "matched",
  );
});
