import { readFile, readdir } from "node:fs/promises";
import { valid } from "semver";
import { parse, parseAllDocuments } from "yaml";

export async function verifyFixedVersions(root = ".") {
  const load = async (name) => JSON.parse(await readFile(`${root}/${name}`, "utf8"));
  const [pkg, lockSource, tools, validation] = await Promise.all([
    load("package.json"), readFile(`${root}/pnpm-lock.yaml`, "utf8"), load("toolchain.lock.json"), load("validation-versions.json"),
  ]);
  // pnpm 12 stores the manager/config lock and project lock as YAML documents.
  const documents = parseAllDocuments(lockSource);
  if (documents.some((document) => document.errors.length)) throw new Error("Invalid pnpm lockfile");
  const locks = documents.map((document) => document.toJS());
  const projectLocks = locks.filter((lock) => lock?.importers?.["."]?.devDependencies);
  if (projectLocks.length !== 1) throw new Error("Expected one root dependency lock");
  const lock = projectLocks[0];
  const managerLocks = locks.filter((lock) => lock?.importers?.["."]?.packageManagerDependencies?.pnpm);
  if (managerLocks.length !== 1) throw new Error("Expected one pnpm manager lock");
  const manager = managerLocks[0].importers["."].packageManagerDependencies.pnpm;
  if (pkg.packageManager !== `pnpm@${manager.version}` || manager.specifier !== manager.version) throw new Error("Package manager lock mismatch");
  const exact = (value, label) => {
    if (typeof value !== "string" || valid(value) !== value) throw new Error(`${label} must be an exact semantic version`);
  };
  const integrity = (value, label) => {
    const match = typeof value === "string" && /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || Buffer.from(match[1], "base64").length !== 64) throw new Error(`${label} must have valid SHA-512 integrity`);
  };
  exact(manager.version, "package manager pnpm");
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    exact(version, `devDependency ${name}`);
    const installed = lock.importers["."].devDependencies[name];
    if (installed?.specifier !== version || installed?.version !== version || !lock.packages?.[`${name}@${version}`]) throw new Error(`Lock mismatch for ${name}`);
  }
  for (const document of locks) {
    for (const [path, entry] of Object.entries(document.packages ?? {})) {
      if (!entry.resolution?.directory) integrity(entry.resolution?.integrity, `lock package ${path}`);
    }
  }
  if (tools.schema !== 1 || validation.schema !== 1) throw new Error("Unsupported pin schema");
  for (const name of ["npm", "corepack"]) {
    const tool = tools[name];
    exact(tool?.version, `toolchain ${name}`);
    integrity(tool?.integrity, `toolchain ${name}`);
    if (tool.tarball !== `https://registry.npmjs.org/${name}/-/${name}-${tool.version}.tgz`) throw new Error(`Pinned ${name} tarball identity mismatch`);
    if (tool.bin !== (name === "npm" ? "bin/npm-cli.js" : "dist/corepack.js")) throw new Error(`Pinned ${name} executable mismatch`);
  }
  exact(validation.pnpm, "validation pnpm");
  exact(validation.yarn, "validation Yarn");
  if (pkg.devDependencies?.["@yarnpkg/cli-dist"] !== validation.yarn) throw new Error("validation Yarn pin must equal devDependency @yarnpkg/cli-dist");
  for (const file of await readdir(`${root}/.github/workflows`)) {
    if (!/\.ya?ml$/.test(file)) continue;
    const workflow = parse(await readFile(`${root}/.github/workflows/${file}`, "utf8"));
    const inspect = (uses) => {
      if (uses && !uses.startsWith("./") && !/^[^@\s]+@[0-9a-f]{40}$/.test(uses)) throw new Error(`Workflow ${file} must pin action ${uses} to a full SHA`);
    };
    for (const job of Object.values(workflow.jobs ?? {})) {
      inspect(job.uses);
      for (const step of job.steps ?? []) inspect(step.uses);
    }
  }
}
