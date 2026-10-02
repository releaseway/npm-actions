import { readFile, readdir } from "node:fs/promises";
import { valid } from "semver";
import { parse } from "yaml";

export async function verifyFixedVersions(root = ".") {
  const load = async (name) => JSON.parse(await readFile(`${root}/${name}`, "utf8"));
  const [pkg, lock, tools, validation] = await Promise.all([
    load("package.json"), load("package-lock.json"), load("toolchain.lock.json"), load("validation-versions.json"),
  ]);
  const exact = (value, label) => {
    if (typeof value !== "string" || valid(value) !== value) throw new Error(`${label} must be an exact semantic version`);
  };
  const integrity = (value, label) => {
    const match = typeof value === "string" && /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match || Buffer.from(match[1], "base64").length !== 64) throw new Error(`${label} must have valid SHA-512 integrity`);
  };
  for (const [name, version] of Object.entries(pkg.devDependencies ?? {})) {
    exact(version, `devDependency ${name}`);
    const installed = lock.packages?.[`node_modules/${name}`];
    if (lock.packages?.[""]?.devDependencies?.[name] !== version || installed?.version !== version) throw new Error(`Lock mismatch for ${name}`);
  }
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path && !entry.link) integrity(entry.integrity, `lock package ${path}`);
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
