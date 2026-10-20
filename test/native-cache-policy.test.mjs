import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import * as tar from "tar";
import { prepareNativeExecutable } from "../src/native/launcher/cache.ts";

async function fixture(fn) {
  const root=await mkdtemp(join(tmpdir(),"native-cache-policy-"));
  try {
    const source=join(root,"source");await mkdir(source);await writeFile(join(source,"tool"),"#!/bin/sh\nexit 0\n");
    const archive=join(root,"tool.tar.gz");await tar.c({cwd:source,file:archive,gzip:true},["tool"]);
    const bytes=await readFile(archive), target={asset:"tool.tar.gz",executable:"tool",sha256:createHash("sha256").update(bytes).digest("hex")};
    const manifest={repository:"releaseway/example",tag:"v1.0.0",version:"1.0.0",cacheEnv:"TOOL_CACHE_DIR",targets:{"linux-x64-gnu":target}};
    await fn({root,bytes,target,manifest});
  }finally{await rm(root,{recursive:true,force:true});}
}
test("actual preparation honors package, generic, platform and explicit root precedence",async()=>{
  await fixture(async({root,bytes,target,manifest})=>{
    const custom=join(root,"custom"),generic=join(root,"generic"),explicit=join(root,"explicit"),home=join(root,"home");
    for(const [env,rootOverride,expected] of [
      [{TOOL_CACHE_DIR:custom,RELEASEWAY_NATIVE_CACHE_DIR:generic},undefined,custom],
      [{TOOL_CACHE_DIR:"",RELEASEWAY_NATIVE_CACHE_DIR:generic},undefined,generic],
      [{},undefined,join(home,".cache")],
      [{TOOL_CACHE_DIR:custom,RELEASEWAY_NATIVE_CACHE_DIR:generic},explicit,explicit],
    ]){
      const path=await prepareNativeExecutable(manifest,target,{env,root:rootOverride,platform:"linux",home,download:async()=>bytes});
      assert(path.startsWith(expected));
    }
  });
});
test("built launcher consumes manifest cacheEnv on a warm cache",async()=>{
  await fixture(async({root,bytes,target,manifest})=>{
    const custom=join(root,"custom"),generic=join(root,"generic");
    for(const cache of [custom,generic])await prepareNativeExecutable(manifest,target,{root:cache,download:async()=>bytes});
    const path=join(root,"native.json");await writeFile(path,JSON.stringify(manifest));
    const originalCustom=process.env.TOOL_CACHE_DIR,originalGeneric=process.env.RELEASEWAY_NATIVE_CACHE_DIR;
    try {
      process.env.TOOL_CACHE_DIR=custom;process.env.RELEASEWAY_NATIVE_CACHE_DIR=generic;
      const runtime=createRequire(import.meta.url)("../dist/native-runtime.cjs");
      const result=await runtime.resolveLauncherExecutable(path,"linux-x64-gnu");
      assert(result.executable.startsWith(custom));
    }finally{
      if(originalCustom===undefined)delete process.env.TOOL_CACHE_DIR;else process.env.TOOL_CACHE_DIR=originalCustom;
      if(originalGeneric===undefined)delete process.env.RELEASEWAY_NATIVE_CACHE_DIR;else process.env.RELEASEWAY_NATIVE_CACHE_DIR=originalGeneric;
    }
  });
});

test("cached executable mode damage is repaired from the verified archive under concurrent calls",{skip:process.platform==="win32"},async()=>{
  await fixture(async({root,bytes,target,manifest})=>{
    let downloads=0;const options={root:join(root,"cache"),download:async()=>{downloads++;return bytes;}};
    const executable=await prepareNativeExecutable(manifest,target,options);
    assert.equal(spawnSync(executable,[]).status,0);
    await chmod(executable,0o644);
    const repaired=await Promise.all([prepareNativeExecutable(manifest,target,options),prepareNativeExecutable(manifest,target,options)]);
    assert.equal(repaired[0],executable);assert.equal(repaired[1],executable);
    assert.equal(spawnSync(executable,[]).status,0);assert.equal(downloads,1);
    await writeFile(executable,"damaged");
    assert.equal(await prepareNativeExecutable(manifest,target,options),executable);
    assert.equal(spawnSync(executable,[]).status,0);assert.equal(downloads,1);
  });
});
test("valid readonly cache is reusable and invalid readonly cache fails with recovery guidance",{skip:process.platform==="win32"||process.getuid?.()===0},async()=>{
  await fixture(async({root,bytes,target,manifest})=>{
    const options={root:join(root,"cache"),download:async()=>bytes};
    const executable=await prepareNativeExecutable(manifest,target,options),entry=dirname(executable),parent=dirname(entry);
    try {
      await chmod(entry,0o555);await chmod(parent,0o555);await chmod(executable,0o555);
      assert.equal(await prepareNativeExecutable(manifest,target,options),executable);
      await chmod(executable,0o644);
      await assert.rejects(prepareNativeExecutable(manifest,target,options),/check permissions.*invalid entry/);
    }finally{await chmod(parent,0o755);await chmod(entry,0o755);await chmod(executable,0o755);}
  });
});
