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
} from "../src/registry/client.ts";

function sri(bytes) {
  return "sha512-" + createHash("sha512").update(bytes).digest("base64");
}

async function withTarball(fn) {
  const root = await mkdtemp(join(tmpdir(), "releaseway-registry-"));
  const path = join(root, "package.tgz");
  const bytes = Buffer.from("exact-package-tarball");
  await writeFile(path, bytes);
  try {
    await fn({ path, bytes, integrity: sri(bytes) });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function response(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("SHA-512 SRI helpers require a valid exact SHA-512 value", async () => {
  await withTarball(async ({ path, bytes, integrity }) => {
    assert.equal(await sha512Integrity(path), integrity);
    assert.equal(hasValidSha512Integrity(integrity), true);
    assert.equal(
      integrityContainsExactSha512(
        "sha256-ZGVhZGJlZWY= " + integrity,
        integrity,
      ),
      true,
    );
    assert.equal(
      integrityContainsExactSha512(sri(Buffer.from("different")), integrity),
      false,
    );
    assert.equal(hasValidSha512Integrity("sha256-ZGVhZGJlZWY="), false);
    assert.throws(
      () => integrityContainsExactSha512(integrity, "sha256-ZGVhZGJlZWY="),
      /must be SHA-512 SRI/,
    );
    assert.equal(bytes.length > 0, true);
  });
});

test("public registry reconciliation is anonymous and accepts exact existing artifact", async () => {
  await withTarball(async ({ path, integrity }) => {
    const requests = [];
    const client = new NpmRegistryClient({
      fetchImpl: async (input, init = {}) => {
        requests.push({ input: String(input), init });
        return response({
          "dist-tags": { latest: "9.9.9", next: "1.2.3" },
          versions: {
            "1.2.3": {
              dist: {
                integrity,
              },
            },
          },
        });
      },
    });

    const result = await client.reconcile("@scope/pkg", "1.2.3", path);
    assert.equal(result.state, "existing");
    assert.equal(result.integrity, integrity);
    assert.equal(
      requests[0].input,
      NPM_REGISTRY + "/" + encodeURIComponent("@scope/pkg"),
    );
    const headers = new Headers(requests[0].init.headers);
    assert.equal(headers.has("authorization"), false);
  });
});

test("read token is scoped to registry metadata reads", async () => {
  await withTarball(async ({ path }) => {
    const client = new NpmRegistryClient({
      readToken: "read-only-token",
      fetchImpl: async (_input, init = {}) => {
        const headers = new Headers(init.headers);
        assert.equal(
          headers.get("authorization"),
          "Bearer read-only-token",
        );
        return response({ versions: {} });
      },
    });

    const result = await client.reconcile("pkg", "2.0.0", path);
    assert.equal(result.state, "candidate");
  });
});

test("package identity absence requires maintainer bootstrap", async () => {
  await withTarball(async ({ path }) => {
    const client = new NpmRegistryClient({
      fetchImpl: async () => response({ error: "Not found" }, 404),
    });

    await assert.rejects(
      client.reconcile("new-package", "1.0.0", path),
      /maintainer bootstrap and Trusted Publisher configuration are required/,
    );
  });
});

test("existing version fails for missing, weaker-only, malformed, or different integrity", async () => {
  await withTarball(async ({ path, integrity }) => {
    const cases = [
      ["missing dist", { versions: { "1.0.0": {} } }, /lacks dist/],
      [
        "missing integrity",
        { versions: { "1.0.0": { dist: {} } } },
        /lacks dist\.integrity/,
      ],
      [
        "weaker only",
        {
          versions: {
            "1.0.0": { dist: { integrity: "sha256-ZGVhZGJlZWY=" } },
          },
        },
        /no valid SHA-512/,
      ],
      [
        "malformed sha512",
        {
          versions: {
            "1.0.0": { dist: { integrity: "sha512-ZGVhZGJlZWY=" } },
          },
        },
        /no valid SHA-512/,
      ],
      [
        "different sha512",
        {
          versions: {
            "1.0.0": {
              dist: { integrity: sri(Buffer.from("different")) },
            },
          },
        },
        /different package artifact integrity/,
      ],
    ];

    for (const [label, metadata, pattern] of cases) {
      const client = new NpmRegistryClient({
        fetchImpl: async () => response(metadata),
      });
      await assert.rejects(
        client.reconcile("pkg", "1.0.0", path),
        pattern,
        label,
      );
    }

    const client = new NpmRegistryClient({
      fetchImpl: async () =>
        response({
          versions: {
            "1.0.0": {
              dist: { integrity: "sha256-ZGVhZGJlZWY= " + integrity },
            },
          },
        }),
    });
    assert.equal(
      (await client.reconcile("pkg", "1.0.0", path)).state,
      "existing",
    );
  });
});

test("dist-tag differences do not participate in immutable version equality", async () => {
  await withTarball(async ({ path, integrity }) => {
    const client = new NpmRegistryClient({
      fetchImpl: async () =>
        response({
          "dist-tags": {
            latest: "999.0.0",
            legacy: "1.2.3",
          },
          versions: {
            "1.2.3": {
              dist: { integrity },
            },
          },
        }),
    });

    assert.equal(
      (await client.reconcile("pkg", "1.2.3", path)).state,
      "existing",
    );
  });
});
