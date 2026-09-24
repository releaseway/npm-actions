const TOKEN_ENV_NAMES = new Set([
  "NODE_AUTH_TOKEN",
  "NPM_TOKEN",
  "NPM_AUTH_TOKEN",
  "NPM_USERNAME",
  "NPM_PASSWORD",
  "NPM_OTP",
  "YARN_NPM_AUTH_TOKEN",
]);

export function assertTrustedPublishingEnvironment(
  env: NodeJS.ProcessEnv,
): void {
  if (env.GITHUB_ACTIONS !== "true") {
    throw new Error("npm Trusted Publishing requires GitHub Actions");
  }
  if (env.RUNNER_ENVIRONMENT !== "github-hosted") {
    throw new Error(
      "npm Trusted Publishing requires a GitHub-hosted runner",
    );
  }
  if (
    !env.ACTIONS_ID_TOKEN_REQUEST_URL ||
    !env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  ) {
    throw new Error(
      "GitHub Actions OIDC is unavailable; grant id-token: write to the publish job",
    );
  }
}

export function isolatedPublisherEnvironment(
  source: NodeJS.ProcessEnv,
  home: string,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (TOKEN_ENV_NAMES.has(upper) || upper.startsWith("NPM_CONFIG_")) {
      continue;
    }
    result[name] = value;
  }

  result.HOME = home;
  result.USERPROFILE = home;
  return result;
}
