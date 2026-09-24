import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  runRelease,
  type OrchestrationDependencies,
  type PackageResult,
} from "./orchestrate.ts";
import { githubContextFromEnv } from "./workspace/identity.ts";

type AppendOutput = (
  path: string,
  data: string,
  options: { encoding: "utf8" },
) => void;

type RunRelease = typeof runRelease;

function requiredEnvironment(
  env: NodeJS.ProcessEnv,
  name: string,
): string {
  const value = env[name];
  if (!value) {
    throw new Error(
      `Missing required GitHub Actions environment variable: ${name}`,
    );
  }
  return value;
}

export function writePackagesOutput(
  outputPath: string,
  packages: readonly PackageResult[],
  appendOutput: AppendOutput = appendFileSync,
): void {
  appendOutput(
    outputPath,
    "packages=" + JSON.stringify(packages) + "\n",
    { encoding: "utf8" },
  );
}

export function resolveActionPath(
  explicit: string | undefined,
  env: NodeJS.ProcessEnv,
  argv: readonly string[] = process.argv,
): string {
  if (explicit) {
    return resolve(explicit);
  }
  if (env.GITHUB_ACTION_PATH) {
    return resolve(env.GITHUB_ACTION_PATH);
  }

  const entrypoint = argv[1];
  if (!entrypoint) {
    throw new Error("Unable to determine JavaScript action entrypoint path");
  }
  return resolve(dirname(entrypoint), "..");
}

export async function runAction(
  options: {
    env?: NodeJS.ProcessEnv;
    release?: RunRelease;
    dependencies?: OrchestrationDependencies;
    appendOutput?: AppendOutput;
    actionPath?: string;
    argv?: readonly string[];
  } = {},
): Promise<PackageResult[]> {
  const env = options.env ?? process.env;
  const github = githubContextFromEnv(env);
  const actionPath = resolveActionPath(
    options.actionPath,
    env,
    options.argv ?? process.argv,
  );
  const outputPath = requiredEnvironment(env, "GITHUB_OUTPUT");

  const packages = await (options.release ?? runRelease)(
    {
      ...github,
      actionPath,
      env,
    },
    options.dependencies,
  );

  writePackagesOutput(
    outputPath,
    packages,
    options.appendOutput ?? appendFileSync,
  );
  return packages;
}
