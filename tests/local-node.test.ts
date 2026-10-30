/**
 * The local profile uses the built runtime and a real file-backed Solid server.
 * Socket observation fails closed before any non-loopback TCP connection is made;
 * neither persistence nor the publisher/discovery calls are replaced by fixtures.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { Socket, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  ContextDescriptor, generateKeyPair, openEncryptedEnvelope,
  type EncryptedEnvelope, type IRI,
} from '@interego/core';
import { resolveDeploymentConfig } from '@interego/deployment-config';
import { startLocalNode, type LocalNode } from '@interego/local-node';
import { discover, publish, type FetchFn } from '@interego/solid';

const STARTUP_MS = 120_000;

interface ConnectionAttempt {
  readonly transport: 'ipc' | 'tcp';
  readonly host: string;
}

/** Observe Node TCP clients as well as fetch; allow CSS's private IPC socket. */
function loopbackConnectionsOnly() {
  const attempts: ConnectionAttempt[] = [];
  const denied: string[] = [];
  const original = Socket.prototype.connect;
  const guard = vi.spyOn(Socket.prototype, 'connect');
  guard.mockImplementation(function (this: Socket, ...args: unknown[]): Socket {
    const first: unknown = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (typeof first === 'string') {
      attempts.push({ transport: 'ipc', host: first });
    } else {
      const options = typeof first === 'object' && first !== null
        ? first as { path?: unknown; host?: unknown; hostname?: unknown }
        : undefined;
      if (typeof options?.path === 'string') {
        attempts.push({ transport: 'ipc', host: options.path });
      } else {
        const host = String(options?.host ?? options?.hostname
          ?? (typeof args[1] === 'string' ? args[1] : 'localhost'));
        attempts.push({ transport: 'tcp', host });
        if (!['127.0.0.1', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1'].includes(host)) {
          denied.push(host);
          throw new Error('The offline local-node test refused a non-loopback connection.');
        }
      }
    }
    return Reflect.apply(original, this, args) as Socket;
  } as typeof Socket.prototype.connect);
  return { attempts, denied, restore: () => guard.mockRestore() };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => { server.off('error', fail); done(); });
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((done, fail) => {
    server.close(error => error ? fail(error) : done());
  });
}

/** Node's HTTP client lets the test send an exact Host header. */
async function rawRequest(url: string, headers: Record<string, string>): Promise<number> {
  return new Promise<number>((done, fail) => {
    const pending = request(url, { headers }, response => {
      const status = response.statusCode ?? 0;
      response.resume();
      response.once('end', () => done(status));
    });
    pending.once('error', fail);
    pending.end();
  });
}

