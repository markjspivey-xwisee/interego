/**
 * What an agent can do with the xAPI Profile Server, as affordances. These are the whole surface:
 * the server is reached by following them from the manifest, not by knowing its paths.
 */
import type { Affordance } from '../../../_shared/affordance-mcp/index.js';
import type { IRI } from '@interego/core';

const SERVER = 'The xAPI Profile Server (xAPI Profiles specification, Part Three) at {base}/xapi/profiles. GET that address for the profiles held and these links.';
const signedInputs = (fields: string) => [
  { name: '_signed_payload', type: 'string' as const, required: true, description: `JSON.stringify({ agent_id, timestamp, ${fields} }).` },
  { name: '_signature', type: 'string' as const, required: true, description: 'sign_request signature (secp256k1 over sha256 of _signed_payload).' },
];

export const xapiProfileServerAffordances: Affordance[] = [
  {
    action: 'urn:iep:action:foxxi:xapi-profile-add-signed' as IRI,
    toolName: 'foxxi.xapi_profile_add',
    title: 'Add an xAPI Profile to the profile server',
    description: `Add a version of an xAPI Profile as yourself, by its contents (profile) or by the https address it is published at (uri), when that address is on a host this deployment fetches from (profiles.adlnet.gov, raw.githubusercontent.com and w3id.org unless the operator set others); a profile published anywhere else is sent by its contents. ${SERVER} The version becomes a holon in a public PGSL lattice with its exact document as content, and its RDF is projected from that; it is then queryable at /sparql in a named graph whose IRI is the version's IRI, in the default graph if it is the profile's current version, and usable by id at /validate_templates and /validate_patterns. The first agent to add a profile IRI is the one who adds later versions of it. Up to 256 KB and 6,000 triples per version.`,
    method: 'POST',
    targetTemplate: '{base}/agent/xapi-profiles/add',
    mediaType: 'application/json',
    externallyRouted: true,
    annotations: { title: 'Add an xAPI Profile', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputs: signedInputs('profile?: <the profile document>, uri?: "https://…" — exactly one of the two'),
    outputs: {
      description: 'Where the version now answers. 400 when the document is not a profile, 409 when another agent added that profile IRI, 413 when it is too large, 507 when the server is full, 429 past the hourly count, 502 when a uri could not be fetched.',
      properties: {
        ok: { type: 'boolean' },
        profile: { type: 'string', description: 'The profile IRI.' },
        version: { type: 'string', description: 'The version IRI, which is also the named graph.' },
        current: { type: 'boolean', description: 'Whether this version is the one in the default graph.' },
        replaced: { type: 'boolean', description: 'True when this version was already held and is now this document.' },
        triples: { type: 'number' },
        document: { type: 'string', description: 'GET for the exact document as added.' },
        sparql: { type: 'string' },
        validateTemplates: { type: 'string' },
        validatePatterns: { type: 'string' },
        holonUri: { type: 'string', description: 'The profile version as a holon in the lattice.' },
        persisted: { type: 'boolean', description: 'False when the pod write did not land: the profile answers now but would not survive a restart.' },
      },
      required: ['ok'],
    },
  },
  {
    action: 'urn:iep:action:foxxi:xapi-profile-remove-signed' as IRI,
    toolName: 'foxxi.xapi_profile_remove',
    title: 'Take an xAPI Profile down from the profile server',
    description: `Take down a profile you added (every version) or one version of it, named by iri. The operator may take down any. ${SERVER} The lattice is append-only: the removal is what is recorded, the server stops answering from the profile, and the earlier holon stays addressable. This deployment's own profile cannot be taken down.`,
    method: 'POST',
    targetTemplate: '{base}/agent/xapi-profiles/remove',
    mediaType: 'application/json',
    externallyRouted: true,
    annotations: { title: 'Take down an xAPI Profile', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    inputs: signedInputs('iri: <profile or version IRI>'),
    outputs: {
      description: 'The version IRIs no longer served. 403 when you did not add it, 404 when it is not held, 409 for the deployment\'s own profile.',
      properties: { ok: { type: 'boolean' }, removed: { type: 'array', items: { type: 'string' } }, persisted: { type: 'boolean' } },
      required: ['ok'],
    },
  },
  {
    action: 'urn:iep:action:foxxi:xapi-profile-sparql' as IRI,
    toolName: 'foxxi.xapi_profile_sparql',
    title: 'Query the xAPI Profiles on the profile server with SPARQL',
    description: `Ask a SPARQL SELECT or ASK query of the profiles held. ${SERVER} The default graph holds the current version of every profile; each version is also a named graph whose IRI is the version IRI (FROM <version>, or WHERE { GRAPH <version> { … } }, or GRAPH ?g to ask every version). Inferred and queryable: every SKOS relationship in both directions and transitively (skos:broaderTransitive, skos:narrowerTransitive), and skos:inScheme from a concept, statement template or pattern to its profile. Evaluated: basic graph patterns, OPTIONAL, UNION, FILTER (comparison, REGEX, STRSTARTS, BOUND), VALUES, GROUP BY with COUNT/SUM/AVG/MIN/MAX, ORDER BY, LIMIT, OFFSET. Not evaluated, and refused with a 400 that says so rather than answered wrongly: property paths, subqueries, MINUS, EXISTS, HAVING, CONSTRUCT, DESCRIBE, SERVICE, and GRAPH beside other patterns. Also at GET {base}/xapi/profiles/sparql?query=….`,
    method: 'POST',
    targetTemplate: '{base}/xapi/profiles/sparql',
    mediaType: 'application/json',
    externallyRouted: true,
    annotations: { title: 'Query xAPI Profiles', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputs: [
      { name: 'query', type: 'string', required: true, description: 'The SPARQL query. The specification\'s own example queries are accepted as it writes them.' },
      { name: 'default-graph-uri', type: 'string', required: false, description: 'A version IRI to query in place of the default graph.' },
    ],
    outputs: {
      description: 'SPARQL 1.1 Query Results JSON (application/sparql-results+json).',
      properties: {
        head: { type: 'object', description: 'vars: the selected variable names.' },
        results: { type: 'object', description: 'bindings: one object per row, each variable a term { type: uri | literal | bnode, value, xml:lang?, datatype? }.' },
        boolean: { type: 'boolean', description: 'The answer to an ASK.' },
      },
    },
  },
  {
    action: 'urn:iep:action:foxxi:xapi-profile-validate-templates' as IRI,
    toolName: 'foxxi.xapi_profile_validate_templates',
    title: 'Validate a statement against a profile\'s statement templates',
    description: `Run the specification's statement template validation (Part Three, 2.1) for one xAPI Statement against a profile on the server, named by its id. ${SERVER} A statement validates when it matches at least one template on every determining property (verb, object activity type, context activity types, attachment usage types) and follows every rule of each template it matches. 204 with no body when it validates. 400 with comments naming the template, the rule's location and what was found when it does not, or when it matches no template. Nothing is stored. As the specification says of this API, it is for experiment and demonstration, not for a critical path.`,
    method: 'POST',
    targetTemplate: '{base}/xapi/profiles/validate_templates',
    mediaType: 'application/json',
    externallyRouted: true,
    annotations: { title: 'Validate against statement templates', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputs: [
      { name: 'statement', type: 'object', required: true, description: 'One xAPI Statement.' },
      { name: 'profile', type: 'string', required: true, description: 'The id of a profile, or of a version, held on the server.' },
    ],
    outputs: {
      description: 'An empty 204 on success. On 400: why.',
      properties: {
        valid: { type: 'boolean' },
        comments: { type: 'array', items: { type: 'string' }, description: 'Which template and rule were not followed.' },
        notChecked: { type: 'array', items: { type: 'string' }, description: 'Checks of a referenced statement skipped because that statement was not available.' },
      },
    },
  },
  {
    action: 'urn:iep:action:foxxi:xapi-profile-validate-patterns' as IRI,
    toolName: 'foxxi.xapi_profile_validate_patterns',
    title: 'Validate a run of statements against a profile\'s patterns',
    description: `Run the specification's pattern validation (Part Three, 2.2) for an array of xAPI Statements against a profile on the server, named by its id. ${SERVER} The statements are taken in timestamp order, then array order. They follow the profile when each validates against its statement templates and one primary pattern matches all of them from first to last. 204 with no body when they do. 400 with comments saying which statement or which part of the pattern did not. Up to 500 statements. Nothing is stored.`,
    method: 'POST',
    targetTemplate: '{base}/xapi/profiles/validate_patterns',
    mediaType: 'application/json',
    externallyRouted: true,
    annotations: { title: 'Validate against patterns', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputs: [
      { name: 'statements', type: 'array', required: true, description: 'The xAPI Statements of one registration or sub-registration.' },
      { name: 'profile', type: 'string', required: true, description: 'The id of a profile, or of a version, held on the server.' },
    ],
    outputs: {
      description: 'An empty 204 on success. On 400: why.',
      properties: { valid: { type: 'boolean' }, comments: { type: 'array', items: { type: 'string' } } },
    },
  },
];
