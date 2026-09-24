import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  loadConfig,
  parseConfig,
} from "../src/config/load.ts";
import {
  discoverWorkspace,
  selectPublishablePackages,
} from "../src/workspace/discover.ts";
import {
  githubContextFromEnv,
  verifySourceIdentity,
} from "../src/workspace/identity.ts";
import {
  parseGitHubRepository,
  repositoryFullName,
} from "../src/workspace/repository.ts";

async function json(path, value) {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function packageAt(root, relative, manifest) {
  const directory = relative === "." ? root : join(root, relative);
  await mkdir(directory, { recursive: true });
  await json(join(directory, "package.json"), manifest);
}

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), "releaseway-workspace-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("missing Releaseway config uses staged repository defaults", async () => {
  await fixture(async (root) => {
    const config = await loadConfig(root);
    assert.deepEqual(config, {
      schema: 1,
      publish: { mode: "stage" },
      packages: {},
    });
  });
});

test("config parsing is strict and preserves package overrides", () => {
  const config = parseConfig(`
schema: 1
publish:
  mode: direct
packages:
  "@scope/cli":
    publish:
      mode: stage
    distribution:
      type: github-release
      tag: "v{version}"
      targets:
        linux-x64-gnu:
          asset: cli_linux_x64.tar.gz
          executable: cli
`);

  assert.equal(config.packages["@scope/cli"].publish.mode, "stage");
  assert.equal(
    config.packages["@scope/cli"].distribution.targets["linux-x64-gnu"].asset,
    "cli_linux_x64.tar.gz",
  );

  assert.throws(
    () => parseConfig("schema: 1\nunknown: true\n"),
    /unsupported keys/,
  );
  assert.throws(
    () => parseConfig("schema: 1\nschema: 1\n"),
    /Invalid Releaseway config/,
  );
});

test("package.json workspaces discover root and public children", async () => {
  await fixture(async (root) => {
    await packageAt(root, ".", {
      private: true,
      workspaces: { packages: ["packages/*"] },
    });
    await packageAt(root, "packages/a", {
      name: "@scope/a",
      version: "1.0.0",
      repository: "github:releaseway/example",
    });
    await packageAt(root, "packages/b", {
      name: "@scope/b",
      version: "2.0.0",
      repository: {
        type: "git",
        url: "git+https://github.com/releaseway/example.git",
      },
      publishConfig: {
        registry: "https://registry.npmjs.org/",
      },
    });

    const discovered = await discoverWorkspace(root);
    assert.deepEqual(
      discovered.map((pkg) => pkg.relativeDirectory),
      [".", "packages/a", "packages/b"],
    );

    const config = parseConfig(`
schema: 1
publish:
  mode: direct
packages:
  "@scope/b":
    publish:
      mode: stage
`);
    const publishable = selectPublishablePackages(
      discovered,
      config,
      "releaseway/example",
    );

    assert.deepEqual(
      publishable.map(({ name, publishMode }) => ({ name, publishMode })),
      [
        { name: "@scope/a", publishMode: "direct" },
        { name: "@scope/b", publishMode: "stage" },
      ],
    );
  });
});


test("package.json workspace arrays cover npm and modern Yarn layouts", async () => {
  await fixture(async (root) => {
    await packageAt(root, ".", {
      private: true,
      workspaces: ["packages/*"],
    });
    await packageAt(root, "packages/a", {
      name: "@scope/a",
      version: "1.0.0",
      repository: "releaseway/example",
    });

    const discovered = await discoverWorkspace(root);
    assert.deepEqual(
      discovered.map((pkg) => pkg.relativeDirectory),
      [".", "packages/a"],
    );
  });
});

test("pnpm-workspace patterns include defaults and exclusions", async () => {
  await fixture(async (root) => {
    await packageAt(root, ".", {
      private: true,
      packageManager: "pnpm@12.6.0",
    });
    await packageAt(root, "packages/keep", {
      name: "@scope/keep",
      version: "1.0.0",
      repository: "releaseway/example",
    });
    await packageAt(root, "packages/excluded", {
      name: "@scope/excluded",
      version: "1.0.0",
      repository: "releaseway/example",
    });
    await writeFile(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n  - '!packages/excluded'\n",
    );

    const discovered = await discoverWorkspace(root);
    assert.deepEqual(
      discovered.map((pkg) => pkg.relativeDirectory),
      [".", "packages/keep"],
    );
  });

  await fixture(async (root) => {
    await packageAt(root, ".", {
      private: true,
      packageManager: "pnpm@12.6.0",
    });
    await packageAt(root, "nested/pkg", {
      name: "@scope/nested",
      version: "1.0.0",
      repository: "releaseway/example",
    });
    await writeFile(join(root, "pnpm-workspace.yaml"), "catalog: {}\n");

    const discovered = await discoverWorkspace(root);
    assert.deepEqual(
      discovered.map((pkg) => pkg.relativeDirectory),
      [".", "nested/pkg"],
    );
  });
});

