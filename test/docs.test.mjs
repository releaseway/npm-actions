import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { parseConfig } from "../src/config/load.ts";
import { SUPPORTED_NATIVE_TARGETS } from "../src/native/validate.ts";

const README = resolve("README.md");

test("README quick start matches zero-input OIDC action contract", async () => {
  const source = await readFile(README, "utf8");

  assert.match(source, /permissions:\n  contents: read\n  id-token: write/);
  assert.match(
    source,
    /uses: releaseway\/npm-actions@<full-commit-sha> # vX\.Y\.Z/,
  );
  assert.match(
    source,
    /uses: actions\/checkout@<checkout-full-commit-sha> # vX\.Y\.Z/,
  );

  const quickStart = source.match(
    /## Quick start[\s\S]*?## What gets published/,
  )?.[0];
  assert.ok(quickStart);
  assert.doesNotMatch(quickStart, /\n\s+with:\n/);
});

test("README Releaseway config examples are accepted by the real parser", async () => {
  const source = await readFile(README, "utf8");
  const yamlBlocks = [...source.matchAll(/```yaml\n([\s\S]*?)```/g)].map(
    (match) => match[1],
  );

  const configExamples = yamlBlocks.filter((block) =>
    /^schema:\s*1/m.test(block),
  );
  assert.equal(configExamples.length, 3);

  for (const example of configExamples) {
    assert.doesNotThrow(() => parseConfig(example));
  }
});

test("README native target list exactly matches runtime support", async () => {
  const source = await readFile(README, "utf8");
  const block = source.match(
    /Supported runtime targets are:\n\n```text\n([\s\S]*?)```/,
  )?.[1];
  assert.ok(block);

  const documented = block
    .trim()
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();

  assert.deepEqual(documented, [...SUPPORTED_NATIVE_TARGETS].sort());
});

test("README keeps current security and scope boundaries explicit", async () => {
  const source = await readFile(README, "utf8");

  for (const required of [
    "https://registry.npmjs.org/",
    "long-lived npm publish token",
    "Brand-new npm packages are outside npm-actions.",
    "Private GitHub Release-backed native assets are not supported.",
    "Staged publishing is the repository default:",
    "publish-time malware scan",
    "postinstall",
    "pending staged-version conflict",
    "SHA-512",
    "SHA-256",
    "The bin path must be extensionless or end in `.js`, `.mjs`, or `.cjs`.",
  ]) {
    assert.ok(source.includes(required), required);
  }

  for (const stale of [
    "native: auto",
    "auth: auto",
    "package-path",
    "registry-url",
  ]) {
    assert.equal(source.includes(stale), false, stale);
  }
});

test("documentation describes one registry-first contract without historical repacking", async () => {
  for (const file of ["README.md", "DESIGN.md", "IMPLEMENTATION.md"]) {
    const text = await readFile(file, "utf8");
    assert.ok(text.includes("already-published"), file);
    assert.doesNotMatch(text, /state: \"existing\"|\"state\":\"existing\"/);
    assert.doesNotMatch(text, /Exact existing-version reconciliation/);
  }
  const readme = await readFile(README, "utf8");
  assert.match(readme, /without packing, provisioning a toolchain/);
  assert.match(readme, /caller owns version bumps/);
  assert.match(readme, /identical concurrent publication/);
});
