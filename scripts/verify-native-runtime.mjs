import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import process from "node:process";
import * as tar from "tar";

import { prepareNativeExecutable } from "../src/native/launcher/cache.ts";
import { detectNativeTarget } from "../src/native/launcher/target.ts";

const root = await mkdtemp(join(tmpdir(), "releaseway-native-runtime-smoke-"));

try {
  const source = join(root, "source");
  const executableName = basename(process.execPath);
  await mkdir(join(source, "a"), { recursive: true });
  await mkdir(join(source, "b"), { recursive: true });
  await copyFile(process.execPath, join(source, "a", executableName));
  await copyFile(process.execPath, join(source, "b", executableName));

  const archive = join(root, "node-fixture.tar.gz");
  await tar.c(
    {
      cwd: source,
      file: archive,
      gzip: true,
      portable: true,
    },
    ["a", "b"],
  );

  const bytes = await readFile(archive);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const targetName = detectNativeTarget();
  const targetA = {
    asset: "node-fixture.tar.gz",
    executable: "a/" + executableName,
    sha256: digest,
  };
  const targetB = {
    asset: "node-fixture.tar.gz",
    executable: "b/" + executableName,
    sha256: digest,
  };
  const manifestA = {
    repository: "releaseway/example",
    version: "0.0.0",
    tag: "fixture",
    targets: {
      [targetName]: targetA,
    },
  };
  const manifestB = {
    ...manifestA,
    targets: {
      [targetName]: targetB,
    },
  };

  let downloads = 0;
  const download = async () => {
    downloads += 1;
    return bytes;
  };
  const cacheRoot = join(root, "cache");
  const [cachedA, cachedB] = await Promise.all([
    prepareNativeExecutable(manifestA, targetA, {
      root: cacheRoot,
      download,
    }),
    prepareNativeExecutable(manifestB, targetB, {
      root: cacheRoot,
      download,
    }),
  ]);

  if (cachedA === cachedB) {
    throw new Error("Distinct executable paths reused one native cache path");
  }
  if (downloads !== 1) {
    throw new Error(
      "Shared native archive downloaded " + String(downloads) + " times",
    );
  }

  for (const cached of [cachedA, cachedB]) {
    const result = spawnSync(cached, ["--version"], {
      encoding: "utf8",
    });

    if (result.status !== 0) {
      process.stderr.write(result.stderr ?? "");
      throw new Error(
        "Cached native executable failed with status " + String(result.status),
      );
    }
    if ((result.stdout ?? "").trim() !== process.version) {
      throw new Error(
        "Cached native executable returned unexpected version: " +
          (result.stdout ?? "").trim(),
      );
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
