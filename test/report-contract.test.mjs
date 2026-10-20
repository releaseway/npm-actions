import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { writeReleaseReport } from "../src/report.ts";

test("legacy report JSON remains a strict schema 1 document independent of new diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "npm-report-contract-"));
  try {
    const legacy = { schema: 1, source: { repository: "owner/repo", commit: "a".repeat(40) }, status: "failed", stage: "publish", plan: [], results: [], failedPackage: { name: "tool", version: "1.2.0" } };
    const path = await writeReleaseReport(legacy, { RUNNER_TEMP: root });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), legacy);
    const schema = JSON.parse(await readFile(new URL("../contracts/diagnostics-v1.schema.json", import.meta.url), "utf8"));
    const diagnostic = JSON.parse(await readFile(new URL("./fixtures/release-contract/diagnostics-v1.json", import.meta.url), "utf8"));
    assert.deepEqual(Object.keys(diagnostic).sort(), schema.required.toSorted());
    assert.equal(schema.additionalProperties, false);
    assert.ok(schema.required.includes("schema"));
  } finally { await rm(root, { recursive: true, force: true }); }
});
