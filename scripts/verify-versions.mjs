import { readFile } from "node:fs/promises";
import process from "node:process";
import { prerelease, rcompare, satisfies, valid } from "semver";

const packageJson = JSON.parse(await readFile("package.json", "utf8"));
const toolchain = JSON.parse(await readFile("toolchain.lock.json", "utf8"));
const validation = JSON.parse(
  await readFile("validation-versions.json", "utf8"),
);

const VERSION_RANGES = {
  "@types/node": ">=24.0.0 <25.0.0",
};

async function registryJson(name, suffix = "") {
  const response = await fetch(
    "https://registry.npmjs.org/" + encodeURIComponent(name) + suffix,
    {
      headers: {
        Accept: "application/json",
        "User-Agent": "releaseway-npm-actions-version-gate",
      },
    },
  );
  if (!response.ok) {
    throw new Error(
      "Failed to resolve " + name + suffix + ": HTTP " + response.status,
    );
  }
  return response.json();
}

function nodeCompatible(metadata) {
  const range = metadata?.engines?.node;
  return (
    typeof range !== "string" ||
    range.length === 0 ||
    satisfies(process.versions.node, range)
  );
}

function versionAllowed(name, version) {
  const range = VERSION_RANGES[name] ?? "*";
  return (
    valid(version) === version &&
    prerelease(version) === null &&
    satisfies(version, range)
  );
}

async function preferredStable(name) {
  const latest = await registryJson(name, "/latest");
  if (
    typeof latest.version === "string" &&
    versionAllowed(name, latest.version) &&
    nodeCompatible(latest)
  ) {
    return latest;
  }

  const metadata = await registryJson(name);
  const versions =
    metadata?.versions && typeof metadata.versions === "object"
      ? metadata.versions
      : {};

  const candidates = Object.keys(versions)
    .filter((version) => versionAllowed(name, version))
    .sort(rcompare);

  for (const version of candidates) {
    const candidate = versions[version];
    if (candidate && nodeCompatible(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    "No compatible stable " +
      name +
      " release exists for Node " +
      process.versions.node +
      " and version range " +
      (VERSION_RANGES[name] ?? "*"),
  );
}

function assertExactPreferred(name, actual, metadata, label = name) {
  if (actual !== metadata.version) {
    throw new Error(
      label +
        " is stale: configured " +
        actual +
        ", preferred compatible stable " +
        metadata.version,
    );
  }
}

const devDependencies = packageJson.devDependencies ?? {};
for (const [name, configured] of Object.entries(devDependencies)) {
  if (typeof configured !== "string" || valid(configured) !== configured) {
    throw new Error(
      "devDependency " + name + " must be pinned to an exact semantic version",
    );
  }
  const metadata = await preferredStable(name);
  assertExactPreferred(
    name,
    configured,
    metadata,
    "devDependency " + name,
  );
}

for (const name of ["npm", "corepack"]) {
  const configured = toolchain[name];
  if (!configured || typeof configured !== "object") {
    throw new Error("toolchain.lock.json is missing " + name);
  }
  const metadata = await preferredStable(name);
  assertExactPreferred(
    name,
    configured.version,
    metadata,
    "toolchain " + name,
  );

  if (
    configured.tarball !== metadata?.dist?.tarball ||
    configured.integrity !== metadata?.dist?.integrity
  ) {
    throw new Error(
      "toolchain " +
        name +
        " metadata does not match the preferred registry tarball/integrity",
    );
  }
}

const pnpmMetadata = await preferredStable("pnpm");
assertExactPreferred(
  "pnpm",
  validation.pnpm,
  pnpmMetadata,
  "validation pnpm",
);

const yarnMetadata = await preferredStable("@yarnpkg/cli-dist");
assertExactPreferred(
  "@yarnpkg/cli-dist",
  validation.yarn,
  yarnMetadata,
  "validation Yarn",
);

if (devDependencies["@yarnpkg/cli-dist"] !== validation.yarn) {
  throw new Error(
    "validation Yarn pin must equal devDependency @yarnpkg/cli-dist",
  );
}
