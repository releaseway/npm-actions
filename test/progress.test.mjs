import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { activity, logProgress } from "../src/progress.ts";
import { publishPackage } from "../src/publish/index.ts";
import { sha512Integrity } from "../src/registry/integrity.ts";
import { ExecutionReporter, writeExecutionReport } from "../src/execution-report.ts";

test("an actual asynchronous publisher permits heartbeats and keeps captured output private", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "rw-progress-"));
  try {
    const tarballPath = join(root, "pkg.tgz"), npmCli = join(root, "npm.cjs");
    await writeFile(tarballPath, "prepared bytes");
    await writeFile(npmCli, `if (process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) process.exit(7);\nconsole.log('SECRET_STDOUT'); console.error('SECRET_STDERR'); setTimeout(() => {}, 150);\n`);
    const request = { name: "@scope/pkg", version: "1.0.0", mode: "direct", tarballPath, integrity: await sha512Integrity(tarballPath), publishOptions: { tag: "latest" } };
    const events = [], logs = [];
    const reporter = new ExecutionReporter();
    const onProgress = event => { events.push(event); reporter.progress(event); logProgress(event, line => logs.push(line)); };
    assert.equal(await activity(request, "npm-command", onProgress, () => publishPackage({ npmCli }, request, {
      tempRoot: root,
      env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "SECRET_OIDC", NPM_TOKEN: "SECRET_NPM", NODE_AUTH_TOKEN: "SECRET_READ" },
    }), 10), "direct-accepted");
    assert.ok(events.some(event => event.state === "waiting"));
    assert.equal(events.at(-1).state, "completed");
    const count = events.length;
    await new Promise(done => setTimeout(done, 30));
    assert.equal(events.length, count, "heartbeat timer is cleared at completion");
    reporter.finish(true);
    const text = await readFile(await writeExecutionReport(reporter.report, { RUNNER_TEMP: root }), "utf8");
    assert.doesNotMatch(text + logs.join("\n"), /SECRET/);
    assert.ok(reporter.report.packages[0].timings[0].elapsedMs >= 100);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("activity failure completes its timer and console write failures do not change results", async () => {
  const events = [];
  await assert.rejects(activity(null, "prepare", event => events.push(event), async () => { throw new Error("SECRET"); }), /SECRET/);
  assert.deepEqual(events.map(event => event.state), ["started", "failed"]);
  assert.doesNotThrow(() => logProgress(events[0], () => { throw new Error("closed output"); }));
  assert.doesNotMatch(JSON.stringify(events), /SECRET/);
});

test("publisher rechecks admission after context setup and removes skipped request state", async () => {
  const root = await mkdtemp(join(tmpdir(), "rw-admission-"));
  try {
    const tarballPath = join(root, "pkg.tgz");
    await writeFile(tarballPath, "prepared bytes");
    const request = { name: "@scope/pkg", version: "1.0.0", mode: "direct", tarballPath, integrity: await sha512Integrity(tarballPath), publishOptions: {} };
    const result = await publishPackage({ npmCli: "/unused" }, request, {
      tempRoot: root,
      env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture" },
      canPublish: () => false,
      runPublisher: () => assert.fail("stopped admission must not start a subprocess"),
    });
    assert.equal(result, "not-submitted");
    assert.deepEqual(await readdir(root), ["pkg.tgz"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a failed real subprocess closes before cleanup and does not expose its captured output", { timeout: 10_000 }, async () => {
  const { errorMessage } = await import("../src/errors.ts");
  const root = await mkdtemp(join(tmpdir(), "rw-command-fail-"));
  try {
    const tarballPath = join(root, "pkg.tgz"), npmCli = join(root, "npm.cjs");
    await writeFile(tarballPath, "prepared bytes");
    await writeFile(npmCli, "process.stderr.write('SECRET_SUBPROCESS'); process.exitCode = 23;\n");
    const request = { name: "@scope/pkg", version: "1.0.0", mode: "direct", tarballPath, integrity: await sha512Integrity(tarballPath), publishOptions: {} };
    await assert.rejects(publishPackage({ npmCli }, request, {
      tempRoot: root,
      env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture" },
    }), error => {
      assert.match(error.output, /SECRET_SUBPROCESS/);
      assert.doesNotMatch(errorMessage(error), /SECRET_SUBPROCESS/);
      return true;
    });
    assert.deepEqual((await readdir(root)).toSorted(), ["npm.cjs", "pkg.tgz"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("publisher bounds subprocess output and cleans overflowed requests after close", { timeout: 10_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "rw-output-limit-"));
  try {
    const tarballPath = join(root, "pkg.tgz"), npmCli = join(root, "npm.cjs");
    await writeFile(tarballPath, "prepared bytes");
    await writeFile(npmCli, "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setTimeout(() => {}, 1000);\n");
    const request = { name: "@scope/pkg", version: "1.0.0", mode: "direct", tarballPath, integrity: await sha512Integrity(tarballPath), publishOptions: {} };
    await assert.rejects(publishPackage({ npmCli }, request, {
      tempRoot: root,
      env: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", ACTIONS_ID_TOKEN_REQUEST_URL: "https://example.invalid", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fixture" },
    }), /capture limit/);
    assert.deepEqual((await readdir(root)).toSorted(), ["npm.cjs", "pkg.tgz"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});
