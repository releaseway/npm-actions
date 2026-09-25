import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { resolveActionPath, runAction } from "../src/action.ts";

test("action metadata uses the Node 24 bundle and exposes only packages", async () => {
  const metadata = await readFile(resolve("action.yml"), "utf8");

  assert.match(metadata, /using:\s*node24/);
  assert.match(metadata, /main:\s*dist\/main\.js/);
  assert.match(metadata, /^outputs:\n\s+packages:/m);
  assert.doesNotMatch(metadata, /^inputs:/m);
});

test("JavaScript action root derives from the bundled main entrypoint", () => {
  assert.equal(
    resolveActionPath(undefined, {}, [
      "/opt/hostedtoolcache/node/bin/node",
      "/home/runner/work/_actions/releaseway/npm-actions/sha/dist/main.js",
    ]),
    "/home/runner/work/_actions/releaseway/npm-actions/sha",
  );
});

test("action writes packages output only after successful orchestration", async () => {
  const writes = [];
  const expected = [
    {
      name: "@scope/a",
      version: "1.2.3",
      state: "already-published",
    },
    {
      name: "@scope/b",
      version: "2.0.0",
      state: "published",
    },
  ];

  const result = await runAction({
    actionPath: "/action",
    env: {
      GITHUB_OUTPUT: "/github/output",
      GITHUB_WORKSPACE: "/workspace",
      GITHUB_REPOSITORY: "releaseway/example",
      GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
    },
    release: async () => expected,
    appendOutput(path, data, options) {
      writes.push({ path, data, options });
    },
  });

  assert.deepEqual(result, expected);
  assert.deepEqual(writes, [
    {
      path: "/github/output",
      data: "packages=" + JSON.stringify(expected) + "\n",
      options: { encoding: "utf8" },
    },
  ]);
});

test("action does not write output when orchestration fails", async () => {
  let writes = 0;

  await assert.rejects(
    runAction({
      actionPath: "/action",
      env: {
        GITHUB_OUTPUT: "/github/output",
        GITHUB_WORKSPACE: "/workspace",
        GITHUB_REPOSITORY: "releaseway/example",
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
      },
      release: async () => {
        throw new Error("preflight failed");
      },
      appendOutput() {
        writes += 1;
      },
    }),
    /preflight failed/,
  );

  assert.equal(writes, 0);
});
