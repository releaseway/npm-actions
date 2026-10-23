import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runAction } from "../src/action.ts";
import { ArtifactError } from "../src/artifacts/errors.ts";
import { ArtifactReporter } from "../src/artifacts/report.ts";

const a = { name: "@scope/a", version: "1.2.3" };
const b = { name: "@scope/b", version: "2.0.0" };
const digest = "sha512-" + Buffer.alloc(64, 7).toString("base64");
const artifact = { ...a, tarball: "a.tgz", integrity: digest };
const emit = (target, data) => target.progress({ kind: "artifact-verification", event: data });

function supplied(target) {
  emit(target, { phase: "selection", packages: [a, b] });
  emit(target, { phase: "read", integrity: digest });
  emit(target, { phase: "manifest", packages: [artifact] });
  emit(target, { phase: "source", source: { repository: "owner/repo", commit: "a".repeat(40) } });
}

test("artifact sidecar separates covered public SHA-512 from uncovered historical existence", async () => {
  const tracker = new ArtifactReporter(); supplied(tracker);
  emit(tracker, { phase: "existing", identity: a });
  emit(tracker, { phase: "existing", identity: b });
  emit(tracker, { phase: "public", identity: a, integrity: digest, matched: true });
  emit(tracker, { phase: "preflight" }); tracker.complete();
  const report = tracker.report;
  const schema = JSON.parse(await readFile(new URL("../contracts/npm-artifact-report-v1.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(report).sort(), schema.required.toSorted());
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(report.packages[0], { ...a, coverage: "supplied", expectedIntegrity: digest, localIntegrity: null,
    publicIntegrity: digest, localVerification: "not-required", publicVerification: "matched", publication: "already-published" });
  assert.deepEqual(report.packages[1], { ...b, coverage: "not-supplied", expectedIntegrity: null, localIntegrity: null,
    publicIntegrity: null, localVerification: "not-required", publicVerification: "not-checked", publication: "already-published" });
  assert.equal(report.status, "success"); assert.equal(report.error, null);
});

test("staged bytes, late changed snapshots and uncertain publication retain distinct observations", () => {
  const tracker = new ArtifactReporter(); supplied(tracker);
  emit(tracker, { phase: "local", identity: a, integrity: digest, matched: true });
  emit(tracker, { phase: "preflight" });
  tracker.progress({ kind: "publishing", ...a });
  tracker.progress({ kind: "phase", phase: "publish" });
  tracker.progress({ kind: "completed", result: { ...a, state: "staged" } });
  assert.equal(tracker.report.packages[0].publicVerification, "not-checked");
  tracker.progress({ kind: "publishing", ...b });
  emit(tracker, { phase: "local", identity: b, integrity: digest, matched: false });
  tracker.fail(new Error("wrapper", { cause: new ArtifactError("ARTIFACT_CHANGED", "SECRET", b) }));
  assert.equal(tracker.report.error.code, "ARTIFACT_CHANGED");
  assert.equal(tracker.report.error.remoteState, "present");
  assert.equal(tracker.report.packages[1].publication, "not-attempted");
  tracker.progress({ kind: "phase", phase: "publish" });
  tracker.fail(new Error("lost acknowledgment SECRET"));
  assert.equal(tracker.report.packages[1].publication, "unknown");
  assert.equal(tracker.report.error.remoteState, "unknown");
  assert.ok(!JSON.stringify(tracker.report).includes("SECRET"));
});

async function actionFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "releaseway-artifact-report-test-"));
  const writes = [];
  const env = { GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "a".repeat(40), RUNNER_TEMP: root,
    GITHUB_OUTPUT: join(root, "outputs"), GITHUB_STEP_SUMMARY: join(root, "summary"), "INPUT_ARTIFACTS-MANIFEST": "artifacts.json" };
  const options = { env, actionPath: root, appendOutput: (_path, data) => writes.push(data) };
  const output = async name => {
    const path = writes.find(line => line.startsWith(name + "="))?.slice(name.length + 1).trim();
    return path ? JSON.parse(await readFile(path, "utf8")) : undefined;
  };
  try { await run({ root, writes, options, output }); }
  finally { await rm(root, { recursive: true, force: true }); }
}
const noop = async (_context, dependencies) => {
  const tracker = { progress: event => dependencies.onProgress(event) };
  supplied(tracker);
  emit(tracker, { phase: "existing", identity: a }); emit(tracker, { phase: "existing", identity: b });
  emit(tracker, { phase: "public", identity: a, integrity: digest, matched: true });
  emit(tracker, { phase: "preflight" });
  return [{ ...a, state: "already-published" }, { ...b, state: "already-published" }];
};

test("action emits the new sidecar while preserving exact legacy output and diagnostics shapes", async () => actionFixture(async h => {
  const packages = await runAction({ ...h.options, release: noop });
  assert.deepEqual(packages, [{ ...a, state: "already-published" }, { ...b, state: "already-published" }]);
  assert.deepEqual((await h.output("report-path")).results, packages);
  assert.equal((await h.output("diagnostics-path")).packages[0].verification, "exists");
  const sidecar = await h.output("artifact-report-path");
  assert.equal(sidecar.status, "success"); assert.equal(sidecar.publicationCommit, "a".repeat(40));
  assert.equal(sidecar.packages[0].publicVerification, "matched");
  assert.match(await readFile(join(h.root, "summary"), "utf8"), /Prepacked artifact verification/);
}));

test("real invalid manifest failure still emits sanitized report with the raw document SRI and no packages output", async () => actionFixture(async h => {
  await writeFile(join(h.root, "package.json"), JSON.stringify({ ...a, repository: "owner/repo" }));
  await writeFile(join(h.root, "artifacts.json"), "{SECRET");
  await assert.rejects(runAction({ ...h.options, dependencies: { verifySource() {} } }), /valid artifact manifest/);
  const report = await h.output("artifact-report-path");
  assert.equal(report.status, "failed"); assert.equal(report.preflight, "not-complete");
  assert.equal(report.error.code, "MANIFEST_INVALID");
  assert.match(report.manifestIntegrity, /^sha512-/);
  assert.ok(!JSON.stringify(report).includes("SECRET"));
  assert.ok(!h.writes.some(line => line.startsWith("packages=")));
}));

test("report write failure fails a successful action but cannot replace its original failure", async () => actionFixture(async h => {
  const writeArtifactReport = async () => { throw new Error("report disk failed"); };
  await assert.rejects(runAction({ ...h.options, release: noop, writeArtifactReport }), /report disk failed/);
  await assert.rejects(runAction({ ...h.options, release: async () => { throw new ArtifactError("SOURCE_MISMATCH", "original source failure"); }, writeArtifactReport }), /original source failure/);
}));

test("public mismatch invalidates a previous matching observation without reflecting raw errors", () => {
  const tracker = new ArtifactReporter(); supplied(tracker);
  emit(tracker, { phase: "public", identity: a, integrity: digest, matched: true });
  tracker.fail(new ArtifactError("PUBLIC_INTEGRITY_MISMATCH", "secret", a, null, "present"));
  assert.equal(tracker.report.packages[0].publicVerification, "mismatched");
  assert.equal(tracker.report.packages[0].publicIntegrity, null);
  assert.equal(tracker.report.error.recovery, "inspect-remote");
  assert.deepEqual(Object.keys(tracker.report.error).sort(), ["code", "entryIndex", "package", "recovery", "remoteState"]);
});
