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
  method: 'GET', targetTemplate: '{base}/i2idlx/' + path, mediaType, externallyRouted: true,
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inputs: [], outputs: {
    description: 'Externally routed HTTP GET, not a named-MCP shim. The endpoint returns ' + mediaType
      + ' directly. These fields describe the existing core followAffordance result, not a JSON wrapper added to the endpoint; inspect status and contentType before parsing body.',
    properties: {
      status: { type: 'number', description: 'Actual HTTP status from the read target; 200 is success, while failures retain their returned status.' },
      contentType: { type: 'string', description: 'The target response Content-Type. Successful reads return ' + mediaType + '; an unavailable read returns an application/json error.' },
      body: { type: 'string', description: mediaType === 'application/json'
        ? 'Raw JSON response text. JSON.parse(body) exposes kind, status, upstream_adopted, canonical_source, counts, catalog, rdf and _affordances. Follow rdf.href and verify its bytes against rdf.sha256; the catalog has its own representation ETag.'
        : action === 'authored-rdf'
          ? 'Raw Turtle response text, not JSON. It contains the authored concept, definition, origin, reviewed proposal digest, evidence and directional restrictions; its SHA-256 is catalog.rdf.sha256 and classifier evidence authored_graph_sha256.'
          : 'Raw Turtle response text, not JSON. It contains the canonical SHACL profile extended with only the exact authored IRIs; its SHA-256 is the validator evidence effective_shape_sha256.' },
      affordance: { type: 'object', description: 'The existing follower echoes the resolved read action, HTTP target, method and declared media type.', properties: {
        action: { type: 'string' }, target: { type: 'string' }, method: { type: 'string', enum: ['GET'] }, mediaType: { type: 'string' },
      } },
    },
  },
}));
