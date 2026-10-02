import { createReadStream } from "node:fs";
import { posix } from "node:path";
import * as tar from "tar";
import yauzl from "yauzl";
import { nativeLimits, withDeadline, type NativeLimits } from "../limits.ts";

export function normalizeArchivePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\0") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/.test(value)
  ) {
    throw new Error(`Unsafe archive entry path: ${value}`);
  }

  const trimmed = value.replace(/^\.\//, "");
  const normalized = posix.normalize(trimmed);
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe archive entry path: ${value}`);
  }
  return normalized;
}

function isTarRegularFile(type: string): boolean {
  return type === "File" || type === "OldFile" || type === "ContiguousFile";
}

export async function extractTarGzExecutable(
  archivePath: string,
  executablePath: string,
  limits: NativeLimits = nativeLimits(),
): Promise<Buffer> {
  const wanted = normalizeArchivePath(executablePath);
  const seen = new Set<string>();
  const chunks: Buffer[] = [];
  let matches = 0;
  let scanError: Error | undefined;
  let expanded = 0;
  let executableBytes = 0;

  await withDeadline("Native tar extraction", limits.extractTimeoutMs, (signal) => new Promise<void>((resolve, reject) => {
    const input = createReadStream(archivePath);
    const parser = tar.t({
      strict: true,
      onentry(entry) {
        if (scanError) {
          entry.resume();
          return;
        }

        try {
          expanded += entry.size;
          if (expanded > limits.maxExpandedBytes) throw new Error("Native archive exceeds expanded byte limit");
          const normalized = normalizeArchivePath(entry.path.replace(/\/$/, ""));
          if (seen.has(normalized)) {
            throw new Error(`Duplicate archive entry path: ${normalized}`);
          }
          seen.add(normalized);

          if (entry.type === "Directory") {
            return;
          }
          if (!isTarRegularFile(entry.type)) {
            throw new Error(
              `Unsupported non-regular tar entry ${entry.type}: ${entry.path}`,
            );
          }

          if (normalized === wanted) {
            if (entry.size > limits.maxExecutableBytes) throw new Error("Native executable exceeds byte limit");
            matches += 1;
            entry.on("data", (chunk) => {
              executableBytes += chunk.length;
              if (executableBytes > limits.maxExecutableBytes) {
                parser.abort(new Error("Native executable exceeds byte limit"));
                return;
              }
              chunks.push(Buffer.from(chunk));
            });
          }
        } catch (error) {
          scanError =
            error instanceof Error ? error : new Error(String(error));
          entry.resume();
          parser.abort(scanError);
        }
      },
    });
    const abort = () => parser.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const finish = (error?: Error) => {
      signal.removeEventListener("abort", abort);
      input.destroy();
      if (error) reject(error); else resolve();
    };
    input.on("error", (error) => { parser.abort(error); });
    parser.on("error", finish);
    parser.on("end", () => finish());
    input.pipe(parser);
  }));

  if (scanError) {
    throw scanError;
  }

  if (matches !== 1) {
    throw new Error(
      `Native executable ${wanted} must occur exactly once in tar.gz; found ${matches}`,
    );
  }
  return Buffer.concat(chunks);
}

function zipUnixMode(entry: yauzl.Entry): number | undefined {
  const hostSystem = entry.versionMadeBy >>> 8;
  if (hostSystem !== 3) {
    return undefined;
  }
  return (entry.externalFileAttributes >>> 16) & 0xffff;
}

function assertZipEntryType(entry: yauzl.Entry, normalized: string): void {
  if (entry.isEncrypted()) {
    throw new Error(`Encrypted zip entries are not supported: ${normalized}`);
  }

  const mode = zipUnixMode(entry);
  if (mode === undefined || mode === 0) {
    return;
  }
  const fileType = mode & 0o170000;
  if (
    fileType !== 0 &&
    fileType !== 0o100000 &&
    fileType !== 0o040000
  ) {
    throw new Error(`Unsupported non-regular zip entry: ${normalized}`);
  }
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("Failed to open zip archive"));
        return;
      }
      resolve(zip);
    });
  });
}

function readZipEntry(
  zip: yauzl.ZipFile,
  entry: yauzl.Entry,
  maxBytes: number,
  signal: AbortSignal,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error("Failed to read zip entry"));
        return;
      }
      if (signal.aborted) {
        stream.destroy();
        reject(signal.reason);
        return;
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const abort = () => stream.destroy(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      stream.on("close", () => signal.removeEventListener("abort", abort));
      stream.on("data", (chunk) => {
        total += chunk.length;
        if (total > maxBytes) stream.destroy(new Error("Native executable exceeds byte limit"));
        else chunks.push(Buffer.from(chunk));
      });
      stream.on("error", reject);
      stream.on("end", () => resolve(Buffer.concat(chunks)));
    });
  });
}

export async function extractZipExecutable(
  archivePath: string,
  executablePath: string,
  limits: NativeLimits = nativeLimits(),
): Promise<Buffer> {
  return withDeadline("Native zip extraction", limits.extractTimeoutMs, async (signal) => {
    const wanted = normalizeArchivePath(executablePath);
    const zip = await openZip(archivePath);
    const seen = new Set<string>();
    let match: Buffer | undefined;
    let matches = 0;
    let expanded = 0;

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: unknown) => {
        if (settled) return;
        settled = true;
        try {
          zip.close();
        } catch {}
        reject(error);
      };

      zip.on("error", fail);
      const abort = () => fail(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      zip.on("close", () => signal.removeEventListener("abort", abort));
      if (signal.aborted) { fail(signal.reason); return; }
      zip.on("entry", async (entry) => {
        try {
          expanded += entry.uncompressedSize;
          if (expanded > limits.maxExpandedBytes) throw new Error("Native archive exceeds expanded byte limit");
          const raw = entry.fileName.replace(/\/$/, "");
          const normalized = normalizeArchivePath(raw);
          if (seen.has(normalized)) {
            throw new Error(`Duplicate archive entry path: ${normalized}`);
          }
          seen.add(normalized);
          assertZipEntryType(entry, normalized);

          const directory =
            entry.fileName.endsWith("/") ||
            ((zipUnixMode(entry) ?? 0) & 0o170000) === 0o040000;

          if (normalized === wanted) {
            if (directory) {
              throw new Error(
                `Configured native executable is not a regular zip file: ${wanted}`,
              );
            }
            matches += 1;
            if (entry.uncompressedSize > limits.maxExecutableBytes) throw new Error("Native executable exceeds byte limit");
            match = await readZipEntry(zip, entry, limits.maxExecutableBytes, signal);
          }

          zip.readEntry();
        } catch (error) {
          fail(error);
        }
      });
      zip.on("end", () => {
        if (settled) return;
        settled = true;
        if (matches !== 1 || !match) {
          reject(
            new Error(
              `Native executable ${wanted} must occur exactly once in zip; found ${matches}`,
            ),
          );
          return;
        }
        resolve(match);
      });
      zip.readEntry();
    });
  });
}

export async function extractExecutable(
  archivePath: string,
  assetName: string,
  executablePath: string,
  limits: NativeLimits = nativeLimits(),
): Promise<Buffer> {
  if (assetName.endsWith(".tar.gz")) {
    return extractTarGzExecutable(archivePath, executablePath, limits);
  }
  if (assetName.endsWith(".zip")) {
    return extractZipExecutable(archivePath, executablePath, limits);
  }
  throw new Error(`Unsupported native archive format: ${assetName}`);
}
