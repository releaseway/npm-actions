import { ReleaseError, type ReleaseErrorCode, type RemoteState } from "../release-error.ts";

export const artifactErrorCodes = {
  MANIFEST_INVALID: "INVALID_INPUT",
  SOURCE_MISMATCH: "PLAN_CONFIG_MISMATCH",
  PACKAGE_SET_MISMATCH: "INVALID_INPUT",
  ARTIFACT_MISSING: "INVALID_INPUT",
  ARTIFACT_INVALID: "INVALID_INPUT",
  ARTIFACT_IDENTITY_MISMATCH: "INVALID_INPUT",
  ARTIFACT_INTEGRITY_MISMATCH: "INVALID_INPUT",
  ARTIFACT_CHANGED: "INVALID_INPUT",
  PUBLIC_INTEGRITY_MISMATCH: "ARTIFACT_MISMATCH",
  REGISTRY_STATE_CHANGED: "REMOTE_UNCERTAIN",
  UNSUPPORTED_DISTRIBUTION: "CONFIG_INVALID",
  REGISTRY_UNAVAILABLE: "REMOTE_UNAVAILABLE",
  PLAN_INVALID: "PLAN_INVALID",
  PUBLISH_FAILED: "PUBLISH_FAILED",
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const satisfies Record<string, ReleaseErrorCode>;

export type ArtifactErrorCode = keyof typeof artifactErrorCodes;
export interface ArtifactIdentity { name: string; version: string }
export class ArtifactError extends ReleaseError {
  readonly artifactCode: ArtifactErrorCode;
  readonly identity: ArtifactIdentity | null;
  readonly entryIndex: number | null;
  constructor(
    artifactCode: ArtifactErrorCode,
    message: string,
    identity: ArtifactIdentity | null = null,
    entryIndex: number | null = null,
    remoteState: RemoteState = "unchanged",
  ) {
    super(artifactErrorCodes[artifactCode], message, remoteState);
    this.artifactCode = artifactCode;
    this.identity = identity;
    this.entryIndex = entryIndex;
  }
}
