import { verifyRegistryIntegrity, type RegistryReader } from "../registry/client.ts";
import { hasValidSha512Integrity } from "../registry/integrity.ts";
import type { PackageManifest } from "../workspace/discover.ts";
import { ArtifactError, type ArtifactIdentity } from "./errors.ts";
import type { ArtifactEntry } from "./manifest.ts";
import type { ArtifactProgress } from "./progress.ts";

export async function readArtifactVersion(registry: RegistryReader, identity: ArtifactIdentity) {
  try { return await registry.lookupVersion(identity.name, identity.version); }
  catch (error) {
    throw new ArtifactError("REGISTRY_UNAVAILABLE", error instanceof Error ? error.message : "Registry metadata lookup failed", identity);
  }
}

export function verifySuppliedPublic(entry: ArtifactEntry, manifest: PackageManifest, progress: (event: ArtifactProgress) => void): void {
  const dist = manifest.dist as { integrity?: unknown } | undefined;
  const remote = typeof dist?.integrity === "string" ? dist.integrity : "";
  const actual = remote.split(/\s+/).find(token => hasValidSha512Integrity(token));
  const canonical = actual ? "sha512-" + Buffer.from(actual.slice(7), "base64").toString("base64") : null;
  try { verifyRegistryIntegrity(manifest, entry.integrity); }
  catch {
    progress({ phase: "public", identity: entry, integrity: canonical, matched: false });
    throw new ArtifactError("PUBLIC_INTEGRITY_MISMATCH", "Supplied public version has no matching SHA-512", entry, null, "present");
  }
  progress({ phase: "public", identity: entry, integrity: entry.integrity, matched: true });
}
