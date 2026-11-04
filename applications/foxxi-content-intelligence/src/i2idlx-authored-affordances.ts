/** Read ports for the separately authored glossary layer; canonical I2IDL endpoints are unchanged. */
import type { Affordance } from '../../_shared/affordance-mcp/index.js';
import type { IRI } from '@interego/core';
const reads = [
  ['authored-catalog', 'authored-catalog', 'Read the authored glossary catalog', 'application/json'],
  ['authored-rdf', 'authored.ttl', 'Read authored glossary RDF', 'text/turtle'],
  ['authored-shapes', 'authored-shapes.ttl', 'Read the canonical and exact-authored reference shapes', 'text/turtle'],
] as const;
export const authoredGlossaryAffordances: Affordance[] = reads.map(([action, path, title, mediaType]) => ({
  action: ('urn:iep:action:foxxi:i2idlx-' + action) as IRI, toolName: 'foxxi.i2idlx_' + action.replaceAll('-', '_'),
  title, description: 'Read the deployment-owned Hypothetical authored layer with origin and source binding. No canonical source edit, ratification, learner claim or publication occurs.',
  method: 'GET', targetTemplate: '{base}/i2idlx/' + path, externallyRouted: true,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputs: [], outputs: { description: 'The authored layer as ' + mediaType + '; inspect the catalog RDF SHA-256 and exact reference profile.', properties: {} },
}));
