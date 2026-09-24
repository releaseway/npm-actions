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
  const sourceExecutable = join(source, "bin", executableName);
  await mkdir(join(source, "bin"), { recursive: true });
  await copyFile(process.execPath, sourceExecutable);

  const archive = join(root, "node-fixture.tar.gz");
  await tar.c(
    {
      cwd: source,
      file: archive,
      gzip: true,
      portable: true,
    },
    ["bin"],
  );

  const bytes = await readFile(archive);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const targetName = detectNativeTarget();
  const target = {
    asset: "node-fixture.tar.gz",
    executable: "bin/" + executableName,
    sha256: digest,
  };
  const manifest = {
    repository: "releaseway/example",
    version: "0.0.0",
    tag: "fixture",
    targets: {
      [targetName]: target,
    },
  };

  const cached = await prepareNativeExecutable(manifest, target, {
    root: join(root, "cache"),
    download: async () => bytes,
  });
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
} finally {
  await rm(root, { recursive: true, force: true });
}
