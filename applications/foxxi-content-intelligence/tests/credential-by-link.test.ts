/**
 * A credential verified by its link: the reader follows the wallet descriptor to the graph beside
 * it and returns the credential exactly as it was stored, so the bytes a relying party checks are
 * the bytes the issuer signed. The link to the graph works as well as the descriptor's, a missing
 * credential is an error rather than an empty answer, and a private host is never fetched.
 */
import { describe, expect, it } from 'vitest';
import { fetchCredentialAt } from '../src/clr.js';

const WALLET = 'https://pod.example.invalid/u-eth-0123456789ab/foxxi-wallet/';
const DESCRIPTOR = `${WALLET}cred-course-1.ttl`;
const GRAPH = `${WALLET}cred-course-1-graph.trig`;
const credential = {
  '@context': ['https://www.w3.org/ns/credentials/v2'],
  id: DESCRIPTOR,
  type: ['VerifiableCredential', 'OpenBadgeCredential'],
  issuer: 'did:key:z6MkTenant',
  validFrom: '2026-09-25T00:00:00.000Z',
  credentialSubject: { id: 'https://identity.example/users/u-eth-0123456789ab/profile#me', achievement: { id: 'urn:course-1', name: 'Course 1' }, evidence: [{ id: 'urn:statement:1' }] },
  proof: { type: 'DataIntegrityProof', cryptosuite: 'eddsa-jcs-2022', proofValue: 'z3xample' },
};
const bundle = Buffer.from(JSON.stringify(credential)).toString('base64');
const pod: Record<string, string> = {
  [DESCRIPTOR]: `<${DESCRIPTOR}#descriptor> a <https://markjspivey-xwisee.github.io/interego/ns/iep#ContextDescriptor> .\n[] hydra:target <${GRAPH}> .\n`,
  [GRAPH]: `<urn:graph> {\n  <urn:credential> <https://foxxi.example/ns#bundleJson> "${bundle}"^^<http://www.w3.org/2001/XMLSchema#base64Binary> .\n}\n`,
};
const fetchFromPod = (async (url: string) => (pod[url] !== undefined
  ? new Response(pod[url], { status: 200, headers: { 'Content-Type': url.endsWith('.trig') ? 'application/trig' : 'text/turtle' } })
  : new Response('', { status: 404, statusText: 'Not Found' }))) as unknown as typeof fetch;

describe('a credential read by its link', () => {
  it('follows the wallet descriptor to its graph and returns the credential exactly as stored', async () => {
    expect(await fetchCredentialAt(DESCRIPTOR, fetchFromPod)).toEqual(credential);
  });
  it('reads the graph directly when the link names it', async () => {
    expect(await fetchCredentialAt(GRAPH, fetchFromPod)).toEqual(credential);
  });
  it('fails when nothing is at the link, rather than answering with an empty credential', async () => {
    await expect(fetchCredentialAt(`${WALLET}cred-missing.ttl`, fetchFromPod)).rejects.toThrow(/404/);
  });
  it('never fetches a private host', async () => {
    let fetched = false;
    const spy = (async () => { fetched = true; return new Response(''); }) as unknown as typeof fetch;
    await expect(fetchCredentialAt('http://127.0.0.1/u-eth-0123456789ab/foxxi-wallet/cred.ttl', spy)).rejects.toThrow(/private|loopback/);
    expect(fetched).toBe(false);
  });
});
