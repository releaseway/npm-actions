import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

async function latestPackage(name, bin) {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(name)}/latest`,
  );
  if (!response.ok) {
    throw new Error(`Failed to resolve latest ${name}: HTTP ${response.status}`);
  }

  const metadata = await response.json();
  const integrity = metadata?.dist?.integrity;
  const tarball = metadata?.dist?.tarball;

  if (
    typeof metadata.version !== "string" ||
    typeof tarball !== "string" ||
    typeof integrity !== "string" ||
    !integrity.startsWith("sha512-")
  ) {
    throw new Error(`Latest ${name} metadata lacks exact SHA-512 package identity`);
  }

  return {
    version: metadata.version,
    tarball,
    integrity,
    bin,
  };
}

const lock = {
  schema: 1,
  npm: await latestPackage("npm", "bin/npm-cli.js"),
  corepack: await latestPackage("corepack", "dist/corepack.js"),
};

await writeFile(
  resolve("toolchain.lock.json"),
  JSON.stringify(lock, null, 2) + "\n",
  "utf8",
);
