import { spawnSync } from "node:child_process";
import { valid } from "semver";

import type { VersionPolicy } from "../config/types.ts";
import type { GithubContext } from "../workspace/identity.ts";

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
  return result.stdout;
}

interface RemoteTag {
  direct?: string;
  peeled?: string;
}

export function resolveGitTagVersion(
  context: GithubContext,
  policy: VersionPolicy,
  runGit: RunGit = defaultRunGit,
): string {
  const output = runGitRequired(runGit, context.workspace, ["ls-remote", "--tags", "origin"]);
  const tags = new Map<string, RemoteTag>();

  for (const line of output.split("\n")) {
    if (!line) continue;
    const [sha, ref] = line.split("\t");
    if (!sha || !ref || !/^[0-9a-f]{40}$/i.test(sha)) continue;
    if (!ref.startsWith("refs/tags/")) continue;

    const peeled = ref.endsWith("^{}");
    const name = ref.slice("refs/tags/".length, peeled ? -3 : undefined);
    const entry = tags.get(name) ?? {};
    if (peeled) entry.peeled = sha.toLowerCase();
    else entry.direct = sha.toLowerCase();
    tags.set(name, entry);
  }

  const candidates: Array<{ tag: string; version: string }> = [];
  for (const [tag, target] of tags) {
    if (!tag.startsWith(policy.prefix)) continue;
    const version = tag.slice(policy.prefix.length);
    if (valid(version) !== version) continue;
    const commit = target.peeled ?? target.direct;
    if (commit === context.sha.toLowerCase()) {
      candidates.push({ tag, version });
    }
  }

  candidates.sort((left, right) => left.tag.localeCompare(right.tag));
  if (candidates.length === 0) {
    throw new Error(
      `No remote SemVer tag with prefix ${JSON.stringify(policy.prefix)} resolves to GITHUB_SHA ${context.sha}`,
    );
  }
  if (candidates.length > 1) {
    throw new Error(
      `Multiple remote SemVer tags resolve to GITHUB_SHA ${context.sha}: ${candidates.map((candidate) => candidate.tag).join(", ")}`,
    );
  }
  return candidates[0].version;
}
