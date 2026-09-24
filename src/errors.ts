export function escapeWorkflowCommand(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.stack ?? error.message
    : String(error);
}

export function githubErrorCommand(error: unknown): string {
  return "::error::" + escapeWorkflowCommand(errorMessage(error));
}
