import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  runRelease,
  type OrchestrationDependencies,
  type PackageResult,
} from "./orchestrate.ts";
import { githubContextFromEnv } from "./workspace/identity.ts";
import { updateReport, writeReleaseReport, type ReleaseReport } from "./report.ts";

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
    writeReport?: typeof writeReleaseReport;
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

  const report: ReleaseReport = {
    schema: 1, source: { repository: github.repository, commit: github.sha },
    status: "running", stage: "prepare", plan: [], results: [],
  };
  const append = options.appendOutput ?? appendFileSync;
  try {
    const packages = await (options.release ?? runRelease)(
      { ...github, actionPath, env },
      {
        ...options.dependencies,
        onProgress(event) {
          updateReport(report, event);
          options.dependencies?.onProgress?.(event);
        },
      },
    );
    writePackagesOutput(outputPath, packages, append);
    report.results = packages.map(({ name, version, state }) => ({ name, version, state }));
    report.status = "success";
    report.stage = "complete";
    delete report.failedPackage;
    return packages;
  } catch (error) {
    report.status = "failed";
    throw error;
  } finally {
    try {
      const path = await (options.writeReport ?? writeReleaseReport)(report, env);
      append(outputPath, "report-path=" + path + "\n", { encoding: "utf8" });
    } catch (error) {
      if (report.status !== "failed") throw error;
      console.warn("Release report could not be saved; preserving the original release failure");
    }
  }
}
