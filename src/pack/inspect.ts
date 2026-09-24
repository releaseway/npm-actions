import { readFile } from "node:fs/promises";
import * as tar from "tar";

import type { PackageManifest } from "../workspace/discover.ts";

export interface PackedEntry {
  path: string;
  type: string;
  mode: number;
  size: number;
}

export interface PackedArtifact {
  tarballPath: string;
  manifest: PackageManifest;
  entries: PackedEntry[];
}

export async function inspectPackedTarball(
  tarballPath: string,
): Promise<PackedArtifact> {
  const entries: PackedEntry[] = [];
  let packageJson: string | undefined;
  const pending: Promise<void>[] = [];

  await tar.t({
    file: tarballPath,
    strict: true,
    onentry(entry) {
      entries.push({
        path: entry.path,
        type: entry.type,
        mode: entry.mode ?? 0,
        size: entry.size ?? 0,
      });

      if (entry.path === "package/package.json") {
        const chunks: Buffer[] = [];
        pending.push(
          new Promise((resolve, reject) => {
            entry.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            entry.on("end", () => {
              packageJson = Buffer.concat(chunks).toString("utf8");
              resolve();
            });
            entry.on("error", reject);
          }),
        );
      }
    },
  });
  await Promise.all(pending);

  if (packageJson === undefined) {
    throw new Error(`Packed tarball lacks package/package.json: ${tarballPath}`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(packageJson);
  } catch (error) {
    throw new Error(
      `Packed package.json is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Packed package.json must contain a JSON object");
  }

  await readFile(tarballPath);

  return {
    tarballPath,
    manifest: manifest as PackageManifest,
    entries,
  };
}
