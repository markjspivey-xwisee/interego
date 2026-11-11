/**
 * An artifact with hundreds of sub-holons must not be composed as one sequence that wide.
 *
 * ingest builds about n^2/2 fragments over a sequence of n items. Each ontology the bridge
 * composes at boot has one sub-holon per subject, and all of them went into the final ingest
 * together: the bridge held 2.5 GB for eighteen ontologies. Past a small width the sub-holons
 * are now folded into holons of holons, so the node count grows with the artifact, not its square.
 *
 * In memory only: an ephemeral compose reads and writes no pod.
 */
process.env.FOXXI_WALLET_SEED ||= 'narrow-holons-regression-seed';

import { describe, it, expect } from 'vitest';
import { composeIntoSharedLattice, readArtifact } from '../src/foundation-shared-lattice.js';

const noFetch = (async () => { throw new Error('an ephemeral compose must not reach a pod'); }) as unknown as typeof fetch;

async function compose(label: string, subjects: number) {
  const groups = Array.from({ length: subjects }, (_, i) => [
    [`https://x.example/s${i}`, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', 'http://www.w3.org/2002/07/owl#Class'],
    [`https://x.example/s${i}`, 'http://www.w3.org/2000/01/rdf-schema#label', `subject ${i}`],
  ]);
  const result = await composeIntoSharedLattice({
    podUrl: 'https://pod.narrow-holons.example/agent/', agentDid: 'did:test:narrow', label,
    terms: [`https://x.example/${label}`], termGroups: groups,
    content: { subjects }, contentType: 'spec:Ontology', projections: ['rdf'],
    ephemeral: true, fetch: noFetch as never,
  });
  if (!result) throw new Error('compose returned nothing');
  return result;
}

describe('a wide artifact composes in narrow holons', () => {
  it('grows with the number of subjects, not its square', async () => {
    const small = await compose('narrow-100', 100);
    const large = await compose('narrow-400', 400);
    // Four times the subjects. A quadratic top level would be about sixteen times the nodes.
    expect(large.stats.totalNodes / small.stats.totalNodes).toBeLessThan(6);
    expect(large.stats.totalNodes).toBeLessThan(400 * 40);
  });

  it('still reads the whole artifact back from the holon', async () => {
    const r = await compose('narrow-readback', 50);
    expect(readArtifact('narrow-readback', r.holonUri)).toEqual({ contentType: 'spec:Ontology', content: { subjects: 50 } });
  });

  it('leaves a holon of few sub-holons as it was', async () => {
    const a = await compose('narrow-same-a', 3);
    const b = await compose('narrow-same-b', 3);
    expect(a.stats.totalNodes).toBe(b.stats.totalNodes);
    expect(a.stats.totalNodes).toBeLessThan(80);
  });
});
