export interface PackageRepository {
  owner: string;
  repo: string;
}

function normalizeRepoName(repo: string): string {
  return repo.endsWith(".git") ? repo.slice(0, -4) : repo;
}

export function parseGitHubRepository(value: unknown): PackageRepository {
  const raw =
    typeof value === "string"
      ? value
      : value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          typeof (value as Record<string, unknown>).url === "string"
        ? String((value as Record<string, unknown>).url)
        : "";

  if (!raw) {
    throw new Error("package.json.repository must identify the GitHub repository");
  }

  const shorthand = /^(?:github:)?([^/:\s]+)\/([^/\s]+)$/.exec(raw);
  if (shorthand) {
    return { owner: shorthand[1], repo: normalizeRepoName(shorthand[2]) };
  }

  const scp = /^git@github\.com:([^/]+)\/(.+)$/.exec(raw);
  if (scp) {
    return { owner: scp[1], repo: normalizeRepoName(scp[2]) };
  }

  const cleaned = raw.replace(/^git\+/, "");
  let url: URL;
  try {
    url = new URL(cleaned);
  } catch {
    throw new Error(`Unsupported GitHub repository URL: ${raw}`);
  }

  if (url.hostname.toLowerCase() !== "github.com") {
    throw new Error(`Repository must use github.com: ${raw}`);
  }

  const path = url.pathname.replace(/^\/+/, "").replace(/\/+$/, "");
  const parts = path.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Repository must identify owner/repo: ${raw}`);
  }

  return {
    owner: parts[0],
    repo: normalizeRepoName(parts[1]),
  };
}

export function repositoryFullName(repository: PackageRepository): string {
  return `${repository.owner}/${repository.repo}`;
}
