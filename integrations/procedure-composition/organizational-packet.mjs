/** Domain-owned preparation adapter over the existing OWM Decision vocabulary.
 * It prepares data for publish_context; it does not publish or grant authority.
 */
import { createHash } from 'node:crypto';
import { graphIndex, iri, literal, canonical, httpUrl, DCT } from './profile.mjs';
export const OWM = 'https://markjspivey-xwisee.github.io/interego/applications/organizational-working-memory/owm#';

export function prepareDecisionPacket({ decision, evidence, projectIri, trustedSigner }) {
  for (const ref of [decision, evidence]) {
    httpUrl(ref.podUrl); httpUrl(ref.descriptorUrl); iri(ref.graphIri);
    if (typeof ref.cid !== 'string' || !ref.cid || typeof ref.content !== 'string' || Buffer.byteLength(ref.content) > 128 * 1024) throw new Error('Expected a bounded observed source and committed reference');
  }
  iri(projectIri); iri(trustedSigner);
  const graph = graphIndex(decision.content), id = decision.graphIri;
  if (!graph.typed(id, OWM + 'Decision') || graph.link(id, OWM + 'concernsProject') !== projectIri
      || graph.link(id, DCT + 'source') !== evidence.graphIri) throw new Error('Decision project or citation does not match the selected sources');
  const document = { profile: 'interego.organizational-decision-review/v1', trustedSigner,
    decision: { id, projectIri, title: graph.text(id, DCT + 'title'), rationale: graph.text(id, OWM + 'rationale') },
    sources: { decision: structuredClone(decision), evidence: structuredClone(evidence) },
    limit: 'Verifies source identity, publication binding, exact projection and current heads. It does not judge whether the rationale is sound or make an organizational approval.' };
  const text = canonical(document), sha256 = createHash('sha256').update(text).digest('hex');
  return { document, sha256, turtle: `@prefix ia: <urn:interego:application:> .\n<urn:interego:organizational-review:packet:${sha256}>\n  ia:format "canonical-json/v1" ;\n  ia:jsonBase64 "${Buffer.from(text).toString('base64')}" ;\n  ia:sha256 "${sha256}" ;\n  ${iri(DCT + 'source')} ${iri(decision.descriptorUrl)}, ${iri(evidence.descriptorUrl)} .\n` };
}
