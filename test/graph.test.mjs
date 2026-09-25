import assert from "node:assert/strict";
import test from "node:test";
import { buildWorkspaceDependencyGraph } from "../src/graph/dependencies.ts";
import { topologicalPublishOrder } from "../src/graph/topo.ts";
import { parseRegistrySnapshot } from "../src/registry/client.ts";
const pkg = (name, version = "1.0.0", mode = "direct") => ({
  name,
  version,
  publishMode: mode,
});
const artifact = (pkg, fields = {}) => ({
  manifest: { name: pkg.name, version: pkg.version, ...fields },
  entries: [],
  tarballPath: "/unused",
});
function plan(
  packages,
  fields = {},
  live = {},
  included = packages.map((p) => p.name),
) {
  const snapshots = new Map(
    packages.map((p) => [
      p.name,
      parseRegistrySnapshot(p.name, {
        name: p.name,
        versions: Object.fromEntries(
          (live[p.name] ?? []).map((v) => [v, { name: p.name, version: v }]),
        ),
      }),
    ]),
  );
  return buildWorkspaceDependencyGraph(
    packages,
    new Map(
      packages
        .filter((p) => included.includes(p.name))
        .map((p) => [p.name, artifact(p, fields[p.name])]),
    ),
    snapshots,
  );
}
const order = (g) => topologicalPublishOrder(g, new Set(g.packages.keys()));

test("candidate hard and optional dependencies precede their consumers", () => {
  const g = plan([pkg("app"), pkg("lib"), pkg("optional")], {
    app: {
      dependencies: { lib: "^1.0.0" },
      optionalDependencies: { optional: "~1.0.0" },
    },
  });
  assert.deepEqual(order(g), ["lib", "optional", "app"]);
});
test("npm aliases resolve actual scoped target and version", () => {
  const g = plan([pkg("@scope/a-app"), pkg("@scope/z-dep")], {
    "@scope/a-app": { dependencies: { alias: "npm:@scope/z-dep@1.0.0" } },
  });
  assert.deepEqual(order(g), ["@scope/z-dep", "@scope/a-app"]);
  assert.equal(g.requirements.get("@scope/a-app")[0].installName, "alias");
});
test("alias ranges and cycles are validated using target identity", () => {
  assert.throws(
    () =>
      plan([pkg("app"), pkg("dep")], {
        app: { dependencies: { alias: "npm:dep@^2.0.0" } },
      }),
    /no satisfying/,
  );
  const g = plan([pkg("a"), pkg("b")], {
    a: { dependencies: { other: "npm:b@*" } },
    b: { dependencies: { other: "npm:a@*" } },
  });
  assert.throws(() => order(g), /dependency cycle/);
});
test("peer ranges are validated without imposing publish order", () => {
  const g = plan([pkg("host", "2.0.0"), pkg("plugin")], {
    host: { peerDependencies: { plugin: "^1.0.0" } },
    plugin: { peerDependencies: { host: "^2.0.0" } },
  });
  assert.deepEqual(order(g), ["host", "plugin"]);
});
test("published packages are not repacked or interpreted using their local manifests", () => {
  const g = plan(
    [
      pkg("app"),
      { ...pkg("lib", "9.0.0"), manifest: { dependencies: "local garbage" } },
    ],
    { app: { dependencies: { lib: "^1.0.0" } } },
    { lib: ["1.5.0", "9.0.0"] },
    ["app"],
  );
  assert.deepEqual(order(g), ["app"]);
  assert.equal(g.requirements.get("app")[0].version, "1.5.0");
});
test("a satisfying live version takes precedence over a newer staged candidate", () => {
  const g = plan(
    [pkg("app"), pkg("dep", "1.1.0", "stage")],
    { app: { dependencies: { dep: "^1.0.0" } } },
    { dep: ["1.0.0"] },
  );
  assert.equal(g.hardDependencies.get("app").size, 0);
  assert.equal(g.requirements.get("app")[0].source, "live");
});
test("direct required dependencies cannot resolve only to staged candidates", () => {
  assert.throws(
    () =>
      plan([pkg("app"), pkg("dep", "1.0.0", "stage")], {
        app: { dependencies: { dep: "1.0.0" } },
      }),
    /only a staged candidate/,
  );
});
test("transitive staged-only dependency blocks the entire direct plan", () => {
  assert.throws(
    () =>
      plan([pkg("app"), pkg("middle"), pkg("leaf", "1.0.0", "stage")], {
        app: { dependencies: { middle: "*" } },
        middle: { dependencies: { leaf: "*" } },
      }),
    /middle cannot publish directly/,
  );
});
test("staged consumers may reference staged candidates without claiming live availability", () => {
  const g = plan([pkg("app", "1.0.0", "stage"), pkg("dep", "1.0.0", "stage")], {
    app: { dependencies: { dep: "*" } },
  });
  assert.deepEqual(order(g), ["dep", "app"]);
});
test("optional dependencies override required declarations and retain ordering", () => {
  const g = plan([pkg("app"), pkg("dep", "1.0.0", "stage")], {
    app: {
      dependencies: { dep: "^2.0.0" },
      optionalDependencies: { dep: "^1.0.0" },
    },
  });
  assert.deepEqual(order(g), ["dep", "app"]);
  assert.equal(g.requirements.get("app")[0].field, "optionalDependencies");
});
test("hard cycles without an already-live resolution fail closed", () => {
  const g = plan([pkg("a"), pkg("b")], {
    a: { dependencies: { b: "*" } },
    b: { optionalDependencies: { a: "*" } },
  });
  assert.throws(() => order(g), /dependency cycle: a, b/);
});
test("live resolutions can break ordering cycles without fabricating publish order", () => {
  const g = plan(
    [pkg("a", "2.0.0"), pkg("b", "2.0.0")],
    { a: { dependencies: { b: "*" } }, b: { dependencies: { a: "*" } } },
    { a: ["1.0.0"] },
  );
  assert.deepEqual(order(g), ["b", "a"]);
});
test("managed mutable tags, surviving workspace protocols and malformed maps fail", () => {
  for (const spec of ["latest", "workspace:*", "file:../dep"]) {
    assert.throws(() =>
      plan([pkg("app"), pkg("dep")], { app: { dependencies: { dep: spec } } }),
    );
  }
  assert.throws(
    () => plan([pkg("app")], { app: { dependencies: [] } }),
    /mapping/,
  );
});
test("external dependencies do not become managed publication edges", () => {
  const g = plan([pkg("app")], {
    app: {
      dependencies: { external: "^99.0.0", renamed: "npm:unmanaged@^2.0.0" },
    },
  });
  assert.equal(g.requirements.get("app").length, 0);
});
test("independent candidates use deterministic lexical order", () => {
  assert.deepEqual(order(plan([pkg("z"), pkg("a"), pkg("m")])), [
    "a",
    "m",
    "z",
  ]);
});
