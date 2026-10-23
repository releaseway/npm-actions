import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { valid } from "semver";
import { immutableJson } from "../immutable.ts";
import type { GithubContext } from "../workspace/identity.ts";
import type { PublishablePackage } from "../workspace/discover.ts";
import { ArtifactError } from "./errors.ts";

export const ARTIFACT_LIMITS = Object.freeze({
  manifestBytes: 1024 ** 2, packageJsonBytes: 1024 ** 2,
  archiveBytes: 1024 ** 3, expandedBytes: 4 * 1024 ** 3,
  entries: 100_000, copyTimeoutMs: 240_000, inspectTimeoutMs: 120_000,
});
export interface ArtifactEntry {
  readonly name: string;
  readonly version: string;
  readonly tarball: string;
  readonly integrity: string;
}
export interface ArtifactManifest {
  readonly schema: 1;
  readonly source: { readonly repository: string; readonly commit: string };
  readonly packages: readonly ArtifactEntry[];
}
export interface LoadedArtifacts {
  readonly manifest: ArtifactManifest;
  readonly directory: string;
  readonly integrity: string;
}
export const bytesIntegrity = (bytes: Uint8Array): string =>
  "sha512-" + createHash("sha512").update(bytes).digest("base64");

export function canonicalIntegrity(value: unknown): value is string {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(value)) return false;
  const bytes = Buffer.from(value.slice(7), "base64");
  return bytes.length === 64 && "sha512-" + bytes.toString("base64") === value;
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new ArtifactError("MANIFEST_INVALID", "Artifact manifest has missing, unknown or invalid fields");
  }
  return value as Record<string, unknown>;
}
export function assertPortablePath(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || /[\\:\x00-\x1f\x7f]/.test(value) ||
      value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new ArtifactError("MANIFEST_INVALID", "Tarball path must be a portable relative path inside the manifest directory");
  }
}
export function parseArtifactManifest(value: unknown): ArtifactManifest {
  const root = object(value, ["schema", "source", "packages"]);
  const source = object(root.source, ["repository", "commit"]);
  if (root.schema !== 1 || typeof source.repository !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) ||
      typeof source.commit !== "string" || !/^[0-9a-f]{40}$/i.test(source.commit) || !Array.isArray(root.packages)) {
    throw new ArtifactError("MANIFEST_INVALID", "Invalid artifact manifest schema or source");
  }
  const names = new Set<string>(), paths = new Set<string>();
  const packages = root.packages.map((raw, index) => {
    const item = object(raw, ["name", "version", "tarball", "integrity"]);
    if (typeof item.name !== "string" || !item.name || typeof item.version !== "string" ||
        valid(item.version) !== item.version || !canonicalIntegrity(item.integrity)) {
      throw new ArtifactError("MANIFEST_INVALID", "Invalid artifact identity or canonical SHA-512 SRI", null, index);
    }
    assertPortablePath(item.tarball);
    if (names.has(item.name) || paths.has(item.tarball)) {
      throw new ArtifactError("PACKAGE_SET_MISMATCH", "Duplicate artifact package or tarball path", null, index);
    }
    names.add(item.name); paths.add(item.tarball);
    return { name: item.name, version: item.version, tarball: item.tarball, integrity: item.integrity };
  });
  return immutableJson({ schema: 1, source: { repository: source.repository.toLowerCase(), commit: source.commit.toLowerCase() }, packages });
}
export function within(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix === "" || (!isAbsolute(suffix) && suffix !== ".." && !suffix.startsWith(".." + sep));
}

/** Check components before canonicalization so a contained symlink is not silently accepted. */
export async function regularFileInside(root: string, path: string): Promise<string> {
  const base = resolve(root), target = resolve(path);
  if (!within(base, target) || base === target) throw new Error("Artifact file is outside its allowed directory");
  const parts = relative(base, target).split(sep);
  let current = base;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || (index === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error("Artifact path must use regular files and real directories");
    }
  }
  const [canonicalBase, canonicalTarget] = await Promise.all([realpath(base), realpath(target)]);
  if (!within(canonicalBase, canonicalTarget)) throw new Error("Artifact path escapes its allowed directory");
  return canonicalTarget;
}
export async function loadArtifactManifest(input: string, context: GithubContext, env: NodeJS.ProcessEnv): Promise<LoadedArtifacts> {
  try {
    const path = resolve(context.workspace, input);
    const roots = [resolve(context.workspace), ...(env.RUNNER_TEMP ? [resolve(env.RUNNER_TEMP)] : [])]
      .filter(root => within(root, path)).sort((a, b) => b.length - a.length);
    if (!roots.length) throw new Error("Artifact manifest must be inside the workspace or RUNNER_TEMP");
    const canonical = await regularFileInside(roots[0]!, path);
    const handle = await open(canonical, "r");
    let bytes: Buffer;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > ARTIFACT_LIMITS.manifestBytes) throw new Error("Artifact manifest exceeds its byte budget");
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of handle.createReadStream()) {
        size += chunk.length;
        if (size > ARTIFACT_LIMITS.manifestBytes) throw new Error("Artifact manifest exceeds its byte budget");
        chunks.push(chunk);
      }
      bytes = Buffer.concat(chunks);
    } finally { await handle.close(); }
    const manifest = parseArtifactManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    return { manifest, directory: dirname(canonical), integrity: bytesIntegrity(bytes) };
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError("MANIFEST_INVALID", "Cannot read a valid artifact manifest inside an allowed directory");
  }
}
export function bindArtifacts(loaded: LoadedArtifacts, context: GithubContext, packages: readonly PublishablePackage[], candidates: readonly PublishablePackage[]): void {
  const { manifest } = loaded;
  if (manifest.source.repository !== context.repository.toLowerCase() || manifest.source.commit !== (context.sourceSha ?? context.sha).toLowerCase()) {
    throw new ArtifactError("SOURCE_MISMATCH", "Artifact source does not match the verified checkout source");
  }
  const selected = new Map(packages.map(pkg => [pkg.name, pkg.version]));
  for (const [index, entry] of manifest.packages.entries()) {
    if (selected.get(entry.name) !== entry.version) throw new ArtifactError("PACKAGE_SET_MISMATCH", "Artifact identity is outside the selected release", entry, index);
  }
  const supplied = new Set(manifest.packages.map(entry => entry.name));
  for (const pkg of candidates) {
    if (!supplied.has(pkg.name)) throw new ArtifactError("PACKAGE_SET_MISMATCH", "Unpublished package has no artifact", pkg);
  }
}
