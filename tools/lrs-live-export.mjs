#!/usr/bin/env node
/** Authenticated-container maintenance only. This file NEVER starts an inspector or sends signals.
 * Connect only to an operator-enabled loopback inspector; copy five already-live LRS registries, resume,
 * remove the breakpoint, disconnect, then encrypt in this maintenance process's own memory.
 * Never imports target modules, reads process.env through CDP, takes heap dumps, signs or persists.
 */
import { createHash, randomBytes, hkdfSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SOURCE_SUFFIX = '/applications/foxxi-content-intelligence/src/xapi-lrs.ts';
// Exact original TypeScript at deployed74475d4a; actualmodule fixture uses this same commit.
export const BASELINE_SOURCE_SHA256 = '644b4e7e8ab6b6f7d1f1e8dcf68884979c9fdf65c665b70334a1aa8e8119cc35';
const sha = x => createHash('sha256').update(x).digest('hex');
const fail = code => { throw new Error(code); };
const SAFE_ERRORS = new Set(['loopback-only', 'invalid-port', 'missing-archive-seed', 'inspector-unavailable',
  'inspector-target-ambiguous', 'inspector-channel-closed', 'inspector-response-failed', 'inspector-timeout',
  'target-source-ambiguous', 'target-source-unrecognized', 'target-breakpoint-unavailable', 'pause-timeout',
  'unexpected-pause-frame', 'snapshot-refused', 'snapshot-result-invalid', 'snapshot-byte-limit',
  'snapshot-recovery-mismatch', 'maintenance-pause-budget-exceeded']);

export function recognizeLoadedSource(scriptSource, expectedScriptSha256) {
  const digest = sha(scriptSource);
  if (expectedScriptSha256 && /^[a-f0-9]{64}$/.test(expectedScriptSha256) && digest === expectedScriptSha256) return { loadedScriptSha256: digest, sourcePin: 'operator-supplied-loaded-script-sha256' };
  if (digest === BASELINE_SOURCE_SHA256) return { loadedScriptSha256: digest, originalSourceSha256: digest, sourcePin: 'deployed74475-original-source' };
  const inline = /sourceMappingURL=data:application\/json(?:;charset=utf-8)?;base64,([A-Za-z0-9+/=]+)/.exec(scriptSource);
  if (inline) {
    try {
      const map = JSON.parse(Buffer.from(inline[1], 'base64').toString('utf8'));
      if (Array.isArray(map.sourcesContent) && map.sourcesContent.some(source => typeof source === 'string' && sha(source) === BASELINE_SOURCE_SHA256)) {
        return { loadedScriptSha256: digest, originalSourceSha256: BASELINE_SOURCE_SHA256, sourcePin: 'deployed74475-original-source-in-inline-map' };
      }
    } catch { /* only exact known content is accepted */ }
  }
  fail('target-source-unrecognized');
}

/** Tagged codec keeps exact string collection keys, undefined, binary buffers and property order. */
export const SNAPSHOT_EXPRESSION = `(() => {
  let nodes = 0, characters = 0, binaryBytes = 0, rows = 0;
  const own = (value, key) => {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d || !('value' in d)) throw new Error('unsupported-own-property');
    return d.value;
  };
  const boundedString = x => { characters += x.length; if (characters > 32*1024*1024) throw new Error('snapshot-string-limit'); return x; };
  const encode = (value, depth=0) => {
    if (++nodes > 300000 || depth > 50) throw new Error('snapshot-node-limit');
    if (value === null) return {t:'null'};
    if (value === undefined) return {t:'undefined'};
    if (typeof value === 'string') return {t:'string',v:boundedString(value)};
    if (typeof value === 'boolean') return {t:'boolean',v:value};
    if (typeof value === 'number') return {t:'number',v:Object.is(value,-0)?'-0':Number.isFinite(value)?value:String(value)};
    if (Buffer.isBuffer(value)) {
      binaryBytes += value.length; if(binaryBytes > 32*1024*1024) throw new Error('snapshot-binary-limit');
      return {t:'Buffer',v:Buffer.prototype.toString.call(value,'base64'),n:value.length};
    }
    if (Array.isArray(value)) {
      const properties=Object.getOwnPropertyDescriptors(value),items=[];
      for(let i=0;i<value.length;i++) {
        const d=properties[String(i)];
        if(!d || !('value' in d)) throw new Error('sparse-or-accessor-array-refused');
        items.push(encode(d.value,depth+1));
      }
      return {t:'array',v:items};
    }
    if (typeof value !== 'object') throw new Error('unsupported-value-type');
    const p = Object.getPrototypeOf(value);
    if(p !== Object.prototype && p !== null) throw new Error('unsupported-object-prototype');
    const props=Object.getOwnPropertyDescriptors(value), entries=[];
    for(const key of Object.keys(props)) {
      const d=props[key]; if(!d.enumerable) continue;
      if(!('value' in d)) throw new Error('accessor-refused');
      entries.push([boundedString(key),encode(d.value,depth+1)]);
    }
    return {t:p===null?'null-object':'object',v:entries};
  };
  const partitions = partition => {
    const map=own(partition,'byTenant'); if(!(map instanceof Map)) throw new Error('partition-map-unavailable');
    if(map.size>20000) throw new Error('partition-limit');
    return map;
  };
  const dumpMap = map => {
    if(!(map instanceof Map)) throw new Error('record-map-unavailable');
    const out=[]; for(const [key,value] of map) {
      if(++rows>100000 || typeof key!=='string') throw new Error('record-key-or-count-refused');
      out.push([boundedString(key),encode(value)]);
    } return out;
  };
  const docs = partition => {
    const out=[]; for(const [tenant,map] of partitions(partition)) {
      if(typeof tenant!=='string') throw new Error('tenant-key-refused');
      out.push([boundedString(tenant),dumpMap(map)]);
    } return out;
  };
  const statements=[];
  for(const [tenant,store] of partitions(statementStores)) {
    if(typeof tenant!=='string') throw new Error('tenant-key-refused');
    const descriptors=Object.getOwnPropertyDescriptors(store);
    let map,field;
    for(const key of ['store','hot']) if(descriptors[key] && 'value' in descriptors[key] && descriptors[key].value instanceof Map) { map=descriptors[key].value; field=key; break; }
    if(!map) for(const key of ['memory','cache']) if(descriptors[key] && 'value' in descriptors[key]) {
      const inner=Object.getOwnPropertyDescriptor(descriptors[key].value,'store');
      if(inner && 'value' in inner && inner.value instanceof Map) { map=inner.value; field=key+'.store'; break; }
    }
    if(!map) throw new Error('unknown-statement-storage-shape');
    statements.push({tenant:boundedString(tenant),storageField:field,records:dumpMap(map)});
  }
  return JSON.stringify({schema:'interego-live-lrs-map-snapshot-v1',statements,
    state:docs(stateStores),activityProfile:docs(activityProfileStores),agentProfile:docs(agentProfileStores),
    attachments:docs(attachmentStores),counts:{nodes,rows,binaryBytes}});
})()`;

export function decodeTagged(node) {
  switch (node.t) {
    case 'null': return null; case 'undefined': return undefined;
    case 'string': case 'boolean': return node.v;
    case 'number': return typeof node.v === 'number' ? node.v : Number(node.v);
    case 'Buffer': { const b = Buffer.from(node.v, 'base64'); if (b.length !== node.n) fail('snapshot-result-invalid'); return b; }
    case 'array': return node.v.map(decodeTagged);
    case 'object': case 'null-object': {
      const out = node.t === 'null-object' ? Object.create(null) : {};
      for (const [k, v] of node.v) Object.defineProperty(out, k, { value: decodeTagged(v), enumerable: true, writable: true, configurable: true });
      return out;
    }
    default: fail('snapshot-result-invalid');
  }
}

export function validateSnapshot(raw) {
  const s = JSON.parse(raw);
  if (s?.schema !== 'interego-live-lrs-map-snapshot-v1' || !Array.isArray(s.statements)) fail('snapshot-result-invalid');
  const summary = { statementTenants: s.statements.length, statements: 0, voidedStatements: 0,
    stateDocuments: 0, activityProfiles: 0, agentProfiles: 0, attachments: 0, attachmentBytes: 0 };
  const statementKeys = new Set();
  for (const part of s.statements) {
    if (typeof part.tenant !== 'string' || !Array.isArray(part.records)) fail('snapshot-result-invalid');
    for (const [key, value] of part.records) {
      const record = decodeTagged(value), identity = JSON.stringify([part.tenant, key]);
      if (typeof key !== 'string' || statementKeys.has(identity) || record?.id !== key || typeof record.stored !== 'string') fail('snapshot-result-invalid');
      statementKeys.add(identity); summary.statements++; if (record.voided) summary.voidedStatements++;
    }
  }
  for (const [name, count] of [['state', 'stateDocuments'], ['activityProfile', 'activityProfiles'], ['agentProfile', 'agentProfiles'], ['attachments', 'attachments']]) {
    if (!Array.isArray(s[name])) fail('snapshot-result-invalid');
    for (const [tenant, entries] of s[name]) {
      if (typeof tenant !== 'string' || !Array.isArray(entries)) fail('snapshot-result-invalid');
      const keys = new Set();
      for (const [key, value] of entries) {
        if (typeof key !== 'string' || keys.has(key)) fail('snapshot-result-invalid'); keys.add(key);
        const decoded = decodeTagged(value); summary[count]++;
        if (name === 'attachments') {
          if (!Buffer.isBuffer(decoded.data) || typeof decoded.contentType !== 'string' || sha(decoded.data) !== key) fail('snapshot-result-invalid');
          summary.attachmentBytes += decoded.data.length;
        }
      }
    }
  }
  return summary;
}

function checkPort(n) { if (!Number.isSafeInteger(n) || n < 1024 || n > 65535) fail('invalid-port'); return n; }
export function checkedInspectorUrl(raw) {
  const u = new URL(raw);
  if (u.protocol !== 'ws:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.search || u.hash || !/^\/[a-f0-9-]+$/i.test(u.pathname)) fail('loopback-only');
  checkPort(Number(u.port)); return u.href;
}

class Inspector {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Set();
    ws.addEventListener('message', e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m.id) { const p = this.pending.get(m.id); if (!p) return; clearTimeout(p.timer); this.pending.delete(m.id);
        if (m.error) p.reject(new Error('inspector-response-failed')); else p.resolve(m.result); }
      else for (const h of this.handlers) h(m);
    });
    ws.addEventListener('close', () => { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('inspector-channel-closed')); } this.pending.clear(); });
  }
  call(method, params = {}, timeout = 3000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id, timer = setTimeout(() => { this.pending.delete(id); reject(new Error('inspector-timeout')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch { clearTimeout(timer); this.pending.delete(id); reject(new Error('inspector-channel-closed')); }
    });
  }
  close() { this.ws.close(); }
}
async function attach(inspectorPort) {
  const response = await fetch(`http://127.0.0.1:${checkPort(inspectorPort)}/json/list`, { redirect: 'error', signal: AbortSignal.timeout(3000) });
  const text = await response.text(); if (response.status !== 200 || text.length > 128 * 1024) fail('inspector-unavailable');
  const targets = JSON.parse(text).filter(x => x.type === 'node' && typeof x.webSocketDebuggerUrl === 'string');
  if (targets.length !== 1) fail('inspector-target-ambiguous');
  const url = checkedInspectorUrl(targets[0].webSocketDebuggerUrl);
  if (Number(new URL(url).port) !== inspectorPort) fail('loopback-only');
  const ws = new WebSocket(url), inspector = new Inspector(ws);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('inspector-timeout')), 3000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('inspector-unavailable')); }, { once: true });
  });
  return inspector;
}

