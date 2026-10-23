import { newDiagnostics, safeSha, packageDiagnostics, completeDiagnostics, failDiagnostics, writeDiagnostics } from "./diagnostics.ts";
import { appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  runRelease,
  type OrchestrationDependencies,
  type PackageResult,
} from "./orchestrate.ts";
import { githubContextFromEnv } from "./workspace/identity.ts";
import { updateReport, writeReleaseReport, type ReleaseReport } from "./report.ts";
import { ArtifactReporter, writeArtifactReport } from "./artifacts/report.ts";

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
    writeDiagnostics?: typeof writeDiagnostics;
    writeArtifactReport?: typeof writeArtifactReport;
  } = {},
): Promise<PackageResult[]> {
  const env = options.env ?? process.env;
  const append = options.appendOutput ?? appendFileSync;
  const diagnostic = newDiagnostics("npm", "publish");
  diagnostic.selection.source = safeSha(env.GITHUB_SHA);
  let report: ReleaseReport | undefined;
  let failed = false;
  const artifacts = env["INPUT_ARTIFACTS-MANIFEST"]?.trim() ? new ArtifactReporter() : undefined;
  try {
    const github = githubContextFromEnv(env);
    diagnostic.selection.commit = github.sha;
    if (artifacts) artifacts.report.publicationCommit = github.sha;
    const actionPath = resolveActionPath(options.actionPath, env, options.argv ?? process.argv);
    const outputPath = requiredEnvironment(env, "GITHUB_OUTPUT");
    report = { schema: 1, source: { repository: github.repository, commit: github.sha }, status: "running", stage: "prepare", plan: [], results: [] };
    const packages = await (options.release ?? runRelease)(
      { ...github, actionPath, env },
      {
        ...options.dependencies,
        onProgress(event) {
          updateReport(report!, event);
          artifacts?.progress(event);
          if (event.kind === "selection") {
            diagnostic.selection.tag = event.tag;
            diagnostic.selection.version = event.version;
            diagnostic.verification.remoteTag = "matched";
          } else if (event.kind === "phase") diagnostic.phase = event.phase;
          else if (event.kind === "publishing") diagnostic.phase = "publish";
          packageDiagnostics(diagnostic, report!.results);
          options.dependencies?.onProgress?.(event);
        },
      },
    );
    artifacts?.complete();
    writePackagesOutput(outputPath, packages, append);
    report.results = packages.map(({ name, version, state }) => ({ name, version, state }));
    report.status = "success"; report.stage = "complete";
    delete report.failedPackage;
    packageDiagnostics(diagnostic, packages);
    completeDiagnostics(diagnostic);
    return packages;
  } catch (error) {
    failed = true;
    if (report) report.status = "failed";
    artifacts?.fail(error);
    failDiagnostics(diagnostic, error, diagnostic.phase === "input" ? "INVALID_INPUT" : "PUBLISH_FAILED");
    throw error;
  } finally {
    let outputFailure: unknown;
    if (report) {
      try {
        const path = await (options.writeReport ?? writeReleaseReport)(report, env);
        append(env.GITHUB_OUTPUT!, "report-path=" + path + "\n", { encoding: "utf8" });
      } catch (error) {
        outputFailure = error;
        if (failed) console.warn("Release report could not be saved; preserving the original release failure");
      }
    }
    try { (options.writeDiagnostics ?? writeDiagnostics)(diagnostic, env, append); }
    catch (error) {
      outputFailure ??= error;
      if (failed) console.warn("Diagnostics could not be saved; preserving the original failure. Inspect the registry before retrying.");
    }
    if (artifacts) {
      if (!failed && outputFailure) artifacts.fail(outputFailure);
      try {
        const path = await (options.writeArtifactReport ?? writeArtifactReport)(artifacts.report, env);
        if (env.GITHUB_OUTPUT) append(env.GITHUB_OUTPUT, "artifact-report-path=" + path + "\n", { encoding: "utf8" });
      } catch (error) {
        outputFailure ??= error;
        if (failed) console.warn("Artifact verification report could not be saved; preserving the original failure");
      }
    }
    if (!failed && outputFailure) throw outputFailure;
  }
}
