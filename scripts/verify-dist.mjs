import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

const temp = await mkdtemp(join(tmpdir(), "releaseway-npm-actions-dist-"));

try {
  const result = spawnSync(
    process.execPath,
    [resolve("scripts/build.mjs"), "--outdir", temp],
    { cwd: process.cwd(), encoding: "utf8" },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    process.exit(result.status ?? 1);
  }

  for (const filename of [
    "main.js",
    "native-runtime.cjs",
  ]) {
    const [expected, actual] = await Promise.all([
      readFile(resolve("dist", filename)),
      readFile(join(temp, filename)),
    ]);

    if (!expected.equals(actual)) {
      throw new Error(
        `dist/${filename} is stale; run npm run build and commit the generated bundle`,
      );
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