describe('a real local pod, with outbound connections denied', () => {
  let fixtureDir: string;
  let node: LocalNode | undefined;
  let network: ReturnType<typeof loopbackConnectionsOnly> | undefined;

  const current = (): LocalNode => {
    if (!node) throw new Error('The local-node fixture did not start.');
    return node;
  };

  beforeAll(async () => {
    fixtureDir = await mkdtemp(join(tmpdir(), 'interego-local-node-'));
    network = loopbackConnectionsOnly();
    node = await startLocalNode(resolveDeploymentConfig({
      profile: 'local', dataDir: join(fixtureDir, 'persistent'),
    }), { port: 0, startupTimeoutMs: STARTUP_MS });
  }, STARTUP_MS + 30_000);

  afterAll(async () => {
    try { await node?.stop(); }
    finally {
      network?.restore();
      // Only remove this test's own newly created temporary directory.
      if (fixtureDir && dirname(resolve(fixtureDir)) === resolve(tmpdir())
        && basename(fixtureDir).startsWith('interego-local-node-')) {
        await rm(fixtureDir, { recursive: true, force: true });
      }
    }
  }, STARTUP_MS);

  it('publishes, discovers, restarts, and decrypts the exact persisted bytes without cloud access', async () => {
    const owner = generateKeyPair();
    const stranger = generateKeyPair();
    const graphIri = 'urn:graph:offline-local-node' as IRI;
    const descriptor = ContextDescriptor.create('urn:iep:offline-local-node' as IRI)
      .describes(graphIri)
      .selfAsserted('urn:owner:local-test' as IRI)
      .build();
    const plaintext = '<urn:local:decision> <urn:local:body> "Only this computer holds the original." .';
    const first = current();
    // CSS deliberately rejects updates to existing containers via PUT. Owner
    // metadata is an ordinary RDF document; PATCH is unavailable in this profile.
    const ownerMetadataUrl = new URL('owner-metadata.ttl', first.podUrl).href;
    const ownerMetadata = await first.fetch(ownerMetadataUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: `<${first.podUrl}> <urn:local:ownerNote> "Owner metadata survives restart." .`,
    });
    expect(ownerMetadata.ok, `Owner metadata save returned ${ownerMetadata.status}: ${await ownerMetadata.text()}`).toBe(true);
    const published = await publish(descriptor, plaintext, first.podUrl, {
      fetch: first.fetch as FetchFn,
      encrypt: { recipients: [owner.publicKey], senderKeyPair: owner },
      visibility: 'private',
    });
    expect(published.encrypted).toBe(true);
    const entries = await discover(first.podUrl, undefined, { fetch: first.fetch as FetchFn });
    expect(entries.some(entry => entry.descriptorUrl === published.descriptorUrl
      && entry.describes.includes(graphIri))).toBe(true);
    const ownerMetadataBefore = await first.fetch(ownerMetadataUrl, { headers: { Accept: 'text/turtle' } });
    expect(ownerMetadataBefore.status).toBe(200);
    const beforeOwnerMetadata = Buffer.from(await ownerMetadataBefore.arrayBuffer());
    expect(beforeOwnerMetadata.toString('utf8')).toContain('Owner metadata survives restart.');
    const rootBefore = await first.fetch(first.podUrl, { method: 'HEAD', headers: { Accept: 'text/turtle' } });
    expect(rootBefore.status).toBe(200);
    const beforeRootEtag = rootBefore.headers.get('etag');
    expect(beforeRootEtag).not.toBeNull();

    const descriptorResponse = await first.fetch(published.descriptorUrl, { headers: { Accept: 'text/turtle' } });
    expect(descriptorResponse.status).toBe(200);
    const beforeDescriptor = Buffer.from(await descriptorResponse.arrayBuffer());
    const envelopeResponse = await first.fetch(published.graphUrl);
    expect(envelopeResponse.status).toBe(200);
    const beforeEnvelope = Buffer.from(await envelopeResponse.arrayBuffer());
    expect((await fetch(published.graphUrl)).status).toBe(401);
    expect(beforeEnvelope.toString('utf8')).not.toContain('Only this computer holds the original.');
    const sealed = JSON.parse(beforeEnvelope.toString('utf8')) as EncryptedEnvelope;
    const opened = openEncryptedEnvelope(sealed, owner);
    expect(opened).toContain(plaintext);
    expect(openEncryptedEnvelope(sealed, stranger)).toBeNull();

    const baseUrl = first.baseUrl;
    await first.stop();
    await first.stop();
    node = undefined;
    await expect(first.fetch(published.descriptorUrl)).rejects.toThrow(/stopped/i);
    node = await startLocalNode(resolveDeploymentConfig({
      profile: 'local', dataDir: join(fixtureDir, 'persistent'), baseUrl,
    }), { startupTimeoutMs: STARTUP_MS });

    expect(current().podUrl).toBe(first.podUrl);
    const rootAfter = await current().fetch(current().podUrl, { method: 'HEAD', headers: { Accept: 'text/turtle' } });
    expect(rootAfter.status).toBe(200);
    expect(rootAfter.headers.get('etag')).toBe(beforeRootEtag);
    const recoveredOwnerMetadata = await current().fetch(ownerMetadataUrl, { headers: { Accept: 'text/turtle' } });
    expect(recoveredOwnerMetadata.status).toBe(200);
    expect(Buffer.from(await recoveredOwnerMetadata.arrayBuffer())).toEqual(beforeOwnerMetadata);
    const afterDescriptor = await current().fetch(published.descriptorUrl, { headers: { Accept: 'text/turtle' } });
    expect(afterDescriptor.status).toBe(200);
    expect(Buffer.from(await afterDescriptor.arrayBuffer())).toEqual(beforeDescriptor);
    const afterEnvelope = await current().fetch(published.graphUrl);
    expect(afterEnvelope.status).toBe(200);
    const persistedEnvelope = Buffer.from(await afterEnvelope.arrayBuffer());
    expect(persistedEnvelope).toEqual(beforeEnvelope);
    expect(openEncryptedEnvelope(JSON.parse(persistedEnvelope.toString('utf8')) as EncryptedEnvelope, owner)).toBe(opened);
    const recovered = await discover(current().podUrl, undefined, { fetch: current().fetch as FetchFn });
    expect(recovered.some(entry => entry.descriptorUrl === published.descriptorUrl)).toBe(true);
    expect(network?.denied).toEqual([]);
    expect(network?.attempts.some(attempt => attempt.transport === 'tcp')).toBe(true);
    expect(network?.attempts.some(attempt => attempt.transport === 'ipc')).toBe(true);
  }, STARTUP_MS + 60_000);

  it('requires authorization for reads and writes', async () => {
    const pod = current();
    expect((await fetch(pod.podUrl)).status).toBe(401);
    const forbiddenWrite = new URL('unauthed.txt', pod.podUrl).href;
    expect((await fetch(forbiddenWrite, { method: 'PUT', body: 'This must never be stored.' })).status).toBe(401);
    expect((await fetch(pod.podUrl, { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await pod.fetch(forbiddenWrite)).status).toBe(404);
  });

  it('refuses foreign browser origins and Host headers even with the correct credential', async () => {
    const pod = current();
    const credential = (await readFile(join(fixtureDir, 'persistent', 'service-credential'), 'utf8')).trim();
    expect(await rawRequest(pod.podUrl, {
      Authorization: `Bearer ${credential}`, Origin: 'https://foreign.example',
    })).toBe(403);
    expect(await rawRequest(pod.podUrl, {
      Authorization: `Bearer ${credential}`, Host: 'foreign.example',
    })).toBe(403);
    expect((await pod.fetch(pod.podUrl)).status).toBe(200);
  });

  it('keeps the active data directory locked and leaves the running pod usable', async () => {
    await expect(startLocalNode(resolveDeploymentConfig({
      profile: 'local', dataDir: join(fixtureDir, 'persistent'),
    }), { port: 0, startupTimeoutMs: STARTUP_MS })).rejects.toThrow(/locked/i);
    expect((await current().fetch(current().podUrl)).status).toBe(200);
  });

  it('refuses remote-loading JSON-LD and PATCH before either can contact another host', async () => {
    const pod = current();
    const resource = new URL('egress-boundary.ttl', pod.podUrl).href;
    const original = '<urn:local:egress> <urn:local:body> "The original stays intact." .';
    expect((await pod.fetch(resource, {
      method: 'PUT', headers: { 'Content-Type': 'text/turtle' }, body: original,
    })).ok).toBe(true);

    const jsonLd = await pod.fetch(resource, {
      method: 'PUT', headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify({
        '@context': 'https://example.invalid/context.jsonld',
        '@id': 'urn:local:egress', body: 'An external context must not be loaded.',
      }),
    });
    expect(jsonLd.status).toBe(415);
    const disguisedJsonLd = await pod.fetch(resource, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ '@context': 'https://example.invalid/context.jsonld', '@id': 'urn:local:egress' }),
    });
    expect(disguisedJsonLd.status).toBe(415);
    const patch = await pod.fetch(resource, {
      method: 'PATCH', headers: { 'Content-Type': 'application/sparql-update' },
      body: 'LOAD <https://example.invalid/remote.ttl> INTO GRAPH <urn:local:external>',
    });
    expect(patch.status).toBe(405);
    const conversion = await pod.fetch(resource, {
      headers: { Accept: 'application/ld+json; profile="https://example.invalid/context.jsonld"' },
    });
    expect(conversion.status).toBe(406);
    expect((await pod.fetch(resource, { headers: { Accept: 'application/json' } })).status).toBe(406);

    const retained = await pod.fetch(resource, { headers: { Accept: 'text/turtle' } });
    expect(retained.status).toBe(200);
    expect(await retained.text()).toContain('The original stays intact.');
    expect(network?.denied).toEqual([]);
  });

  it('never gives credentials to another origin and forces redirects to fail', async () => {
    let foreignRequests = 0;
    const foreign = createServer((_request, response) => { foreignRequests++; response.end('unexpected'); });
    const foreignPort = await listen(foreign);
    try {
      await expect(current().fetch(`http://127.0.0.1:${foreignPort}/`, { redirect: 'follow' }))
        .rejects.toThrow(/another origin/i);
      expect(foreignRequests).toBe(0);

      const originalFetch = globalThis.fetch;
      const outgoing: Request[] = [];
      const observing = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
        const outgoingRequest = new Request(input, init);
        outgoing.push(outgoingRequest);
        return originalFetch(outgoingRequest);
      });
      try {
        expect((await current().fetch(current().podUrl, { redirect: 'follow' })).status).toBe(200);
        expect(outgoing).toHaveLength(1);
        expect(outgoing[0]!.redirect).toBe('error');
        expect(outgoing[0]!.headers.has('authorization')).toBe(true);
      } finally { observing.mockRestore(); }
    } finally { await close(foreign); }
  });

  it('cleans up a failed listener so the same data directory can start successfully', async () => {
    const occupied = createServer();
    const port = await listen(occupied);
    const dataDir = join(fixtureDir, 'failed-bind');
    const config = resolveDeploymentConfig({ profile: 'local', dataDir, baseUrl: `http://127.0.0.1:${port}/` });
    let accidental: LocalNode | undefined;
    try {
      await expect(startLocalNode(config, { startupTimeoutMs: STARTUP_MS }).then(started => {
        accidental = started;
        return started;
      })).rejects.toThrow(/EADDRINUSE|address.*use|listen/i);
      await expect(stat(join(dataDir, 'runtime.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await accidental?.stop();
      await close(occupied);
    }
    const recovered = await startLocalNode(config, { startupTimeoutMs: STARTUP_MS });
    try { expect((await recovered.fetch(recovered.podUrl)).status).toBe(200); }
    finally { await recovered.stop(); }
    expect(network?.denied).toEqual([]);
  }, STARTUP_MS + 30_000);

  it('refuses unsupported federation before creating local state', async () => {
    const dataDir = join(fixtureDir, 'federation-refused');
    await expect(startLocalNode(resolveDeploymentConfig({
      profile: 'local', dataDir, federation: { enabled: true },
    }), { startupTimeoutMs: STARTUP_MS })).rejects.toThrow(/federation/i);
    await expect(stat(dataDir)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
