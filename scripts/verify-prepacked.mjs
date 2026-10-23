// Verify actual npm wire bytes using disposable fixtures and a loopback registry.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as tar from "tar";
import { bootstrapReleasewayToolchain } from "../src/toolchain/bootstrap.ts";
import { importArtifact } from "../src/artifacts/import.ts";

const sri = bytes => "sha512-" + createHash("sha512").update(bytes).digest("base64");
const root = await mkdtemp(join(tmpdir(), "releaseway-npm-bytes-probe-"));
const writes = [];
const server = createServer(async (request, response) => {
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    let body = Buffer.concat(chunks);
    if (request.headers["content-encoding"] === "gzip") body = gunzipSync(body);
    if (["PUT", "POST"].includes(request.method)) {
      writes.push({ method: request.method, url: request.url, body: JSON.parse(body.toString("utf8")) });
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, id: "releaseway-bytes-probe", rev: "1", stageId: "local-stage" }));
    } else {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ name: "releaseway-bytes-probe", "dist-tags": {}, versions: {} }));
    }
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});

async function cli(npmCli, args, cwd) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:NPM|NODE_AUTH|YARN_NPM|ACTIONS_ID_TOKEN|GITHUB_)/i.test(key)));
  env.HOME = join(root, "home");
  env.USERPROFILE = env.HOME;
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", chunk => { output += chunk; });
    child.stderr.on("data", chunk => { output += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Probe CLI timeout")); }, 30_000);
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

try {
  const toolchain = await bootstrapReleasewayToolchain({ rootBase: root });
  const packageRoot = join(root, "source", "package");
  await mkdir(packageRoot, { recursive: true });
  await mkdir(join(root, "home"));
  await writeFile(join(packageRoot, "package.json"), JSON.stringify({
    name: "releaseway-bytes-probe", version: "1.0.0", repository: "github:releaseway/npm-actions",
    scripts: { prepublishOnly: "node -e \"process.exit(93)\"", prepack: "node -e \"process.exit(94)\"" },
  }));
  await writeFile(join(packageRoot, "index.js"), "module.exports = 42;\n");
  const originalPath = join(root, "original.tgz");
  await tar.c({ cwd: join(root, "source"), file: originalPath, gzip: true, portable: true, mtime: new Date(0) }, ["package"]);
  const original = await readFile(originalPath);
  const alternate = Buffer.from(original);
  alternate.writeUInt32LE(12345, 4);
  assert.deepEqual(gunzipSync(original), gunzipSync(alternate));
  assert.notEqual(sri(original), sri(alternate));

  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  const userConfig = join(root, "user.npmrc");
  const globalConfig = join(root, "global.npmrc");
  await writeFile(userConfig, `//127.0.0.1:${port}/:_authToken=disposable-loopback-only\n`);
  await writeFile(globalConfig, "");
  const results = [];
  for (const mode of ["direct", "stage"]) {
    const previousWrites = writes.length;
    await writeFile(join(root, "input.tgz"), alternate);
    const artifact = await importArtifact(root, { name: "releaseway-bytes-probe", version: "1.0.0", tarball: "input.tgz", integrity: sri(alternate) },
      join(root, "owned", `${mode}.tgz`), "releaseway/npm-actions");
    const path = artifact.tarballPath;
    assert.equal(artifact.manifest.version, "1.0.0");
    // Publication must read the admitted snapshot, even when the producer's path changes.
    await writeFile(join(root, "input.tgz"), "changed after import");
    const result = await cli(toolchain.npmCli, [
      ...(mode === "direct" ? ["publish"] : ["stage", "publish"]), path,
      `--registry=http://127.0.0.1:${port}/`, `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`,
      `--cache=${join(root, "cache")}`, "--tag=bytes-probe", "--ignore-scripts", "--provenance=false", "--fetch-retries=0",
    ], root);
    assert.equal(result.code, 0, result.output);
    assert.equal(writes.length, previousWrites + 1, result.output);
    const captured = writes.at(-1);
    const attachment = Object.values(captured.body._attachments).find(value => value.content_type === "application/octet-stream");
    const uploaded = Buffer.from(attachment.data, "base64");
    assert.deepEqual(uploaded, alternate);
    assert.equal(captured.body.versions["1.0.0"].dist.integrity, sri(alternate));
    assert.deepEqual(await readFile(path), alternate);
    results.push({ mode, method: captured.method, request: captured.url, exactBytes: true, exactSRI: true, sourceUnchanged: true, lifecycleDisabled: true });
  }
  assert.equal(writes.length, 2);
  console.log(JSON.stringify({ node: process.version, npm: "12.2.0", publicWrites: 0, loopbackWrites: writes.length,
    sameExpandedContentDifferentSRI: true, ownedSnapshots: true, results }, null, 2));
} finally {
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
}
