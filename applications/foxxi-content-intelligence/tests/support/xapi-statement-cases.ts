/**
 * xAPI statements and the verdict the xAPI shapes give each, in its JSON and in its RDF reading through
 * /ns/xapi/context. Held by a-statement-read-as-rdf-meets-the-same-shapes.test.ts (the Foxxi validator
 * and the substrate's SHACL processor) and by the Foxxi SHACL agreement job (pySHACL; see
 * tools/shacl-agreement/).
 */
type Json = Record<string, unknown>;

// ── Statements ────────────────────────────────────────────────────────────────────────────
export const AGENT = { mbox: 'mailto:ada@example.org', name: 'Ada' };
export const VERB = { id: 'http://adlnet.gov/expapi/verbs/completed', display: { 'en-US': 'completed' } };
export const ACTIVITY = { id: 'https://example.org/courses/refunds', definition: { name: { en: 'Refunds 101' }, type: 'http://adlnet.gov/expapi/activities/course' } };
export const base = (extra: Json = {}): Json => ({
  id: '6b9e2a2c-5d1f-4c6e-8a3b-7f0e9d8c7b6a', actor: AGENT, verb: VERB, object: ACTIVITY, timestamp: '2026-10-01T12:00:00.000Z', ...extra,
});
export const RICH = base({
  verb: { id: 'http://adlnet.gov/expapi/verbs/answered', display: { 'en-US': 'answered', fr: 'a répondu' } },
  object: {
    objectType: 'Activity', id: 'https://example.org/q/1',
    definition: {
      name: { en: 'Q1' }, description: { en: 'Pick one.' }, type: 'http://adlnet.gov/expapi/activities/cmi.interaction',
      moreInfo: 'https://example.org/q/1/about', interactionType: 'choice', correctResponsesPattern: ['a'],
      choices: [{ id: 'a', description: { en: 'A' } }, { id: 'b', description: { en: 'B' } }],
      extensions: { 'https://example.org/ext/difficulty': 3 },
    },
  },
  result: { score: { scaled: 0.5, raw: 5, min: 0, max: 10 }, success: true, completion: true, response: 'a', duration: 'PT1M30.5S', extensions: { 'https://example.org/ext/attempt': 'second' } },
  context: {
    registration: 'ec2a3c1b-0a5e-4d3c-9b2a-1f0e9d8c7b6a',
    instructor: { objectType: 'Agent', account: { homePage: 'https://lms.example.org', name: 'teacher-7' } },
    team: { objectType: 'Group', name: 'Blue', mbox: 'mailto:blue@example.org' },
    contextActivities: { parent: [{ id: 'https://example.org/quiz/1' }], grouping: [{ id: 'https://example.org/courses/refunds' }], category: [{ id: 'https://w3id.org/xapi/cmi5/v1.0' }] },
    contextAgents: [{ objectType: 'contextAgent', agent: { mbox: 'mailto:t@example.org' }, relevantTypes: ['https://example.org/roles/assessor'] }],
    contextGroups: [{ objectType: 'contextGroup', group: { objectType: 'Group', member: [{ mbox: 'mailto:p@example.org' }] }, relevantTypes: ['https://example.org/roles/cohort'] }],
    revision: 'r2', platform: 'Example LMS', language: 'en-US',
    statement: { objectType: 'StatementRef', id: '1b9e2a2c-5d1f-4c6e-8a3b-7f0e9d8c7b6a' },
    extensions: { 'https://example.org/ext/session': 'abc' },
  },
  stored: '2026-10-01T12:00:01.000Z',
  authority: { objectType: 'Agent', account: { homePage: 'https://lrs.example.org', name: 'client-1' } },
  version: '2.0.0',
  attachments: [{ usageType: 'https://example.org/attachments/certificate', display: { en: 'Certificate' }, description: { en: 'The certificate' }, contentType: 'application/pdf', length: 1024, sha2: 'a'.repeat(64), fileUrl: 'https://example.org/c.pdf' }],
});

/** `fault`: the shape each reading names for the violation — the same, unless an untyped node is held
 *  to a shape by the shape that selects it (an Agent left untyped, by ActorShape) or the LRS
 *  validator, which reports under StatementShape, is the one that sees the fault in JSON. */
