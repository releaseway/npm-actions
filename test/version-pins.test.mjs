import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { verifyFixedVersions } from "../scripts/verify-fixed-versions.mjs";

test("fixed pin validation is offline, latest drift is separate, malformed pins fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-pin-tests-"));
  try {
    for (const file of ["package.json", "pnpm-lock.yaml", "toolchain.lock.json", "validation-versions.json"]) await cp(file, join(root, file));
    await cp(".github", join(root, ".github"), { recursive: true });
    const injection = join(root, "fetch.mjs");
    await writeFile(injection, `globalThis.fetch = async (url) => new Response(JSON.stringify({ version: url.includes("%40types%2Fnode") ? "24.99.0" : "99.0.0", dist: {tarball:"changed", integrity:"changed"} }));`);
    const command = (args) => spawnSync(process.execPath, ["--import", injection, resolve("scripts/verify-versions.mjs"), ...args], { cwd: root, encoding: "utf8" });
    assert.equal(command([]).status, 0);
    const latest = command(["--latest"]);
    assert.equal(latest.status, 0, latest.stderr);
    assert.match(latest.stderr, /::warning::devDependency @types\/node is stale/);
    assert.match(latest.stderr, /::warning::toolchain npm is stale/);
    assert.match(latest.stderr, /::warning::validation pnpm is stale/);
    await writeFile(injection, `globalThis.fetch = async () => new Response("unavailable", { status: 503 });`);
    const unavailable = command(["--latest"]);
    assert.notEqual(unavailable.status, 0);
    assert.match(unavailable.stderr, /Failed to resolve .*HTTP 503/);
    const toolsPath = join(root, "toolchain.lock.json");
    const tools = JSON.parse(await readFile(toolsPath, "utf8"));
    await writeFile(toolsPath, JSON.stringify({ ...tools, npm: { ...tools.npm, integrity: "sha512-broken" } }));
    await assert.rejects(verifyFixedVersions(root), /SHA-512 integrity/);
    await writeFile(toolsPath, JSON.stringify(tools));
    const pkgPath = join(root, "package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
    await writeFile(pkgPath, JSON.stringify({ ...pkg, devDependencies: { ...pkg.devDependencies, tar: "^7.5.22" } }));
    await assert.rejects(verifyFixedVersions(root), /exact semantic version/);
    await writeFile(pkgPath, JSON.stringify({ ...pkg, devDependencies: { ...pkg.devDependencies, tar: "7.5.21" } }));
    await assert.rejects(verifyFixedVersions(root), /Lock mismatch/);
    await writeFile(pkgPath, JSON.stringify(pkg));
    await writeFile(pkgPath, JSON.stringify({ ...pkg, packageManager: "pnpm@0.0.1" }));
    await assert.rejects(verifyFixedVersions(root), /Package manager lock mismatch/);
    await writeFile(pkgPath, JSON.stringify(pkg));
    const lockPath = join(root, "pnpm-lock.yaml");
    const lockSource = await readFile(lockPath, "utf8");
    await writeFile(lockPath, lockSource.replace(/integrity: sha512-[^}\s]+/, "integrity: sha512-broken"));
    await assert.rejects(verifyFixedVersions(root), /SHA-512 integrity/);
    await writeFile(lockPath, lockSource);
    await writeFile(join(root, ".github/workflows/unsafe.yml"), "jobs:\n  bad:\n    steps:\n      - uses: owner/action@main\n");
    await assert.rejects(verifyFixedVersions(root), /full SHA/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
