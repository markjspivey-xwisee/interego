import { Wallet } from 'ethers';
import { vi } from 'vitest';
import { fixtureStore } from '../../examples/application-simulation/fixture-store.js';
import { releaseControl } from '../../examples/application-simulation/rule-packs.js';
import application from '../../integrations/application-runtime/resource-composition.js';
import { parseSignedJsonDocument, type Json, type ApplicationContract } from '../../integrations/application-runtime/application-lab-runtime.js';
import { attestClientRegistration } from '../../deploy/mcp-relay/client-registration.js';
import { clientSigningMessage, type ClientSignature } from '../../integrations/application-runtime/client-authorization.js';
import { ResourceCompositions, type ResourceWriteContext } from '../../deploy/mcp-relay/resource-compositions.js';
import { ClientInteractions, type InteractionRecord, type InteractionStore, type InteractionOwner } from '../../deploy/mcp-relay/client-interactions.js';

export function memoryInteractionStore(): InteractionStore & { records: Map<string, { record: InteractionRecord; revision: number }> } {
  const records = new Map<string, { record: InteractionRecord; revision: number }>();
  return { records,
    async enqueue() {},
    async pending(owner) { return [...records.values()].filter(v => v.record.owner.userId === owner.userId && v.record.owner.clientId === owner.clientId && v.record.owner.principal === owner.principal).map(v => v.record.id); },
    async read(id) { const value = records.get(id); return value ? { record: structuredClone(value.record), etag: String(value.revision) } : undefined; },
    async write(record, etag) {
      const previous = records.get(record.id);
      if (previous ? etag !== String(previous.revision) : etag !== undefined) throw new Error('interaction changed; reload its status');
      records.set(record.id, { record: structuredClone(record), revision: (previous?.revision ?? 0) + 1 });
    },
  };
}

export async function signingFixture(options: { clientGrants?: boolean } = {}) {
  const relay = Wallet.createRandom();
  let now = Date.now();
  const pack = releaseControl();
  const approve = pack.contract.actions[0]!;
  const contract: ApplicationContract = { ...pack.contract, actions: [{ ...approve, clientSignature: true, ...(options.clientGrants ? { allowClientDelegation: true } : {}),
    guard: { op: 'all', guards: [approve.guard!, { op: 'none', path: '$state.approvals', where: { itemPath: 'keyId', eq: '$authorization.keyId' } }] } as Json,
    effects: [{ op: 'appendUnique', path: '$state.approvals', by: 'approver', value: { approver: '$actor', at: '$now', keyId: '$authorization.keyId', verified: '$authorization.verified' } }] }, ...pack.contract.actions.slice(1), ...(options.clientGrants ? (['enroll', 'revoke'] as const).map(op => ({ actionIri: pack.contract.applicationId + ':grant:' + op,
      label: op === 'enroll' ? 'Enroll signing grant' : 'Revoke signing grant', clientGrantOperation: op, clientSignature: true, method: 'POST',
      target: approve.target!, inputs: (op === 'enroll' ? ['grant', 'possession'] : ['grantId']).map(name => ({ name, type: 'string' as const, required: true })), effects: [] })) : [])],
    ...(options.clientGrants ? { clientSigningGrants: { schema: 'interego.application.client-grants/v1' as const, audience: 'https://relay.example', registrationVerifier: 'did:ethr:' + relay.address.toLowerCase() } } : {}) };
  const store = fixtureStore({ ...pack, contract });
  const initial = await store.resolve();
  const registry = new ResourceCompositions([application]);
  const wallets = { alice: Wallet.createRandom(), bob: Wallet.createRandom() };
  const owners: Record<string, InteractionOwner> = {
    alice: { userId: 'alice', clientId: 'client-a', principal: 'did:example:alice' },
    bob: { userId: 'bob', clientId: 'client-b', principal: 'did:example:bob' },
  };
  const revoked = new Set<string>();
  const publish = vi.fn(async (request: Parameters<ResourceWriteContext['publish']>[0]) => {
    const current = store.heads.get(store.graphs.state)!.head!;
    if (request.expectedHead !== current.cid) throw new Error('CAS failed');
    const parsed = parseSignedJsonDocument(request.graphContent);
    const url = `https://pod.example/simulation/context-graphs/state-${parsed.document.version}.ttl`;
    const cid = `fixture-cid-${parsed.declaredDigest}`;
    store.descriptors.set(url, { url, cid, content: request.graphContent, authorship: { ...initial.stateDescriptor.authorship!, signedBy: request.actor } });
    store.heads.set(store.graphs.state, { head: { descriptorUrl: url, cid }, forked: false });
    store.history.push({ descriptorUrl: url, cid, supersedes: [current.descriptorUrl!] });
    return { published: true };
  });
  const context = (credential = 'alice'): ResourceWriteContext => ({ reads: { ...store.reads, discover: store.reads.discoverCatalogs },
    principal: owners[credential]!.principal, identityUrl: 'https://identity.example', now: new Date(now).toISOString(), relayUrl: 'https://relay.example', clock: () => now,
    attestClientRegistration: proof => attestClientRegistration(proof, { actor: owners[credential]!.principal, now: new Date(now).toISOString(),
      verifier: 'did:ethr:' + relay.address.toLowerCase(), keys: [{ scheme: 'eip191', address: wallets[credential as keyof typeof wallets].address.toLowerCase() }], sign: message => relay.signMessage(message) }),
    signingKeys: async () => [{ scheme: 'eip191' as const, address: wallets[credential as keyof typeof wallets].address.toLowerCase() }], publish });
  const storage = memoryInteractionStore();
  const deps = {
    store: storage, publicUrl: 'https://identity.example', now: () => now,
    authorize: async (credential: string) => { if (!owners[credential] || revoked.has(credential)) throw new Error('grant revoked'); return { ...owners[credential]!, expiresAt: now + 3600_000 }; },
    prepare: (record: InteractionRecord) => registry.prepareSignature(record.reference, record.action, record.payload, context(record.credential)),
    prepareGrant: (record: InteractionRecord, payload: Record<string, unknown>) => registry.prepareClientGrant(record.reference, record.action, payload, context(record.credential)),
    validate: (record: InteractionRecord, proof: unknown) => registry.validateSignature(record.draft!.reference, record.action, record.payload, proof, context(record.credential)),
    execute: (record: InteractionRecord, proof: unknown) => registry.invoke(record.draft!.reference, record.action, { ...record.payload, client_proof: proof }, context(record.credential)).then(value => value!),
  };
  const broker = new ClientInteractions(deps);
  const control = async (credential = 'alice') => {
    const view = (await registry.render(initial.catalogDescriptor.url, context(credential), initial.catalogDescriptor))!;
    return view.controls.find(c => c['label'] === 'Submit: Approve release')!;
  };
  const create = async (credential = 'alice') => {
    const c = await control(credential);
    return registry.invoke(String(c['descriptorUrl']), String(c['action']), {}, { ...context(credential),
      requestSignature: (reference, action, payload, draft) => broker.create({ credential, reference, action, payload, draft }) });
  };
  const sign = async (request: { message: string }, credential: keyof typeof wallets = 'alice'): Promise<ClientSignature> => {
    const key = { scheme: 'eip191' as const, address: wallets[credential].address.toLowerCase() };
    return { schema: 'interego.client-signature/v1', key, message: request.message,
      signature: await wallets[credential].signMessage(clientSigningMessage(request.message, key)) };
  };
  return { broker, deps, storage, store, registry, initial, context, create, control, sign, owners, wallets, relay, publish, revoked,
    advance: (ms: number) => { now += ms; } };
}
