/**
 * An Enterprise Learner Record built by the code that builds them, from a learner's statements, and the
 * loader a verifier reads one through: the W3C VC 2.0 contexts from static copies (contexts/, checked
 * against their published digests), and the record context the bridge serves. Used by
 * an-enterprise-learner-record-reads-as-rdf.test.ts and by the Foxxi SHACL agreement job (pySHACL; see
 * tools/shacl-agreement/).
 */
import { readFileSync } from 'node:fs';
import { assembleEnterpriseLearnerRecord, PERF_EXT, PERFORMED_VERB } from '../../src/learner-record.js';
import type { StoredStatement } from '../../src/statement-store.js';
import { FOXXI_NS } from '../../src/foxxi-vocab.js';
import { ELR_CONTEXT_URL, elrJsonLdContext } from '../../src/ler-tla-vocab.js';

const CONTEXTS = new URL('./contexts/', import.meta.url);
export const VC2 = 'https://www.w3.org/ns/credentials/v2';
export const UNDEFINED_TERMS = 'https://www.w3.org/ns/credentials/undefined-terms/v2';
export const read = (f: string): string => readFileSync(new URL(f, CONTEXTS), 'utf8');

/** Answers only the three contexts a record names; anything else is an error, never a fetch. */
export const documentLoader = async (url: string) => {
  const doc = url === VC2 ? JSON.parse(read('credentials-v2.jsonld'))
    : url === UNDEFINED_TERMS ? JSON.parse(read('credentials-undefined-terms-v2.jsonld'))
      : url === ELR_CONTEXT_URL ? elrJsonLdContext() : undefined;
  if (!doc) throw new Error(`the test fetches nothing: ${url}`);
  return { contextUrl: undefined, documentUrl: url, document: doc };
};

export const at = (n: number): string => `2026-10-0${n}T10:00:00Z`;
export const statement = (id: string, verb: string, extra: Record<string, unknown>, ts: string): StoredStatement => ({
  id, stored: ts, voided: false,
  statement: {
    id, verb: { id: verb }, timestamp: ts,
    actor: { objectType: 'Agent', account: { homePage: 'https://bridge.example', name: 'did:web:p.example' } },
    ...extra,
  },
});
export const performed = (id: string, ts: string, success: boolean): StoredStatement => statement(id, PERFORMED_VERB, {
  object: { objectType: 'Activity', id: `urn:task:${id}`, definition: { name: { en: 'Refund a disputed order' }, type: `${FOXXI_NS}ProductionTask` } },
  result: { success },
  context: { extensions: { [PERF_EXT.contextKind]: 'production' } },
}, ts);
export const completed = statement('c1', 'http://adlnet.gov/expapi/verbs/completed', {
  object: { objectType: 'Activity', id: 'https://bridge.example/course/refunds', definition: { name: { en: 'Refunds 101' } } },
}, at(1));

export async function record() {
  return assembleEnterpriseLearnerRecord({
    learnerDid: 'did:web:p.example', learnerPodUrl: 'https://pod.example/p/', tenantDid: 'did:web:tenant.example', lrsEndpoint: 'https://bridge.example',
    statements: [completed, performed('p1', at(2), true), performed('p2', at(3), true), performed('p3', at(4), true)],
    subjectKind: 'agent', fetch: (async () => { throw new Error('no pod here'); }) as never,
  });
}
