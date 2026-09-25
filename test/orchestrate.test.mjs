import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  prepareRelease,
  executePreparedRelease,
  runRelease,
  waitForDirectLive,
} from "../src/orchestrate.ts";
import { NpmRegistryClient } from "../src/registry/client.ts";
import { sha512Integrity } from "../src/registry/integrity.ts";
import { PublishCommandError } from "../src/publish/index.ts";
const pkg = (name, fields = {}) => ({
  name,
  version: "1.0.0",
  repository: "releaseway/example",
  ...fields,
});

async function fixture(
  packages,
  fn,
  config = "schema: 1\npublish:\n  mode: direct\n",
) {
  const root = await mkdtemp(join(tmpdir(), "rw-orchestration-"));
  const events = [];
  const packed = new Map();
  const docs = new Map(
    packages.map((p) => [p.name, { name: p.name, versions: {} }]),
  );
  const put = (name, version, fields = {}) => {
    docs.get(name).versions[version] = { name, version, ...fields };
  };
  await mkdir(join(root, ".github/npm"), { recursive: true });
  await writeFile(join(root, ".github/npm/packages.yml"), config);
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ private: true, workspaces: ["packages/*"] }),
  );
  for (let i = 0; i < packages.length; i++) {
    const dir = join(root, "packages", String(i));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "package.json"), JSON.stringify(packages[i]));
  }
  const client = new NpmRegistryClient({
    fetchImpl: async (url) => {
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      return new Response(JSON.stringify(docs.get(name) ?? {}), {
        status: docs.has(name) ? 200 : 404,
      });
    },
  });
  const registry = {
    lookupVersion(...args) {
      events.push("lookup:" + args[0] + "@" + args[1]);
      return client.lookupVersion(...args);
    },
    verifyPublishedArtifact(...args) {
      events.push("verify:" + args[0]);
      return client.verifyPublishedArtifact(...args);
    },
  };
  const context = {
    workspace: root,
    repository: "releaseway/example",
    sha: "b".repeat(40),
    actionPath: resolve("."),
    env: {
      RUNNER_TEMP: root,
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture",
      NODE_AUTH_TOKEN: "read-only",
      NPM_TOKEN: "forbidden",
    },
  };
  const deps = {
    verifySource() {
      events.push("source");
    },
    registryClient: registry,
    bootstrapToolchain: async () => {
      events.push("bootstrap");
      return {
        root: "/isolated",
        npmCli: "/isolated/npm-cli.js",
        corepackCli: "/isolated/corepack.js",
        corepackHome: "/isolated/corepack-home",
      };
    },
    packAll: async (_workspace, candidates, command, output) => {
      events.push("pack:" + candidates.map((p) => p.name).join(","));
      assert.equal(command.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
      assert.equal(command.env.NPM_TOKEN, undefined);
      assert.equal(command.env.NODE_AUTH_TOKEN, "read-only");
      await mkdir(output, { recursive: true });
      const artifacts = [];
      for (const p of candidates) {
        const path = join(output, encodeURIComponent(p.name) + ".tgz");
        await writeFile(path, JSON.stringify(p.manifest));
        const artifact = {
          tarballPath: path,
          manifest: structuredClone(p.manifest),
          entries: [],
        };
        packed.set(p.name, artifact);
        artifacts.push(artifact);
      }
      return artifacts;
    },
    publish: async (_toolchain, request) => {
      events.push("publish:" + request.mode + ":" + request.name);
      assert.ok(Object.isFrozen(request));
      assert.ok(Object.isFrozen(request.publishOptions));
      if (request.mode === "direct")
        put(request.name, request.version, {
          dist: { integrity: request.integrity },
        });
      return request.mode === "direct" ? "direct-accepted" : "staged";
    },
  };
  const h = { root, context, deps, events, packed, docs, put, registry };
  try {
    await fn(h);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
const mutations = (events) => events.filter((e) => e.startsWith("publish:"));

test("all-published releases require no pack, native bundle, temporary toolchain or OIDC", async () => {
  await fixture(
    [pkg("native", { bin: "bin/tool.cjs" })],
    async (h) => {
      h.put("native", "1.0.0", { dist: { integrity: "sha1-historical" } });
      h.context.env = {};
      h.context.actionPath = "/missing-action";
      h.deps.nativeResolver = {
        resolve() {
          assert.fail("must not inspect an old release");
        },
      };
      const before = await readdir(h.root);
      const result = await runRelease(h.context, h.deps);
      assert.deepEqual(result, [
        { name: "native", version: "1.0.0", state: "already-published" },
      ]);
      assert.deepEqual(h.events, ["source", "lookup:native@1.0.0"]);
      assert.deepEqual(await readdir(h.root), before);
    },
    "schema: 1\npackages:\n  native:\n    distribution:\n      type: github-release\n      tag: v{version}\n      targets:\n        linux-x64-gnu:\n          asset: native.tar.gz\n          executable: tool\n",
  );
});

test("all version lookups precede toolchain provisioning and only candidates are packed", async () => {
  await fixture([pkg("a-old"), pkg("b-new"), pkg("c-new")], async (h) => {
    h.put("a-old", "1.0.0", { dependencies: { remote: "*" } });
    const result = await runRelease(h.context, h.deps);
    assert.deepEqual(
      result.map((r) => r.state),
      ["already-published", "published", "published"],
    );
    assert.ok(
      h.events.indexOf("lookup:c-new@1.0.0") < h.events.indexOf("bootstrap"),
    );
    assert.ok(h.events.includes("pack:b-new,c-new"));
    assert.equal(h.packed.has("a-old"), false);
  });
});

test("old native versions do not block a different package on a later commit", async () => {
  await fixture(
    [
      pkg("a-native", { bin: "bin/tool.cjs" }),
      pkg("b-lib", { version: "1.0.1" }),
    ],
    async (h) => {
      h.put("a-native", "1.0.0");
      h.deps.nativeResolver = {
        resolve() {
          assert.fail("old native release must not be resolved");
        },
      };
      const result = await runRelease(h.context, h.deps);
      assert.equal(result[0].state, "already-published");
      assert.equal(result[1].state, "published");
      assert.deepEqual([...h.packed.keys()], ["b-lib"]);
    },
    "schema: 1\npublish:\n  mode: direct\npackages:\n  a-native:\n    distribution:\n      type: github-release\n      tag: v{version}\n      targets:\n        linux-x64-gnu:\n          asset: native.tar.gz\n          executable: tool\n",
  );
});

test("registry preflight errors block all package-manager and publish operations", async () => {
  await fixture([pkg("a"), pkg("z")], async (h) => {
    h.docs.delete("z");
    await assert.rejects(runRelease(h.context, h.deps), /bootstrap/);
    assert.equal(h.events.includes("bootstrap"), false);
    assert.deepEqual(mutations(h.events), []);
  });
});

test("invalid late candidate options cause zero publication mutations", async () => {
  await fixture(
    [pkg("a"), pkg("z", { version: "1.0.0-beta.1" })],
    async (h) => {
      await assert.rejects(
        runRelease(h.context, h.deps),
        /requires explicit publishConfig.tag/,
      );
      assert.deepEqual(mutations(h.events), []);
    },
  );
});

test("direct consumer of only a staged required candidate fails all-preflight", async () => {
  await fixture(
    [pkg("app", { dependencies: { dep: "1.0.0" } }), pkg("dep")],
    async (h) => {
      await assert.rejects(
        runRelease(h.context, h.deps),
        /only a staged candidate/,
      );
      assert.deepEqual(mutations(h.events), []);
    },
    "schema: 1\npublish:\n  mode: direct\npackages:\n  dep:\n    publish:\n      mode: stage\n",
  );
});

test("direct consumer can use an older live version instead of a staged candidate", async () => {
  await fixture(
    [
      pkg("app", { dependencies: { dep: "^1.0.0" } }),
      pkg("dep", { version: "1.1.0" }),
    ],
    async (h) => {
      h.put("dep", "1.0.0");
      const result = await runRelease(h.context, h.deps);
      assert.deepEqual(
        result.map((r) => r.state),
        ["published", "staged"],
      );
      assert.ok(h.events.includes("lookup:dep@1.0.0"));
    },
    "schema: 1\npublish:\n  mode: direct\npackages:\n  dep:\n    publish:\n      mode: stage\n",
  );
});

test("alias dependency is made live and verified before its direct consumer", async () => {
  await fixture(
    [
      pkg("a-app", { dependencies: { renamed: "npm:z-dep@1.0.0" } }),
      pkg("z-dep"),
    ],
    async (h) => {
      const result = await runRelease(h.context, h.deps);
      assert.deepEqual(
        result.map((r) => r.name),
        ["z-dep", "a-app"],
      );
      assert.ok(
        h.events.indexOf("publish:direct:z-dep") <
          h.events.lastIndexOf("lookup:z-dep@1.0.0"),
      );
      assert.ok(
        h.events.lastIndexOf("lookup:z-dep@1.0.0") <
          h.events.indexOf("publish:direct:a-app"),
      );
    },
  );
});

test("plans own frozen manifests, options and digests independent of mutable pack results", async () => {
  await fixture([pkg("app")], async (h) => {
    const plan = await prepareRelease(h.context, h.deps);
    assert.equal(plan.kind, "ready");
    h.packed.get("app").manifest.version = "9.0.0";
    assert.equal(plan.publications[0].manifest.version, "1.0.0");
    assert.throws(() => {
      plan.publications[0].request.publishOptions.tag = "other";
    }, TypeError);
    assert.equal(
      plan.publications[0].request.integrity,
      await sha512Integrity(h.packed.get("app").tarballPath),
    );
  });
});

test("identical race before mutation is accepted only as a verified planned artifact", async () => {
  await fixture([pkg("app")], async (h) => {
    const plan = await prepareRelease(h.context, h.deps);
    h.put("app", "1.0.0", {
      dist: { integrity: plan.publications[0].request.integrity },
    });
    assert.equal(
      (await executePreparedRelease(h.context, plan, h.deps))[0].state,
      "published",
    );
    assert.deepEqual(mutations(h.events), []);
  });
});

test("different race before mutation fails instead of becoming already-published", async () => {
  await fixture([pkg("app")], async (h) => {
    const plan = await prepareRelease(h.context, h.deps);
    h.put("app", "1.0.0", {
      dist: { integrity: "sha512-" + Buffer.alloc(64).toString("base64") },
    });
    await assert.rejects(
      executePreparedRelease(h.context, plan, h.deps),
      /different package artifact/,
    );
    assert.deepEqual(mutations(h.events), []);
  });
});

test("mutating any prepared tarball stops the whole plan before its first write", async () => {
  await fixture([pkg("a"), pkg("z")], async (h) => {
    const plan = await prepareRelease(h.context, h.deps);
    await writeFile(plan.publications[1].request.tarballPath, "altered");
    await assert.rejects(
      executePreparedRelease(h.context, plan, h.deps),
      /Prepared tarball changed/,
    );
    assert.deepEqual(mutations(h.events), []);
  });
});

test("vanished required live versions prevent a new direct mutation", async () => {
  await fixture(
    [pkg("app", { dependencies: { dep: "1.0.0" } }), pkg("dep")],
    async (h) => {
      h.put("dep", "1.0.0");
      const plan = await prepareRelease(h.context, h.deps);
      delete h.docs.get("dep").versions["1.0.0"];
      await assert.rejects(
        executePreparedRelease(h.context, plan, h.deps),
        /no longer live/,
      );
      assert.deepEqual(mutations(h.events), []);
    },
  );
});

test("a failed write is reconciled by exact live digest without retrying publication", async () => {
  await fixture([pkg("app")], async (h) => {
    let writes = 0;
    h.deps.publish = async (_tc, request) => {
      writes++;
      h.put("app", "1.0.0", { dist: { integrity: request.integrity } });
      throw new Error("lost response");
    };
    assert.equal((await runRelease(h.context, h.deps))[0].state, "published");
    assert.equal(writes, 1);
  });
});

test("unresolved stage conflicts fail without approval, inspection or mode conversion", async () => {
  await fixture(
    [pkg("app")],
    async (h) => {
      let writes = 0;
      h.deps.publish = async (_tc, request) => {
        writes++;
        throw new PublishCommandError(
          request,
          "E409 Cannot publish over previously staged version",
        );
      };
      await assert.rejects(runRelease(h.context, h.deps), /E409/);
      assert.equal(writes, 1);
    },
    "schema: 1\npublish:\n  mode: stage\n",
  );
});

test("partial failures report completed candidates and reruns skip public versions", async () => {
  await fixture([pkg("a"), pkg("z")], async (h) => {
    const publish = h.deps.publish;
    h.deps.publish = async (tc, request) => {
      if (request.name === "z") throw new Error("outage");
      return publish(tc, request);
    };
    await assert.rejects(
      runRelease(h.context, h.deps),
      /completed before failure: a@1.0.0\(published\)/,
    );
    h.deps.publish = publish;
    h.events.length = 0;
    const result = await runRelease(h.context, h.deps);
    assert.deepEqual(
      result.map((r) => r.state),
      ["already-published", "published"],
    );
    assert.ok(h.events.includes("pack:z"));
  });
});

test("direct visibility polling reuses the frozen digest and respects the deadline", async () => {
  let clock = 0;
  let calls = 0;
  const registry = {
    async verifyPublishedArtifact(_name, _version, expected, options) {
      calls++;
      assert.equal(expected, "frozen");
      assert.ok(options.signal);
      return calls === 3 ? "matched" : "not-published";
    },
  };
  await waitForDirectLive(registry, "pkg", "1.0.0", "frozen", {
    timeoutMs: 100,
    pollMs: 10,
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });
  assert.equal(calls, 3);
  await assert.rejects(
    waitForDirectLive(
      {
        verifyPublishedArtifact: async () => {
          clock += 100;
          return "matched";
        },
      },
      "pkg",
      "1.0.0",
      "frozen",
      { timeoutMs: 5, now: () => clock },
    ),
    /visibility budget/,
  );
});

test("an empty publication workspace is still a preflight error", async () => {
  await fixture([], async (h) => {
    await assert.rejects(runRelease(h.context, h.deps), /No publishable/);
    assert.equal(h.events.includes("bootstrap"), false);
  });
});
