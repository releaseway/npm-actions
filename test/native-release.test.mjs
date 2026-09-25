import assert from "node:assert/strict";
import test from "node:test";

import {
  expandReleaseTag,
  validateNativeDistribution,
} from "../src/native/validate.ts";
import { NativeReleaseResolver } from "../src/native/release.ts";

const SOURCE_SHA = "0123456789abcdef0123456789abcdef01234567";

function nativePackage(distributionOverrides = {}) {
  return {
    directory: "/workspace",
    relativeDirectory: ".",
    manifestPath: "/workspace/package.json",
    manifest: {
      name: "@scope/tool",
      version: "1.2.3",
      repository: "releaseway/example",
    },
    name: "@scope/tool",
    version: "1.2.3",
    publishMode: "direct",
    policy: {
      distribution: {
        type: "github-release",
        tag: "v{version}",
        targets: {
          "darwin-arm64": {
            asset: "tool_darwin_arm64.tar.gz",
            executable: "tool",
          },
          "linux-x64-gnu": {
            asset: "tool_linux_x64.tar.gz",
            executable: "bin/tool",
          },
        },
        ...distributionOverrides,
      },
    },
  };
}

function packedArtifact(bin = { tool: "bin/launcher.js" }) {
  return {
    tarballPath: "/tmp/tool.tgz",
    manifest: {
      name: "@scope/tool",
      version: "1.2.3",
      bin,
    },
    entries: [
      {
        path: "package/package.json",
        type: "File",
        mode: 0o644,
        size: 100,
      },
    ],
  };
}

