import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { build, sourceRoot, crc32, collect, zip } from './build.mjs';

function unzip(bytes) {
  const out=new Map();let offset=0;
  while(bytes.readUInt32LE(offset)===0x04034b50){
    const length=bytes.readUInt32LE(offset+18), expectedSize=bytes.readUInt32LE(offset+22),nameLength=bytes.readUInt16LE(offset+26),extraLength=bytes.readUInt16LE(offset+28);
    const name=bytes.subarray(offset+30,offset+30+nameLength).toString(),start=offset+30+nameLength+extraLength;
    const data=inflateRawSync(bytes.subarray(start,start+length));
    assert.equal(data.length,expectedSize);assert.equal(crc32(data),bytes.readUInt32LE(offset+14));assert.ok(!out.has(name));out.set(name,data);offset=start+length;
  }
  assert.equal(bytes.readUInt32LE(offset),0x02014b50);
  assert.equal(bytes.readUInt32LE(bytes.length-22),0x06054b50);
  assert.equal(bytes.readUInt16LE(bytes.length-12),out.size);
  return out;
}

async function withOutput(run) {const dir=await mkdtemp(join(tmpdir(),'interego-plugin-test-'));try{return await run(dir);}finally{await rm(dir,{recursive:true,force:true});}}

test('portable ZIP preserves every source file and durable bootstrap identity',()=>withOutput(async out=>{
 const result=await build({out}),bytes=await readFile(result.archivePath),entries=unzip(bytes);
 for(const file of await collect(sourceRoot)) assert.deepEqual(entries.get(`interego-workflows/${file.name}`),file.data);
 const mcp=JSON.parse(entries.get('interego-workflows/mcp.json'));
 assert.equal(mcp.mcpServers.interego.type,'streamable-http');assert.equal(new URL(mcp.mcpServers.interego.url).protocol,'https:');
 const module=await import(pathToFileURL(join(out,'interego-bootstrap.mjs')));
 const bootstrap=entries.get('interego-workflows/runtime/bootstrap.md').toString();
 assert.equal(module.instructions,bootstrap);assert.equal(module.version,result.version);assert.equal(module.sha256,createHash('sha256').update(bootstrap).digest('hex'));
 assert.equal(result.archiveSha256,createHash('sha256').update(bytes).digest('hex'));
}));

test('account ZIP retains the same skills and reuses exactly one app without a duplicate MCP connection',()=>withOutput(async out=>{
 const fixtureApp='asdk_app_0123456789abcdef',fixtureKey='interego-fixture';
 const result=await build({out,appId:fixtureApp,appKey:fixtureKey});const entries=unzip(await readFile(result.archivePath));
 assert.ok(!entries.has('interego-workflows/mcp.json'));
 assert.deepEqual(JSON.parse(entries.get('interego-workflows/.app.json')),{apps:{[fixtureKey]:{id:fixtureApp}}});
 const manifest=JSON.parse(entries.get('interego-workflows/plugin.json'));
 assert.equal(manifest.extensions['com.openai'].apps,'./.app.json');assert.ok(!('apps' in manifest));
 for(const source of (await collect(sourceRoot)).filter(f=>f.name.startsWith('skills/')))assert.deepEqual(entries.get(`interego-workflows/${source.name}`),source.data);
}));

test('repeated builds are deterministic',()=>withOutput(async out=>{const first=await build({out}),second=await build({out});assert.equal(first.archiveSha256,second.archiveSha256);}));

test('incomplete identity binding and source overwrite are rejected',()=>withOutput(async out=>{
 await assert.rejects(build({out,appId:'asdk_app_123'}),/both verified/);
 await assert.rejects(build({out,appId:'asdk_app_123',appKey:'../escape'}),/Invalid account/);
 await assert.rejects(build({out:sourceRoot}),/outside plugin/);
 await assert.rejects(build({out:join(sourceRoot,'dist')}),/outside plugin/);
}));

test('archive path traversal is rejected',()=>{assert.throws(()=>zip([{name:'../escape',data:Buffer.from('x')}],'interego-workflows'),/Unsafe archive/);});
