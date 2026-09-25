import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

const CHECK = resolve(".github/workflows/check.yml");
const RELEASE = resolve(".github/workflows/release.yml");

async function workflowSource(path) {
  return readFile(path, "utf8");
}

test("check workflow contains the required validation gates", async () => {
  const source = await workflowSource(CHECK);
  const workflow = parse(source);

  assert.deepEqual(Object.keys(workflow.jobs), [
    "action-pins",
    "static",
    "unit",
    "pack-integration",
    "runtime-matrix",
    "musl-runtime",
    "fake-registry-e2e",
  ]);

  assert.deepEqual(
    workflow.jobs["runtime-matrix"].strategy.matrix.runner,
    [
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
      "macos-15",
      "macos-15-intel",
      "windows-2025",
      "windows-11-arm",
    ],
  );

  const runtimeMatrix = JSON.stringify(workflow.jobs["runtime-matrix"]);
  assert.match(runtimeMatrix, /verify:native-runtime/);
  assert.match(runtimeMatrix, /verify:native-install/);

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(source.includes("id-token: write"), false);
  assert.equal(/\bnpm\s+(?:stage\s+)?publish\b/.test(source), false);

  const versionsIndex = source.indexOf("- run: npm run verify:versions");
  const verifyIndex = source.indexOf("- run: npm run verify:dist");
  const buildIndex = source.indexOf("- run: npm run build");
  const diffIndex = source.indexOf("- run: git diff --exit-code -- dist");
  assert.ok(versionsIndex !== -1 && versionsIndex < verifyIndex);
  assert.ok(verifyIndex !== -1 && verifyIndex < buildIndex);
  assert.ok(buildIndex < diffIndex);

  const packIntegration = JSON.stringify(workflow.jobs["pack-integration"]);
  assert.match(packIntegration, /verify:toolchain/);
  assert.match(packIntegration, /verify:pack/);
  assert.match(packIntegration, /verify:yarn-corepack/);
});

test("all repository workflow action dependencies use immutable full SHAs", async () => {
  for (const path of [CHECK, RELEASE]) {
    const source = await workflowSource(path);
    const uses = [
      ...source.matchAll(
        /^\s*- uses:\s*([^\s#]+)(?:\s+#\s*(.+))?$/gm,
      ),
    ];

    assert.ok(uses.length > 0, path);
    for (const match of uses) {
      const reference = match[1];
      assert.match(
        reference,
        /^[^@\s]+@[0-9a-f]{40}$/,
        "workflow action is not pinned to a full commit SHA: " + reference,
      );
      assert.ok(
        match[2]?.trim(),
        "full-SHA workflow action pin must keep an adjacent version comment: " +
          reference,
      );
    }
  }
});

test("actions-up gates use the current tool and repository-only scan", async () => {
  for (const path of [CHECK, RELEASE]) {
    const source = await workflowSource(path);

    assert.match(source, /test "\$latest_actions_up" = "1\.21\.0"/);
    assert.match(source, /actions-up@1\.21\.0/);
    assert.match(source, /--dir \.github/);
    assert.match(source, /--recursive/);
    assert.match(source, /--mode major/);
    assert.match(source, /--style sha/);
    assert.match(source, /--prefer-tags/);
    assert.match(source, /--min-age 0/);
    assert.match(source, /totalUpdates == 0/);
    assert.match(source, /totalRunnerUpdates == 0/);
    assert.match(source, /totalBlockedByMode == 0/);
    assert.match(source, /totalBlockedByAge == 0/);
  }
});

test("musl gate uses Node 24 Alpine and never publishes npm state", async () => {
  const source = await workflowSource(CHECK);
  const workflow = parse(source);
  const job = workflow.jobs["musl-runtime"];
  const serialized = JSON.stringify(job);

  assert.match(serialized, /node:24-alpine/);
  assert.match(serialized, /verify:native-runtime/);
  assert.doesNotMatch(serialized, /npm publish|npm stage publish/);
});

test("release workflow certifies the tagged source before immutable GitHub release", async () => {
  const source = await workflowSource(RELEASE);
  const workflow = parse(source);

  assert.deepEqual(workflow.permissions, { contents: "write" });
  assert.equal(workflow.jobs.release["runs-on"], "ubuntu-24.04");
  assert.equal(source.includes("id-token: write"), false);
  assert.equal(/\bnpm\s+(?:stage\s+)?publish\b/.test(source), false);

  assert.match(
    source,
    /\^v\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\\\.\(0\|\[1-9\]\[0-9\]\*\)\$/,
  );
  assert.match(source, /git checkout --detach "\$TARGET"/);
  for (const required of [
    "action.yml",
    "dist/main.js",
    "dist/native-runtime.cjs",
    ".github/workflows/check.yml",
    ".github/workflows/release.yml",
  ]) {
    assert.ok(source.includes(required), required);
  }

  for (const command of [
    "npm ci",
    "npm run verify:versions",
    "npm run typecheck",
    "npm run verify:dist",
    "npm test",
    "npm run verify:toolchain",
    "npm run verify:pack",
    "npm run verify:yarn-corepack",
    "npm run verify:native-runtime",
    "npm run verify:native-install",
    "node:24-alpine",
    "git diff --exit-code",
  ]) {
    assert.ok(source.includes(command), command);
  }

  assert.match(
    source,
    /uses: releaseway\/actions@49c543357d96884d0e5a683c45d45ebd50a8b612 # v0\.1\.4/,
  );
  assert.match(source, /tag: \$\{\{ steps\.release\.outputs\.tag \}\}/);
  assert.match(source, /commit: \$\{\{ steps\.release\.outputs\.target \}\}/);
  assert.match(source, /latest: "true"/);
});
