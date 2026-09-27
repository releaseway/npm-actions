export type PublishMode = "direct" | "stage";

export interface PublishPolicy {
  mode: PublishMode;
}

export interface VersionPolicy {
  source: "git-tag";
  prefix: string;
}

export interface NativeTargetPolicy {
  asset: string;
  executable: string;
}

export interface GithubReleaseDistribution {
  type: "github-release";
  tag: string;
  cacheEnv?: string;
  targets: Record<string, NativeTargetPolicy>;
}

export interface PackagePolicy {
  publish?: PublishPolicy;
  distribution?: GithubReleaseDistribution;
}

export interface ReleasewayConfig {
  schema: 1;
  version?: VersionPolicy;
  publish: PublishPolicy;
  packages: Record<string, PackagePolicy>;
}

export const DEFAULT_CONFIG: ReleasewayConfig = {
  schema: 1,
  publish: { mode: "stage" },
  packages: {},
};