test("duplicate names and stale config selectors fail before packing", async () => {
  await fixture(async (root) => {
    await packageAt(root, ".", {
      private: true,
      workspaces: ["packages/*"],
    });
    for (const name of ["a", "b"]) {
      await packageAt(root, `packages/${name}`, {
        name: "@scope/duplicate",
        version: "1.0.0",
        repository: "releaseway/example",
      });
    }

    const discovered = await discoverWorkspace(root);
    assert.throws(
      () =>
        selectPublishablePackages(
          discovered,
          { schema: 1, publish: { mode: "direct" }, packages: {} },
          "releaseway/example",
        ),
      /Duplicate workspace package name/,
    );
  });

  await fixture(async (root) => {
    await packageAt(root, ".", {
      name: "@scope/a",
      version: "1.0.0",
      repository: "releaseway/example",
    });

    const discovered = await discoverWorkspace(root);
    assert.throws(
      () =>
        selectPublishablePackages(
          discovered,
          {
            schema: 1,
            publish: { mode: "direct" },
            packages: { "@scope/missing": {} },
          },
          "releaseway/example",
        ),
      /does not match a discovered package/,
    );
  });
});

test("repository and registry mismatches fail closed", async () => {
  await fixture(async (root) => {
    await packageAt(root, ".", {
      name: "@scope/a",
      version: "1.0.0",
      repository: "releaseway/other",
      publishConfig: {
        registry: "https://npm.example.invalid/",
      },
    });

    const discovered = await discoverWorkspace(root);
    assert.throws(
      () =>
        selectPublishablePackages(
          discovered,
          { schema: 1, publish: { mode: "direct" }, packages: {} },
          "releaseway/example",
        ),
      /unsupported registry/,
    );

    discovered[0].manifest.publishConfig = {
      registry: "https://registry.npmjs.org/",
    };
    assert.throws(
      () =>
        selectPublishablePackages(
          discovered,
          { schema: 1, publish: { mode: "direct" }, packages: {} },
          "releaseway/example",
        ),
      /does not match/,
    );
  });
});

test("GitHub repository parser accepts common npm repository forms", () => {
  for (const value of [
    "releaseway/example",
    "github:releaseway/example",
    "git@github.com:releaseway/example.git",
    "git+https://github.com/releaseway/example.git",
    { type: "git", url: "https://github.com/releaseway/example.git" },
  ]) {
    assert.equal(
      repositoryFullName(parseGitHubRepository(value)),
      "releaseway/example",
    );
  }
  assert.throws(
    () => parseGitHubRepository("https://gitlab.com/releaseway/example.git"),
    /github\.com/,
  );
});

test("GitHub source identity requires exact SHA and origin repository", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const context = githubContextFromEnv({
    GITHUB_WORKSPACE: "/workspace/repo",
    GITHUB_REPOSITORY: "releaseway/example",
    GITHUB_SHA: sha,
  });

  const successfulGit = (args) => {
    if (args.join(" ") === "rev-parse HEAD") {
      return { status: 0, stdout: sha + "\n", stderr: "" };
    }
    if (args.join(" ") === "remote get-url origin") {
      return {
        status: 0,
        stdout: "https://github.com/releaseway/example.git\n",
        stderr: "",
      };
    }
    throw new Error("unexpected git command");
  };

  verifySourceIdentity(context, successfulGit);

  assert.throws(
    () =>
      verifySourceIdentity(context, (args) =>
        args.join(" ") === "rev-parse HEAD"
          ? {
              status: 0,
              stdout: "ffffffffffffffffffffffffffffffffffffffff\n",
              stderr: "",
            }
          : successfulGit(args),
      ),
    /does not match GITHUB_SHA/,
  );

  assert.throws(
    () =>
      verifySourceIdentity(context, (args) =>
        args.join(" ") === "remote get-url origin"
          ? {
              status: 0,
              stdout: "https://github.com/releaseway/other.git\n",
              stderr: "",
            }
          : successfulGit(args),
      ),
    /does not match GITHUB_REPOSITORY/,
  );
});
