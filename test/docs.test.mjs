import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { parse } from "yaml";

import { parseConfig } from "../src/config/load.ts";
import { SUPPORTED_NATIVE_TARGETS } from "../src/native/validate.ts";

const README = resolve("README.md");

test("README quick start matches zero-input OIDC action contract", async () => {
  const source = await readFile(README, "utf8");

  const workflows = [...source.matchAll(/```yaml\s*\n([\s\S]*?)```/g)]
    .map((match) => parse(match[1].replace(/<[a-z-]+-sha>/g, "a".repeat(40))))
    .filter((value) => value?.jobs);
  const workflow = workflows.find((value) => Object.values(value.jobs).some(
    (job) => job.steps?.some((step) => /^releaseway\/npm-actions@/.test(step.uses) && !step.with),
  ));
  assert.ok(workflow, "A runnable zero-input quick start is required");
  assert.deepEqual(workflow.permissions, {
    contents: "read",
    "id-token": "write",
  });
  const steps = Object.values(workflow.jobs).find((job) => job.steps?.some(
    (step) => /^releaseway\/npm-actions@/.test(step.uses) && !step.with,
  )).steps;
  assert.ok(steps.some((step) => /^actions\/checkout@[a-f0-9]{40}$/.test(step.uses)));
  const action = steps.find((step) => /^releaseway\/npm-actions@/.test(step.uses));
  assert.ok(action);
  assert.match(action.uses, /^releaseway\/npm-actions@[a-f0-9]{40}$/);
  assert.equal(action.with, undefined);
});

test("README Releaseway config examples are accepted by the real parser", async () => {
  const source = await readFile(README, "utf8");
  const yamlBlocks = [...source.matchAll(/```yaml\n([\s\S]*?)```/g)].map(
    (match) => match[1],
  );

  const configExamples = yamlBlocks.filter((block) =>
    /^schema:\s*1/m.test(block),
  );
  assert.ok(configExamples.length > 0, "At least one configuration example is required");

  for (const example of configExamples) {
    assert.doesNotThrow(() => parseConfig(example));
  }
});

test("README native target list exactly matches runtime support", async () => {
  const source = await readFile(README, "utf8");
  const block = [...source.matchAll(/```text\s*\n([\s\S]*?)```/g)]
    .map((match) => match[1]).find((value) => value.includes([...SUPPORTED_NATIVE_TARGETS][0]));
  assert.ok(block);

  const documented = block
    .trim()
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .sort();

  assert.deepEqual(documented, [...SUPPORTED_NATIVE_TARGETS].sort());
});

// Security explanations and scope prose are reviewed with the guide. Runtime
// policy is covered by config, registry, native and publication behavior tests.
