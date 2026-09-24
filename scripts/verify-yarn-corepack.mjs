import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import validationVersions from "../validation-versions.json" with { type: "json" };

import { packPackage } from "../src/pack/index.ts";
import {
  bootstrapReleasewayToolchain,
  provisionPackageManager,
} from "../src/toolchain/bootstrap.ts";
import { packageOperationEnvironment } from "../src/toolchain/environment.ts";

function run(command, args, cwd) {
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
      command.name +
        " " +
        args.join(" ") +
        " failed with status " +
        String(result.status),
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

const root = await mkdtemp(
  join(tmpdir(), "releaseway-yarn-corepack-integration-"),
);
const toolchain = await bootstrapReleasewayToolchain({ rootBase: root });

try {
  const workspace = join(root, "workspace");
  const packageA = join(workspace, "packages", "a");
  const packageB = join(workspace, "packages", "b");

  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(workspace, "package.json"),
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
  await writePackage(packageA, {
    name: "@releaseway-fixture/yarn-a",
    version: "1.0.0",
  });
  const manifest = {
    name: "@releaseway-fixture/yarn-b",
    version: "1.0.0",
    dependencies: {
      "@releaseway-fixture/yarn-a": "workspace:^",
    },
  };
  await writePackage(packageB, manifest);

  const command = provisionPackageManager(
    "yarn@" + validationVersions.yarn,
    toolchain,
    workspace,
    {
      ...packageOperationEnvironment(process.env),
      YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
    },
  );

  run(command, ["install", "--mode=skip-build"], workspace);

  const artifact = await packPackage(
    packageModel(packageB, manifest),
    command,
    join(root, "out"),
  );

  if (
    artifact.manifest.dependencies?.["@releaseway-fixture/yarn-a"] !==
    "^1.0.0"
  ) {
    throw new Error(
      "Corepack-provisioned Yarn did not rewrite workspace:^ to ^1.0.0",
    );
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
