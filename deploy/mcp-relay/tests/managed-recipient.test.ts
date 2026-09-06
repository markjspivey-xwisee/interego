import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  generateKeyPair, createEncryptedEnvelope, kernelAct, dereference,
  type EncryptedEnvelope, type FetchFn,
} from '@interego/core';
import { fetchGraphContent } from '@interego/solid';
import {
  managedRecipientKey, managedRecipientPublicKeys, openManagedEnvelope,
  type ManagedKeyContext,
} from '../managed-recipient.js';
import { createRecipientGrant, openRecipientGrant, recipientGrantUrl, managedGrantRecipientKey, persistRecipientGrants } from '../envelope-sharing.js';

const root = generateKeyPair();
const identityUrl = 'https://identity.example';
const origin = 'https://store.example';
const author = 'did:web:identity.example:agents:author';
const reviewer = 'did:web:identity.example:agents:reviewer';
const stranger = 'did:web:identity.example:agents:stranger';
const graphUrl = `${origin}/author/context-graphs/1-graph.envelope.jose.json`;
const descriptorUrl = `${origin}/author/context-graphs/1.ttl`;
const plaintext = '<urn:contract> <urn:requires> "two distinct agent DIDs" .';
function context(actor: string | undefined, pod: string | undefined): ManagedKeyContext {
  return { root, identityUrl, sessionActor: actor, ownPodUrl: pod ? `${origin}/${pod}/` : undefined, storeOrigins: new Set([origin]) };
}
const authorContext = context(author, 'author');
const reviewerContext = context(reviewer, 'reviewer');
const strangerContext = context(stranger, 'stranger');
const reader = (ctx: ManagedKeyContext) => (env: EncryptedEnvelope, url: string) => openManagedEnvelope(ctx, env, url);
const bindings = [author, reviewer].map(agentId => ({ agentId, publicKey: root.publicKey }));
const keys = managedRecipientPublicKeys(root, bindings, identityUrl);
assert.equal(keys.length, 2, 'shared relay registrations become two distinct recipient wraps');
assert(!keys.includes(root.publicKey), 'new shared envelopes contain no fleet-key recipient');
assert.equal(managedRecipientKey(root, 'reviewer', identityUrl).publicKey, keys[1], 'slug and verified DID resolve to the same stable key');
assert.notEqual(managedRecipientKey(generateKeyPair(), reviewer, identityUrl).publicKey, keys[1], 'different roots cannot derive the reader key');
assert.deepEqual(managedRecipientPublicKeys(root, [{ agentId: reviewer, publicKey: generateKeyPair().publicKey }], identityUrl), [], 'client-held keys are never replaced with managed keys');

