import type { ArtifactIdentity } from "./errors.ts";
import type { ArtifactEntry, ArtifactManifest } from "./manifest.ts";

export type ArtifactProgress =
  | { phase: "read"; integrity: string }
  | { phase: "manifest"; packages: readonly ArtifactEntry[] }
  | { phase: "source"; source: ArtifactManifest["source"] }
  | { phase: "selection"; packages: readonly ArtifactIdentity[] }
  | { phase: "existing"; identity: ArtifactIdentity }
  | { phase: "local"; identity: ArtifactIdentity; integrity: string | null; matched: boolean }
  | { phase: "public"; identity: ArtifactIdentity; integrity: string | null; matched: boolean }
  | { phase: "preflight" };
