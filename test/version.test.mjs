import assert from "node:assert/strict";
import test from "node:test";

import { resolveGitTagVersion } from "../src/version/git-tag.ts";

const context = {
  workspace: "/workspace/example",
  repository: "releaseway/example",
  sha: "b".repeat(40),
};

function gitWithTags(lines) {
  return (args, cwd) => {
    assert.equal(cwd, context.workspace);
    assert.deepEqual(args, ["ls-remote", "--tags", "origin"]);
    return { status: 0, stdout: lines.join("\n") + "\n", stderr: "" };
  };
}

test("git-tag version provenance resolves annotated tag commit", () => {
  const tagObject = "a".repeat(40);
  assert.equal(
    resolveGitTagVersion(
      context,
      { source: "git-tag", prefix: "v" },
      gitWithTags([
        `${tagObject}\trefs/tags/v1.2.3`,
        `${context.sha}\trefs/tags/v1.2.3^{}`,
        `${"c".repeat(40)}\trefs/tags/v1.2.2`,
      ]),
    ),
    "1.2.3",
  );
});

test("git-tag version provenance accepts lightweight tags and prereleases", () => {
  assert.equal(
    resolveGitTagVersion(
      context,
      { source: "git-tag", prefix: "release-" },
      gitWithTags([
        `${context.sha}\trefs/tags/release-2.0.0-rc.1`,
      ]),
    ),
    "2.0.0-rc.1",
  );
});

test("git-tag version provenance rejects missing and ambiguous commit tags", () => {
  assert.throws(
    () =>
      resolveGitTagVersion(
        context,
        { source: "git-tag", prefix: "v" },
        gitWithTags([
          `${"a".repeat(40)}\trefs/tags/v1.2.3`,
        ]),
      ),
    /No remote SemVer tag/,
  );

  assert.throws(
    () =>
      resolveGitTagVersion(
        context,
        { source: "git-tag", prefix: "v" },
        gitWithTags([
          `${context.sha}\trefs/tags/v1.2.3`,
          `${context.sha}\trefs/tags/v1.2.4`,
        ]),
      ),
    /Multiple remote SemVer tags/,
  );
});
