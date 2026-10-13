/**
 * The JSON-LD 1.1 context that gives an xAPI 2.0 statement its RDF reading in the Foxxi xAPI
 * ontology — so the SHACL shapes the ontology publishes have something to check.
 *
 * ★ A STATEMENT IS JSON, AND THE SHAPES CONSTRAIN RDF. The ontology's shapes were written for nodes
 * typed with its classes, and nothing produced such nodes: no context read a statement into this
 * vocabulary, `objectType` was a literal property, and a statement, its verb, its result and its
 * context are never typed in xAPI at all. So a SHACL processor given a statement found no focus node,
 * and passed anything. This context reads a statement as it arrives (IEEE 9274.1.1-2023, §5.2) into
 * the ontology's terms, and the shapes now select what it produces: by class where xAPI types a node
 * (objectType is read as rdf:type), by the property that reaches it where xAPI does not.
 *
 * ★ `id` MEANS FOUR THINGS IN xAPI, and each is read as what it is: a Statement's or a Statement
 * Reference's UUID is the xapi:id literal; an Activity's and a Verb's id is the node's IRI (inside
 * `object`, `verb` and the context activities, by property-scoped contexts, JSON-LD 1.1 §4.1.8); an
 * interaction component's is its xapi:componentId. A Statement Reference, and a Sub-Statement — which
 * must not have an id, so one it carries is read as a literal its shape can refuse — set it back by
 * type-scoped contexts, which JSON-LD applies after the property-scoped one.
 *
 * ★ LANGUAGE MAPS are @language containers: each entry is one language-tagged string. Timestamps are
 * xsd:dateTime, IRIs that are values (mbox, openid, homePage, moreInfo, fileUrl) xsd:anyURI, and the
 * IRIs that name things (an activity type, a usage type, a relevant type) node references.
 *
 * ★ WHAT HAS NO READING. An extension's value is read when it is a string, a number, a boolean, a
 * list of them, or an object keyed by IRIs; a JSON object keyed by plain names has none — xAPI leaves
 * its structure to whoever controls the extension IRI, and no context can name its keys — so a
 * processor in safe mode refuses a statement that carries one, and any other drops it.
 */
import { ns } from '../spec-ontology.js';
import { XAPI_MODEL, XAPI_CONTEXT_URL } from './xapi.model.js';

export { XAPI_CONTEXT_URL };

const XSD = 'http://www.w3.org/2001/XMLSchema#';

/** The context as it is served and archived: indented JSON, one trailing newline. */
export const renderXapiContext = (): string => `${JSON.stringify(xapiJsonLdContext(), null, 2)}\n`;

export function xapiJsonLdContext(): Record<string, unknown> {
  const lang = (term: string) => ({ '@id': `xapi:${term}`, '@container': '@language' });
  const anyUri = (term: string) => ({ '@id': `xapi:${term}`, '@type': 'xsd:anyURI' });
  const ref = (term: string) => ({ '@id': `xapi:${term}`, '@type': '@id' });
  /** An interaction component list: each component's id is its component id, its description a language map. */
  const components = (term: string) => ({ '@id': `xapi:${term}`, '@container': '@set', '@context': { id: 'xapi:componentId', description: lang('description') } });
  /** A context-activities list: Activities, each named by its id. */
  const activities = (term: string) => ({ '@id': `xapi:${term}`, '@container': '@set', '@context': { id: '@id' } });
  return {
    '@context': {
      '@version': 1.1,
      xapi: ns(XAPI_MODEL),
      xsd: XSD,
      // The object types are the ontology's classes.
      objectType: '@type',
      Agent: 'xapi:Agent',
      Group: 'xapi:Group',
      Activity: 'xapi:Activity',
      StatementRef: { '@id': 'xapi:StatementRef', '@context': { id: 'xapi:id' } },
      SubStatement: { '@id': 'xapi:SubStatement', '@context': { id: 'xapi:id' } },
      contextAgent: 'xapi:ContextAgent',
      contextGroup: 'xapi:ContextGroup',
      // Statement
      id: 'xapi:id',
      actor: 'xapi:actor',
      verb: { '@id': 'xapi:verb', '@context': { id: '@id', display: lang('display') } },
      object: { '@id': 'xapi:object', '@context': { id: '@id' } },
      result: 'xapi:result',
      context: 'xapi:context',
      timestamp: { '@id': 'xapi:timestamp', '@type': 'xsd:dateTime' },
      stored: { '@id': 'xapi:stored', '@type': 'xsd:dateTime' },
      authority: 'xapi:authority',
      version: 'xapi:version',
      attachments: {
        '@id': 'xapi:attachments', '@container': '@set',
        '@context': { usageType: ref('usageType'), display: lang('display'), description: lang('description'), fileUrl: anyUri('fileUrl') },
      },
      contentType: 'xapi:contentType',
      length: 'xapi:length',
      sha2: 'xapi:sha2',
      // Agents and Groups
      name: 'xapi:name',
      mbox: anyUri('mbox'),
      mbox_sha1sum: 'xapi:mbox_sha1sum',
      openid: anyUri('openid'),
      account: { '@id': 'xapi:account', '@context': { homePage: anyUri('homePage') } },
      member: { '@id': 'xapi:member', '@container': '@set' },
      // Activity definitions
      definition: {
        '@id': 'xapi:definition',
        '@context': {
          name: lang('name'), description: lang('description'),
          type: ref('type'), moreInfo: anyUri('moreInfo'),
          interactionType: 'xapi:interactionType',
          correctResponsesPattern: { '@id': 'xapi:correctResponsesPattern', '@container': '@set' },
          choices: components('choices'), scale: components('scale'), source: components('source'),
          target: components('target'), steps: components('steps'),
        },
      },
      // Result
      score: 'xapi:score',
      scaled: 'xapi:scaled',
      raw: 'xapi:raw',
      min: 'xapi:min',
      max: 'xapi:max',
      success: 'xapi:success',
      completion: 'xapi:completion',
      response: 'xapi:response',
      duration: 'xapi:duration',
      extensions: 'xapi:extensions',
      // Context
      registration: 'xapi:registration',
      instructor: 'xapi:instructor',
      team: 'xapi:team',
      contextActivities: {
        '@id': 'xapi:contextActivities',
        '@context': { parent: activities('parent'), grouping: activities('grouping'), category: activities('category'), other: activities('other') },
      },
      contextAgents: { '@id': 'xapi:contextAgents', '@container': '@set', '@context': { relevantTypes: { ...ref('relevantTypes'), '@container': '@set' } } },
      contextGroups: { '@id': 'xapi:contextGroups', '@container': '@set', '@context': { relevantTypes: { ...ref('relevantTypes'), '@container': '@set' } } },
      agent: 'xapi:agent',
      group: 'xapi:group',
      revision: 'xapi:revision',
      platform: 'xapi:platform',
      language: { '@id': 'xapi:language', '@type': 'xsd:language' },
      statement: 'xapi:statement',
    },
  };
}
