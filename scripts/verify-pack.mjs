import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";

import validationVersions from "../validation-versions.json" with { type: "json" };

import { packPackage } from "../src/pack/index.ts";
import {
  bootstrapReleasewayToolchain,
  provisionPackageManager,
  releasewayNpmCommand,
} from "../src/toolchain/bootstrap.ts";

function runManager(command, args, cwd) {
  const result = spawnSync(
    command.executable,
    [...command.argsPrefix, ...args],
    {
      cwd,
      env: command.env,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    process.stderr.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    throw new Error(
      command.name + " " + args.join(" ") + " failed with status " + String(result.status),
    );
  }
}

async function writePackage(directory, manifest) {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await writeFile(join(directory, "index.js"), "export const value = 1;\n");
}

function packageModel(directory, manifest) {
  return {
    directory,
    relativeDirectory: ".",
    manifestPath: join(directory, "package.json"),
    manifest,
    name: manifest.name,
    version: manifest.version,
    publishMode: "direct",
  };
}

const temp = await mkdtemp(join(tmpdir(), "releaseway-pack-integration-"));
const toolchain = await bootstrapReleasewayToolchain({ rootBase: temp });

try {
  const npmRoot = join(temp, "npm");
  const npmManifest = {
    name: "releaseway-pack-npm-fixture",
    version: "1.0.0",
  };
  await writePackage(npmRoot, npmManifest);
  const npmArtifact = await packPackage(
    packageModel(npmRoot, npmManifest),
    releasewayNpmCommand(toolchain),
    join(temp, "npm-out"),
  );
  if (npmArtifact.manifest.name !== npmManifest.name) {
    throw new Error("npm pack integration returned the wrong package");
  }

  const pnpmRoot = join(temp, "pnpm-workspace");
  const pnpmA = join(pnpmRoot, "packages", "a");
  const pnpmB = join(pnpmRoot, "packages", "b");
  await writeFile(
    join(pnpmRoot, "pnpm-workspace.yaml"),
    "packages:\n  - packages/*\n",
  ).catch(async (error) => {
    if (error?.code === "ENOENT") {
      await mkdir(pnpmRoot, { recursive: true });
      await writeFile(
        join(pnpmRoot, "pnpm-workspace.yaml"),
        "packages:\n  - packages/*\n",
      );
      return;
    }
    throw error;
  });
  await writePackage(pnpmA, {
    name: "@releaseway-fixture/pnpm-a",
    version: "1.0.0",
  });
  const pnpmManifest = {
    name: "@releaseway-fixture/pnpm-b",
    version: "1.0.0",
    dependencies: {
      "@releaseway-fixture/pnpm-a": "workspace:^",
    },
  };
  await writePackage(pnpmB, pnpmManifest);
  const pnpmCommand = provisionPackageManager(
    "pnpm@" + validationVersions.pnpm,
    toolchain,
    pnpmRoot,
  );
  runManager(pnpmCommand, ["install", "--ignore-scripts"], pnpmRoot);
  const pnpmArtifact = await packPackage(
    packageModel(pnpmB, pnpmManifest),
    pnpmCommand,
    join(temp, "pnpm-out"),
  );
  if (
    pnpmArtifact.manifest.dependencies?.["@releaseway-fixture/pnpm-a"] !==
    "^1.0.0"
  ) {
    throw new Error("pnpm pack did not rewrite workspace:^ to ^1.0.0");
  }

  const yarnRoot = join(temp, "yarn-workspace");
  const yarnA = join(yarnRoot, "packages", "a");
  const yarnB = join(yarnRoot, "packages", "b");
  await mkdir(yarnRoot, { recursive: true });
  await writeFile(
    join(yarnRoot, "package.json"),
    JSON.stringify(
      {
        private: true,
        packageManager: "yarn@" + validationVersions.yarn,
        workspaces: ["packages/*"],
      },
      null,
      2,
    ) + "\n",
  );
  await writePackage(yarnA, {
    name: "@releaseway-fixture/yarn-a",
    version: "1.0.0",
  });
  const yarnManifest = {
    name: "@releaseway-fixture/yarn-b",
    version: "1.0.0",
    dependencies: {
      "@releaseway-fixture/yarn-a": "workspace:^",
    },
  };
  await writePackage(yarnB, yarnManifest);

  const yarnCommand = {
    name: "yarn",
    version: validationVersions.yarn,
    executable: process.execPath,
    argsPrefix: [
      resolve("node_modules/@yarnpkg/cli-dist/bin/yarn.js"),
    ],
    env: {
      ...process.env,
      COREPACK_ENABLE_PROJECT_SPEC: "0",
      YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
    },
  };
  runManager(yarnCommand, ["install", "--mode=skip-build"], yarnRoot);
  const yarnArtifact = await packPackage(
    packageModel(yarnB, yarnManifest),
    yarnCommand,
    join(temp, "yarn-out"),
  );
  if (
    yarnArtifact.manifest.dependencies?.["@releaseway-fixture/yarn-a"] !==
    "^1.0.0"
  ) {
    throw new Error("Yarn pack did not rewrite workspace:^ to ^1.0.0");
  }
} finally {
  await rm(temp, { recursive: true, force: true });
}
