import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { execFileSync } from "node:child_process";

const CHECK = resolve(".github/workflows/check.yml");
const RELEASE = resolve(".github/workflows/release.yml");
const MAINTENANCE = resolve(".github/workflows/maintenance.yml");

async function workflowSource(path) {
  return readFile(path, "utf8");
}

test("check workflow contains the required validation gates", async () => {
  const source = await workflowSource(CHECK);
  const workflow = parse(source);

  for (const role of ["static", "unit", "pack-integration", "runtime-matrix", "musl-runtime"]) {
    assert.ok(workflow.jobs[role], role);
  }

  const runtimeMatrix = JSON.stringify(workflow.jobs["runtime-matrix"]);
  assert.match(workflow.jobs["runtime-matrix"].strategy.matrix.include, /needs\.coverage\.outputs\.runtime/);
  assert.ok(workflow.jobs["runtime-matrix"].steps.some((step) => step.with?.["node-version"] === "${{ matrix.node }}"));
  assert.match(runtimeMatrix, /verify:native-runtime/);
  assert.match(runtimeMatrix, /verify:native-install/);

  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.equal(source.includes("id-token: write"), false);
  assert.equal(/\bnpm\s+(?:stage\s+)?publish\b/.test(source), false);

  assert.match(source, /pnpm run verify:versions/);
  assert.match(source, /pnpm run verify:dist/);

  const packIntegration = JSON.stringify(workflow.jobs["pack-integration"]);
  assert.match(packIntegration, /verify:toolchain/);
  assert.match(packIntegration, /verify:pack/);
  assert.match(packIntegration, /verify:yarn-corepack/);
});

test("all repository workflow action dependencies use immutable full SHAs", async () => {
  for (const path of [CHECK, RELEASE]) {
    const workflow = parse(await workflowSource(path));
    const uses = Object.values(workflow.jobs).flatMap((job) =>
      [job.uses, ...(job.steps ?? []).map((step) => step.uses)]).filter(Boolean);

    assert.ok(uses.length > 0, path);
    for (const reference of uses) {
      if (reference.startsWith("./")) continue;
      assert.match(
        reference,
        /^[^@\s]+@[0-9a-f]{40}$/,
        "workflow action is not pinned to a full commit SHA: " + reference,
      );
    }
  }
});

test("latest dependency checks run in maintenance separately from release checks", async () => {
  for (const path of [CHECK, RELEASE]) {
    assert.doesNotMatch(await workflowSource(path), /latest_actions_up|verify:latest|actions-up@/);
  }
  for (const path of [MAINTENANCE]) {
    const source = await workflowSource(path);

    assert.match(source, /pnpm run verify:latest/);
    const workflow = parse(source);
    assert.ok(workflow.on.schedule.length);
    assert.ok(Object.hasOwn(workflow.on, "workflow_dispatch"));
  }
});

test("musl gate certifies installed native runtime on Node 22, 24 and 26", async () => {
  const source = await workflowSource(CHECK);
  const workflow = parse(source);
  const job = workflow.jobs["musl-runtime"];
  const serialized = JSON.stringify(job);

  assert.match(job.strategy.matrix.node, /needs\.coverage\.outputs\.musl/);
  assert.match(serialized, /node:\$\{\{ matrix\.node \}\}-alpine/);
  assert.match(serialized, /verify:native-runtime/);
  assert.match(serialized, /verify:native-install/);
  assert.doesNotMatch(serialized, /npm publish|npm stage publish/);
});

test("smoke covers each platform and Node; release preserves every supported pair", () => {
  const script = "import runpy,json; m=runpy.run_path('scripts/ci-matrix.py'); print(json.dumps([m['matrices'](False),m['matrices'](True)]))";
  const [smoke, full] = JSON.parse(execFileSync("python3", ["-c", script], { encoding: "utf8" }));
  assert.equal(smoke[0].length + smoke[1].length, 9);
  assert.equal(full[0].length + full[1].length, 21);
  assert.equal(new Set(smoke[0].map((pair) => pair.runner)).size, 6);
  for (const node of ["22", "24", "26"]) {
    assert.equal(full[0].filter((pair) => pair.node === node).length, 6);
    assert.ok(full[1].includes(node));
    assert.ok(smoke[0].some((pair) => pair.node === node));
  }
});

test("release workflow certifies the tagged source before immutable GitHub release", async () => {
  const source = await workflowSource(RELEASE);
  const workflow = parse(source);

  assert.deepEqual(workflow.permissions, { contents: "write", actions: "read" });
  assert.equal(workflow.jobs.release["runs-on"], "ubuntu-24.04");
  assert.equal(source.includes("id-token: write"), false);
  assert.equal(/\bnpm\s+(?:stage\s+)?publish\b/.test(source), false);

  assert.match(source, /uses: releaseway\/actions\/prepare@[0-9a-f]{40}/);
  assert.match(source, /mode: resolve/);
  assert.match(source, /ref: \$\{\{ steps\.release\.outputs\.commit \}\}/);
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
    "python3 scripts/prepare-release-evidence.py",
    "python3 scripts/verify-archived-release.py",
  ]) {
    assert.ok(source.includes(command), command);
  }

  assert.match(
    source,
    /uses: releaseway\/actions@[0-9a-f]{40}/,
  );
  assert.match(source, /tag: \$\{\{ steps\.release\.outputs\.tag \}\}/);
  assert.match(source, /commit: \$\{\{ steps\.release\.outputs\.target \}\}/);
  assert.match(source, /latest: "true"/);
  const approval = workflow.jobs.release.steps.findIndex((step) => step.run?.includes("scripts/prepare-release-evidence.py"));
  const publication = workflow.jobs.release.steps.findIndex((step) => step.id === "publish");
  assert.ok(approval >= 0 && publication > approval);
  assert.equal(workflow.jobs.release.steps.find((step) => step.id === "publish").with.assets, "releaseway-evidence.json");
  assert.match(workflow.jobs.release.steps.find((step) => step.id === "publish").if, /steps.evidence.outputs.state == 'prepared'/);
  assert.ok(workflow.jobs.release.steps.some((step) => step.with?.path === "release-source" && step.with.ref === "${{ steps.release.outputs.commit }}"));
});
