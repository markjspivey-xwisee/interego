import { readFile, readdir, mkdir, writeFile, lstat } from 'node:fs/promises';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';

export const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), 'interego-workflows');
const hash = data => createHash('sha256').update(data).digest('hex');
const allowed = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);

export function validateManifest(manifest) {
  if (Object.keys(manifest).some(key => !allowed.has(key))) throw new Error('Unsupported portable manifest field');
  if (manifest.$schema !== 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') throw new Error('Unexpected plugin schema');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name) || manifest.name.length > 64) throw new Error('Invalid plugin name');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) throw new Error('Invalid release version');
  const ui = manifest.extensions?.['com.openai']?.interface;
  if (!ui || ui.shortDescription.length > 30) throw new Error('Invalid listing subtitle');
  if (typeof ui.defaultPrompt !== 'string' && (!Array.isArray(ui.defaultPrompt) || ui.defaultPrompt.length > 3 || ui.defaultPrompt.some(x => typeof x !== 'string'))) throw new Error('Invalid starting prompts');
}

export async function collect(root, sub = '') {
  const files = [];
  for (const entry of (await readdir(resolve(root, sub), { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name, 'en'))) {
    const name = sub ? `${sub}/${entry.name}` : entry.name;
    const absolute = resolve(root, name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) throw new Error(`Symlink is not distributable: ${name}`);
    if (entry.isDirectory()) files.push(...await collect(root, name));
    else if (entry.isFile()) files.push({ name, data: await readFile(absolute) });
    else throw new Error(`Unsupported entry: ${name}`);
  }
  return files;
}

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit=0; bit<8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function zip(files, prefix) {
  const parts=[], directory=[]; let offset=0;
  for (const file of files) {
    if (file.name.startsWith('/') || file.name.split('/').some(x => x === '..' || !x) || file.name.includes('\\')) throw new Error('Unsafe archive path');
    const name=Buffer.from(`${prefix}/${file.name}`), data=file.data;
    const compressed=deflateRawSync(data), crc=crc32(data);
    const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20,4); local.writeUInt16LE(0x800,6); local.writeUInt16LE(8,8); local.writeUInt16LE(33,12);
    local.writeUInt32LE(crc,14); local.writeUInt32LE(compressed.length,18); local.writeUInt32LE(data.length,22); local.writeUInt16LE(name.length,26);
    const central=Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(0x800,8); central.writeUInt16LE(8,10); central.writeUInt16LE(33,14);
    central.writeUInt32LE(crc,16); central.writeUInt32LE(compressed.length,20); central.writeUInt32LE(data.length,24); central.writeUInt16LE(name.length,28); central.writeUInt32LE(offset,42);
    parts.push(local,name,compressed); directory.push(central,name); offset += local.length+name.length+compressed.length;
  }
  const table=Buffer.concat(directory), end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(table.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...parts,table,end]);
}

export async function build({ out, appId, appKey, root=sourceRoot }) {
  root=resolve(root); out=resolve(out);
  const rel=relative(root,out);
  if (!rel || (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.includes(':'))) throw new Error('Output must be outside plugin source');
  let files=await collect(root);
  const manifest=JSON.parse(files.find(x => x.name==='plugin.json').data.toString());
  validateManifest(manifest);
  const skillFiles=files.filter(x => /^skills\/[^/]+\/SKILL\.md$/.test(x.name));
  if (skillFiles.length !== 5) throw new Error('Expected five workflow skills');
  for(const file of skillFiles) {
    const front=file.data.toString().match(/^---\r?\nname: ([a-z0-9-]+)\r?\ndescription: ([^\r\n]+)\r?\n---\r?\n/);
    if (!front || file.name !== `skills/${front[1]}/SKILL.md`) throw new Error(`Invalid skill frontmatter: ${file.name}`);
  }
  const mcp=JSON.parse(files.find(x => x.name==='mcp.json').data.toString());
  if (mcp.$schema!=='https://agent-plugins.org/schemas/1.0.0/mcp.schema.json' || Object.keys(mcp.mcpServers).length!==1 || mcp.mcpServers.interego.type!=='streamable-http' || mcp.mcpServers.interego.url!=='https://relay.interego.xwisee.com/mcp') throw new Error('Invalid existing service connection');
  if (Boolean(appId) !== Boolean(appKey)) throw new Error('Supply both verified app ID and app key');
  if (appId) {
    if (!/^asdk_app_[a-f0-9]+$/.test(appId) || !/^[a-zA-Z0-9_-]+$/.test(appKey)) throw new Error('Invalid account binding');
    manifest.extensions['com.openai'].apps='./.app.json';
    files=files.filter(x => x.name!=='mcp.json');
    files.push({name:'.app.json',data:Buffer.from(JSON.stringify({apps:{[appKey]:{id:appId}}},null,2)+'\n')});
    files.find(x => x.name==='plugin.json').data=Buffer.from(JSON.stringify(manifest,null,2)+'\n');
  }
  const bootstrap=files.find(x => x.name==='runtime/bootstrap.md').data.toString();
  if (!bootstrap.startsWith(`# Interego workflow bootstrap\n\nVersion: ${manifest.version}\n`)) throw new Error('Bootstrap version does not match release');
  files.sort((a,b)=>a.name.localeCompare(b.name,'en'));
  const mode=appId?'account':'portable';
  const archive=zip(files,manifest.name);
  const receipt={name:manifest.name,version:manifest.version,mode,archiveSha256:hash(archive),bootstrapSha256:hash(bootstrap),files:files.map(f=>({path:f.name,sha256:hash(f.data),bytes:f.data.length}))};
  const module=`// Generated from interego-workflows/runtime/bootstrap.md; do not edit.\nexport const version = ${JSON.stringify(manifest.version)};\nexport const sha256 = ${JSON.stringify(receipt.bootstrapSha256)};\nexport const instructions = ${JSON.stringify(bootstrap)};\n`;
  await mkdir(out,{recursive:true});
  const archivePath=resolve(out,`${manifest.name}-${manifest.version}-${mode}.zip`);
  await writeFile(archivePath,archive);
  await writeFile(resolve(out,`${manifest.name}-${manifest.version}-${mode}.manifest.json`),JSON.stringify(receipt,null,2)+'\n');
  await writeFile(resolve(out,'interego-bootstrap.mjs'),module);
  return {archivePath,...receipt};
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const args=process.argv.slice(2), options={};
  for(let i=0;i<args.length;i+=2){const key={'--out':'out','--app-id':'appId','--app-key':'appKey'}[args[i]];if(!key || !args[i+1])throw new Error('Usage: build.mjs --out ABSOLUTE_DIRECTORY [--app-id VERIFIED_APP_ID --app-key VERIFIED_APP_KEY]');options[key]=args[i+1];}
  if(!options.out) throw new Error('An output directory is required');
  console.log(JSON.stringify(await build(options),null,2));
}