export async function captureLiveMaps({ inspectorPort = 9229, aboutPort = 6080,
  sourceSuffix = SOURCE_SUFFIX, pauseBudgetMs = 1000, failAfterPause = false, expectedScriptSha256 } = {}) {
  checkPort(aboutPort);
  const inspector = await attach(inspectorPort); let breakpoint, paused = false, watchdog, trigger;
  let pauseStarted = 0, pauseMs = 0, activeScriptId;
  const scripts = new Map();
  let pausedResolve, pausedReject;
  const pausedPromise = new Promise((resolve, reject) => { pausedResolve = resolve; pausedReject = reject; });
  pausedPromise.catch(() => {}); // An early unexpected pause is still resumed by finally.
  const listener = m => {
    if (m.method === 'Debugger.scriptParsed') scripts.set(m.params.scriptId, m.params.url);
    if (m.method === 'Debugger.paused') {
      paused = true; pauseStarted = performance.now();
      watchdog = setTimeout(() => { inspector.call('Debugger.resume', {}, 1000).catch(() => {}); }, pauseBudgetMs);
      const frame = m.params.callFrames.find(f => f.location.scriptId === activeScriptId && f.functionName === 'handleAbout');
      if (!frame) pausedReject(new Error('unexpected-pause-frame')); else pausedResolve(frame);
    }
  };
  inspector.handlers.add(listener);
  try {
    await inspector.call('Debugger.enable');
    const matches = [...scripts].filter(([, url]) => url.endsWith(sourceSuffix));
    if (matches.length !== 1) fail('target-source-ambiguous');
    const [scriptId] = matches[0]; activeScriptId = scriptId;
    const { scriptSource } = await inspector.call('Debugger.getScriptSource', { scriptId });
    const sourceProof = recognizeLoadedSource(scriptSource, expectedScriptSha256);
    const declarations = ['statementStores', 'stateStores', 'activityProfileStores', 'agentProfileStores', 'attachmentStores'];
    const declared = new Set([...scriptSource.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map(m => m[1]));
    if (!declarations.every(name => declared.has(name))) fail('target-source-unrecognized');
    const match = /function\s+handleAbout\([^)]*\)\s*\{/.exec(scriptSource);
    if (!match) fail('target-source-unrecognized');
    const offset = match.index + match[0].length, prefix = scriptSource.slice(0, offset), lines = prefix.split('\n');
    const location = { scriptId, lineNumber: lines.length - 1, columnNumber: lines.at(-1).length };
    const possible = await inspector.call('Debugger.getPossibleBreakpoints', { start: location, restrictToFunction: true });
    if (!possible.locations?.length) fail('target-breakpoint-unavailable');
    const bound = await inspector.call('Debugger.setBreakpoint', { location: possible.locations[0] }); breakpoint = bound.breakpointId;
    const pauseTimeout = setTimeout(() => pausedReject(new Error('pause-timeout')), 5000);
    trigger = fetch(`http://127.0.0.1:${aboutPort}/xapi/about`, { redirect: 'error', signal: AbortSignal.timeout(8000) }).catch(() => null);
    let raw;
    try {
      const frame = await pausedPromise;
      if (failAfterPause) fail('snapshot-refused');
      // This fixed expression reads no auth/config/environment; only the targeted business collections.
      const result = await inspector.call('Debugger.evaluateOnCallFrame', { callFrameId: frame.callFrameId,
        expression: SNAPSHOT_EXPRESSION, silent: true, returnByValue: true }, 2000);
      if (result.exceptionDetails) fail('snapshot-refused');
      raw = result.result?.value;
      if (typeof raw !== 'string') fail('snapshot-result-invalid');
      if (Buffer.byteLength(raw) > 64 * 1024 * 1024) fail('snapshot-byte-limit');
    } finally { clearTimeout(pauseTimeout); }
    // Remove the one-shot breakpoint while paused, so another About request cannot re-pause us.
    await inspector.call('Debugger.removeBreakpoint', { breakpointId: breakpoint }); breakpoint = undefined;
    // Resume before validation, encryption or any file operations.
    await inspector.call('Debugger.resume'); paused = false;
    pauseMs = performance.now() - pauseStarted; clearTimeout(watchdog);
    const counts = validateSnapshot(raw);
    if (pauseMs > pauseBudgetMs) fail('maintenance-pause-budget-exceeded');
    return { raw, counts, pauseMs, targetSourceSha256: sha(scriptSource), sourceSuffix, sourceProof };
  } finally {
    clearTimeout(watchdog);
    if (breakpoint) { try { await inspector.call('Debugger.removeBreakpoint', { breakpointId: breakpoint }, 1000); } catch { /* disconnect removes breakpoint */ } }
    if (paused) { try { await inspector.call('Debugger.resume', {}, 1000); } catch { /* disconnect below also removes debugger */ } }
    try { await inspector.call('Debugger.disable', {}, 1000); } catch { /* best effort; no record writes */ }
    inspector.handlers.delete(listener); inspector.close();
    if (trigger) await trigger;
  }
}

export function encryptLiveSnapshot(raw, seed, metadata = {}) {
  if (typeof seed !== 'string' || !seed) fail('missing-archive-seed');
  const counts = validateSnapshot(raw), plain = Buffer.from(raw), salt = randomBytes(32), iv = randomBytes(12);
  const key = Buffer.from(hkdfSync('sha256', Buffer.from(seed), salt, Buffer.from('interego:live-lrs-map-snapshot:v1'), 32));
  const header = { schema: 'interego-encrypted-live-lrs-v1', algorithm: 'AES-256-GCM', kdf: 'HKDF-SHA256',
    keyContext: 'FOXXI_ADMIN_KEY_SEED; interego:live-lrs-map-snapshot:v1', createdAt: new Date().toISOString(),
    plaintextSha256: sha(plain), ...metadata };
  const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(Buffer.from(JSON.stringify(header)));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAAD(Buffer.from(JSON.stringify(header))); decipher.setAuthTag(tag);
  const recovered = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (!recovered.equals(plain)) fail('snapshot-recovery-mismatch'); validateSnapshot(recovered.toString());
  key.fill(0); plain.fill(0); recovered.fill(0);
  return { envelope: { header, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: tag.toString('base64'), ciphertext: ciphertext.toString('base64') }, counts };
}

async function main() {
  try {
    const seed = process.env.FOXXI_ADMIN_KEY_SEED;
    if (!seed) fail('missing-archive-seed');
    const captured = await captureLiveMaps({ inspectorPort: Number(process.env.LRS_INSPECTOR_PORT ?? 9229), aboutPort: Number(process.env.PORT ?? 6080), expectedScriptSha256: process.env.LRS_EXPECTED_SOURCE_SHA256 });
    const { envelope, counts } = encryptLiveSnapshot(captured.raw, seed, { targetSourceSha256: captured.targetSourceSha256 });
    const data = JSON.stringify(envelope), out = resolve('lrs-live-output'); await mkdir(out, { recursive: true, mode: 0o700 });
    const summary = { schema: envelope.header.schema, ...counts, pauseMs: Math.round(captured.pauseMs),
      exactDecryptedBytesCompared: true, collectionKeysPreserved: true, ciphertextSha256: sha(data),
      plaintextSha256: envelope.header.plaintextSha256, targetSourceSha256: captured.targetSourceSha256,
      scope: 'The five live LRS collection registries only; records existing during the paused snapshot.' };
    await writeFile(resolve(out, 'lrs-live.encrypted.json'), data, { mode: 0o600, flag: 'wx' });
    await writeFile(resolve(out, 'lrs-live-summary.json'), JSON.stringify(summary, null, 2), { mode: 0o600, flag: 'wx' });
    console.log(`LRS_LIVE_PRESERVED=${JSON.stringify(summary)}`);
  } catch (error) {
    console.log(`LRS_LIVE_EXPORT_FAILED=${JSON.stringify({ code: SAFE_ERRORS.has(error?.message) ? error.message : 'maintenance-operation-failed', archiveWritten: false })}`);
    process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
