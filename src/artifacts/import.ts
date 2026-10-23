import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import * as tar from "tar";
import type { PackedArtifact, PackedEntry } from "../pack/inspect.ts";
import type { PackageManifest } from "../workspace/discover.ts";
import { parseGitHubRepository, repositoryFullName } from "../workspace/repository.ts";
import { ArtifactError } from "./errors.ts";
import { ARTIFACT_LIMITS, assertPortablePath, regularFileInside, type ArtifactEntry } from "./manifest.ts";

function budget(maximum: number, consume?: (chunk: Buffer) => void): Transform {
  let total = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    total += chunk.length;
    if (!Number.isSafeInteger(total) || total > maximum) return callback(new Error("Artifact byte budget exceeded"));
    consume?.(chunk); callback(null, chunk);
  } });
}
export async function inspectArtifact(path: string): Promise<PackedArtifact> {
  const entries: PackedEntry[] = [], seen = new Set<string>();
  let json: Buffer[] | undefined;
  const parser = new tar.Parser({ strict: true, maxMetaEntrySize: ARTIFACT_LIMITS.packageJsonBytes });
  parser.on("ignoredEntry", () => parser.abort(new Error("Ignored tar entries are not accepted")));
  parser.on("entry", (entry: tar.ReadEntry) => {
    try {
      const name = entry.path.endsWith("/") ? entry.path.slice(0, -1) : entry.path;
      assertPortablePath(name);
      if ((name !== "package" && !name.startsWith("package/")) || seen.has(name) ||
          !["File", "OldFile", "Directory"].includes(entry.type) || (name === "package" && entry.type !== "Directory") ||
          !Number.isSafeInteger(entry.size) || entry.size < 0 || entries.length >= ARTIFACT_LIMITS.entries) {
        throw new Error("Ambiguous or unsupported artifact archive entry");
      }
      seen.add(name);
      entries.push({ path: entry.path, type: entry.type, mode: entry.mode ?? 0, size: entry.size });
      if (name === "package/package.json") {
        if (entry.type === "Directory" || entry.size > ARTIFACT_LIMITS.packageJsonBytes) throw new Error("Invalid package.json entry");
        json = [];
        entry.on("data", (chunk: Buffer) => json!.push(Buffer.from(chunk)));
      }
      entry.resume();
    } catch { parser.abort(new Error("Invalid archive entry")); }
  });
  await pipeline(createReadStream(path), createGunzip(), budget(ARTIFACT_LIMITS.expandedBytes), parser,
    { signal: AbortSignal.timeout(ARTIFACT_LIMITS.inspectTimeoutMs) });
  if (!json) throw new Error("Artifact lacks package/package.json");
  const manifest: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(json)));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid packed package.json");
  return { tarballPath: path, entries, manifest: manifest as PackageManifest };
}
export async function importArtifact(directory: string, entry: ArtifactEntry, destination: string, repository: string,
  onIntegrity?: (integrity: string, matched: boolean) => void): Promise<PackedArtifact> {
  let source: string;
  try { source = await regularFileInside(directory, join(directory, entry.tarball)); }
  catch { throw new ArtifactError("ARTIFACT_MISSING", "Candidate artifact is missing or is not a regular contained file", entry); }
  await mkdir(join(destination, ".."), { recursive: true, mode: 0o700 });
  let handle;
  try { handle = await open(source, "r"); }
  catch { throw new ArtifactError("ARTIFACT_MISSING", "Candidate artifact cannot be opened", entry); }
  try {
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > ARTIFACT_LIMITS.archiveBytes) throw new Error("Artifact exceeds its compressed byte budget");
      const hash = createHash("sha512");
      await pipeline(handle.createReadStream(), budget(ARTIFACT_LIMITS.archiveBytes, chunk => hash.update(chunk)),
        createWriteStream(destination, { flags: "wx", mode: 0o600 }), { signal: AbortSignal.timeout(ARTIFACT_LIMITS.copyTimeoutMs) });
      const integrity = "sha512-" + hash.digest("base64");
      onIntegrity?.(integrity, integrity === entry.integrity);
      if (integrity !== entry.integrity) {
        throw new ArtifactError("ARTIFACT_INTEGRITY_MISMATCH", "Candidate artifact differs from its expected SHA-512", entry);
      }
      await chmod(destination, 0o400);
      const artifact = await inspectArtifact(destination);
      let packedRepository: string;
      try { packedRepository = repositoryFullName(parseGitHubRepository(artifact.manifest.repository)); }
      catch { throw new ArtifactError("ARTIFACT_IDENTITY_MISMATCH", "Candidate packed repository is invalid", entry); }
      if (artifact.manifest.name !== entry.name || artifact.manifest.version !== entry.version || artifact.manifest.private === true ||
          packedRepository.toLowerCase() !== repository.toLowerCase()) {
        throw new ArtifactError("ARTIFACT_IDENTITY_MISMATCH", "Candidate packed identity is not publishable from this source", entry);
      }
      return artifact;
    } catch (error) {
      await rm(destination, { force: true }).catch(() => {});
      if (error instanceof ArtifactError) throw error;
      throw new ArtifactError("ARTIFACT_INVALID", "Candidate archive failed admission checks", entry);
    }
  } finally { await handle.close(); }
}
