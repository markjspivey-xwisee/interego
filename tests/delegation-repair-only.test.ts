import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Wallet } from 'ethers';
import { describe, expect, it } from 'vitest';
import {
  canonicalCredentialPayload, createSignedDelegationCredential, makeWalletDelegationVerifier, ownerProfileToTurtle, parseDelegationCredential,
  type AuthorizedAgentData, type DelegationSigner, type IRI, type OwnerProfileData,
} from '../packages/core/src/index.js';
import { CodecRegistry, InMemoryFdb, LdpStore, NativeResourceManagedError, openStore } from '../packages/pgsl-store/src/index.js';
import { repairOnlySessionDelegation, writeRegistrationDelegationCredential,
  type DelegationRepairOptions } from '../deploy/mcp-relay/delegation-repair-only.js';
import { createEgress } from '../deploy/mcp-relay/egress.js';

const identity = 'https://identity.example';
const agent = 'did:web:identity.example:agents:session-alice' as IRI;
const owner = 'https://identity.example/users/alice/profile#me' as IRI;
const credentialType = 'application/ld+json';
const nativeType = 'application/vnd.interego.native-commit+json';
const encoder = new TextEncoder();
const nativeEtag = (revision: string) => '"' + revision + '-' + createHash('sha256').update(credentialType).digest('hex').slice(0, 16) + '"';

interface FixtureOptions {
  profile?: OwnerProfileData;
  registry?: (read: number, profile: OwnerProfileData) => OwnerProfileData | null;
  credentialStatus?: number;
  native?: boolean;
  loseAcknowledgement?: boolean;
  raceBody?: Uint8Array;
  putRevisionHeader?: string;
  readRevisionOverride?: string;
  changeReceipt?: (receipt: Record<string, unknown>) => Record<string, unknown>;
}

