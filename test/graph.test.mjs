import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkspaceDependencyGraph,
} from "../src/graph/dependencies.ts";
import {
  topologicalPublishOrder,
} from "../src/graph/topo.ts";

function pkg(name, version = "1.0.0") {
  return {
    directory: "/workspace/" + name,
    relativeDirectory: name,
    manifestPath: "/workspace/" + name + "/package.json",
    manifest: { name, version, repository: "releaseway/example" },
    name,
    version,
    publishMode: "direct",
  };
}

function artifact(name, version = "1.0.0", fields = {}) {
  return {
    tarballPath: "/tmp/" + name + ".tgz",
    manifest: {
      name,
      version,
      ...fields,
    },
    entries: [],
  };
}

test("hard dependency and optional dependency edges publish dependencies first", () => {
  const packages = [pkg("app"), pkg("lib"), pkg("optional")];
  const artifacts = new Map([
    ["app", artifact("app", "1.0.0", {
      dependencies: { lib: "^1.0.0" },
      optionalDependencies: { optional: "~1.0.0" },
    })],
    ["lib", artifact("lib")],
    ["optional", artifact("optional")],
  ]);

  const graph = buildWorkspaceDependencyGraph(packages, artifacts);
  const order = topologicalPublishOrder(
    graph,
    new Set(["app", "lib", "optional"]),
  );

  assert.equal(order.at(-1), "app");
  assert.ok(order.indexOf("lib") < order.indexOf("app"));
  assert.ok(order.indexOf("optional") < order.indexOf("app"));
});

test("peer dependencies validate ranges without introducing ordering edges", () => {
  const packages = [pkg("host", "2.0.0"), pkg("plugin", "1.0.0")];
  const artifacts = new Map([
    ["host", artifact("host", "2.0.0", {
      peerDependencies: { plugin: "^1.0.0" },
    })],
    ["plugin", artifact("plugin", "1.0.0", {
      peerDependencies: { host: "^2.0.0" },
    })],
  ]);

  const graph = buildWorkspaceDependencyGraph(packages, artifacts);
  assert.deepEqual(
    topologicalPublishOrder(graph, new Set(["plugin", "host"])),
    ["host", "plugin"],
  );
});

test("existing workspace dependencies are removed from candidate ordering", () => {
  const packages = [pkg("app"), pkg("lib")];
  const artifacts = new Map([
    ["app", artifact("app", "1.0.0", {
      dependencies: { lib: "^1.0.0" },
    })],
    ["lib", artifact("lib")],
  ]);

  const graph = buildWorkspaceDependencyGraph(packages, artifacts);
  assert.deepEqual(
    topologicalPublishOrder(graph, new Set(["app"])),
    ["app"],
  );
});

test("incompatible packed workspace ranges fail validation", () => {
  const packages = [pkg("app"), pkg("lib", "2.0.0")];
  const artifacts = new Map([
    ["app", artifact("app", "1.0.0", {
      dependencies: { lib: "^1.0.0" },
    })],
    ["lib", artifact("lib", "2.0.0")],
  ]);

  assert.throws(
    () => buildWorkspaceDependencyGraph(packages, artifacts),
    /does not accept workspace version/,
  );
});

test("hard dependency cycles fail closed", () => {
  const packages = [pkg("a"), pkg("b")];
  const artifacts = new Map([
    ["a", artifact("a", "1.0.0", { dependencies: { b: "^1.0.0" } })],
    ["b", artifact("b", "1.0.0", { optionalDependencies: { a: "^1.0.0" } })],
  ]);

  const graph = buildWorkspaceDependencyGraph(packages, artifacts);
  assert.throws(
    () => topologicalPublishOrder(graph, new Set(["a", "b"])),
    /dependency cycle: a, b/,
  );
});

test("independent candidates use deterministic lexical order", () => {
  const packages = [pkg("z"), pkg("a"), pkg("m")];
  const artifacts = new Map(
    packages.map((value) => [value.name, artifact(value.name)]),
  );
  const graph = buildWorkspaceDependencyGraph(packages, artifacts);

  assert.deepEqual(
    topologicalPublishOrder(graph, new Set(["z", "m", "a"])),
    ["a", "m", "z"],
  );
});
