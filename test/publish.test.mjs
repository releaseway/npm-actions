import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";

import {
  assertTrustedPublishingEnvironment,
  isolatedPublisherEnvironment,
} from "../src/publish/environment.ts";
import { publishPackage, PublishCommandError } from "../src/publish/index.ts";
import { derivePublishOptions } from "../src/publish/options.ts";

function trustedEnv(extra = {}) {
  return {
    GITHUB_ACTIONS: "true",
    RUNNER_ENVIRONMENT: "github-hosted",
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/token",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-token",
    RUNNER_TEMP: tmpdir(),
    PATH: process.env.PATH,
    ...extra,
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

async function withTarball(fn) {
  const root = await mkdtemp(join(tmpdir(), "releaseway-publish-test-"));
  const tarball = join(root, "package.tgz");
  await writeFile(tarball, "fixture");
  try {
    await fn({ root, tarball });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("trusted publishing requires GitHub-hosted OIDC", () => {
  assert.doesNotThrow(() => assertTrustedPublishingEnvironment(trustedEnv()));
  assert.throws(
    () =>
      assertTrustedPublishingEnvironment(
        trustedEnv({ RUNNER_ENVIRONMENT: "self-hosted" }),
      ),
    /GitHub-hosted runner/,
  );
  assert.throws(
    () =>
      assertTrustedPublishingEnvironment({
        ...trustedEnv(),
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "",
      }),
    /id-token: write/,
  );
  assert.throws(
    () =>
      assertTrustedPublishingEnvironment({
        RUNNER_ENVIRONMENT: "github-hosted",
      }),
    /requires GitHub Actions/,
  );
});

test("publisher environment strips npm credentials but preserves OIDC", () => {
  const env = isolatedPublisherEnvironment(
    trustedEnv({
      NODE_AUTH_TOKEN: "read-token",
      NPM_TOKEN: "publish-token",
      NPM_CONFIG_USERCONFIG: "/unsafe/npmrc",
      NPM_CONFIG__AUTH_TOKEN: "unsafe-token",
      HTTPS_PROXY: "http://proxy.example",
    }),
    "/isolated/home",
  );

  assert.equal(env.NODE_AUTH_TOKEN, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.NPM_CONFIG_USERCONFIG, undefined);
  assert.equal(env.NPM_CONFIG__AUTH_TOKEN, undefined);
  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, "oidc-request-token");
  assert.equal(env.HTTPS_PROXY, "http://proxy.example");
  assert.equal(env.HOME, "/isolated/home");
  assert.equal(env.USERPROFILE, "/isolated/home");
});

test("publish options honor explicit tag/access and reject token config", () => {
  assert.deepEqual(
    derivePublishOptions(
      {
        publishConfig: {
          registry: "https://registry.npmjs.org/",
          tag: "next",
          access: "public",
        },
      },
      "1.2.3",
      "1.2.2",
    ),
    { tag: "next", access: "public" },
  );

  assert.throws(
    () =>
      derivePublishOptions(
        { publishConfig: { _authToken: "secret" } },
        "1.2.3",
      ),
    /forbidden publish credential setting/,
  );
  assert.throws(
    () =>
      derivePublishOptions(
        { publishConfig: { registry: "https://npm.example.invalid" } },
        "1.2.3",
      ),
    /must be https:\/\/registry\.npmjs\.org/,
  );

  for (const tag of ["1.2.3", "v1.4", "^2.0.0"]) {
    assert.throws(
      () => derivePublishOptions({ publishConfig: { tag } }, "1.2.3"),
      /must not be interpretable as a SemVer range/,
      tag,
    );
  }
});

test("pre-release and non-latest versions require explicit tag", () => {
  assert.throws(
    () => derivePublishOptions({}, "2.0.0-beta.1", "1.9.0"),
    /prerelease.*publishConfig\.tag/,
  );
  assert.throws(
    () => derivePublishOptions({}, "1.5.0", "2.0.0"),
    /lower than current latest.*publishConfig\.tag/,
  );
  assert.doesNotThrow(() =>
    derivePublishOptions(
      { publishConfig: { tag: "legacy" } },
      "1.5.0",
      "2.0.0",
    ),
  );
});

import { sha512Integrity } from "../src/registry/integrity.ts";

async function request(tarball, overrides = {}) {
  return Object.freeze({
    name: "pkg",
    version: "1.0.0",
    mode: "direct",
    tarballPath: tarball,
    integrity: await sha512Integrity(tarball),
    publishOptions: Object.freeze({ tag: "next", access: "public" }),
    ...overrides,
  });
}

test("publisher executes only the prepared tarball with frozen options and isolated OIDC", async () => {
  await withTarball(async ({ root, tarball }) => {
    const calls = [];
    const state = await publishPackage(toolchain(), await request(tarball), {
      tempRoot: root,
      env: trustedEnv({
        NODE_AUTH_TOKEN: "read-only",
        NPM_TOKEN: "must-not-leak",
        NPM_CONFIG_USERCONFIG: "/unsafe",
      }),
      runPublisher(executable, args, options) {
        calls.push({ executable, args, options });
        return { status: 0, stdout: "ok", stderr: "" };
      },
    });
    assert.equal(state, "direct-accepted");
    const call = calls[0];
    assert.equal(call.executable, process.execPath);
    assert.deepEqual(call.args.slice(0, 3), [
      toolchain().npmCli,
      "publish",
      tarball,
    ]);
    assert.ok(call.args.includes("--tag=next"));
    assert.ok(call.args.includes("--access=public"));
    assert.ok(call.args.includes("--ignore-scripts"));
    assert.ok(call.args.includes("--registry=https://registry.npmjs.org/"));
    assert.ok(call.args.some((arg) => arg.startsWith("--userconfig=")));
    assert.ok(call.args.some((arg) => arg.startsWith("--globalconfig=")));
    assert.equal(call.options.env.NODE_AUTH_TOKEN, undefined);
    assert.equal(call.options.env.NPM_TOKEN, undefined);
    assert.equal(
      call.options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      "oidc-request-token",
    );
    assert.notEqual(call.options.cwd, process.cwd());
  });
});

test("stage success means submitted, not publicly live", async () => {
  await withTarball(async ({ root, tarball }) => {
    let args;
    const state = await publishPackage(
      toolchain(),
      await request(tarball, { mode: "stage" }),
      {
        tempRoot: root,
        env: trustedEnv(),
        runPublisher(_exe, values) {
          args = values;
          return { status: 0, stdout: "staged", stderr: "" };
        },
      },
    );
    assert.equal(state, "staged");
    assert.deepEqual(args.slice(0, 4), [
      toolchain().npmCli,
      "stage",
      "publish",
      tarball,
    ]);
  });
});

test("pending-scan subprocess conflicts remain errors until orchestration verifies live integrity", async () => {
  await withTarball(async ({ root, tarball }) => {
    for (const mode of ["direct", "stage"]) {
      await assert.rejects(
        publishPackage(toolchain(), await request(tarball, { mode }), {
          tempRoot: root,
          env: trustedEnv(),
          runPublisher: () => ({
            status: 1,
            stdout: "Cannot publish over previously staged version",
            stderr: "E409",
          }),
        }),
        (error) =>
          error instanceof PublishCommandError &&
          error.output.includes(
            "Cannot publish over previously staged version",
          ) &&
          error.output.includes("E409"),
      );
    }
  });
});

test("altered prepared tarballs fail before publisher subprocess", async () => {
  await withTarball(async ({ root, tarball }) => {
    const frozen = await request(tarball);
    await writeFile(tarball, "changed");
    let calls = 0;
    await assert.rejects(
      publishPackage(toolchain(), frozen, {
        tempRoot: root,
        env: trustedEnv(),
        runPublisher: () => {
          calls++;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
      /Prepared tarball changed/,
    );
    assert.equal(calls, 0);
  });
});

test("token-only publication fails before any publisher subprocess", async () => {
  await withTarball(async ({ root, tarball }) => {
    let calls = 0;
    await assert.rejects(
      publishPackage(toolchain(), await request(tarball), {
        tempRoot: root,
        env: { NODE_AUTH_TOKEN: "token-only" },
        runPublisher: () => {
          calls++;
          return { status: 0, stdout: "", stderr: "" };
        },
      }),
      /requires GitHub Actions/,
    );
    assert.equal(calls, 0);
  });
});
