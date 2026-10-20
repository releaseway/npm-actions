import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { packAllPackages } from "../src/pack/index.ts";

async function fixture(hook = false) {
  const root = await mkdtemp(join(tmpdir(), "pack-recovery-"));
  await writeFile(join(root,"package.json"), JSON.stringify({ private:true }));
  await writeFile(join(root,"pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
  await writeFile(join(root,".gitignore"), "node_modules/\n");
  const packages=[];
  for(const name of ["a","b"]){
    const directory=join(root,"packages",name);await mkdir(directory,{recursive:true});
    const manifest={name:"@fixture/"+name,version:"0.0.0",...(name==="a"?{dependencies:{"@fixture/b":"workspace:*"},...(hook?{scripts:{prepack:'node -e "const f=require(\'fs\');f.unlinkSync(\'package.json\');f.mkdirSync(\'package.json\');process.exit(17)"'}}:{})}:{})};
    const manifestPath=join(directory,"package.json");await writeFile(manifestPath,JSON.stringify(manifest)+"\n");
    packages.push({name:manifest.name,version:"1.2.3",manifest,manifestPath,directory,relativeDirectory:"packages/"+name,publishMode:"direct"});
  }
  await mkdir(join(packages[0].directory,"node_modules/@fixture"),{recursive:true});await symlink(packages[1].directory,join(packages[0].directory,"node_modules/@fixture/b"),"junction");
  for(const args of [["init"],["add","."]]){const r=spawnSync("git",args,{cwd:root,encoding:"utf8"});assert.equal(r.status,0,r.stderr);}
  const command={name:"pnpm",version:"12.14.0",executable:process.env.RELEASEWAY_TEST_PNPM??"pnpm",argsPrefix:[],env:{...process.env,COREPACK_ENABLE_PROJECT_SPEC:"0"}};
  return {root,packages,command};
}
test("partial packing uses the complete lockstep version plan and restores every manifest",async()=>{
  const {root,packages,command}=await fixture();const out=await mkdtemp(join(tmpdir(),"pack-output-"));
  try{
    const originals=await Promise.all(packages.map(p=>readFile(p.manifestPath)));
    const packed=await packAllPackages(root,[packages[0]],command,out,undefined,packages);
    assert.equal(packed.length,1);assert.equal(packed[0].manifest.dependencies["@fixture/b"],"1.2.3");
    for(let i=0;i<packages.length;i++)assert.deepEqual(await readFile(packages[i].manifestPath),originals[i]);
  }finally{await rm(root,{recursive:true,force:true});await rm(out,{recursive:true,force:true});}
});
test("one failed restore preserves the pack error and backups while restoring other manifests",async()=>{
  const {root,packages,command}=await fixture(true);const out=await mkdtemp(join(tmpdir(),"pack-output-"));let failure;
  try{
    try{await packAllPackages(root,packages,command,out);}catch(error){failure=error;}
    assert(failure instanceof AggregateError);assert.match(failure.errors[0].message,/pack failed/);
    assert.equal(JSON.parse(await readFile(packages[1].manifestPath,"utf8")).version,"0.0.0");
    const recovery=JSON.parse(await readFile(join(failure.recoveryDirectory,"recovery.json"),"utf8"));
    assert.equal(recovery[0].path,packages[0].manifestPath);
    assert.equal(JSON.parse(await readFile(join(failure.recoveryDirectory,recovery[0].backup),"utf8")).version,"0.0.0");
  }finally{await rm(root,{recursive:true,force:true});await rm(out,{recursive:true,force:true});if(failure?.recoveryDirectory)await rm(failure.recoveryDirectory,{recursive:true,force:true});}
});
