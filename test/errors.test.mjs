import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeWorkflowCommand,
  errorMessage,
  githubErrorCommand,
} from "../src/errors.ts";

test("workflow error annotations escape GitHub command control characters", () => {
  assert.equal(
    escapeWorkflowCommand("npm 100% failed\r\nline 2"),
    "npm 100%25 failed%0D%0Aline 2",
  );
});

test("workflow error annotation preserves the actionable error text", () => {
  const error = new Error("npm stage publish failed: E403\ntrusted publisher mismatch");
  const message = errorMessage(error);
  assert.match(message, /npm stage publish failed: E403/);

  const command = githubErrorCommand(error);
  assert.match(command, /^::error::/);
  assert.match(command, /npm stage publish failed: E403/);
  assert.match(command, /%0A/);
});
