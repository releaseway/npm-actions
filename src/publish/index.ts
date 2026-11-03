import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

import { NPM_REGISTRY } from "../registry/client.ts";
import { sha512Integrity } from "../registry/integrity.ts";
import type { ReleasewayToolchain } from "../toolchain/bootstrap.ts";
import {
  assertTrustedPublishingEnvironment,
  isolatedPublisherEnvironment,
} from "./environment.ts";
import type { PublishOptions } from "./options.ts";

export type PublishMode = "direct" | "stage";
export type PublicationMutationState = "direct-accepted" | "staged" | "not-submitted";
interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}
export type RunPublisher = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => RunResult | Promise<RunResult>;
const defaultRunPublisher: RunPublisher = (executable, args, options) => new Promise((done, reject) => {
  const child = spawn(executable, [...args], { ...options, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let stdoutBytes = 0, stderrBytes = 0;
  let failure: Error | undefined;
  const capture = (chunks: Buffer[], stream: "stdout" | "stderr", chunk: Buffer) => {
    if (failure) return;
    if (stream === "stdout") stdoutBytes += chunk.length;
    else stderrBytes += chunk.length;
    if (Math.max(stdoutBytes, stderrBytes) > 1024 * 1024) {
      failure = new Error("npm command output exceeded the capture limit");
      child.kill();
    } else chunks.push(chunk);
  };
  child.stdout.on("data", (chunk: Buffer) => capture(stdout, "stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => capture(stderr, "stderr", chunk));
  child.on("error", error => { failure ??= error; });
  // close, rather than exit/error, owns completion and cleanup of the subprocess context.
  child.on("close", status => failure ? reject(failure) : done({
    status, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
  }));
});
export interface PublishRequest {
  readonly mode: PublishMode;
  readonly name: string;
  readonly version: string;
  readonly tarballPath: string;
  readonly integrity: string;
  readonly publishOptions: Readonly<PublishOptions>;
}
export interface PublisherOptions {
  env?: NodeJS.ProcessEnv;
  tempRoot?: string;
  runPublisher?: RunPublisher;
  canPublish?: () => boolean;
}

/** A subprocess failure is evidence of a failed request, never evidence of acceptance. */
export class PublishCommandError extends Error {
  readonly output: string;
  constructor(request: PublishRequest, output: string) {
    super(
      "npm " +
        (request.mode === "direct" ? "publish" : "stage publish") +
        " failed for " +
        request.name +
        "@" +
        request.version +
        ": " +
        output,
    );
    this.name = "PublishCommandError";
    this.output = output;
  }
}
export function isPendingRegistryScanConflict(output: string): boolean {
  return /Cannot publish over previously staged version/i.test(output);
}
export async function assertPreparedTarball(
  request: Pick<
    PublishRequest,
    "tarballPath" | "integrity" | "name" | "version"
  >,
): Promise<void> {
  if ((await sha512Integrity(request.tarballPath)) !== request.integrity) {
    throw new Error(
      "Prepared tarball changed for " + request.name + "@" + request.version,
    );
  }
}
function publicationArgs(
  request: PublishRequest,
  userConfig: string,
  globalConfig: string,
): string[] {
  const args =
    request.mode === "direct"
      ? ["publish", resolve(request.tarballPath)]
      : ["stage", "publish", resolve(request.tarballPath)];
  args.push(
    "--registry=" + NPM_REGISTRY + "/",
    "--userconfig=" + userConfig,
    "--globalconfig=" + globalConfig,
    "--ignore-scripts",
  );
  if (request.publishOptions.tag)
    args.push("--tag=" + request.publishOptions.tag);
  if (request.publishOptions.access)
    args.push("--access=" + request.publishOptions.access);
  return args;
}
export async function publishPackage(
  toolchain: ReleasewayToolchain,
  request: PublishRequest,
  options: PublisherOptions = {},
): Promise<PublicationMutationState> {
  const sourceEnv = options.env ?? process.env;
  assertTrustedPublishingEnvironment(sourceEnv);
  await assertPreparedTarball(request);
  const base = resolve(options.tempRoot ?? sourceEnv.RUNNER_TEMP ?? tmpdir());
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "releaseway-npm-publish-"));
  try {
    const home = join(root, "home");
    await mkdir(home, { recursive: true });
    const userConfig = join(root, "user.npmrc");
    const globalConfig = join(root, "global.npmrc");
    const config = "registry=" + NPM_REGISTRY + "/\n";
    await Promise.all([
      writeFile(userConfig, config, { encoding: "utf8", mode: 0o600 }),
      writeFile(globalConfig, config, { encoding: "utf8", mode: 0o600 }),
    ]);
    // Request setup contains awaits. Recheck admission at the actual process boundary.
    if (options.canPublish && !options.canPublish()) return "not-submitted";
    const result = await (options.runPublisher ?? defaultRunPublisher)(
      process.execPath,
      [toolchain.npmCli, ...publicationArgs(request, userConfig, globalConfig)],
      { cwd: root, env: isolatedPublisherEnvironment(sourceEnv, home) },
    );
    if (result.status !== 0) {
      throw new PublishCommandError(
        request,
        [result.stderr.trim(), result.stdout.trim()]
          .filter(Boolean)
          .join("\n") || "<no output>",
      );
    }
    return request.mode === "direct" ? "direct-accepted" : "staged";
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