function baseGithubState() {
  return {
    repository: { private: false },
    release: {
      tag_name: "v1.2.3",
      draft: false,
      immutable: true,
      published_at: "2026-09-24T00:00:00Z",
      assets: [
        {
          name: "tool_darwin_arm64.tar.gz",
          state: "uploaded",
          digest:
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
        {
          name: "tool_linux_x64.tar.gz",
          state: "uploaded",
          digest:
            "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      ],
    },
    ref: {
      object: {
        type: "commit",
        sha: SOURCE_SHA,
      },
    },
    tags: {},
  };
}

function fakeGithubFetch(state, requests = []) {
  return async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push({ url: url.toString(), init });

    const headers = new Headers(init.headers);
    assert.equal(headers.has("authorization"), false);

    let body;
    let status = 200;
    if (url.pathname === "/repos/releaseway/example") {
      body = state.repository;
    } else if (
      url.pathname === "/repos/releaseway/example/releases/tags/v1.2.3"
    ) {
      body = state.release;
    } else if (
      url.pathname === "/repos/releaseway/example/git/ref/tags/v1.2.3"
    ) {
      body = state.ref;
    } else if (
      url.pathname.startsWith("/repos/releaseway/example/git/tags/")
    ) {
      const sha = url.pathname.split("/").at(-1);
      body = state.tags[sha];
      if (!body) status = 404;
    } else {
      status = 404;
      body = { message: "Not Found" };
    }

    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

test("native distribution validation normalizes one bin and explicit targets", () => {
  const validated = validateNativeDistribution(
    nativePackage(),
    packedArtifact(),
  );

  assert.deepEqual(validated.bin, {
    command: "tool",
    path: "bin/launcher.js",
  });
  assert.equal(validated.tag, "v1.2.3");
  assert.deepEqual(Object.keys(validated.targets), [
    "darwin-arm64",
    "linux-x64-gnu",
  ]);

  assert.equal(expandReleaseTag("release-{version}", "1.2.3"), "release-1.2.3");
  assert.throws(
    () => expandReleaseTag("v{version}-{sha}", "1.2.3"),
    /unsupported template placeholder/,
  );
});

test("native validation rejects ambiguous or unsafe distribution contracts", () => {
  assert.throws(
    () => validateNativeDistribution(nativePackage(), packedArtifact({})),
    /exactly one npm bin entry/,
  );
  assert.throws(
    () =>
      validateNativeDistribution(
        nativePackage({
          targets: {
            "linux-x64": {
              asset: "tool.tar.gz",
              executable: "tool",
            },
          },
        }),
        packedArtifact(),
      ),
    /unsupported native target/,
  );
  assert.throws(
    () =>
      validateNativeDistribution(
        nativePackage({
          targets: {
            "darwin-arm64": {
              asset: "same.tar.gz",
              executable: "tool",
            },
            "linux-x64-gnu": {
              asset: "same.tar.gz",
              executable: "tool",
            },
          },
        }),
        packedArtifact(),
      ),
    /multiple native targets/,
  );
  assert.throws(
    () =>
      validateNativeDistribution(
        nativePackage({
          targets: {
            "linux-x64-gnu": {
              asset: "tool.tar.gz",
              executable: "../tool",
            },
          },
        }),
        packedArtifact(),
      ),
    /safe relative POSIX path/,
  );
  assert.throws(
    () =>
      validateNativeDistribution(
        nativePackage({
          targets: {
            "linux-x64-gnu": {
              asset: "tool.tar.xz",
              executable: "tool",
            },
          },
        }),
        packedArtifact(),
      ),
    /must be .tar.gz or .zip/,
  );
});

test("public immutable release provenance materializes fresh package results from one cached snapshot", async () => {
  const state = baseGithubState();
  const requests = [];
  const resolver = new NativeReleaseResolver(fakeGithubFetch(state, requests));
  const distribution = validateNativeDistribution(
    nativePackage(),
    packedArtifact(),
  );

  const first = await resolver.resolve(
    "releaseway/example",
    "1.2.3",
    SOURCE_SHA,
    distribution,
  );
  const count = requests.length;
  const second = await resolver.resolve(
    "releaseway/example",
    "1.2.3",
    SOURCE_SHA,
    distribution,
  );

  assert.notStrictEqual(first, second);
  assert.deepEqual(first, second);
  assert.equal(requests.length, count);
  assert.equal(first.repository, "releaseway/example");
  assert.equal(first.tag, "v1.2.3");
  assert.equal(
    first.targets["darwin-arm64"].sha256,
    "a".repeat(64),
  );
  assert.equal(
    first.targets["linux-x64-gnu"].sha256,
    "b".repeat(64),
  );
});

test("cached release snapshots do not reuse another package target mapping", async () => {
  const state = baseGithubState();
  state.release.assets.push({
    name: "tool_alt_linux_x64.tar.gz",
    state: "uploaded",
    digest:
      "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  });
  const requests = [];
  const resolver = new NativeReleaseResolver(fakeGithubFetch(state, requests));

  const firstDistribution = validateNativeDistribution(
    nativePackage({
      targets: {
        "linux-x64-gnu": {
          asset: "tool_linux_x64.tar.gz",
          executable: "bin/a",
        },
      },
    }),
    packedArtifact(),
  );
  const secondDistribution = validateNativeDistribution(
    nativePackage({
      targets: {
        "linux-x64-gnu": {
          asset: "tool_alt_linux_x64.tar.gz",
          executable: "bin/b",
        },
      },
    }),
    packedArtifact(),
  );

  const first = await resolver.resolve(
    "releaseway/example",
    "1.2.3",
    SOURCE_SHA,
    firstDistribution,
  );
  const requestCount = requests.length;
  const second = await resolver.resolve(
    "releaseway/example",
    "1.2.3",
    SOURCE_SHA,
    secondDistribution,
  );

  assert.equal(requests.length, requestCount);
  assert.notStrictEqual(first, second);
  assert.deepEqual(first.targets["linux-x64-gnu"], {
    asset: "tool_linux_x64.tar.gz",
    executable: "bin/a",
    sha256: "b".repeat(64),
  });
  assert.deepEqual(second.targets["linux-x64-gnu"], {
    asset: "tool_alt_linux_x64.tar.gz",
    executable: "bin/b",
    sha256: "c".repeat(64),
  });
});

test("cached release snapshots still validate missing package assets", async () => {
  const state = baseGithubState();
  const requests = [];
  const resolver = new NativeReleaseResolver(fakeGithubFetch(state, requests));

  await resolver.resolve(
    "releaseway/example",
    "1.2.3",
    SOURCE_SHA,
    validateNativeDistribution(nativePackage(), packedArtifact()),
  );
  const requestCount = requests.length;

  await assert.rejects(
    resolver.resolve(
      "releaseway/example",
      "1.2.3",
      SOURCE_SHA,
      validateNativeDistribution(
        nativePackage({
          targets: {
            "linux-x64-gnu": {
              asset: "missing.tar.gz",
              executable: "bin/tool",
            },
          },
        }),
        packedArtifact(),
      ),
    ),
    /exactly one uploaded GitHub Release asset/,
  );
  assert.equal(requests.length, requestCount);
});

test("cached release snapshots still validate each expected source commit", async () => {
  const state = baseGithubState();
  const requests = [];
  const resolver = new NativeReleaseResolver(fakeGithubFetch(state, requests));
  const distribution = validateNativeDistribution(
    nativePackage(),
    packedArtifact(),
  );

  await resolver.resolve(
    "releaseway/example",
    "1.2.3",
    SOURCE_SHA,
    distribution,
  );
  const requestCount = requests.length;

  await assert.rejects(
    resolver.resolve(
      "releaseway/example",
      "1.2.3",
      "ffffffffffffffffffffffffffffffffffffffff",
      distribution,
    ),
    /resolves to .* expected/,
  );
  assert.equal(requests.length, requestCount);
});

test("failed release snapshot loads are evicted so a later resolve can retry", async () => {
  const state = baseGithubState();
  const requests = [];
  const healthyFetch = fakeGithubFetch(state, requests);
  let failFirst = true;
  const fetch = async (input, init) => {
    if (failFirst) {
      failFirst = false;
      return new Response(JSON.stringify({ message: "temporary failure" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      });
    }
    return healthyFetch(input, init);
  };

  const resolver = new NativeReleaseResolver(fetch);
  const distribution = validateNativeDistribution(
    nativePackage(),
    packedArtifact(),
  );

  await assert.rejects(
    resolver.resolve(
      "releaseway/example",
      "1.2.3",
      SOURCE_SHA,
      distribution,
    ),
    /HTTP 503/,
  );

  const result = await resolver.resolve(
    "releaseway/example",
    "1.2.3",
    SOURCE_SHA,
    distribution,
  );
  assert.equal(result.targets["linux-x64-gnu"].sha256, "b".repeat(64));
  assert.ok(requests.length > 0);
});

test("annotated release tags are peeled to the source commit", async () => {
  const state = baseGithubState();
  const tagSha = "1111111111111111111111111111111111111111";
  state.ref = {
    object: {
      type: "tag",
      sha: tagSha,
    },
  };
  state.tags[tagSha] = {
    object: {
      type: "commit",
      sha: SOURCE_SHA,
    },
  };

  const resolver = new NativeReleaseResolver(fakeGithubFetch(state));
  const result = await resolver.resolve(
    "releaseway/example",
    "1.2.3",
    SOURCE_SHA,
    validateNativeDistribution(nativePackage(), packedArtifact()),
  );
  assert.equal(result.tag, "v1.2.3");
});

test("release provenance rejects private, mutable, wrong-commit, and invalid assets", async () => {
  const cases = [
    [
      "private repository",
      (state) => {
        state.repository.private = true;
      },
      /must be public/,
    ],
    [
      "mutable release",
      (state) => {
        state.release.immutable = false;
      },
      /must be immutable/,
    ],
    [
      "draft release",
      (state) => {
        state.release.draft = true;
      },
      /must be published/,
    ],
    [
      "wrong commit",
      (state) => {
        state.ref.object.sha =
          "ffffffffffffffffffffffffffffffffffffffff";
      },
      /resolves to .* expected/,
    ],
    [
      "missing asset",
      (state) => {
        state.release.assets.pop();
      },
      /exactly one uploaded GitHub Release asset/,
    ],
    [
      "duplicate asset",
      (state) => {
        state.release.assets.push({ ...state.release.assets[0] });
      },
      /exactly one uploaded GitHub Release asset/,
    ],
    [
      "non-uploaded asset",
      (state) => {
        state.release.assets[0].state = "starter";
      },
      /state must be uploaded/,
    ],
    [
      "bad digest",
      (state) => {
        state.release.assets[0].digest = "sha256:not-a-digest";
      },
      /valid SHA-256 digest/,
    ],
  ];

  for (const [label, mutate, pattern] of cases) {
    const state = baseGithubState();
    mutate(state);
    const resolver = new NativeReleaseResolver(fakeGithubFetch(state));

    await assert.rejects(
      resolver.resolve(
        "releaseway/example",
        "1.2.3",
        SOURCE_SHA,
        validateNativeDistribution(nativePackage(), packedArtifact()),
      ),
      pattern,
      label,
    );
  }
});
