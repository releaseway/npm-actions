import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ReleaseProgress } from "../report.ts";
import { ReleaseError, type RemoteState } from "../release-error.ts";
import { ArtifactError, type ArtifactErrorCode, type ArtifactIdentity } from "./errors.ts";

interface ArtifactPackageReport extends ArtifactIdentity {
  coverage: "supplied" | "not-supplied";
  expectedIntegrity: string | null;
  localIntegrity: string | null;
  publicIntegrity: string | null;
  localVerification: "not-checked" | "not-required" | "matched" | "mismatched";
  publicVerification: "not-checked" | "matched" | "mismatched";
  publication: "not-attempted" | "already-published" | "published" | "staged" | "unknown";
}
export interface ArtifactReport {
  schema: 1;
  mode: "prepacked";
  source: { repository: string; commit: string } | null;
  publicationCommit: string | null;
  manifestIntegrity: string | null;
  status: "success" | "failed";
  preflight: "not-complete" | "passed";
  packages: ArtifactPackageReport[];
  error: {
    code: ArtifactErrorCode;
    entryIndex: number | null;
    package: ArtifactIdentity | null;
    remoteState: RemoteState;
    recovery: "fix-input" | "same-input" | "inspect-remote";
  } | null;
}
const identity = (value: ArtifactIdentity): ArtifactIdentity => ({ name: value.name, version: value.version });

/** Keep verification observations separate from legacy package result semantics. */
export class ArtifactReporter {
  readonly report: ArtifactReport = {
    schema: 1, mode: "prepacked", source: null, publicationCommit: null, manifestIntegrity: null,
    status: "failed", preflight: "not-complete", packages: [], error: null,
  };
  private current: ArtifactPackageReport | null = null;
  private submitting = false;

  private row(value: ArtifactIdentity): ArtifactPackageReport {
    let row = this.report.packages.find(pkg => pkg.name === value.name && pkg.version === value.version);
    if (!row) {
      row = { ...identity(value), coverage: "not-supplied", expectedIntegrity: null, localIntegrity: null, publicIntegrity: null,
        localVerification: "not-checked", publicVerification: "not-checked", publication: "not-attempted" };
      this.report.packages.push(row);
      this.report.packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
    }
    return row;
  }
  progress(event: ReleaseProgress): void {
    if (event.kind === "artifact-verification") {
      const data = event.event;
      if (data.phase === "read") this.report.manifestIntegrity = data.integrity;
      else if (data.phase === "source") this.report.source = { ...data.source };
      else if (data.phase === "preflight") this.report.preflight = "passed";
      else if (data.phase === "selection") data.packages.forEach(pkg => this.row(pkg));
      else if (data.phase === "manifest") data.packages.forEach(pkg => Object.assign(this.row(pkg), { coverage: "supplied", expectedIntegrity: pkg.integrity }));
      else if (data.phase === "existing") Object.assign(this.row(data.identity), { publication: "already-published", localVerification: "not-required" });
      else if (data.phase === "local") Object.assign(this.row(data.identity), { localIntegrity: data.integrity, localVerification: data.matched ? "matched" : "mismatched" });
      else if (data.phase === "public") Object.assign(this.row(data.identity), { publicIntegrity: data.integrity, publicVerification: data.matched ? "matched" : "mismatched" });
    } else if (event.kind === "publishing") {
      this.current = this.row(event); this.submitting = false;
    } else if (event.kind === "phase" && event.phase === "publish") {
      this.submitting = true;
    } else if (event.kind === "completed") {
      const row = this.row(event.result);
      row.publication = event.result.state;
      if (event.result.state === "published") {
        row.publicVerification = "matched"; row.publicIntegrity = row.expectedIntegrity;
      }
      this.submitting = false;
    }
  }
  complete(): void {
    if (this.report.preflight !== "passed") throw new ArtifactError("INTERNAL_ERROR", "Artifact preflight was not completed");
    this.report.status = "success"; this.report.error = null;
  }
  fail(error: unknown): void {
    for (let depth = 0; depth < 8 && error instanceof Error && !(error instanceof ReleaseError) && error.cause; depth++) error = error.cause;
    const artifact = error instanceof ArtifactError ? error : undefined;
    let code: ArtifactErrorCode = artifact?.artifactCode ?? (this.report.preflight === "passed" ? "PUBLISH_FAILED" : "PLAN_INVALID");
    if (!artifact && error instanceof ReleaseError && error.code === "ARTIFACT_MISMATCH") code = "PUBLIC_INTEGRITY_MISMATCH";
    if (code === "PUBLIC_INTEGRITY_MISMATCH") {
      const row = artifact?.identity ? this.row(artifact.identity) : this.current;
      if (row && row.publicVerification !== "mismatched") Object.assign(row, { publicVerification: "mismatched", publicIntegrity: null });
    }
    const localFailure = !!artifact && !["PUBLIC_INTEGRITY_MISMATCH", "REGISTRY_STATE_CHANGED", "REGISTRY_UNAVAILABLE", "PUBLISH_FAILED"].includes(code);
    if (this.current && this.submitting && !localFailure) this.current.publication = "unknown";
    const completed = this.report.packages.some(pkg => pkg.publication === "published" || pkg.publication === "staged");
    const uncertain = this.report.packages.some(pkg => pkg.publication === "unknown");
    const remoteState: RemoteState = uncertain ? "unknown" : completed ? "present" : artifact?.remoteState ?? "unchanged";
    const recovery = ["PUBLIC_INTEGRITY_MISMATCH", "REGISTRY_STATE_CHANGED", "PUBLISH_FAILED", "INTERNAL_ERROR"].includes(code)
      ? "inspect-remote" : code === "REGISTRY_UNAVAILABLE" ? "same-input" : "fix-input";
    this.report.status = "failed";
    this.report.error = { code, entryIndex: artifact?.entryIndex ?? null,
      package: artifact?.identity ? identity(artifact.identity) : this.current ? identity(this.current) : null, remoteState, recovery };
  }
}

export async function writeArtifactReport(report: ArtifactReport, env: NodeJS.ProcessEnv): Promise<string> {
  const base = resolve(env.RUNNER_TEMP ?? tmpdir());
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "releaseway-npm-artifact-report-"));
  const path = join(directory, "artifact-report.json");
  await writeFile(path, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  if (env.GITHUB_STEP_SUMMARY) {
    const matched = report.packages.filter(pkg => pkg.publicVerification === "matched").length;
    await appendFile(env.GITHUB_STEP_SUMMARY, `\n### Prepacked artifact verification\n\nStatus: ${report.status}; public SHA-512 matches: ${matched}; report: ${path}\n`);
  }
  return path;
}
