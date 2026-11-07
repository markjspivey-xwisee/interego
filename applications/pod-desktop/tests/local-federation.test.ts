import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { EncryptionKeyPair, IRI } from '@interego/core';
import { discover, parseDistributionFromDescriptorTurtle, type FetchFn } from '@interego/solid';
import type { LocalNode } from '@interego/local-node';
import { FederationService, ProtectedFederationStore } from '@interego/pod-federation';
import { PodController } from '../src/controller.js';
import { AgentService } from '../src/agent-service.js';
import { BridgeServer } from '../src/bridge-server.js';
import { presentSharedResource } from '../src/federation-notes.js';

describe('two authoritative local pods over the actual HTTP bridge adapter', () => {
  it('pairs with consent, sends only selected encrypted snapshots, resumes off and blocks revoked peers', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'interego-two-pods-'));
    const pods: PodController[] = []; const bridges: BridgeServer[] = []; const brokers: AgentService[] = []; const sharing: FederationService[] = [];
    const routes = new Map<string, string>(); const traffic: string[] = [];
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init); const url = new URL(request.url); const target = routes.get(url.origin);
      if (!target) throw new Error('Unrecognized test endpoint.');
      const body = await request.text(); traffic.push(body);
      return fetch(target + url.pathname, { method: request.method, headers: request.headers, body, redirect: 'error', signal: request.signal });
    };
    const protector = { protect: (value: string) => Buffer.from(value).toString('base64'), unprotect: (value: string) => Buffer.from(value, 'base64').toString() };
    async function local(name: string) {
      let key: EncryptionKeyPair | null = null;
      const controller = new PodController({ dataDir: join(directory, name, 'pod'), vault: { load: async () => key, save: async value => { key = value; } } });
      pods.push(controller); await controller.setup();
      const store = new ProtectedFederationStore({ dataDir: join(directory, name, 'sharing'), protector });
      let service = new FederationService({ store, binding: () => controller.agentPodBinding(), fetch: transport }); sharing.push(service);
      const agents = new AgentService({ dataDir: join(directory, name, 'agents'), protector, getPodBinding: () => controller.agentPodBinding(),
        execute: (operation, args, authorize) => controller.executeAgent(operation, args, authorize) }); brokers.push(agents);
      const bridge = new BridgeServer({ agents, federation: request => service.handle(request) }); bridges.push(bridge);
      const origin = `https://${name}.example.com`;
      const loopback = await bridge.start({ client: 'other-web', name: 'Unused MCP grant policy', permissions: ['notes:read'], expiresInDays: 7 });
      bridge.setPublicUrl(origin); routes.set(origin, loopback);
      await service.configure({ name, endpoint: `${origin}/pod-federation`, kind: 'local' });
      return { controller, service, store, origin, loopback, key: () => key!, restart: () => {
        service = new FederationService({ store, binding: () => controller.agentPodBinding(), fetch: transport }); sharing.push(service); return service;
      } };
    }
    try {
      const alice = await local('alice'); const bob = await local('bob');
      const selected = await alice.controller.saveNote({ title: 'For my brother', body: 'A selected private snapshot, including "quotes" and\na newline.' });
      const privateNote = await alice.controller.saveNote({ title: 'Unshared note', body: 'THIS MUST NEVER LEAVE ALICE.' });
      expect((await fetch(`${alice.loopback}/pod-federation/profile`)).status).toBe(503);
      expect((await alice.service.status()).enabled).toBe(false); expect((await bob.service.status()).enabled).toBe(false);
      await alice.service.setEnabled(true); await bob.service.setEnabled(true);
      const invitation = await alice.service.createInvite(); await bob.service.acceptInvite(invitation.code);
      const pending = (await alice.service.status()).pending[0]!;
      expect((await bob.service.status()).joining[0]!.verificationCode).toBe(pending.verificationCode);
      expect((await alice.service.status()).peers).toEqual([]);
      await expect(alice.service.approve(pending.id, '0000-0000')).rejects.toThrow();
      await alice.service.approve(pending.id, pending.verificationCode); await bob.service.refresh();
      const peer = (await alice.service.status()).peers[0]!;
      const source = await alice.controller.federationResources([selected.id]);
      expect(source).toHaveLength(1); expect(source[0]!.iri).toBe(`urn:graph:pod-note:${selected.id}`);
      // Simulate backing storage repointing the selected descriptor at another
      // valid owner-encrypted note. Selection must bind the authenticated inner id.
      const node = (alice.controller as unknown as { node: LocalNode }).node;
      const entries = await discover(node.podUrl, undefined, { fetch: node.fetch as FetchFn });
      const selectedEntry = entries.find(entry => entry.describes.includes(`urn:graph:pod-note:${selected.id}` as IRI))!;
      const otherEntry = entries.find(entry => entry.describes.includes(`urn:graph:pod-note:${privateNote.id}` as IRI))!;
      const selectedDescriptor = await (await node.fetch(selectedEntry.descriptorUrl)).text();
      const otherDescriptor = await (await node.fetch(otherEntry.descriptorUrl)).text();
      const ownDistribution = parseDistributionFromDescriptorTurtle(selectedDescriptor)!;
      const otherDistribution = parseDistributionFromDescriptorTurtle(otherDescriptor)!;
      const swapped = selectedDescriptor.replace(ownDistribution.accessURL, otherDistribution.accessURL);
      expect(swapped).not.toBe(selectedDescriptor);
      await node.fetch(selectedEntry.descriptorUrl, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: swapped });
      try { await expect(alice.controller.federationResources([selected.id])).rejects.toThrow('does not match'); }
      finally { await node.fetch(selectedEntry.descriptorUrl, { method: 'PUT', headers: { 'content-type': 'text/turtle' }, body: selectedDescriptor }); }
      await expect(alice.controller.federationResources([selected.id, privateNote.id, selected.id])).rejects.toThrow('Choose between');
      await alice.service.share(peer.id, source);
      const received = (await bob.service.status()).received;
      expect(received).toHaveLength(1);
      expect(await bob.service.received(received[0]!.id)).toEqual(source[0]);
      expect(presentSharedResource(await bob.service.received(received[0]!.id)).note).toEqual({ title: selected.title, body: selected.body });
      expect(await bob.controller.listNotes()).toEqual([]);
      expect(traffic.join('\n')).not.toContain(selected.body);
      expect(traffic.join('\n')).not.toContain(privateNote.body);
      expect(traffic.join('\n')).not.toContain(alice.key().secretKey);
      await bob.service.setEnabled(false); const reopened = bob.restart();
      expect((await reopened.status()).enabled).toBe(false);
      expect(await reopened.received(received[0]!.id)).toEqual(source[0]);
      expect((await fetch(`${bob.loopback}/pod-federation/profile`)).status).toBe(503);
      await reopened.setEnabled(true); await reopened.revoke((await reopened.status()).peers[0]!.id);
      await expect(alice.service.share(peer.id, source)).rejects.toThrow();
      expect((await reopened.status()).received).toHaveLength(1);
      await alice.controller.stop(); await alice.controller.start();
      expect(await alice.controller.listNotes()).toHaveLength(2);
    } finally {
      await Promise.allSettled(sharing.map(service => service.setEnabled(false)));
      await Promise.allSettled(bridges.map(bridge => bridge.stop()));
      await Promise.allSettled(brokers.map(broker => broker.close()));
      await Promise.allSettled(pods.map(pod => pod.stop()));
      if (dirname(resolve(directory)) === resolve(tmpdir()) && basename(directory).startsWith('interego-two-pods-')) await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 240_000);
});