export interface StatementCase { stmt: Json; conforms: boolean; refused?: string; jsonOnly?: string; fault?: string | { json: string; rdf: string } }
export const STATEMENT_CASES: Readonly<Record<string, StatementCase>> = {
  // Valid
  'a minimal statement: an Agent left untyped, an Activity left untyped': { stmt: base(), conforms: true },
  'a statement using every part of the data model': { stmt: RICH, conforms: true },
  'an Identified Group that lists its members': { stmt: base({ actor: { objectType: 'Group', openid: 'https://id.example.org/team-a', member: [{ mbox: 'mailto:a@example.org' }, { account: { homePage: 'https://lms.example.org', name: 'b' } }] } }), conforms: true },
  'an Anonymous Group': { stmt: base({ actor: { objectType: 'Group', member: [{ mbox: 'mailto:a@example.org' }, { mbox_sha1sum: 'f'.repeat(40) }] } }), conforms: true },
  'a statement voiding another': { stmt: base({ verb: { id: 'http://adlnet.gov/expapi/verbs/voided', display: { en: 'voided' } }, object: { objectType: 'StatementRef', id: '1b9e2a2c-5d1f-4c6e-8a3b-7f0e9d8c7b6a' } }), conforms: true },
  'an Agent as the object': { stmt: base({ verb: { id: 'http://adlnet.gov/expapi/verbs/mentored' }, object: { objectType: 'Agent', account: { homePage: 'https://lms.example.org', name: 'learner-9' } } }), conforms: true },
  'a Sub-Statement as the object': { stmt: base({ verb: { id: 'http://adlnet.gov/expapi/verbs/planned' }, object: { objectType: 'SubStatement', actor: AGENT, verb: VERB, object: ACTIVITY, timestamp: '2026-10-08T12:00:00.000Z' } }), conforms: true },
  // Invalid in both readings
  'an Agent with two identifiers': { stmt: base({ actor: { ...AGENT, openid: 'https://id.example.org/ada' } }), conforms: false, fault: { json: 'AgentShape', rdf: 'ActorShape' } },
  'an Agent with no identifier': { stmt: base({ actor: { name: 'Ada' } }), conforms: false, fault: { json: 'AgentShape', rdf: 'ActorShape' } },
  'a Group with neither an identifier nor members': { stmt: base({ actor: { objectType: 'Group', name: 'Nobody' } }), conforms: false, fault: 'GroupShape' },
  'an mbox that is not a mailto IRI': { stmt: base({ actor: { mbox: 'https://example.org/ada' } }), conforms: false, fault: { json: 'AgentShape', rdf: 'ActorShape' } },
  'a statement id that is not a UUID': { stmt: base({ id: 'statement-1' }), conforms: false, fault: 'StatementShape' },
  'a timestamp not in UTC': { stmt: base({ timestamp: '2026-10-01T08:00:00.000-04:00' }), conforms: false, fault: 'StatementShape' },
  'a statement with no verb': { stmt: (({ verb: _v, ...rest }) => rest)(base()), conforms: false, fault: 'StatementShape' },
  'a scaled score above 1': { stmt: base({ result: { score: { scaled: 1.5 } } }), conforms: false, fault: 'ScoreShape' },
  'a score whose min is not below its max': { stmt: base({ result: { score: { min: 10, max: 5 } } }), conforms: false, fault: 'ScoreShape' },
  'a raw score above its max': { stmt: base({ result: { score: { raw: 11, min: 0, max: 10 } } }), conforms: false, fault: 'ScoreShape' },
  'a duration that is not ISO 8601': { stmt: base({ result: { duration: '90 seconds' } }), conforms: false, fault: 'ResultShape' },
  'an interaction type outside the vocabulary': { stmt: base({ object: { id: 'https://example.org/q/2', definition: { interactionType: 'essay' } } }), conforms: false, fault: 'InteractionDefinitionShape' },
  'a registration that is not a UUID': { stmt: base({ context: { registration: 'reg-1' } }), conforms: false, fault: { json: 'StatementShape', rdf: 'ContextShape' } },
  'an attachment without its SHA-2': { stmt: base({ attachments: [{ usageType: 'https://example.org/a', display: { en: 'A' }, contentType: 'text/plain', length: 3 }] }), conforms: false, fault: 'AttachmentShape' },
  'a voiding statement whose object is an Activity': { stmt: base({ verb: { id: 'http://adlnet.gov/expapi/verbs/voided' } }), conforms: false, fault: 'StatementShape' },
  'a Sub-Statement nesting a Sub-Statement': { stmt: base({ object: { objectType: 'SubStatement', actor: AGENT, verb: VERB, object: { objectType: 'SubStatement', actor: AGENT, verb: VERB, object: ACTIVITY } } }), conforms: false, fault: 'SubStatementShape' },
  'a Sub-Statement carrying a version': { stmt: base({ object: { objectType: 'SubStatement', actor: AGENT, verb: VERB, object: ACTIVITY, version: '2.0.0' } }), conforms: false, fault: 'SubStatementShape' },
  'a context statement that is not a Statement Reference': { stmt: base({ context: { statement: { id: '1b9e2a2c-5d1f-4c6e-8a3b-7f0e9d8c7b6a' } } }), conforms: false, fault: { json: 'StatementShape', rdf: 'ContextShape' } },
  // Refused in safe mode: no reading, and the JSON validator rejects them too
  'a verb whose id is not an IRI': { stmt: base({ verb: { id: 'completed' } }), conforms: false, refused: 'relative @id reference' },
  'a property xAPI does not define': { stmt: base({ mood: 'happy' }), conforms: false, refused: 'invalid property' },
  'an extension value keyed by plain names': { stmt: base({ result: { extensions: { 'https://example.org/ext/geo': { lat: 1, lon: 2 } } } }), conforms: true, refused: 'invalid property' },
  // Rules with no RDF statement: the LRS validator checks them alone
  // ★ Found by a second review: a context agent was selected by its class alone, so one without its
  // objectType had no type in the reading and passed.
  'a context agent without its objectType': { stmt: base({ context: { contextAgents: [{ agent: AGENT, relevantTypes: ['https://example.org/roles/teacher'] }] } }), conforms: false, fault: 'ContextAgentShape' },
  'a context group without its objectType': { stmt: base({ context: { contextGroups: [{ group: { objectType: 'Group', member: [AGENT] } }] } }), conforms: false, fault: 'ContextGroupShape' },
  'an authority Group that is not an OAuth pair': { stmt: base({ authority: { objectType: 'Group', mbox: 'mailto:g@example.org' } }), conforms: false, jsonOnly: 'an authority Group must be anonymous, of exactly two Agents (§5.2.2.1)' },
};
