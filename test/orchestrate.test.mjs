import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runRelease } from "../src/orchestrate.ts";

async function createWorkspace() {
  const root = await mkdtemp(join(tmpdir(), "releaseway-orchestrate-"));
  await mkdir(join(root, ".github", "npm"), { recursive: true });
  await mkdir(join(root, "packages", "a"), { recursive: true });
  await mkdir(join(root, "packages", "b"), { recursive: true });
  await mkdir(join(root, "packages", "c"), { recursive: true });

  await writeFile(
    join(root, "package.json"),
    JSON.stringify(
      {
        private: true,
        workspaces: ["packages/*"],
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(root, ".github", "npm", "packages.yml"),
    [
      "schema: 1",
      "publish:",
      "  mode: direct",
      "packages:",
      '  "@scope/c":',
      "    publish:",
      "      mode: stage",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "packages", "a", "package.json"),
    JSON.stringify(
      {
        name: "@scope/a",
        version: "1.0.0",
        repository: "releaseway/example",
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(root, "packages", "b", "package.json"),
    JSON.stringify(
      {
        name: "@scope/b",
        version: "2.0.0",
        repository: "releaseway/example",
      },
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(root, "packages", "c", "package.json"),
    JSON.stringify(
      {
        name: "@scope/c",
        version: "3.0.0",
        repository: "releaseway/example",
        dependencies: {
          "@scope/b": "^2.0.0",
        },
      },
      null,
      2,
    ) + "\n",
  );

  return root;
}

function context(root) {
  return {
    workspace: root,
    repository: "releaseway/example",
    sha: "0123456789abcdef0123456789abcdef01234567",
    actionPath: root,
    env: {
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
      NODE_AUTH_TOKEN: "read-only-token",
      NPM_TOKEN: "must-not-reach-pack",
      RUNNER_TEMP: root,
    },
  };
}

function toolchain() {
  return {
    root: "/isolated",
    npmCli: "/isolated/npm/bin/npm-cli.js",
    corepackCli: "/isolated/corepack/dist/corepack.js",
    corepackHome: "/isolated/corepack-home",
  };
}

function fakePackAll(events) {
  return async (_workspace, packages, command) => {
    events.push("pack-all");
    events.push(
      "pack-oidc:" +
        (command.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN ? "present" : "absent"),
    );
    events.push(
      "pack-read-token:" + String(command.env.NODE_AUTH_TOKEN ?? "absent"),
    );
    events.push(
      "pack-publish-token:" + String(command.env.NPM_TOKEN ?? "absent"),
    );
    return packages.map((pkg) => ({
      tarballPath: "/artifacts/" + encodeURIComponent(pkg.name) + ".tgz",
      manifest: {
        ...pkg.manifest,
      },
      entries: [
        {
          path: "package/package.json",
          type: "File",
          mode: 0o644,
          size: 100,
        },
      ],
    }));
  };
}

function dependenciesFor(states, events, publishImpl) {
  return {
    verifySource() {
      events.push("verify-source");
    },
    bootstrapToolchain: async () => {
      events.push("bootstrap-toolchain");
      return toolchain();
    },
    packAll: fakePackAll(events),
    registryClient: {
      async reconcile(name, version) {
        events.push("registry:" + name);
        const state = states[name];
        if (state instanceof Error) {
          throw state;
        }
        if (!state) {
          throw new Error("missing test state for " + name);
        }
        return {
          ...state,
          name,
          version,
          integrity: "sha512-" + "A".repeat(88),
        };
      },
    },
    publish:
      publishImpl ??
      (async (_toolchain, request) => {
        events.push("publish:" + request.name);
        return request.mode === "stage" ? "staged" : "published";
      }),
  };
}

test("orchestration completes all preflight before the first mutation", async () => {
  const root = await createWorkspace();
  const events = [];

  try {
    const result = await runRelease(
      context(root),
      dependenciesFor(
        {
          "@scope/a": { state: "existing" },
          "@scope/b": { state: "candidate", latestVersion: "1.0.0" },
          "@scope/c": { state: "candidate", latestVersion: "2.0.0" },
        },
        events,
      ),
    );

    assert.deepEqual(result, [
      { name: "@scope/a", version: "1.0.0", state: "existing" },
      { name: "@scope/b", version: "2.0.0", state: "published" },
      { name: "@scope/c", version: "3.0.0", state: "staged" },
    ]);

    const firstPublish = events.findIndex((event) =>
      event.startsWith("publish:"),
    );
    const lastRegistry = Math.max(
      ...events
        .map((event, index) => [event, index])
        .filter(([event]) => event.startsWith("registry:"))
        .map(([, index]) => index),
    );
    assert.ok(firstPublish > lastRegistry, events.join("\n"));
    assert.deepEqual(
      events.filter((event) => event.startsWith("publish:")),
      ["publish:@scope/b", "publish:@scope/c"],
    );
    assert.ok(events.includes("pack-oidc:absent"));
    assert.ok(events.includes("pack-read-token:read-only-token"));
    assert.ok(events.includes("pack-publish-token:absent"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preflight failure performs zero publication mutations", async () => {
  const root = await createWorkspace();
  const events = [];

  try {
    await assert.rejects(
      runRelease(
        context(root),
        dependenciesFor(
          {
            "@scope/a": { state: "existing" },
            "@scope/b": { state: "candidate", latestVersion: "1.0.0" },
            "@scope/c": new Error("registry preflight mismatch"),
          },
          events,
        ),
      ),
      /registry preflight mismatch/,
    );

    assert.deepEqual(
      events.filter((event) => event.startsWith("publish:")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publish option preflight also blocks all mutations", async () => {
  const root = await createWorkspace();
  const events = [];

  try {
    const cPath = join(root, "packages", "c", "package.json");
    await writeFile(
      cPath,
      JSON.stringify(
        {
          name: "@scope/c",
          version: "3.0.0-beta.1",
          repository: "releaseway/example",
          dependencies: {
            "@scope/b": "^2.0.0",
          },
        },
        null,
        2,
      ) + "\n",
    );

    await assert.rejects(
      runRelease(
        context(root),
        dependenciesFor(
          {
            "@scope/a": { state: "existing" },
            "@scope/b": { state: "candidate", latestVersion: "1.0.0" },
            "@scope/c": { state: "candidate", latestVersion: "2.0.0" },
          },
          events,
        ),
      ),
      /requires explicit publishConfig\.tag/,
    );

    assert.deepEqual(
      events.filter((event) => event.startsWith("publish:")),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("partial publication failure reports completed packages and rerun continues", async () => {
  const root = await createWorkspace();

  try {
    const firstEvents = [];
    let publishCalls = 0;

    await assert.rejects(
      runRelease(
        context(root),
        dependenciesFor(
          {
            "@scope/a": { state: "existing" },
            "@scope/b": { state: "candidate", latestVersion: "1.0.0" },
            "@scope/c": { state: "candidate", latestVersion: "2.0.0" },
          },
          firstEvents,
          async (_toolchain, request) => {
            firstEvents.push("publish:" + request.name);
            publishCalls += 1;
            if (request.name === "@scope/c") {
              throw new Error("simulated stage outage");
            }
            return "published";
          },
        ),
      ),
      /Publication failed for @scope\/c@3\.0\.0; completed before failure: @scope\/b@2\.0\.0\(published\); cause: simulated stage outage/,
    );
    assert.equal(publishCalls, 2);

    const rerunEvents = [];
    const rerun = await runRelease(
      context(root),
      dependenciesFor(
        {
          "@scope/a": { state: "existing" },
          "@scope/b": { state: "existing" },
          "@scope/c": { state: "candidate", latestVersion: "2.0.0" },
        },
        rerunEvents,
      ),
    );

    assert.deepEqual(rerun, [
      { name: "@scope/a", version: "1.0.0", state: "existing" },
      { name: "@scope/b", version: "2.0.0", state: "existing" },
      { name: "@scope/c", version: "3.0.0", state: "staged" },
    ]);
    assert.deepEqual(
      rerunEvents.filter((event) => event.startsWith("publish:")),
      ["publish:@scope/c"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no publishable packages is a hard preflight failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-empty-orchestrate-"));
  const events = [];

  try {
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ private: true }, null, 2) + "\n",
    );

    await assert.rejects(
      runRelease(
        context(root),
        dependenciesFor({}, events),
      ),
      /No publishable npm packages were discovered/,
    );
    assert.equal(events.includes("bootstrap-toolchain"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
