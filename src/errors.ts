import { ReleaseError, type ReleaseErrorCode, type RemoteState } from "./release-error.ts";
import type { PackageIdentity } from "./progress.ts";

export class InvalidPublishConcurrencyError extends ReleaseError {
  constructor() { super("INVALID_INPUT", "publish-concurrency must be a positive safe integer"); }
}

export function releaseErrorCode(error: unknown, fallback: ReleaseErrorCode = "PUBLISH_FAILED"): ReleaseErrorCode {
  if (error instanceof PublicationFailure) return error.code;
  for (let depth = 0; depth < 8 && error instanceof Error; depth++, error = error.cause) {
    if (error instanceof ReleaseError) return error.code;
  }
  return fallback;
}

export class PublicationFailure extends Error {
  readonly identity: PackageIdentity;
  readonly phase: "publish" | "verify";
  readonly code: ReleaseErrorCode;
  readonly remoteState: RemoteState;
  constructor(identity: PackageIdentity, phase: "publish" | "verify", remoteState: RemoteState, error: unknown, completed: string) {
    super(`Publication failed for ${identity.name}@${identity.version}; completed before failure: ${completed}; cause: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    this.identity = { name: identity.name, version: identity.version };
    this.phase = phase;
    this.code = releaseErrorCode(error);
    this.remoteState = remoteState;
  }
}

export function escapeWorkflowCommand(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

export function errorMessage(error: unknown): string {
  if (error instanceof InvalidPublishConcurrencyError) return "publish-concurrency must be a positive safe integer";
  if (error instanceof PublicationFailure) {
    return `Releaseway npm failed for ${JSON.stringify(error.identity.name + "@" + error.identity.version)} during ${error.phase} (${error.code}, remote: ${error.remoteState}). Inspect release reports before retrying.`;
  }
  const code = error instanceof ReleaseError ? error.code : "INTERNAL_ERROR";
  return `Releaseway npm failed (${code}). Inspect release reports and configuration before retrying.`;
}

export function githubErrorCommand(error: unknown): string {
  return "::error::" + escapeWorkflowCommand(errorMessage(error));
}
