import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { PackageResult } from "./orchestrate.ts";

export interface ReleasePlanEntry {
  name: string;
  version: string;
  mode: "direct" | "stage";
  integrity: string;
}

export type ReleaseProgress =
  | { kind: "plan"; plan: readonly ReleasePlanEntry[]; alreadyPublished: readonly PackageResult[] }
  | { kind: "publishing"; name: string; version: string }
  | { kind: "completed"; result: PackageResult };

export interface ReleaseReport {
  schema: 1;
  source: { repository: string; commit: string };
  status: "running" | "success" | "failed";
  stage: "prepare" | "publish" | "complete";
  plan: ReleasePlanEntry[];
  results: PackageResult[];
  failedPackage?: { name: string; version: string };
}

export function updateReport(report: ReleaseReport, event: ReleaseProgress): void {
  if (event.kind === "plan") {
    report.plan = event.plan.map(({ name, version, mode, integrity }) => ({ name, version, mode, integrity }));
    report.results = event.alreadyPublished.map(({ name, version, state }) => ({ name, version, state }));
  } else if (event.kind === "publishing") {
    report.stage = "publish";
    report.failedPackage = { name: event.name, version: event.version };
  } else {
    const { name, version, state } = event.result;
    report.results.push({ name, version, state });
    delete report.failedPackage;
  }
}

/** Persist only fixed metadata fields; errors, command output and environment stay outside. */
export async function writeReleaseReport(report: ReleaseReport, env: NodeJS.ProcessEnv): Promise<string> {
  const base = resolve(env.RUNNER_TEMP ?? tmpdir());
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "releaseway-npm-report-"));
  const path = join(directory, "report.json");
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  if (env.GITHUB_STEP_SUMMARY) {
    const safeJson = JSON.stringify(report, null, 2).replace(/`/g, "\\u0060");
    await appendFile(env.GITHUB_STEP_SUMMARY, `### Releaseway npm release\n\n\`\`\`json\n${safeJson}\n\`\`\`\n`);
  }
  return path;
}
