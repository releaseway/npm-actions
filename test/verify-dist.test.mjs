import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

test("the retained dist gate detects stale shipped bytes without rewriting them", async () => {
  const root = await mkdtemp(join(tmpdir(), "releaseway-dist-gate-"));
  try {
    for (const directory of ["scripts", "src", "node_modules"]) {
      await symlink(resolve(directory), join(root, directory), "junction");
    }
    const built = spawnSync(process.execPath, [resolve("scripts/build.mjs")], { cwd: root, encoding: "utf8" });
    assert.equal(built.status, 0, built.stderr);
    const run = () => spawnSync(process.execPath, [resolve("scripts/verify-dist.mjs")], {
      cwd: root, encoding: "utf8",
    });
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    await writeFile(join(root, "dist/native-runtime.cjs"), "stale bytes\n");
    const stale = run();
    assert.notEqual(stale.status, 0);
    assert.match(stale.stderr, /native-runtime\.cjs is stale/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
