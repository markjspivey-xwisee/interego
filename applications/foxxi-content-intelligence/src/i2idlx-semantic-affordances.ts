/** Public deterministic checks over the deployment's pinned I2IDL-X build. */
import type { Affordance } from '../../_shared/affordance-mcp/index.js';
import type { IRI } from '@interego/core';

const definitions = [
  ['classifier', 'classify', 'Classify an RDF draft', 'Run the fixed q-classify query and pinned category-disjointness checks. Derived types remain Hypothetical; this is not full OWL consistency checking.'],
  ['shacl', 'validate', 'Validate an RDF draft', 'Run the existing native SHACL Core validator and check classified concept existence against the pinned glossary. Unsupported constraints fail closed.'],
  ['peerTerm', 'peer-term', 'Look up a peer term', 'Look up an exact IRI in the pinned publisher-label and mapping-target evidence. A miss means unconfirmed in this snapshot, not nonexistent.'],
  ['sourceVersion', 'source-version', 'Check the upstream source version', 'Compare the pinned glossary release with the canonical scheme fetched now. An outage returns unavailable; no snapshot is automatically upgraded.'],
] as const;

export const semanticAffordances: Affordance[] = definitions.map(([, slug, title, description]) => ({
  action: ('urn:iep:action:foxxi:i2idlx-' + slug) as IRI,
  toolName: 'foxxi.i2idlx_' + slug.replaceAll('-', '_'), title, description,
  method: 'POST', targetTemplate: '{base}/i2idlx/api/' + slug, externallyRouted: true,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: slug !== 'source-version', openWorldHint: slug === 'source-version' },
  inputs: slug === 'source-version' ? [] : slug === 'peer-term'
    ? [{ name: 'iri', type: 'string', required: true, description: 'One absolute HTTP(S) term IRI, at most 2048 UTF-8 bytes. This operation does not fetch the supplied IRI.' }]
    : [{ name: 'graph_content', type: 'string', required: true, description: 'Inline instance-only Turtle, at most 64000 UTF-8 bytes and 512 triples. No caller schema, inference-changing axioms, paths, remote graph URLs, custom shapes or executable queries.' }],
  outputs: {
    description: 'An executed deterministic read-only check with pinned source provenance and explicit evidence. No model sampling, pod writes, approval, ratification or publication occurs.',
    properties: {
      task: { type: 'string' }, status: { type: 'string' }, execution: { type: 'string' },
      sampling_performed: { type: 'boolean' }, writes_performed: { type: 'boolean' },
      source: { type: 'object', additionalProperties: true }, evidence: { type: 'object', additionalProperties: true },
      result: { type: 'object', additionalProperties: true }, error: { type: 'string' },
    },
  },
}));

export function semanticCheckOperations(baseUrl: string) {
  const base = baseUrl.replace(/\/+$/, '');
  return Object.fromEntries(definitions.map(([key, slug]) => [key, {
    action: 'urn:iep:action:foxxi:i2idlx-' + slug, href: base + '/i2idlx/api/' + slug, method: 'POST' as const,
  }])) as Record<typeof definitions[number][0], { action: string; href: string; method: 'POST' }>;
}