const envelope = createEncryptedEnvelope(plaintext, keys, root);
const oldPrivate = createEncryptedEnvelope('legacy private', [root.publicKey], root);
const originalBytes = JSON.stringify(oldPrivate);
const reviewerKey = managedRecipientKey(root, reviewer, identityUrl);
assert.equal(managedGrantRecipientKey(authorContext, reviewer, root.publicKey), reviewerKey.publicKey, 'legacy registry key resolves to the usable managed recipient');
assert.equal(managedGrantRecipientKey(authorContext, reviewer, reviewerKey.publicKey), reviewerKey.publicKey, 'current managed registrations remain usable');
assert.equal(managedGrantRecipientKey(authorContext, reviewer, generateKeyPair().publicKey), null, 'client-held keys must not be reported as a usable detached grant');
const grant = createRecipientGrant(authorContext, graphUrl, oldPrivate, reviewer, reviewerKey.publicKey, '2026-09-06T00:00:00Z');
const grantUrl = recipientGrantUrl(authorContext, graphUrl, reviewerKey.publicKey)!;
const anotherGrant = createRecipientGrant(authorContext, graphUrl, oldPrivate, stranger, managedRecipientKey(root, stranger, identityUrl).publicKey, '2026-09-06T00:00:00Z');
const anotherUrl = recipientGrantUrl(authorContext, graphUrl, anotherGrant.recipientPublicKey)!;
const planned = [{ grant, url: grantUrl }, { grant: anotherGrant, url: anotherUrl }];
const persisted = new Map<string, string>();
const partialWrite: FetchFn = async (url, init) => {
  const ok = url === grantUrl;
  if (ok) persisted.set(url, init!.body as string);
  return { ok, status: ok ? 201 : 403, statusText: '', text: async () => '', json: async () => ({}) };
};
const partial = await persistRecipientGrants(planned, partialWrite);
assert.equal(partial.shared, false); assert.equal(partial.partial, true);
assert.equal(partial.grants[0]!.recipient, reviewer, 'a later failure must not hide access already granted');
assert.equal(partial.failures[0]!.recipient, stranger); assert.equal(partial.failures[0]!.outcome, 'rejected');
assert.equal(openRecipientGrant(reviewerContext, graphUrl, oldPrivate, JSON.parse(persisted.get(grantUrl)!)), 'legacy private');
const unknown = await persistRecipientGrants(planned, async (url, init) => {
  if (url === anotherUrl) throw new Error('connection lost');
  return partialWrite(url, init);
});
assert.equal(unknown.shared, false); assert.equal(unknown.partial, true);
assert.equal(unknown.grants.length, 1); assert.equal(unknown.failures[0]!.outcome, 'unknown', 'a lost response cannot assert that no grant was persisted');
assert.equal(JSON.stringify(oldPrivate), originalBytes, 'sharing leaves the original encrypted artifact byte-identical');
assert(!JSON.stringify(grant).includes('legacy private'), 'grant contains only an encrypted content-key wrap');
assert.equal(openRecipientGrant(reviewerContext, graphUrl, oldPrivate, grant), 'legacy private', 'recipient opens the actual legacy ciphertext using its own detached wrap');
assert.equal(openRecipientGrant(strangerContext, graphUrl, oldPrivate, grant), null);
assert.equal(openRecipientGrant(reviewerContext, `${origin}/author/other.envelope.jose.json`, oldPrivate, grant), null, 'grant is bound to the exact source path');
assert.equal(openRecipientGrant(reviewerContext, graphUrl, envelope, grant), null, 'grant is bound to the exact encrypted envelope');
assert.equal(openRecipientGrant(context(reviewer, undefined), graphUrl, oldPrivate, grant), null);
assert.throws(() => createRecipientGrant(reviewerContext, graphUrl, oldPrivate, stranger, keys[0]!, ''), /source-pod owner/, 'a delegated foreign reader cannot mint grants on the source pod');
assert.throws(() => createRecipientGrant(context(undefined, 'author'), graphUrl, oldPrivate, reviewer, reviewerKey.publicKey, ''), /source-pod owner/);
assert(recipientGrantUrl(reviewerContext, graphUrl, reviewerKey.publicKey)?.startsWith(`${origin}/author/context-graphs/`));
const corruptGrant = { ...grant, wrappedKey: { ...grant.wrappedKey, wrappedKey: 'AAAA' } };
assert.equal(openRecipientGrant(reviewerContext, graphUrl, oldPrivate, corruptGrant), null, 'a corrupt detached wrap cannot open the content');
const newPrivate = createEncryptedEnvelope('agent private', [keys[0]!], root);
assert.equal(reader(authorContext)(envelope, graphUrl), plaintext);
assert.equal(reader(reviewerContext)(envelope, graphUrl), plaintext, 'foreign recipient actually unwraps the content key');
assert.equal(reader(strangerContext)(envelope, graphUrl), null, 'unlisted agent cannot unwrap');
assert.equal(reader(context(undefined, undefined))(envelope, graphUrl), null, 'anonymous read stays sealed');
assert.equal(reader(context(reviewer, undefined))(envelope, graphUrl), null, 'an identity string without an authenticated pod is insufficient');
assert.equal(reader(context(undefined, 'reviewer'))(envelope, graphUrl), null, 'pod identity alone does not impersonate a recipient');
assert.equal(reader(reviewerContext)(oldPrivate, graphUrl), null, 'foreign reader never receives the fleet key');
assert.equal(reader(authorContext)(oldPrivate, graphUrl), 'legacy private', 'owner can still read legacy encrypted data');
assert.equal(reader(context(reviewer, 'author'))(newPrivate, graphUrl), null, 'owning the same pod does not open a new private envelope for a different agent');
assert.equal(reader(authorContext)(newPrivate, graphUrl), 'agent private');
for (const url of [
  'https://attacker.example/author/1.envelope.jose.json',
  `${origin}/author/..%2freviewer/1.envelope.jose.json`,
  `${origin}/author/..%5creviewer/1.envelope.jose.json`,
]) assert.equal(reader(authorContext)(oldPrivate, url), null, 'copied or path-laundered private ciphertext stays sealed');
const forged: EncryptedEnvelope = { ...envelope, wrappedKeys: envelope.wrappedKeys.map((key, i) =>
  i === 0 ? { ...key, recipientPublicKey: managedRecipientKey(root, stranger, identityUrl).publicKey } : key),
};
assert.equal(reader(strangerContext)(forged, graphUrl), null, 'editing the declared recipient does not authenticate a wrapped key');
const altered = structuredClone(envelope);
const bytes = Buffer.from(altered.content.ciphertext, 'base64'); bytes[0] = bytes[0]! ^ 1;
(altered.content as { ciphertext: string }).ciphertext = bytes.toString('base64');
assert.equal(reader(reviewerContext)(altered, graphUrl), null, 'tampered ciphertext fails authentication');

