import { spawnSync } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { valid } from "semver";
import * as tar from "tar";

import toolchainLock from "../../toolchain.lock.json" with { type: "json" };

export interface ToolSpec {
  version: string;
  tarball: string;
  integrity: string;
  bin: string;
}

export interface ReleasewayToolchain {
  root: string;
  npmCli: string;
  corepackCli: string;
  corepackHome: string;
}

export interface PackageManagerDeclaration {
  name: "npm" | "pnpm" | "yarn";
  version: string;
  corepackReference: string;
}

export interface PackageManagerCommand {
  name: "npm" | "pnpm" | "yarn";
  version: string;
  executable: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
}

type FetchLike = typeof fetch;

interface BootstrapOptions {
  rootBase?: string;
  fetchImpl?: FetchLike;
}

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type RunCommand = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => RunResult;

const defaultRunCommand: RunCommand = (executable, args, options) => {
  const result = spawnSync(executable, [...args], {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

export function verifyIntegrity(bytes: Uint8Array, integrity: string): void {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!match) {
    throw new Error("Toolchain integrity must be an SRI SHA-512 value");
  }

  const expected = Buffer.from(match[1], "base64");
  const actual = createHash("sha512").update(bytes).digest();

  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error("Toolchain tarball integrity mismatch");
  }
}

export async function downloadAndExtract(
  name: string,
  spec: ToolSpec,
  root: string,
  fetchImpl: FetchLike,
): Promise<string> {
  const response = await fetchImpl(spec.tarball);
  if (!response.ok) {
    throw new Error(
      `Failed to download pinned ${name} ${spec.version}: HTTP ${response.status}`,
    );
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  verifyIntegrity(bytes, spec.integrity);

  const archive = join(root, `${name}.tgz`);
  const destination = join(root, name);
  await mkdir(destination, { recursive: true });
  await writeFile(archive, bytes);

  try {
    await tar.x({
      cwd: destination,
      file: archive,
      strip: 1,
      strict: true,
    });
  } finally {
    await rm(archive, { force: true });
  }

  const cli = resolve(destination, spec.bin);
  await access(cli);
  return cli;
}

export async function bootstrapReleasewayToolchain(
  options: BootstrapOptions = {},
): Promise<ReleasewayToolchain> {
  const base = resolve(
    options.rootBase ?? process.env.RUNNER_TEMP ?? tmpdir(),
  );
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(join(base, "releaseway-npm-actions-toolchain-"));
  const fetchImpl = options.fetchImpl ?? fetch;

  const [npmCli, corepackCli] = await Promise.all([
    downloadAndExtract("npm", toolchainLock.npm, root, fetchImpl),
    downloadAndExtract("corepack", toolchainLock.corepack, root, fetchImpl),
  ]);

  const corepackHome = join(root, "corepack-home");
  await mkdir(corepackHome, { recursive: true });

  return { root, npmCli, corepackCli, corepackHome };
}

export function parsePackageManager(
  declaration: string,
): PackageManagerDeclaration {
  const at = declaration.indexOf("@");
  if (at <= 0 || at === declaration.length - 1) {
    throw new Error("packageManager must be an exact npm, pnpm, or yarn reference");
  }

  const name = declaration.slice(0, at);
  if (name !== "npm" && name !== "pnpm" && name !== "yarn") {
    throw new Error(`Unsupported package manager: ${name}`);
  }

  const reference = declaration.slice(at + 1);
  const hashIndex = reference.search(/\+sha(?:224|256|384|512)\./);
  const version = hashIndex === -1 ? reference : reference.slice(0, hashIndex);

  if (valid(version) !== version) {
    throw new Error(
      `packageManager must use an exact semantic version: ${declaration}`,
    );
  }

  if (
    hashIndex !== -1 &&
    !/^\+sha(?:224|256|384|512)\.[A-Za-z0-9+/=_-]+$/.test(
      reference.slice(hashIndex),
    )
  ) {
    throw new Error(`Invalid Corepack integrity suffix: ${declaration}`);
  }

  return {
    name,
    version,
    corepackReference: `${name}@${reference}`,
  };
}

function isolatedCorepackEnvironment(
  corepackHome: string,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(source)) {
    if (name.toUpperCase().startsWith("COREPACK_")) {
      continue;
    }
    sanitized[name] = value;
  }

  return {
    ...sanitized,
    COREPACK_HOME: corepackHome,
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_NPM_REGISTRY: "https://registry.npmjs.org",
  };
}

export function releasewayNpmCommand(
  toolchain: ReleasewayToolchain,
  env: NodeJS.ProcessEnv = process.env,
): PackageManagerCommand {
  return {
    name: "npm",
    version: toolchainLock.npm.version,
    executable: process.execPath,
    argsPrefix: [toolchain.npmCli],
    env: { ...env },
  };
}

export function provisionPackageManager(
  declaration: string,
  toolchain: ReleasewayToolchain,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
  runCommand: RunCommand = defaultRunCommand,
): PackageManagerCommand {
  const parsed = parsePackageManager(declaration);
  const commandEnv = isolatedCorepackEnvironment(toolchain.corepackHome, env);
  const argsPrefix = [toolchain.corepackCli, parsed.corepackReference];

  const result = runCommand(
    process.execPath,
    [...argsPrefix, "--version"],
    { cwd, env: commandEnv },
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to provision ${parsed.corepackReference}: ${result.stderr.trim()}`,
    );
  }

  const reported = result.stdout.trim();
  if (reported !== parsed.version) {
    throw new Error(
      `Package manager version mismatch: expected ${parsed.version}, got ${reported || "<empty>"}`,
    );
  }

  return {
    name: parsed.name,
    version: parsed.version,
    executable: process.execPath,
    argsPrefix,
    env: commandEnv,
  };
}
