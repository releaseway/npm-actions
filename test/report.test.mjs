import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runAction } from "../src/action.ts";

test("reports survive cleanup and preserve partial results without secret or subprocess data", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-report-test-"));
  const sentinel = "SECRET_SENTINEL_TOKEN_OIDC";
  try {
    for (const completed of [0, 1, 2]) {
      const writes = [];
      const summary = join(root, `summary-${completed}.md`);
      const work = runAction({
        actionPath: "/action",
        env: { RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: summary, GITHUB_OUTPUT: "/output", GITHUB_WORKSPACE: "/workspace", GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "a".repeat(40), NODE_AUTH_TOKEN: sentinel, ACTIONS_ID_TOKEN_REQUEST_TOKEN: sentinel },
        appendOutput(_path, data) { writes.push(data); },
        release: async (_context, dependencies) => {
          const plan = ["one", "two"].map((name) => ({ name, version: "1.0.0", mode: "stage", integrity: "sha512-fixed" }));
          dependencies.onProgress({ kind: "plan", plan, alreadyPublished: [] });
          for (let index = 0; index < 2; index++) {
            dependencies.onProgress({ kind: "publishing", name: plan[index].name, version: "1.0.0" });
            if (index === completed) throw new Error("subprocess output " + sentinel);
            dependencies.onProgress({ kind: "completed", result: { name: plan[index].name, version: "1.0.0", state: "staged", token: sentinel } });
          }
          return plan.map(({ name, version }) => ({ name, version, state: "staged" }));
        },
      });
      if (completed < 2) await assert.rejects(work, /subprocess output/);
      else await work;
      const output = writes.find((line) => line.startsWith("report-path="));
      assert.ok(output);
      const text = await readFile(output.slice("report-path=".length).trim(), "utf8");
      assert.equal(text.includes(sentinel), false);
      assert.equal(text.includes("subprocess"), false);
      const report = JSON.parse(text);
      assert.equal(report.results.length, completed);
      assert.equal(report.plan.length, 2);
      assert.equal(report.status, completed === 2 ? "success" : "failed");
      if (completed < 2) assert.equal(report.failedPackage.name, completed === 0 ? "one" : "two");
      assert.equal((await readFile(summary, "utf8")).includes(sentinel), false);
      assert.equal(writes.some((line) => line.startsWith("packages=")), completed === 2);
    }
    let path;
    await assert.rejects(runAction({ actionPath: "/action", env: { RUNNER_TEMP: root, GITHUB_OUTPUT: "/output", GITHUB_WORKSPACE: "/workspace", GITHUB_REPOSITORY: "owner/repo", GITHUB_SHA: "a".repeat(40) }, appendOutput(_output, data) { path = data.slice("report-path=".length).trim(); }, release: async () => { throw new Error("prepare " + sentinel); } }), /prepare/);
    const report = JSON.parse(await readFile(path, "utf8"));
    assert.equal(report.stage, "prepare");
    assert.deepEqual(report.plan, []);
    assert.deepEqual(report.results, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
