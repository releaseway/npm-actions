import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import { NPM_REGISTRY } from "../registry/client.ts";
import type { ReleasewayToolchain } from "../toolchain/bootstrap.ts";
import type { PackageManifest } from "../workspace/discover.ts";
import {
  assertTrustedPublishingEnvironment,
  isolatedPublisherEnvironment,
} from "./environment.ts";
import { derivePublishOptions } from "./options.ts";

export type PublishMode = "direct" | "stage";
export type PublicationMutationState = "direct-accepted" | "staged";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type RunPublisher = (
  executable: string,
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
  },
) => RunResult;

const defaultRunPublisher: RunPublisher = (executable, args, options) => {
  const result = spawnSync(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export interface PublishRequest {
  mode: PublishMode;
  name: string;
  version: string;
  tarballPath: string;
  manifest: PackageManifest;
  latestVersion?: string;
}

export interface PublisherOptions {
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  runPublisher?: RunPublisher;
}

function publicationArgs(
  request: PublishRequest,
  userConfig: string,
  globalConfig: string,
): string[] {
  const mutable = derivePublishOptions(
    request.manifest,
    request.version,
    request.latestVersion,
  );

  const args =
    request.mode === "direct"
      ? ["publish", resolve(request.tarballPath)]
      : ["stage", "publish", resolve(request.tarballPath)];

  args.push(
    `--registry=${NPM_REGISTRY}/`,
    `--userconfig=${userConfig}`,
    `--globalconfig=${globalConfig}`,
  );

  if (mutable.tag) {
    args.push(`--tag=${mutable.tag}`);
  }
  if (mutable.access) {
    args.push(`--access=${mutable.access}`);
  }

  return args;
}

export function isPendingRegistryScanConflict(output: string): boolean {
  return /Cannot publish over previously staged version/i.test(output);
}

export async function publishPackage(
  toolchain: ReleasewayToolchain,
  request: PublishRequest,
  options: PublisherOptions = {},
): Promise<PublicationMutationState> {
  const sourceEnv = options.env ?? process.env;
  assertTrustedPublishingEnvironment(sourceEnv);

  const base = resolve(
    options.tempRoot ?? sourceEnv.RUNNER_TEMP ?? tmpdir(),
  );
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "releaseway-npm-publish-"));

  try {
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const userConfig = join(root, "user.npmrc");
    const globalConfig = join(root, "global.npmrc");
    const safeConfig = `registry=${NPM_REGISTRY}/\n`;
    await Promise.all([
      writeFile(userConfig, safeConfig, { encoding: "utf8", mode: 0o600 }),
      writeFile(globalConfig, safeConfig, { encoding: "utf8", mode: 0o600 }),
    ]);

    const env = isolatedPublisherEnvironment(sourceEnv, home);
    const args = [
      toolchain.npmCli,
      ...publicationArgs(request, userConfig, globalConfig),
    ];
    const runner = options.runPublisher ?? defaultRunPublisher;
    const result = runner(process.execPath, args, {
      cwd: root,
      env,
    });

    const output =
      result.stderr.trim() || result.stdout.trim() || "<no output>";

    if (result.status !== 0) {
      if (
        request.mode === "direct" &&
        isPendingRegistryScanConflict(output)
      ) {
        return "direct-accepted";
      }

      throw new Error(
        `npm ${request.mode === "direct" ? "publish" : "stage publish"} failed for ${request.name}@${request.version}: ${result.stderr.trim() || result.stdout.trim() || "<no output>"}`,
      );
    }

    return request.mode === "direct" ? "direct-accepted" : "staged";
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
