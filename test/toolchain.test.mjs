import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import * as tar from "tar";

import {
  downloadAndExtract,
  parsePackageManager,
  provisionPackageManager,
  releasewayNpmCommand,
  verifyIntegrity,
} from "../src/toolchain/bootstrap.ts";
import { packageOperationEnvironment } from "../src/toolchain/environment.ts";

function sri(bytes) {
  return "sha512-" + createHash("sha512").update(bytes).digest("base64");
}

test("verifyIntegrity accepts exact SHA-512 and rejects corruption", () => {
  const bytes = Buffer.from("releaseway-toolchain");
  verifyIntegrity(bytes, sri(bytes));
  assert.throws(
    () => verifyIntegrity(Buffer.from("corrupt"), sri(bytes)),
    /integrity mismatch/,
  );
  assert.throws(
    () => verifyIntegrity(bytes, "sha256-deadbeef"),
    /must be an SRI SHA-512/,
  );
});

test("downloadAndExtract verifies before exposing the executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-tool-download-"));
  const source = join(root, "source");
  const archive = join(root, "fixture.tgz");
  const destination = join(root, "extract");

  try {
    await mkdir(join(source, "package", "bin"), { recursive: true });
    await writeFile(join(source, "package", "bin", "tool.js"), "fixture\n");
    await tar.c(
      { cwd: source, file: archive, gzip: true, portable: true },
      ["package"],
    );
    const bytes = await readFile(archive);
    const spec = {
      version: "1.0.0",
      tarball: "https://registry.example/tool.tgz",
      integrity: sri(bytes),
      bin: "bin/tool.js",
    };

    const fetchImpl = async () => new Response(bytes, { status: 200 });
    const cli = await downloadAndExtract(
      "fixture",
      spec,
      destination,
      fetchImpl,
    );

    assert.equal(await readFile(cli, "utf8"), "fixture\n");

    await assert.rejects(
      downloadAndExtract(
        "corrupt",
        { ...spec, integrity: sri(Buffer.from("different")) },
        join(root, "corrupt"),
        fetchImpl,
      ),
      /integrity mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parsePackageManager requires supported exact versions", () => {
  assert.deepEqual(parsePackageManager("pnpm@12.6.0"), {
    name: "pnpm",
    version: "12.6.0",
    corepackReference: "pnpm@12.6.0",
  });
  assert.deepEqual(parsePackageManager("yarn@4.9.2+sha512.ABC_def-123"), {
    name: "yarn",
    version: "4.9.2",
    corepackReference: "yarn@4.9.2+sha512.ABC_def-123",
  });

  for (const invalid of [
    "bun@1.2.3",
    "pnpm@latest",
    "pnpm@^10.0.0",
    "pnpm@10",
    "pnpm",
  ]) {
    assert.throws(() => parsePackageManager(invalid));
  }
});

test("releaseway npm command never resolves npm through PATH", () => {
  const toolchain = {
    root: "/isolated",
    npmCli: "/isolated/npm/bin/npm-cli.js",
    corepackCli: "/isolated/corepack/dist/corepack.js",
    corepackHome: "/isolated/corepack-home",
  };

  const command = releasewayNpmCommand(toolchain, {
    PATH: "/malicious",
  });

  assert.equal(command.executable, process.execPath);
  assert.deepEqual(command.argsPrefix, [toolchain.npmCli]);
  assert.equal(command.env.PATH, "/malicious");
});

test("provisionPackageManager executes pinned Corepack and checks the exact version", () => {
  const toolchain = {
    root: "/isolated",
    npmCli: "/isolated/npm/bin/npm-cli.js",
    corepackCli: "/isolated/corepack/dist/corepack.js",
    corepackHome: "/isolated/corepack-home",
  };
  const calls = [];

  const command = provisionPackageManager(
    "pnpm@12.6.0",
    toolchain,
    "/workspace",
    {
      PATH: "/malicious",
      HTTPS_PROXY: "http://proxy.example",
      COREPACK_HOME: "/attacker/corepack",
      COREPACK_NPM_REGISTRY: "https://registry.example.invalid",
      COREPACK_NPM_TOKEN: "attacker-token",
      COREPACK_INTEGRITY_KEYS: "0",
      COREPACK_ON_UNVERIFIED_DOWNLOAD: "ignore",
    },
    (executable, args, options) => {
      calls.push({ executable, args, options });
      return { status: 0, stdout: "12.6.0\n", stderr: "" };
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].executable, process.execPath);
  assert.deepEqual(calls[0].args, [
    toolchain.corepackCli,
    "pnpm@12.6.0",
    "--version",
  ]);
  assert.equal(calls[0].options.env.COREPACK_HOME, toolchain.corepackHome);
  assert.equal(
    calls[0].options.env.COREPACK_NPM_REGISTRY,
    "https://registry.npmjs.org",
  );
  assert.equal(calls[0].options.env.COREPACK_NPM_TOKEN, undefined);
  assert.equal(calls[0].options.env.COREPACK_INTEGRITY_KEYS, undefined);
  assert.equal(
    calls[0].options.env.COREPACK_ON_UNVERIFIED_DOWNLOAD,
    undefined,
  );
  assert.equal(calls[0].options.env.HTTPS_PROXY, "http://proxy.example");
  assert.equal(command.executable, process.execPath);
  assert.deepEqual(command.argsPrefix, [
    toolchain.corepackCli,
    "pnpm@12.6.0",
  ]);

  assert.throws(
    () =>
      provisionPackageManager(
        "pnpm@12.6.0",
        toolchain,
        "/workspace",
        {},
        () => ({ status: 0, stdout: "12.5.9\n", stderr: "" }),
      ),
    /version mismatch/,
  );
});


test("package operations cannot inherit publish OIDC or publish-token credentials", () => {
  const env = packageOperationEnvironment({
    ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
    NODE_AUTH_TOKEN: "read-only",
    NPM_TOKEN: "publish-token",
    NPM_AUTH_TOKEN: "publish-auth-token",
    NPM_CONFIG__AUTH_TOKEN: "config-token",
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    HTTPS_PROXY: "http://proxy.example",
  });

  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_URL, undefined);
  assert.equal(env.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(env.NPM_TOKEN, undefined);
  assert.equal(env.NPM_AUTH_TOKEN, undefined);
  assert.equal(env.NPM_CONFIG__AUTH_TOKEN, undefined);
  assert.equal(env.NODE_AUTH_TOKEN, "read-only");
  assert.equal(env.NPM_CONFIG_REGISTRY, "https://registry.npmjs.org/");
  assert.equal(env.HTTPS_PROXY, "http://proxy.example");
});
