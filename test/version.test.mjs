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

test("explicit release tag selects rc or stable at one commit and validates remote identity", () => {
  const output = [`${context.sha}\trefs/tags/v1.2.0-rc.0`, `${"a".repeat(40)}\trefs/tags/v1.2.0`, `${context.sha}\trefs/tags/v1.2.0^{}`].join("\n");
  const run = (args) => ({ status: 0, stdout: args[0] === "ls-remote" ? output : "", stderr: "" });
  for (const [tag, version] of [["v1.2.0-rc.0", "1.2.0-rc.0"], ["v1.2.0", "1.2.0"]]) {
    assert.equal(resolveGitTagVersion({ ...context, releaseTag: tag }, { source: "git-tag", prefix: "v" }, run), version);
  }
  assert.throws(() => resolveGitTagVersion({ ...context, releaseTag: "v1.2.1" }, { source: "git-tag", prefix: "v" }, run), { code: "TAG_NOT_FOUND" });
  assert.throws(() => resolveGitTagVersion({ ...context, sha: "c".repeat(40), releaseTag: "v1.2.0" }, { source: "git-tag", prefix: "v" }, run), { code: "TAG_COMMIT_MISMATCH" });
  assert.throws(() => resolveGitTagVersion({ ...context, releaseTag: "v1.2.0" }, { source: "git-tag", prefix: "release-" }, run), { code: "TAG_INVALID" });
  assert.throws(() => resolveGitTagVersion({ ...context, releaseTag: "refs/tags/v1.2.0" }, { source: "git-tag", prefix: "v" }, run), { code: "TAG_INVALID" });
});
