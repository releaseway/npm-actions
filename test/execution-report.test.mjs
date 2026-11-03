import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ExecutionReporter } from "../src/execution-report.ts";
import { activity, logProgress } from "../src/progress.ts";
import { ReleaseError } from "../src/release-error.ts";

test("preparation failures identify their real phase and preserve safe codes", async () => {
  const reporter = new ExecutionReporter();
  const identity = { name: "@scope/pkg", version: "1.0.0" };
  const error = new ReleaseError("REMOTE_UNAVAILABLE", "SECRET registry details");
  await assert.rejects(activity(identity, "prepare", event => reporter.progress(event), async () => { throw error; }), /SECRET/);
  reporter.finish(false, error);
  assert.deepEqual(reporter.report.packages[0].error, { code: "REMOTE_UNAVAILABLE", phase: "prepare", remoteState: "unchanged" });
  assert.equal(reporter.report.packages[0].status, "failed");
  assert.equal(reporter.report.packages[0].timings[0].status, "failed");
  assert.doesNotMatch(JSON.stringify(reporter.report), /SECRET/);
});

test("public skips and prepacked skips are explicit without altering legacy schemas", async () => {
  const identity = { name: "@scope/pkg", version: "1.0.0" };
  const reporter = new ExecutionReporter();
  const logs = [];
  const plan = { kind: "plan", plan: [], alreadyPublished: [{ ...identity, state: "already-published" }] };
  reporter.progress(plan);
  logProgress(plan, line => logs.push(line));
  assert.match(logs[0], /already-published/);
  assert.equal(reporter.report.packages[0].publication, "already-published");
  reporter.progress({ kind: "activity", package: identity, phase: "pack", state: "skipped", at: "2026-11-03T00:00:00.000Z", elapsedMs: 0 });
  assert.equal(reporter.report.packages[0].timings[0].status, "skipped");
  const schema = JSON.parse(await readFile(new URL("../contracts/npm-execution-report-v1.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(reporter.report).sort(), schema.required.toSorted());
});
