import type { ReleaseProgress } from "./report.ts";
import { releaseErrorCode } from "./errors.ts";
import type { ReleaseErrorCode } from "./release-error.ts";

export interface PackageIdentity { name: string; version: string }
export type ActivityPhase = "prepare" | "pack" | "import" | "npm-command" | "public-check";
export interface ActivityEvent {
  kind: "activity";
  package: PackageIdentity | null;
  phase: ActivityPhase;
  state: "started" | "waiting" | "completed" | "failed" | "skipped";
  at: string;
  elapsedMs: number;
  code?: ReleaseErrorCode;
}
export type ProgressObserver = (event: ReleaseProgress) => void;
export const HEARTBEAT_MS = 30_000;

/** Heartbeats observe work; they never initiate registry requests or extend deadlines. */
export async function activity<T>(
  pkg: PackageIdentity | null,
  phase: ActivityPhase,
  observe: ProgressObserver | undefined,
  work: () => Promise<T>,
  heartbeatMs = 0,
): Promise<T> {
  const started = performance.now();
  const emit = (state: ActivityEvent["state"], error?: unknown) => observe?.({
    kind: "activity", package: pkg && { name: pkg.name, version: pkg.version }, phase, state,
    at: new Date().toISOString(), elapsedMs: Math.max(0, Math.round(performance.now() - started)),
    ...(state === "failed" ? { code: releaseErrorCode(error, "INTERNAL_ERROR") } : {}),
  });
  emit("started");
  const timer = heartbeatMs > 0 && observe ? setInterval(() => {
    try { emit("waiting"); } catch { /* A periodic observer cannot abort an in-flight command. */ }
  }, heartbeatMs) : undefined;
  timer?.unref();
  try {
    const result = await work();
    emit("completed");
    return result;
  } catch (error) {
    emit("failed", error);
    throw error;
  } finally {
    if (timer) clearInterval(timer);
  }
}

export function logProgress(event: ReleaseProgress, write: (line: string) => void = console.log): void {
  if (event.kind === "plan") {
    event.alreadyPublished.forEach(result => logProgress({ kind: "completed", result }, write));
    return;
  }
  if (event.kind !== "activity" && event.kind !== "completed" && event.kind !== "failed") return;
  const identity = event.kind === "activity" ? event.package : event.kind === "completed" ? event.result : event;
  const label = identity ? JSON.stringify(identity.name + "@" + identity.version) : "release";
  const detail = event.kind === "activity"
    ? `${event.phase} ${event.state} elapsed=${(event.elapsedMs / 1000).toFixed(1)}s`
    : event.kind === "completed" ? event.result.state : `failed phase=${event.phase} code=${event.code} remote=${event.remoteState}`;
  // JSON quoting prevents package metadata from introducing extra workflow-command lines.
  try { write(`[releaseway/npm] ${label} ${detail}`); }
  catch { /* Logging cannot change the outcome of an accepted publication. */ }
}
