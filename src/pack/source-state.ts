import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink } from "node:fs/promises";
import { resolve } from "node:path";
import fg from "fast-glob";

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type RunGit = (args: readonly string[], cwd: string) => RunResult;

const defaultRunGit: RunGit = (args, cwd) => {
  const result = spawnSync("git", [...args], {
    cwd,
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

function runGit(runGit: RunGit, cwd: string, args: readonly string[]): string {
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || "<no stderr>"}`,
    );
  }
  return result.stdout;
}

async function hashRepositoryFiles(root: string, paths: readonly string[]): Promise<string> {
  const hash = createHash("sha256");

  for (const relativePath of paths) {
    const absolute = resolve(root, relativePath);
    const stat = await lstat(absolute);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(String(stat.mode));
    hash.update("\0");

    if (stat.isSymbolicLink()) {
      hash.update("symlink\0");
      hash.update(await readlink(absolute));
    } else if (stat.isFile()) {
      hash.update("file\0");
      hash.update(await readFile(absolute));
    } else {
      hash.update("other\0");
    }
    hash.update("\0");
  }

  return hash.digest("hex");
}

export interface SourceState {
  status: string;
  filesDigest: string;
}

export async function snapshotSourceState(
  root: string,
  runGitImpl: RunGit = defaultRunGit,
): Promise<SourceState> {
  const status = runGit(
    runGitImpl,
    root,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
  );

  const listed = runGit(
    runGitImpl,
    root,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
  );
  const gitPaths = listed
    .split("\0")
    .filter(Boolean);

  const workspacePaths = await fg("**/*", {
    cwd: root,
    dot: true,
    onlyFiles: false,
    followSymbolicLinks: false,
    unique: true,
    ignore: [
      ".git",
      ".git/**",
      "node_modules",
      "node_modules/**",
      "**/node_modules",
      "**/node_modules/**",
    ],
  });

  const paths = [...new Set([...gitPaths, ...workspacePaths])]
    .filter(
      (path) =>
        path !== ".git" &&
        !path.startsWith(".git/") &&
        path !== "node_modules" &&
        !path.startsWith("node_modules/") &&
        !path.includes("/node_modules/"),
    )
    .sort();

  return {
    status,
    filesDigest: await hashRepositoryFiles(root, paths),
  };
}

export function assertSourceStateUnchanged(
  before: SourceState,
  after: SourceState,
): void {
  if (before.status !== after.status || before.filesDigest !== after.filesDigest) {
    throw new Error("Package manager pack mutated the source worktree");
  }
}
