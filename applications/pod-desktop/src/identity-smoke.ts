/** Isolated packaged verification: native owner IPC, real console host, DPAPI and broker. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, createPublicKey, randomBytes, randomUUID, verify as verifySignature } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { LocalIdentityContext, LocalIdentityStatus, LocalIdentityTicket } from './local-identity-types.js';

export interface IdentitySmokeOptions {
  readonly invoke: <T>(method: string, argument?: unknown) => Promise<T>;
  readonly approve: (id: string, verificationCode: string) => Promise<LocalIdentityStatus>;
  readonly executable: string;
  readonly dataDir: string;
  readonly allow: (ids: readonly string[]) => Promise<unknown>;
  readonly expectPrevious: boolean;
}
const relay = 'https://relay.interego.xwisee.com';
const provider = 'https://identity.interego.xwisee.com';
const callback = 'https://packaged-client.example/callback?fixture=local-identity';
const extensionId = 'a'.repeat(32);
const opaque = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
function insist(value: unknown, stage: string): asserts value { if (!value) throw new Error(`Packaged local sign-in verification failed: ${stage}.`); }
function object(value: unknown): Record<string, unknown> {
  insist(value && typeof value === 'object' && !Array.isArray(value), 'response object'); return value as Record<string, unknown>;
}
function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).sort().join(',') === [...keys].sort().join(','); }
function publicKey(did: string) {
  insist(/^did:key:z[1-9A-HJ-NP-Za-km-z]{40,60}$/.test(did), 'public identity');
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'; let number = 0n;
  for (const character of did.slice(9)) number = number * 58n + BigInt(alphabet.indexOf(character));
  const text = number.toString(16); const decoded = Buffer.from(text.length % 2 ? '0' + text : text, 'hex');
  insist(decoded.length === 34 && decoded[0] === 0xed && decoded[1] === 0x01, 'Ed25519 identity');
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), decoded.subarray(2)]), type: 'spki', format: 'der' });
}
async function bounded<T>(operation: Promise<T>, stage: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<T>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`Packaged local sign-in verification timed out: ${stage}.`)), 20_000); })]); }
  finally { clearTimeout(timer); }
}

class NativePort {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly output: AsyncIterator<Buffer>;
  private readonly closed: Promise<number | null>;
  private buffered = Buffer.alloc(0);
  private diagnostic = false;
  constructor(options: IdentitySmokeOptions, private readonly inspect: (value: unknown) => void) {
    this.child = spawn(options.executable, [`chrome-extension://${extensionId}/`, '--pod-data-dir', options.dataDir],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stdin.on('error', () => {}); this.child.stderr.on('data', () => { this.diagnostic = true; });
    this.closed = new Promise(resolve => { this.child.once('error', () => resolve(null)); this.child.once('close', resolve); });
    this.output = this.child.stdout[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  }
  async call(operation: string, args: Record<string, unknown> = {}, accepted = true): Promise<unknown> {
    const id = randomUUID(); const body = Buffer.from(JSON.stringify({ version: 1, id, operation, ...args })); const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
    await new Promise<void>((resolve, reject) => this.child.stdin.write(Buffer.concat([header, body]), error => error ? reject(new Error('The packaged native sign-in host could not receive a request.')) : resolve()));
    const reply = object(await bounded(this.response(), 'native response'));
    this.inspect(reply);
    insist(reply['version'] === 1 && reply['id'] === id && reply['ok'] === accepted
      && sameKeys(reply, accepted ? ['version', 'id', 'ok', 'value'] : ['version', 'id', 'ok', 'error']), 'native response authority');
    return accepted ? reply['value'] : reply;
  }
  private async response(): Promise<unknown> {
    for (;;) {
      if (this.buffered.length >= 4) {
        const length = this.buffered.readUInt32LE(0); insist(length > 0 && length <= 64 * 1024, 'native frame bounds');
        if (this.buffered.length >= length + 4) {
          const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffered.subarray(4, length + 4)));
          this.buffered = this.buffered.subarray(length + 4); return value;
        }
      }
      const chunk = await this.output.next(); insist(!chunk.done && this.buffered.length + chunk.value.length <= 128 * 1024, 'native frame stream');
      this.buffered = Buffer.concat([this.buffered, chunk.value]);
    }
  }
  async close(): Promise<void> {
    try {
      this.child.stdin.end();
      await bounded((async () => {
        insist(this.buffered.length === 0, 'unsolicited native response');
        for (;;) { const next = await this.output.next(); if (next.done) break; insist(next.value.length === 0, 'unsolicited native output'); }
        insist(await this.closed === 0 && !this.diagnostic, 'native shutdown');
      })(), 'native shutdown');
    } finally { if (this.child.exitCode === null && !this.child.killed) this.child.kill(); }
  }
}

interface Ceremony { readonly context: LocalIdentityContext; readonly state: string; readonly redirect: string }
export function createIdentitySmoke(): { readonly fetch: typeof fetch; readonly verify: (options: IdentitySmokeOptions) => Promise<void> } {
  const handoffs = new Map<string, Ceremony>(); const completions = new Map<string, Ceremony>(); const privateValues = new Set<string>();
  let expectedDid: string | undefined; let proofs = 0;
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    insist(request.method === 'POST' && [relay + '/oauth/local-identity/context', relay + '/oauth/verify'].includes(request.url), 'isolated relay route');
    const body = object(JSON.parse(await request.text()));
    if (request.url.endsWith('/context')) {
      insist(sameKeys(body, ['handoffCode']) && typeof body['handoffCode'] === 'string', 'handoff request');
      const ceremony = handoffs.get(body['handoffCode']); insist(ceremony, 'one-time handoff'); handoffs.delete(body['handoffCode']);
      completions.set(ceremony.context.completionCode, ceremony); return Response.json(ceremony.context);
    }
    insist(sameKeys(body, ['pending_id', 'method', 'did', 'nonce', 'signature', 'native_handoff']) && body['method'] === 'did'
      && body['did'] === expectedDid && typeof body['signature'] === 'string' && typeof body['native_handoff'] === 'string', 'native proof shape');
    const ceremony = completions.get(body['native_handoff']); insist(ceremony, 'one-time native completion'); completions.delete(body['native_handoff']);
    insist(body['pending_id'] === ceremony.context.pendingId && body['nonce'] === ceremony.context.nonce, 'native proof ceremony');
    const signature = Buffer.from(body['signature'], 'base64url');
    insist(signature.length === 64 && signature.toString('base64url') === body['signature'] && expectedDid
      && verifySignature(null, Buffer.from(ceremony.context.message), publicKey(expectedDid), signature), 'actual Ed25519 signature');
    privateValues.add(body['signature']); proofs++; return Response.json({ redirect: ceremony.redirect });
  };
  function ceremony() {
    const nonce = opaque(); const state = opaque(); const completionCode = `interego-login-result:v1:${opaque()}.${opaque()}`;
    const context: LocalIdentityContext = { version: 1, issuer: relay, identityOrigin: provider, pendingId: randomBytes(16).toString('hex'),
      clientId: 'packaged-hosted-app', clientName: 'Packaged hosted app verification', redirectUri: callback, scopes: ['mcp:read'], resource: relay + '/mcp',
      codeChallenge: opaque(), stateDigest: hash(state), expiresAt: new Date(Date.now() + 120_000).toISOString(), nonce,
      message: `Interego DID sign-in v1\nHost: identity.interego.xwisee.com\nNonce: ${nonce}`, challengeExpiresAt: new Date(Date.now() + 300_000).toISOString(), completionCode };
    const handoffCode = `interego-login:v1:${opaque()}.${opaque()}`; const redirect = callback + '&code=' + opaque() + '&state=' + state;
    handoffs.set(handoffCode, { context, state, redirect }); privateValues.add(nonce); privateValues.add(completionCode);
    return { handoffCode, redirect };
  }
  function privateReply(value: unknown): void {
    const text = JSON.stringify(value);
    insist(!/"(?:privateKey|signature|native_handoff|nonce|completionCode)"|MC4CAQAwBQYDK2VwBCIEI/.test(text)
      && ![...privateValues].some(secret => text.includes(secret)), 'native credential privacy');
  }
  return { fetch: transport, verify: async options => {
    insist(isAbsolute(options.executable) && isAbsolute(options.dataDir), 'packaged paths');
    const journal = join(options.dataDir, 'smoke-local-identity.json'); const ports: NativePort[] = [];
    try {
      let status = await options.invoke<LocalIdentityStatus>('localIdentityStatus');
      insist(status.configured === options.expectPrevious && status.pending.length === 0, 'retained identity setup');
      if (!options.expectPrevious) status = await options.invoke<LocalIdentityStatus>('setupLocalIdentity');
      insist(status.configured && status.identity, 'native identity setup'); expectedDid = status.identity.did; publicKey(expectedDid);
      if (options.expectPrevious) {
        const stat = await lstat(journal); insist(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096, 'retained identity journal');
        const previous = object(JSON.parse(await readFile(journal, 'utf8')));
        insist(sameKeys(previous, ['version', 'did']) && previous['version'] === 1 && previous['did'] === expectedDid, 'retained identity credential');
      } else await writeFile(journal, JSON.stringify({ version: 1, did: expectedDid }), { flag: 'wx', mode: 0o600 });
      await options.allow([extensionId]); const native = new NativePort(options, privateReply); ports.push(native); const first = ceremony();
      const ticket = object(await native.call('start', { relayOrigin: relay, handoffCode: first.handoffCode })) as unknown as LocalIdentityTicket;
      insist(sameKeys(ticket as unknown as Record<string, unknown>, ['id', 'receipt', 'verificationCode', 'expiresAt']), 'native ticket shape'); privateReply(ticket);
      const pending = await options.invoke<LocalIdentityStatus>('localIdentityStatus'); const approval = pending.pending.find(row => row.id === ticket.id);
      insist(approval && pending.pending.length === 1 && approval.verificationCode === ticket.verificationCode && approval.relayOrigin === relay
        && approval.identityOrigin === provider && approval.clientId === 'packaged-hosted-app' && approval.redirectUri === callback
        && approval.scopes.join(',') === 'mcp:read' && approval.resource === relay + '/mcp', 'native owner consent'); privateReply(pending);
      const receipt = { requestId: ticket.id, receipt: ticket.receipt };
      const waiting = await native.call('poll', receipt); insist(object(waiting)['state'] === 'waiting', 'unapproved request'); privateReply(waiting);
      await native.call('approve', { requestId: ticket.id, verificationCode: ticket.verificationCode }, false);
      const before = proofs; await options.approve(ticket.id, ticket.verificationCode);
      const complete = await native.call('poll', receipt); insist(proofs === before + 1 && object(complete)['state'] === 'complete'
        && object(complete)['redirect'] === first.redirect, 'native OAuth completion'); privateReply(complete);
      const consumed = await native.call('poll', receipt); insist(object(consumed)['state'] === 'expired' && proofs === before + 1, 'one-time callback'); privateReply(consumed);
      const second = ceremony(); const denied = object(await native.call('start', { relayOrigin: relay, handoffCode: second.handoffCode })) as unknown as LocalIdentityTicket;
      await options.invoke<LocalIdentityStatus>('denyLocalIdentity', denied.id);
      const refusal = await native.call('poll', { requestId: denied.id, receipt: denied.receipt });
      insist(object(refusal)['state'] === 'denied' && proofs === before + 1, 'native denial'); privateReply(refusal);
      const final = await options.invoke<LocalIdentityStatus>('localIdentityStatus'); insist(final.identity?.did === expectedDid && final.pending.length === 0, 'retained private credential');
    } finally {
      try { for (const port of ports) await port.close(); }
      finally { await options.allow([]); handoffs.clear(); completions.clear(); privateValues.clear(); }
    }
  } };
}