async function fixture(settings: FixtureOptions = {}) {
  // The supplied authentication context is a unit seam. All credential HTTP
  // requests, byte storage, create-only CAS and ECDSA signatures are real.
  const wallet = Wallet.createRandom(), verifier = makeWalletDelegationVerifier();
  const signer: DelegationSigner = async payload => ({ signature: await wallet.signMessage(payload),
    signerAddress: wallet.address, verificationMethod: `did:ethr:${wallet.address}` as IRI });
  const row: AuthorizedAgentData = { agentId: agent, delegatedBy: owner, scope: 'ReadWrite',
    validFrom: new Date(Date.now() - 60_000).toISOString(), validUntil: new Date(Date.now() + 3_600_000).toISOString(),
    label: 'Existing session', isSoftwareAgent: true, encryptionPublicKey: 'A'.repeat(43) + '=' };
  const profile = settings.profile ?? { webId: owner, authorizedAgents: [row] };
  let currentProfile = profile, raceBody = settings.raceBody, loseAcknowledgement = settings.loseAcknowledgement;
  let readRevisionOverride = settings.readRevisionOverride;
  let beforeNextNativePut: (() => void) | undefined;
  const backing = new InMemoryFdb(), ldp = new LdpStore(openStore(backing), new CodecRegistry());
  const requests: { method: string; path: string; headers: Record<string, string | string[] | undefined> }[] = [];
  let podUrl = '', credentialUrl = '', registryReads = 0, handlerFailure: unknown;
  const server = createServer((request, response) => {
    void (async () => {
      const method = request.method ?? 'GET', path = request.url ?? '';
      requests.push({ method, path, headers: request.headers });
      expect(request.headers['cache-control']).toBe('no-cache');
      if (path === '/alice/agents' && method === 'GET') {
        const selected = settings.registry ? settings.registry(++registryReads, currentProfile) : (++registryReads, currentProfile);
        response.writeHead(selected ? 200 : 404, { 'Content-Type': 'text/turtle' });
        response.end(selected ? ownerProfileToTurtle(selected) : ''); return;
      }
      expect(path).toBe('/alice/credentials/' + encodeURIComponent(agent) + '.jsonld');
      if (method === 'OPTIONS') {
        response.writeHead(204, settings.native === false ? {} : {
          'Interego-Native-Commit': '1', 'Accept-Put': nativeType,
        }); response.end(); return;
      }
      if (method === 'PUT') {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const wireBody = Buffer.concat(chunks);
        if (request.headers['content-type'] === credentialType) {
          try { await ldp.writeResource('css', credentialUrl, wireBody, credentialType); }
          catch (error) {
            if (!(error instanceof NativeResourceManagedError)) throw error;
            response.writeHead(409); response.end('native conditional commit required'); return;
          }
          response.writeHead(201); response.end(); return;
        }
        expect(request.headers['content-type']).toBe(nativeType);
        const command = JSON.parse(wireBody.toString('utf8')) as {
          version: number; expectedRevision: string | null; contentType: string; bodyBase64: string;
        };
        expect(command.version).toBe(1);
        if (command.expectedRevision === null) {
          expect(request.headers['if-none-match']).toBe('*'); expect(request.headers['if-match']).toBeUndefined();
        } else {
          expect(request.headers['if-match']).toBe(nativeEtag(command.expectedRevision)); expect(request.headers['if-none-match']).toBeUndefined();
        }
        expect(command.contentType).toBe(credentialType);
        const beforePut = beforeNextNativePut; beforeNextNativePut = undefined; beforePut?.();
        if (raceBody) {
          const head = await ldp.readResource('css', credentialUrl);
          await ldp.commitResource('css', credentialUrl, raceBody, credentialType, { expectedRevision: head?.revision ?? null });
        }
        const result = await ldp.commitResource('css', credentialUrl, new Uint8Array(Buffer.from(command.bodyBase64, 'base64')),
          command.contentType, { expectedRevision: command.expectedRevision });
        if (result.status === 'conflict') { response.writeHead(412); response.end(); return; }
        if (loseAcknowledgement) { response.destroy(); return; }
        const receipt = { ...result, version: 1, resource: credentialUrl, expectedRevision: command.expectedRevision };
        response.writeHead(200, { 'Content-Type': 'application/json', ETag: nativeEtag(result.revision),
          ...(settings.putRevisionHeader ? { 'Interego-Revision': settings.putRevisionHeader } : {}) });
        response.end(JSON.stringify(settings.changeReceipt ? settings.changeReceipt(receipt) : receipt)); return;
      }
      expect(method).toBe('GET');
      if (settings.credentialStatus !== undefined) {
        response.writeHead(settings.credentialStatus, { 'Content-Type': credentialType }); response.end('untrusted existing bytes'); return;
      }
      const result = await ldp.readResource('css', credentialUrl);
      if (!result) { response.writeHead(404); response.end(); return; }
      response.writeHead(200, { 'Content-Type': result.contentType,
        ...(settings.native === false ? { ETag: '"legacy-fixture"' } : { 'Interego-Revision': readRevisionOverride ?? result.revision,
          'Interego-Body-Digest': result.bodyDigest, ETag: nativeEtag(result.revision) }) });
      response.end(result.bytes);
    })().catch(error => { handlerFailure = error; response.writeHead(500); response.end('fixture handler failed'); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('loopback address unavailable');
  podUrl = `http://127.0.0.1:${address.port}/alice/`;
  credentialUrl = podUrl + 'credentials/' + encodeURIComponent(agent) + '.jsonld';
  const egress = createEgress({ cssUrl: podUrl, publicBaseUrl: '', screenAddresses: true });
  const args: Record<string, unknown> = { repair_only: true, agent_id: agent, pod_name: 'alice', owner_webid: owner,
    _session_agent_did: agent, _session_user_id: 'alice', _session_principal: owner, _session_owner_webid: owner };
  let signerCalls = 0;
  const options: DelegationRepairOptions = { podUrl, ownPodUrl: podUrl, identityBaseUrl: identity,
    canonicalPodKey: url => new URL(url).href, fetch: egress.solidFetch,
    getSigner: async () => { signerCalls += 1; return signer; }, verifier };
  return { args, options, profile, row, requests, credentialUrl, verifier, ldp,
    setProfile(value: OwnerProfileData) { currentProfile = value; },
    setBeforeNativePut(callback: () => void) { beforeNextNativePut = callback; },
    setReadRevisionOverride(value: string) { readRevisionOverride = value; },
    setNativeFault(value: { raceBody?: Uint8Array; loseAcknowledgement?: boolean }) {
      raceBody = value.raceBody; loseAcknowledgement = value.loseAcknowledgement;
    },
    signerCalls: () => signerCalls, registryReads: () => registryReads,
    puts: () => requests.filter(request => request.method === 'PUT'),
    stored: () => ldp.readResource('css', credentialUrl),
    async close() {
      server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await egress.close();
      await backing.close(); if (handlerFailure) throw handlerFailure;
    } };
}

async function registration(f: Awaited<ReturnType<typeof fixture>>, scope: AuthorizedAgentData['scope'] = 'DiscoverOnly',
  changes: Partial<AuthorizedAgentData> = {}) {
  const row: AuthorizedAgentData = { ...f.row, scope, ...changes };
  const profile: OwnerProfileData = { ...f.profile, authorizedAgents: [row] };
  f.setProfile(profile);
  const credential = await createSignedDelegationCredential(profile, row, f.options.podUrl as IRI, await f.options.getSigner());
  return { row, profile, credential, options: { fetch: f.options.fetch, verifier: f.verifier, profile, agent: row } };
}

describe('missing-only same-session delegation repair', () => {
  it.each([true, false])('accepts server-injected native lifecycle metadata %s without changing the existing grant', async nativeLifecycle => {
    const f = await fixture();
    try {
      const before = ownerProfileToTurtle(f.profile);
      const result = await repairOnlySessionDelegation({ ...f.args, _session_native_lifecycle: nativeLifecycle }, f.options);
      expect(result).toMatchObject({ registered: false, repaired: true, repair_only: true,
        agent, scope: f.row.scope, credential: f.credentialUrl });
      expect(f.puts()).toHaveLength(1);
      expect(f.puts()[0]?.path).toBe('/alice/credentials/' + encodeURIComponent(agent) + '.jsonld');
      const registry = await f.options.fetch(f.options.podUrl + 'agents', { headers: { 'Cache-Control': 'no-cache' } });
      expect(await registry.text()).toBe(before);
      const stored = await f.stored();
      const credential = parseDelegationCredential(new TextDecoder().decode(stored!.bytes));
      expect(credential.credentialSubject).toEqual({ id: agent, delegatedBy: owner,
        scope: ['publish', 'discover', 'subscribe'], pod: f.options.podUrl });
      expect(await f.verifier(canonicalCredentialPayload(credential), credential.proof!)).toBe(true);
    } finally { await f.close(); }
  });

  it('creates only the encoded missing VC through actual HTTP/native CAS and verifies the real ECDSA chain', async () => {
    const f = await fixture();
    try {
      const result = await repairOnlySessionDelegation(f.args, f.options);
      expect(result).toMatchObject({ registered: false, repaired: true, repair_only: true, agent, scope: 'ReadWrite', credential: f.credentialUrl });
      expect(f.puts()).toHaveLength(1); expect(f.registryReads()).toBeGreaterThanOrEqual(4);
      const stored = await f.stored(); expect(stored?.contentType).toBe(credentialType);
      const credential = parseDelegationCredential(new TextDecoder().decode(stored!.bytes));
      expect(credential.id).toBe(f.credentialUrl); expect(credential.issuer).toBe(owner);
      expect(credential.credentialSubject).toEqual({ id: agent, delegatedBy: owner, scope: ['publish', 'discover', 'subscribe'], pod: f.options.podUrl });
      expect(credential.expirationDate).toBe(f.row.validUntil);
      expect(credential.proof).toBeDefined();
      expect(await f.verifier(canonicalCredentialPayload(credential), credential.proof!)).toBe(true);
      const retry = await repairOnlySessionDelegation(f.args, f.options);
      expect(retry).toMatchObject({ error: 'delegation_repair_not_missing', repaired: false, dispatched: false });
      expect(f.puts()).toHaveLength(1);
    } finally { await f.close(); }
  });

  it('refuses identity, owner, scope, key, label and governance mutations before any write', async () => {
    const f = await fixture();
    try {
      const changes: Record<string, unknown>[] = [
        { agent_id: 'did:web:identity.example:agents:another' }, { _session_agent_did: undefined },
        { _session_owner_webid: undefined }, { _session_owner_webid: 'https://identity.example/users/bob/profile#me' },
        { owner_webid: 'https://identity.example/users/bob/profile#me' }, { pod_url: 'https://foreign.example/alice/' }, { pod_name: 'bob' },
        { scope: 'ReadWrite' }, { scope: null }, { tenant_admin: false }, { encryption_public_key: null },
        { label: 'changed' }, { owner_name: 'changed' }, { unknown_permission: true }, { repair_only: false }, { repair_only: 'true' },
      ];
      for (const nativeLifecycle of [true, false]) for (const change of changes) {
        const result = await repairOnlySessionDelegation({ ...f.args, _session_native_lifecycle: nativeLifecycle, ...change }, f.options);
        expect(result).toMatchObject({ repaired: false, dispatched: false }); expect(result.error).toBeTypeOf('string');
      }
      for (const ownPodUrl of [undefined, 'https://foreign.example/alice/']) {
        expect(await repairOnlySessionDelegation(f.args, { ...f.options, ownPodUrl })).toMatchObject({ repaired: false, dispatched: false });
      }
      expect(f.puts()).toHaveLength(0); expect(f.signerCalls()).toBe(0);
    } finally { await f.close(); }
  });

  it('cannot turn a foreign owner named by editable own-pod metadata into a relay-issued delegation', async () => {
    const otherOwner = 'https://identity.example/users/bob/profile#me' as IRI;
    const f = await fixture({ profile: { webId: otherOwner, authorizedAgents: [{
      agentId: agent, delegatedBy: otherOwner, scope: 'ReadWrite', validFrom: new Date(Date.now() - 60_000).toISOString(),
    }] } });
    try {
      expect(await repairOnlySessionDelegation({ ...f.args, owner_webid: otherOwner }, f.options))
        .toMatchObject({ repaired: false, dispatched: false });
      expect(f.puts()).toHaveLength(0); expect(f.signerCalls()).toBe(0);
    } finally { await f.close(); }
  });

  it('requires a currently active preexisting write grant and preserves PublishOnly exactly', async () => {
    const base = await fixture(), template = base.row; await base.close();
    const rows: AuthorizedAgentData[][] = [[], [template, template], [{ ...template, scope: 'ReadOnly' }], [{ ...template, scope: 'DiscoverOnly' }],
      [{ ...template, revoked: true }], [{ ...template, validFrom: new Date(Date.now() + 60_000).toISOString() }],
      [{ ...template, validUntil: new Date(Date.now() - 60_000).toISOString() }]];
    for (const authorizedAgents of rows) {
      const f = await fixture({ profile: { webId: owner, authorizedAgents } });
      try {
        expect(await repairOnlySessionDelegation(f.args, f.options)).toMatchObject({ repaired: false, dispatched: false });
        expect(f.puts()).toHaveLength(0); expect(f.signerCalls()).toBe(0);
      } finally { await f.close(); }
    }
    const f = await fixture({ profile: { webId: owner, authorizedAgents: [{ ...template, scope: 'PublishOnly' }] } });
    try {
      expect(await repairOnlySessionDelegation(f.args, f.options)).toMatchObject({ repaired: true, scope: 'PublishOnly' });
      const stored = await f.stored(); const credential = parseDelegationCredential(new TextDecoder().decode(stored!.bytes));
      expect(credential.credentialSubject.scope).toEqual(['publish']);
    } finally { await f.close(); }
  });

  it('requires a definite raw 404 and advertised native CAS without overwriting or falling back to LDP', async () => {
    for (const settings of [{ credentialStatus: 200 }, { credentialStatus: 403 }, { credentialStatus: 500 }, { native: false }]) {
      const f = await fixture(settings);
      try {
        expect(await repairOnlySessionDelegation(f.args, f.options)).toMatchObject({ repaired: false, dispatched: false });
        expect(f.puts()).toHaveLength(0); expect(f.signerCalls()).toBe(0);
      } finally { await f.close(); }
    }
  });

  it('refuses a changed grant immediately before dispatch and a revoked grant after commit', async () => {
    const mutations: ((row: AuthorizedAgentData) => AuthorizedAgentData)[] = [
      row => ({ ...row, revoked: true }), row => ({ ...row, scope: 'DiscoverOnly' }),
      row => ({ ...row, scope: 'PublishOnly' }), row => ({ ...row, encryptionPublicKey: 'B'.repeat(43) + '=' }),
    ];
    for (const changedAt of [2, 3]) for (const mutate of mutations) {
      const f = await fixture({ registry: (read, profile) => read < changedAt ? profile : {
        ...profile, authorizedAgents: profile.authorizedAgents.map(mutate),
      } });
      try {
        const result = await repairOnlySessionDelegation(f.args, f.options);
        expect(result).toMatchObject({ error: 'delegation_repair_grant_changed', repaired: false, dispatched: changedAt === 3 });
        expect(f.puts()).toHaveLength(changedAt === 3 ? 1 : 0);
        if (changedAt === 3) expect(result.read_confirm_only).toBe(true);
        const current = await f.options.fetch(f.options.podUrl + 'agents', { headers: { 'Cache-Control': 'no-cache' } });
        expect(await current.text()).toBe(ownerProfileToTurtle({ ...f.profile, authorizedAgents: f.profile.authorizedAgents.map(mutate) }));
      } finally { await f.close(); }
    }
  });

  it('preserves a competing creator and treats lost or forged acknowledgements as unconfirmed', async () => {
    const competing = encoder.encode('{"existing":"must remain byte-identical"}');
    const race = await fixture({ raceBody: competing });
    try {
      expect(await repairOnlySessionDelegation(race.args, race.options)).toMatchObject({ error: 'delegation_repair_conflict', repaired: false });
      expect(Uint8Array.from((await race.stored())!.bytes)).toEqual(competing); expect(race.puts()).toHaveLength(1);
    } finally { await race.close(); }
    for (const settings of [{ loseAcknowledgement: true }, { putRevisionHeader: 'sha256:' + '0'.repeat(64) },
      { readRevisionOverride: 'sha256:' + '0'.repeat(64) },
      { changeReceipt: (receipt: Record<string, unknown>) => ({ ...receipt, pod: 'foreign-namespace' }) },
      { changeReceipt: (receipt: Record<string, unknown>) => ({ ...receipt, resource: 'https://foreign.example/credential' }) }]) {
      const f = await fixture(settings);
      try {
        expect(await repairOnlySessionDelegation(f.args, f.options)).toMatchObject({ repaired: false, dispatched: true, read_confirm_only: true });
        expect(f.puts()).toHaveLength(1); expect(await f.stored()).not.toBeNull();
      } finally { await f.close(); }
    }
  });

  it('allows explicit owner re-registration after repair, revoke and regrant while ordinary LDP remains blocked', async () => {
    const f = await fixture();
    try {
      expect(await repairOnlySessionDelegation(f.args, f.options)).toMatchObject({ repaired: true });
      const prior = Uint8Array.from((await f.stored())!.bytes);
      f.setProfile({ ...f.profile, authorizedAgents: [] });
      expect(await repairOnlySessionDelegation(f.args, f.options)).toMatchObject({ repaired: false, dispatched: false });
      const next = await registration(f);
      const ordinary = await f.options.fetch(f.credentialUrl, { method: 'PUT', headers: {
        'Content-Type': credentialType, 'Cache-Control': 'no-cache',
      }, body: JSON.stringify(next.credential) });
      expect(ordinary.status).toBe(409); await ordinary.text();
      expect(Uint8Array.from((await f.stored())!.bytes)).toEqual(prior);
      expect(await writeRegistrationDelegationCredential(next.credential, f.options.podUrl, next.options)).toBe(f.credentialUrl);
      const current = parseDelegationCredential(new TextDecoder().decode((await f.stored())!.bytes));
      expect(current.credentialSubject.scope).toEqual(['discover']);
      expect(await f.verifier(canonicalCredentialPayload(current), current.proof!)).toBe(true);
      const nativeWrites = f.puts().filter(request => request.headers['content-type'] === nativeType);
      expect(nativeWrites).toHaveLength(2); expect(nativeWrites[1]!.headers['if-match']).toMatch(/^"sha256:/);
    } finally { await f.close(); }
  });

  it('keeps initial and fully legacy explicit registration usable', async () => {
    for (const existing of [false, true]) {
      const f = await fixture({ native: false });
      try {
        if (existing) await f.ldp.writeResource('css', f.credentialUrl, encoder.encode('{"legacy":"old"}'), credentialType);
        const next = await registration(f, 'ReadOnly');
        expect(await writeRegistrationDelegationCredential(next.credential, f.options.podUrl, next.options)).toBe(f.credentialUrl);
        expect(f.puts()).toHaveLength(1); expect(f.puts()[0]!.headers['content-type']).toBe(credentialType);
        expect(parseDelegationCredential(new TextDecoder().decode((await f.stored())!.bytes)).credentialSubject.scope).toEqual(['discover', 'subscribe']);
      } finally { await f.close(); }
    }
  });

  it('never retries or falls back to LDP after a native registration conflict, lost ACK or changed readback revision', async () => {
    for (const failure of ['conflict', 'lost-ack', 'readback'] as const) {
      const f = await fixture();
      try {
        expect(await repairOnlySessionDelegation(f.args, f.options)).toMatchObject({ repaired: true });
        const next = await registration(f, 'PublishOnly');
        const competing = encoder.encode('{"competing":"must remain"}');
        if (failure === 'conflict') f.setNativeFault({ raceBody: competing });
        if (failure === 'lost-ack') f.setNativeFault({ loseAcknowledgement: true });
        if (failure === 'readback') f.setBeforeNativePut(() => f.setReadRevisionOverride('sha256:' + '0'.repeat(64)));
        await expect(writeRegistrationDelegationCredential(next.credential, f.options.podUrl, next.options)).rejects.toThrow(/unconfirmed/);
        expect(f.puts()).toHaveLength(2);
        expect(f.puts().every(request => request.headers['content-type'] === nativeType)).toBe(true);
        if (failure === 'conflict') expect(Uint8Array.from((await f.stored())!.bytes)).toEqual(competing);
      } finally { await f.close(); }
    }
  });

  it('does not confirm ordinary registration through expired, future, revoked, narrowed or changed-key grants', async () => {
    const changes: Partial<AuthorizedAgentData>[] = [{ revoked: true }, { scope: 'DiscoverOnly' }, { encryptionPublicKey: 'C'.repeat(43) + '=' }];
    for (const change of changes) {
      const f = await fixture();
      try {
        expect(await repairOnlySessionDelegation(f.args, f.options)).toMatchObject({ repaired: true });
        const next = await registration(f, 'PublishOnly');
        const changed: OwnerProfileData = { ...next.profile, authorizedAgents: [{ ...next.row, ...change }] };
        f.setBeforeNativePut(() => f.setProfile(changed));
        await expect(writeRegistrationDelegationCredential(next.credential, f.options.podUrl, next.options)).rejects.toThrow(/unconfirmed/);
        expect(f.puts()).toHaveLength(2);
        const current = await f.options.fetch(f.options.podUrl + 'agents', { headers: { 'Cache-Control': 'no-cache' } });
        expect(await current.text()).toBe(ownerProfileToTurtle(changed));
      } finally { await f.close(); }
    }
    for (const change of [{ validUntil: new Date(Date.now() - 60_000).toISOString() }, { validFrom: new Date(Date.now() + 60_000).toISOString() }]) {
      const f = await fixture();
      try {
        expect(await repairOnlySessionDelegation(f.args, f.options)).toMatchObject({ repaired: true });
        const next = await registration(f, 'PublishOnly', change);
        await expect(writeRegistrationDelegationCredential(next.credential, f.options.podUrl, next.options)).rejects.toThrow(/safely/);
        expect(f.puts()).toHaveLength(1);
      } finally { await f.close(); }
    }
  });
});
