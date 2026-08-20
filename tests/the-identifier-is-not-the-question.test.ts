/**
 * TWO CALLERS ASKING ABOUT ONE SUBJECT MUST GET ONE `id` BACK.
 *
 * MEASURED by a delegate, same subject and same signature six seconds apart:
 *
 *   no named pod            -> id: https://gate.interego.xwisee.com/eth-…/#enterprise-learner-record
 *   read_pod_url (internal) -> id: http://css.railway.internal:3456/eth-…/#enterprise-learner-record
 *
 * Same record, same principal, same authority decision — and an IEEE P2997 document that names its
 * own evidence at an address nothing outside one private network resolves. Adding `read_pod_url`
 * let a caller NAME a pod, and the raw string it named was echoed straight into the published
 * artifact, so the document made dereferenceable one day was undereferenceable again through the
 * field added the next.
 *
 * ★ AN IDENTIFIER IS A PROPERTY OF THE THING, NOT OF THE QUESTION. Which spelling you got depended
 * on HOW YOU ASKED. The read still goes wherever the caller named — that is the request, and it is
 * theirs — but `id` and `provenance.rawDataLocations` are the ARTIFACT, and the artifact belongs to
 * the subject.
 *
 * Third time this session one value served two purposes: `subject_pod_url` answering both "whose
 * pod am I" and "whose record am I asking for"; the relay minting a fetch target as an identifier;
 * and now a read target echoed as a published id.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleEnterpriseLearnerRecord } from '../applications/foxxi-content-intelligence/src/learner-record.js';

const INTERNAL = 'http://css.railway.internal:3456/eth-42c2ffd7e4c0/';
const PUBLIC = 'https://gate.interego.xwisee.com/eth-42c2ffd7e4c0/';

/** The assembler needs no network for this: an empty statement set still produces id + provenance. */
const assemble = (learnerPodUrl: string, publicPodUrl?: string): ReturnType<typeof assembleEnterpriseLearnerRecord> =>
  assembleEnterpriseLearnerRecord({
    learnerDid: 'did:ethr:0x42c2ffd7e4c048f2ee757b26ee16a2c2339882ab',
    learnerPodUrl,
    ...(publicPodUrl ? { publicPodUrl } : {}),
    subjectKind: 'agent',
    tenantDid: 'did:web:acme-id.interego.xwisee.com',
    lrsEndpoint: 'https://foxxi-bridge.interego.xwisee.com',
    statements: [],
    // No pod is reachable from a test process; exportClr fails closed and the ELR still assembles.
    fetch: (async () => { throw new Error('offline'); }) as unknown as typeof globalThis.fetch,
  });

describe('★ the published identifier does not depend on how the caller asked', () => {
  it('a record READ from the internal spelling is still IDENTIFIED publicly', async () => {
    const elr = await assemble(INTERNAL, PUBLIC);
    expect(elr.id).toBe(`${PUBLIC.replace(/\/+$/, '')}/#enterprise-learner-record`);
    expect(elr.id, 'the artifact must not name an address only one network resolves')
      .not.toContain('css.railway.internal');
  });

  it('and so is every raw-data location — P2997 exists so a third party can go and look', async () => {
    const elr = await assemble(INTERNAL, PUBLIC);
    const subjectPod = elr.provenance.rawDataLocations.find((l) => l.kind === 'subject-pod');
    expect(subjectPod?.location).toBe(PUBLIC);
    for (const l of elr.provenance.rawDataLocations) {
      expect(l.location, `${l.kind} must be dereferenceable`).not.toContain('css.railway.internal');
    }
  });

  it('★ the two spellings produce the SAME id — which is the whole property', async () => {
    // The delegate's measurement, as an assertion: one subject, two ways of asking, one identifier.
    const fromInternal = await assemble(INTERNAL, PUBLIC);
    const fromPublic = await assemble(PUBLIC, PUBLIC);
    expect(fromInternal.id).toBe(fromPublic.id);
    expect(fromInternal.provenance.rawDataLocations[0]?.location)
      .toBe(fromPublic.provenance.rawDataLocations[0]?.location);
  });

  it('and omitting publicPodUrl behaves exactly as before', async () => {
    // A caller with only one spelling must be unaffected — the field defaults to the read pod.
    const elr = await assemble(PUBLIC);
    expect(elr.id).toBe(`${PUBLIC.replace(/\/+$/, '')}/#enterprise-learner-record`);
  });
});

describe('the bridge supplies it, and only for its own store', () => {
  const src = readFileSync(join(
    dirname(fileURLToPath(import.meta.url)),
    '..', 'applications', 'foxxi-content-intelligence', 'bridge', 'server.ts',
  ), 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));

  it('every ELR assembly passes the canonical public pod', () => {
    const assembles = code.filter((l) => /assembleEnterpriseLearnerRecord\(\{/.test(l)).length;
    const passes = code.filter((l) => /publicPodUrl: canonicalPublicPodUrl\(/.test(l)).length;
    expect(assembles, 'call sites').toBeGreaterThan(0);
    expect(passes, `${assembles} assemblies but only ${passes} pass publicPodUrl`).toBe(assembles);
  });

  it('★ and it re-spells ONLY this deployment\'s store', () => {
    // Re-spelling a foreign host onto ours is the laundering that made the relay's
    // toInternalPodUrl a decryption oracle. Anything not ours is returned untouched.
    const at = src.indexOf('function canonicalPublicPodUrl');
    const fn = src.slice(at, src.indexOf('\n}\n', at) + 3);
    expect(fn).toMatch(/if \(!sameStore\(pod, tenantPodUrl\)\) return pod;/);
    expect(fn, 'the public origin comes from configuration, not a literal').toMatch(/new URL\(tenantPodUrl\)\.origin/);
  });
});
