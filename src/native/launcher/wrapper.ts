import { posix } from "node:path";

export type NativeLauncherKind = "cjs" | "esm";

export interface NativeLauncherSpec {
  kind: NativeLauncherKind;
  binPath: string;
  runtimePath: string;
  manifestPath: string;
}

function relativeFromBin(binPath: string, targetPath: string): string {
  const relative = posix.relative(posix.dirname(binPath), targetPath);
  if (!relative || posix.isAbsolute(relative)) {
    throw new Error(
      `Unable to resolve generated native launcher path from ${binPath} to ${targetPath}`,
    );
  }
  return relative;
}

export function renderNativeLauncher(spec: NativeLauncherSpec): string {
  const runtimeRelative = JSON.stringify(
    relativeFromBin(spec.binPath, spec.runtimePath),
  );
  const manifestRelative = JSON.stringify(
    relativeFromBin(spec.binPath, spec.manifestPath),
  );

  if (spec.kind === "cjs") {
    return `#!/usr/bin/env node
"use strict";

const { realpathSync } = require("node:fs");
const { dirname, resolve } = require("node:path");

const self = realpathSync(__filename);
const runtime = require(resolve(dirname(self), ${runtimeRelative}));

runtime.main({
  manifestPath: resolve(dirname(self), ${manifestRelative}),
});
`;
  }

  return `#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const self = realpathSync(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const runtime = require(resolve(dirname(self), ${runtimeRelative}));

runtime.main({
  manifestPath: resolve(dirname(self), ${manifestRelative}),
});
`;
}
