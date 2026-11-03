import assert from "node:assert/strict";
import test from "node:test";

import {
  escapeWorkflowCommand,
  errorMessage,
  githubErrorCommand,
  PublicationFailure,
  InvalidPublishConcurrencyError,
} from "../src/errors.ts";
import { ReleaseError } from "../src/release-error.ts";

test("workflow error annotations escape GitHub command control characters", () => {
  assert.equal(
    escapeWorkflowCommand("npm 100% failed\r\nline 2"),
    "npm 100%25 failed%0D%0Aline 2",
  );
});

test("workflow errors keep safe package context and omit subprocess output, stacks and arbitrary values", () => {
  const error = new PublicationFailure({ name: "@scope/pkg", version: "1.2.3" }, "publish", "unknown", new Error("npm stage publish failed: E403\nSECRET"), "none");
  const message = errorMessage(error);
  assert.match(message, /@scope\/pkg@1.2.3/);
  assert.match(message, /publish.*PUBLISH_FAILED.*unknown/);

  const command = githubErrorCommand(error);
  assert.match(command, /^::error::/);
  assert.doesNotMatch(command, /SECRET|E403|Error:|%0A/);
  assert.doesNotMatch(errorMessage("SECRET"), /SECRET/);
  assert.match(errorMessage(new ReleaseError("CONFIG_INVALID", "SECRET")), /CONFIG_INVALID/);
  assert.equal(errorMessage(new InvalidPublishConcurrencyError()), "publish-concurrency must be a positive safe integer");
});
