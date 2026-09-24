import type { WorkspaceDependencyGraph } from "./dependencies.ts";

export function topologicalPublishOrder(
  graph: WorkspaceDependencyGraph,
  candidates: ReadonlySet<string>,
): string[] {
  for (const candidate of candidates) {
    if (!graph.packages.has(candidate)) {
      throw new Error(`Unknown publish candidate: ${candidate}`);
    }
  }

  const indegree = new Map<string, number>();
  const dependents = new Map<string, Set<string>>();

  for (const candidate of candidates) {
    indegree.set(candidate, 0);
    dependents.set(candidate, new Set());
  }

  for (const candidate of candidates) {
    const dependencies = graph.hardDependencies.get(candidate) ?? new Set();
    for (const dependency of dependencies) {
      if (!candidates.has(dependency)) {
        continue;
      }
      indegree.set(candidate, (indegree.get(candidate) ?? 0) + 1);
      dependents.get(dependency)?.add(candidate);
    }
  }

  const ready = [...candidates]
    .filter((name) => indegree.get(name) === 0)
    .sort();
  const order: string[] = [];

  while (ready.length > 0) {
    const current = ready.shift();
    if (!current) break;
    order.push(current);

    for (const dependent of [...(dependents.get(current) ?? [])].sort()) {
      const next = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, next);
      if (next === 0) {
        ready.push(dependent);
        ready.sort();
      }
    }
  }

  if (order.length !== candidates.size) {
    const cyclic = [...candidates]
      .filter((name) => (indegree.get(name) ?? 0) > 0)
      .sort();
    throw new Error(
      `Workspace publication dependency cycle: ${cyclic.join(", ")}`,
    );
  }

  return order;
}
