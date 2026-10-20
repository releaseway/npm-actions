export const recoveries = {
  INVALID_INPUT: "fix-input", CONFIG_INVALID: "fix-input", PLAN_INVALID: "fix-input",
  PLAN_CONFIG_MISMATCH: "replan", PLAN_STALE: "replan", TAG_INVALID: "fix-input",
  TAG_NOT_FOUND: "fix-input", TAG_COMMIT_MISMATCH: "fix-input", TAG_AMBIGUOUS: "fix-input",
  TAG_CONFLICT: "inspect-remote", IDENTITY_CONFLICT: "inspect-remote", NOT_ON_BRANCH: "fix-input",
  CHANNEL_CLOSED: "fix-input", PERMISSION_DENIED: "fix-permission", REMOTE_REJECTED: "inspect-remote",
  REMOTE_UNAVAILABLE: "same-input", REMOTE_UNCERTAIN: "inspect-remote",
  ARTIFACT_MISMATCH: "inspect-remote", PUBLISH_FAILED: "inspect-remote", INTERNAL_ERROR: "inspect-remote",
} as const;
export type ReleaseErrorCode = keyof typeof recoveries;
export type RemoteState = "unchanged" | "present" | "unknown";
export class ReleaseError extends Error {
  readonly code: ReleaseErrorCode;
  readonly remoteState: RemoteState;
  constructor(code: ReleaseErrorCode, message: string, remoteState: RemoteState = "unchanged") {
    super(message);
    this.code = code;
    this.remoteState = remoteState;
    this.name = "ReleaseError";
  }
}