const action = 'https://markjspivey-xwisee.github.io/interego/ns/iep#canDecrypt';
const descriptor = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<urn:descriptor> iep:affordance [ a iep:Affordance ; iep:action <${action}> ; hydra:target <${graphUrl}> ; hydra:method "GET" ] .`;
function transport(payload: EncryptedEnvelope, finalUrl = graphUrl): FetchFn {
  return async url => ({
    ok: true, status: 200, statusText: 'OK', url: url === descriptorUrl ? descriptorUrl : finalUrl,
    headers: { get: () => url === descriptorUrl ? 'text/turtle' : 'application/jose+json' },
    text: async () => url === descriptorUrl ? descriptor : JSON.stringify(payload),
    json: async () => payload,
  });
}
const read = await fetchGraphContent(graphUrl, { fetch: transport(envelope), openEnvelope: reader(reviewerContext) });
assert.equal(read.encrypted, true); assert.equal(read.content, plaintext);
const deny = await fetchGraphContent(graphUrl, { fetch: transport(oldPrivate), recipientKeyPair: root, openEnvelope: reader(reviewerContext) });
assert.equal(deny.content, null, 'a host refusal cannot fall back to a supplied fleet key');
const redirect = await fetchGraphContent(graphUrl, {
  fetch: transport(oldPrivate, `${origin}/victim/private.envelope.jose.json`),
  recipientKeyPair: root, openEnvelope: reader(authorContext),
});
assert.equal(redirect.content, null, 'authorization uses the landed URL rather than the requested own-pod URL');
const dereferenced = await dereference(graphUrl, { fetch: transport(envelope), openEnvelope: reader(reviewerContext) });
assert.equal(dereferenced.status, 'ok'); assert.equal(dereferenced.representation, plaintext);
for (const affordance of [
  { descriptorUrl, actionIri: action },
  { action, target: graphUrl, method: 'GET' as const },
]) {
  const opened = await kernelAct(affordance, {}, { fetch: transport(envelope), openEnvelope: reader(reviewerContext) });
  assert.equal(opened.body, plaintext, 'both named and direct canDecrypt affordances open for the recipient');
  const blocked = await kernelAct(affordance, {}, {
    fetch: transport(oldPrivate), recipientKeyPair: root, openEnvelope: reader(reviewerContext),
  });
  assert.equal(blocked.body, JSON.stringify(oldPrivate), 'both action paths leave foreign private ciphertext sealed');
  const redirected = await kernelAct(affordance, {}, {
    fetch: transport(oldPrivate, `${origin}/victim/private.envelope.jose.json`),
    recipientKeyPair: root, openEnvelope: reader(authorContext),
  });
  assert.equal(redirected.body, JSON.stringify(oldPrivate), 'both action paths authorize the final redirect destination');
  const throughGrant = await kernelAct(affordance, {}, {
    fetch: transport(oldPrivate),
    openEnvelope: async (env, url) => openRecipientGrant(reviewerContext, url, env, grant),
  });
  assert.equal(throughGrant.body, 'legacy private', 'both action paths await detached recipient decryption');
}
const grantRead = await fetchGraphContent(graphUrl, {
  fetch: transport(oldPrivate), openEnvelope: async (env, url) => openRecipientGrant(reviewerContext, url, env, grant),
});
assert.equal(grantRead.encrypted, true); assert.equal(grantRead.content, 'legacy private');

// These wiring checks supplement the executable policy/crypto/transport tests.
const server = readFileSync(new URL('../server.ts', import.meta.url), 'utf8');
const sharingHandler = server.slice(server.indexOf('async function handleShareEncryptedEnvelope('), server.indexOf('async function handleKernelAct('));
assert(sharingHandler.indexOf('unsupportedRecipients:') < sharingHandler.indexOf('persistRecipientGrants('), 'unsupported keys are rejected before any grant writes');
for (const sink of server.matchAll(/recipientKeyPair: await recipientKeyFor\(args, [^\n]+\),/g)) {
  assert.match(server.slice(sink.index, sink.index! + 220), /openEnvelope: await envelopeOpenerFor\(args\)/, 'every named read path carries the authoritative policy');
}
const opener = server.slice(server.indexOf('async function envelopeOpenerFor('), server.indexOf('async function selfPodUrl('));
assert.match(opener, /args\._session_agent_did \?\? args\._session_agent_id/);
assert.doesNotMatch(opener, /callerAgentId\(args\)|args\.agent_id/, 'a caller-supplied target agent is not a decryption identity');
assert.equal((server.match(/openEnvelope: renderOpenEnvelope/g) ?? []).length, 2, 'both render branches use the same recipient policy');
console.log('Managed recipient encryption: real unwraps, unauthorized reads, tampering, redirects and both kernel action paths passed.');
