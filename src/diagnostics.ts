import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { valid } from "semver";
import { ReleaseError, recoveries, type ReleaseErrorCode } from "./release-error.ts";

export interface Diagnostics {
  schema: 1;
  component: "prepare" | "release" | "npm";
  operation: "plan" | "prepare" | "resume" | "resolve" | "tag" | "publish" | "preview";
  status: "success" | "failed";
  phase: "input" | "plan" | "bind-tag" | "resolve" | "pack" | "publish" | "verify" | "complete";
  selection: { source: string | null; commit: string | null; tag: string | null; version: string | null; strategy: "release-commit" | "source-tag" | null };
  verification: { remoteTag: "not-checked" | "matched" | "mismatched"; artifacts: "not-checked" | "matched" | "mixed"; publication: "not-checked" | "public" | "staged" | "mixed"; channel: "not-checked" };
  packages: { name: string; version: string; state: "already-published" | "published" | "staged"; verification: "exists" | "sha512" | "stage-accepted" }[];
  error: { code: ReleaseErrorCode; recovery: typeof recoveries[ReleaseErrorCode]; remoteState: "unchanged" | "present" | "unknown" } | null;
}
export const safeSha = (value: string | undefined): string | null => value && /^[a-f0-9]{40}$/i.test(value) ? value.toLowerCase() : null;
export const safeVersion = (value: string | undefined): string | null => value && valid(value) === value ? value : null;
export function newDiagnostics(component: Diagnostics["component"], operation: Diagnostics["operation"]): Diagnostics {
  return { schema: 1, component, operation, status: "failed", phase: "input", selection: { source: null, commit: null, tag: null, version: null, strategy: null }, verification: { remoteTag: "not-checked", artifacts: "not-checked", publication: "not-checked", channel: "not-checked" }, packages: [], error: null };
}
export function failDiagnostics(diagnostic: Diagnostics, error: unknown, fallback: ReleaseErrorCode = "INTERNAL_ERROR"): void {
  for (let depth = 0; depth < 8 && error instanceof Error && !(error instanceof ReleaseError) && error.cause; depth++) error = error.cause;
  const code = error instanceof ReleaseError ? error.code : fallback;
  diagnostic.status = "failed";
  diagnostic.error = { code, recovery: recoveries[code], remoteState: error instanceof ReleaseError ? error.remoteState : ["publish", "verify", "bind-tag"].includes(diagnostic.phase) ? "unknown" : "unchanged" };
  if (code === "TAG_COMMIT_MISMATCH") diagnostic.verification.remoteTag = "mismatched";
}
export function completeDiagnostics(diagnostic: Diagnostics): void {
  diagnostic.status = "success"; diagnostic.phase = "complete"; diagnostic.error = null;
}
export function packageDiagnostics(diagnostic: Diagnostics, results: readonly { name: string; version: string; state: "already-published" | "published" | "staged" }[]): void {
  diagnostic.packages = results.map(({ name, version, state }) => ({ name, version, state, verification: state === "already-published" ? "exists" : state === "published" ? "sha512" : "stage-accepted" }));
  const matches = diagnostic.packages.filter((entry) => entry.verification === "sha512").length;
  diagnostic.verification.artifacts = matches === 0 ? "not-checked" : matches === diagnostic.packages.length ? "matched" : "mixed";
  const staged = results.some((entry) => entry.state === "staged"), live = results.some((entry) => entry.state !== "staged");
  diagnostic.verification.publication = staged && live ? "mixed" : staged ? "staged" : live ? "public" : "not-checked";
}
export function writeDiagnostics(diagnostic: Diagnostics, env: NodeJS.ProcessEnv, append: (path: string, data: string, options: { encoding: "utf8" }) => void = appendFileSync): string {
  const root = resolve(env.RUNNER_TEMP || tmpdir());
  mkdirSync(root, { recursive: true });
  const directory = mkdtempSync(join(root, "releaseway-diagnostics-"));
  const path = join(directory, "diagnostics.json");
  writeFileSync(path, JSON.stringify(diagnostic, null, 2) + "\n", { mode: 0o600 });
  if (env.GITHUB_OUTPUT) append(env.GITHUB_OUTPUT, `diagnostics-path=${path}\n`, { encoding: "utf8" });
  return path;
}
