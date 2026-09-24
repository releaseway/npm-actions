import { spawnSync } from "node:child_process";
import process from "node:process";

export type SupportedNativeTarget =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64-gnu"
  | "linux-x64-gnu"
  | "linux-arm64-musl"
  | "linux-x64-musl"
  | "win32-arm64"
  | "win32-x64";

export type LinuxLibc = "gnu" | "musl";

interface DetectTargetOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  report?: () => unknown;
  runLdd?: () => { stdout: string; stderr: string };
}

function linuxLibcFromReport(report: unknown): LinuxLibc | undefined {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return undefined;
  }
  const header = (report as Record<string, unknown>).header;
  if (!header || typeof header !== "object" || Array.isArray(header)) {
    return undefined;
  }

  const glibc = (header as Record<string, unknown>).glibcVersionRuntime;
  if (typeof glibc === "string" && glibc.length > 0) {
    return "gnu";
  }

  const serialized = JSON.stringify(header).toLowerCase();
  if (serialized.includes("musl")) {
    return "musl";
  }

  return undefined;
}

function defaultReport(): unknown {
  try {
    return process.report?.getReport();
  } catch {
    return undefined;
  }
}

function defaultRunLdd(): { stdout: string; stderr: string } {
  const result = spawnSync("ldd", ["--version"], {
    encoding: "utf8",
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function detectLinuxLibc(
  options: Pick<DetectTargetOptions, "report" | "runLdd"> = {},
): LinuxLibc {
  const fromReport = linuxLibcFromReport(
    (options.report ?? defaultReport)(),
  );
  if (fromReport) {
    return fromReport;
  }

  const ldd = (options.runLdd ?? defaultRunLdd)();
  const output = (ldd.stdout + "\n" + ldd.stderr).toLowerCase();
  if (output.includes("musl")) {
    return "musl";
  }
  if (
    output.includes("glibc") ||
    output.includes("gnu libc") ||
    output.includes("gnu c library")
  ) {
    return "gnu";
  }

  throw new Error("Unable to determine Linux libc variant (GNU libc or musl)");
}

export function detectNativeTarget(
  options: DetectTargetOptions = {},
): SupportedNativeTarget {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported native architecture: ${arch}`);
  }

  if (platform === "darwin") {
    return `darwin-${arch}` as SupportedNativeTarget;
  }
  if (platform === "win32") {
    return `win32-${arch}` as SupportedNativeTarget;
  }
  if (platform === "linux") {
    const libc = detectLinuxLibc(options);
    return `linux-${arch}-${libc}` as SupportedNativeTarget;
  }

  throw new Error(`Unsupported native platform: ${platform}`);
}
