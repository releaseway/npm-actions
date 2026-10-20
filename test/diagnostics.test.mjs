import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAction } from "../src/action.ts";
import { ReleaseError } from "../src/release-error.ts";

test("npm sidecar distinguishes existence, verified bytes, stage acceptance and partial failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-diagnostics-"));
  try {
    for (const fail of [false, true]) {
      const writes = [];
      const packages = [{ name: "a", version: "1.2.0", state: "already-published" }, { name: "b", version: "1.2.0", state: "published" }, { name: "c", version: "1.2.0", state: "staged" }];
      const options = {
        env: { GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "a".repeat(40), GITHUB_OUTPUT: "/output", RUNNER_TEMP: root, NODE_AUTH_TOKEN: "SECRET_SENTINEL" },
        actionPath: "/action", appendOutput(_path, data) { writes.push(data); },
        release: async (_context, deps) => {
          deps.onProgress({ kind: "selection", tag: "v1.2.0", version: "1.2.0" });
          deps.onProgress({ kind: "plan", plan: [], alreadyPublished: [packages[0]] });
          deps.onProgress({ kind: "completed", result: packages[1] });
          deps.onProgress({ kind: "completed", result: packages[2] });
          if (fail) throw new Error("SECRET_SENTINEL", { cause: new ReleaseError("REMOTE_UNCERTAIN", "SECRET_SENTINEL", "unknown") });
          return packages;
        },
      };
      if (fail) await assert.rejects(runAction(options), /SECRET_SENTINEL/); else await runAction(options);
      const path = writes.find((line) => line.startsWith("diagnostics-path=")).slice("diagnostics-path=".length).trim();
      const text = await readFile(path, "utf8"), diagnostic = JSON.parse(text);
      assert.equal(text.includes("SECRET_SENTINEL"), false);
      assert.deepEqual(diagnostic.packages.map((entry) => entry.verification), ["exists", "sha512", "stage-accepted"]);
      assert.equal(diagnostic.verification.artifacts, "mixed");
      assert.equal(diagnostic.verification.publication, "mixed");
      assert.equal(diagnostic.verification.channel, "not-checked");
      assert.equal(diagnostic.selection.strategy, null);
      assert.equal(diagnostic.status, fail ? "failed" : "success");
      assert.equal(diagnostic.error?.code ?? null, fail ? "REMOTE_UNCERTAIN" : null);
      assert.equal(writes.some((line) => line.startsWith("packages=")), !fail);
      const legacy = JSON.parse(await readFile(writes.find((line) => line.startsWith("report-path=")).slice("report-path=".length).trim(), "utf8"));
      assert.equal(legacy.schema, 1); assert.equal("selection" in legacy, false);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("diagnostic persistence failure cannot replace an original publication failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-diagnostics-failure-"));
  try {
    const options = { env: { GITHUB_WORKSPACE: root, GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "a".repeat(40), GITHUB_OUTPUT: "/output", RUNNER_TEMP: root }, actionPath: "/action", appendOutput() {}, writeDiagnostics() { throw new Error("disk unavailable"); }, release: async () => { throw new Error("original publish error"); } };
    await assert.rejects(runAction(options), /original publish error/);
    await assert.rejects(runAction({ ...options, release: async () => [] }), /disk unavailable/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
