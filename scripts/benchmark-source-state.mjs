// Run on Node 24: node --experimental-strip-types scripts/benchmark-source-state.mjs [baseline.ts]
// Each implementation runs in a fresh process against the same fixture and checks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const exec = (args, cwd) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
};

if (process.argv[2] === "--worker") {
  const { snapshotSourceState, assertSourceStateUnchanged } = await import(pathToFileURL(process.argv[3]));
  const root = process.argv[4];
  const start = performance.now();
  const before = await snapshotSourceState(root);
  for (let i = 0; i < 3; i++) assertSourceStateUnchanged(before, await snapshotSourceState(root));
  const elapsedMs = performance.now() - start;
  const peakRssKiB = process.resourceUsage().maxRSS;
  // Check content, mode, symlink target and ignored build output without trusting git status alone.
  for (const mutate of [
    () => writeFile(join(root, "tracked.txt"), "changed"),
    () => writeFile(join(root, "untracked.txt"), "changed"),
    () => writeFile(join(root, "build/ignored.bin"), "changed"),
    () => chmod(join(root, "tracked.txt"), 0o755),
    async () => { await rm(join(root, "link")); await symlink("untracked.txt", join(root, "link")); },
  ]) {
    const prior = await snapshotSourceState(root);
    await mutate();
    const next = await snapshotSourceState(root);
    assert.throws(() => assertSourceStateUnchanged(prior, next), /mutated/);
  }
  console.log(JSON.stringify({ filesDigest: before.filesDigest, elapsedMs, peakRssKiB }));
} else {
  const variants = process.argv[2] ? [resolve(process.argv[2]), resolve("src/pack/source-state.ts")] : [resolve("src/pack/source-state.ts")];
  const directory = await mkdtemp(join(tmpdir(), "releaseway-source-bench-"));
  try {
    const measurements = [];
    for (const variant of variants) {
      for (let repeat = 0; repeat < 3; repeat++) {
        const root = join(directory, `fixture-${measurements.length}`);
        await mkdir(join(root, "build"), { recursive: true });
        await writeFile(join(root, ".gitignore"), "build/\n");
        await writeFile(join(root, "tracked.txt"), "tracked");
        exec(["init", "--quiet"], root);
        exec(["add", "."], root);
        await writeFile(join(root, "untracked.txt"), "untracked");
        await symlink("tracked.txt", join(root, "link"));
        for (let i = 0; i < 500; i++) await writeFile(join(root, `small-${i}.txt`), Buffer.alloc(4096, i % 256));
        await writeFile(join(root, "build/ignored.bin"), Buffer.alloc(128 * 1024 * 1024, 7));
        const result = spawnSync(process.execPath, ["--experimental-strip-types", import.meta.filename, "--worker", variant, root], { encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
        measurements.push({ implementation: variant, repeat, ...JSON.parse(result.stdout) });
      }
    }
    assert.equal(new Set(measurements.map(item => item.filesDigest)).size, 1, "baseline digest changed");
    const fixture = join(directory, "fixture-0");
    let payloadBytes = 0;
    for (const name of [".gitignore", "tracked.txt", "untracked.txt", ...Array.from({ length: 500 }, (_, i) => `small-${i}.txt`)]) payloadBytes += (await readFile(join(fixture, name))).length;
    payloadBytes += 128 * 1024 * 1024;
    console.log(JSON.stringify({ snapshots: 4, regularFilePayloadBytesPerSnapshot: payloadBytes, regularFilePayloadBytesRead: payloadBytes * 4, measurements }, null, 2));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
