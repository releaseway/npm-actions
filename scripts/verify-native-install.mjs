import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import * as tar from "tar";

import { augmentNativeArtifact } from "../src/native/augment.ts";
import {
  nativeCacheRoot,
  prepareNativeExecutable,
} from "../src/native/launcher/cache.ts";
import { detectNativeTarget } from "../src/native/launcher/target.ts";
import { validateNativeDistribution } from "../src/native/validate.ts";
import { inspectPackedTarball } from "../src/pack/inspect.ts";

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error("npm_execpath is required for native install verification");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    shell: options.shell ?? false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      [
        `${command} ${args.join(" ")} failed with status ${String(result.status)}`,
        result.stdout ?? "",
        result.stderr ?? "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result;
}

function runNpm(args, options = {}) {
  return run(process.execPath, [npmExecPath, ...args], options);
}

function runInstalledCommand(command, args, options = {}) {
  return run(command, args, {
    ...options,
    shell: process.platform === "win32",
  });
}

function expectVersion(result, label) {
  const actual = (result.stdout ?? "").trim();
  if (actual !== process.version) {
    throw new Error(
      `${label} returned ${JSON.stringify(actual)}, expected ${process.version}`,
    );
  }
}

function cacheEnvironment(root) {
  const home = join(root, "h");
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(root, "x"),
    LOCALAPPDATA: join(root, "l"),
  };
  return { env, home };
}

function packageModel(directory, manifest, targetName, target) {
  return {
    directory,
    relativeDirectory: ".",
    manifestPath: join(directory, "package.json"),
    manifest,
    name: manifest.name,
    version: manifest.version,
    publishMode: "direct",
    policy: {
      distribution: {
        type: "github-release",
        tag: "v{version}",
        targets: {
          [targetName]: {
            asset: target.asset,
            executable: target.executable,
          },
        },
      },
    },
  };
}

async function packFixture(directory, manifest) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  const packed = runNpm(
    ["pack", "--ignore-scripts", "--json"],
    { cwd: directory },
  );
  const parsed = JSON.parse(packed.stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1 || !parsed[0]?.filename) {
    throw new Error("npm pack returned an unexpected result");
  }
  return join(directory, parsed[0].filename);
}

function localBinPath(project, command) {
  return join(
    project,
    "node_modules",
    ".bin",
    process.platform === "win32" ? command + ".cmd" : command,
  );
}

function globalBinPath(prefix, command) {
  if (process.platform === "win32") {
    return join(prefix, command + ".cmd");
  }
  return join(prefix, "bin", command);
}

const root = await mkdtemp(join(tmpdir(), "rw-ni-"));

try {
  const runtimeBundle = {
    runtime: await readFile(resolve("dist", "native-runtime.cjs")),
  };
  if (runtimeBundle.runtime.byteLength === 0) {
    throw new Error("dist/native-runtime.cjs is empty");
  }

  const nativeSource = join(root, "native-source");
  const executableName = basename(process.execPath);
  const sourceExecutable = join(nativeSource, "bin", executableName);
  await mkdir(join(nativeSource, "bin"), { recursive: true });
  await copyFile(process.execPath, sourceExecutable);

  const archivePath = join(root, "node-fixture.tar.gz");
  await tar.c(
    {
      cwd: nativeSource,
      file: archivePath,
      gzip: true,
      portable: true,
    },
    ["bin"],
  );
  const archiveBytes = await readFile(archivePath);
  const archiveSha256 = createHash("sha256")
    .update(archiveBytes)
    .digest("hex");
  const targetName = detectNativeTarget();
  const target = {
    asset: "node-fixture.tar.gz",
    executable: "bin/" + executableName,
    sha256: archiveSha256,
  };
  const runtimeManifest = {
    repository: "releaseway/native-install-fixture",
    version: "1.0.0",
    tag: "v1.0.0",
    targets: {
      [targetName]: target,
    },
  };

  const { env, home } = cacheEnvironment(root);
  await mkdir(home, { recursive: true });
  const expectedCacheRoot = nativeCacheRoot({
    env,
    platform: process.platform,
    home,
  });
  await prepareNativeExecutable(runtimeManifest, target, {
    root: expectedCacheRoot,
    env,
    platform: process.platform,
    home,
    download: async () => archiveBytes,
  });

  const fixtures = [
    {
      label: "cjs",
      binPath: "bin/tool.cjs",
      type: "commonjs",
    },
    {
      label: "esm-mjs",
      binPath: "bin/tool.mjs",
    },
    {
      label: "esm-js",
      binPath: "bin/tool.js",
      type: "module",
    },
    {
      label: "esm-extensionless",
      binPath: "bin/tool",
      type: "module",
    },
  ];

  for (const fixture of fixtures) {
    const command = "native-" + fixture.label;
    const fixtureRoot = join(root, "fixture-" + fixture.label);
    const manifest = {
      name: "@releaseway/native-install-" + fixture.label,
      version: "1.0.0",
      ...(fixture.type ? { type: fixture.type } : {}),
      bin: {
        [command]: fixture.binPath,
      },
    };

    const packedPath = await packFixture(fixtureRoot, manifest);
    const artifact = await inspectPackedTarball(packedPath);
    const pkg = packageModel(fixtureRoot, artifact.manifest, targetName, target);
    const distribution = validateNativeDistribution(pkg, artifact);
    const verifiedRelease = {
      repository: runtimeManifest.repository,
      version: manifest.version,
      tag: runtimeManifest.tag,
      targets: {
        [targetName]: target,
      },
    };
    const finalTarball = join(root, fixture.label + "-final.tgz");

    await augmentNativeArtifact(
      pkg,
      artifact,
      distribution,
      verifiedRelease,
      finalTarball,
      runtimeBundle,
      { tempRoot: root },
    );

    const project = join(root, "local-" + fixture.label);
    await mkdir(project, { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify(
        {
          name: "native-install-consumer-" + fixture.label,
          private: true,
          scripts: {
            probe: command + " --version",
          },
        },
        null,
        2,
      ) + "\n",
    );

    runNpm(
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        finalTarball,
      ],
      { cwd: project, env },
    );

    expectVersion(
      runInstalledCommand(localBinPath(project, command), ["--version"], {
        cwd: project,
        env,
      }),
      fixture.label + " local .bin",
    );
    expectVersion(
      runNpm(["exec", "--", command, "--version"], {
        cwd: project,
        env,
      }),
      fixture.label + " npm exec",
    );
    expectVersion(
      runNpm(["run", "--silent", "probe"], {
        cwd: project,
        env,
      }),
      fixture.label + " npm run",
    );

    const prefix = join(root, "global-" + fixture.label);
    runNpm(
      [
        "install",
        "--global",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--prefix",
        prefix,
        finalTarball,
      ],
      { env },
    );
    expectVersion(
      runInstalledCommand(globalBinPath(prefix, command), ["--version"], {
        cwd: root,
        env,
      }),
      fixture.label + " global install",
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
