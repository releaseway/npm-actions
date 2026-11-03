import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseProgress } from "./report.ts";
import type { ActivityPhase, PackageIdentity } from "./progress.ts";
import type { ReleaseErrorCode, RemoteState } from "./release-error.ts";
import { ReleaseError } from "./release-error.ts";
import { PublicationFailure, releaseErrorCode } from "./errors.ts";

interface Timing {
  phase: ActivityPhase;
  startedAt: string;
  finishedAt: string | null;
  elapsedMs: number;
  status: "running" | "completed" | "failed" | "skipped";
}
interface ExecutionPackage extends PackageIdentity {
  status: "not-started" | "running" | "completed" | "failed";
  publication: "not-attempted" | "already-published" | "published" | "staged" | "unknown";
  timings: Timing[];
  error: { code: ReleaseErrorCode; phase: "prepare" | "pack" | "import" | "publish" | "verify"; remoteState: RemoteState } | null;
}
export interface ExecutionReport {
  schema: 1;
  status: "success" | "failed";
  concurrency: number;
  elapsedMs: number;
  timings: Timing[];
  packages: ExecutionPackage[];
  error: { code: ReleaseErrorCode; remoteState: RemoteState } | null;
}

/** Per-package state is independent of event interleaving and legacy report schemas. */
export class ExecutionReporter {
  readonly report: ExecutionReport = { schema: 1, status: "failed", concurrency: 1, elapsedMs: 0, timings: [], packages: [], error: null };
  private readonly started = performance.now();
  private order: string[] = [];
  private row(identity: PackageIdentity): ExecutionPackage {
    let row = this.report.packages.find(row => row.name === identity.name && row.version === identity.version);
    if (!row) {
      row = { name: identity.name, version: identity.version, status: "not-started", publication: "not-attempted", timings: [], error: null };
      this.report.packages.push(row);
    }
    return row;
  }
  progress(event: ReleaseProgress): void {
    if (event.kind === "selected") event.packages.forEach(pkg => this.row(pkg));
    else if (event.kind === "plan") {
      this.order = [...event.alreadyPublished, ...event.plan].map(pkg => pkg.name);
      event.alreadyPublished.forEach(pkg => Object.assign(this.row(pkg), { status: "completed", publication: pkg.state }));
      event.plan.forEach(pkg => this.row(pkg));
    } else if (event.kind === "publishing") this.row(event).status = "running";
    else if (event.kind === "deferred") {
      const row = this.row(event);
      row.status = "not-started"; row.publication = "not-attempted";
      const timing = row.timings.findLast(item => item.phase === "npm-command");
      if (timing) timing.status = "skipped";
    } else if (event.kind === "submission") this.row(event).publication = "unknown";
    else if (event.kind === "completed") Object.assign(this.row(event.result), { status: "completed", publication: event.result.state, error: null });
    else if (event.kind === "failed") {
      const row = this.row(event);
      row.status = "failed";
      if (event.remoteState === "unknown") row.publication = "unknown";
      row.error = { code: event.code, phase: event.phase, remoteState: event.remoteState };
    } else if (event.kind === "activity") {
      const timings = event.package ? this.row(event.package).timings : this.report.timings;
      if (event.package && event.state === "failed" && (event.phase === "pack" || event.phase === "import" || event.phase === "prepare")) {
        const row = this.row(event.package);
        row.status = "failed";
        row.error = { code: event.code ?? "INTERNAL_ERROR", phase: event.phase, remoteState: "unchanged" };
      }
      if (event.state === "skipped") timings.push({ phase: event.phase, startedAt: event.at, finishedAt: event.at, elapsedMs: 0, status: "skipped" });
      else if (event.state === "started") timings.push({ phase: event.phase, startedAt: event.at, finishedAt: null, elapsedMs: 0, status: "running" });
      else {
        const timing = timings.findLast(item => item.phase === event.phase && item.status === "running");
        if (timing) {
          timing.elapsedMs = event.elapsedMs;
          if (event.state === "completed" || event.state === "failed") {
            timing.status = event.state;
            timing.finishedAt = event.at;
          }
        }
      }
    }
  }
  finish(success: boolean, error?: unknown): void {
    this.report.status = success ? "success" : "failed";
    this.report.error = success ? null : {
      code: error === undefined ? "INTERNAL_ERROR" : releaseErrorCode(error, "INTERNAL_ERROR"),
      remoteState: this.report.packages.some(row => row.publication === "unknown") ? "unknown"
        : this.report.packages.some(row => row.publication === "published" || row.publication === "staged") ? "present"
        : error instanceof PublicationFailure || error instanceof ReleaseError ? error.remoteState : "unchanged",
    };
    this.report.elapsedMs = Math.max(0, Math.round(performance.now() - this.started));
    for (const row of this.report.packages) {
      if (row.status === "running" && row.publication === "not-attempted") row.status = "not-started";
    }
    this.report.packages.sort((a, b) => {
      const ai = this.order.indexOf(a.name), bi = this.order.indexOf(b.name);
      return ai < 0 || bi < 0 ? a.name.localeCompare(b.name) : ai - bi;
    });
  }
}

export async function writeExecutionReport(report: ExecutionReport, env: NodeJS.ProcessEnv): Promise<string> {
  const base = resolve(env.RUNNER_TEMP ?? tmpdir());
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "releaseway-npm-execution-"));
  const path = join(root, "execution.json");
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  return path;
}
