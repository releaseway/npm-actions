const STRIPPED_ENV = new Set([
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "NPM_TOKEN",
  "NPM_AUTH_TOKEN",
  "NPM_USERNAME",
  "NPM_PASSWORD",
  "NPM_OTP",
  "YARN_NPM_AUTH_TOKEN",
]);

export function packageOperationEnvironment(
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};

  for (const [name, value] of Object.entries(source)) {
    const upper = name.toUpperCase();
    if (STRIPPED_ENV.has(upper)) {
      continue;
    }
    if (
      upper.startsWith("NPM_CONFIG_") &&
      /(?:AUTH|TOKEN|PASSWORD|USERNAME|OTP)/.test(upper)
    ) {
      continue;
    }
    result[name] = value;
  }

  return result;
}
