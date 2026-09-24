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
import { publishPackage } from "../src/publish/index.ts";
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
  assert.doesNotThrow(() =>
    assertTrustedPublishingEnvironment(trustedEnv()),
  );
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
  assert.equal(
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
    "oidc-request-token",
  );
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
      () =>
        derivePublishOptions(
          { publishConfig: { tag } },
          "1.2.3",
        ),
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

test("direct publisher uses exact tarball, isolated configs, and no token fallback", async () => {
  await withTarball(async ({ root, tarball }) => {
    const calls = [];
    const state = await publishPackage(
      toolchain(),
      {
        mode: "direct",
        name: "@scope/pkg",
        version: "1.2.3",
        tarballPath: tarball,
        manifest: {
          publishConfig: {
            tag: "next",
            access: "public",
          },
        },
        latestVersion: "1.2.2",
      },
      {
        tempRoot: root,
        env: trustedEnv({
          NODE_AUTH_TOKEN: "read-only",
          NPM_TOKEN: "must-not-leak",
          NPM_CONFIG_USERCONFIG: "/unsafe",
        }),
        runPublisher(executable, args, options) {
          calls.push({ executable, args, options });
          return { status: 0, stdout: "ok\n", stderr: "" };
        },
      },
    );

    assert.equal(state, "direct-accepted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, process.execPath);
    assert.deepEqual(calls[0].args.slice(0, 3), [
      toolchain().npmCli,
      "publish",
      tarball,
    ]);
    assert.ok(
      calls[0].args.includes(
        "--registry=https://registry.npmjs.org/",
      ),
    );
    assert.ok(calls[0].args.some((arg) => arg.startsWith("--userconfig=")));
    assert.ok(calls[0].args.some((arg) => arg.startsWith("--globalconfig=")));
    assert.ok(calls[0].args.includes("--tag=next"));
    assert.ok(calls[0].args.includes("--access=public"));
    assert.equal(calls[0].options.env.NODE_AUTH_TOKEN, undefined);
    assert.equal(calls[0].options.env.NPM_TOKEN, undefined);
    assert.equal(
      calls[0].options.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN,
      "oidc-request-token",
    );
    assert.notEqual(calls[0].options.cwd, process.cwd());
  });
});

test("direct publisher treats npm scan-pending E409 as accepted", async () => {
  await withTarball(async ({ root, tarball }) => {
    const state = await publishPackage(
      toolchain(),
      {
        mode: "direct",
        name: "pkg",
        version: "4.0.0",
        tarballPath: tarball,
        manifest: {},
        latestVersion: "3.0.0",
      },
      {
        tempRoot: root,
        env: trustedEnv(),
        runPublisher: () => ({
          status: 1,
          stdout: "",
          stderr:
            'E409 Conflict - Cannot publish over previously staged version "4.0.0".',
        }),
      },
    );

    assert.equal(state, "direct-accepted");
  });
});

test("stage publisher uses npm stage publish and reports staged", async () => {
  await withTarball(async ({ root, tarball }) => {
    const calls = [];
    const state = await publishPackage(
      toolchain(),
      {
        mode: "stage",
        name: "pkg",
        version: "3.0.0",
        tarballPath: tarball,
        manifest: {},
        latestVersion: "2.0.0",
      },
      {
        tempRoot: root,
        env: trustedEnv(),
        runPublisher(executable, args, options) {
          calls.push({ executable, args, options });
          return { status: 0, stdout: "staged\n", stderr: "" };
        },
      },
    );

    assert.equal(state, "staged");
    assert.deepEqual(calls[0].args.slice(0, 4), [
      toolchain().npmCli,
      "stage",
      "publish",
      tarball,
    ]);
  });
});

test("publisher fails before subprocess when OIDC or tag preflight is invalid", async () => {
  await withTarball(async ({ root, tarball }) => {
    let calls = 0;
    const runner = () => {
      calls += 1;
      return { status: 0, stdout: "", stderr: "" };
    };

    await assert.rejects(
      publishPackage(
        toolchain(),
        {
          mode: "direct",
          name: "pkg",
          version: "1.0.0",
          tarballPath: tarball,
          manifest: {},
        },
        {
          tempRoot: root,
          env: { NODE_AUTH_TOKEN: "token-only" },
          runPublisher: runner,
        },
      ),
      /requires GitHub Actions/,
    );
    assert.equal(calls, 0);

    await assert.rejects(
      publishPackage(
        toolchain(),
        {
          mode: "stage",
          name: "pkg",
          version: "2.0.0-beta.1",
          tarballPath: tarball,
          manifest: {},
          latestVersion: "1.0.0",
        },
        {
          tempRoot: root,
          env: trustedEnv(),
          runPublisher: runner,
        },
      ),
      /requires explicit publishConfig\.tag/,
    );
    assert.equal(calls, 0);
  });
});

test("publisher propagates staged conflict as failure without reconciliation", async () => {
  await withTarball(async ({ root, tarball }) => {
    await assert.rejects(
      publishPackage(
        toolchain(),
        {
          mode: "stage",
          name: "pkg",
          version: "2.0.0",
          tarballPath: tarball,
          manifest: {},
          latestVersion: "1.0.0",
        },
        {
          tempRoot: root,
          env: trustedEnv(),
          runPublisher: () => ({
            status: 1,
            stdout: "",
            stderr: "E409 version already staged",
          }),
        },
      ),
      /E409 version already staged/,
    );
  });
});
