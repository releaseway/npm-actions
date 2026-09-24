import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import {
  parseGitHubRepository,
  repositoryFullName,
} from "./repository.ts";

export interface GithubContext {
  workspace: string;
  repository: string;
  sha: string;
}

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

function runGitRequired(
  runGit: RunGit,
  cwd: string,
  args: readonly string[],
): string {
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.trim() || "<no stderr>"}`,
    );
  }
  return result.stdout.trim();
}

export function githubContextFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): GithubContext {
  const workspace = env.GITHUB_WORKSPACE;
  const repository = env.GITHUB_REPOSITORY;
  const sha = env.GITHUB_SHA;

  if (!workspace || !repository || !sha) {
    throw new Error(
      "GITHUB_WORKSPACE, GITHUB_REPOSITORY, and GITHUB_SHA are required",
    );
  }
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error("GITHUB_SHA must be a full 40-character commit SHA");
  }
  if (!/^[^/]+\/[^/]+$/.test(repository)) {
    throw new Error("GITHUB_REPOSITORY must be owner/repo");
  }

  return {
    workspace: resolve(workspace),
    repository,
    sha: sha.toLowerCase(),
  };
}

export function verifySourceIdentity(
  context: GithubContext,
  runGit: RunGit = defaultRunGit,
): void {
  const head = runGitRequired(runGit, context.workspace, ["rev-parse", "HEAD"]);
  if (head.toLowerCase() !== context.sha) {
    throw new Error(
      `Checkout HEAD ${head} does not match GITHUB_SHA ${context.sha}`,
    );
  }

  const origin = runGitRequired(runGit, context.workspace, [
    "remote",
    "get-url",
    "origin",
  ]);
  const parsed = parseGitHubRepository(origin);
  const remote = repositoryFullName(parsed).toLowerCase();
  if (remote !== context.repository.toLowerCase()) {
    throw new Error(
      `Checkout origin ${remote} does not match GITHUB_REPOSITORY ${context.repository}`,
    );
  }
}
