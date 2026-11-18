/**
 * Descriptors served to both hypermedia clients, the page (tests/hypermedia-client-rendering.test.ts)
 * and hmc.py (tests/hypermedia-client-cli.test.ts), so each case is one document read by both. Each
 * is valid JSON-LD that a client once read differently from jsonld.js, or that held a request
 * problem, and is named for what it exercises. `base` is the origin the test serves them from.
 */
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const SH = 'http://www.w3.org/ns/shacl#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const DCT = 'http://purl.org/dc/terms/';
const DCAT = 'http://www.w3.org/ns/dcat#';
const HYDRA_CONTEXT = 'http://www.w3.org/ns/hydra/context.jsonld';
const CTX = { hydra: HYDRA, iep: IEP, sh: SH, xsd: XSD, rdf: RDF, rdfs: RDFS, dct: DCT, dcat: DCAT };

/** An affordance written in place: `#id`, its action, a method when it has one, a title, and more. */
function op(id: string, action: string, method: string | null, title: string, extra: Record<string, unknown> = {}) {
  return { '@id': `#${id}`, '@type': 'iep:Affordance', 'iep:action': { '@id': action },
    ...(method ? { 'hydra:method': method } : {}), 'hydra:title': title, ...extra };
}
const target = (path: string) => ({ 'hydra:target': { '@id': path } });
/** Arrays nested `depth` deep: [] is 1, [[]] is 2. */
export function nested(depth: number): unknown[] {
  let value: unknown[] = [];
  for (let i = 1; i < depth; i++) value = [value];
  return value;
}
/** The XSD 1.1 date and time datatypes each client checks, by local name. */
export const TEMPORAL_TYPES = ['date', 'dateTime', 'dateTimeStamp', 'time', 'gYear', 'gYearMonth', 'gMonth', 'gDay', 'gMonthDay',
  'duration', 'yearMonthDuration', 'dayTimeDuration'] as const;
/** An affordance that sends to /num-target and expects a JSON Schema object with these properties. */
const schemaOp = (id: string, action: string, method: string, title: string, properties: Record<string, unknown>) =>
  op(id, action, method, title, { ...target('/num-target'), 'hydra:expects': { type: 'object', properties } });
/** A GET to /api written in place with no "@id", as a container term's single value. */
const inline = (action: string, title: string) => ({ '@type': 'hydra:Operation', 'iep:action': { '@id': action }, 'hydra:method': 'GET',
  'hydra:title': title, ...target('/api') });

/**
 * A context of 3,000 terms and 80 nested classes under it, the last with a GET to /api: each class
 * typed with a type-scoped context, or each the value of a term with a property-scoped one.
 */
function deepScoped(base: string, path: string, scoped: 'type' | 'property') {
  const terms = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`t${i}`, `urn:t:${i}`]));
  const local = { home: { '@id': 'urn:x:home', '@type': '@id' } };
  const read = { '@type': 'hydra:Operation', 'iep:action': { '@id': `urn:deep:${scoped}` }, 'hydra:method': 'GET',
    'hydra:title': `Deep ${scoped} read`, 'hydra:target': { '@id': '/api' } };
  const key = scoped === 'type' ? 'hydra:supportedClass' : 'member';
  let level: Record<string, unknown> = { '@type': scoped === 'type' ? 'Catalog' : 'hydra:Class', home: '/home', 'hydra:supportedOperation': [read] };
  for (let i = 0; i < 80; i++) level = { '@type': scoped === 'type' ? 'Catalog' : 'hydra:Class', home: '/home', [key]: level };
  const term = scoped === 'type' ? { Catalog: { '@id': 'urn:x:Catalog', '@context': local } }
    : { member: { '@id': 'hydra:supportedClass', '@context': local } };
  return { '@context': { ...CTX, ...terms, ...term }, '@id': `${base}${path}`, [key]: level };
}

/**
 * How an invoke of one /outcomes control ends, read from what the host received and answered:
 *   - `answer`: the request got this final answer, from the address it was sent to, or from
 *     `landed` when a GET or HEAD followed a redirect there, by way of each address in `via` in turn;
 *   - `redirect`: the address answered with this redirect, and the request was not sent again,
 *     to its Location (a path on the host, an absolute URL, or null for an empty one) or as a GET;
 *   - `refused`: a GET's redirect to this address, which neither client sends to: no answer;
 *   - `backslash`: a GET's redirect whose Location, given here, holds a backslash. hmc.py refuses
 *     it, as it refuses such an address, and sends nothing there; the page's browser reads the
 *     backslash as a slash and lands at `landed` (resolved against the host), which answers `answer`;
 *   - `loop`: a GET's or HEAD's redirect into a loop, along LOOP. The host receives the request this
 *     many times, 20 redirects followed and the 21st not, as fetch follows them: no answer.
 * `landed` is written as fetch writes a response's url: no fragment, and `{`, `}` and the backtick
 * percent-encoded.
 */
export type InvokeEnd =
  | { readonly answer: number; readonly landed?: string; readonly via?: readonly string[] }
  | { readonly redirect: 301 | 302 | 303 | 307 | 308; readonly location: string | null }
  | { readonly refused: string }
  | { readonly backslash: string; readonly landed: string; readonly answer: number }
  | { readonly loop: number };
/**
 * Where a loop row's request goes: the address it is sent to redirects to the second, and the second
 * and the third each to the other, so the 21st request goes to another address than the first.
 */
const LOOP = ['/answer/loop', '/answer/loop-a', '/answer/loop-b'] as const;
/**
 * The /outcomes controls, as [title, method, the /answer/ address it sends to, how it ends, and
 * whether the document marks it destructive]. A write is confirmed and sends a body; GET and HEAD
 * are safe, OPTIONS too, but only GET and HEAD follow a redirect.
 */
const OUTCOMES: ReadonlyArray<readonly [title: string, method: string, answer: string, end: InvokeEnd, destructive?: true]> = [
  ...(['POST', 'PUT', 'PATCH', 'DELETE'] as const).flatMap(method => ([307, 308] as const).map(status =>
    [`${method} ${status}`, method, `${status}`, { redirect: status, location: '/landing' }] as const)),
  ...([301, 302, 303] as const).map(status => [`POST ${status}`, 'POST', `${status}`, { redirect: status, location: '/landing' }] as const),
  // fetch turns only a POST into a GET on a 301 or 302, and anything but a GET or HEAD on a 303.
  ['PUT 302', 'PUT', '302', { redirect: 302, location: '/landing' }],
  ['DELETE 303', 'DELETE', '303', { redirect: 303, location: '/landing' }],
  ['Destructive GET 302', 'GET', '302', { redirect: 302, location: '/landing' }, true],
  ['OPTIONS 303', 'OPTIONS', '303', { redirect: 303, location: '/landing' }],
  ['POST to ftp', 'POST', 'to-ftp', { redirect: 307, location: 'ftp://127.0.0.1:9/x' }],
  ['POST empty Location', 'POST', 'empty', { redirect: 307, location: null }],
  // A GET or HEAD is the same request on every hop, whatever the redirect status, as fetch sends it:
  // a HEAD is never turned into a GET, which would download the body it did not ask for. Chained,
  // each redirect keeps it, and 20 are followed and the 21st is not.
  ...(['GET', 'HEAD'] as const).flatMap(method => ([301, 302, 303, 307, 308] as const).map(status =>
    [`${method} ${status}`, method, `${status}`, { answer: 200, landed: '/landing' }] as const)),
  ...(['GET', 'HEAD'] as const).flatMap(method => [
    [`${method} chain`, method, 'chain', { answer: 200, landed: '/landing', via: ['/answer/307'] }],
    [`${method} loop`, method, 'loop', { loop: 21 }]] as const),
  // A host that answers a HEAD with a body all the same: a HEAD's answer has none, in both clients.
  ['HEAD body anyway', 'HEAD', 'to-body', { answer: 200, landed: '/landing-body' }],
  // A redirect whose own body never ends is followed on its headers, as fetch follows it.
  ['GET unending redirect', 'GET', 'unending', { answer: 200, landed: '/landing' }],
  // Nor is the body of a redirect a request does not follow read: it is the answer, on its headers.
  ['POST unending redirect', 'POST', 'unending', { redirect: 302, location: '/landing' }],
  ['OPTIONS unending redirect', 'OPTIONS', 'unending', { redirect: 302, location: '/landing' }],
  ['Destructive GET unending redirect', 'GET', 'unending', { redirect: 302, location: '/landing' }, true],
  ['GET to ftp', 'GET', 'to-ftp', { refused: 'ftp://127.0.0.1:9/x' }],
  ['GET empty Location', 'GET', 'empty', { answer: 307 }],
  // A Location fetch writes otherwise than its text: a fragment, which a response's url drops, and
  // characters it percent-encodes; and one with a backslash, which a browser reads as a slash.
  ['GET fragment Location', 'GET', 'fragment', { answer: 200, landed: '/landing' }],
  ['HEAD odd Location', 'HEAD', 'odd', { answer: 200, landed: '/landing%7B%60%7D' }],
  ['GET backslash path', 'GET', 'backslash-path', { backslash: '/landing\\b', landed: '/landing/b', answer: 404 }],
  ['GET backslash host', 'GET', 'backslash-host', { backslash: '\\\\other.example/x', landed: 'https://other.example/x', answer: 404 }],
  ['GET 404 HTML', 'GET', '404-html', { answer: 404 }],
  ...(['POST', 'GET'] as const).flatMap(method => [200, 300, 404, 500].map(status => [`${method} ${status}`, method, `${status}`, { answer: status }] as const)),
];
const outcomeSlug = (title: string) => title.toLowerCase().replace(/ /g, '-');
const outcomeRel = (title: string) => `urn:outcome:${outcomeSlug(title)}`;
/** What every safe /outcomes control returns, so each of its requests asks for it in Accept. */
const OUTCOME_MEDIA = 'text/plain';
function outcomesDescriptor(base: string) {
  const note = { 'hydra:expects': { type: 'object', properties: { note: { type: 'string', default: 'once' } } } };
  return { '@context': CTX, '@id': `${base}/outcomes`, 'iep:affordance': OUTCOMES.map(([title, method, answer, , destructive]) =>
    op(outcomeSlug(title), outcomeRel(title), method, title, { ...target(`/answer/${answer}`),
      ...(['GET', 'HEAD', 'OPTIONS'].includes(method) ? { 'dcat:mediaType': OUTCOME_MEDIA } : note),
      ...(destructive ? { 'iep:destructiveHint': true } : {}) })) };
}

/** Each path's document as the text served. */
/** A shape whose one property, status, takes one value and has these facets as well. */
const statusShape = (facets: Record<string, unknown>) => ({ '@type': 'sh:NodeShape',
  'sh:property': { 'sh:path': { '@id': 'urn:p:status' }, 'sh:name': 'status', 'sh:maxCount': 1, ...facets } });
/**
 * The shapes /empty-lists names, as [id, the action of the control that expects it, its title, the
 * shape]: lists given empty, written each way JSON-LD may write one (a list object, an array,
 * rdf:nil compact and full, and a list of nulls JSON-LD drops), and zeros a falsy test would skip.
 */
const EMPTY_SHAPES: ReadonlyArray<readonly [id: string, rel: string, title: string, shape: Record<string, unknown>]> = [
  ['IL', 'urn:empty:in-list', 'Empty in list', statusShape({ 'sh:in': { '@list': [] } })],
  ['IA', 'urn:empty:in-array', 'Empty in array', statusShape({ 'sh:in': [] })],
  ['IN', 'urn:empty:in-nil', 'Empty in nil', statusShape({ 'sh:in': { '@id': 'rdf:nil' } })],
  ['IF', 'urn:empty:in-nil-full', 'Empty in full nil', statusShape({ 'sh:in': { '@id': `${RDF}nil` } })],
  ['IU', 'urn:empty:in-nulls', 'Empty in of nulls', statusShape({ 'sh:in': { '@list': [null] } })],
  ['ID', 'urn:empty:in-default', 'Empty in default', statusShape({ 'sh:in': { '@list': [] }, 'sh:defaultValue': 'x' })],
  ['IR', 'urn:empty:in-required', 'Empty in required', statusShape({ 'sh:in': { '@list': [] }, 'sh:minCount': 1 })],
  ['IH', 'urn:empty:in-has-value', 'Empty in has value', statusShape({ 'sh:in': { '@list': [] }, 'sh:hasValue': 'a' })],
  ['IM', 'urn:empty:in-many', 'Empty in list field', { '@type': 'sh:NodeShape',
    'sh:property': { 'sh:path': { '@id': 'urn:p:status' }, 'sh:name': 'status', 'sh:in': { '@list': [] } } }],
  ['IX', 'urn:empty:in-integer', 'Empty in integer', statusShape({ 'sh:in': [], 'sh:datatype': { '@id': 'xsd:integer' } })],
  ['IB', 'urn:empty:in-body', 'Empty in body', { '@type': 'sh:NodeShape', 'sh:in': { '@list': [] } }],
  ['HC', 'urn:empty:in-class', 'Empty in class', { '@type': 'hydra:Class',
    'hydra:supportedProperty': { 'hydra:property': { '@id': 'urn:p:status' }, 'sh:maxCount': 1, 'sh:in': { '@list': [] } } }],
  ['HR', 'urn:empty:in-class-required', 'Empty in required class', { '@type': 'hydra:Class',
    'hydra:supportedProperty': { 'hydra:property': { '@id': 'urn:p:status' }, 'sh:maxCount': 1, 'hydra:required': true, 'sh:in': [] } }],
  ['OL', 'urn:empty:or-list', 'Empty or', statusShape({ 'sh:or': { '@list': [] } })],
  ['OA', 'urn:empty:or-array', 'Empty or array', statusShape({ 'sh:or': [] })],
  ['XA', 'urn:empty:xone-array', 'Empty xone', statusShape({ 'sh:xone': [] })],
  ['LA', 'urn:empty:language-array', 'Empty languageIn', statusShape({ 'sh:languageIn': [] })],
  ['LN', 'urn:empty:language-nil', 'Empty languageIn nil', statusShape({ 'sh:languageIn': { '@id': 'rdf:nil' } })],
  ['OR', 'urn:empty:or-required', 'Empty or required', statusShape({ 'sh:or': { '@list': [] }, 'sh:minCount': 1 })],
  ['AL', 'urn:empty:and-list', 'Empty and', statusShape({ 'sh:and': { '@list': [] } })],
  ['AN', 'urn:empty:and-nil', 'Empty and nil', statusShape({ 'sh:and': { '@id': 'rdf:nil' } })],
  ['NO', 'urn:empty:node-or', 'Shape empty or', { ...statusShape({}), 'sh:or': [] }],
  ['NA', 'urn:empty:node-and', 'Shape empty and', { ...statusShape({}), 'sh:and': { '@list': [] } }],
  ['ZR', 'urn:empty:zero-required', 'Required none', statusShape({ 'sh:maxCount': 0, 'sh:minCount': 1 })],
  ['PA', 'urn:empty:property-array', 'No properties listed', { '@type': 'sh:NodeShape', 'sh:property': [] }],
  ['SA', 'urn:empty:supported-array', 'No supported properties listed', { '@type': 'hydra:Class', 'hydra:supportedProperty': [] }],
  ['ML', 'urn:empty:max-length-zero', 'Length zero', statusShape({ 'sh:maxLength': 0 })],
  ['MZ', 'urn:empty:max-zero', 'Bound zero', statusShape({ 'sh:maxInclusive': 0, 'sh:datatype': { '@id': 'xsd:integer' } })],
  ['DZ', 'urn:empty:default-zero', 'Default zero', statusShape({ 'sh:defaultValue': 0, 'sh:datatype': { '@id': 'xsd:integer' } })],
];

export function sharedDescriptors(base: string): Record<string, string> {
  const docs: Record<string, unknown> = {
    // A GET marked destructive in four ways a client once missed: the MCP annotations shape nested
    // with @nest, a term written with a prefix the context defines after it, a node's own @context,
    // and an annotations object no context describes. The one plain read stays a safe read.
    '/hints': {
      '@context': { ...CTX, annotations: '@nest', readOnlyHint: 'iep:readOnlyHint', destructiveHint: 'iep:destructiveHint',
        late: 'i:destructiveHint', i: IEP },
      '@id': `${base}/hints`,
      'iep:affordance': [
        op('purge', 'iep:purge', 'GET', 'Purge cache', { ...target('/purge'), annotations: { readOnlyHint: false, destructiveHint: true } }),
        op('late', 'iep:late', 'GET', 'Late prefix', { ...target('/purge'), late: true }),
        { '@context': { x: IEP }, ...op('embedded', 'iep:embedded', 'GET', 'Own context', { ...target('/purge'), 'x:destructiveHint': true }) },
        op('mcp', 'iep:mcp', 'GET', 'Bare annotations', { ...target('/purge'), mcp: { destructiveHint: true } }),
        op('read', 'iep:read', 'GET', 'Plain read', target('/api')),
      ],
    },
    // Keyword aliases, as schema.org, ActivityStreams and DID contexts define them.
    '/alias': {
      '@context': { ...CTX, id: '@id', type: '@type' },
      '@graph': [
        { id: `${base}/alias`, 'iep:affordance': { id: '#search' } },
        { id: '#search', type: 'hydra:Operation', 'iep:action': { id: 'iep:aliasSearch' }, 'hydra:method': 'GET',
          'hydra:title': 'Aliased search', 'hydra:target': { id: '/api' }, 'hydra:expects': { id: '#S' } },
        { id: '#S', type: 'sh:NodeShape', 'sh:property': { 'sh:path': { id: `${base}/q` }, 'sh:name': 'q',
          'sh:datatype': { id: 'xsd:integer' }, 'sh:minCount': 1, 'sh:maxCount': 1 } },
      ],
    },
    '/alias-graph': { '@context': { ...CTX, graph: '@graph' }, graph: [
      { '@id': `${base}/alias-graph`, 'iep:affordance': { '@id': '#a' } }, op('a', 'iep:aliasGraph', 'GET', 'Graph alias read', target('/api'))] },
    // Term definitions with no "@id", which take their IRI from @vocab.
    '/typeonly': {
      '@context': { '@vocab': HYDRA, iep: IEP, sh: SH, xsd: XSD, target: { '@type': '@id' }, expects: { '@type': '@id' } },
      '@id': `${base}/typeonly`,
      'iep:affordance': [{ '@id': '#get', '@type': 'Operation', 'iep:action': { '@id': 'iep:typeOnly' }, method: 'GET',
        title: 'Type-only terms', target: '/api', expects: '#S' }],
      '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': `${base}/n` }, 'sh:name': 'n',
        'sh:datatype': { '@id': 'xsd:integer' }, 'sh:maxCount': 1 } }],
    },
    // Nodes in a named graph, in @included, and in @index and @id maps.
    '/named-graph': { '@context': CTX, '@graph': [{ '@id': 'urn:g:1', '@graph': [
      { '@id': `${base}/named-graph`, 'iep:affordance': { '@id': '#a' } }, op('a', 'iep:named', 'GET', 'Named graph read', target('/api'))] }] },
    '/included': { '@context': CTX, '@id': `${base}/included`, 'iep:affordance': { '@id': '#a' },
      '@included': [op('a', 'iep:included', 'GET', 'Included read', target('/api'))] },
    '/index-map': { '@context': { ...CTX, affordances: { '@id': 'iep:affordance', '@container': '@index' } }, '@id': `${base}/index-map`,
      affordances: { search: op('a', 'iep:indexMap', 'GET', 'Index map read', target('/api')) } },
    '/id-map': { '@context': { ...CTX, affordances: { '@id': 'iep:affordance', '@container': '@id' } }, '@id': `${base}/id-map`,
      affordances: { '#a': { '@type': 'iep:Affordance', 'iep:action': { '@id': 'iep:idMap' }, 'hydra:method': 'GET',
        'hydra:title': 'Id map read', ...target('/api') } } },
    // A JSON Schema given as a JSON literal value object.
    '/json-value': { '@context': CTX, '@id': `${base}/json-value`, 'iep:affordance': [op('w', 'iep:jsonValue', 'POST', 'JSON value write', {
      ...target('/num-target'), 'hydra:expects': { '@type': '@json', '@value': { type: 'object', required: ['name'],
        properties: { name: { type: 'string' }, count: { type: 'integer' } } } } })] },
    // "@vocab": "#", the document's own fragment namespace, and actions written as vocabulary terms
    // whose names are also the clients' own property names, and as a urn prefix.
    '/vocab-hash': { '@context': { ...CTX, '@vocab': '#', act: { '@id': 'iep:action', '@type': '@vocab' } }, '@id': `${base}/vocab-hash`,
      'iep:affordance': [{ '@id': '#op', '@type': 'hydra:Operation', act: 'publish', 'hydra:method': 'POST', 'hydra:title': 'Vocab hash publish',
        'hydra:target': { '@id': 'https://relay.interego.example/tool/publish_context' } }] },
    '/actions': {
      '@context': { ...CTX, '@vocab': 'https://vocab.example/actions#', action: { '@id': 'iep:action', '@type': '@vocab' }, act: 'urn:example:action:' },
      '@id': `${base}/actions`,
      'iep:affordance': [
        { '@id': '#s', '@type': 'iep:Affordance', action: 'search', 'hydra:method': 'GET', 'hydra:title': 'Vocab search',
          'hydra:target': { '@id': 'https://relay.interego.example/tool/x' } },
        { '@id': '#c', '@type': 'iep:Affordance', action: 'comment', 'hydra:method': 'POST', 'hydra:title': 'Vocab comment',
          'hydra:target': { '@id': 'https://relay.interego.example/tool/y' } },
        { '@id': '#u', '@type': 'iep:Affordance', 'iep:action': { '@id': 'act:lookup' }, 'hydra:method': 'GET', 'hydra:title': 'Urn lookup',
          'hydra:target': { '@id': 'https://relay.interego.example/tool/z' } },
      ],
    },
    // Relative IRI templates, against the document's address and against an @base, and RFC 6570's
    // prefix modifier.
    '/tmpl/desc': { '@context': CTX, '@id': `${base}/tmpl/desc`, 'iep:affordance': [
      op('s', 'iep:relSearch', 'GET', 'Relative search', { 'hydra:search': { '@type': 'hydra:IriTemplate', 'hydra:template': '/search{?q}',
        'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:required': true }] } }),
      op('i', 'iep:relItems', 'GET', 'Relative items', { 'hydra:template': 'items/{id}',
        'hydra:mapping': [{ 'hydra:variable': 'id', 'hydra:required': true }, { 'hydra:variable': 'limit' }] }),
      op('p', 'iep:prefixShard', 'GET', 'Prefix shard', { 'hydra:template': 'shard/{id:2}/{id}',
        'hydra:mapping': [{ 'hydra:variable': 'id', 'hydra:required': true }] }),
    ] },
    // hydra:required read as a boolean field's value is: trimmed of space, tab, CR and LF and of
    // nothing else, and a JSON 1.0 (put in the text below) as 1.
    '/required-text': { '@context': CTX, '@id': `${base}/required-text`, 'iep:affordance': [
      ...([['spaced', ' true\t'], ['whole', 'REQUIRED-ONE'], ['nbsp', '\u00a0true']] as const).map(([name, required]) =>
        op(name, `urn:required:${name}`, 'GET', `Required ${name}`, { 'hydra:template': '/api{?q}',
          'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:required': required }] })),
    ] },
    '/tmpl-base': { '@context': [CTX, { '@base': 'https://api.example/v1/' }], '@id': `${base}/tmpl-base`, 'iep:affordance': [
      op('t', 'iep:baseItems', 'GET', 'Based items', { 'hydra:template': 'items{?q}', 'hydra:mapping': [{ 'hydra:variable': 'q' }] })] },
    // A flattened document, as jsonld.js writes one from RDF: a blank property shape sorts first.
    '/flat': { '@context': CTX, '@graph': [
      { '@id': '_:p1', 'sh:path': { '@id': `${base}/q` }, 'sh:name': 'q', 'sh:datatype': { '@id': 'xsd:integer' }, 'sh:maxCount': 1 },
      { '@id': `${base}/flat`, 'dct:title': 'Glossary catalog', 'rdfs:seeAlso': { '@id': `${base}/next` }, 'iep:affordance': { '@id': `${base}/flat#search` } },
      { '@id': `${base}/flat#S`, '@type': 'sh:NodeShape', 'sh:property': { '@id': '_:p1' } },
      { '@id': `${base}/flat#search`, '@type': 'iep:Affordance', 'iep:action': { '@id': 'iep:flatSearch' }, 'hydra:method': 'GET',
        'hydra:title': 'Flat search', 'hydra:target': { '@id': `${base}/api` }, 'hydra:expects': { '@id': `${base}/flat#S` } },
    ] },
    // Two template mappings with no hydra:property, as Interego's decorations write them.
    '/mappings': { '@context': CTX, '@id': `${base}/mappings`, 'iep:affordance': [op('d', 'urn:delete-item', 'DELETE', 'Delete item', {
      'hydra:search': { '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/items/{id}{?force}`,
        'hydra:mapping': [{ 'hydra:variable': 'id', 'hydra:required': true }, { 'hydra:variable': 'force', 'hydra:required': false }] } })] },
    // Templates whose host a variable straight after it could extend, and one whose host is fixed.
    '/dest': { '@context': CTX, '@id': `${base}/dest`, 'iep:affordance': [
      op('n', 'iep:destNote', 'POST', 'Post note', { 'hydra:search': { '@type': 'hydra:IriTemplate',
        'hydra:template': 'https://relay.good.example{+path}', 'hydra:mapping': [{ 'hydra:variable': 'path', 'hydra:required': true }] } }),
      op('f', 'iep:destFixed', 'POST', 'Fixed host note', { 'hydra:search': { '@type': 'hydra:IriTemplate',
        'hydra:template': 'https://relay.good.example/{+path}', 'hydra:mapping': [{ 'hydra:variable': 'path', 'hydra:required': true }] } }),
    ] },
    // A hydra:IriTemplate as the hydra:target, as Interego's decoration catalogs write one.
    '/target-template': { '@context': CTX, '@graph': [
      { '@id': `${base}/target-template`, 'iep:affordance': { '@id': `${base}/target-template#control-about` } },
      { '@id': `${base}/target-template#control-about`, '@type': ['iep:Affordance', 'hydra:Operation'], 'hydra:method': 'GET',
        'dct:title': 'Read what the LRS supports', 'hydra:target': { '@id': '_:b0' } },
      { '@id': '_:b0', '@type': 'hydra:IriTemplate', 'hydra:template': '{+endpoint}/about', 'hydra:mapping': { '@id': '_:b1' } },
      { '@id': '_:b1', '@type': 'hydra:IriTemplateMapping', 'hydra:variable': 'endpoint', 'hydra:required': true },
    ] },
    // A body sent whole from one field: a SPARQL query by GET and by POST, and a note by PUT.
    '/raw': { '@context': CTX, '@id': `${base}/raw`, 'iep:affordance': [
      op('qg', 'iep:sparqlGet', 'GET', 'SPARQL get', { ...target('/sparql'), 'dcat:mediaType': 'application/sparql-results+json', 'hydra:expects': { '@id': '#Q' } }),
      op('qp', 'iep:sparqlPost', 'POST', 'SPARQL post', { ...target('/sparql'), 'dcat:mediaType': 'application/sparql-results+json', 'hydra:expects': { '@id': '#Q' } }),
      op('np', 'iep:notePut', 'PUT', 'Note put', { ...target('/notes/1'), 'hydra:returnsContentType': 'text/turtle', 'hydra:expects': { '@id': '#N' } }),
    ], '@graph': [
      { '@id': '#Q', '@type': 'sh:NodeShape', 'rdfs:label': 'SPARQL query', 'sh:datatype': { '@id': 'xsd:string' } },
      { '@id': '#N', '@type': 'sh:NodeShape', 'rdfs:label': 'Note text', 'sh:datatype': { '@id': 'xsd:string' } },
    ] },
    // An affordance with no hydra:method, which the substrate's own follower sends as POST.
    '/no-method': { '@context': CTX, '@id': `${base}/no-method`, 'iep:affordance': [op('p', 'urn:publish-note', null, 'Publish note', {
      ...target('/publish'), 'hydra:expects': { type: 'object', properties: { graph_content: { type: 'string', default: 'private draft text' } } } })] },
    // A target with a non-ASCII character, a target whose query names a field, and number fields in a URL.
    '/wiki': { '@context': CTX, '@id': `${base}/wiki`, 'iep:affordance': [op('w', 'urn:wiki', 'GET', 'Wiki page', target('/wiki/Café'))] },
    '/merge': { '@context': CTX, '@id': `${base}/merge`, 'iep:affordance': [op('m', 'urn:merge', 'GET', 'Merge query', {
      ...target('/items?tag=all&view=full'), 'hydra:expects': { type: 'object', properties: { tag: { type: 'array' }, view: { type: 'string' } } } })] },
    '/rates': { '@context': CTX, '@id': `${base}/rates`, 'iep:affordance': [op('r', 'urn:rates', 'GET', 'Rates', {
      'hydra:search': { '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/rates/{amount}{?lat,big}`,
        'hydra:mapping': [{ 'hydra:variable': 'amount', 'hydra:required': true }, { 'hydra:variable': 'lat' }, { 'hydra:variable': 'big' }] },
      'hydra:expects': { type: 'object', properties: { amount: { type: 'number' }, lat: { type: 'number' }, big: { type: 'number' } } } })] },
    // A write whose shape has list properties, as the I2IDL catalog's conforms_to_shapes is: a
    // property with no sh:maxCount, one bounded 2 to 5, and an integer list with sh:in.
    '/multi': { '@context': { ...CTX, cat: `${base}/cat#` }, '@id': `${base}/multi`,
      'iep:affordance': [op('p', 'urn:act-publish', 'POST', 'Publish classified', { ...target('/num-target'), 'hydra:expects': { '@id': '#S' } })],
      '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'cat:graph_iri' }, 'sh:name': 'graph_iri', 'sh:datatype': { '@id': 'xsd:string' }, 'sh:minCount': 1, 'sh:maxCount': 1 },
        { 'sh:path': { '@id': 'cat:conforms_to_shapes' }, 'sh:name': 'conforms_to_shapes', 'sh:datatype': { '@id': 'xsd:string' },
          'sh:minCount': 1, 'sh:defaultValue': `${base}/shapes` },
        { 'sh:path': { '@id': 'cat:tags' }, 'sh:name': 'tags', 'sh:datatype': { '@id': 'xsd:string' }, 'sh:minCount': 2, 'sh:maxCount': 5 },
        { 'sh:path': { '@id': 'cat:levels' }, 'sh:name': 'levels', 'sh:datatype': { '@id': 'xsd:integer' }, 'sh:in': { '@list': [1, 2, 3] } },
      ] }] },
    // Hydra's own way to describe an input: a class with hydra:supportedProperty, by property IRI
    // (Hydra's ApiDocumentation) and by an inline rdf:Property with a label (Interego's manifests).
    '/apidoc': { '@context': { hydra: HYDRA, schema: 'https://schema.org/', xsd: XSD }, '@id': `${base}/apidoc`, '@type': 'hydra:ApiDocumentation',
      'hydra:supportedClass': [{ '@id': `${base}/apidoc#Comment`, '@type': 'hydra:Class', 'hydra:title': 'Comment',
        'hydra:supportedProperty': [
          { '@type': 'hydra:SupportedProperty', 'hydra:property': { '@id': 'schema:text' }, 'hydra:required': true },
          { '@type': 'hydra:SupportedProperty', 'hydra:property': { '@id': 'schema:author' }, 'hydra:required': false },
        ],
        'hydra:supportedOperation': [{ '@id': `${base}/apidoc#post-comment`, '@type': 'hydra:Operation', 'hydra:method': 'POST',
          'hydra:title': 'Post a comment', 'hydra:target': { '@id': `${base}/num-target` }, 'hydra:expects': { '@id': `${base}/apidoc#Comment` } }] }] },
    '/manifest': { '@context': CTX, '@id': `${base}/manifest`, 'iep:affordance': [op('n', 'urn:create-note', 'POST', 'Create note', {
      ...target('/num-target'), 'hydra:expects': { '@type': 'hydra:Class', 'rdfs:label': 'create_note-input', 'hydra:supportedProperty': [
        { '@type': 'hydra:SupportedProperty', 'hydra:property': { '@type': 'rdf:Property', 'rdfs:label': 'title' }, 'hydra:required': true,
          'sh:datatype': { '@id': 'xsd:string' } },
        { '@type': 'hydra:SupportedProperty', 'hydra:property': { '@type': 'rdf:Property', 'rdfs:label': 'priority' }, 'hydra:required': false,
          'sh:datatype': { '@id': 'xsd:integer' }, 'sh:minInclusive': 1, 'sh:maxInclusive': 5 },
        { '@type': 'hydra:SupportedProperty', 'hydra:property': { '@type': 'rdf:Property', 'rdfs:label': 'kind' }, 'hydra:required': true,
          'sh:datatype': { '@id': 'xsd:string' }, 'sh:in': { '@list': ['memo', 'todo'] } },
      ] } })] },
    // A template mapping whose hydra:property is a plain compact IRI, which Hydra's context types as
    // @vocab, under that context (which neither client fetches) and an inline prefix.
    '/mapprop': { '@context': [HYDRA_CONTEXT, { sh: SH, schema: 'https://schema.org/', xsd: XSD, iep: IEP }], '@id': `${base}/mapprop`,
      'iep:affordance': [{ '@id': '#find', '@type': 'iep:Affordance', 'iep:action': { '@id': 'iep:find' }, method: 'GET', title: 'Find',
        search: { '@type': 'IriTemplate', template: `${base}/find{?text}`, mapping: [{ variable: 'text', property: 'schema:query', required: true }] },
        expects: { '@id': '#S' } }],
      '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'schema:query' }, 'sh:minCount': 1,
        'sh:maxCount': 1, 'sh:maxLength': 5 } }] },
    // Field names from relative paths with non-ASCII characters, and two paths with one local name.
    '/fiche': { '@context': CTX, '@id': `${base}/fiche`,
      'iep:affordance': [op('f', 'urn:fiche', 'POST', 'Fiche', { ...target('/num-target'), 'hydra:expects': { '@id': '#S' } })],
      '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': '#prénom' }, 'sh:datatype': { '@id': 'xsd:string' }, 'sh:minCount': 1, 'sh:maxCount': 1 },
        { 'sh:path': { '@id': '#âge' }, 'sh:datatype': { '@id': 'xsd:integer' }, 'sh:maxCount': 1 },
      ] }] },
    '/dup': { '@context': { ...CTX, schema: 'https://schema.org/' }, '@id': `${base}/dup`,
      'iep:affordance': [op('d', 'urn:dup', 'POST', 'Two descriptions', { ...target('/num-target'), 'hydra:expects': { '@id': '#S' } })],
      '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'dct:description' }, 'sh:datatype': { '@id': 'xsd:string' }, 'sh:minCount': 1, 'sh:maxCount': 1 },
        { 'sh:path': { '@id': 'schema:description' }, 'sh:datatype': { '@id': 'xsd:string' }, 'sh:maxCount': 1 },
      ] }] },
    // Operations listed under hydra:operation, under Hydra's context, one expecting a class the
    // document does not describe.
    '/events': { '@context': HYDRA_CONTEXT, '@id': `${base}/events`, '@type': 'Collection',
      operation: [{ '@type': 'Operation', method: 'POST', title: 'Create event', expects: 'https://vocab.example/Event' }] },
    // Enums of JSON booleans and an object, and count facets written as 1.0.
    '/bool-enum': { '@context': CTX, '@id': `${base}/bool-enum`, 'iep:affordance': [op('a', 'urn:accept', 'POST', 'Accept terms', {
      ...target('/num-target'), 'hydra:expects': { type: 'object', required: ['agree'],
        properties: { agree: { type: 'boolean', enum: [true] }, mode: { enum: [true, { a: 1 }, 'plain'] } } } })] },
    '/mincount': { '@context': CTX, '@id': `${base}/mincount`,
      'iep:affordance': [op('m', 'urn:mincount', 'POST', 'Count facets', { ...target('/num-target'), 'hydra:expects': { '@id': '#S' } })],
      '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': '#a' }, 'sh:datatype': { '@id': 'xsd:string' },
        'sh:minCount': 'ONE-POINT-ZERO', 'sh:maxCount': 1, 'sh:maxLength': 3 } }] },
    // Addresses a URL parser reads differently from their text, each refused before anything is
    // sent: a backslash before the host (one backslash in the template), "https:" with no "//",
    // user information, a host written as a hexadecimal number, and a tab. Then addresses each
    // client sends as the parser writes them, which is also what its dry run shows: "%2e%2e"
    // segments removed, an upper-case scheme and host with a default port, a dot segment, quotes
    // and a fragment, and a query parameter whose value needs encoding. Last, a template that is
    // not http(s) with non-ASCII user information and an IPv6 host with a port, shown not sent,
    // and a host with a sharp s, which IDNA 2003 and a browser map to two different domains.
    '/sent': { '@context': CTX, '@id': `${base}/sent`, 'iep:affordance': [
      op('bs', 'urn:sent-backslash', 'GET', 'Backslash host', { 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': 'https://evil.example\\@good.example{?q}', 'hydra:mapping': [{ 'hydra:variable': 'q' }] } }),
      op('plus', 'urn:sent-plus', 'GET', 'No slashes', { 'hydra:template': 'https:{+u}', 'hydra:mapping': [{ 'hydra:variable': 'u' }] }),
      op('user', 'urn:sent-user', 'GET', 'User information', { 'hydra:target': { '@id': 'https://user@good.example/x' } }),
      op('num', 'urn:sent-number', 'GET', 'Number host', { 'hydra:target': { '@id': 'https://0x7f.1/x' } }),
      op('tab', 'urn:sent-tab', 'GET', 'Tab in path', { 'hydra:target': { '@id': `${base}/a\tb` } }),
      op('dots', 'urn:sent-dots', 'GET', 'Encoded dots', { 'hydra:target': { '@id': `${base}/notes/%2e%2e/%2E%2e/admin` } }),
      op('canon', 'urn:sent-canon', 'GET', 'Upper-case scheme', { 'hydra:target': { '@id': 'HTTPS://Good.Example:443/A/./b/../c?x="y"&z=\'w\'#frag' } }),
      op('query', 'urn:sent-query', 'GET', 'Query bytes', { 'hydra:target': { '@id': `${base}/q?keep=a%20b` },
        'hydra:expects': { type: 'object', properties: { a: { type: 'string' } } } }),
      op('v6', 'urn:sent-v6', 'GET', 'IPv6 port', { 'hydra:template': 'ftp://üser@[::1]:8443/x{?q}' }),
      op('sz', 'urn:sent-sharp-s', 'GET', 'Sharp s host', { 'hydra:target': { '@id': 'https://straße.example/x' } }),
      op('puny', 'urn:sent-punycode', 'GET', 'Bad punycode host', { 'hydra:target': { '@id': 'https://xn--a.example/x' } }),
    ] },
    // Two mappings of one variable, and a mapping that renames a shape's field followed by a bare
    // mapping of the name it gave: one field each, as the page always read them.
    '/twin-mappings': { '@context': CTX, '@id': `${base}/twin-mappings`, 'iep:affordance': [
      op('a', 'urn:twin-variable', 'GET', 'Twin variable', { 'hydra:search': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/s{?q}`, 'hydra:mapping': [{ 'hydra:variable': 'q' }, { 'hydra:variable': 'q' }] } }),
      op('b', 'urn:twin-renamed', 'GET', 'Renamed then bare', { 'hydra:expects': { '@id': '#S' }, 'hydra:search': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/s{?q}`, 'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:property': { '@id': `${base}/p#text` } },
          { 'hydra:variable': 'q' }] } }),
    ], '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': `${base}/p#text` }, 'sh:maxCount': 1 } }] },
    // One inline operation with no "@id" under each kind of container, as jsonld.js reads them. Under
    // @set, @list, @graph with @set, and @set written as an array, the value is the one node object
    // written there, keys that look like a language tag or an IRI included. Only @index, @id and
    // @type containers (alone, with @set or with @graph) hold a map, and there every object is a map,
    // even one keyed by "@id". An @id map's key names the graph, not the node, when the container
    // has @graph too, a key aliased to @none names nothing, and a node's own "@id" or "@type" holds
    // when an alias writes it. An "@index" property takes each key as its value: a method, and an
    // action that the term types as an IRI.
    '/containers': {
      '@context': { ...CTX, none: '@none', id: '@id', type: '@type', en: 'https://vocab.example/en',
        Verbed: { '@id': 'urn:c:Verbed', '@context': { verb: 'hydra:method' } }, act: { '@id': 'iep:action', '@type': '@id' },
        methodOps: { '@id': 'hydra:operation', '@container': '@index', '@index': 'hydra:method' },
        actionOps: { '@id': 'hydra:operation', '@container': ['@index', '@set'], '@index': 'act' },
        setOp: { '@id': 'hydra:operation', '@container': '@set' }, listOp: { '@id': 'hydra:operation', '@container': '@list' },
        graphOp: { '@id': 'hydra:operation', '@container': ['@graph', '@set'] }, arrayOp: { '@id': 'hydra:operation', '@container': ['@set'] },
        indexOps: { '@id': 'hydra:operation', '@container': ['@set', '@index'] }, typeOps: { '@id': 'hydra:operation', '@container': '@type' },
        graphIndexOps: { '@id': 'hydra:operation', '@container': ['@graph', '@index'] },
        graphIdOps: { '@id': 'hydra:operation', '@container': ['@graph', '@id'] }, idOps: { '@id': 'hydra:operation', '@container': '@id' } },
      '@id': `${base}/containers`,
      setOp: inline('urn:c:set', 'Set read'),
      listOp: inline('urn:c:list', 'List read'),
      graphOp: inline('urn:c:graph', 'Graph set read'),
      arrayOp: { ...inline('urn:c:keys', 'Keyed read'), en: 'English', [`${base}/id`]: { '@id': '#x' } },
      indexOps: { '@id': inline('urn:c:index-id', 'Index read'), en: inline('urn:c:index-en', 'Index en read') },
      typeOps: { 'hydra:Operation': { 'iep:action': { '@id': 'urn:c:type' }, 'hydra:method': 'GET', 'hydra:title': 'Type read', ...target('/api') },
        'urn:c:Kind': { type: 'Verbed', verb: 'GET', 'iep:action': { '@id': 'urn:c:typed' }, 'hydra:title': 'Own type read', ...target('/api') } },
      graphIndexOps: { g: inline('urn:c:graph-index', 'Graph index read') },
      graphIdOps: { '#g1': { '@type': 'hydra:Operation', 'hydra:method': 'GET', 'hydra:title': 'Graph id read', ...target('/api') } },
      idOps: { none: { '@type': 'hydra:Operation', 'hydra:method': 'GET', 'hydra:title': 'No id read', ...target('/api') },
        '#k': inline('urn:c:id', 'Id read'),
        '#a': { id: 'urn:c:own', '@type': 'hydra:Operation', 'hydra:method': 'GET', 'hydra:title': 'Own id read', ...target('/api') } },
      methodOps: { GET: { '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:c:method' }, 'hydra:title': 'Method index read', ...target('/api') } },
      actionOps: { 'iep:indexed': { '@type': 'hydra:Operation', 'hydra:method': 'GET', 'hydra:title': 'Action index read', ...target('/api') } },
    },
    // Writes whose fields each take a JSON array with a count to keep: SHACL properties with
    // sh:node and with sh:nodeKind sh:BlankNode, one sh:node property that takes a single object,
    // and JSON Schema arrays with minItems and maxItems, one of which may also be an object.
    '/counts': { '@context': CTX, '@id': `${base}/counts`, 'iep:affordance': [
      op('n', 'urn:count-nodes', 'POST', 'Node counts', { ...target('/num-target'), 'hydra:expects': { '@id': '#S' } }),
      op('j', 'urn:count-items', 'POST', 'Item counts', { ...target('/num-target'), 'hydra:expects': { type: 'object', required: ['tags'],
        properties: { tags: { type: 'array', minItems: 2, maxItems: 3 }, extra: { type: ['array', 'object'], maxItems: 1 } } } }),
    ], '@graph': [
      { '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': '#members' }, 'sh:name': 'members', 'sh:node': { '@id': '#M' }, 'sh:minCount': 2, 'sh:maxCount': 3 },
        { 'sh:path': { '@id': '#notes' }, 'sh:name': 'notes', 'sh:nodeKind': { '@id': 'sh:BlankNode' }, 'sh:maxCount': 2 },
        { 'sh:path': { '@id': '#owner' }, 'sh:name': 'owner', 'sh:node': { '@id': '#M' }, 'sh:minCount': 1, 'sh:maxCount': 1 },
      ] },
      { '@id': '#M', '@type': 'sh:NodeShape' },
    ] },
    // A type's scoped context holds for that node's own keys only, and an embedded context marked
    // "@propagate": false for its own node only: a node object written under either reads the
    // context before it, as jsonld.js reads it. Here the catalog's "target" is its home, and the
    // operation's "target" is the document's hydra:target while its "goto" names nothing.
    '/type-scoped': {
      '@context': { ...CTX, target: { '@id': 'hydra:target', '@type': '@id' },
        Catalog: { '@id': 'urn:x:Catalog', '@context': { target: { '@id': 'urn:x:catalogHome', '@type': '@id' }, goto: { '@id': 'hydra:target', '@type': '@id' } } } },
      '@id': `${base}/type-scoped`, '@type': 'Catalog', target: '/home',
      'hydra:operation': [{ '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:scope:type' }, 'hydra:method': 'POST',
        'hydra:title': 'Type-scoped write', target: '/right', goto: '/wrong' }] },
    '/propagate': {
      '@context': { ...CTX, to: { '@id': 'hydra:target', '@type': '@id' } }, '@id': `${base}/propagate`,
      'hydra:operation': { '@context': { '@version': 1.1, '@propagate': false, to: { '@id': 'urn:x:audience', '@type': '@id' } }, '@id': '#holder', to: '/people',
        'hydra:operation': [{ '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:scope:propagate' }, 'hydra:method': 'POST',
          'hydra:title': 'Unpropagated write', to: '/right' }] } },
    // Both again 80 levels deep under a context of 3,000 terms: a level goes back to the context
    // before its type's, and a term's scoped context met inside its own value adds nothing, so
    // neither copies the 3,000 terms once per level.
    '/type-scoped-deep': deepScoped(base, '/type-scoped-deep', 'type'),
    '/property-scoped-deep': deepScoped(base, '/property-scoped-deep', 'property'),
    // A string in an @index map whose term holds IRIs names a node, which the map's "@index"
    // property reaches; under @graph that property is the graph's, not the node's.
    '/index-refs': { '@context': { ...CTX, ops: { '@id': 'hydra:operation', '@type': '@id', '@container': '@index', '@index': 'hydra:method' } },
      '@id': `${base}/index-refs`, ops: { DELETE: '#remove', PUT: ['#replace'] },
      '@graph': [
        { '@id': '#remove', '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:refs:remove' }, 'hydra:title': 'Remove', ...target('/thing') },
        { '@id': '#replace', '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:refs:replace' }, 'hydra:title': 'Replace', ...target('/thing') },
      ] },
    '/graph-index': { '@context': { ...CTX, ops: { '@id': 'hydra:operation', '@container': ['@graph', '@index'], '@index': 'hydra:method' } },
      '@id': `${base}/graph-index`, ops: {
        DELETE: { '@type': 'hydra:Operation', 'hydra:method': 'GET', 'iep:action': { '@id': 'urn:graph:own' }, 'hydra:title': 'Own method', ...target('/thing') },
        GET: { '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:graph:keyed' }, 'hydra:title': 'Keyed method', ...target('/thing') } } },
    // A JSON Schema with an "@id", under a context that aliases "type" to "@type", as Interego's
    // own context does: its property schemas keep their "type".
    '/schema-alias': { '@context': { ...CTX, type: '@type' }, '@id': `${base}/schema-alias`, 'iep:affordance': [
      { '@id': '#w', type: 'iep:Affordance', 'iep:action': { '@id': 'urn:schema:alias' }, 'hydra:method': 'POST', 'hydra:title': 'Aliased schema',
        ...target('/num-target'), 'hydra:expects': { '@id': '#schema', type: 'object', required: ['n'],
          properties: { n: { type: 'integer', maximum: 5 }, tags: { type: 'array', minItems: 2 } } } }] },
    // A node's "@type" and "@id" written inside a @nest object are the node's.
    '/nest-keywords': { '@context': { ...CTX, meta: '@nest', kind: '@type' }, '@id': `${base}/nest-keywords`, '@graph': [
      { '@id': '#op', meta: { kind: 'hydra:Operation', 'hydra:title': 'Nested alias type' }, ...target('/thing'), 'iep:action': { '@id': 'urn:nest:alias' } },
      { meta: { '@type': 'iep:Affordance', '@id': '#typed' }, 'hydra:title': 'Nested type', ...target('/thing2') },
    ] },
    // "target" and "method" that the context defines as other properties are those properties.
    '/defined-terms': { '@context': { ...CTX, target: { '@id': 'urn:x:audience' }, method: { '@id': 'urn:x:approach' } },
      '@id': `${base}/defined-terms`, 'hydra:operation': [
        { '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:defined:target' }, 'hydra:title': 'Audience note', 'hydra:method': 'POST',
          target: 'https://audience.example/inbox' },
        { '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:defined:method' }, 'hydra:title': 'Approach note', method: 'GET',
          target: 'https://elsewhere.example/hook' },
      ] },
    // Two terms for one property, each holding an inline operation with no "@id" or "@type".
    '/two-terms': { '@context': { ...CTX, reads: { '@id': 'hydra:operation', '@container': '@set' }, writes: { '@id': 'hydra:operation', '@container': '@set' } },
      '@id': `${base}/two-terms`,
      reads: [{ 'iep:action': { '@id': 'urn:two:read' }, 'hydra:method': 'GET', 'hydra:title': 'Two-term read', ...target('/api') }],
      writes: [{ 'iep:action': { '@id': 'urn:two:write' }, 'hydra:method': 'POST', 'hydra:title': 'Two-term write', ...target('/api') }] },
    // An expanded term definition is a prefix only with "@prefix": true; a simple one ending in "/" is one.
    '/prefix-terms': { '@context': { ...CTX, api: { '@id': `${base}/` }, api2: `${base}/` }, '@id': `${base}/prefix-terms`, 'hydra:operation': [
      { '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:prefix:expanded' }, 'hydra:method': 'POST', 'hydra:title': 'Expanded prefix', 'hydra:target': { '@id': 'api:collect' } },
      { '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:prefix:simple' }, 'hydra:method': 'POST', 'hydra:title': 'Simple prefix', 'hydra:target': { '@id': 'api2:collect' } },
    ] },
    // A map's keys read in one order in both clients, as jsonld.js sorts them ("2" before
    // "current"): two operations with one action, a GET and a DELETE, are refused, whether they are
    // two named nodes or two blank ones; and one operation with two methods is refused too.
    '/index-order': { '@context': { ...CTX, versions: { '@id': 'hydra:operation', '@container': '@index' } }, '@id': `${base}/index-order`,
      versions: {
        current: { '@id': '#current', '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:order:item' }, 'hydra:method': 'GET', 'hydra:title': 'Read item', ...target('/item') },
        2: { '@id': '#v2', '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:order:item' }, 'hydra:method': 'DELETE', 'hydra:title': 'Delete item', ...target('/item') } } },
    '/index-order-inline': { '@context': { ...CTX, versions: { '@id': 'hydra:operation', '@container': '@index' } }, '@id': `${base}/index-order-inline`,
      versions: {
        current: { '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:order:inline' }, 'hydra:method': 'GET', 'hydra:title': 'Read inline item', ...target('/item') },
        2: { '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:order:inline' }, 'hydra:method': 'DELETE', 'hydra:title': 'Delete inline item', ...target('/item') } } },
    '/two-methods': { '@context': { ...CTX, ops: { '@id': 'hydra:operation', '@container': '@index', '@index': 'hydra:method' } },
      '@id': `${base}/two-methods`,
      ops: { GET: { '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:methods:keyed' }, 'hydra:method': 'DELETE', 'hydra:title': 'Keyed delete', ...target('/thing') } },
      'hydra:operation': { '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:methods:listed' }, 'hydra:method': ['GET', 'DELETE'],
        'hydra:title': 'Listed delete', ...target('/thing') } },
    // An operation that a property-scoped context gives a second hydra:target, as jsonld.js reads it.
    '/two-targets': { '@context': { ...CTX, target: { '@id': 'hydra:target', '@type': '@id' },
      ops: { '@id': 'hydra:operation', '@context': { dest: { '@id': 'hydra:target', '@type': '@id' } } } }, '@id': `${base}/two-targets`,
      ops: [{ '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:targets:two' }, 'hydra:method': 'POST', 'hydra:title': 'Two targets',
        dest: '/dest', target: '/t' }] },
    // A reserved expansion passes a percent-encoded triplet through as it is (RFC 6570, 3.2.3).
    '/tmpl-pct': { '@context': CTX, '@id': `${base}/tmpl-pct`, 'iep:affordance': [op('r', 'urn:tmpl:pct', 'GET', 'Reserved triplet', {
      'hydra:template': `${base}/r{+path}`, 'hydra:mapping': [{ 'hydra:variable': 'path', 'hydra:required': true }] })] },
    // Hints the clients once read only the first value of: [false, true], and false and true in two
    // descriptions of one @id, are refused, and so is a hint written as a @list; a typed literal, a
    // string and a value that is no boolean each make a GET unsafe. The plain read stays a safe read.
    '/hint-values': { '@context': CTX, '@id': `${base}/hint-values`, 'iep:affordance': [
      op('two', 'urn:hint:two', 'GET', 'Two hints', { ...target('/purge'), 'iep:destructiveHint': [false, true] }),
      op('merged', 'urn:hint:merged', 'GET', 'Merged hint', { ...target('/purge'), 'iep:destructiveHint': false }),
      op('listed', 'urn:hint:listed', 'GET', 'Listed hint', { ...target('/purge'), 'iep:destructiveHint': { '@list': [false] } }),
      op('typed', 'urn:hint:typed', 'GET', 'Typed hint', { ...target('/purge'), 'iep:destructiveHint': { '@value': 'true', '@type': 'xsd:boolean' } }),
      op('string', 'urn:hint:string', 'GET', 'String hint', { ...target('/purge'), 'iep:readOnlyHint': 'false' }),
      op('unread', 'urn:hint:unread', 'GET', 'Unreadable hint', { ...target('/purge'), 'iep:destructiveHint': 'maybe' }),
      op('read', 'urn:hint:read', 'GET', 'Plain hint read', { ...target('/api'), 'iep:readOnlyHint': [true, { '@value': 'true', '@type': 'xsd:boolean' }] }),
    ], '@graph': [{ '@id': '#merged', 'iep:destructiveHint': true }] },
    // Explicit @set, @list and @graph objects where an operation, a shape's properties or a value
    // goes, nested in an array and through a keyword alias; a language-tagged method is still GET.
    '/set-values': { '@context': { ...CTX, items: '@set' }, '@id': `${base}/set-values`,
      'hydra:operation': { '@set': [{ '@id': '#read', 'iep:action': { '@id': 'urn:set:read' }, 'hydra:method': 'GET', 'hydra:title': 'Set object read',
        'hydra:target': { '@id': '/api' } }] },
      'iep:affordance': [
        { '@set': [op('nested', 'urn:set:nested', 'GET', 'Nested set read', target('/api'))] },
        { '@list': [op('listed', 'urn:set:list', 'GET', 'List object read', target('/api'))] },
        { '@graph': [op('graphed', 'urn:set:graph', 'GET', 'Graph object read', target('/api'))] },
        { items: [op('aliased', 'urn:set:alias', 'GET', 'Aliased set read', target('/api'))] },
        op('method', 'urn:set:method', null, 'Set method read', { 'hydra:method': { '@set': ['GET'] }, 'hydra:target': { '@set': [{ '@id': '/api' }] } }),
        op('tagged', 'urn:set:tagged', null, 'Tagged method read', { 'hydra:method': { '@value': 'GET', '@language': 'en' }, ...target('/api') }),
        op('shape', 'urn:set:shape', 'GET', 'Set shape read', { ...target('/api'), 'hydra:expects': { '@id': '#S' } }),
      ],
      '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': { '@set': [{ 'sh:path': { '@id': `${base}/q` }, 'sh:name': 'q',
        'sh:maxCount': { '@set': [1] }, 'sh:datatype': { '@id': 'xsd:integer' } }] } }] },
    // A value the clients act on written in a form they do not read, or with more than one value:
    // a method as a @list or under a @list container, a target as a JSON literal, two actions, two
    // templates, a template and an address, two shapes, two media types, a mapping with two
    // variables, and an input with two datatypes, two counts, a count in words, a path that is a
    // SHACL sequence, or two defaults. Each control is refused with a problem that names it.
    '/value-forms': { '@context': { ...CTX, verbs: { '@id': 'hydra:method', '@container': '@list' } }, '@id': `${base}/value-forms`,
      'iep:affordance': [
        op('lm', 'urn:form:list-method', null, 'Listed method', { 'hydra:method': { '@list': ['GET'] }, ...target('/api') }),
        op('cm', 'urn:form:container-method', null, 'List container method', { verbs: 'GET', ...target('/api') }),
        op('jt', 'urn:form:json-target', 'GET', 'JSON target', { 'hydra:target': { '@value': '/api', '@type': '@json' } }),
        op('ia', 'urn:form:two-actions', 'GET', 'Two actions', { ...target('/api'),
          'iep:action': [{ '@id': 'urn:form:two-actions' }, { '@id': 'urn:form:other' }] }),
        op('tt', 'urn:form:two-templates', 'GET', 'Two templates', { 'hydra:template': [`${base}/a{?q}`, `${base}/b{?q}`] }),
        op('te', 'urn:form:template-and-address', 'GET', 'Template and address', {
          'hydra:target': [{ '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/t{?q}` }, { '@id': '/api' }] }),
        op('ex', 'urn:form:two-shapes', 'POST', 'Two shapes', { ...target('/api'), 'hydra:expects': [{ '@id': '#S1' }, { '@id': '#S2' }] }),
        op('mt', 'urn:form:two-media', 'GET', 'Two media types', { ...target('/api'), 'hydra:returnsContentType': ['application/json', 'text/html'] }),
        op('mv', 'urn:form:two-variables', 'GET', 'Two variables', { 'hydra:search': { '@type': 'hydra:IriTemplate',
          'hydra:template': `${base}/api{?q}`, 'hydra:mapping': [{ 'hydra:variable': ['q', 'r'] }] } }),
        op('fd', 'urn:form:two-datatypes', 'POST', 'Two datatypes', { ...target('/api'), 'hydra:expects': { '@id': '#D' } }),
        op('fc', 'urn:form:two-counts', 'POST', 'Two counts', { ...target('/api'), 'hydra:expects': { '@id': '#C' } }),
        op('fw', 'urn:form:word-count', 'POST', 'Word count', { ...target('/api'), 'hydra:expects': { '@id': '#W' } }),
        op('fp', 'urn:form:sequence-path', 'POST', 'Sequence path', { ...target('/api'), 'hydra:expects': { '@id': '#P' } }),
        op('fv', 'urn:form:two-defaults', 'POST', 'Two defaults', { ...target('/api'), 'hydra:expects': { '@id': '#V' } }),
      ],
      '@graph': [
        { '@id': '#S1', '@type': 'sh:NodeShape' }, { '@id': '#S2', '@type': 'sh:NodeShape' },
        { '@id': '#D', 'sh:property': { 'sh:path': { '@id': '#n' }, 'sh:name': 'n', 'sh:maxCount': 1,
          'sh:datatype': [{ '@id': 'xsd:integer' }, { '@id': 'xsd:string' }] } },
        { '@id': '#C', 'sh:property': { 'sh:path': { '@id': '#n' }, 'sh:name': 'n', 'sh:maxCount': [1, 2] } },
        { '@id': '#W', 'sh:property': { 'sh:path': { '@id': '#n' }, 'sh:name': 'n', 'sh:maxCount': 'one' } },
        { '@id': '#P', 'sh:property': { 'sh:path': { '@list': [{ '@id': '#a' }, { '@id': '#b' }] }, 'sh:name': 'n', 'sh:maxCount': 1 } },
        { '@id': '#V', 'sh:property': { 'sh:path': { '@id': '#n' }, 'sh:name': 'n', 'sh:maxCount': 1, 'sh:defaultValue': ['a', 'b'] } },
      ] },
    // Documents that use a JSON-LD structure the clients do not read, each refused whole
    // (DOCUMENT_REFUSALS): a named graph as a property's value, @included inside a node, @reverse,
    // a @set object with another key, and a node given two "@id"s through an alias or a @nest.
    '/nested-graph': { '@context': CTX, '@id': `${base}/nested-graph`, 'iep:affordance': [op('r', 'urn:ng:read', 'GET', 'Nested graph read', target('/api'))],
      'dct:hasPart': { '@graph': [op('w', 'urn:ng:hidden', 'DELETE', 'Hidden delete', target('/thing'))] } },
    '/nested-included': { '@context': CTX, '@id': `${base}/nested-included`, 'iep:affordance': [op('r', 'urn:ni:read', 'GET', 'Included in a node', {
      ...target('/api'), '@included': [op('w', 'urn:ni:hidden', 'DELETE', 'Hidden delete', target('/thing'))] })] },
    '/reverse': { '@context': CTX, '@id': `${base}/reverse`, '@graph': [
      { '@id': '#w', '@type': 'hydra:Operation', 'iep:action': { '@id': 'urn:rev:write' }, 'hydra:method': 'GET', 'hydra:title': 'Reverse read',
        ...target('/api'), '@reverse': { 'hydra:operation': { '@id': `${base}/reverse` } } }] },
    '/set-extra': { '@context': CTX, '@id': `${base}/set-extra`, 'hydra:operation': { '@set': [op('r', 'urn:se:read', 'GET', 'Set with a title', target('/api'))],
      'hydra:title': 'extra' } },
    '/colliding': { '@context': { ...CTX, id: '@id' }, '@id': `${base}/colliding`, 'iep:affordance': [
      { ...op('a', 'urn:collide:a', 'GET', 'Colliding ids', target('/api')), id: '#b' }] },
    // Two controls whose short names are one name: a name that matches both is refused, not read as
    // the first. The write's input takes a value by its name or its path's, but not by both.
    '/same-names': { '@context': CTX, '@id': `${base}/same-names`, 'iep:affordance': [
      op('a', 'urn:a:remove', 'GET', 'Read remove', target('/api')),
      op('b', 'urn:b:remove', 'DELETE', 'Delete remove', target('/thing')),
      op('w', 'urn:same:write', 'POST', 'Write by two names', { ...target('/api'), 'hydra:expects': { '@id': '#S' } }),
    ], '@graph': [{ '@id': '#S', 'sh:property': { 'sh:path': { '@id': `${base}/query` }, 'sh:name': 'q', 'sh:maxCount': 1 } }] },
    '/nest-id': { '@context': { ...CTX, meta: '@nest' }, '@id': `${base}/nest-id`, 'iep:affordance': [
      { ...op('a', 'urn:collide:nest', 'GET', 'Nested id', target('/api')), meta: { '@id': '#b' } }] },
    // Two operations that name one action are refused, whatever each sends: the second is marked
    // destructive, and the first, a plain read of the same address, was the one a link invoked.
    '/same-action': { '@context': CTX, '@id': `${base}/same-action`, 'iep:affordance': [
      op('a', 'urn:same:action', 'GET', 'Same-action read', target('/purge')),
      op('b', 'urn:same:action', 'GET', 'Same-action purge', { ...target('/purge'), 'iep:destructiveHint': true })] },
    // One node described in more than one place: a hint, a method and a target written on an object
    // with the control's "@id" under a property the clients read nothing else from, or inside another
    // @graph node, and a template and a shape written in place with an "@id" the @graph describes
    // too. Each description is the node's, as JSON-LD merges them.
    '/described-twice': { '@context': CTX, '@id': `${base}/described-twice`,
      'iep:affordance': [
        op('h', 'urn:twice:hint', 'GET', 'Hint elsewhere', target('/purge')),
        op('m', 'urn:twice:method', 'GET', 'Method elsewhere', target('/thing')),
        op('g', 'urn:twice:graph', 'GET', 'Target elsewhere', target('/thing')),
        op('t', 'urn:twice:template', 'GET', 'Template in place', {
          'hydra:target': { '@id': '#t', '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/a{?q}` } }),
        op('s', 'urn:twice:shape', 'POST', 'Shape in place', { ...target('/api'), 'hydra:expects': { '@id': '#S',
          'sh:property': { 'sh:path': { '@id': 'urn:p:a' }, 'sh:name': 'a', 'sh:minCount': 1, 'sh:maxCount': 1 } } }),
      ],
      'rdfs:seeAlso': { '@id': '#h', 'iep:destructiveHint': true },
      'dct:hasPart': { '@id': '#m', 'hydra:method': 'DELETE' },
      '@graph': [
        { '@id': '#other', 'dct:relation': { '@id': '#g', 'iep:readOnlyHint': false, 'hydra:target': { '@id': '/purge' } } },
        { '@id': '#t', 'hydra:template': `${base}/b{?q}` },
        { '@id': '#S', 'sh:property': { 'sh:path': { '@id': 'urn:p:b' }, 'sh:name': 'b', 'sh:maxCount': 1 } },
      ] },
    // A term whose values are graphs holds a node of another graph, which the clients do not read.
    '/graph-container': { '@context': { ...CTX, parts: { '@id': 'dct:hasPart', '@container': '@graph' } }, '@id': `${base}/graph-container`,
      'iep:affordance': [op('a', 'urn:gc:read', 'GET', 'Graph container read', target('/api'))], parts: { '@id': '#a', 'hydra:method': 'DELETE' } },
    // Operations written with no "@id" are blank nodes, each its own: none takes its action, or a
    // label the clients give it, as an "@id" and with it another node's method. The first two name
    // no method, so each is a POST.
    '/blank-ids': { '@context': CTX, '@id': `${base}/blank-ids`,
      'iep:affordance': [
        { '@type': 'iep:Affordance', 'iep:action': { '@id': 'urn:blank:purge' }, 'hydra:title': 'Blank purge', ...target('/purge') },
        { '@type': 'hydra:Operation', 'hydra:title': 'Blank no action', ...target('/purge') },
        { '@type': 'iep:Affordance', 'iep:action': { '@id': 'urn:blank:two' }, 'hydra:title': 'Blank no method', ...target('/purge') },
        { '@type': 'iep:Affordance', 'iep:action': { '@id': 'urn:blank:two' }, 'hydra:method': 'GET', 'hydra:title': 'Blank read', ...target('/purge') },
      ],
      '@graph': [{ '@id': 'urn:blank:purge', 'rdfs:label': 'The purge action', 'hydra:method': 'GET' }, { '@id': '_:n3', 'hydra:method': 'GET' }] },
    // A template the clients cannot read, as a target or a search, is a problem; its node's own IRI
    // is not an address to send to, and the control's other target is not a fallback.
    '/template-nodes': { '@context': CTX, '@id': `${base}/template-nodes`, 'iep:affordance': [
      op('l', 'urn:tn:listed', 'GET', 'Listed template', { 'hydra:target': { '@id': 'https://other.example/tm' } }),
      op('n', 'urn:tn:none', 'GET', 'No template', { 'hydra:target': { '@id': 'https://other.example/tn', '@type': 'hydra:IriTemplate' } }),
      op('s', 'urn:tn:search', 'GET', 'Unread search', { ...target('/items'),
        'hydra:search': { '@type': 'hydra:IriTemplate', 'hydra:template': { '@list': [`${base}/search{?q}`] } } }),
      op('e', 'urn:tn:empty-search', 'GET', 'Empty search', { ...target('/items'), 'hydra:search': { '@type': 'hydra:IriTemplate' } }),
    ], '@graph': [{ '@id': 'https://other.example/tm', '@type': 'hydra:IriTemplate', 'hydra:template': { '@list': [`${base}/s{?q}`] } }] },
    // Values of terms typed "@json" are JSON literals, not an address or a method; a hint in one is
    // still read, so the GET that carries it is unsafe.
    '/json-terms': { '@context': { ...CTX, tgt: { '@id': 'hydra:target', '@type': '@json' }, verb: { '@id': 'hydra:method', '@type': '@json' },
      notes: { '@id': 'urn:x:notes', '@type': '@json' } }, '@id': `${base}/json-terms`, 'iep:affordance': [
      op('t', 'urn:json:target', 'GET', 'JSON term target', { tgt: `${base}/api` }),
      op('m', 'urn:json:method', null, 'JSON term method', { verb: 'GET', ...target('/api') }),
      op('h', 'urn:json:hint', 'GET', 'JSON annotations', { ...target('/purge'), notes: { destructiveHint: true } }),
    ] },
    // SHACL paths that are not one property: an inverse path on a blank node, and alternatives on a
    // named one. Neither names a field.
    // Hint containers a control names by reference, each read as the node the document describes at
    // that @id, every description of it merged, never as the reference object: a node in @graph, one
    // written in another node's property, one under an aliased compact @id, and one in a @list; an
    // inline false that another description of the same node contradicts; a reference to a node the
    // document does not describe; and a node whose references loop back to it and to the control.
    '/ref-hints': {
      '@context': { ...CTX, ex: 'urn:ex:', id: '@id' }, '@id': `${base}/ref-hints`,
      'iep:affordance': [
        op('graph', 'urn:ref:graph', 'GET', 'Graph flags', { ...target('/purge'), annotations: { '@id': '#flags' } }),
        op('placed', 'urn:ref:placed', 'GET', 'Placed flags', { ...target('/purge'), annotations: { '@id': '#writes' } }),
        op('alias', 'urn:ref:alias', 'GET', 'Aliased flags', { ...target('/purge'), annotations: { id: 'ex:flags' } }),
        op('listed', 'urn:ref:listed', 'GET', 'Listed flags', { ...target('/purge'), annotations: { '@list': [{ '@id': '#flags' }] } }),
        op('mixed', 'urn:ref:mixed', 'GET', 'Mixed flags', { ...target('/purge'), annotations: { '@id': '#mixed-flags', 'iep:destructiveHint': false } }),
        op('missing', 'urn:ref:missing', 'GET', 'Missing flags', { ...target('/purge'), annotations: { '@id': '#nowhere' } }),
        op('cyc', 'urn:ref:loop', 'GET', 'Looped flags', { ...target('/api'), annotations: { '@id': '#ring' } }),
      ],
      '@graph': [
        { '@id': '#flags', 'iep:destructiveHint': true },
        { '@id': '#holder', 'rdfs:seeAlso': { '@id': '#writes', 'iep:readOnlyHint': false } },
        { '@id': 'ex:flags', 'iep:destructiveHint': true },
        { '@id': '#mixed-flags', 'iep:destructiveHint': true },
        { '@id': '#ring', 'iep:readOnlyHint': true, 'rdfs:seeAlso': [{ '@id': '#ring' }, { '@id': '#cyc' }] },
      ],
    },
    // Hint containers named by a string, which JSON-LD reads as the same reference an object with
    // that @id is: under a term typed "@id", one typed "@vocab", in a @list, and under a term with
    // no type, where each client still reads the node the string names, since reading more hints
    // can only make a control less safe; and a string naming a node the document does not describe.
    '/ref-hint-strings': {
      '@context': { ...CTX, ex: 'urn:ex:', annotations: { '@id': 'https://h.example/vocab#annotations', '@type': '@id' },
        notes: { '@id': 'https://h.example/other#annotations', '@type': '@vocab' } },
      '@id': `${base}/ref-hint-strings`,
      'iep:affordance': [
        op('typed', 'urn:refstr:typed', 'GET', 'Typed string flags', { ...target('/purge'), annotations: '#ann' }),
        op('vocab', 'urn:refstr:vocab', 'GET', 'Vocab string flags', { ...target('/purge'), notes: 'ex:vflags' }),
        op('listed', 'urn:refstr:listed', 'GET', 'Listed string flags', { ...target('/purge'), annotations: { '@list': ['#calm', '#ann'] } }),
        op('plain', 'urn:refstr:plain', 'GET', 'Plain string flags', { ...target('/purge'), 'rdfs:seeAlso': '#ann' }),
        op('missing', 'urn:refstr:missing', 'GET', 'Missing string flags', { ...target('/purge'), annotations: '#nowhere' }),
      ],
      '@graph': [
        { '@id': '#ann', 'iep:destructiveHint': true },
        { '@id': 'ex:vflags', 'iep:readOnlyHint': false },
        { '@id': '#calm', 'iep:readOnlyHint': true },
      ],
    },
    // Inputs and addresses a control names by reference: a template mapping, a shape's property and a
    // class's supported property the document does not describe; a target, a shape and an sh:in
    // list that are blank nodes it does not describe; an inline field and JSON Schema properties
    // written as references; and a mapping two descriptions of one node make required.
    '/ref-inputs': {
      '@context': CTX, '@id': `${base}/ref-inputs`,
      'iep:affordance': [
        op('mapping', 'urn:refin:mapping', 'GET', 'Missing mapping', { 'hydra:search': { '@type': 'hydra:IriTemplate',
          'hydra:template': '/api{?q,r}', 'hydra:mapping': [{ 'hydra:variable': 'q' }, { '@id': '#m-missing' }] } }),
        op('prop', 'urn:refin:prop', 'POST', 'Missing property', { ...target('/num-target'), 'hydra:expects': { '@id': '#S' } }),
        op('class', 'urn:refin:class', 'POST', 'Missing supported property', { ...target('/num-target'), 'hydra:expects': { '@id': '#C' } }),
        op('blank-target', 'urn:refin:target', 'GET', 'Blank target', { 'hydra:target': { '@id': '_:nowhere' } }),
        op('blank-shape', 'urn:refin:shape', 'POST', 'Blank shape', { ...target('/num-target'), 'hydra:expects': { '@id': '_:shapeless' } }),
        op('blank-list', 'urn:refin:list', 'GET', 'Blank list', { ...target('/api'), 'hydra:expects': { '@id': '#L' } }),
        op('fields', 'urn:refin:fields', 'POST', 'Field reference', { ...target('/num-target'), fields: [{ name: 'a' }, { '@id': '#f2' }] }),
        op('schema-ref', 'urn:refin:schema', 'POST', 'Schema reference', { ...target('/num-target'), 'hydra:expects': { type: 'object',
          properties: { q: { $ref: '#/definitions/q' }, r: { '@id': '#r' } } } }),
        op('merged-mapping', 'urn:refin:merged', 'GET', 'Merged mapping', { 'hydra:search': { '@type': 'hydra:IriTemplate',
          'hydra:template': '/api{?q}', 'hydra:mapping': { '@id': '#m1' } } }),
      ],
      '@graph': [
        { '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': [{ '@id': '#p-missing' },
          { 'sh:path': { '@id': 'urn:p:q' }, 'sh:name': 'q', 'sh:maxCount': 1 }] },
        { '@id': '#C', '@type': 'hydra:Class', 'hydra:supportedProperty': { '@id': '#sp-missing' } },
        { '@id': '#L', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:q' }, 'sh:name': 'q', 'sh:maxCount': 1,
          'sh:in': { '@id': '_:unlisted' } } },
        { '@id': '#f2', name: 'b', minCount: 1 },
        { '@id': '#m1', 'hydra:variable': 'q' },
        { '@id': '#holder', 'rdfs:seeAlso': { '@id': '#m1', 'hydra:required': true } },
      ],
    },
    // A write whose inputs are a single choice with a default, a multiple choice with a default, an
    // integer with a default, a line of text and a list of text with a default. LINK_CASES give it
    // values a link or --field can hold and values its form could not.
    '/link-values': { '@context': CTX, '@id': `${base}/link-values`,
      'iep:affordance': [op('w', 'urn:lv:write', 'POST', 'Linked write', { ...target('/num-target'), 'hydra:expects': { '@id': '#V' } })],
      '@graph': [{ '@id': '#V', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:scope' }, 'sh:name': 'scope', 'sh:in': ['mine', 'all'], 'sh:defaultValue': 'all', 'sh:maxCount': 1 },
        { 'sh:path': { '@id': 'urn:p:picks' }, 'sh:name': 'picks', 'sh:in': ['x', 'y', 'z'], 'sh:defaultValue': 'x' },
        { 'sh:path': { '@id': 'urn:p:n' }, 'sh:name': 'n', 'sh:datatype': { '@id': 'xsd:integer' }, 'sh:defaultValue': 5, 'sh:maxCount': 1 },
        { 'sh:path': { '@id': 'urn:p:note' }, 'sh:name': 'note', 'sh:datatype': { '@id': 'xsd:string' }, 'sh:maxCount': 1 },
        { 'sh:path': { '@id': 'urn:p:tags' }, 'sh:name': 'tags', 'sh:datatype': { '@id': 'xsd:string' }, 'sh:defaultValue': 'a' },
      ] }] },
    // Inputs a value can be given to under another input's name: a path whose local name is another
    // input's name, two paths of one local name, and a template variable that renames the input whose
    // property it maps to a name that is another input's path's local name.
    '/crossed-names': { '@context': CTX, '@id': `${base}/crossed-names`, 'iep:affordance': [
      op('n', 'urn:crossed:name', 'POST', 'Crossed names', { ...target('/num-target'), 'hydra:expects': { '@id': '#N' } }),
      op('p', 'urn:crossed:path', 'POST', 'Shared path name', { ...target('/num-target'), 'hydra:expects': { '@id': '#P' } }),
      op('v', 'urn:crossed:variable', 'POST', 'Crossed variable', { 'hydra:expects': { '@id': '#V' }, 'hydra:search': {
        '@type': 'hydra:IriTemplate', 'hydra:template': '/num-target{?z,b}',
        'hydra:mapping': { 'hydra:variable': 'z', 'hydra:property': { '@id': 'urn:p:a' } } } }),
    ], '@graph': [
      { '@id': '#N', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:b' }, 'sh:name': 'a', 'sh:maxCount': 1 },
        { 'sh:path': { '@id': 'urn:p:other' }, 'sh:name': 'b', 'sh:defaultValue': '2', 'sh:maxCount': 1 }] },
      { '@id': '#P', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:x' }, 'sh:name': 'a', 'sh:maxCount': 1 },
        { 'sh:path': { '@id': 'urn:q:x' }, 'sh:name': 'c', 'sh:maxCount': 1 }] },
      { '@id': '#V', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:a' }, 'sh:name': 'a', 'sh:maxCount': 1 },
        { 'sh:path': { '@id': 'urn:p:z' }, 'sh:name': 'b', 'sh:maxCount': 1 }] },
    ] },
    '/complex-path': { '@context': CTX, '@id': `${base}/complex-path`, 'iep:affordance': [
      op('i', 'urn:path:inverse', 'POST', 'Inverse path', { ...target('/api'), 'hydra:expects': { '@id': '#I' } }),
      op('a', 'urn:path:alternative', 'POST', 'Alternative path', { ...target('/api'), 'hydra:expects': { '@id': '#A' } }),
    ], '@graph': [
      { '@id': '#I', 'sh:property': { 'sh:path': { '@id': '_:p' }, 'sh:minCount': 1, 'sh:maxCount': 1 } },
      { '@id': '_:p', 'sh:inversePath': { '@id': 'urn:p:parent' } },
      { '@id': '#A', 'sh:property': { 'sh:path': { '@id': '#pp' }, 'sh:name': 'pp', 'sh:maxCount': 1 } },
      { '@id': '#pp', 'sh:alternativePath': { '@list': [{ '@id': 'urn:p:a' }, { '@id': 'urn:p:b' }] } },
    ] },
    // Operations written in place, inside another written in place with compact keys only, and nodes
    // that name a method and a target whatever else they are typed as: each is listed.
    '/nested-ops': { '@context': CTX, '@id': `${base}/nested-ops`, 'iep:affordance': [
      { 'iep:action': { '@id': 'urn:nest:outer' }, 'hydra:method': 'GET', 'hydra:title': 'Outer read', ...target('/api'),
        'iep:affordance': [{ 'iep:action': { '@id': 'urn:nest:inner' }, 'hydra:method': 'DELETE', 'hydra:title': 'Inner delete', ...target('/thing') }] },
    ], '@graph': [
      { '@id': '#both', '@type': ['hydra:Operation', 'hydra:IriTemplate'], 'iep:action': { '@id': 'urn:nest:both' }, 'hydra:method': 'DELETE',
        'hydra:title': 'Operation and template', ...target('/thing') },
      { '@id': '#tm', '@type': 'hydra:IriTemplate', 'iep:action': { '@id': 'urn:nest:template' }, 'hydra:method': 'DELETE',
        'hydra:title': 'Template with a method', 'hydra:template': `${base}/thing` },
    ] },
    // Values that JSON and JavaScript take differently as true or false: an empty array is no value,
    // an empty object is a value in a form the clients do not read, and a JSON Schema is an object
    // whose "properties" is an object and whose "required" and "enum" are lists.
    '/truthiness': { '@context': CTX, '@id': `${base}/truthiness`, 'iep:affordance': [
      op('p', 'urn:truth:props', 'POST', 'Empty property list', { ...target('/api'), 'hydra:expects': { '@id': '#P' } }),
      op('d', 'urn:truth:datatype', 'POST', 'Empty datatype', { ...target('/api'), 'hydra:expects': { '@id': '#D' } }),
      op('n', 'urn:truth:null-properties', 'GET', 'Null properties', { ...target('/api'), 'hydra:expects': { '@id': '#Q', properties: null } }),
      op('e', 'urn:truth:enum', 'GET', 'Object enum', { ...target('/api'),
        'hydra:expects': { type: 'object', properties: { q: { type: 'string', enum: {} } } } }),
      op('r', 'urn:truth:required', 'GET', 'Nested required', { ...target('/api'),
        'hydra:expects': { type: 'object', required: [['q']], properties: { q: { type: 'string' } } } }),
    ], '@graph': [
      { '@id': '#none', 'hydra:method': [], 'hydra:title': 'Empty method', 'hydra:template': `${base}/x{?q}` },
      { '@id': '#obj', 'hydra:method': {}, 'hydra:title': 'Object method', 'hydra:template': `${base}/x{?q}` },
      { '@id': '#P', 'sh:property': [], 'hydra:supportedProperty': [{ 'hydra:property': { '@id': 'urn:p:name' }, 'hydra:required': true }] },
      { '@id': '#D', 'sh:datatype': [] },
      { '@id': '#Q', 'sh:property': { 'sh:path': { '@id': 'urn:p:q' }, 'sh:name': 'q', 'sh:minCount': 1, 'sh:maxCount': 1 } },
    ] },
    // Field names with a line break in them are kept whole, however the break is written.
    '/line-names': { '@context': CTX, '@id': `${base}/line-names`, 'iep:affordance': [
      op('w', 'urn:lines:write', 'POST', 'Names with line breaks', { ...target('/api'), 'hydra:expects': { '@id': '#S' } })],
      '@graph': [{ '@id': '#S', 'sh:property': [
      { 'sh:path': { '@id': 'urn:p:a' }, 'sh:name': 'abc\n', 'sh:maxCount': 1 },
      { 'sh:path': { '@id': 'urn:p:b' }, 'sh:name': 'rest-param-q-limit\n', 'sh:maxCount': 1 },
      { 'sh:path': { '@id': 'urn:p:c' }, 'sh:name': 'rest-param-q-li\rmit', 'sh:maxCount': 1 },
      { 'sh:path': { '@id': 'urn:p:d' }, 'sh:name': 'rest-param-q-offset', 'sh:maxCount': 1 }] }] },
    // A context that imports another, which a JSON-LD processor fetches and these clients do not.
    '/import-context': { '@context': [CTX, { '@import': 'https://evil.example/ctx.jsonld' }], '@id': `${base}/import-context`,
      'iep:affordance': [op('a', 'urn:import:read', 'GET', 'Imported context read', target('/api'))] },
    // A @set object with a @context of its own, which JSON-LD reads as what it holds.
    '/set-context': { '@context': CTX, '@id': `${base}/set-context`, 'iep:affordance': [op('a', 'urn:setctx:read', null, 'Set with a context',
      { 'hydra:method': { '@context': { s: '@set' }, s: ['GET'] }, ...target('/api') })] },
    // Writes that take JSON, as a JSON Schema object, an rdf:JSON property and a whole rdf:JSON
    // body, one whose default holds a number past a double (1e400, put in the text below), and
    // string fields with JSON Schema and SHACL length facets. VALUE_CASES are their values. Then a
    // read that takes an object and one that takes lists (into the address), text fields whose
    // defaults are a 31-digit integer and other values that are not strings, a default holding an
    // unpaired surrogate, integer fields bounded below by a 400-digit integer and with defaults of
    // 2.0 and 2^53 + 1, and a boolean field; the numbers JSON.stringify cannot write are put in the
    // text below.
    '/values': { '@context': CTX, '@id': `${base}/values`, 'iep:affordance': [
      op('o', 'urn:values:object', 'POST', 'Object value', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { document: { type: 'object' } } } }),
      op('q', 'urn:values:query', 'GET', 'Object query', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { filter: { type: 'object' } } } }),
      op('t', 'urn:values:list', 'GET', 'List values', { ...target('/num-target'), 'hydra:expects': { '@id': '#T' } }),
      op('x', 'urn:values:text-default', 'POST', 'Text defaults', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { big: { type: 'string', maxLength: 10, default: 'BIG-TEXT-DEFAULT' }, small: { type: 'string', default: 5 },
          flag: { type: 'string', default: true }, object: { type: 'string', default: { a: [1] } } } } }),
      op('u', 'urn:values:surrogate-default', 'POST', 'Surrogate default', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { a: { type: 'string', default: '\ud800' } } } }),
      op('n', 'urn:values:bound', 'POST', 'Large bound', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { amount: { type: 'integer', minimum: 'LARGE-BOUND' } } } }),
      op('i', 'urn:values:whole-default', 'POST', 'Whole default', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { n: { type: 'integer', default: 'TWO-POINT-ZERO' } } } }),
      op('k', 'urn:values:unsafe-default', 'POST', 'Past 2^53 default', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { n: { type: 'integer', default: 'PAST-SAFE' } } } }),
      op('f', 'urn:values:flag', 'POST', 'Flag value', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { flag: { type: 'boolean' } } } }),
      op('ld', 'urn:values:list-default', 'POST', 'List defaults', { ...target('/num-target'), 'hydra:expects': { '@id': '#D' } }),
      op('bp', 'urn:values:bad-pick', 'POST', 'Bad pick default', { ...target('/num-target'), 'hydra:expects': { '@id': '#W' } }),
      op('ln', 'urn:values:line-default', 'POST', 'Line defaults', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { line: { type: 'string', default: 'a\nb' }, cr: { type: 'string', default: 'c\rd' },
          nul: { type: 'string', default: 'x\u0000y' }, lead: { type: 'string', maxLength: 500, default: '\nx' },
          pick: { type: 'string', enum: ['c\rd', 'x\u0000y'], default: 'x\u0000y' } } } }),
      op('j', 'urn:values:json', 'POST', 'JSON value', { ...target('/num-target'), 'hydra:expects': { '@id': '#J' } }),
      op('b', 'urn:values:body', 'POST', 'JSON body', { ...target('/num-target'), 'hydra:expects': { '@id': '#B' } }),
      op('d', 'urn:values:default', 'POST', 'Large default', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { report: { type: 'object', default: { score: 'LARGE-SCORE' } } } } }),
      op('l', 'urn:values:length', 'POST', 'Schema lengths', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { one: { type: 'string', maxLength: 1 }, two: { type: 'string', minLength: 2 } } } }),
      op('s', 'urn:values:shacl-length', 'POST', 'Shape lengths', { ...target('/num-target'), 'hydra:expects': { '@id': '#L' } }),
      op('sn', 'urn:values:space-number', 'POST', 'Space number default', { ...target('/num-target'), 'hydra:expects': { '@id': '#SN' } }),
      op('sl', 'urn:values:space-list', 'POST', 'Blank list default', { ...target('/num-target'), 'hydra:expects': { '@id': '#SL' } }),
      op('rc', 'urn:values:required-crlf', 'POST', 'Required CRLF default', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        required: ['memo'], properties: { memo: { type: 'string', default: 'a\r\nb' } } } }),
    ], '@graph': [
      { '@id': '#SN', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:amt' }, 'sh:name': 'amt',
        'sh:datatype': { '@id': 'xsd:decimal' }, 'sh:defaultValue': '   ', 'sh:maxCount': 1 } },
      { '@id': '#SL', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:mt' }, 'sh:name': 'mt',
        'sh:datatype': { '@id': 'xsd:string' }, 'sh:defaultValue': '  ' } },
      { '@id': '#J', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:data' }, 'sh:name': 'data',
        'sh:datatype': { '@id': 'rdf:JSON' }, 'sh:maxCount': 1 } },
      { '@id': '#B', '@type': 'sh:NodeShape', 'rdfs:label': 'JSON body', 'sh:datatype': { '@id': 'rdf:JSON' } },
      { '@id': '#L', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:one' }, 'sh:name': 'one', 'sh:maxLength': 1, 'sh:maxCount': 1 },
        { 'sh:path': { '@id': 'urn:p:two' }, 'sh:name': 'two', 'sh:minLength': 2, 'sh:maxCount': 1 }] },
      { '@id': '#T', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:tags' }, 'sh:name': 'tags' },
        { 'sh:path': { '@id': 'urn:p:short' }, 'sh:name': 'short', 'sh:maxLength': 10 },
        { 'sh:path': { '@id': 'urn:p:nums' }, 'sh:name': 'nums', 'sh:datatype': { '@id': 'xsd:double' } },
        { 'sh:path': { '@id': 'urn:p:counts' }, 'sh:name': 'counts', 'sh:datatype': { '@id': 'xsd:integer' } }] },
      { '@id': '#D', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:lines' }, 'sh:name': 'lines', 'sh:defaultValue': ['a\nb', 'c'] },
        { 'sh:path': { '@id': 'urn:p:picks' }, 'sh:name': 'picks', 'sh:in': ['x', 'y', 'z'], 'sh:defaultValue': ['z', 'x'] },
        { 'sh:path': { '@id': 'urn:p:held' }, 'sh:name': 'held', 'sh:in': ['x', 'y', 'z'], 'sh:defaultValue': ['x', 'z'] }] },
      { '@id': '#W', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:picks' }, 'sh:name': 'picks', 'sh:in': ['x', 'y', 'z'], 'sh:defaultValue': ['x', 'w'] }] },
    ] },
    // Enumerations whose entries are JSON values of every kind: an array, an object, nested arrays,
    // entries of mixed kinds in a property with no type, null, numbers written 1.0 and past 2^53
    // inside arrays and objects, a list whose items each have choices, a const, two entries
    // written alike, defaults that are another JSON value than the choice their text names, and an
    // integer field's entry and const past 2^53. CHOICE_CASES reads them.
    '/choices': { '@context': CTX, '@id': `${base}/choices`, 'iep:affordance': [
      schemaOp('a', 'urn:choice:array', 'POST', 'Array choice', { selection: { type: 'array', enum: [['allowed']] } }),
      schemaOp('o', 'urn:choice:object', 'POST', 'Object choice', { pick: { type: 'object', enum: [{ a: 1, b: [2, 3] }] } }),
      schemaOp('n', 'urn:choice:nested', 'POST', 'Nested choice', { grid: { type: 'array', enum: [[[1, 2], [3]], [[]]] } }),
      schemaOp('m', 'urn:choice:mixed', 'POST', 'Mixed choice', { mode: { enum: ['plain', 1, true, ['x'], { k: 'v' }] } }),
      schemaOp('u', 'urn:choice:null', 'POST', 'Null choice', { state: { enum: ['open', null] },
        kind: { type: ['string', 'null'], enum: ['a', null] } }),
      schemaOp('ur', 'urn:choice:null-read', 'GET', 'Read of a null choice', { state: { enum: ['open', null] } }),
      schemaOp('ua', 'urn:choice:null-array', 'POST', 'Null array choice', { list: { type: ['array', 'null'], enum: [null, ['a']] } }),
      schemaOp('nu', 'urn:choice:numbers', 'POST', 'Number choice', { pair: { type: 'array',
        enum: [['CHOICE-ONE', { n: 'CHOICE-TWO' }], ['CHOICE-PAST-SAFE']] } }),
      op('l', 'urn:choice:list', 'POST', 'List choice', { ...target('/num-target'), 'hydra:expects': { '@id': '#CL' } }),
      schemaOp('i', 'urn:choice:items', 'POST', 'Item choice', { codes: { type: 'array', items: { enum: ['x', 'y'] } } }),
      schemaOp('c', 'urn:choice:const', 'POST', 'Const choice', { v: { const: { a: [1] } } }),
      schemaOp('w', 'urn:choice:alike', 'POST', 'Alike choice', { flag: { enum: ['true', true] } }),
      schemaOp('dt', 'urn:choice:text-default', 'POST', 'Number default of a text choice', { m: { enum: ['1'], default: 1 } }),
      schemaOp('ds', 'urn:choice:typed-default', 'POST', 'Number default of a string choice', { m: { type: 'string', enum: ['1'], default: 1 } }),
      schemaOp('db', 'urn:choice:bool-default', 'POST', 'Boolean default of a text choice', { m: { enum: ['true'], default: true } }),
      schemaOp('dn', 'urn:choice:number-default', 'POST', 'Text default of a number choice', { m: { enum: [1], default: '1' } }),
      schemaOp('dd', 'urn:choice:same-default', 'POST', 'Default that is a choice', { m: { enum: [1, 2], default: 2 } }),
      schemaOp('ip', 'urn:choice:past-safe', 'POST', 'Integer choice past 2^53', { n: { type: 'integer', enum: ['INTEGER-PAST-SAFE'] } }),
      schemaOp('ic', 'urn:choice:past-safe-const', 'POST', 'Integer const past 2^53', { n: { type: 'integer', const: 'CONST-PAST-SAFE' } }),
    ], '@graph': [
      { '@id': '#CL', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:tags' }, 'sh:name': 'tags', 'sh:in': ['a', 'b'] } },
    ] },
    // Every other value constraint either client reads, written so that a value of each kind meets
    // it: JSON Schema's exclusive bounds, a type of array or object, a keyword neither client checks,
    // lengths given a number, a bound given text, a schema inside a property, types read as no one
    // input, and keywords written in forms JSON Schema does not allow; SHACL's exclusive bounds, a
    // datatype whose form is not checked, a bound that is not a number, an integer type's range,
    // node kinds, sh:class, sh:node, rdf:JSON with a length or choices, sh:hasValue and
    // sh:qualifiedValueShape; hydra:writable; a body schema with a keyword neither client checks, or
    // that requires a name it does not describe; and values an address leaves out. Then a body schema
    // with an enum or a const; a template variable that is no property, under additionalProperties
    // false or a schema; a property shape's own sh:property and sh:closed; bodies sent whole with
    // sh:in, a bound, a node kind, sh:languageIn or sh:hasValue; a shape with properties and its own
    // sh:in or sh:nodeKind; node kinds on a JSON array's items and on rdf:JSON; a float past the
    // largest float; a field written in place with a key the reader does not model; a bound and a
    // length written as text; entries past a double; and readOnly. SWEEP_CASES reads them.
    '/sweep': { '@context': CTX, '@id': `${base}/sweep`, 'iep:affordance': [
      schemaOp('e', 'urn:sweep:exclusive', 'POST', 'Exclusive bounds', { n: { type: 'integer', exclusiveMinimum: 0, exclusiveMaximum: 10 },
        m: { type: 'number', minimum: 0, exclusiveMinimum: true } }),
      schemaOp('j', 'urn:sweep:json-type', 'POST', 'Array or object', { extra: { type: ['array', 'object'] } }),
      schemaOp('k', 'urn:sweep:unchecked', 'POST', 'Unchecked keywords', { u: { type: 'array', uniqueItems: true },
        w: { type: 'array', items: { type: 'number', multipleOf: 2 } } }),
      schemaOp('nl', 'urn:sweep:number-length', 'POST', 'Number length', { n: { type: 'integer', maxLength: 1 } }),
      schemaOp('sb', 'urn:sweep:string-bound', 'POST', 'String bound', { s: { type: 'string', minimum: 5 } }),
      schemaOp('ns', 'urn:sweep:nested', 'POST', 'Nested schema', { doc: { type: 'object', required: ['id'], additionalProperties: false,
        properties: { id: { type: 'integer', minimum: 1 }, tags: { type: 'array', maxItems: 2, items: { type: 'string', maxLength: 3 } } } } }),
      schemaOp('un', 'urn:sweep:union', 'POST', 'Type union', { u: { type: ['integer', 'boolean'] } }),
      schemaOp('bt', 'urn:sweep:bad-type', 'POST', 'Bad type', { u: { type: 'int' } }),
      schemaOp('bl', 'urn:sweep:bad-length', 'POST', 'Bad length', { u: { type: 'string', maxLength: 2.5 } }),
      schemaOp('bb', 'urn:sweep:bad-bound', 'POST', 'Bad bound', { u: { type: 'integer', minimum: 'low' } }),
      op('s', 'urn:sweep:shacl', 'POST', 'Shape constraints', { ...target('/num-target'), 'hydra:expects': { '@id': '#SW' } }),
      op('h', 'urn:sweep:has-value', 'POST', 'Has value', { ...target('/num-target'), 'hydra:expects': { '@id': '#HV' } }),
      op('q', 'urn:sweep:qualified', 'POST', 'Qualified shape', { ...target('/num-target'), 'hydra:expects': { '@id': '#QV' } }),
      op('hw', 'urn:sweep:writable', 'POST', 'Writable', { ...target('/num-target'), 'hydra:expects': { '@id': '#HC' } }),
      schemaOp('er', 'urn:sweep:empty-read', 'GET', 'Empty read', { list: { type: 'array' }, doc: { type: 'object' } }),
      op('ra', 'urn:sweep:root-all-of', 'POST', 'Root allOf', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { a: { type: 'string' } }, allOf: [{ required: ['a'] }] } }),
      op('rr', 'urn:sweep:root-required', 'POST', 'Root required', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        required: ['b'], properties: { a: { type: 'string' } } } }),
      op('re', 'urn:sweep:root-enum', 'POST', 'Root enum', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { a: { type: 'string' } }, enum: [{ a: 'x' }] } }),
      op('rc', 'urn:sweep:root-const', 'POST', 'Root const', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { a: { type: 'string' } }, const: { a: 'x' } } }),
      op('xf', 'urn:sweep:extra-false', 'POST', 'Template variable, no other property', { 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/num-target{?q}`, 'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:property': { '@id': 'urn:p:q' } }] },
      'hydra:expects': { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false } }),
      op('xs', 'urn:sweep:extra-schema', 'POST', 'Template variable, other properties bounded', { 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/num-target{?q}`, 'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:property': { '@id': 'urn:p:q' } }] },
      'hydra:expects': { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: { type: 'integer', maximum: 5 } } }),
      op('pn', 'urn:sweep:nested-shape', 'POST', 'Nested shape', { ...target('/num-target'), 'hydra:expects': { '@id': '#PS' } }),
      op('ri', 'urn:sweep:raw-in', 'POST', 'Body choices', { ...target('/num-target'), 'hydra:expects': { '@id': '#RI' } }),
      op('rm', 'urn:sweep:raw-bound', 'POST', 'Body bound', { ...target('/num-target'), 'hydra:expects': { '@id': '#RM' } }),
      op('rk', 'urn:sweep:raw-kind', 'POST', 'Body node kind', { ...target('/num-target'), 'hydra:expects': { '@id': '#RK' } }),
      op('rl', 'urn:sweep:raw-language', 'POST', 'Body language', { ...target('/num-target'), 'hydra:expects': { '@id': '#RL' } }),
      op('rh', 'urn:sweep:raw-has-value', 'POST', 'Body value', { ...target('/num-target'), 'hydra:expects': { '@id': '#RH' } }),
      op('ni', 'urn:sweep:node-in', 'POST', 'Shape choices', { ...target('/num-target'), 'hydra:expects': { '@id': '#NI' } }),
      op('nk', 'urn:sweep:node-kind', 'POST', 'Shape node kind', { ...target('/num-target'), 'hydra:expects': { '@id': '#NK' } }),
      op('if', 'urn:sweep:inline-key', 'POST', 'Inline field choices', { ...target('/num-target'),
        fields: [{ name: 'x', path: 'urn:x', in: ['a'] }] }),
      schemaOp('tb', 'urn:sweep:text-bound', 'POST', 'Bound as text', { n: { type: 'integer', minimum: '5' } }),
      schemaOp('tl', 'urn:sweep:text-length', 'POST', 'Length as text', { s: { type: 'string', minLength: '3' } }),
      schemaOp('ie', 'urn:sweep:infinite-entry', 'POST', 'Entry past a double', { m: { enum: ['INFINITE-ENTRY', null] } }),
      schemaOp('in', 'urn:sweep:infinite-number', 'POST', 'Number entry past a double', { m: { type: 'number', enum: ['INFINITE-ENTRY', 1] } }),
      schemaOp('ro', 'urn:sweep:read-only', 'POST', 'Read-only', { id: { type: 'string', readOnly: true }, name: { type: 'string' },
        doc: { type: 'object', properties: { id: { readOnly: true } } } }),
    ], '@graph': [
      { '@id': '#SW', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:ex' }, 'sh:name': 'ex', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:integer' },
          'sh:minExclusive': 0, 'sh:maxExclusive': 10 },
        { 'sh:path': { '@id': 'urn:p:day' }, 'sh:name': 'day', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:date' } },
        { 'sh:path': { '@id': 'urn:p:when' }, 'sh:name': 'when', 'sh:maxCount': 1, 'sh:minInclusive': '2024-01-01' },
        { 'sh:path': { '@id': 'urn:p:pos' }, 'sh:name': 'pos', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:positiveInteger' } },
        { 'sh:path': { '@id': 'urn:p:byte' }, 'sh:name': 'byte', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:byte' } },
        { 'sh:path': { '@id': 'urn:p:iri' }, 'sh:name': 'iri', 'sh:maxCount': 1, 'sh:nodeKind': { '@id': 'sh:IRI' } },
        { 'sh:path': { '@id': 'urn:p:cls' }, 'sh:name': 'cls', 'sh:maxCount': 1, 'sh:class': { '@id': 'urn:class:Thing' } },
        { 'sh:path': { '@id': 'urn:p:node' }, 'sh:name': 'node', 'sh:maxCount': 1, 'sh:node': { '@id': '#NS' } },
        { 'sh:path': { '@id': 'urn:p:jlen' }, 'sh:name': 'jlen', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'rdf:JSON' }, 'sh:maxLength': 5 },
        { 'sh:path': { '@id': 'urn:p:jin' }, 'sh:name': 'jin', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'rdf:JSON' }, 'sh:in': ['[1]', '"x"'] },
        { 'sh:path': { '@id': 'urn:p:nodes' }, 'sh:name': 'nodes', 'sh:nodeKind': { '@id': 'sh:BlankNode' } },
        { 'sh:path': { '@id': 'urn:p:jlit' }, 'sh:name': 'jlit', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'rdf:JSON' }, 'sh:nodeKind': { '@id': 'sh:Literal' } },
        { 'sh:path': { '@id': 'urn:p:jnode' }, 'sh:name': 'jnode', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'rdf:JSON' }, 'sh:nodeKind': { '@id': 'sh:BlankNode' } },
        { 'sh:path': { '@id': 'urn:p:fl' }, 'sh:name': 'fl', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:float' } },
      ] },
      { '@id': '#PS', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:d' }, 'sh:name': 'd', 'sh:maxCount': 1, 'sh:nodeKind': { '@id': 'sh:BlankNode' },
          'sh:property': { 'sh:path': { '@id': 'urn:p:id' }, 'sh:minCount': 1 } },
        { 'sh:path': { '@id': 'urn:p:e' }, 'sh:name': 'e', 'sh:maxCount': 1, 'sh:nodeKind': { '@id': 'sh:BlankNode' }, 'sh:closed': true },
        { 'sh:path': { '@id': 'urn:p:f' }, 'sh:name': 'f', 'sh:maxCount': 1, 'sh:nodeKind': { '@id': 'sh:BlankNode' }, 'sh:closed': false },
      ] },
      { '@id': '#RI', '@type': 'sh:NodeShape', 'sh:datatype': { '@id': 'xsd:string' }, 'sh:in': { '@list': ['a', 'b'] } },
      { '@id': '#RM', '@type': 'sh:NodeShape', 'sh:datatype': { '@id': 'xsd:integer' }, 'sh:maxInclusive': 5 },
      { '@id': '#RK', '@type': 'sh:NodeShape', 'sh:datatype': { '@id': 'xsd:string' }, 'sh:nodeKind': { '@id': 'sh:IRI' } },
      { '@id': '#RL', '@type': 'sh:NodeShape', 'sh:datatype': { '@id': 'xsd:string' }, 'sh:languageIn': { '@list': ['en'] } },
      { '@id': '#RH', '@type': 'sh:NodeShape', 'sh:hasValue': 'yes' },
      { '@id': '#NI', '@type': 'sh:NodeShape', 'sh:in': { '@list': ['a'] },
        'sh:property': { 'sh:path': { '@id': 'urn:p:z' }, 'sh:name': 'z', 'sh:maxCount': 1 } },
      { '@id': '#NK', '@type': 'sh:NodeShape', 'sh:nodeKind': { '@id': 'sh:IRI' },
        'sh:property': { 'sh:path': { '@id': 'urn:p:z' }, 'sh:name': 'z', 'sh:maxCount': 1 } },
      { '@id': '#NS', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:a' }, 'sh:datatype': { '@id': 'xsd:integer' } } },
      { '@id': '#HV', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:fixed' }, 'sh:name': 'fixed', 'sh:maxCount': 1, 'sh:hasValue': 'yes' },
        { 'sh:path': { '@id': 'urn:p:tags' }, 'sh:name': 'tags', 'sh:hasValue': 'a' },
      ] },
      { '@id': '#QV', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:q' }, 'sh:name': 'q',
        'sh:qualifiedValueShape': { '@id': '#NS' }, 'sh:qualifiedMinCount': 1 } },
      { '@id': '#HC', '@type': 'hydra:Class', 'hydra:supportedProperty': [
        { 'hydra:property': { '@id': 'urn:p:id' }, 'hydra:writable': false },
        { 'hydra:property': { '@id': 'urn:p:name' } },
      ] },
    ] },
    // Constraints both clients read but once passed over, and defaults read as the document gives
    // them: defaults of another kind than their field's, a SHACL count of 0, fields written in place
    // with counts and rdf:JSON, alone and beside a shape the document describes or does not, a body
    // schema with no properties, a closed shape with a template variable, bounds on fields that take
    // no number, dates and times, a property name with "/", readOnly on the body and on a property
    // with a default, a property not written with a default, and number entries past 2^53.
    // RULE_CASES and WARNING_CASES read them.
    '/rules': { '@context': CTX, '@id': `${base}/rules`, 'iep:affordance': [
      schemaOp('ds', 'urn:rules:schema-default', 'POST', 'String default 1', { m: { type: 'string', default: 1 } }),
      schemaOp('du', 'urn:rules:untyped-default', 'POST', 'Untyped object default', { m: { default: { k: 1 } } }),
      op('sd', 'urn:rules:shape-default', 'POST', 'Shape number default', { ...target('/num-target'), 'hydra:expects': { '@id': '#SD' } }),
      op('su', 'urn:rules:shape-untyped', 'POST', 'Untyped shape number default', { ...target('/num-target'), 'hydra:expects': { '@id': '#SU' } }),
      op('sl', 'urn:rules:list-default', 'POST', 'List number default', { ...target('/num-target'), 'hydra:expects': { '@id': '#SL' } }),
      op('sb', 'urn:rules:bool-default', 'POST', 'Boolean number default', { ...target('/num-target'), 'hydra:expects': { '@id': '#SB' } }),
      op('sn', 'urn:rules:number-text-default', 'POST', 'Number text default', { ...target('/num-target'), 'hydra:expects': { '@id': '#SN' } }),
      op('zc', 'urn:rules:zero', 'POST', 'No value', { ...target('/num-target'), 'hydra:expects': { '@id': '#ZC' } }),
      op('zd', 'urn:rules:zero-default', 'POST', 'No value, with a default', { ...target('/num-target'), 'hydra:expects': { '@id': '#ZD' } }),
      op('im', 'urn:rules:inline-min', 'POST', 'Inline two or more', { ...target('/num-target'), fields: [{ name: 'x', path: 'urn:x', minCount: 2 }] }),
      op('ix', 'urn:rules:inline-max', 'POST', 'Inline three or fewer', { ...target('/num-target'), fields: [{ name: 'x', path: 'urn:x', maxCount: 3 }] }),
      op('iz', 'urn:rules:inline-zero', 'POST', 'Inline none', { ...target('/num-target'), fields: [{ name: 'x', path: 'urn:x', maxCount: 0 }] }),
      op('ij', 'urn:rules:inline-json', 'POST', 'Inline JSON', { ...target('/num-target'), fields: [{ name: 'x', path: 'urn:x', datatype: 'rdf:JSON' }] }),
      op('is', 'urn:rules:inline-schema', 'POST', 'Inline beside a schema', { ...target('/num-target'), fields: [{ name: 'x' }],
        'hydra:expects': { type: 'object', properties: { x: { type: 'string', enum: ['a'] } } } }),
      op('ih', 'urn:rules:inline-shape', 'POST', 'Inline beside a shape', { ...target('/num-target'), fields: [{ name: 'x' }],
        'hydra:expects': { '@id': '#IS' } }),
      op('id', 'urn:rules:inline-disagree', 'POST', 'Inline that disagrees', { ...target('/num-target'),
        fields: [{ name: 'x', datatype: 'xsd:integer' }], 'hydra:expects': { type: 'object', properties: { x: { type: 'string' } } } }),
      op('ie', 'urn:rules:inline-extra', 'POST', 'Inline the shape lacks', { ...target('/num-target'),
        fields: [{ name: 'y' }], 'hydra:expects': { type: 'object', properties: { x: { type: 'string' } } } }),
      op('io', 'urn:rules:inline-outside', 'POST', 'Inline beside an outside shape', { ...target('/num-target'),
        fields: [{ name: 'x' }], 'hydra:expects': { '@id': 'https://vocab.example/Outside' } }),
      op('nf', 'urn:rules:no-props-false', 'POST', 'Body of no properties', { 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/num-target{?q}`, 'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:property': { '@id': 'urn:p:q' } }] },
      'hydra:expects': { type: 'object', additionalProperties: false } }),
      op('nr', 'urn:rules:no-props-required', 'POST', 'Body requiring what it lacks', { ...target('/num-target'),
        'hydra:expects': { type: 'object', required: ['x'] } }),
      op('cv', 'urn:rules:closed-var', 'POST', 'Closed shape variable', { 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/num-target{?q}`, 'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:property': { '@id': 'urn:p:q' } }] },
      'hydra:expects': { '@id': '#CS' } }),
      op('ci', 'urn:rules:closed-ignored', 'POST', 'Closed shape ignoring the variable', { 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/num-target{?q}`, 'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:property': { '@id': 'urn:p:q' } }] },
      'hydra:expects': { '@id': '#CI' } }),
      op('bt', 'urn:rules:text-bounds', 'POST', 'Bounds on text', { ...target('/num-target'), 'hydra:expects': { '@id': '#BT' } }),
      schemaOp('sn2', 'urn:rules:slash-name', 'POST', 'Slash name', { 'd/x': { type: 'array', items: { type: 'integer' } } }),
      op('rr', 'urn:rules:root-read-only', 'POST', 'Read-only body', { ...target('/num-target'),
        'hydra:expects': { type: 'object', readOnly: true, properties: { a: { type: 'string' } } } }),
      schemaOp('rd', 'urn:rules:read-only-default', 'POST', 'Read-only default', { id: { type: 'string', readOnly: true, default: 'x' },
        name: { type: 'string' } }),
      op('wd', 'urn:rules:unwritable-default', 'POST', 'Unwritable default', { ...target('/num-target'), 'hydra:expects': { '@id': '#WD' } }),
      schemaOp('np', 'urn:rules:number-past-safe', 'POST', 'Number entry past 2^53', { n: { type: 'number', enum: ['NUMBER-PAST-SAFE'] } }),
      schemaOp('up', 'urn:rules:untyped-past-safe', 'POST', 'Untyped entry past 2^53', { m: { enum: ['NUMBER-PAST-SAFE', 'a'] } }),
      op('ee', 'urn:rules:empty-entry', 'POST', 'Empty entry', { ...target('/num-target'), 'hydra:expects': { '@id': '#EE' } }),
      // A shape the document describes with no properties is still the shape: closed, it allows no
      // template variable sh:ignoredProperties does not name, and beside it no field written in
      // place is one of its inputs; open or closed, its warning says it is described.
      op('ce', 'urn:rules:closed-empty-var', 'POST', 'Closed empty shape variable', { 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/num-target{?q}`, 'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:property': { '@id': 'urn:p:q' } }] },
      'hydra:expects': { '@id': '#CE' } }),
      op('cg', 'urn:rules:closed-empty-ignored', 'POST', 'Closed empty shape ignoring the variable', { 'hydra:target': {
        '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/num-target{?q}`,
        'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:property': { '@id': 'urn:p:q' } }] }, 'hydra:expects': { '@id': '#CG' } }),
      op('cf', 'urn:rules:closed-empty-inline', 'POST', 'Inline beside a closed empty shape', { ...target('/num-target'),
        fields: [{ name: 'x' }], 'hydra:expects': { '@id': '#CE' } }),
      op('of', 'urn:rules:open-empty-inline', 'POST', 'Inline beside an open empty shape', { ...target('/num-target'),
        fields: [{ name: 'x' }], 'hydra:expects': { '@id': 'urn:shape:Empty' } }),
      op('es', 'urn:rules:empty-shape', 'POST', 'Empty shape', { ...target('/num-target'), 'hydra:expects': { '@id': 'urn:shape:Empty' } }),
      op('ec', 'urn:rules:empty-class', 'POST', 'Empty class', { ...target('/num-target'), 'hydra:expects': { '@id': 'urn:class:Empty' } }),
      // A JSON Schema default is checked as the document gives it, text included: never trimmed,
      // read as a number or a boolean, or parsed as JSON. A shape's boolean default is an XSD
      // boolean's text.
      schemaOp('tn', 'urn:rules:number-text-schema', 'POST', 'Schema number text default', { m: { type: 'number', default: '5' } }),
      schemaOp('ti', 'urn:rules:integer-text-schema', 'POST', 'Schema integer text default', { m: { type: 'integer', default: ' 7 ' } }),
      schemaOp('tb', 'urn:rules:boolean-text-schema', 'POST', 'Schema boolean text default', { m: { type: 'boolean', default: 'yes' } }),
      schemaOp('to', 'urn:rules:object-text-schema', 'POST', 'Schema object text default', { m: { type: 'object', default: '{}' } }),
      schemaOp('te', 'urn:rules:enum-text-schema', 'POST', 'Schema enum text default', { m: { type: 'integer', enum: [1], default: '1' } }),
      op('sy', 'urn:rules:bool-yes-default', 'POST', 'Boolean yes default', { ...target('/num-target'), 'hydra:expects': { '@id': '#SY' } }),
      op('sz', 'urn:rules:bool-text-default', 'POST', 'Boolean text default', { ...target('/num-target'), 'hydra:expects': { '@id': '#SZ' } }),
      // A schema inside a property's schema written as a reference (@id) is not read: a value given is refused.
      schemaOp('nz', 'urn:rules:nested-ref', 'POST', 'Nested reference', { a: { type: 'array', items: { '@id': '#E' } },
        o: { type: 'object', additionalProperties: { '@id': '#E' } }, p: { type: 'object', properties: { k: { '@id': '#E' } } } }),
      // Counts and lengths written in place that are not whole numbers of zero or more, which the
      // substrate's lift drops, and a shape's negative sh:maxCount.
      op('if', 'urn:rules:inline-fraction', 'POST', 'Inline fraction count', { ...target('/num-target'), fields: [{ name: 'x', maxCount: 1.5 }] }),
      op('it', 'urn:rules:inline-text-count', 'POST', 'Inline text length', { ...target('/num-target'), fields: [{ name: 'x', minLength: '2' }] }),
      op('in', 'urn:rules:inline-negative', 'POST', 'Inline negative count', { ...target('/num-target'), fields: [{ name: 'x', maxCount: -1 }] }),
      op('sm', 'urn:rules:shape-negative', 'POST', 'Shape negative count', { ...target('/num-target'), 'hydra:expects': { '@id': '#NC' } }),
      // Entries an integer past 2^53, which reading JSON may have rounded, match nothing: a sh:in,
      // a sh:hasValue, and an enum and a const inside a property's schema.
      op('ri', 'urn:rules:rounded-in', 'POST', 'Rounded entries', { ...target('/num-target'), 'hydra:expects': { '@id': '#RI' } }),
      op('rh', 'urn:rules:rounded-has-value', 'POST', 'Rounded has value', { ...target('/num-target'), 'hydra:expects': { '@id': '#RH' } }),
      schemaOp('rn', 'urn:rules:rounded-nested', 'POST', 'Rounded nested entries', { a: { type: 'array', items: { enum: ['NUMBER-PAST-SAFE', 1] } },
        o: { type: 'object', enum: [{ a: 'NUMBER-PAST-SAFE' }] }, c: { type: 'array', items: { const: 'NUMBER-PAST-SAFE' } } }),
      // A list default holding a blank value, and JSON Schema defaults of null.
      op('lb', 'urn:rules:list-blank-default', 'POST', 'List blank default', { ...target('/num-target'), 'hydra:expects': { '@id': '#LB' } }),
      schemaOp('nd', 'urn:rules:null-default', 'POST', 'Null choice default', { m: { enum: ['a', null], default: null } }),
      schemaOp('nn', 'urn:rules:nullable-default', 'POST', 'Nullable default', { m: { type: ['string', 'null'], default: null } }),
      schemaOp('nx', 'urn:rules:null-not-allowed', 'POST', 'Null default not allowed', { m: { type: 'string', default: null } }),
      // A default of empty text is a value: sent as it is in a body, and refused by name where an
      // address would leave it out or the field reads no value in it.
      schemaOp('xs', 'urn:rules:empty-text-schema', 'POST', 'Empty text schema default', { m: { type: 'string', default: '' } }),
      op('xh', 'urn:rules:empty-text-shape', 'POST', 'Empty text shape default', { ...target('/num-target'), 'hydra:expects': { '@id': '#XT' } }),
      op('xi', 'urn:rules:empty-text-inline', 'POST', 'Empty text inline default', { ...target('/num-target'), fields: [{ name: 'm', defaultValue: '' }] }),
      op('xr', 'urn:rules:empty-text-read', 'GET', 'Empty text read default', { ...target('/num-target'), 'hydra:expects': { '@id': '#XT' } }),
      op('xn', 'urn:rules:empty-text-number', 'POST', 'Empty text number default', { ...target('/num-target'), 'hydra:expects': { '@id': '#XN' } }),
      op('xb', 'urn:rules:empty-text-boolean', 'POST', 'Empty text boolean default', { ...target('/num-target'), 'hydra:expects': { '@id': '#XB' } }),
      // JSON-LD keywords inside a schema written in place are no JSON Schema keyword this client
      // checks: each is named where it is, and a value given is refused.
      schemaOp('kw', 'urn:rules:keyword-schema', 'POST', 'JSON-LD keywords in a schema', {
        a: { type: 'array', items: { '@set': [{ type: 'integer' }] } }, s: { '@set': [{ type: 'integer' }] },
        l: { type: 'array', items: { '@list': [{ type: 'integer' }] } }, g: { type: 'object', properties: { k: { '@graph': [{ type: 'integer' }] } } },
        v: { type: 'array', items: { '@value': { type: 'integer' }, '@type': '@json' } },
        x: { type: 'object', additionalProperties: { '@set': [{ type: 'integer' }] } } }),
      // A list's sh:hasValue that is an integer past 2^53, and a JSON Schema number's default of only spaces.
      op('rv', 'urn:rules:rounded-has-value-list', 'POST', 'Rounded has value list', { ...target('/num-target'), 'hydra:expects': { '@id': '#RL' } }),
      schemaOp('sp', 'urn:rules:space-number-schema', 'POST', 'Schema number space default', { m: { type: 'number', default: '  ' } }),
      // An integer field's value past 2^53, which a JSON number cannot carry exactly, in either client.
      op('ip', 'urn:rules:integer-past-safe', 'POST', 'Integers past 2^53', { ...target('/num-target'), 'hydra:expects': { '@id': '#IP' } }),
      // A supported property with no sh:name whose hydra:property is a blank node is named by that
      // node's rdfs:label, which each client reads twice, for what the field shows and for its name.
      ...([['lt', 'tagged', 'Language-tagged label', { '@value': 'title', '@language': 'en' }], ['la', 'array', 'Array label', ['title']]] as const)
        .map(([id, kind, title, label]) => op(id, `urn:rules:${kind}-label`, 'POST', title, { ...target('/num-target'), 'hydra:expects': {
          '@type': 'hydra:Class', 'hydra:supportedProperty': [{ '@type': 'hydra:SupportedProperty',
            'hydra:property': { '@type': 'rdf:Property', 'rdfs:label': label } }] } })),
    ], '@graph': [
      { '@id': '#XT', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1,
        'sh:defaultValue': '' } },
      { '@id': '#XN', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:integer' }, 'sh:defaultValue': '' } },
      { '@id': '#XB', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:boolean' }, 'sh:defaultValue': '' } },
      { '@id': '#RL', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:r' }, 'sh:name': 'r',
        'sh:datatype': { '@id': 'xsd:decimal' }, 'sh:hasValue': 'NUMBER-PAST-SAFE' } },
      { '@id': '#IP', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:l' }, 'sh:name': 'l', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:long' } },
        { 'sh:path': { '@id': 'urn:p:i' }, 'sh:name': 'i', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:int' } },
        { 'sh:path': { '@id': 'urn:p:g' }, 'sh:name': 'g', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:integer' }, 'sh:maxInclusive': 2.5 }] },
      { '@id': '#SD', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:string' }, 'sh:defaultValue': 5 } },
      { '@id': '#SU', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1,
        'sh:defaultValue': 5 } },
      { '@id': '#SL', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm',
        'sh:datatype': { '@id': 'xsd:string' }, 'sh:defaultValue': [1, 'a'] } },
      { '@id': '#SB', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:b' }, 'sh:name': 'b', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:boolean' }, 'sh:defaultValue': 1 } },
      { '@id': '#SN', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:n' }, 'sh:name': 'n', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:integer' }, 'sh:defaultValue': '7' } },
      { '@id': '#ZC', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 0 } },
      { '@id': '#ZD', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 0,
        'sh:defaultValue': 'd' } },
      { '@id': '#IS', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:x' }, 'sh:name': 'x', 'sh:maxCount': 1,
        'sh:in': ['a'] } },
      { '@id': '#CS', '@type': 'sh:NodeShape', 'sh:closed': true,
        'sh:property': { 'sh:path': { '@id': 'urn:p:a' }, 'sh:name': 'a', 'sh:maxCount': 1 } },
      { '@id': '#CI', '@type': 'sh:NodeShape', 'sh:closed': true, 'sh:ignoredProperties': { '@list': [{ '@id': 'urn:p:q' }] },
        'sh:property': { 'sh:path': { '@id': 'urn:p:a' }, 'sh:name': 'a', 'sh:maxCount': 1 } },
      { '@id': '#BT', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:tb' }, 'sh:name': 'tb', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:string' }, 'sh:minInclusive': 3 },
        { 'sh:path': { '@id': 'urn:p:ub' }, 'sh:name': 'ub', 'sh:maxCount': 1, 'sh:minInclusive': 3 },
        { 'sh:path': { '@id': 'urn:p:since' }, 'sh:name': 'since', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:date' },
          'sh:minInclusive': '2020-01-01' },
        { 'sh:path': { '@id': 'urn:p:when' }, 'sh:name': 'when', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:dateTimeStamp' } },
        { 'sh:path': { '@id': 'urn:p:span' }, 'sh:name': 'span', 'sh:datatype': { '@id': 'xsd:dayTimeDuration' } },
      ] },
      { '@id': '#WD', '@type': 'hydra:Class', 'hydra:supportedProperty': [
        { 'hydra:property': { '@id': 'urn:p:id' }, 'hydra:writable': false, 'sh:defaultValue': 'x' },
        { 'hydra:property': { '@id': 'urn:p:name' } },
      ] },
      { '@id': '#EE', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:c' }, 'sh:name': 'c', 'sh:maxCount': 1,
        'sh:in': ['', 'a'] } },
      { '@id': '#CE', '@type': 'sh:NodeShape', 'sh:closed': true },
      { '@id': '#CG', '@type': 'sh:NodeShape', 'sh:closed': true, 'sh:ignoredProperties': { '@list': [{ '@id': 'urn:p:q' }] } },
      { '@id': 'urn:shape:Empty', '@type': 'sh:NodeShape' },
      { '@id': 'urn:class:Empty', '@type': 'hydra:Class' },
      { '@id': '#SY', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:b' }, 'sh:name': 'b', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:boolean' }, 'sh:defaultValue': 'yes' } },
      { '@id': '#SZ', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:b' }, 'sh:name': 'b', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:boolean' }, 'sh:defaultValue': '0' } },
      { '@id': '#E', type: 'string', enum: ['a', 'b'] },
      { '@id': '#NC', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': -1 } },
      { '@id': '#RI', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:u' }, 'sh:name': 'u', 'sh:maxCount': 1, 'sh:in': { '@list': ['NUMBER-PAST-SAFE', 1] } },
        { 'sh:path': { '@id': 'urn:p:d' }, 'sh:name': 'd', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:decimal' },
          'sh:in': { '@list': ['NUMBER-PAST-SAFE', 1] } },
        { 'sh:path': { '@id': 'urn:p:j' }, 'sh:name': 'j', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'rdf:JSON' },
          'sh:in': { '@list': ['{"a":9007199254740993}', '{"a":1}'] } },
      ] },
      { '@id': '#RH', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:h' }, 'sh:name': 'h', 'sh:maxCount': 1,
        'sh:hasValue': 'NUMBER-PAST-SAFE' } },
      { '@id': '#LB', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm',
        'sh:datatype': { '@id': 'xsd:string' }, 'sh:defaultValue': ['a', ''] } },
    ] },
    // Numbers a double may not hold exactly: defaults that hold an integer past 2^53 at any depth, or a
    // number this document writes with digits its double drops (0.30000000000000000001, read as
    // 0.3), and JSON given or written as text that holds one. RULE_CASES read them.
    '/rounding': { '@context': CTX, '@id': `${base}/rounding`, 'iep:affordance': [
      schemaOp('nd', 'urn:round:number-default', 'POST', 'Number default past 2^53', { m: { type: 'number', default: 'PAST-SAFE' } }),
      schemaOp('id', 'urn:round:integer-default', 'POST', 'Integer default past 2^53', { m: { type: 'integer', default: 'PAST-SAFE' } }),
      schemaOp('ad', 'urn:round:array-default', 'POST', 'Array default past 2^53', { m: { type: 'array', items: { type: 'integer' }, default: ['PAST-SAFE'] } }),
      schemaOp('od', 'urn:round:object-default', 'POST', 'Untyped default past 2^53', { m: { default: { a: 'PAST-SAFE' } } }),
      schemaOp('fd', 'urn:round:fraction-default', 'POST', 'Number default past a double', { m: { type: 'number', default: 'PAST-DOUBLE' } }),
      op('sd', 'urn:round:decimal-default', 'POST', 'Decimal default past 2^53', { ...target('/num-target'), 'hydra:expects': { '@id': '#DD' } }),
      op('sl', 'urn:round:decimal-list-default', 'POST', 'Decimal list default past 2^53', { ...target('/num-target'), 'hydra:expects': { '@id': '#DL' } }),
      op('sb', 'urn:round:double-default', 'POST', 'Double default past 2^53', { ...target('/num-target'), 'hydra:expects': { '@id': '#DB' } }),
      op('sj', 'urn:round:json-text-default', 'POST', 'JSON text default past 2^53', { ...target('/num-target'), 'hydra:expects': { '@id': '#JD' } }),
      op('si', 'urn:round:inline-default', 'POST', 'Inline default past 2^53', { ...target('/num-target'), fields: [{ name: 'm', defaultValue: 'PAST-SAFE' }] }),
      schemaOp('og', 'urn:round:object', 'POST', 'Object given', { m: { type: 'object' } }),
      op('jg', 'urn:round:json', 'POST', 'JSON given', { ...target('/num-target'), 'hydra:expects': { '@id': '#JG' } }),
      op('lg', 'urn:round:list', 'POST', 'Decimal list given', { ...target('/num-target'), 'hydra:expects': { '@id': '#LG' } }),
    ], '@graph': [
      { '@id': '#DD', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:decimal' }, 'sh:defaultValue': 'PAST-SAFE' } },
      { '@id': '#DL', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm',
        'sh:datatype': { '@id': 'xsd:decimal' }, 'sh:defaultValue': [1, 'PAST-SAFE'] } },
      { '@id': '#DB', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:double' }, 'sh:defaultValue': 'PAST-SAFE' } },
      { '@id': '#JD', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'rdf:JSON' }, 'sh:defaultValue': '{"a":9007199254740993}' } },
      { '@id': '#JG', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'rdf:JSON' } } },
      { '@id': '#LG', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm',
        'sh:datatype': { '@id': 'xsd:decimal' } } },
    ] },
    // Values read strictly: an XSD boolean's forms, a list default that holds no value, a list whose
    // check stops at its first bad value, and a JSON literal schema with JSON-LD keywords at its top.
    // RULE_CASES read them.
    '/strict': { '@context': CTX, '@id': `${base}/strict`, 'iep:affordance': [
      op('bo', 'urn:strict:boolean', 'POST', 'Strict boolean', { ...target('/num-target'), 'hydra:expects': { '@id': '#BO' } }),
      op('bl', 'urn:strict:blank-list-default', 'POST', 'Blank list default', { ...target('/num-target'), 'hydra:expects': { '@id': '#BL' } }),
      op('ib', 'urn:strict:inline-blank-list', 'POST', 'Inline blank list default', { ...target('/num-target'),
        fields: [{ name: 'm', minCount: 2, defaultValue: '' }] }),
      op('ls', 'urn:strict:list-stop', 'POST', 'List stops', { ...target('/num-target'), 'hydra:expects': { '@id': '#LS' } }),
      op('lt', 'urn:strict:literal-type', 'POST', 'Literal schema type', { ...target('/num-target'),
        'hydra:expects': { '@type': '@json', '@value': { '@type': 'x', type: 'object', properties: { m: { type: 'string' } } } } }),
      op('lc', 'urn:strict:literal-context', 'POST', 'Literal schema context', { ...target('/num-target'),
        'hydra:expects': { '@type': '@json', '@value': { '@context': { k: 'urn:k' }, type: 'object', properties: { m: { type: 'string' } } } } }),
    ], '@graph': [
      { '@id': '#BO', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:b' }, 'sh:name': 'b', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:boolean' } } },
      { '@id': '#BL', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm',
        'sh:datatype': { '@id': 'xsd:string' }, 'sh:defaultValue': '' } },
      { '@id': '#LS', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm',
        'sh:datatype': { '@id': 'xsd:integer' }, 'sh:maxInclusive': 5 } },
    ] },
    // Bounds and entries whose number may not be what the document writes: text with more digits
    // than a double keeps, a JSON integer past 2^53, and a JSON number written with more digits than
    // its double keeps (0.30000000000000000001, read as 0.3). RULE_CASES read them.
    '/inexact': { '@context': CTX, '@id': `${base}/inexact`, 'iep:affordance': [
      op('sb', 'urn:inexact:shape', 'POST', 'Inexact shape', { ...target('/num-target'), 'hydra:expects': { '@id': '#SB' } }),
      op('hv', 'urn:inexact:has-value', 'POST', 'Inexact has value', { ...target('/num-target'), 'hydra:expects': { '@id': '#HV' } }),
      schemaOp('jb', 'urn:inexact:schema', 'POST', 'Inexact schema', { f: { type: 'number', minimum: 'PAST-SAFE' },
        g: { type: 'number', minimum: 'POINT-THREE' }, j: { type: 'number', enum: ['POINT-THREE', 1] }, k: { type: 'number', const: 'POINT-THREE' },
        l: { type: 'number', minimum: 0.5 } }),
    ], '@graph': [
      { '@id': '#HV', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:i' }, 'sh:name': 'i', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:decimal' }, 'sh:hasValue': 'POINT-THREE' } },
      { '@id': '#SB', '@type': 'sh:NodeShape', 'sh:property': [
        { 'sh:path': { '@id': 'urn:p:a' }, 'sh:name': 'a', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:decimal' },
          'sh:minInclusive': '0.30000000000000000001' },
        { 'sh:path': { '@id': 'urn:p:b' }, 'sh:name': 'b', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:decimal' }, 'sh:minInclusive': 'PAST-SAFE' },
        { 'sh:path': { '@id': 'urn:p:c' }, 'sh:name': 'c', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:double' }, 'sh:minInclusive': 'PAST-SAFE' },
        { 'sh:path': { '@id': 'urn:p:e' }, 'sh:name': 'e', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:decimal' },
          'sh:maxInclusive': '0.29999999999999999999' },
        { 'sh:path': { '@id': 'urn:p:h' }, 'sh:name': 'h', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:decimal' },
          'sh:in': { '@list': ['POINT-THREE', 1] } },
        { 'sh:path': { '@id': 'urn:p:n' }, 'sh:name': 'n', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:decimal' }, 'sh:minInclusive': 'POINT-THREE' },
        { 'sh:path': { '@id': 'urn:p:o' }, 'sh:name': 'o', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:decimal' },
          'sh:minInclusive': '0.50000000000000000000' },
      ] },
    ] },
    // Numbers each client names as the document writes them, not as reading JSON rounded them: one
    // past 2^53, one with more digits than a double keeps, one smaller and one larger than any
    // double, as bounds, entries and a const. RULE_CASES read it.
    '/written-numbers': { '@context': CTX, '@id': `${base}/written-numbers`, 'iep:affordance': [
      schemaOp('w', 'urn:written:schema', 'POST', 'Written numbers', { tiny: { type: 'number', minimum: 'TINY' },
        big: { type: 'number', maximum: 'PAST-SAFE' }, pick: { type: 'number', enum: ['PAST-SAFE', 1] }, whole: { const: { a: ['PAST-SAFE'] } },
        huge: { enum: ['HUGE', 'x'] }, fixed: { const: 'HUGE' }, items: { type: 'array', items: { type: 'number', minimum: 'POINT-THREE' } } })] },
    // One node named both as a shape's property and as a class's supported property, the shape's
    // control first and then the class's, and the other way round: each reads it as its own kind,
    // a property shape (path, name, count) or a supported property (hydra:property, required,
    // writable), in either order. RULE_CASES read them.
    ...Object.fromEntries((['/shared-node', '/shared-node-swapped'] as const).map((path, k) => {
      const ops = [op('a', 'urn:shared-node:shape', 'POST', 'Shape write', { ...target('/num-target'), 'hydra:expects': { '@id': '#S' } }),
        op('b', 'urn:shared-node:class', 'POST', 'Class write', { ...target('/num-target'), 'hydra:expects': { '@id': '#C' } })];
      return [path, { '@context': CTX, '@id': `${base}${path}`, 'iep:affordance': k ? ops.reverse() : ops, '@graph': [
        { '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': { '@id': '#p' } },
        { '@id': '#C', '@type': 'hydra:Class', 'hydra:supportedProperty': { '@id': '#p' } },
        { '@id': '#p', 'sh:path': { '@id': 'urn:p:shpath' }, 'sh:name': 'shname', 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:integer' },
          'hydra:property': { '@id': 'urn:p:hyprop' }, 'hydra:required': true, 'hydra:writable': false, 'sh:defaultValue': 5 }] }];
    })),
    // Numbers past 2^53 that a decimal or a double field takes: sent as JavaScript writes the double,
    // in an address, a path and a body alike. dryRuns and BODY_TEXTS read them.
    '/big-numbers': { '@context': CTX, '@id': `${base}/big-numbers`, 'iep:affordance': [
      op('q', 'urn:big:query', 'GET', 'Big query', { 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/num-target{?amount}`, 'hydra:mapping': [{ 'hydra:variable': 'amount', 'hydra:property': { '@id': 'urn:p:amount' } }] },
      'hydra:expects': { '@id': '#AM' } }),
      op('p', 'urn:big:path', 'GET', 'Big path', { 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/num-target{/m}`, 'hydra:mapping': [{ 'hydra:variable': 'm', 'hydra:property': { '@id': 'urn:p:m' } }] },
      'hydra:expects': { '@id': '#DB' } }),
      schemaOp('s', 'urn:big:schema', 'POST', 'Big schema number', { amount: { type: 'number' } }),
      op('d', 'urn:big:decimal', 'POST', 'Big decimal', { ...target('/num-target'), 'hydra:expects': { '@id': '#AM' } }),
      op('b', 'urn:big:double-default', 'POST', 'Big double default', { ...target('/num-target'), 'hydra:expects': { '@id': '#DB' } }),
      op('l', 'urn:big:double-list', 'POST', 'Big double list', { ...target('/num-target'), 'hydra:expects': { '@id': '#DL' } }),
    ], '@graph': [
      { '@id': '#AM', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:amount' }, 'sh:name': 'amount', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:decimal' } } },
      { '@id': '#DB', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1,
        'sh:datatype': { '@id': 'xsd:double' }, 'sh:defaultValue': 'BIG-DOUBLE' } },
      { '@id': '#DL', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm',
        'sh:datatype': { '@id': 'xsd:float' }, 'sh:defaultValue': ['BIG-DOUBLE'] } },
    ] },
    // A body schema of JSON Schema keywords alone, under a property-scoped context that maps one of
    // them to an IRI, which JSON-LD reads as a property: refused whole, as HIDDEN_NODES are.
    '/scoped-schema': { '@context': CTX, '@id': `${base}/scoped-schema`, 'iep:affordance': [
      op('sc', 'urn:scoped-schema', 'POST', 'Schema under a scoped context', {
        '@context': { scopedExpects: { '@id': 'hydra:expects', '@context': { additionalProperties: 'urn:other#additionalProperties' } } },
        'hydra:target': { '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/num-target{?q}`,
          'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:property': { '@id': 'urn:p:q' } }] },
        scopedExpects: { type: 'object', additionalProperties: false } })] },
    // A body schema beside its own @id under a write whose type's scoped context, which does not
    // propagate, sets "default" to null: JSON-LD reads the schema, a node under the write, in the
    // context before it, where "default" is a hint, so it says the read #d is destructive.
    '/hidden-type-revert': { '@context': { ...CTX, default: 'iep:destructiveHint', T: { '@id': 'iep:T', '@context': { default: null } } },
      '@id': `${base}/hidden-type-revert`, 'iep:affordance': [
        op('w', 'urn:hidden:write', 'POST', 'Hiding write', { '@type': ['iep:Affordance', 'T'], ...target('/num-target'),
          'hydra:expects': { '@id': '#d', type: 'object', properties: { m: { type: 'string' } }, default: true } }),
        op('d', 'urn:hidden:read', 'GET', 'Hidden read', target('/purge'))] },
    // A hint on a node written inside an object read as JSON, not JSON-LD: one that is no JSON Schema,
    // outside hydra:expects, is read as JSON-LD; HIDDEN_NODES are refused whole.
    '/hidden-meta': { '@context': { hydra: HYDRA, iep: IEP, ex: 'https://ex.example/' }, '@id': `${base}/hidden-meta`,
      'ex:meta': { properties: {}, 'iep:y': { '@id': '#d', 'iep:destructiveHint': true } },
      'iep:affordance': [{ '@id': '#d', 'iep:action': { '@id': 'urn:hidden:meta' }, 'hydra:method': 'GET', 'hydra:title': 'Hidden meta',
        'hydra:target': { '@id': `${base}/purge` } }] },
    ...Object.fromEntries(HIDDEN_NODES.map(([path, hidden, , context]) => [path, { '@context': context ?? CTX, '@id': `${base}${path}`, 'iep:affordance': [
      op('w', 'urn:hidden:write', 'POST', 'Hiding write', { ...target('/num-target'),
        'hydra:expects': { type: 'object', properties: { m: { type: 'string' } }, ...hidden } }),
      op('d', 'urn:hidden:read', 'GET', 'Hidden read', target('/purge'))] }])),
    // One field for each XSD 1.1 date and time datatype, named for it. TEMPORAL_CASES read it.
    '/temporal': { '@context': CTX, '@id': `${base}/temporal`, 'iep:affordance': [
      op('t', 'urn:temporal', 'POST', 'Dates and times', { ...target('/num-target'), 'hydra:expects': { '@id': '#T' } })],
    '@graph': [{ '@id': '#T', '@type': 'sh:NodeShape', 'sh:property': TEMPORAL_TYPES.map(type =>
      ({ 'sh:path': { '@id': `urn:p:${type}` }, 'sh:name': type, 'sh:maxCount': 1, 'sh:datatype': { '@id': `xsd:${type}` } })) }] },
    // Lists given empty and zeros: an empty sh:in, sh:or, sh:xone or sh:languageIn allows no value,
    // an empty sh:and asks nothing, an empty enum allows no value at any depth, and a required input
    // that allows none keeps its control from being invoked; allOf, anyOf, oneOf and prefixItems
    // hold one schema or more; and a zero bounds, as any number does. EMPTY_CASES read them.
    '/empty-lists': { '@context': CTX, '@id': `${base}/empty-lists`, 'iep:affordance': [
      ...EMPTY_SHAPES.map(([id, rel, title]) => op(id, rel, 'POST', title, { ...target('/num-target'), 'hydra:expects': { '@id': `#${id}` } })),
      op('im', 'urn:empty:in-mapped', 'POST', 'Empty in mapped required', { 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/num-target{?status}`,
        'hydra:mapping': [{ 'hydra:variable': 'status', 'hydra:property': { '@id': 'urn:p:status' }, 'hydra:required': true }] },
      'hydra:expects': { '@id': '#IL' } }),
      op('iv', 'urn:empty:enum-variable', 'POST', 'Empty enum variable', { 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/num-target{?q}`,
        'hydra:mapping': [{ 'hydra:variable': 'q', 'hydra:property': { '@id': 'urn:p:q' }, 'hydra:required': true }] },
      'hydra:expects': { type: 'object', additionalProperties: { enum: [] } } }),
      schemaOp('je', 'urn:empty:enum', 'POST', 'Empty enum', { m: { type: 'string', enum: [] } }),
      schemaOp('jd', 'urn:empty:enum-default', 'POST', 'Empty enum default', { m: { type: 'string', enum: [], default: 'x' } }),
      op('jr', 'urn:empty:enum-required', 'POST', 'Empty enum required', { ...target('/num-target'),
        'hydra:expects': { type: 'object', properties: { m: { type: 'string', enum: [] } }, required: ['m'] } }),
      schemaOp('ji', 'urn:empty:enum-items', 'POST', 'Empty enum items', { m: { type: 'array', items: { enum: [] } } }),
      schemaOp('jc', 'urn:empty:const-null', 'POST', 'Const null', { m: { const: null } }),
      op('jq', 'urn:empty:required-none', 'POST', 'None required', { ...target('/num-target'),
        'hydra:expects': { type: 'object', properties: { m: { type: 'string' } }, required: [] } }),
      schemaOp('ja', 'urn:empty:any-of', 'POST', 'Empty anyOf', { m: { type: 'string', anyOf: [] } }),
      schemaOp('jo', 'urn:empty:one-of', 'POST', 'Object oneOf', { m: { type: 'string', oneOf: {} } }),
      schemaOp('jl', 'urn:empty:all-of', 'POST', 'Empty allOf items', { m: { type: 'array', items: { allOf: [] } } }),
      schemaOp('jp', 'urn:empty:prefix-items', 'POST', 'Empty prefixItems', { m: { type: 'array', prefixItems: [] } }),
      schemaOp('jz', 'urn:empty:zeros', 'POST', 'Schema zeros', { n: { type: 'integer', maximum: 0, default: 0 },
        s: { type: 'string', maxLength: 0 }, a: { type: 'array', maxItems: 0 } }),
    ], '@graph': EMPTY_SHAPES.map(([id, , , shape]) => ({ '@id': `#${id}`, ...shape })) },
    // A document nested deeper than either client reads.
    '/deep-document': { '@context': CTX, '@id': `${base}/deep-document`, 'rdfs:comment': nested(300) },
  };
  // JSON.stringify writes 1.0 as 1, so the 1.0 is put in the text by hand.
  const out = Object.fromEntries(Object.entries(docs).map(([path, doc]) => [path, JSON.stringify(doc).replace('"ONE-POINT-ZERO"', '1.0')
    .replace('"REQUIRED-ONE"', '1.0')]));
  // JSON.stringify writes no number past a double, so the 1e400 is put in the text by hand. JSON's
  // grammar allows it, and both clients read it as an infinity.
  out['/values'] = out['/values']!.replace('"LARGE-SCORE"', '1e400').replace('"BIG-TEXT-DEFAULT"', `1${'0'.repeat(30)}`)
    .replace('"LARGE-BOUND"', `1${'0'.repeat(399)}`).replace('"TWO-POINT-ZERO"', '2.0').replace('"PAST-SAFE"', '9007199254740993');
  // Numbers inside the choices' entries as written: 1.0, 2.0 and 2^53 + 1, which JSON.parse reads as 2^53.
  out['/choices'] = out['/choices']!.replace('"CHOICE-ONE"', '1.0').replace('"CHOICE-TWO"', '2.0').replace('"CHOICE-PAST-SAFE"', '9007199254740993')
    .replace('"INTEGER-PAST-SAFE"', '9007199254740993').replace('"CONST-PAST-SAFE"', '9007199254740993');
  // An entry no double holds, 1e400, which JSON.parse reads as an infinity.
  out['/sweep'] = out['/sweep']!.split('"INFINITE-ENTRY"').join('1e400');
  // An entry 2^53 + 1, which JSON.parse reads as 2^53.
  out['/rules'] = out['/rules']!.split('"NUMBER-PAST-SAFE"').join('9007199254740993');
  // 2^53 + 1, which JSON.parse reads as 2^53, and a fraction JSON.parse reads as 0.3.
  out['/rounding'] = out['/rounding']!.split('"PAST-SAFE"').join('9007199254740993').split('"PAST-DOUBLE"').join('0.30000000000000000001');
  out['/inexact'] = out['/inexact']!.split('"PAST-SAFE"').join('9007199254740993').split('"POINT-THREE"').join('0.30000000000000000001');
  // A number below every double (read as 0), one past 2^53, one past every double and one with digits a double drops.
  out['/written-numbers'] = out['/written-numbers']!.split('"TINY"').join('1e-400').split('"PAST-SAFE"').join('9007199254740993')
    .split('"HUGE"').join('1e400').split('"POINT-THREE"').join('0.30000000000000000001');
  // A JSON number past 2^53 that a double field takes as the double nearest it.
  out['/big-numbers'] = out['/big-numbers']!.split('"BIG-DOUBLE"').join('123456789012345678901');
  // JSON.stringify writes each key once, so a repeated key is put in the text by hand: JSON leaves
  // its meaning open, and a reader that takes the last "hydra:method" takes GET.
  out['/repeated-key'] = JSON.stringify({ '@context': CTX, '@id': `${base}/repeated-key`, 'iep:affordance': [
    op('d', 'urn:repeat:delete', 'DELETE', 'Repeated method', target('/thing'))] }).replace('"hydra:method":"DELETE"', '"hydra:method":"DELETE","hydra:method":"GET"');
  // NaN is not JSON: the page's JSON.parse refuses it, and hmc.py, whose json.loads would read it, does too.
  out['/outcomes'] = JSON.stringify(outcomesDescriptor(base));
  // A GET for each response shownCases serves, titled "Shown <name>".
  out['/shown'] = JSON.stringify({ '@context': CTX, '@id': `${base}/shown`, 'iep:affordance': shownCases().map(c =>
    op(c.name, `urn:shown:${c.name}`, 'GET', `Shown ${c.name}`, target(`/shown/${c.name}`))) });
  out['/not-json'] = JSON.stringify({ '@context': CTX, '@id': `${base}/not-json`, 'iep:affordance': [
    op('n', 'urn:nan:read', 'GET', 'NaN read', { ...target('/api'), 'hydra:title': 'NAN-HERE' })] }).replace('"NAN-HERE"', 'NaN');
  return out;
}

/** HyperMarkdown documents served to both clients as text/markdown. */
export function sharedMarkdown(base: string): Record<string, string> {
  return {
    // A block that gives its method twice is refused, whichever comes last; a title given twice
    // is shown as the last; a GET marked destructive is unsafe.
    '/hm-repeat': ['# Repeated keys', '',
      ':::control hm-two-methods', 'title: Repeated method', 'method: DELETE', 'method: GET', `target: ${base}/thing`, ':::', '',
      ':::control hm-two-titles', 'title: First title', 'title: Second title', 'method: GET', `target: ${base}/api`, ':::', '',
      ':::control hm-destructive', 'title: Destructive read', 'method: GET', 'destructiveHint: true', `target: ${base}/purge`, ':::', ''].join('\n'),
    // Line endings as CommonMark has them: CR LF, a lone CR or LF, and nothing else. A form feed is
    // part of its line, and U+FEFF is part of a value, not a space around it.
    '/hm-lines': ['# Line endings', '',
      ':::control hm-cr', 'title: CR hint\rdestructiveHint: true', 'method: GET', `target: ${base}/purge`, ':::', '',
      ':::control hm-cr-method', 'title: CR method\rmethod: DELETE', 'method: GET', `target: ${base}/thing`, ':::', '',
      ':::control hm-ff', 'title: Form feed read', 'whenToUse: a\fdestructiveHint: true', 'method: GET', `target: ${base}/api`, ':::', '',
      ':::control hm-bom', 'title: BOM method', 'method: GET\ufeff', `target: ${base}/purge`, ':::', ''].join('\n') +
      [':::control hm-cr-only', 'title: CR-only read', 'method: GET', `target: ${base}/api`, ':::', ''].join('\r'),
    // JSON values in a block are read as a document's are: NaN and a repeated key are not JSON, a
    // target or a rel is text, and two fields of one name are refused.
    '/hm-json': ['# JSON values', '',
      ':::control hm-nan', 'title: NaN fields', 'method: POST', `target: ${base}/api`, 'fields: [{"name": "a", "defaultValue": NaN}]', ':::', '',
      ':::control hm-repeat-key', 'title: Repeated key fields', 'method: POST', `target: ${base}/api`, 'fields: [{"name": "a", "name": "b"}]', ':::', '',
      ':::control hm-target-list', 'title: Target list', 'method: GET', `target: ["${base}/a", "${base}/b"]`, ':::', '',
      ':::control hm-rel-list', 'title: Rel list', 'rel: ["urn:hm:x"]', 'method: GET', `target: ${base}/api`, ':::', '',
      ':::control hm-two-fields', 'title: Two fields of one name', 'method: POST', `target: ${base}/api`,
      'fields: [{"name": "a"}, {"name": "a", "minCount": 1, "defaultValue": "x"}]', ':::', ''].join('\n'),
    // Defaults read as a document's JSON is: a 31-digit integer in a text field of maxLength 10,
    // and a string holding an unpaired surrogate, which JSON writes as an escape.
    '/values-md': ['# Default values', '',
      ':::control hm-big-default', 'title: Big text default', 'method: POST', `target: ${base}/num-target`,
      `fields: [{"name": "a", "maxLength": 10, "defaultValue": 1${'0'.repeat(30)}}]`, ':::', '',
      ':::control hm-surrogate-default', 'title: Surrogate text default', 'method: POST', `target: ${base}/num-target`,
      'fields: [{"name": "a", "defaultValue": "\\ud800"}]', ':::', '',
      ':::control hm-unread-key', 'title: Unread field key', 'method: POST', `target: ${base}/num-target`,
      'fields: [{"name": "x", "datatype": "xsd:integer", "minInclusive": 5}]', ':::', ''].join('\n'),
    // A block's fields counted as a property shape's are, a block that expects a shape it cannot
    // describe, with and without fields, fields nested deeper than either client reads, and a
    // length past 2^53, which no count is.
    '/rules-md': ['# Rules', '',
      ':::control hm-inline-bad-length', 'title: Block length past 2^53', 'method: POST', `target: ${base}/num-target`,
      'fields: [{"name": "x", "maxLength": 9007199254740993}]', ':::', '',
      ':::control hm-inline-min', 'title: Block two or more', 'method: POST', `target: ${base}/num-target`,
      'fields: [{"name": "x", "minCount": 2}]', ':::', '',
      ':::control hm-expects', 'title: Block expects', 'method: POST', `target: ${base}/num-target`, 'expects: urn:shape:Outside',
      'fields: [{"name": "x"}]', ':::', '',
      ':::control hm-expects-none', 'title: Block expects, no fields', 'method: POST', `target: ${base}/num-target`,
      'expects: urn:shape:Outside', ':::', '',
      ':::control hm-deep-fields', 'title: Block nested too deep', 'method: POST', `target: ${base}/num-target`,
      `fields: ${JSON.stringify(nested(300))}`, ':::', ''].join('\n'),
  };
}

/**
 * Descriptor addresses written with a character a URL parser drops, encodes or reads otherwise: a
 * tab, a line feed or a carriage return at the end, and a space at the start. Each client refuses
 * the address as it was given, naming ADDRESS_TEXT_PROBLEM, and fetches nothing: the page's
 * address field, and Python's urlsplit, would each have dropped the character and fetched
 * another address.
 */
export const addressTexts = (base: string): readonly string[] =>
  [`${base}/link-\tvalues`, `${base}/link-values\n`, `${base}/link-values\r`, ` ${base}/link-values`];
export const ADDRESS_TEXT_PROBLEM = 'the address holds a backslash, a space or a control character, which URL parsers read in different ways';

/** What a document whose JSON Schema holds `what`, which JSON-LD would read and neither client reads there, is refused with. */
const inSchema = (what: string) => `This document writes ${what} in a JSON Schema, which this client does not read as JSON-LD, so it is not read.`;
/** What a JSON Schema written in place is refused with when its document's @context gives `key`, one of its keywords, a meaning. */
const keywordTerm = (key: string) => inSchema(`${JSON.stringify(key)}, a key its @context gives a meaning,`);
/** What a document that names a remote @context is refused with when it writes a JSON Schema in place. */
export const REMOTE_SCHEMA = 'This document names a remote @context, which this client does not fetch, so what the keys of a JSON Schema ' +
  'written in it mean is not known, and it is not read.';
/**
 * Documents whose JSON Schema, written in place under hydra:expects beside a GET, holds what
 * JSON-LD reads as a node or a keyword: a node under a key that is no JSON Schema keyword, with an
 * @id or with terms; a JSON-LD keyword other than its own @id and @type; beside its own @id, a key
 * the context expands, which says something of that node; or a JSON Schema keyword (default,
 * examples, properties, ...) that @vocab or a term of the same name makes a property, so JSON-LD
 * reads what is under it, a node and its hints, or what it says of the schema's own @id. A
 * remote @context may define any such term, and neither client fetches one. Neither client reads
 * a schema as JSON-LD, so a hint written there would be passed over, and the GET it names (#d)
 * listed as a safe read: each is refused whole, as [path, what the schema holds beside its
 * keywords, the problem, the document's @context when it is not CTX].
 */
export const HIDDEN_NODES: ReadonlyArray<readonly [path: string, hidden: Record<string, unknown>, problem: string, context?: unknown]> = [
  ['/hidden-key', { 'iep:x': { '@id': '#d', 'iep:destructiveHint': true } }, inSchema('a node under "iep:x"')],
  ['/hidden-blank', { 'iep:x': [{ 'iep:destructiveHint': true }] }, inSchema('a node under "iep:x"')],
  ['/hidden-own-id', { '@id': '#d', 'iep:destructiveHint': true }, inSchema('"iep:destructiveHint" beside its own @id')],
  ...([['@included', [{ '@id': '#d', 'iep:destructiveHint': true }]], ['@graph', [{ '@id': '#d', 'iep:destructiveHint': true }]],
    ['@context', { k: 'iep:destructiveHint' }], ['@language', 'en'], ['@index', 'i'], ['@direction', 'ltr'], ['@foo', 1]] as const)
    .map(([key, value]) => [`/schema-keyword-${key.slice(1)}`, { [key]: value }, inSchema(key)] as const),
  // Under @vocab every keyword is a property: a node under "default", or under "examples" in a
  // property's schema, which JSON-LD reaches through "properties".
  ['/hidden-vocab-default', { default: { '@id': '#d', destructiveHint: true } }, keywordTerm('default'), { ...CTX, '@vocab': IEP }],
  ['/hidden-vocab-examples', { properties: { m: { type: 'string', examples: [{ '@id': '#d', destructiveHint: true }] } } },
    keywordTerm('properties'), { ...CTX, '@vocab': IEP }],
  // A term named for a keyword: a node under it, beside the schema's own @id a hint it names, and
  // one in a property's schema, which JSON-LD reaches where terms name the keys above it too.
  ['/hidden-term-default', { default: { '@id': '#d', 'iep:destructiveHint': true } }, keywordTerm('default'), { ...CTX, default: 'iep:default' }],
  ['/hidden-term-own-id', { '@id': '#d', default: true }, keywordTerm('default'), { ...CTX, default: 'iep:destructiveHint' }],
  ['/hidden-term-nested', { properties: { m: { type: 'string', title: { '@id': '#d', 'iep:destructiveHint': true } } } },
    keywordTerm('title'), { ...CTX, title: 'iep:title' }],
  // A key that is no keyword but that the context expands, read as a property of the schema's node.
  ['/hidden-literal', { 'iep:readOnlyHint': false }, keywordTerm('iep:readOnlyHint')],
  // A remote context, which may name any keyword as a term.
  ['/hidden-remote', { description: { '@id': '#d', 'iep:destructiveHint': true } }, REMOTE_SCHEMA, [HYDRA_CONTEXT, CTX]],
  // A type the schema itself names whose scoped context, which JSON-LD applies to the schema's own
  // keys, makes a keyword a property: beside its own @id a hint, or a node under it.
  ['/hidden-type-default', { '@id': '#d', '@type': 'T', default: true }, keywordTerm('default'),
    { ...CTX, T: { '@id': 'iep:T', '@context': { default: 'iep:destructiveHint' } } }],
  ['/hidden-type-node', { '@type': 'T', default: { '@id': '#d', 'iep:destructiveHint': true } }, keywordTerm('default'),
    { ...CTX, T: { '@id': 'iep:T', '@context': { default: 'iep:x' } } }],
];

/** Documents each client refuses whole, as [path, the problem it names]; nothing is listed or sent. */
export const DOCUMENT_REFUSALS: ReadonlyArray<readonly [path: string, problem: string]> = [
  ...HIDDEN_NODES.map(([path, , problem]) => [path, problem] as const),
  ['/scoped-schema', keywordTerm('additionalProperties')],
  ['/hidden-type-revert', keywordTerm('default')],
  ['/nested-graph', 'This document holds a @graph inside a node, which this client does not read, so it is not read.'],
  ['/nested-included', 'This document holds @included inside a node that is not at its top or in a @graph, which this client does not read, so it is not read.'],
  ['/reverse', 'This document uses @reverse, which this client does not read, so it is not read.'],
  ['/set-extra', 'This document has a @set object with a key other than @set and @index, which JSON-LD does not allow, so it is not read.'],
  ['/colliding', 'This document gives one node @id twice, which JSON-LD does not allow, so it is not read.'],
  ['/nest-id', 'This document gives one node @id twice, which JSON-LD does not allow, so it is not read.'],
  ['/repeated-key', 'This document repeats the key "hydra:method" in one object, so which value it means is not known, and it is not read.'],
  ['/deep-document', 'This document nests JSON deeper than 256 levels, which this client does not read, so it is not read.'],
  ['/graph-container', 'This document holds a @graph inside a node, which this client does not read, so it is not read.'],
  ['/import-context', "This document's @context uses @import, which this client does not fetch, so it is not read."],
  ['/set-context', 'This document has a @set object inside a @list or with a @context of its own, which this client does not read, so it is not read.'],
];

/** The titles of every control each client lists for a document, sorted: no more and no fewer. */
export const LISTED: ReadonlyArray<readonly [path: string, titles: readonly string[]]> = [
  ['/nested-ops', ['Inner delete', 'Operation and template', 'Outer read', 'Template with a method']],
  ['/truthiness', ['Empty datatype', 'Empty property list', 'Nested required', 'Null properties', 'Object enum', 'Object method']],
  ['/blank-ids', ['Blank no action', 'Blank no method', 'Blank purge']],
];

/**
 * Controls each client lists as unsafe with no problem, as [path, the name that invokes it, or null
 * for one the document gives no name, title, the method shown]: invoked unconfirmed, each is a dry
 * run that sends nothing.
 */
export const UNSAFE_CONTROLS: ReadonlyArray<readonly [path: string, rel: string | null, title: string, method: string]> = [
  ['/described-twice', 'urn:twice:hint', 'Hint elsewhere', 'GET'],
  ['/blank-ids', 'urn:blank:purge', 'Blank purge', 'POST'],
  ['/blank-ids', null, 'Blank no action', 'POST'],
  ['/json-terms', 'urn:json:hint', 'JSON annotations', 'GET'],
  ['/hm-lines', 'hm-cr', 'CR hint', 'GET'],
  ['/hm-lines', 'hm-bom', 'BOM method', 'GET\ufeff'],
  // A hint on the node a control's annotations name by reference, wherever the document describes it.
  ['/ref-hints', 'urn:ref:graph', 'Graph flags', 'GET'],
  ['/ref-hints', 'urn:ref:placed', 'Placed flags', 'GET'],
  ['/ref-hints', 'urn:ref:alias', 'Aliased flags', 'GET'],
  ['/ref-hints', 'urn:ref:listed', 'Listed flags', 'GET'],
  // The same, named by a string: under a term typed @id or @vocab, in a @list, or with no type.
  ['/ref-hint-strings', 'urn:refstr:typed', 'Typed string flags', 'GET'],
  ['/ref-hint-strings', 'urn:refstr:vocab', 'Vocab string flags', 'GET'],
  ['/ref-hint-strings', 'urn:refstr:listed', 'Listed string flags', 'GET'],
  ['/ref-hint-strings', 'urn:refstr:plain', 'Plain string flags', 'GET'],
  // An object with "properties" outside hydra:expects is no JSON Schema: the node in it is read.
  ['/hidden-meta', 'urn:hidden:meta', 'Hidden meta', 'GET'],
];

/**
 * Dry runs each client plans alike, as [path, action, fields, the address and body planned, or the
 * validation error that stops it].
 */
export function dryRuns(base: string): ReadonlyArray<readonly [path: string, rel: string, fields: Record<string, string>,
  outcome: { readonly url: string; readonly body: unknown } | { readonly error: string }]> {
  return [
    ['/described-twice', 'urn:twice:shape', { b: '1' }, { error: "missing required field 'a'" }],
    ['/described-twice', 'urn:twice:shape', { a: 'x', b: '1' }, { url: `${base}/api`, body: { a: 'x', b: '1' } }],
    ['/truthiness', 'urn:truth:props', {}, { error: "missing required field 'name'" }],
    ['/truthiness', 'urn:truth:datatype', {}, { url: `${base}/api`, body: {} }],
    ['/truthiness', 'urn:truth:null-properties', {}, { error: "missing required field 'q'" }],
    ['/line-names', 'urn:lines:write', { 'abc\n': '1', 'rest-param-q-limit\n': '2', 'rest-param-q-li\rmit': '3', offset: '4' },
      { url: `${base}/api`, body: { 'abc\n': '1', 'rest-param-q-limit\n': '2', 'rest-param-q-li\rmit': '3', offset: '4' } }],
    // NaN is not JSON, so this list is one line of text, not three values.
    ['/multi', 'urn:act-publish', { graph_iri: `${base}/g`, tags: '["a","b",NaN]' }, { error: 'tags: needs at least 2 values, got 1' }],
    // JSON in the address is written as JSON.stringify writes it: 1.0 as 1, 1e-7 as it is, -0 as 0,
    // and an object's array-index keys first, in numeric order, as JavaScript keeps them.
    ['/values', 'urn:values:query', { filter: '{"b":1.0,"a":1e-7,"c":-0.0,"2":[1E2],"1":true}' },
      { url: `${base}/num-target?${new URLSearchParams({ filter: '{"1":true,"2":[100],"b":1,"a":1e-7,"c":0}' })}`, body: null }],
    // A JSON number its double would change is refused, in an object and in a list alike; one its
    // double holds is written as JavaScript writes the double.
    ['/values', 'urn:values:query', { filter: '{"c":12345678901234567890}' },
      { error: 'filter: holds 12345678901234567890, which a JSON number would change, so it is not sent' }],
    ['/values', 'urn:values:query', { filter: '{"c":12345678901234567000}' },
      { url: `${base}/num-target?${new URLSearchParams({ filter: '{"c":12345678901234567000}' })}`, body: null }],
    ['/values', 'urn:values:list', { tags: '[1000000000000000000000000000000, 9007199254740993]' },
      { error: 'tags: holds 9007199254740993, which a JSON number would change, so it is not sent' }],
    ['/values', 'urn:values:list', { tags: '[1000000000000000000000000000000, 9007199254740992]' },
      { url: `${base}/num-target?tags=1e%2B30&tags=9007199254740992`, body: null }],
    ['/values', 'urn:values:list', { short: `[1${'0'.repeat(30)}]` }, { url: `${base}/num-target?short=1e%2B30`, body: null }],
    ['/values', 'urn:values:list', { counts: '[1.0, 2]' }, { url: `${base}/num-target?counts=1&counts=2`, body: null }],
    ['/required-text', 'urn:required:spaced', {}, { error: "missing required field 'q'" }],
    ['/required-text', 'urn:required:whole', {}, { error: "missing required field 'q'" }],
    ['/required-text', 'urn:required:nbsp', {}, { url: `${base}/api`, body: null }],
    // A mapping read as the node at its @id, both its descriptions merged: one names its variable,
    // the other makes it required.
    ['/ref-inputs', 'urn:refin:merged', {}, { error: "missing required field 'q'" }],
    ['/ref-inputs', 'urn:refin:merged', { q: '1' }, { url: `${base}/api?q=1`, body: null }],
    // A decimal or a double past 2^53 is written as JavaScript writes its double, in a query and a path.
    ['/big-numbers', 'urn:big:query', { amount: '123456789012345680000' }, { url: `${base}/num-target?amount=123456789012345680000`, body: null }],
    ['/big-numbers', 'urn:big:path', {}, { url: `${base}/num-target/123456789012345680000`, body: null }],
    ['/big-numbers', 'urn:big:path', { m: '123456789012345678901' }, { url: `${base}/num-target/123456789012345680000`, body: null }],
  ];
}

/** What /link-values' write sends when it is given nothing: each field's default. */
const LINKED = { scope: 'all', picks: ['x'], n: 5, tags: ['a'] };
/**
 * Values a link (each a field.<name> parameter, a list one per value) and hmc.py's --field (repeated
 * for a list) give /link-values' write, as [path, action, fields, the body a dry run plans, or the
 * validation error that stops it]. Each is checked as it was given, never as a form control would
 * change it: a choice that is none of the options, or a number that is no number, is refused
 * rather than replaced by the default; a multiple choice is sent in the order and number given; a
 * line break or carriage return in a line of text is kept; and a value of only spaces or blank
 * lines is refused rather than read as none.
 */
export const LINK_CASES: ReadonlyArray<readonly [path: string, rel: string, fields: Record<string, string | string[]>,
  outcome: { readonly body: unknown } | { readonly error: string }]> = [
  ['/link-values', 'urn:lv:write', {}, { body: LINKED }],
  ['/link-values', 'urn:lv:write', { scope: 'mine' }, { body: { ...LINKED, scope: 'mine' } }],
  ['/link-values', 'urn:lv:write', { scope: 'invalid' }, { error: 'scope: must be one of mine, all' }],
  ['/link-values', 'urn:lv:write', { scope: ['mine', 'invalid'] }, { error: 'scope: must be one of mine, all' }],
  ['/link-values', 'urn:lv:write', { picks: 'w' }, { error: 'picks: must be one of x, y, z' }],
  ['/link-values', 'urn:lv:write', { picks: ['x', 'w'] }, { error: 'picks: must be one of x, y, z' }],
  ['/link-values', 'urn:lv:write', { picks: ['z', 'x'] }, { body: { ...LINKED, picks: ['z', 'x'] } }],
  ['/link-values', 'urn:lv:write', { picks: ['y', 'y'] }, { body: { ...LINKED, picks: ['y', 'y'] } }],
  ['/link-values', 'urn:lv:write', { picks: 'y\nz' }, { body: { ...LINKED, picks: ['y', 'z'] } }],
  ['/link-values', 'urn:lv:write', { n: 'abc' }, { error: 'n: not an integer' }],
  ['/link-values', 'urn:lv:write', { n: ' \t' }, { error: 'n: not an integer' }],
  ['/link-values', 'urn:lv:write', { n: ' 7 ' }, { body: { ...LINKED, n: 7 } }],
  ['/link-values', 'urn:lv:write', { note: 'a\nb' }, { body: { ...LINKED, note: 'a\nb' } }],
  ['/link-values', 'urn:lv:write', { note: 'a\r\nb' }, { body: { ...LINKED, note: 'a\r\nb' } }],
  ['/link-values', 'urn:lv:write', { tags: ' ' }, { error: 'tags: was given no values' }],
  ['/link-values', 'urn:lv:write', { tags: ['b', 'c'] }, { body: { ...LINKED, tags: ['b', 'c'] } }],
];

/**
 * The GETs to /api that /containers holds, as [the IRI that names it, title]: every one is a
 * control, with its method and target. Each is named by its action, or with none by its node's own
 * IRI; the two that have neither (null) are named by no IRI the document gives them.
 */
export const CONTAINER_READS: ReadonlyArray<readonly [rel: string | null, title: string]> = [
  ['urn:c:set', 'Set read'], ['urn:c:list', 'List read'], ['urn:c:graph', 'Graph set read'], ['urn:c:keys', 'Keyed read'],
  ['urn:c:index-id', 'Index read'], ['urn:c:index-en', 'Index en read'], ['urn:c:type', 'Type read'], ['urn:c:typed', 'Own type read'],
  ['urn:c:graph-index', 'Graph index read'], [null, 'Graph id read'], [null, 'No id read'], ['urn:c:id', 'Id read'],
  ['urn:c:own', 'Own id read'], ['urn:c:method', 'Method index read'], [`${IEP}indexed`, 'Action index read'],
];

/**
 * Writes each client refuses, on a dry run and on a confirmed invoke alike, as [path, action,
 * title, fields, the error it names]: a JSON array with too few or too many values for its
 * sh:minCount and sh:maxCount or its minItems and maxItems, and a list of text values with too many
 * for its sh:maxCount.
 */
export function countCases(base: string): ReadonlyArray<readonly [path: string, action: string, title: string, fields: Record<string, string>, error: string]> {
  return [
    ['/counts', 'urn:count-nodes', 'Node counts', { members: '[]', owner: '{}' }, 'members: needs at least 2 values, got 0'],
    ['/counts', 'urn:count-nodes', 'Node counts', { members: '[{},{},{},{}]', owner: '{}' }, 'members: takes at most 3 values, got 4'],
    ['/counts', 'urn:count-nodes', 'Node counts', { members: '[{},{}]', notes: '[{},{},{}]', owner: '{}' }, 'notes: takes at most 2 values, got 3'],
    ['/counts', 'urn:count-items', 'Item counts', { tags: '["a"]' }, 'tags: needs at least 2 values, got 1'],
    ['/counts', 'urn:count-items', 'Item counts', { tags: '["a","b","c","d"]' }, 'tags: takes at most 3 values, got 4'],
    ['/counts', 'urn:count-items', 'Item counts', { tags: '["a","b"]', extra: '[1,2]' }, 'extra: takes at most 1 values, got 2'],
    ['/multi', 'urn:act-publish', 'Publish classified', { graph_iri: `${base}/g`, tags: '["a","b","c","d","e","f"]' }, 'tags: takes at most 5 values, got 6'],
  ];
}

/** U+1F600, one code point that JavaScript's .length counts as two UTF-16 code units. */
const SMILE = '\u{1F600}';
/** What each client reports for a value holding an unpaired surrogate, after the field's name. */
const UNPAIRED = 'holds an unpaired surrogate, which is not Unicode text';
/** What a default that holds a number reading JSON may have rounded is refused with. */
const roundedDefault = (name: string) => `${name}: its default holds a number that reading JSON may have rounded, so it is not sent`;
/** What JSON text that holds a number its double would change is refused with, naming the number as written. */
const changedNumber = (name: string, written: string) => `${name}: holds ${written}, which a JSON number would change, so it is not sent`;
/** "e" and U+0301, a combining acute accent: two code points, shown as one letter. */
const COMBINED = 'e\u0301';
/**
 * Values for /values each client reads alike, as [path, action, title, fields, the body a dry run
 * plans, or the validation error that stops a dry run and a confirmed write alike, sending nothing]:
 *   - NaN, Infinity and -Infinity are not JSON, in a field that takes a JSON object, an rdf:JSON
 *     field or a whole JSON body; Python's json.loads reads them and json.dumps writes them back;
 *   - a repeated key leaves which value an object means open, as it does in a document;
 *   - a number past what a double holds (1e400, -1e400, an integer of 400 or 5,000 digits, or a
 *     descriptor's default of 1e400) cannot be sent: JSON.parse reads it as Infinity, which
 *     JSON.stringify sends as null;
 *   - a length facet counts Unicode code points, as Python's len() does, and not JavaScript's
 *     UTF-16 code units: U+1F600 is one character, and "e" followed by a combining acute accent two;
 *   - an unpaired surrogate is not Unicode text: UTF-8 cannot carry it and I-JSON forbids it, so it
 *     is refused wherever it is, where Python could not encode it and URLSearchParams wrote U+FFFD;
 *   - a JSON integer is the number JSON.parse reads, the double nearest it past 2^53, so a text
 *     field's default, a list item, a bound and an integer field's default read alike;
 *   - a default is what the page's form holds: a text field's default of 5 is "5", and a list's
 *     defaults are one per line, or the options a multiple choice selects. A default the form
 *     cannot hold as it is (a line break in a value, a carriage return, a NUL, a line break at the
 *     start of a text area, choices out of the options' order, or a choice that is none of them)
 *     is not changed to one it can: it is the default itself that is checked and sent;
 *   - a number field given only spaces, and a list given only blank lines, are refused: a value
 *     given is never replaced by the default;
 *   - a boolean is trimmed of space, tab, CR and LF only, as a number is.
 * Each error is the whole message, as the page lists it and hmc.py prints it.
 */
export const VALUE_CASES: ReadonlyArray<readonly [path: string, action: string, title: string, fields: Record<string, string>,
  outcome: { readonly body: unknown } | { readonly error: string }]> = [
  ['/values', 'urn:values:object', 'Object value', { document: '{"score":NaN}' }, { error: 'document must be JSON' }],
  ['/values', 'urn:values:object', 'Object value', { document: '{"score":Infinity}' }, { error: 'document must be JSON' }],
  ['/values', 'urn:values:object', 'Object value', { document: '{"score":-Infinity}' }, { error: 'document must be JSON' }],
  ['/values', 'urn:values:object', 'Object value', { document: '{"score":1e400}' }, { error: 'document: holds a number too large to send' }],
  ['/values', 'urn:values:object', 'Object value', { document: `{"score":1${'0'.repeat(400)}}` }, { error: 'document: holds a number too large to send' }],
  ['/values', 'urn:values:object', 'Object value', { document: `{"score":${'9'.repeat(5000)}}` }, { error: 'document: holds a number too large to send' }],
  ['/values', 'urn:values:object', 'Object value', { document: '{"a":1,"a":2}' },
    { error: 'document repeats the key "a" in one object, so which value it means is not known' }],
  ['/values', 'urn:values:object', 'Object value', { document: '{"score":1.5,"tags":["a"]}' }, { body: { document: { score: 1.5, tags: ['a'] } } }],
  ['/values', 'urn:values:json', 'JSON value', { data: '[1,NaN]' }, { error: 'data must be JSON' }],
  ['/values', 'urn:values:json', 'JSON value', { data: '-1e400' }, { error: 'data: holds a number too large to send' }],
  ['/values', 'urn:values:json', 'JSON value', { data: '[1,2.5]' }, { body: { data: [1, 2.5] } }],
  // JSON nested deeper than 256 levels is refused by name before it is read, in a value and in a
  // list's JSON array alike; 256 levels are read.
  ['/values', 'urn:values:json', 'JSON value', { data: JSON.stringify(nested(257)) },
    { error: 'data: nests JSON deeper than 256 levels, which this client does not read, so it is not sent' }],
  ['/values', 'urn:values:json', 'JSON value', { data: JSON.stringify(nested(256)) }, { body: { data: nested(256) } }],
  ['/values', 'urn:values:list', 'List values', { tags: JSON.stringify(nested(300)) },
    { error: 'tags: nests JSON deeper than 256 levels, which this client does not read, so it is not sent' }],
  ['/values', 'urn:values:body', 'JSON body', { body: '{"score":NaN}' }, { error: 'body must be JSON' }],
  ['/values', 'urn:values:body', 'JSON body', { body: '{"score":Infinity}' }, { error: 'body must be JSON' }],
  ['/values', 'urn:values:body', 'JSON body', { body: '[1e400]' }, { error: 'body: holds a number too large to send' }],
  ['/values', 'urn:values:body', 'JSON body', { body: '{"score": 1.5}' }, { body: '{"score": 1.5}' }],
  ['/values', 'urn:values:default', 'Large default', {}, { error: 'report: holds a number too large to send' }],
  // An unpaired surrogate, in a string or a key, wherever a value goes: a body, an address, a list, a
  // whole JSON body, a default. A pair is one character.
  ['/values', 'urn:values:object', 'Object value', { document: '{"a":"\\ud800"}' }, { error: `document: ${UNPAIRED}` }],
  ['/values', 'urn:values:object', 'Object value', { document: '{"a":"x\\udc00"}' }, { error: `document: ${UNPAIRED}` }],
  ['/values', 'urn:values:object', 'Object value', { document: '{"a":"\\udc00\\ud800"}' }, { error: `document: ${UNPAIRED}` }],
  ['/values', 'urn:values:object', 'Object value', { document: '{"\\ud800":1}' }, { error: `document: ${UNPAIRED}` }],
  ['/values', 'urn:values:object', 'Object value', { document: '{"a":"\\ud83d\\ude00"}' }, { body: { document: { a: SMILE } } }],
  ['/values', 'urn:values:query', 'Object query', { filter: '{"a":"\\ud800"}' }, { error: `filter: ${UNPAIRED}` }],
  ['/values', 'urn:values:list', 'List values', { tags: '["a","\\ud800"]' }, { error: `tags: ${UNPAIRED}` }],
  ['/values', 'urn:values:json', 'JSON value', { data: '"\\ud800"' }, { error: `data: ${UNPAIRED}` }],
  ['/values', 'urn:values:body', 'JSON body', { body: '["\\udfff"]' }, { error: `body: ${UNPAIRED}` }],
  ['/values', 'urn:values:surrogate-default', 'Surrogate default', {}, { error: `a: ${UNPAIRED}` }],
  ['/values-md', 'hm-surrogate-default', 'Surrogate text default', {}, { error: `a: ${UNPAIRED}` }],
  // A JSON Schema string field's default that is not a string is refused, and so is a default
  // that holds an integer past 2^53, which reading JSON may have rounded, in a field written in
  // place too; an integer field's default of 2.0 is 2; a bound no double holds is an infinity,
  // which every number a field takes is below, and a list's number past a double is not a number.
  ['/values', 'urn:values:text-default', 'Text defaults', {}, { error: 'small: must be a JSON string' }],
  ['/values', 'urn:values:text-default', 'Text defaults', {}, { error: 'object: must be a JSON string' }],
  ['/values-md', 'hm-big-default', 'Big text default', {}, { error: roundedDefault('a') }],
  ['/values', 'urn:values:whole-default', 'Whole default', {}, { body: { n: 2 } }],
  ['/values', 'urn:values:unsafe-default', 'Past 2^53 default', {}, { error: roundedDefault('n') }],
  // The bound and the default 1e400 both read as one infinity, so the bound is named as both are written.
  ['/values', 'urn:values:bound', 'Large bound', { amount: '5' }, { error: `amount: below minInclusive 1${'0'.repeat(399)} or 1e400` }],
  ['/values', 'urn:values:list', 'List values', { nums: `[1${'0'.repeat(400)}]` }, { error: 'nums: not a number' }],
  ['/values', 'urn:values:list', 'List values', { counts: '[1, 9007199254740992]' }, { error: 'counts: integer too large to send exactly' }],
  ['/values', 'urn:values:list', 'List values', { counts: '[1, 9007199254740993]' }, { error: changedNumber('counts', '9007199254740993') }],
  // A list's defaults are what the form holds, one per line or the options a multiple choice
  // selects, when it holds them as they are; when it cannot (a value with a line break in it, or
  // choices out of the options' order), the defaults themselves, and a default that is no choice
  // is refused rather than dropped.
  ['/values', 'urn:values:list-default', 'List defaults', {}, { body: { lines: ['a\nb', 'c'], picks: ['z', 'x'], held: ['x', 'z'] } }],
  ['/values', 'urn:values:bad-pick', 'Bad pick default', {}, { error: 'picks: must be one of x, y, z' }],
  // A text default the form cannot hold as it is, a line break, a carriage return, a NUL or a line
  // break at the start of a text area, is sent as it is, not as the form would change it; and a
  // choice is offered, and sent, as its entry is written, a carriage return or a NUL in it.
  ['/values', 'urn:values:line-default', 'Line defaults', {},
    { body: { line: 'a\nb', cr: 'c\rd', nul: 'x\u0000y', lead: '\nx', pick: 'x\u0000y' } }],
  ['/values', 'urn:values:line-default', 'Line defaults', { pick: 'c\rd' },
    { body: { line: 'a\nb', cr: 'c\rd', nul: 'x\u0000y', lead: '\nx', pick: 'c\rd' } }],
  // A number field takes text as typed: what is not a number, spaces only included, is refused,
  // never replaced by its default.
  ['/link-values', 'urn:lv:write', 'Linked write', { n: 'abc' }, { error: 'n: not an integer' }],
  ['/link-values', 'urn:lv:write', 'Linked write', { n: ' \t ' }, { error: 'n: not an integer' }],
  // A default is read as a value given is: a number field's default of only spaces is no number,
  // and a list's default of only spaces holds no values, so each is refused, given nothing or an
  // empty value; a value given in its place is read instead.
  ['/values', 'urn:values:space-number', 'Space number default', {}, { error: 'amt: not a number' }],
  ['/values', 'urn:values:space-number', 'Space number default', { amt: '' }, { error: 'amt: not a number' }],
  ['/values', 'urn:values:space-number', 'Space number default', { amt: ' 2 ' }, { body: { amt: 2 } }],
  ['/values', 'urn:values:space-list', 'Blank list default', {}, { error: 'mt: its default holds no values, so it is not sent' }],
  ['/values', 'urn:values:space-list', 'Blank list default', { mt: '' }, { error: 'mt: its default holds no values, so it is not sent' }],
  ['/values', 'urn:values:space-list', 'Blank list default', { mt: 'x' }, { body: { mt: ['x'] } }],
  // A required input whose default the form cannot hold is left empty, and the default is sent.
  ['/values', 'urn:values:required-crlf', 'Required CRLF default', {}, { body: { memo: 'a\r\nb' } }],
  // A boolean is trimmed of the spaces a number is, space, tab, CR and LF, and of nothing else.
  ['/values', 'urn:values:flag', 'Flag value', { flag: ' true\t' }, { body: { flag: true } }],
  ['/values', 'urn:values:flag', 'Flag value', { flag: '\u00a0true' }, { error: 'flag must be a boolean' }],
  ...(['Schema lengths', 'Shape lengths'] as const).flatMap(title => {
    const rel = title === 'Schema lengths' ? 'urn:values:length' : 'urn:values:shacl-length';
    return [
      ['/values', rel, title, { one: SMILE, two: SMILE + SMILE }, { body: { one: SMILE, two: SMILE + SMILE } }],
      ['/values', rel, title, { two: SMILE }, { error: 'two: shorter than minLength 2' }],
      ['/values', rel, title, { one: SMILE + SMILE }, { error: 'one: longer than maxLength 1' }],
      ['/values', rel, title, { one: COMBINED }, { error: 'one: longer than maxLength 1' }],
      ['/values', rel, title, { two: COMBINED }, { body: { two: COMBINED } }],
    ] as const;
  }),
];

type ValueCase = readonly [path: string, action: string, title: string, fields: Record<string, string>,
  outcome: { readonly body: unknown } | { readonly error: string; readonly only?: true }];
/** What each client says of a value an address would leave out, after the field's name. */
const ADDRESS_LEAVES = 'holds a value an address leaves out (null, "", [] or {}, alone or inside it), so it is not sent';
/** What each client says of a value given for a field with a constraint neither checks, after its name. */
const unchecked = (names: string) => `has a constraint this client does not check (${names}), so it is not sent`;
/** The problem that keeps a control whose input `name` cannot be read from being invoked. */
const unread = (name: string, what: string) =>
  `the input "${name}" ${what}, which this client does not read, so what it takes is not known; this control is not invoked`;
/** The problem that keeps a control whose body schema names `keyword` from being invoked. */
const rootUnchecked = (keyword: string) =>
  `the JSON Schema names ${keyword}, which this client does not check, so what it sends is not known; this control is not invoked`;
/** The problem that keeps a control whose shape, which has properties, names sh:`key` itself from being invoked. */
const nodeUnchecked = (key: string) =>
  `the shape names sh:${key}, which this client does not check, so what it sends is not known; this control is not invoked`;
/** What a value is refused with when the only entry it matches holds an integer past 2^53, which reading JSON may have rounded. */
const rounded = (at: string, entry: string) =>
  `${at}: matches only ${entry}, which holds an integer past 2^53 that reading JSON may have rounded, so it is not sent`;
/** The problem that keeps a control whose field written in place names `key` from being invoked. */
const inlineUnread = (name: string, key: string) =>
  `the input "${name}" names ${key}, which this client does not read in a field written in place, so what it takes is not known; this control is not invoked`;

/**
 * Choices for /choices each client reads alike, as VALUE_CASES are: an enumeration (or a const)
 * holds JSON values of any kind, and a value is one of them when it is the same JSON value: arrays
 * item by item in order, objects by the same keys with the same values in any order, numbers by
 * value (1.0 is 1, and 2^53 + 1 is the 2^53 JSON.parse reads, so an entry that holds one matches
 * no value, and one that would match only it is refused naming it; a value written 2^53 + 1 is
 * refused itself, since a JSON number would change it), and a string, a boolean or
 * null only the same of its kind ("1" is not 1, true is not 1). A choice in a field whose type leaves its
 * kind open is sent as the entry it names, an array, an object, a number, a boolean or null, never
 * as the text that names it; null is offered as a choice of its own, and refused where an address
 * would leave it out. Two entries written alike are a problem, and the control is not invoked.
 */
export const CHOICE_CASES: ReadonlyArray<ValueCase> = [
  ['/choices', 'urn:choice:array', 'Array choice', { selection: '["not-allowed"]' }, { error: 'selection: must be one of ["allowed"]' }],
  ['/choices', 'urn:choice:array', 'Array choice', { selection: '["allowed"]' }, { body: { selection: ['allowed'] } }],
  ['/choices', 'urn:choice:object', 'Object choice', { pick: '{"b":[2,3],"a":1}' }, { body: { pick: { a: 1, b: [2, 3] } } }],
  ...['{"a":1,"b":[3,2]}', '{"a":1}', '{"a":1,"b":[2,3],"c":0}'].map(pick =>
    ['/choices', 'urn:choice:object', 'Object choice', { pick }, { error: 'pick: must be one of {"a":1,"b":[2,3]}' }] as const),
  ['/choices', 'urn:choice:object', 'Object choice', { pick: '[{"a":1,"b":[2,3]}]' }, { error: 'pick must be a JSON object' }],
  ['/choices', 'urn:choice:nested', 'Nested choice', { grid: '[[1,2],[3]]' }, { body: { grid: [[1, 2], [3]] } }],
  ['/choices', 'urn:choice:nested', 'Nested choice', { grid: '[[]]' }, { body: { grid: [[]] } }],
  ...['[[2,1],[3]]', '[[1,2,3]]', '[[1,2],[3],[]]', '[]'].map(grid =>
    ['/choices', 'urn:choice:nested', 'Nested choice', { grid }, { error: 'grid: must be one of [[1,2],[3]], [[]]' }] as const),
  ['/choices', 'urn:choice:mixed', 'Mixed choice', { mode: 'plain' }, { body: { mode: 'plain' } }],
  ['/choices', 'urn:choice:mixed', 'Mixed choice', { mode: '1' }, { body: { mode: 1 } }],
  ['/choices', 'urn:choice:mixed', 'Mixed choice', { mode: 'true' }, { body: { mode: true } }],
  ['/choices', 'urn:choice:mixed', 'Mixed choice', { mode: '["x"]' }, { body: { mode: ['x'] } }],
  ['/choices', 'urn:choice:mixed', 'Mixed choice', { mode: '{"k":"v"}' }, { body: { mode: { k: 'v' } } }],
  ['/choices', 'urn:choice:mixed', 'Mixed choice', { mode: 'other' }, { error: 'mode: must be one of plain, 1, true, ["x"], {"k":"v"}' }],
  ['/choices', 'urn:choice:null', 'Null choice', { state: 'null' }, { body: { state: null } }],
  ['/choices', 'urn:choice:null', 'Null choice', { state: 'open', kind: 'null' }, { body: { state: 'open', kind: null } }],
  ['/choices', 'urn:choice:null', 'Null choice', { state: 'closed' }, { error: 'state: must be one of open, null' }],
  ['/choices', 'urn:choice:null', 'Null choice', { kind: 'b' }, { error: 'kind: must be one of a, null' }],
  ['/choices', 'urn:choice:null-read', 'Read of a null choice', { state: 'null' }, { error: `state: ${ADDRESS_LEAVES}` }],
  ['/choices', 'urn:choice:null-array', 'Null array choice', { list: 'null' }, { body: { list: null } }],
  ['/choices', 'urn:choice:null-array', 'Null array choice', { list: '["a"]' }, { body: { list: ['a'] } }],
  ['/choices', 'urn:choice:null-array', 'Null array choice', { list: '["b"]' }, { error: 'list: must be one of null, ["a"]' }],
  ['/choices', 'urn:choice:numbers', 'Number choice', { pair: '[1,{"n":2}]' }, { body: { pair: [1, { n: 2 }] } }],
  ['/choices', 'urn:choice:numbers', 'Number choice', { pair: '[1.0,{"n":2.00}]' }, { body: { pair: [1, { n: 2 }] } }],
  ['/choices', 'urn:choice:numbers', 'Number choice', { pair: '[9007199254740992]' }, { error: rounded('pair', '[9007199254740993]') }],
  ['/choices', 'urn:choice:numbers', 'Number choice', { pair: '[9007199254740993]' }, { error: changedNumber('pair', '9007199254740993') }],
  ...['[1,{"n":2.5}]', '[true,{"n":2}]', '["1",{"n":2}]', '[1,{"n":"2"}]'].map(pair =>
    ['/choices', 'urn:choice:numbers', 'Number choice', { pair }, { error: 'pair: must be one of [1,{"n":2}], [9007199254740993]' }] as const),
  ['/choices', 'urn:choice:list', 'List choice', { tags: '["a","c"]' }, { error: 'tags: must be one of a, b' }],
  ['/choices', 'urn:choice:list', 'List choice', { tags: '["b","a"]' }, { body: { tags: ['b', 'a'] } }],
  ['/choices', 'urn:choice:items', 'Item choice', { codes: '["x","z"]' }, { error: 'codes/1: must be one of x, y' }],
  ['/choices', 'urn:choice:items', 'Item choice', { codes: '["y","x"]' }, { body: { codes: ['y', 'x'] } }],
  ['/choices', 'urn:choice:const', 'Const choice', { v: '{"a":[1]}' }, { body: { v: { a: [1] } } }],
  ['/choices', 'urn:choice:const', 'Const choice', { v: '{"a":[2]}' }, { error: 'v: must be {"a":[1]}' }],
  ['/choices', 'urn:choice:alike', 'Alike choice', { flag: 'true' },
    { error: 'the input "flag" offers two choices written alike (true), so which one is meant is not known; this control is not invoked' }],
  // A default is checked and sent as the document gives it, so one that is another JSON value than
  // the choice its text names is not that choice: the form leaves it out and the default is refused.
  ['/choices', 'urn:choice:text-default', 'Number default of a text choice', {}, { error: 'm: must be one of 1' }],
  ['/choices', 'urn:choice:typed-default', 'Number default of a string choice', {}, { error: 'm: must be a JSON string' }],
  ['/choices', 'urn:choice:bool-default', 'Boolean default of a text choice', {}, { error: 'm: must be one of true' }],
  ['/choices', 'urn:choice:number-default', 'Text default of a number choice', {}, { error: 'm: must be one of 1' }],
  ['/choices', 'urn:choice:same-default', 'Default that is a choice', {}, { body: { m: 2 } }],
  // An integer field offers no entry past 2^53, which JSON.parse has rounded, and refuses the value
  // its rounding names rather than send it.
  ['/choices', 'urn:choice:past-safe', 'Integer choice past 2^53', { n: '9007199254740992' }, { error: 'n: integer too large to send exactly' }],
  ['/choices', 'urn:choice:past-safe-const', 'Integer const past 2^53', { n: '9007199254740992' }, { error: 'n: integer too large to send exactly' }],
];

/**
 * The other value constraints each client reads, swept across the kinds of value each can meet,
 * on /sweep, read alike by both clients as VALUE_CASES are. A constraint is checked where its
 * standard applies it to the value's kind and passed over where it does not (a JSON Schema length
 * constrains only a string, a bound only a number); where neither client can check it, a value
 * given is refused by name; and a keyword written in a form its standard does not allow keeps the
 * control from being invoked.
 */
export const SWEEP_CASES: ReadonlyArray<ValueCase> = [
  ['/sweep', 'urn:sweep:exclusive', 'Exclusive bounds', { n: '0' }, { error: 'n: not above exclusiveMinimum 0' }],
  ['/sweep', 'urn:sweep:exclusive', 'Exclusive bounds', { n: '10' }, { error: 'n: not below exclusiveMaximum 10' }],
  ['/sweep', 'urn:sweep:exclusive', 'Exclusive bounds', { m: '0' }, { error: 'm: not above exclusiveMinimum 0' }],
  ['/sweep', 'urn:sweep:exclusive', 'Exclusive bounds', { n: '5', m: '0.5' }, { body: { n: 5, m: 0.5 } }],
  ['/sweep', 'urn:sweep:json-type', 'Array or object', { extra: '5' }, { error: 'extra: must be a JSON array or object' }],
  ['/sweep', 'urn:sweep:json-type', 'Array or object', { extra: 'null' }, { error: 'extra: must be a JSON array or object' }],
  ['/sweep', 'urn:sweep:json-type', 'Array or object', { extra: '[1]' }, { body: { extra: [1] } }],
  ['/sweep', 'urn:sweep:unchecked', 'Unchecked keywords', { u: '["a"]' }, { error: `u: ${unchecked('uniqueItems')}` }],
  ['/sweep', 'urn:sweep:unchecked', 'Unchecked keywords', { w: '[2]' }, { error: `w: ${unchecked('items/multipleOf')}` }],
  ['/sweep', 'urn:sweep:number-length', 'Number length', { n: '10' }, { body: { n: 10 } }],
  ['/sweep', 'urn:sweep:string-bound', 'String bound', { s: 'abc' }, { body: { s: 'abc' } }],
  ['/sweep', 'urn:sweep:nested', 'Nested schema', { doc: '{"tags":[]}' }, { error: 'doc: is missing the key "id"' }],
  ['/sweep', 'urn:sweep:nested', 'Nested schema', { doc: '{"id":0}' }, { error: 'doc/id: below minInclusive 1' }],
  ['/sweep', 'urn:sweep:nested', 'Nested schema', { doc: '{"id":"1"}' }, { error: 'doc/id: must be a JSON integer' }],
  ['/sweep', 'urn:sweep:nested', 'Nested schema', { doc: '{"id":1.5}' }, { error: 'doc/id: must be a JSON integer' }],
  ['/sweep', 'urn:sweep:nested', 'Nested schema', { doc: '{"id":1,"tags":["abcd"]}' }, { error: 'doc/tags/0: longer than maxLength 3' }],
  ['/sweep', 'urn:sweep:nested', 'Nested schema', { doc: '{"id":1,"tags":["a","b","c"]}' }, { error: 'doc/tags: takes at most 2 values, got 3' }],
  ['/sweep', 'urn:sweep:nested', 'Nested schema', { doc: '{"id":1,"x":1}' }, { error: 'doc/x: is not allowed by its schema' }],
  ['/sweep', 'urn:sweep:nested', 'Nested schema', { doc: '{"id":2,"tags":["ab"]}' }, { body: { doc: { id: 2, tags: ['ab'] } } }],
  ['/sweep', 'urn:sweep:union', 'Type union', { u: '1' },
    { error: 'the input "u" names JSON Schema types (integer, boolean) that this client does not read as one input, so what it takes is not known; this control is not invoked' }],
  ['/sweep', 'urn:sweep:bad-type', 'Bad type', { u: '1' }, { error: unread('u', 'writes type as something other than a JSON Schema type name or a list of them') }],
  ['/sweep', 'urn:sweep:bad-length', 'Bad length', { u: 'a' }, { error: unread('u', 'writes maxLength as something other than a whole number of zero or more') }],
  ['/sweep', 'urn:sweep:bad-bound', 'Bad bound', { u: '1' }, { error: unread('u', 'writes minimum as something other than a number') }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { ex: '0' }, { error: 'ex: not above minExclusive 0' }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { ex: '10' }, { error: 'ex: not below maxExclusive 10' }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { ex: '5' }, { body: { ex: 5 } }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { day: '2024-01-01' }, { body: { day: '2024-01-01' } }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { day: '2024-02-30' }, { error: 'day: not an xsd:date' }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { when: '2024-02-01' },
    { error: 'when: its sh:minInclusive 2024-01-01 is not a number, which this client does not compare, so it is not sent' }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { pos: '0' }, { error: 'pos: out of the range of xsd:positiveInteger' }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { byte: '128' }, { error: 'byte: out of the range of xsd:byte' }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { pos: '1', byte: '-128' }, { body: { pos: 1, byte: -128 } }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { iri: 'not an iri' }, { error: 'iri: must be an IRI' }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { iri: 'urn:x' }, { body: { iri: 'urn:x' } }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { cls: 'urn:thing:1' }, { error: `cls: ${unchecked('sh:class')}` }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { node: '{"a":1}' }, { error: `node: ${unchecked('sh:node')}` }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { jlen: '[1]' }, { error: 'jlen: holds JSON, which a length facet does not measure, so it is not sent' }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { jin: '"x"' }, { body: { jin: 'x' } }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { jin: '[1]' }, { body: { jin: [1] } }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { jin: '[2]' }, { error: 'jin: must be one of [1], "x"' }],
  ['/sweep', 'urn:sweep:has-value', 'Has value', { fixed: 'no', tags: 'a' }, { error: 'fixed: must be yes' }],
  ['/sweep', 'urn:sweep:has-value', 'Has value', { tags: 'a' }, { error: "missing required field 'fixed'" }],
  ['/sweep', 'urn:sweep:has-value', 'Has value', { fixed: 'yes', tags: 'b' }, { error: 'tags: must include a' }],
  ['/sweep', 'urn:sweep:has-value', 'Has value', { fixed: 'yes', tags: 'b\na' }, { body: { fixed: 'yes', tags: ['b', 'a'] } }],
  ['/sweep', 'urn:sweep:qualified', 'Qualified shape', { q: 'x' },
    { error: 'the input "q" names sh:qualifiedValueShape, which this client does not check, so what it takes is not known; this control is not invoked' }],
  ['/sweep', 'urn:sweep:writable', 'Writable', { id: 'x' }, { error: 'id: is not writable (hydra:writable false), so it is not sent' }],
  ['/sweep', 'urn:sweep:writable', 'Writable', { name: 'n' }, { body: { name: 'n' } }],
  ['/sweep', 'urn:sweep:root-all-of', 'Root allOf', { a: 'x' },
    { error: 'the JSON Schema names allOf, which this client does not check, so what it sends is not known; this control is not invoked' }],
  ['/sweep', 'urn:sweep:root-required', 'Root required', { a: 'x' },
    { error: 'the JSON Schema requires "b", which it does not describe, so what it sends is not known; this control is not invoked' }],
  ['/sweep', 'urn:sweep:empty-read', 'Empty read', { list: '[]' }, { error: `list: ${ADDRESS_LEAVES}` }],
  ['/sweep', 'urn:sweep:empty-read', 'Empty read', { list: '["a",null]' }, { error: `list: ${ADDRESS_LEAVES}` }],
  // An enum or a const on the schema of the whole body is checked by neither client.
  ['/sweep', 'urn:sweep:root-enum', 'Root enum', { a: 'y' }, { error: rootUnchecked('enum') }],
  ['/sweep', 'urn:sweep:root-enum', 'Root enum', {}, { error: rootUnchecked('enum') }],
  ['/sweep', 'urn:sweep:root-const', 'Root const', { a: 'x' }, { error: rootUnchecked('const') }],
  // A template's variable that is no property of the body's schema is sent in the body too, so
  // additionalProperties is its schema.
  ['/sweep', 'urn:sweep:extra-false', 'Template variable, no other property', { a: 'x', q: 'y' }, { error: 'q: is not allowed by its schema' }],
  ['/sweep', 'urn:sweep:extra-false', 'Template variable, no other property', { a: 'x' }, { body: { a: 'x' } }],
  ['/sweep', 'urn:sweep:extra-schema', 'Template variable, other properties bounded', { q: '9' }, { error: 'q: above maxInclusive 5' }],
  ['/sweep', 'urn:sweep:extra-schema', 'Template variable, other properties bounded', { q: 'x' }, { error: 'q: not an integer' }],
  ['/sweep', 'urn:sweep:extra-schema', 'Template variable, other properties bounded', { q: '3' }, { body: { q: 3 } }],
  // A property shape's own sh:property and sh:closed constrain its value node; sh:closed false does not.
  ['/sweep', 'urn:sweep:nested-shape', 'Nested shape', { d: '{"x":1}' }, { error: `d: ${unchecked('sh:property')}` }],
  ['/sweep', 'urn:sweep:nested-shape', 'Nested shape', { e: '{"x":1}' }, { error: `e: ${unchecked('sh:closed')}` }],
  ['/sweep', 'urn:sweep:nested-shape', 'Nested shape', { f: '{"x":1}' }, { body: { f: { x: 1 } } }],
  // A body sent whole is checked against the shape's own value constraints, as an input is.
  ['/sweep', 'urn:sweep:raw-in', 'Body choices', { body: 'c' }, { error: 'body: must be one of a, b' }],
  ['/sweep', 'urn:sweep:raw-in', 'Body choices', { body: 'a' }, { body: 'a' }],
  ['/sweep', 'urn:sweep:raw-bound', 'Body bound', { body: '9' }, { error: 'body: above maxInclusive 5' }],
  ['/sweep', 'urn:sweep:raw-bound', 'Body bound', { body: '3' }, { body: '3' }],
  ['/sweep', 'urn:sweep:raw-kind', 'Body node kind', { body: 'not an iri' }, { error: 'body: must be an IRI' }],
  ['/sweep', 'urn:sweep:raw-language', 'Body language', { body: 'x' }, { error: `body: ${unchecked('sh:languageIn')}` }],
  ['/sweep', 'urn:sweep:raw-has-value', 'Body value', { body: 'no' }, { error: 'body: must be yes' }],
  ['/sweep', 'urn:sweep:raw-has-value', 'Body value', { body: 'yes' }, { body: 'yes' }],
  // A value constraint on a shape that has properties constrains the body, which no input checks.
  ['/sweep', 'urn:sweep:node-in', 'Shape choices', { z: 'q' }, { error: nodeUnchecked('in') }],
  ['/sweep', 'urn:sweep:node-kind', 'Shape node kind', { z: 'q' }, { error: nodeUnchecked('nodeKind') }],
  // sh:nodeKind applies to each value: each item of a field that holds a JSON array, and an
  // rdf:JSON value, which is a literal.
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { nodes: '["a", 1]' }, { error: 'nodes: must be a blank node' }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { nodes: '[{"a":1}]' }, { body: { nodes: [{ a: 1 }] } }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { jlit: '{"a":1}' }, { body: { jlit: { a: 1 } } }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { jnode: '{"a":1}' }, { error: 'jnode: must be a blank node' }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { fl: '1e300' }, { error: 'fl: out of the range of xsd:float' }],
  ['/sweep', 'urn:sweep:shacl', 'Shape constraints', { fl: '3.4e38' }, { body: { fl: 3.4e38 } }],
  // A field written in place says only what the reader models; any other key is refused by name.
  ['/sweep', 'urn:sweep:inline-key', 'Inline field choices', { x: 'a' }, { error: inlineUnread('x', 'in') }],
  ['/values-md', 'hm-unread-key', 'Unread field key', { x: '6' }, { error: inlineUnread('x', 'minInclusive') }],
  // A JSON Schema bound or length is a number; one written as text is not read.
  ['/sweep', 'urn:sweep:text-bound', 'Bound as text', { n: '6' }, { error: unread('n', 'writes minimum as something other than a number') }],
  ['/sweep', 'urn:sweep:text-length', 'Length as text', { s: 'abcd' },
    { error: unread('s', 'writes minLength as something other than a whole number of zero or more') }],
  // An entry no double holds is not offered: null is then a choice alone, and a number field's
  // choice its one other entry.
  ['/sweep', 'urn:sweep:infinite-entry', 'Entry past a double', { m: 'null' }, { body: { m: null } }],
  ['/sweep', 'urn:sweep:infinite-number', 'Number entry past a double', { m: 'null' }, { error: 'm: not a number' }],
  ['/sweep', 'urn:sweep:infinite-number', 'Number entry past a double', { m: '1' }, { body: { m: 1 } }],
  // readOnly says the value is not the client's to write, as hydra:writable false does.
  ['/sweep', 'urn:sweep:read-only', 'Read-only', { id: 'x' }, { error: 'id: is read-only (readOnly true), so it is not sent' }],
  ['/sweep', 'urn:sweep:read-only', 'Read-only', { doc: '{"id":1}' }, { error: 'doc/id: is read-only (readOnly true), so it is not sent' }],
  ['/sweep', 'urn:sweep:read-only', 'Read-only', { name: 'n', doc: '{}' }, { body: { name: 'n', doc: {} } }],
];

/** What a default of another kind than its field takes is refused with. */
const wrongDefault = (name: string, value: string, kind: string) =>
  `${name}: its default ${value} is not ${kind}, which this field takes, so it is not sent`;
/** What a bound on a field that takes no number is refused with. */
const textBound = (name: string, bound: string) =>
  `${name}: its sh:minInclusive ${bound} bounds a field that takes no number, which this client does not compare, so it is not sent`;
/** What a value is refused with when its field's bound, `label`, written as `text`, may not be the number the document writes. */
const inexactBound = (name: string, label: string, text: string) =>
  `${name}: its ${label} ${text} is a number a double may not hold exactly, which this client does not compare, so it is not sent`;
/** What a value is refused with when the only entry it matches holds a number reading JSON may have rounded, other than an integer past 2^53. */
const roundedEntry = (at: string, entry: string) =>
  `${at}: matches only ${entry}, which holds a number that reading JSON may have rounded, so it is not sent`;
/** The problem that keeps a control whose field written in place `what` from being invoked. */
const inlinePlace = (name: string, what: string) => `the input "${name}" ${what}, so what it takes is not known; this control is not invoked`;

/**
 * Rules on /rules and /rules-md, read alike by both clients as SWEEP_CASES are:
 *   - a value given empty (a link's field.m=, an empty --field m=, a cleared input) and none given
 *     (an untouched form) both take the default as the document gives it, checked as it is: a
 *     JSON Schema string field's default of 1 is refused, never sent as "1"; an untyped property's
 *     object default is sent as the object; and a shape's default of another kind than its
 *     datatype takes (a number for text, 1 for a boolean, an item of a list) is refused by name,
 *     while a number field's default written as text is that number;
 *   - sh:maxCount 0 takes no value, a value given and a default alike;
 *   - a field written in place counts its values and reads rdf:JSON as a property shape does, and,
 *     beside a shape the document describes, is checked against it: the shape's constraints are
 *     the field's, and a field the shape lacks or that disagrees with it keeps the control from
 *     being invoked;
 *   - a body schema with no properties is a JSON Schema, so additionalProperties false refuses a
 *     template variable and a required name it lacks keeps the control from being invoked; a closed
 *     shape refuses a template variable sh:ignoredProperties does not name;
 *   - a bound on text, an untyped field or a date is not compared, and a date is checked as XSD 1.1
 *     writes one;
 *   - a field name holding "/" is set apart from the pointer after it;
 *   - readOnly on the body schema keeps the control from being invoked, and a property that is
 *     readOnly or not writable is never given its default;
 *   - an entry past 2^53 is not offered, and a number that names it is refused;
 *   - a shape the document describes with no properties is the shape: closed, it refuses a template
 *     variable sh:ignoredProperties does not name, and beside it a field written in place keeps the
 *     control from being invoked;
 *   - a JSON Schema default written as text is that text, in any field: never trimmed, read as a
 *     number or a boolean, or parsed as JSON; a shape's boolean default is true, false, 1 or 0;
 *   - a schema inside a property's schema written as a reference (@id) refuses a value given;
 *   - a count or a length written in place that is no whole number of zero or more (a fraction,
 *     text, a negative number, one past 2^53) keeps the control from being invoked, and so does a
 *     shape's negative count;
 *   - an entry that holds an integer past 2^53, which reading JSON may have rounded, matches no
 *     value, in sh:in, sh:hasValue, and an enum or a const at any depth: a value that would match
 *     only it is refused naming it;
 *   - a list default with a blank value is refused, never sent without it; a JSON Schema default of
 *     null is sent as null where its schema allows null, and refused where it does not;
 *   - a default of empty text is a value, sent as it is in a body, and refused where an address
 *     would leave it out or a number field reads no number in it;
 *   - a JSON-LD keyword inside a schema written in place (@set, @list, @graph, @value) is named
 *     where it is, and a value given is refused, as a reference (@id) is;
 *   - a list's values are checked against a sh:hasValue past 2^53 as a single value is;
 *   - an integer field's value past 2^53 - 1 is refused alike in both clients;
 *   - a default that holds a number reading JSON may have rounded (an integer past 2^53, or the
 *     double of a number the document writes with more digits than it keeps) is refused at any
 *     depth, but in a double field, and JSON text given or written as a default that holds a
 *     number its double would change is refused naming the number;
 *   - a supported property with no sh:name whose hydra:property is a blank node is named by that
 *     node's rdfs:label, written with a language or as an array alike, though it is read both for
 *     what the field shows and for its name.
 */
export const RULE_CASES: ReadonlyArray<ValueCase> = [
  ['/rules', 'urn:rules:schema-default', 'String default 1', {}, { error: 'm: must be a JSON string' }],
  ['/rules', 'urn:rules:schema-default', 'String default 1', { m: '' }, { error: 'm: must be a JSON string' }],
  ['/rules', 'urn:rules:schema-default', 'String default 1', { m: '1' }, { body: { m: '1' } }],
  ['/rules', 'urn:rules:untyped-default', 'Untyped object default', {}, { body: { m: { k: 1 } } }],
  ['/rules', 'urn:rules:untyped-default', 'Untyped object default', { m: '' }, { body: { m: { k: 1 } } }],
  ['/rules', 'urn:rules:untyped-default', 'Untyped object default', { m: '{"k":1}' }, { body: { m: '{"k":1}' } }],
  ['/rules', 'urn:rules:shape-default', 'Shape number default', {}, { error: wrongDefault('m', '5', 'text') }],
  ['/rules', 'urn:rules:shape-default', 'Shape number default', { m: '' }, { error: wrongDefault('m', '5', 'text') }],
  ['/rules', 'urn:rules:shape-default', 'Shape number default', { m: '5' }, { body: { m: '5' } }],
  ['/rules', 'urn:rules:shape-untyped', 'Untyped shape number default', {}, { error: wrongDefault('m', '5', 'text') }],
  ['/rules', 'urn:rules:list-default', 'List number default', {}, { error: wrongDefault('m', '1', 'text') }],
  ['/rules', 'urn:rules:list-default', 'List number default', { m: 'b' }, { body: { m: ['b'] } }],
  ['/rules', 'urn:rules:bool-default', 'Boolean number default', {}, { error: wrongDefault('b', '1', 'a boolean') }],
  ['/rules', 'urn:rules:number-text-default', 'Number text default', {}, { body: { n: 7 } }],
  ['/rules', 'urn:rules:number-text-default', 'Number text default', { n: '' }, { body: { n: 7 } }],
  ['/rules', 'urn:rules:zero', 'No value', { m: 'x' }, { error: 'm: takes at most 0 values, got 1' }],
  ['/rules', 'urn:rules:zero', 'No value', {}, { body: {} }],
  ['/rules', 'urn:rules:zero-default', 'No value, with a default', {}, { error: 'm: takes at most 0 values, got 1' }],
  ['/rules', 'urn:rules:inline-min', 'Inline two or more', { x: 'a' }, { error: 'x: needs at least 2 values, got 1' }],
  ['/rules', 'urn:rules:inline-min', 'Inline two or more', { x: 'a\nb' }, { body: { x: ['a', 'b'] } }],
  ['/rules', 'urn:rules:inline-max', 'Inline three or fewer', { x: 'a\nb\nc\nd' }, { error: 'x: takes at most 3 values, got 4' }],
  ['/rules', 'urn:rules:inline-max', 'Inline three or fewer', { x: '["a","b"]' }, { body: { x: ['a', 'b'] } }],
  ['/rules', 'urn:rules:inline-zero', 'Inline none', { x: 'a' }, { error: 'x: takes at most 0 values, got 1' }],
  ['/rules', 'urn:rules:inline-json', 'Inline JSON', { x: '{bad' }, { error: 'x must be JSON' }],
  ['/rules', 'urn:rules:inline-json', 'Inline JSON', { x: '{"a":1}' }, { body: { x: { a: 1 } } }],
  ['/rules-md', 'hm-inline-min', 'Block two or more', { x: 'a' }, { error: 'x: needs at least 2 values, got 1' }],
  ['/rules', 'urn:rules:inline-schema', 'Inline beside a schema', { x: 'zzz' }, { error: 'x: must be one of a' }],
  ['/rules', 'urn:rules:inline-schema', 'Inline beside a schema', { x: 'a' }, { body: { x: 'a' } }],
  ['/rules', 'urn:rules:inline-shape', 'Inline beside a shape', { x: 'zzz' }, { error: 'x: must be one of a' }],
  ['/rules', 'urn:rules:inline-disagree', 'Inline that disagrees', { x: '1' },
    { error: inlinePlace('x', 'written in place disagrees with the shape hydra:expects names on its datatype') }],
  ['/rules', 'urn:rules:inline-extra', 'Inline the shape lacks', { y: '1' },
    { error: inlinePlace('y', 'is written in place but is not in the shape hydra:expects names') }],
  ['/rules', 'urn:rules:inline-outside', 'Inline beside an outside shape', { x: 'v' }, { body: { x: 'v' } }],
  ['/rules-md', 'hm-expects', 'Block expects', { x: 'v' }, { body: { x: 'v' } }],
  ['/rules-md', 'hm-deep-fields', 'Block nested too deep', {},
    { error: 'this control block writes fields as JSON nested deeper than 256 levels, which this client does not read, so what it sends is not known; it is not invoked' }],
  ['/rules', 'urn:rules:no-props-false', 'Body of no properties', { q: 'y' }, { error: 'q: is not allowed by its schema' }],
  ['/rules', 'urn:rules:no-props-false', 'Body of no properties', {}, { body: null }],
  ['/rules', 'urn:rules:no-props-required', 'Body requiring what it lacks', {},
    { error: 'the JSON Schema requires "x", which it does not describe, so what it sends is not known; this control is not invoked' }],
  ['/rules', 'urn:rules:closed-var', 'Closed shape variable', { a: 'x', q: 'y' },
    { error: 'q: is not allowed by its shape, which is closed (sh:closed true), so it is not sent' }],
  ['/rules', 'urn:rules:closed-var', 'Closed shape variable', { a: 'x' }, { body: { a: 'x' } }],
  ['/rules', 'urn:rules:closed-ignored', 'Closed shape ignoring the variable', { a: 'x', q: 'y' }, { body: { a: 'x', q: 'y' } }],
  ['/rules', 'urn:rules:text-bounds', 'Bounds on text', { tb: '5' }, { error: textBound('tb', '3') }],
  ['/rules', 'urn:rules:text-bounds', 'Bounds on text', { ub: '5' }, { error: textBound('ub', '3') }],
  ['/rules', 'urn:rules:text-bounds', 'Bounds on text', { since: '2024-01-01' },
    { error: 'since: its sh:minInclusive 2020-01-01 is not a number, which this client does not compare, so it is not sent' }],
  ['/rules', 'urn:rules:text-bounds', 'Bounds on text', { when: '2024-01-01T00:00:00' }, { error: 'when: not an xsd:dateTimeStamp' }],
  ['/rules', 'urn:rules:text-bounds', 'Bounds on text', { when: '2024-01-01T00:00:00Z' }, { body: { when: '2024-01-01T00:00:00Z' } }],
  ['/rules', 'urn:rules:text-bounds', 'Bounds on text', { span: 'P1D\nPT36H' }, { body: { span: ['P1D', 'PT36H'] } }],
  ['/rules', 'urn:rules:text-bounds', 'Bounds on text', { span: 'P1D\nP1M' }, { error: 'span: not an xsd:dayTimeDuration' }],
  ['/rules', 'urn:rules:slash-name', 'Slash name', { 'd/x': '["a"]' }, { error: 'd/x at /0: must be a JSON integer' }],
  ['/rules', 'urn:rules:slash-name', 'Slash name', { 'd/x': '[1]' }, { body: { 'd/x': [1] } }],
  ['/rules', 'urn:rules:root-read-only', 'Read-only body', { a: 'x' },
    { error: 'the JSON Schema of the body is read-only (readOnly true), so nothing is written to it; this control is not invoked' }],
  ['/rules', 'urn:rules:read-only-default', 'Read-only default', { name: 'n' }, { body: { name: 'n' } }],
  ['/rules', 'urn:rules:unwritable-default', 'Unwritable default', { name: 'n' }, { body: { name: 'n' } }],
  ['/rules', 'urn:rules:number-past-safe', 'Number entry past 2^53', { n: '9007199254740992' }, { error: 'n: integer too large to send exactly' }],
  ['/rules', 'urn:rules:untyped-past-safe', 'Untyped entry past 2^53', { m: 'a' }, { body: { m: 'a' } }],
  ['/rules', 'urn:rules:untyped-past-safe', 'Untyped entry past 2^53', { m: '9007199254740992' }, { error: 'm: must be one of 9007199254740993, a' }],
  ['/rules', 'urn:rules:closed-empty-var', 'Closed empty shape variable', { q: 'y' },
    { error: 'q: is not allowed by its shape, which is closed (sh:closed true), so it is not sent' }],
  ['/rules', 'urn:rules:closed-empty-ignored', 'Closed empty shape ignoring the variable', { q: 'y' }, { body: { q: 'y' } }],
  ['/rules', 'urn:rules:closed-empty-inline', 'Inline beside a closed empty shape', { x: 'a' },
    { error: inlinePlace('x', 'is written in place but is not in the shape hydra:expects names') }],
  ['/rules', 'urn:rules:open-empty-inline', 'Inline beside an open empty shape', { x: 'a' },
    { error: inlinePlace('x', 'is written in place but is not in the shape hydra:expects names') }],
  ['/rules', 'urn:rules:number-text-schema', 'Schema number text default', {}, { error: 'm: must be a JSON number' }],
  ['/rules', 'urn:rules:number-text-schema', 'Schema number text default', { m: '' }, { error: 'm: must be a JSON number' }],
  ['/rules', 'urn:rules:number-text-schema', 'Schema number text default', { m: '5' }, { body: { m: 5 } }],
  ['/rules', 'urn:rules:integer-text-schema', 'Schema integer text default', {}, { error: 'm: must be a JSON integer' }],
  ['/rules', 'urn:rules:boolean-text-schema', 'Schema boolean text default', {}, { error: 'm: must be a JSON boolean' }],
  ['/rules', 'urn:rules:object-text-schema', 'Schema object text default', {}, { error: 'm: must be a JSON object' }],
  ['/rules', 'urn:rules:enum-text-schema', 'Schema enum text default', {}, { error: 'm: must be a JSON integer' }],
  ['/rules', 'urn:rules:bool-yes-default', 'Boolean yes default', {}, { error: wrongDefault('b', 'yes', 'a boolean') }],
  ['/rules', 'urn:rules:bool-text-default', 'Boolean text default', {}, { body: { b: false } }],
  ['/rules', 'urn:rules:nested-ref', 'Nested reference', { a: '["zzz"]' }, { error: `a: ${unchecked('items/@id')}` }],
  ['/rules', 'urn:rules:nested-ref', 'Nested reference', { o: '{"k":"zzz"}' }, { error: `o: ${unchecked('additionalProperties/@id')}` }],
  ['/rules', 'urn:rules:nested-ref', 'Nested reference', { p: '{"k":"zzz"}' }, { error: `p: ${unchecked('properties/k/@id')}` }],
  ['/rules', 'urn:rules:inline-fraction', 'Inline fraction count', { x: 'abcd' }, { error: inlinePlace('x', 'names a maxCount that is not a whole number (1.5)') }],
  ['/rules', 'urn:rules:inline-text-count', 'Inline text length', { x: 'abcd' }, { error: inlinePlace('x', 'names a minLength that is not a whole number ("2")') }],
  ['/rules', 'urn:rules:inline-negative', 'Inline negative count', { x: 'abcd' }, { error: inlinePlace('x', 'names a maxCount that is not a whole number (-1)') }],
  ['/rules-md', 'hm-inline-bad-length', 'Block length past 2^53', { x: 'abcd' },
    { error: inlinePlace('x', 'names a maxLength that is not a whole number (9007199254740992)') }],
  ['/rules', 'urn:rules:shape-negative', 'Shape negative count', { m: 'a' }, { error: inlinePlace('m', 'names an sh:maxCount that is not a whole number (-1)') }],
  ['/rules', 'urn:rules:rounded-in', 'Rounded entries', { u: '9007199254740992' }, { error: rounded('u', '9007199254740993') }],
  ['/rules', 'urn:rules:rounded-in', 'Rounded entries', { u: '1' }, { body: { u: '1' } }],
  ['/rules', 'urn:rules:rounded-in', 'Rounded entries', { d: '9007199254740992' }, { error: rounded('d', '9007199254740993') }],
  ['/rules', 'urn:rules:rounded-in', 'Rounded entries', { j: '{"a":9007199254740992}' }, { error: rounded('j', '{"a":9007199254740993}') }],
  ['/rules', 'urn:rules:rounded-in', 'Rounded entries', { j: '{"a":1}' }, { body: { j: { a: 1 } } }],
  ['/rules', 'urn:rules:rounded-has-value', 'Rounded has value', { h: '9007199254740992' }, { error: rounded('h', '9007199254740993') }],
  ['/rules', 'urn:rules:rounded-has-value', 'Rounded has value', { h: '1' }, { error: 'h: must be 9007199254740993' }],
  ['/rules', 'urn:rules:rounded-nested', 'Rounded nested entries', { a: '[9007199254740992]' }, { error: rounded('a/0', '9007199254740993') }],
  ['/rules', 'urn:rules:rounded-nested', 'Rounded nested entries', { a: '[1]' }, { body: { a: [1] } }],
  ['/rules', 'urn:rules:rounded-nested', 'Rounded nested entries', { o: '{"a":9007199254740992}' }, { error: rounded('o', '{"a":9007199254740993}') }],
  ['/rules', 'urn:rules:rounded-nested', 'Rounded nested entries', { c: '[9007199254740992]' }, { error: rounded('c/0', '9007199254740993') }],
  ['/rules', 'urn:rules:rounded-nested', 'Rounded nested entries', { c: '[1]' }, { error: 'c/0: must be 9007199254740993' }],
  ['/rules', 'urn:rules:list-blank-default', 'List blank default', {},
    { error: 'm: its default holds a blank value, which this client neither drops nor sends, so it is not sent' }],
  ['/rules', 'urn:rules:list-blank-default', 'List blank default', { m: 'b' }, { body: { m: ['b'] } }],
  ['/rules', 'urn:rules:null-default', 'Null choice default', {}, { body: { m: null } }],
  ['/rules', 'urn:rules:null-default', 'Null choice default', { m: 'a' }, { body: { m: 'a' } }],
  ['/rules', 'urn:rules:nullable-default', 'Nullable default', {}, { body: { m: null } }],
  ['/rules', 'urn:rules:null-not-allowed', 'Null default not allowed', {}, { error: 'm: must be a JSON string' }],
  // A default of empty text is sent as it is, in a JSON Schema, a shape and a field written in
  // place alike; an address would leave it out, and a number field reads no number in it.
  ['/rules', 'urn:rules:empty-text-schema', 'Empty text schema default', {}, { body: { m: '' } }],
  ['/rules', 'urn:rules:empty-text-schema', 'Empty text schema default', { m: '' }, { body: { m: '' } }],
  ['/rules', 'urn:rules:empty-text-schema', 'Empty text schema default', { m: 'a' }, { body: { m: 'a' } }],
  ['/rules', 'urn:rules:empty-text-shape', 'Empty text shape default', {}, { body: { m: '' } }],
  ['/rules', 'urn:rules:empty-text-inline', 'Empty text inline default', {}, { body: { m: '' } }],
  ['/rules', 'urn:rules:empty-text-read', 'Empty text read default', {}, { error: `m: ${ADDRESS_LEAVES}` }],
  ['/rules', 'urn:rules:empty-text-number', 'Empty text number default', {}, { error: 'm: not an integer' }],
  ['/rules', 'urn:rules:empty-text-boolean', 'Empty text boolean default', {}, { error: wrongDefault('m', '""', 'a boolean') }],
  // A JSON-LD keyword inside a schema written in place is named where it is, and refuses a value.
  ['/rules', 'urn:rules:keyword-schema', 'JSON-LD keywords in a schema', { a: '["x"]' }, { error: `a: ${unchecked('items/@set')}` }],
  ['/rules', 'urn:rules:keyword-schema', 'JSON-LD keywords in a schema', { s: 'x' }, { error: `s: ${unchecked('@set')}` }],
  ['/rules', 'urn:rules:keyword-schema', 'JSON-LD keywords in a schema', { l: '["x"]' }, { error: `l: ${unchecked('items/@list')}` }],
  ['/rules', 'urn:rules:keyword-schema', 'JSON-LD keywords in a schema', { g: '{"k":"x"}' }, { error: `g: ${unchecked('properties/k/@graph')}` }],
  ['/rules', 'urn:rules:keyword-schema', 'JSON-LD keywords in a schema', { v: '["x"]' }, { error: `v: ${unchecked('items/@value, items/@type')}` }],
  ['/rules', 'urn:rules:keyword-schema', 'JSON-LD keywords in a schema', { x: '{"k":"x"}' }, { error: `x: ${unchecked('additionalProperties/@set')}` }],
  // A list that holds the value a sh:hasValue past 2^53 names is refused naming it, and a JSON
  // Schema number's default of only spaces is checked as the text it is, never trimmed.
  ['/rules', 'urn:rules:rounded-has-value-list', 'Rounded has value list', { r: '9007199254740992\n1' }, { error: rounded('r', '9007199254740993') }],
  ['/rules', 'urn:rules:rounded-has-value-list', 'Rounded has value list', { r: '1' }, { error: 'r: must include 9007199254740993' }],
  ['/rules', 'urn:rules:space-number-schema', 'Schema number space default', {}, { error: 'm: must be a JSON number' }],
  // An integer field's value past 2^53 is refused alike, whatever its type's range or its bounds.
  ['/rules', 'urn:rules:integer-past-safe', 'Integers past 2^53', { l: '9007199254740993' }, { error: 'l: integer too large to send exactly' }],
  ['/rules', 'urn:rules:integer-past-safe', 'Integers past 2^53', { l: '+1234567890123456789' }, { error: 'l: integer too large to send exactly' }],
  ['/rules', 'urn:rules:integer-past-safe', 'Integers past 2^53', { i: '9007199254740993' }, { error: 'i: integer too large to send exactly' }],
  ['/rules', 'urn:rules:integer-past-safe', 'Integers past 2^53', { g: '9007199254740993' }, { error: 'g: integer too large to send exactly' }],
  ['/rules', 'urn:rules:integer-past-safe', 'Integers past 2^53', { l: '-9007199254740991', g: '2' }, { body: { l: -9007199254740991, g: 2 } }],
  // A default that holds a number reading JSON may have rounded is refused, at any depth and in any
  // field but a double's, which takes the double nearest; JSON given or written as text that holds
  // a number its double would change is refused naming it, and one it holds exactly is sent.
  ...([['number-default', 'Number default past 2^53'], ['integer-default', 'Integer default past 2^53'],
    ['array-default', 'Array default past 2^53'], ['object-default', 'Untyped default past 2^53'], ['fraction-default', 'Number default past a double'],
    ['decimal-default', 'Decimal default past 2^53'], ['decimal-list-default', 'Decimal list default past 2^53'],
    ['inline-default', 'Inline default past 2^53']] as const).map(([rel, title]) =>
    ['/rounding', `urn:round:${rel}`, title, {}, { error: roundedDefault('m') }] as const),
  ['/rounding', 'urn:round:double-default', 'Double default past 2^53', {}, { body: { m: 9007199254740992 } }],
  ['/rounding', 'urn:round:json-text-default', 'JSON text default past 2^53', {}, { error: changedNumber('m', '9007199254740993') }],
  ['/rounding', 'urn:round:object', 'Object given', { m: '{"a":9007199254740993}' }, { error: changedNumber('m', '9007199254740993') }],
  ['/rounding', 'urn:round:object', 'Object given', { m: '{"a":[0.30000000000000000001]}' }, { error: changedNumber('m', '0.30000000000000000001') }],
  ['/rounding', 'urn:round:object', 'Object given', { m: '{"a":9007199254740992,"b":1.0,"c":-1e-7,"d":1e21}' },
    { body: { m: { a: 9007199254740992, b: 1, c: -1e-7, d: 1e21 } } }],
  ['/rounding', 'urn:round:json', 'JSON given', { m: '[9007199254740993]' }, { error: changedNumber('m', '9007199254740993') }],
  ['/rounding', 'urn:round:list', 'Decimal list given', { m: '[1, 0.30000000000000000001]' }, { error: changedNumber('m', '0.30000000000000000001') }],
  ['/rounding', 'urn:round:list', 'Decimal list given', { m: '[1, 2.5]' }, { body: { m: [1, 2.5] } }],
  // An XSD boolean takes its four forms, true, false, 1 and 0, trimmed of space, tab, CR and LF: a
  // value given is read as a default is, so "yes" and "TRUE" are no boolean.
  ...['yes', 'no', 'TRUE', 'False', 'on'].map(b => ['/strict', 'urn:strict:boolean', 'Strict boolean', { b }, { error: 'b must be a boolean' }] as const),
  ['/strict', 'urn:strict:boolean', 'Strict boolean', { b: ' true ' }, { body: { b: true } }],
  ['/strict', 'urn:strict:boolean', 'Strict boolean', { b: '0' }, { body: { b: false } }],
  // A list default that holds no value is named as the default's problem, not as a value given.
  ['/strict', 'urn:strict:blank-list-default', 'Blank list default', {}, { error: 'm: its default holds no values, so it is not sent' }],
  ['/strict', 'urn:strict:inline-blank-list', 'Inline blank list default', {}, { error: 'm: its default holds no values, so it is not sent' }],
  ['/strict', 'urn:strict:inline-blank-list', 'Inline blank list default', { m: 'a\nb' }, { body: { m: ['a', 'b'] } }],
  // A list's check stops at its first bad value, which is the one named, never the next one's too.
  ['/strict', 'urn:strict:list-stop', 'List stops', { m: 'x\n9' }, { error: 'm: not an integer', only: true }],
  ['/strict', 'urn:strict:list-stop', 'List stops', { m: '9\nx' }, { error: 'm: above maxInclusive 5', only: true }],
  ['/strict', 'urn:strict:list-stop', 'List stops', { m: '1\n5' }, { body: { m: [1, 5] } }],
  // A JSON literal's schema is JSON, so a JSON-LD keyword at its top, @type included, keeps the
  // control from being invoked.
  ['/strict', 'urn:strict:literal-type', 'Literal schema type', { m: 'a' }, { error: rootUnchecked('@type') }],
  ['/strict', 'urn:strict:literal-context', 'Literal schema context', { m: 'a' }, { error: rootUnchecked('@context') }],
  // A bound whose number may not be the one the document writes (text with more digits than a
  // double keeps, a JSON integer past 2^53, or a JSON number its document writes with more digits
  // than its double keeps) is not compared, so a value is refused naming it; an entry of such a
  // number matches no value. A bound written exactly is compared, trailing zeros and all.
  ['/inexact', 'urn:inexact:shape', 'Inexact shape', { a: '0.3' }, { error: inexactBound('a', 'sh:minInclusive', '0.30000000000000000001') }],
  ['/inexact', 'urn:inexact:shape', 'Inexact shape', { b: '9007199254740992' }, { error: inexactBound('b', 'sh:minInclusive', '9007199254740993') }],
  ['/inexact', 'urn:inexact:shape', 'Inexact shape', { c: '9007199254740992' }, { error: inexactBound('c', 'sh:minInclusive', '9007199254740993') }],
  ['/inexact', 'urn:inexact:shape', 'Inexact shape', { e: '0.3' }, { error: inexactBound('e', 'sh:maxInclusive', '0.29999999999999999999') }],
  ['/inexact', 'urn:inexact:shape', 'Inexact shape', { n: '0.4' }, { error: inexactBound('n', 'sh:minInclusive', '0.30000000000000000001') }],
  ['/inexact', 'urn:inexact:shape', 'Inexact shape', { h: '0.3' }, { error: roundedEntry('h', '0.30000000000000000001') }],
  ['/inexact', 'urn:inexact:shape', 'Inexact shape', { h: '1' }, { body: { h: 1 } }],
  ['/inexact', 'urn:inexact:has-value', 'Inexact has value', { i: '0.3' }, { error: roundedEntry('i', '0.30000000000000000001') }],
  ['/inexact', 'urn:inexact:shape', 'Inexact shape', { o: '0.6' }, { body: { o: 0.6 } }],
  ['/inexact', 'urn:inexact:shape', 'Inexact shape', { o: '0.4' }, { error: 'o: below minInclusive 0.50000000000000000000' }],
  ['/inexact', 'urn:inexact:schema', 'Inexact schema', { f: '9007199254740992' }, { error: inexactBound('f', 'minimum', '9007199254740993') }],
  ['/inexact', 'urn:inexact:schema', 'Inexact schema', { g: '0.3' }, { error: inexactBound('g', 'minimum', '0.30000000000000000001') }],
  ['/inexact', 'urn:inexact:schema', 'Inexact schema', { j: '0.3' }, { error: roundedEntry('j', '0.30000000000000000001') }],
  ['/inexact', 'urn:inexact:schema', 'Inexact schema', { j: '1' }, { body: { j: 1 } }],
  ['/inexact', 'urn:inexact:schema', 'Inexact schema', { k: '0.3' }, { error: roundedEntry('k', '0.30000000000000000001') }],
  ['/inexact', 'urn:inexact:schema', 'Inexact schema', { l: '0.6' }, { body: { l: 0.6 } }],
  // A number is named as the document writes it, never as the double reading it gave (0 for
  // 1e-400, 9007199254740992 for 9007199254740993, 0.3 for 0.30000000000000000001, null for 1e400).
  ['/written-numbers', 'urn:written:schema', 'Written numbers', { tiny: '1' }, { error: inexactBound('tiny', 'minimum', '1e-400') }],
  ['/written-numbers', 'urn:written:schema', 'Written numbers', { big: '1' }, { error: inexactBound('big', 'maximum', '9007199254740993') }],
  ['/written-numbers', 'urn:written:schema', 'Written numbers', { pick: '2' }, { error: 'pick: must be one of 9007199254740993, 1' }],
  ['/written-numbers', 'urn:written:schema', 'Written numbers', { whole: '{"a":[1]}' }, { error: 'whole: must be {"a":[9007199254740993]}' }],
  ['/written-numbers', 'urn:written:schema', 'Written numbers', { huge: 'y' }, { error: 'huge: must be one of 1e400, x' }],
  ['/written-numbers', 'urn:written:schema', 'Written numbers', { fixed: 'null' }, { error: 'fixed: must be 1e400' }],
  ['/written-numbers', 'urn:written:schema', 'Written numbers', { items: '[1]' },
    { error: inexactBound('items/0', 'minimum', '0.30000000000000000001') }],
  // One node that is a shape's property and a class's supported property is read by each control as its own kind.
  ...(['/shared-node', '/shared-node-swapped'] as const).flatMap(path => [
    [path, 'urn:shared-node:shape', 'Shape write', {}, { body: { shname: 5 } }],
    [path, 'urn:shared-node:shape', 'Shape write', { shname: '7' }, { body: { shname: 7 } }],
    [path, 'urn:shared-node:class', 'Class write', {}, { error: "missing required field 'shname'" }],
    [path, 'urn:shared-node:class', 'Class write', { shname: '7' }, { error: 'shname: is not writable (hydra:writable false), so it is not sent' }],
  ] as const),
  ['/rules', 'urn:rules:tagged-label', 'Language-tagged label', { title: 'x' }, { body: { title: 'x' } }],
  ['/rules', 'urn:rules:array-label', 'Array label', { title: 'x' }, { body: { title: 'x' } }],
];

/** What each client says of a value for an input whose list of allowed values, `list`, is empty. */
const noValue = (name: string, list: string, of = 'shape') => `${name}: its ${of} allows no value (${list} is empty), so it is not sent`;
/** The problem that keeps a control from being invoked whose required input allows no value. */
const requiredNone = (name: string, why: string) => `the input "${name}" is required, but ${why}; this control is not invoked`;
/** The problem that keeps a control from being invoked whose schema writes `key` as no list of schemas. */
const notSchemas = (key: string) => `the input "m" writes ${key} as something other than a list of one or more schemas, which this ` +
  'client does not read, so what it takes is not known; this control is not invoked';

/**
 * Lists given empty, for /empty-lists, read alike by each client as their standards read them:
 *   - an empty sh:in (a list object, an array, rdf:nil, a list of nulls) allows no value, given or
 *     default, in a shape's property, a class's supported property, a list field and a body sent
 *     whole, and so do an empty sh:or, sh:xone and sh:languageIn; an empty sh:and asks nothing;
 *   - an empty enum allows no value at any depth of a schema, while an empty "required" asks
 *     nothing and a const of null allows null alone;
 *   - an input that is required (by sh:minCount, sh:hasValue, hydra:required, a mapping or a
 *     schema's "required") and allows no value, or takes at most 0 values, keeps its control from
 *     being invoked; an optional one given nothing sends nothing;
 *   - allOf, anyOf, oneOf and prefixItems written as no list of one schema or more are a form JSON
 *     Schema does not allow, and keep the control from being invoked;
 *   - an empty sh:property or hydra:supportedProperty gives a control with no input, and a zero
 *     length, bound, count or default is one, never a facet left out.
 */
export const EMPTY_CASES: ReadonlyArray<ValueCase> = [
  ['/empty-lists', 'urn:empty:in-list', 'Empty in list', { status: 'anything' }, { error: noValue('status', 'sh:in') }],
  ['/empty-lists', 'urn:empty:in-list', 'Empty in list', {}, { body: {} }],
  ['/empty-lists', 'urn:empty:in-array', 'Empty in array', { status: 'anything' }, { error: noValue('status', 'sh:in') }],
  ['/empty-lists', 'urn:empty:in-nil', 'Empty in nil', { status: 'anything' }, { error: noValue('status', 'sh:in') }],
  ['/empty-lists', 'urn:empty:in-nil', 'Empty in nil', { status: `${RDF}nil` }, { error: noValue('status', 'sh:in') }],
  ['/empty-lists', 'urn:empty:in-nil-full', 'Empty in full nil', { status: 'anything' }, { error: noValue('status', 'sh:in') }],
  ['/empty-lists', 'urn:empty:in-nulls', 'Empty in of nulls', { status: 'anything' }, { error: noValue('status', 'sh:in') }],
  ['/empty-lists', 'urn:empty:in-default', 'Empty in default', {}, { error: noValue('status', 'sh:in') }],
  ['/empty-lists', 'urn:empty:in-required', 'Empty in required', {}, { error: requiredNone('status', 'its shape allows no value (sh:in is empty)') }],
  ['/empty-lists', 'urn:empty:in-required', 'Empty in required', { status: 'a' },
    { error: requiredNone('status', 'its shape allows no value (sh:in is empty)') }],
  ['/empty-lists', 'urn:empty:in-has-value', 'Empty in has value', { status: 'a' },
    { error: requiredNone('status', 'its shape allows no value (sh:in is empty)') }],
  ['/empty-lists', 'urn:empty:in-many', 'Empty in list field', { status: 'a' }, { error: noValue('status', 'sh:in') }],
  ['/empty-lists', 'urn:empty:in-integer', 'Empty in integer', { status: '1' }, { error: noValue('status', 'sh:in') }],
  ['/empty-lists', 'urn:empty:in-body', 'Empty in body', { body: 'a' }, { error: requiredNone('body', 'its shape allows no value (sh:in is empty)') }],
  ['/empty-lists', 'urn:empty:in-class', 'Empty in class', { status: 'a' }, { error: noValue('status', 'sh:in') }],
  ['/empty-lists', 'urn:empty:in-class', 'Empty in class', {}, { body: {} }],
  ['/empty-lists', 'urn:empty:in-class-required', 'Empty in required class', {},
    { error: requiredNone('status', 'its shape allows no value (sh:in is empty)') }],
  ['/empty-lists', 'urn:empty:in-mapped', 'Empty in mapped required', {}, { error: requiredNone('status', 'its shape allows no value (sh:in is empty)') }],
  ['/empty-lists', 'urn:empty:or-list', 'Empty or', { status: 'x' }, { error: noValue('status', 'sh:or') }],
  ['/empty-lists', 'urn:empty:or-array', 'Empty or array', { status: 'x' }, { error: noValue('status', 'sh:or') }],
  ['/empty-lists', 'urn:empty:xone-array', 'Empty xone', { status: 'x' }, { error: noValue('status', 'sh:xone') }],
  ['/empty-lists', 'urn:empty:language-array', 'Empty languageIn', { status: 'x' }, { error: noValue('status', 'sh:languageIn') }],
  ['/empty-lists', 'urn:empty:language-nil', 'Empty languageIn nil', { status: 'x' }, { error: noValue('status', 'sh:languageIn') }],
  ['/empty-lists', 'urn:empty:or-required', 'Empty or required', {}, { error: requiredNone('status', 'its shape allows no value (sh:or is empty)') }],
  ['/empty-lists', 'urn:empty:and-list', 'Empty and', { status: 'x' }, { body: { status: 'x' } }],
  ['/empty-lists', 'urn:empty:and-nil', 'Empty and nil', { status: 'x' }, { body: { status: 'x' } }],
  ['/empty-lists', 'urn:empty:node-or', 'Shape empty or', { status: 'x' },
    { error: 'the shape names sh:or, which this client does not check, so what it sends is not known; this control is not invoked' }],
  ['/empty-lists', 'urn:empty:node-and', 'Shape empty and', { status: 'x' }, { body: { status: 'x' } }],
  ['/empty-lists', 'urn:empty:zero-required', 'Required none', {}, { error: requiredNone('status', 'it takes at most 0 values') }],
  ['/empty-lists', 'urn:empty:property-array', 'No properties listed', {}, { body: {} }],
  ['/empty-lists', 'urn:empty:supported-array', 'No supported properties listed', {}, { body: {} }],
  ['/empty-lists', 'urn:empty:max-length-zero', 'Length zero', { status: 'x' }, { error: 'status: longer than maxLength 0' }],
  ['/empty-lists', 'urn:empty:max-zero', 'Bound zero', { status: '1' }, { error: 'status: above maxInclusive 0' }],
  ['/empty-lists', 'urn:empty:default-zero', 'Default zero', {}, { body: { status: 0 } }],
  ['/empty-lists', 'urn:empty:enum', 'Empty enum', { m: 'x' }, { error: noValue('m', 'enum', 'schema') }],
  ['/empty-lists', 'urn:empty:enum', 'Empty enum', {}, { body: {} }],
  ['/empty-lists', 'urn:empty:enum-default', 'Empty enum default', {}, { error: noValue('m', 'enum', 'schema') }],
  ['/empty-lists', 'urn:empty:enum-required', 'Empty enum required', {}, { error: requiredNone('m', 'its schema allows no value (enum is empty)') }],
  ['/empty-lists', 'urn:empty:enum-items', 'Empty enum items', { m: '["x"]' }, { error: noValue('m/0', 'enum', 'schema') }],
  ['/empty-lists', 'urn:empty:enum-items', 'Empty enum items', { m: '[]' }, { body: { m: [] } }],
  ['/empty-lists', 'urn:empty:enum-variable', 'Empty enum variable', {}, { error: requiredNone('q', 'its schema allows no value (enum is empty)') }],
  ['/empty-lists', 'urn:empty:const-null', 'Const null', { m: 'x' }, { error: 'm: must be null' }],
  ['/empty-lists', 'urn:empty:const-null', 'Const null', { m: 'null' }, { body: { m: null } }],
  ['/empty-lists', 'urn:empty:required-none', 'None required', { m: 'x' }, { body: { m: 'x' } }],
  ['/empty-lists', 'urn:empty:any-of', 'Empty anyOf', {}, { error: notSchemas('anyOf') }],
  ['/empty-lists', 'urn:empty:one-of', 'Object oneOf', {}, { error: notSchemas('oneOf') }],
  ['/empty-lists', 'urn:empty:all-of', 'Empty allOf items', {}, { error: notSchemas('items/allOf') }],
  ['/empty-lists', 'urn:empty:prefix-items', 'Empty prefixItems', {}, { error: notSchemas('prefixItems') }],
  ['/empty-lists', 'urn:empty:zeros', 'Schema zeros', {}, { body: { n: 0 } }],
  ['/empty-lists', 'urn:empty:zeros', 'Schema zeros', { n: '1' }, { error: 'n: above maxInclusive 0' }],
  ['/empty-lists', 'urn:empty:zeros', 'Schema zeros', { s: 'x' }, { error: 's: longer than maxLength 0' }],
  ['/empty-lists', 'urn:empty:zeros', 'Schema zeros', { a: '[1]' }, { error: 'a: takes at most 0 values, got 1' }],
];

/**
 * Controls each client shows a warning with, as [path, the name that invokes it, title, the
 * warning]: hydra:expects names a shape the document does not describe, so the fields written in
 * place, if any, are all that is known of what the server expects; or one it describes with no
 * input fields (a shape with no properties, a class with no supported property), which is said so.
 */
export const WARNING_CASES: ReadonlyArray<readonly [path: string, rel: string, title: string, warning: string]> = [
  ['/rules', 'urn:rules:empty-shape', 'Empty shape', 'hydra:expects names urn:shape:Empty, which this document describes with no input ' +
    'fields, so no input fields were built: what the server expects is not known here.'],
  ['/rules', 'urn:rules:empty-class', 'Empty class', 'hydra:expects names urn:class:Empty, which this document describes with no input ' +
    'fields, so no input fields were built: what the server expects is not known here.'],
  ['/rules', 'urn:rules:inline-outside', 'Inline beside an outside shape', 'hydra:expects names https://vocab.example/Outside, which this ' +
    'document does not describe, so only the input fields written in place were built: what else the server expects is not known here.'],
  ['/rules-md', 'hm-expects', 'Block expects', 'hydra:expects names urn:shape:Outside, which this document does not describe, so only the ' +
    'input fields written in place were built: what else the server expects is not known here.'],
  ['/rules-md', 'hm-expects-none', 'Block expects, no fields', 'hydra:expects names urn:shape:Outside, which this document does not ' +
    'describe, so no input fields were built: what the server expects is not known here.'],
];

/**
 * Texts for each XSD 1.1 date and time datatype on /temporal, as [datatype, text, whether it is a
 * value of it], read alike by both clients: a value is sent as typed, and any other text is refused
 * as "<datatype>: not an xsd:<datatype>". Leap days by the proleptic Gregorian rule (2000 and 0000
 * are leap years, 1900 is not), 24:00:00 and nothing past it, timezones to 14:00, years of four
 * digits or more, ASCII digits only, and durations with their parts in order.
 */
export const TEMPORAL_CASES: ReadonlyArray<readonly [type: (typeof TEMPORAL_TYPES)[number], text: string, ok: boolean]> = [
  ...([['2024-02-29', true], ['2023-02-29', false], ['1900-02-29', false], ['2000-02-29', true], ['0000-02-29', true], ['-0001-01-01', true],
    ['12024-01-01', true], ['02024-01-01', false], ['024-01-01', false], ['2024-1-01', false], ['2024-13-01', false], ['2024-00-10', false],
    ['2024-04-31', false], ['2024-04-30', true], ['2024-01-01Z', true], ['2024-01-01+14:00', true], ['2024-01-01+14:01', false],
    ['2024-01-01-13:59', true], ['2024-01-01+15:00', false], ['2024-01-01+05:60', false], ['2024-01-01 ', false], [' 2024-01-01', false],
    ['2024-01-01T00:00:00', false], ['+2024-01-01', false], ['2024-01-01z', false], ['\uff12\uff10\uff12\uff14-01-01', false],
    ['2024-01-01+0100', false], ['', false]] as const).map(([text, ok]) => ['date', text, ok] as const),
  ...([['2024-01-01T00:00:00', true], ['2024-01-01T24:00:00', true], ['2024-01-01T24:00:00.000', true], ['2024-01-01T24:00:01', false],
    ['2024-01-01T24:00:00.1', false], ['2024-01-01T23:59:60', false], ['2024-01-01T23:59:59.999999999Z', true], ['2024-01-01T12:00:00.', false],
    ['2024-01-01T12:00', false], ['2024-01-01t12:00:00', false], ['2024-02-30T00:00:00', false], ['2024-01-01T25:00:00', false],
    ['2024-01-01T12:60:00', false], ['2024-01-01T12:00:00-14:00', true], ['2024-01-01T1:00:00', false]] as const)
    .map(([text, ok]) => ['dateTime', text, ok] as const),
  ...([['2024-01-01T00:00:00Z', true], ['2024-01-01T00:00:00', false], ['2024-01-01T00:00:00+01:00', true]] as const)
    .map(([text, ok]) => ['dateTimeStamp', text, ok] as const),
  ...([['00:00:00', true], ['24:00:00', true], ['23:59:59.5+01:00', true], ['24:30:00', false], ['1:00:00', false], ['12:00:00Z', true],
    ['12:00:00+14:30', false], ['12:00:00.5.5', false]] as const).map(([text, ok]) => ['time', text, ok] as const),
  ...([['2024', true], ['-2024', true], ['0000', true], ['24', false], ['2024Z', true], ['02024', false], ['20240', true], ['2024-', false]] as const)
    .map(([text, ok]) => ['gYear', text, ok] as const),
  ...([['2024-02', true], ['2024-13', false], ['2024-2', false], ['2024-02Z', true], ['-0044-03', true]] as const)
    .map(([text, ok]) => ['gYearMonth', text, ok] as const),
  ...([['--02', true], ['--13', false], ['--02--', false], ['--00', false], ['--12Z', true], ['---02', false]] as const)
    .map(([text, ok]) => ['gMonth', text, ok] as const),
  ...([['---31', true], ['---32', false], ['---00', false], ['---01+01:00', true], ['--31', false]] as const)
    .map(([text, ok]) => ['gDay', text, ok] as const),
  ...([['--02-29', true], ['--02-30', false], ['--04-31', false], ['--04-30', true], ['--12-31Z', true], ['--1-01', false]] as const)
    .map(([text, ok]) => ['gMonthDay', text, ok] as const),
  ...([['P1Y', true], ['P1Y2M3DT4H5M6.7S', true], ['-P1D', true], ['PT1H', true], ['P', false], ['PT', false], ['P1DT', false],
    ['P1S', false], ['PT1.5S', true], ['PT1.S', false], ['PT.5S', false], ['P1.5Y', false], ['P1M1Y', false], ['P1Y1Y', false],
    ['p1Y', false], ['+P1D', false], ['PT1M', true], ['P1M', true], ['P0Y', true], ['PT36H', true], ['P1W', false], ['P1DT1H1M1S1H', false],
    ['PT1H1D', false]] as const).map(([text, ok]) => ['duration', text, ok] as const),
  ...([['P1Y2M', true], ['P1Y', true], ['P2M', true], ['P1D', false], ['P1YT1H', false], ['-P1Y', true]] as const)
    .map(([text, ok]) => ['yearMonthDuration', text, ok] as const),
  ...([['P1D', true], ['PT1H', true], ['P1DT2H3M4.5S', true], ['P1Y', false], ['P1M', false], ['P1M1D', false], ['-PT1S', true]] as const)
    .map(([text, ok]) => ['dayTimeDuration', text, ok] as const),
];

/**
 * Confirmed writes whose body each client sends as the page's JSON.stringify(values, null, 2) writes
 * it, byte for byte, as [path, action, title, fields, the body sent]: each number as JavaScript
 * writes it (1.0 as 1, 1e-7 and 0.000001 as they are, -0 as 0, and 2^53 and a 20-digit integer its
 * double holds as each double's shortest text) and an object's array-index keys first, in numeric
 * order. A number its double would change is refused rather than sent (RULE_CASES).
 */
export const BODY_TEXTS: ReadonlyArray<readonly [path: string, action: string, title: string, fields: Record<string, string>, body: string]> = [
  ['/values', 'urn:values:object', 'Object value', { document: '{"b":1.0,"a":1e-7,"c":-0.0,"2":[1E2,{}],"1":12345678901234567000,"d":[]}' },
    '{\n  "document": {\n    "1": 12345678901234567000,\n    "2": [\n      100,\n      {}\n    ],\n    "b": 1,\n    "a": 1e-7,\n' +
    '    "c": 0,\n    "d": []\n  }\n}'],
  ['/values', 'urn:values:json', 'JSON value', { data: '[0.000001,1e21,-1e-7,9007199254740992]' },
    '{\n  "data": [\n    0.000001,\n    1e+21,\n    -1e-7,\n    9007199254740992\n  ]\n}'],
  // A required input the form leaves empty, since it cannot hold its default, does not stop the
  // form: the default itself is sent, as hmc.py sends it.
  ['/values', 'urn:values:required-crlf', 'Required CRLF default', {}, '{\n  "memo": "a\\r\\nb"\n}'],
  // A decimal or a double past 2^53 is sent as JavaScript writes its double, never as the double's
  // exact integer: given, as a default and as a list default's item alike.
  ['/big-numbers', 'urn:big:schema', 'Big schema number', { amount: '123456789012345680000' }, '{\n  "amount": 123456789012345680000\n}'],
  ['/big-numbers', 'urn:big:decimal', 'Big decimal', { amount: '123456789012345680000' }, '{\n  "amount": 123456789012345680000\n}'],
  ['/big-numbers', 'urn:big:double-default', 'Big double default', {}, '{\n  "m": 123456789012345680000\n}'],
  ['/big-numbers', 'urn:big:double-default', 'Big double default', { m: '123456789012345678901' }, '{\n  "m": 123456789012345680000\n}'],
  ['/big-numbers', 'urn:big:double-list', 'Big double list', {}, '{\n  "m": [\n    123456789012345680000\n  ]\n}'],
];

/** A field name of 10 KB, so that a problem named once for each bad value of a list would cost its length again and again. */
const LONG_NAME = 'n'.repeat(10240);

/**
 * Documents of a few hundred kilobytes whose shape once made both clients' work grow as the product
 * of two of their sizes, with the control each test opens. Before, each took the page 7 to 15 s and
 * hmc.py 5 to 7 s or more; each now takes a small part of the tests' 3 s budget. Each case names
 * the number of controls the document lists and of fields its control has.
 *   - harvest: 1,500 nodes that each name one node holding 1,500 operations, which every naming node
 *     walked again (the named node is listed too, since each node names it as an affordance);
 *   - shape: 400 controls whose hydra:expects all name one 400-property shape, whose fields every
 *     control built;
 *   - template: 400 controls sharing one IRI template of 400 mappings, which every control read and
 *     joined to its fields, each mapping searching all the fields before it;
 *   - mappings: one control whose template has 8,000 mappings, each searching the fields before it;
 *   - class: 1,500 nodes that each name one hydra:Class with 1,500 operations, which every naming
 *     node listed again;
 *   - items: a list default of 50,000 values each checked against an items enum of 50,000 entries,
 *     each value compared with every entry, and items-refused, the same with no value an entry,
 *     whose problems each named every entry; and shape-list, a SHACL list default of 5,000 values
 *     checked against an sh:in of 5,000, whose choices were rebuilt for every value;
 *   - property-named: 100 controls whose shape names one property node 1,000 times, with a
 *     100-character name and a 1,000-character description: each name was read as its own field,
 *     and hmc.py's list --json wrote 168 MB for 34 KB; property-default, one control whose shape
 *     names one node 2,000 times, with a 10 KB description and default: describe wrote 41 MB, of a
 *     control refused for two fields of one name (shape, above, is the third: list --json wrote
 *     each control's copy of the 400 fields they share);
 *   - has-value-list: a decimal list default of 8,000 values and a 300,000-digit sh:hasValue, read
 *     again for each value (9 s in each client), and bound-list and bound-list-refused, 4,000
 *     values and a 150,000-character bound (written exactly, its trailing zeros a double drops), read
 *     again for each value, and in bound-list-refused named in a problem for each;
 *   - template-schemas: 1,000 controls, each with a JSON Schema of its own, sharing an IRI template
 *     of 1,000 mappings, and template-own the same with a property of its own name in each schema:
 *     each control built and wrote the 1,000 mapping fields again (list --json: 540 MB for 252 KB);
 *     template-matched and template-typed, the same with a property one mapping matches, or an
 *     additionalProperties that types the variables, in each, which list builds for so many controls
 *     as the document's size allows and lists the rest without their fields;
 *   - property-shared: 1,000 controls whose shapes, written in place, name one property node with a
 *     100,000-character description and default, and property-shapes the same with 1,000 shapes the
 *     document describes: list --json wrote the node's field once for each (201 MB for 402 KB);
 *   - list-shared: 1,000 controls whose shapes, written in place, each have a property whose sh:in is
 *     one RDF list of 1,000 nodes, which list --json wrote once for each (38 MB for 368 KB);
 *   - list-stop: a double list default of 10,000 values past 2^53, each matching only the sh:in entry
 *     it names, of a field with a 10 KB name: a check that named each bad value, not the first,
 *     would write 100 MB of problems, each naming another entry.
 *   - const-many: one input whose enum of 30,000 empty objects is filtered by a const of 30,000 keys,
 *     each entry compared with the const again, which counted the const's keys each time.
 * A case that names a problem is refused on its dry run, naming it alone; the others' dry runs plan.
 */
export const COST_CASES: ReadonlyArray<readonly [path: string, rel: string, controls: number, fields: number, refused: string | null]> = [
  ['/cost/harvest', 'urn:op5', 1501, 0, null], ['/cost/shape', 'urn:c399', 400, 400, null], ['/cost/template', 'urn:c399', 400, 400, null],
  ['/cost/mappings', 'urn:c', 1, 8000, null], ['/cost/class', 'urn:op5', 1500, 0, null], ['/cost/items', 'urn:items', 1, 1, null],
  ['/cost/items-refused', 'urn:items', 1, 1, 'm/0: must be one of e0, e1, e2, '], ['/cost/shape-list', 'urn:list', 1, 1, 'm: must be one of e0, e1, e2, '],
  ['/cost/property-named', 'urn:c99', 100, 1, null], ['/cost/property-default', 'urn:c', 1, 1, null],
  ['/cost/has-value-list', 'urn:list', 1, 1, 'm: must include 0.111'], ['/cost/bound-list', 'urn:list', 1, 1, null],
  ['/cost/bound-list-refused', 'urn:list', 1, 1, 'm: above maxInclusive 0.4000'],
  ['/cost/template-schemas', 'urn:c999', 1000, 1001, null], ['/cost/template-own', 'urn:c999', 1000, 1001, null],
  ['/cost/template-matched', 'urn:c999', 1000, 1000, null], ['/cost/template-typed', 'urn:c999', 1000, 1001, null],
  ['/cost/property-shared', 'urn:c999', 1000, 1, null], ['/cost/property-shapes', 'urn:c999', 1000, 1, null],
  ['/cost/list-shared', 'urn:c999', 1000, 1, null], ['/cost/list-stop', 'urn:list', 1, 1, `${LONG_NAME}: matches only 9007199254740994`],
  ['/cost/const-many', 'urn:c', 1, 1, null],
];

/** What a document whose IRIs, expanded, come to far more text than the document holds is refused with. */
export const EXPANSION_PROBLEM = "This document's prefixes, terms, @vocab and @base expand its IRIs to far more text than the document " +
  'holds, which this client does not read, so it is not read.';
/**
 * Documents of a few hundred kilobytes whose prefix, @vocab or @base, written once and long, expands
 * thousands of short IRIs, as [path, a control's name]: each IRI was its expansion's length, so one
 * long prefix made a 493 KB document cost hmc.py's list --json 602 MB, and the page its heap. Each
 * client counts the text that prefixes, terms, @vocab and @base expand to as it reads a document,
 * and refuses the document whole once that passes a few times the document's own length.
 *   - prefix-controls: 3,000 controls whose action and target are compact IRIs of one 100,000-
 *     character prefix;
 *   - prefix-shape: one control whose shape has 3,000 properties, each with a path of one 100,000-
 *     character prefix;
 *   - prefix-keys: one node with 3,000 keys of one 100,000-character prefix;
 *   - vocab-types: 3,000 nodes typed by a term @vocab, 100,000 characters long, expands;
 *   - base-ids: 3,000 nodes whose relative @id a 100,000-character @base resolves.
 */
export const EXPANSION_CASES: ReadonlyArray<readonly [path: string, rel: string]> = [
  ['/cost/prefix-controls', 'p:c0'], ['/cost/prefix-shape', 'urn:c'], ['/cost/prefix-keys', 'urn:c'], ['/cost/vocab-types', 'urn:c'],
  ['/cost/base-ids', 'urn:c'],
];

/**
 * Turtle that hmc.py hands to rdflib, which expands each prefixed name and relative IRI as it
 * parses, before this client reads a byte of what it writes, as [path, the Turtle, what hmc.py is
 * refused with]. hmc.py charges what rdflib would make of it first, against the budgets JSON-LD's
 * IRIs and each step's work count against, so each is refused by name, whether rdflib is installed
 * or not. With rdflib 7.6, prefix-controls took 1.77 GB at 3,000 controls and ended in an unnamed
 * MemoryError, and a list of 100,000 numbers took 340 MB and 6 s.
 *   - prefix-controls, prefix-targets: 3,000 controls whose action, or target, is a prefixed name
 *     of one 100,000-character prefix;
 *   - base-ids: 3,000 controls whose relative IRIs a 100,000-character @base resolves;
 *   - prefix-chain: a prefix declared 4,000 times, each time as itself and ten more characters;
 *   - list: one list of 100,000 numbers, each of which rdflib makes a node and two triples of.
 */
export function turtleCostCases(): ReadonlyArray<readonly [path: string, turtle: string, problem: string]> {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  const head = `@prefix iep: <${IEP}> .\n@prefix hydra: <${HYDRA}> .\n`;
  const long = `https://x.example/${'a'.repeat(100000)}/`;
  const controls = (action: (i: number) => string, target: (i: number) => string) => range(3000).map(i =>
    `<#c${i}> a iep:Affordance ; iep:action ${action(i)} ; hydra:method "GET" ; hydra:target ${target(i)} .\n`).join('');
  const list = `<#s> <#p> (${' 1'.repeat(100000)} ) .\n`;
  return [
    ['/ttl/prefix-controls', `@prefix p: <${long}> .\n${head}${controls(i => `p:c${i}`, () => '</api>')}`, EXPANSION_PROBLEM],
    ['/ttl/prefix-targets', `@prefix p: <${long}> .\n${head}${controls(i => `<urn:c${i}>`, i => `p:t${i}`)}`, EXPANSION_PROBLEM],
    ['/ttl/base-ids', `@base <${long}> .\n${head}${controls(i => `<urn:c${i}>`, i => `<t${i}>`)}`, EXPANSION_PROBLEM],
    ['/ttl/prefix-chain', `@prefix p: <https://x.example/> .\n${'@prefix p: p:aaaaaaaaaa .\n'.repeat(4000)}${head}<#c> a iep:Affordance .\n`,
      EXPANSION_PROBLEM],
    ['/ttl/list', `${head}${list}`, workProblem(Buffer.byteLength(`${head}${list}`))],
  ];
}

/**
 * Documents of a few dozen kilobytes in which one list of choices, or one default, description or
 * pattern, serves many inputs, which the form would offer and a check would name once for each, as
 * [path, the control's name, the problem that keeps it from being invoked]. Before, 400 inputs
 * sharing an enum of 400 entries took the page 7 s to select, and 300 sharing an RDF list of 300
 * 4 s; each is now refused within the tests' budget.
 *   - shared-schema: 400 template variables that additionalProperties types, with an enum of 400;
 *   - shared-list: 300 properties whose sh:in is one RDF list of 300 nodes;
 *   - shared-tail: 300 RDF lists that each share a tail of 300 nodes, read as their own;
 *   - shared-default, shared-description and shared-pattern: 400 template variables that
 *     additionalProperties types, with a default, a description or a pattern of 10,000 characters,
 *     which each input would show (and the default send): a 23 KB document planned a 4 MB address,
 *     in 21 s on the page.
 */
export const SHARED_COST_CASES: ReadonlyArray<readonly [path: string, rel: string, problem: string]> = [
  ['/cost/shared-schema', 'urn:shared-schema', 'the inputs "v0" and "v1" share the choices of additionalProperties, which this client would ' +
    "show and check once for each, at a cost the document's size does not bound; this control is not invoked"],
  ['/cost/shared-list', 'urn:shared-list', 'the inputs "p0" and "p1" share one sh:in list, which this client would show and check once for ' +
    "each, at a cost the document's size does not bound; this control is not invoked"],
  ['/cost/shared-tail', 'urn:shared-list', 'the input "p1" writes sh:in as an RDF list that shares nodes with another list, which this ' +
    'client does not read, so what it takes is not known; this control is not invoked'],
  ['/cost/shared-default', 'urn:shared-schema', 'the inputs "v0" and "v1" share the default of additionalProperties, which this client ' +
    "would show, check and send once for each, at a cost the document's size does not bound; this control is not invoked"],
  ['/cost/shared-description', 'urn:shared-schema', 'the inputs "v0" and "v1" share the description of additionalProperties, which this ' +
    "client would show once for each, at a cost the document's size does not bound; this control is not invoked"],
  ['/cost/shared-pattern', 'urn:shared-schema', 'the inputs "v0" and "v1" share the pattern of additionalProperties, which this client ' +
    "would show once for each, at a cost the document's size does not bound; this control is not invoked"],
];

/**
 * The work each client may do for one thing a person asks of it (read a document, list it, open
 * or describe a control, check the values given and build the request), in units: a unit is a
 * UTF-16 code unit of text expanded, shown or built, or a fixed share of a field or control. A
 * document of n bytes allows WORK_PER_BYTE * n of them, and at least WORK_FLOOR; a request also
 * allows WORK_PER_BYTE units for each byte of the values it sends, as JSON writes them.
 */
export const WORK_PER_BYTE = 64;
export const WORK_FLOOR = 2_000_000;
/** What a client refuses a document or a control with once its work passes what `bytes` allows. */
export const workProblem = (bytes: number) => `This document asks for more work than its size allows ` +
  `(${Math.max(WORK_FLOOR, WORK_PER_BYTE * bytes)} units for ${bytes} bytes); nothing was sent.`;
/** The name of the variable /work/expr-explode explodes: 20,000 characters. */
const LONG_VARIABLE = 'v'.repeat(20000);
/** Where a document's work is refused: see WORK_CASES. */
export type WorkStep = 'read' | 'list' | 'list --json' | 'control' | 'request';
/**
 * Documents that made either client do or write far more than their size, and one large honest
 * document, as [path, a control's name, where each client refuses it by name (workProblem), what
 * that control's dry run is refused with otherwise (null: it plans), the values its request sends,
 * which a refused request's bytes count]. Where:
 *   - read: both refuse the document whole as they read it: list, list --json, describe, invoke
 *     and the page's link alike;
 *   - list, list --json: hmc.py's list, or list --json, refuses it, which writes for every control
 *     what the page's list does not show; the page lists it;
 *   - control: opening the control is refused: the page shows no form, describe writes no fields,
 *     and either's dry run sends nothing;
 *   - request: building the control's request is refused: either's dry run sends nothing.
 * Each was written up by a review, but request-repeat:
 *   - comment-shared: 2,000 supported properties with no description of their own whose
 *     hydra:property has a 30,000-character rdfs:comment, which each field took (describe wrote
 *     61 MB for 148 KB);
 *   - template-text: 2,000 controls whose target is one 50,000-character IRI template, which list
 *     wrote once for each;
 *   - template-conflict: 2,000 controls each with two targets, 25,000-character templates, which
 *     the problem that keeps each from being invoked quoted;
 *   - name-shared: 2,000 controls expecting one shape whose two properties share a 50,000-character
 *     sh:name, which the problem each control is refused with quotes, and list wrote once for each;
 *   - joined: 2,500 controls, each with a JSON Schema of its own, sharing a template of 2,500
 *     mappings: list copied the template's fields into each control's (1.3 GB for 2 MB at 12,000);
 *   - template-repeat: one template that writes its one variable 20,000 times, whose default is
 *     5,000 characters: its dry run planned a 100 MB address (12 s);
 *   - expr-repeat: one expression that names its one variable 20,000 times, whose default is
 *     50,000 characters, which each client expanded whole before charging it (1 GB);
 *   - expr-explode: one exploded variable whose name is 20,000 characters and whose default is
 *     a list of 50,000 values, which writes the name once for each value (1 GB);
 *   - honest: 300 controls, each with its own shape of ten properties, which every step reads;
 *   - mcp-indented: a write with no transport but MCP whose JSON default holds 40 arrays nested
 *     240 deep, which the page's dry run showed indented, twice, as the MCP call's payload (10 MB
 *     for 20 KB), and hmc.py's list --json and describe wrote indented (4.8 MB). Each still plans,
 *     and what each writes of its own as JSON is indented only within what its size allows.
 * And sharedNodeDocuments', in which many controls, inputs or mappings name one node by reference, a
 * node of thousands of keys or values (SHARED_NODE_SIZES), which each client read again for each
 * that names it: before, the page's list took 8 to 27 s, past its budget, and hmc.py's 5 to 25 s.
 * Each now reads the node, and reading its values for a property, once, and each that names it
 * costs a constant. The first three are the review's; the rest are each other place the same read
 * was made, found by looking for it:
 *   - hint-shared, hint-string, hint-list: 3,000 reads whose annotations name one read-only node of
 *     3,000 keys, by an object, by a string under a term typed @id, or 3,000 times in one @list:
 *     each control scanned every key for hints. Listed, each a safe read, since an honest document
 *     may share one annotation node: its hints are read, and charged, once;
 *   - target-keys, target-types, search-keys: 1,000 reads whose hydra:target names one node of
 *     12,000 keys or of 18,000 types, and 2,000 whose hydra:search names one of 4,500 keys, each
 *     read in full to see whether it is a template; listed. A thousand uses keep the page's
 *     ordinary cost of its controls well within the time allowed;
 *   - mapping-keys: a template of 3,000 mappings that all name one mapping node of 3,000 keys,
 *     read in full for each; listed;
 *   - property-keys: 1,500 shapes, one for each write, that name one property node of 3,000 keys,
 *     whose field the page built again for each shape (hmc.py built it once); listed;
 *   - supported-keys, range-values, comment-values: 1,000 supported properties naming one
 *     hydra:property node of 20,000 keys, 20,000 rdfs:range values, or 20,000 rdfs:comment values
 *     before the one it reads, read for each; refused, as two inputs that fill one property;
 *   - node-notes: 3,000 properties whose sh:node names one shape of 20,000 notes, each read to see
 *     whether it constrains anything; listed, with 3,000 inputs;
 *   - path-keys: 1,000 properties whose sh:path names one node of 9,000 keys, read to see whether
 *     it is a complex path; refused, as two inputs of one path;
 *   - list-keys: 3,000 properties whose sh:in names one list node of 12,000 keys; refused, as one
 *     list two inputs share (SHARED_COST_CASES' shared-list);
 *   - closed-ignored: 1,500 writes whose template's variable joins one closed shape with 3,000
 *     sh:ignoredProperties, read again for each by hmc.py's list; listed;
 *   - closed-shared: 1,500 writes, each expecting a closed shape of its own, whose
 *     sh:ignoredProperties all name one RDF list of 5,000 members: each shape made a set of the
 *     whole list's text again, which hmc.py's list did for every control (820 MB, past the 512 MB
 *     it is given); listed;
 *   - mapping-values: a template of 6,000 mappings that name one mapping node of 24,000
 *     hydra:variable values, read for each; listed;
 *   - property-values: 1,500 shapes that name one property node of 6,000 values for each facet,
 *     read again for each shape by the page; listed;
 *   - default-rounded: 1,500 shapes that name one property node whose default is 30,000 numbers,
 *     in a document with a number its double rounds, each searched for a rounded number again for
 *     each shape; listed;
 *   - range-distinct, mapping-distinct: as range-values and mapping-values, with every value
 *     distinct, so that each that names the node is refused naming all of them: their problems
 *     grow as the product (hmc.py took 177 MB), and each is charged as it is written, so the
 *     document is refused whole as it is read.
 */
export const WORK_CASES: ReadonlyArray<readonly [path: string, rel: string, refused: readonly WorkStep[], dryRun: string | null,
  sent: Record<string, unknown> | null]> = [
  ['/work/comment-shared', 'urn:c', ['control', 'list --json'], null, null],
  ['/work/template-text', 'urn:c0', ['read'], null, null],
  ['/work/template-conflict', 'urn:c0', ['read'], null, null],
  ['/work/name-shared', 'urn:c0', ['list', 'list --json'], `two input fields are both named '${'n'.repeat(50000)}'`, null],
  ['/work/joined', 'urn:c2499', ['list', 'list --json'], null, null],
  ['/work/template-repeat', 'urn:c', ['request'], null, { q: 'x'.repeat(5000) }],
  ['/work/expr-repeat', 'urn:c', ['request'], null, { q: 'x'.repeat(50000) }],
  ['/work/expr-explode', 'urn:c', ['request'], null, { [LONG_VARIABLE]: Array(50000).fill('x') }],
  ['/work/honest', 'urn:c299', [], null, null],
  ['/work/hint-shared', 'urn:c2999', [], null, null],
  ['/work/hint-string', 'urn:c2999', [], null, null],
  ['/work/hint-list', 'urn:c0', [], null, null],
  ['/work/target-keys', 'urn:c999', [], null, null],
  ['/work/target-types', 'urn:c999', [], null, null],
  ['/work/search-keys', 'urn:c1999', [], null, null],
  ['/work/mapping-keys', 'urn:c0', [], null, null],
  ['/work/property-keys', 'urn:c1499', [], null, null],
  ['/work/supported-keys', 'urn:c0', [], "the input fields 'f0' and 'f1' both take a value named 'p'", null],
  ['/work/node-notes', 'urn:c0', [], null, null],
  ['/work/path-keys', 'urn:c0', [], "the input fields 'f0' and 'f1' both take a value named 'path'", null],
  ['/work/list-keys', 'urn:c0', [], 'the inputs "f0" and "f1" share one sh:in list', null],
  ['/work/closed-ignored', 'urn:c1499', [], null, null],
  ['/work/range-values', 'urn:c0', [], "the input fields 'f0' and 'f1' both take a value named 'p'", null],
  ['/work/comment-values', 'urn:c0', [], "the input fields 'f0' and 'f1' both take a value named 'p'", null],
  ['/work/mapping-values', 'urn:c0', [], null, null],
  ['/work/property-values', 'urn:c1499', [], null, null],
  ['/work/default-rounded', 'urn:c1499', [], null, null],
  ['/work/range-distinct', 'urn:c0', ['read'], null, null],
  ['/work/mapping-distinct', 'urn:c0', ['read'], null, null],
  ['/work/closed-shared', 'urn:c1499', [], null, null],
  ['/work/mcp-indented', 'urn:c', [], null, null],
];

/** Each COST_CASES path's document as the text served; build it once per test file. */
export function costDescriptors(base: string): Record<string, string> {
  const get = (rel: string, title: string, extra: Record<string, unknown> = {}) =>
    ({ 'iep:action': { '@id': rel }, 'hydra:method': 'GET', 'hydra:title': title, 'hydra:target': { '@id': `${base}/api` }, ...extra });
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  const props = (n: number) => range(n).map(j => ({ 'sh:path': { '@id': `urn:p${j}` }, 'sh:name': `p${j}`, 'sh:maxCount': 1 }));
  // A write whose shape's properties take the sh:in each of `heads` names, beside an RDF list of 300 nodes, #L0 to #L299.
  const listShape = (path: string, heads: unknown[], more: unknown[]) => ({ '@context': CTX, '@id': `${base}${path}`,
    'iep:affordance': [{ '@id': '#l', '@type': 'iep:Affordance', 'iep:action': { '@id': 'urn:shared-list' }, 'hydra:method': 'POST',
      'hydra:title': 'Shared list', 'hydra:target': { '@id': `${base}/api` }, 'hydra:expects': { '@id': '#S' } }],
    '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': heads.map((head, j) =>
      ({ 'sh:path': { '@id': `urn:p${j}` }, 'sh:name': `p${j}`, 'sh:maxCount': 1, 'sh:in': head, 'sh:defaultValue': 'zz' })) },
    ...range(300).map(j => ({ '@id': `#L${j}`, 'rdf:first': `e${j}`, 'rdf:rest': { '@id': j === 299 ? 'rdf:nil' : `#L${j + 1}` } })), ...more] });
  // A write whose 400 template variables, none a property, all take the schema additionalProperties names.
  const sharedSchema = (path: string, additional: Record<string, unknown>) => ({ '@context': CTX, '@id': `${base}${path}`,
    'iep:affordance': [{ '@id': '#s', '@type': 'iep:Affordance', 'iep:action': { '@id': 'urn:shared-schema' }, 'hydra:method': 'POST',
      'hydra:title': 'Shared schema', 'hydra:target': { '@type': 'hydra:IriTemplate',
        'hydra:template': `${base}/api{?${range(400).map(j => `v${j}`).join(',')}}`, 'hydra:mapping': range(400).map(j => ({ 'hydra:variable': `v${j}` })) },
      'hydra:expects': { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: additional } }] });
  // A write whose one input takes a list, each of whose values is one of 50,000 entries, with a default of 50,000 values.
  // Controls whose shape names one property node `times` times.
  const named = (path: string, controls: number, times: number, property: Record<string, unknown>) => ({ '@context': CTX, '@id': `${base}${path}`,
    'iep:affordance': range(controls).map(i => ({ '@id': `#c${i}`, '@type': 'iep:Affordance', ...get(controls === 1 ? 'urn:c' : `urn:c${i}`, `C${i}`),
      'hydra:expects': { '@id': '#S' } })),
    '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': range(times).map(() => ({ '@id': '#P' })) },
      { '@id': '#P', 'sh:path': { '@id': 'urn:p:m' }, ...property }] });
  // A write whose one input is a list of decimals with `count` defaults of 0.5 and the constraint given.
  const decimals = (path: string, count: number, constraint: Record<string, unknown>) => ({ '@context': CTX, '@id': `${base}${path}`,
    'iep:affordance': [{ '@id': '#l', '@type': 'iep:Affordance', 'iep:action': { '@id': 'urn:list' }, 'hydra:method': 'POST', 'hydra:title': 'List',
      'hydra:target': { '@id': `${base}/api` }, 'hydra:expects': { '@id': '#S' } }],
    '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm',
      'sh:datatype': { '@id': 'xsd:decimal' }, 'sh:defaultValue': range(count).map(() => 0.5), ...constraint } }] });
  // 1,000 controls whose JSON Schemas each name the property `name(i)` gives, and what `more(i)` adds, sharing one template of 1,000 mappings.
  const templateSchemas = (path: string, name: (i: number) => string, more: (i: number) => Record<string, unknown> = () => ({})) => ({
    '@context': CTX, '@id': `${base}${path}`,
    'iep:affordance': range(1000).map(i => ({ '@id': `#c${i}`, '@type': 'iep:Affordance', ...get(`urn:c${i}`, `C${i}`), 'hydra:target': { '@id': '#T' },
      'hydra:expects': { type: 'object', properties: { [name(i)]: { type: 'string' } }, ...more(i) } })),
    '@graph': [{ '@id': '#T', '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/api{?v0}`,
      'hydra:mapping': range(1000).map(j => ({ 'hydra:variable': `v${j}` })) }] });
  // 1,000 controls whose shapes name one property node, written in place in each or as 1,000 shapes in the @graph.
  const propertyShared = (path: string, described: boolean) => ({ '@context': CTX, '@id': `${base}${path}`,
    'iep:affordance': range(1000).map(i => ({ '@id': `#c${i}`, '@type': 'iep:Affordance', ...get(`urn:c${i}`, `C${i}`),
      'hydra:expects': described ? { '@id': `#S${i}` } : { '@type': 'sh:NodeShape', 'sh:property': { '@id': '#P' } } })),
    '@graph': [{ '@id': '#P', 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1, 'sh:description': 'd'.repeat(100000),
      'sh:defaultValue': 'v'.repeat(100000) }, ...(described ? range(1000).map(i => ({ '@id': `#S${i}`, '@type': 'sh:NodeShape',
      'sh:property': { '@id': '#P' } })) : [])] });
  const LONG_IRI = `https://x.example/${'a'.repeat(100000)}/`;
  const items = (defaults: string[]) => ({ '@context': CTX, '@id': `${base}/cost/items`, 'iep:affordance': [{ '@id': '#i', '@type': 'iep:Affordance',
    'iep:action': { '@id': 'urn:items' }, 'hydra:method': 'POST', 'hydra:title': 'Items', 'hydra:target': { '@id': `${base}/api` },
    'hydra:expects': { type: 'object', properties: { m: { type: 'array', items: { enum: range(50000).map(j => `e${j}`) }, default: defaults } } } }] });
  const docs: Record<string, unknown> = {
    '/cost/harvest': { '@context': CTX, '@id': `${base}/cost/harvest`, '@graph': [
      { '@id': 'urn:x', 'iep:affordance': range(1500).map(i => ({ '@id': `urn:o${i}`, ...get(`urn:op${i}`, `Op ${i}`) })) },
      ...range(1500).map(i => ({ '@id': `urn:n${i}`, 'iep:affordance': { '@id': 'urn:x' } }))] },
    '/cost/shape': { '@context': CTX, '@id': `${base}/cost/shape`,
      'iep:affordance': range(400).map(i => ({ '@id': `#c${i}`, '@type': 'iep:Affordance', ...get(`urn:c${i}`, `C${i}`), 'hydra:expects': { '@id': '#S' } })),
      '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': props(400) }] },
    '/cost/template': { '@context': CTX, '@id': `${base}/cost/template`,
      'iep:affordance': range(400).map(i => ({ '@id': `#c${i}`, '@type': 'iep:Affordance', ...get(`urn:c${i}`, `C${i}`), 'hydra:target': { '@id': '#T' } })),
      '@graph': [{ '@id': '#T', '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/api{?v0}`,
        'hydra:mapping': range(400).map(j => ({ 'hydra:variable': `v${j}`, 'hydra:property': { '@id': `urn:p${j}` } })) }] },
    '/cost/mappings': { '@context': CTX, '@id': `${base}/cost/mappings`, 'iep:affordance': [{ '@id': '#c', '@type': 'iep:Affordance',
      ...get('urn:c', 'C'), 'hydra:target': { '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/api{?v0}`,
        'hydra:mapping': range(8000).map(j => ({ 'hydra:variable': `v${j}`, 'hydra:property': { '@id': `urn:p${j}` } })) } }] },
    '/cost/class': { '@context': CTX, '@id': `${base}/cost/class`, '@graph': [
      { '@id': 'urn:C', 'hydra:supportedOperation': range(1500).map(j => ({ '@id': `urn:o${j}`, ...get(`urn:op${j}`, `Op ${j}`) })) },
      ...range(1500).map(i => ({ '@id': `urn:n${i}`, 'hydra:supportedClass': { '@id': 'urn:C' } }))] },
    '/cost/items': items(range(50000).map(j => `e${j}`)),
    '/cost/items-refused': items(range(50000).map(j => `x${j}`)),
    '/cost/shape-list': { '@context': CTX, '@id': `${base}/cost/shape-list`, 'iep:affordance': [{ '@id': '#l', '@type': 'iep:Affordance',
      'iep:action': { '@id': 'urn:list' }, 'hydra:method': 'POST', 'hydra:title': 'List', 'hydra:target': { '@id': `${base}/api` },
      'hydra:expects': { '@id': '#S' } }],
    '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm',
      'sh:in': { '@list': range(5000).map(j => `e${j}`) }, 'sh:defaultValue': range(5000).map(j => `x${j}`) } }] },
    // 400 template variables, none a property, that all take the enum of 400 entries additionalProperties names.
    '/cost/shared-schema': sharedSchema('/cost/shared-schema', { enum: range(400).map(j => `e${j}`), default: 'zz' }),
    // 400 such variables that would each take a default, a description or a pattern of 10,000 characters.
    '/cost/shared-default': sharedSchema('/cost/shared-default', { type: 'string', default: 'x'.repeat(10000) }),
    '/cost/shared-description': sharedSchema('/cost/shared-description', { type: 'string', description: 'x'.repeat(10000) }),
    '/cost/shared-pattern': sharedSchema('/cost/shared-pattern', { type: 'string', pattern: 'x'.repeat(10000) }),
    // One property node named 1,000 times by a shape 100 controls share, and 2,000 times by one control's.
    '/cost/property-named': named('/cost/property-named', 100, 1000, { 'sh:name': `m${'x'.repeat(99)}`, 'sh:description': 'd'.repeat(1000) }),
    '/cost/property-default': named('/cost/property-default', 1, 2000, { 'sh:name': 'm', 'sh:maxCount': 1, 'sh:description': 'd'.repeat(10000),
      'sh:defaultValue': 'v'.repeat(10000) }),
    // A list of decimals whose sh:hasValue, or whose bound, is a number written with 300,000 or 150,000 digits.
    '/cost/has-value-list': decimals('/cost/has-value-list', 8000, { 'sh:hasValue': `0.${'1'.repeat(300000)}` }),
    '/cost/bound-list': decimals('/cost/bound-list', 4000, { 'sh:minInclusive': `0.5${'0'.repeat(150000)}` }),
    '/cost/bound-list-refused': decimals('/cost/bound-list-refused', 4000, { 'sh:maxInclusive': `0.4${'0'.repeat(150000)}` }),
    // 1,000 controls, each with a JSON Schema of its own, that share one IRI template of 1,000 mappings.
    '/cost/template-schemas': templateSchemas('/cost/template-schemas', () => 'x'),
    '/cost/template-own': templateSchemas('/cost/template-own', i => `x${i}`),
    // The same, with a property each mapping in turn matches, or an additionalProperties of its own that types the variables.
    '/cost/template-matched': templateSchemas('/cost/template-matched', i => `v${i}`),
    '/cost/template-typed': templateSchemas('/cost/template-typed', () => 'x', i => ({ additionalProperties: { type: 'string', maxLength: i } })),
    // One property node with a 100,000-character description and default, named by 1,000 shapes.
    '/cost/property-shared': propertyShared('/cost/property-shared', false),
    '/cost/property-shapes': propertyShared('/cost/property-shapes', true),
    // 1,000 shapes written in place whose property's sh:in is one RDF list of 1,000 nodes.
    '/cost/list-shared': { '@context': CTX, '@id': `${base}/cost/list-shared`,
      'iep:affordance': range(1000).map(i => ({ '@id': `#c${i}`, '@type': 'iep:Affordance', ...get(`urn:c${i}`, `C${i}`),
        'hydra:expects': { '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': 'm', 'sh:maxCount': 1,
          'sh:in': { '@id': '_:l0' } } } })),
      '@graph': range(1000).map(j => ({ '@id': `_:l${j}`, 'rdf:first': `e${j}`, 'rdf:rest': { '@id': j === 999 ? 'rdf:nil' : `_:l${j + 1}` } })) },
    // A double list default of 10,000 values past 2^53 of a field with a 10 KB name, each the one
    // sh:in entry it matches, which a problem would name, one for each value, but for the stop.
    '/cost/list-stop': { '@context': CTX, '@id': `${base}/cost/list-stop`, 'iep:affordance': [{ '@id': '#l', '@type': 'iep:Affordance',
      'iep:action': { '@id': 'urn:list' }, 'hydra:method': 'POST', 'hydra:title': 'List', 'hydra:target': { '@id': `${base}/api` },
      'hydra:expects': { '@id': '#S' } }],
    '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': { 'sh:path': { '@id': 'urn:p:m' }, 'sh:name': LONG_NAME,
      'sh:datatype': { '@id': 'xsd:double' }, 'sh:in': { '@list': range(10000).map(k => 2 ** 53 + 2 + 2 * k) },
      'sh:defaultValue': range(10000).map(k => 2 ** 53 + 2 + 2 * k) } }] },
    // A prefix, a term @vocab expands or a @base, 100,000 characters long, that 3,000 short IRIs use.
    '/cost/prefix-controls': { '@context': { ...CTX, p: LONG_IRI }, '@id': `${base}/cost/prefix-controls`,
      'iep:affordance': range(3000).map(i => ({ '@id': `#c${i}`, 'iep:action': { '@id': `p:c${i}` }, 'hydra:method': 'GET',
        'hydra:target': { '@id': `p:t${i}` } })) },
    '/cost/prefix-shape': { '@context': { ...CTX, p: LONG_IRI }, '@id': `${base}/cost/prefix-shape`, 'iep:affordance': [{ '@id': '#c',
      ...get('urn:c', 'C'), 'hydra:expects': { '@id': '#S' } }],
    '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': range(3000).map(j =>
      ({ 'sh:path': { '@id': `p:k${j}` }, 'sh:name': `k${j}`, 'sh:maxCount': 1 })) }] },
    '/cost/prefix-keys': { '@context': { ...CTX, p: LONG_IRI }, '@id': `${base}/cost/prefix-keys`, 'iep:affordance': [{ '@id': '#c', ...get('urn:c', 'C') }],
      '@graph': [{ '@id': '#n', ...Object.fromEntries(range(3000).map(j => [`p:k${j}`, 1])) }] },
    '/cost/vocab-types': { '@context': { ...CTX, '@vocab': LONG_IRI }, '@id': `${base}/cost/vocab-types`,
      'iep:affordance': [{ '@id': '#c', ...get('urn:c', 'C') }], '@graph': range(3000).map(j => ({ '@id': `#n${j}`, '@type': `T${j}` })) },
    '/cost/base-ids': { '@context': [CTX, { '@base': LONG_IRI }], '@id': `${base}/cost/base-ids`, 'iep:affordance': [{ '@id': `${base}/c`,
      ...get('urn:c', 'C') }], '@graph': range(3000).map(j => ({ '@id': `n${j}`, 'rdfs:label': 'n' })) },
    // 300 properties whose sh:in is one RDF list of 300 nodes.
    '/cost/shared-list': listShape('/cost/shared-list', range(300).map(() => ({ '@id': '#L0' })), []),
    // 300 properties each with an RDF list of its own first node, all ending in one tail of 300 nodes.
    '/cost/shared-tail': listShape('/cost/shared-tail', range(300).map(i => ({ '@id': `#H${i}` })),
      range(300).map(i => ({ '@id': `#H${i}`, 'rdf:first': `h${i}`, 'rdf:rest': { '@id': '#L0' } }))),
    // An enum of 30,000 empty objects and a const of 30,000 keys, which no entry matches.
    '/cost/const-many': { '@context': CTX, '@id': `${base}/cost/const-many`, 'iep:affordance': [{ '@id': '#c', '@type': 'iep:Affordance',
      'iep:action': { '@id': 'urn:c' }, 'hydra:method': 'POST', 'hydra:title': 'C', 'hydra:target': { '@id': `${base}/api` },
      'hydra:expects': { type: 'object', properties: { m: { enum: range(30000).map(() => ({})),
        const: Object.fromEntries(range(30000).map(j => [`k${j}`, 0])) } } } }] },
    // WORK_CASES: 2,000 supported properties whose hydra:property has one 30,000-character comment.
    '/work/comment-shared': { '@context': CTX, '@id': `${base}/work/comment-shared`, 'iep:affordance': [{ '@id': '#c', '@type': 'iep:Affordance',
      'iep:action': { '@id': 'urn:c' }, 'hydra:method': 'POST', 'hydra:title': 'C', 'hydra:target': { '@id': `${base}/api` },
      'hydra:expects': { '@id': '#C' } }],
    '@graph': [{ '@id': '#C', '@type': 'hydra:Class', 'hydra:supportedProperty': range(2000).map(i =>
      ({ 'hydra:property': { '@id': 'urn:x:' }, 'sh:name': `f${i}` })) }, { '@id': 'urn:x:', 'rdfs:comment': 'c'.repeat(30000) }] },
    // 2,000 controls whose target is one IRI template of 50,000 characters, or two of 25,000.
    '/work/template-text': { '@context': CTX, '@id': `${base}/work/template-text`,
      'iep:affordance': range(2000).map(i => ({ '@id': `#c${i}`, '@type': 'iep:Affordance', ...get(`urn:c${i}`, `C${i}`), 'hydra:target': { '@id': '#T' } })),
      '@graph': [{ '@id': '#T', '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/api/${'a'.repeat(50000)}{?q}` }] },
    '/work/template-conflict': { '@context': CTX, '@id': `${base}/work/template-conflict`,
      'iep:affordance': range(2000).map(i => ({ '@id': `#c${i}`, '@type': 'iep:Affordance', ...get(`urn:c${i}`, `C${i}`),
        'hydra:target': [{ '@id': '#T1' }, { '@id': '#T2' }] })),
      '@graph': [1, 2].map(k => ({ '@id': `#T${k}`, '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/api/${String(k).repeat(25000)}{?q}` })) },
    // 2,000 writes expecting one shape whose two properties share a 50,000-character sh:name.
    '/work/name-shared': { '@context': CTX, '@id': `${base}/work/name-shared`,
      'iep:affordance': range(2000).map(i => ({ '@id': `#c${i}`, '@type': 'iep:Affordance', ...get(`urn:c${i}`, `C${i}`), 'hydra:method': 'POST',
        'hydra:expects': { '@id': '#S' } })),
      '@graph': [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': ['a', 'b'].map(p =>
        ({ 'sh:path': { '@id': `urn:p:${p}` }, 'sh:name': 'n'.repeat(50000), 'sh:maxCount': 1 })) }] },
    // 2,500 controls, each with a JSON Schema of its own, sharing one template of 2,500 mappings.
    '/work/joined': { '@context': CTX, '@id': `${base}/work/joined`,
      'iep:affordance': range(2500).map(i => ({ '@id': `#c${i}`, '@type': 'iep:Affordance', ...get(`urn:c${i}`, `C${i}`), 'hydra:target': { '@id': '#T' },
        'hydra:expects': { properties: { [`x${i}`]: {} } } })),
      '@graph': [{ '@id': '#T', '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/api{?v0}`,
        'hydra:mapping': range(2500).map(j => ({ 'hydra:variable': `v${j}` })) }] },
    // One template that writes its one variable 20,000 times, with a default of 5,000 characters.
    '/work/template-repeat': { '@context': CTX, '@id': `${base}/work/template-repeat`, 'iep:affordance': [{ '@id': '#c', '@type': 'iep:Affordance',
      ...get('urn:c', 'C'), 'hydra:target': { '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/api/${'{q}'.repeat(20000)}`,
        'hydra:mapping': [{ 'hydra:variable': 'q' }] },
      'hydra:expects': { type: 'object', properties: { q: { type: 'string', default: 'x'.repeat(5000) } } } }] },
    // One expression that names its one variable 20,000 times, with a default of 50,000 characters.
    '/work/expr-repeat': { '@context': CTX, '@id': `${base}/work/expr-repeat`, 'iep:affordance': [{ '@id': '#c', '@type': 'iep:Affordance',
      ...get('urn:c', 'C'), 'hydra:target': { '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/api{?${Array(20000).fill('q').join(',')}}`,
        'hydra:mapping': [{ 'hydra:variable': 'q' }] },
      'hydra:expects': { type: 'object', properties: { q: { type: 'string', default: 'x'.repeat(50000) } } } }] },
    // One exploded variable of a 20,000-character name whose default is a list of 50,000 values.
    '/work/expr-explode': { '@context': CTX, '@id': `${base}/work/expr-explode`, 'iep:affordance': [{ '@id': '#c', '@type': 'iep:Affordance',
      ...get('urn:c', 'C'), 'hydra:target': { '@type': 'hydra:IriTemplate', 'hydra:template': `${base}/api{?${LONG_VARIABLE}*}`,
        'hydra:mapping': [{ 'hydra:variable': LONG_VARIABLE }] },
      'hydra:expects': { type: 'object', properties: { [LONG_VARIABLE]: { type: 'array', items: { type: 'string' },
        default: Array(50000).fill('x') } } } }] },
    // A write with no transport but MCP whose JSON default holds 40 arrays nested 240 deep.
    '/work/mcp-indented': { '@context': CTX, '@id': `${base}/work/mcp-indented`, 'iep:affordance': [{ '@id': '#c', '@type': 'iep:Affordance',
      'iep:action': { '@id': 'urn:c' }, 'hydra:method': 'POST', 'hydra:title': 'C',
      'hydra:expects': { type: 'object', properties: { data: { type: 'object', default: { n: Array(40).fill(nested(240)) } } } } }] },
    // 300 writes, each expecting a shape of its own with ten described properties.
    '/work/honest': { '@context': CTX, '@id': `${base}/work/honest`,
      'iep:affordance': range(300).map(i => ({ '@id': `#c${i}`, '@type': 'iep:Affordance', ...get(`urn:c${i}`, `Write ${i}`), 'hydra:method': 'POST',
        'hydra:expects': { '@id': `#S${i}` } })),
      '@graph': range(300).map(i => ({ '@id': `#S${i}`, '@type': 'sh:NodeShape', 'sh:property': range(10).map(j => ({
        'sh:path': { '@id': `urn:p:${i}:${j}` }, 'sh:name': `f${j}`, 'sh:maxCount': 1, 'sh:datatype': { '@id': 'xsd:string' },
        'sh:description': `Field ${j} of write ${i}, which an honest document describes in a sentence.`, 'sh:defaultValue': `v${j}` })) })) },
    ...sharedNodeDocuments(base),
  };
  return Object.fromEntries(Object.entries(docs).map(([path, doc]) => [path, JSON.stringify(doc).replace('"INEXACT-NUMBER"', '9007199254740993')]));
}

/**
 * The size of each of sharedNodeDocuments' documents, as [uses, size]: how many controls, inputs or
 * mappings name the one node, and how many keys or values that node holds.
 */
const SHARED_NODE_SIZES = {
  hint: [3000, 3000], hintList: [3000, 3000], target: [1000, 12000], types: [1000, 18000], search: [2000, 4500], mapping: [3000, 3000],
  property: [1500, 3000], supported: [1000, 20000], notes: [3000, 20000], path: [1000, 9000], list: [3000, 12000], closed: [1500, 3000],
  range: [1000, 20000], comment: [1000, 20000], mappingValues: [6000, 24000], propertyValues: [1500, 6000], rounded: [1500, 30000],
  rangeDistinct: [3000, 3000], mappingDistinct: [6000, 6000], closedShared: [1500, 5000],
} as const;

/**
 * WORK_CASES' documents in which many controls, inputs or mappings name one node by reference, a
 * node of thousands of keys or values: each client read the node, or its values, again for each
 * that names it, and now reads it once (SHARED_NODE_SIZES sets each one's size).
 */
function sharedNodeDocuments(base: string): Record<string, unknown> {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  // A node's own keys, n of them, that say nothing either client acts on.
  const keys = (n: number) => Object.fromEntries(range(n).map(j => [`urn:x:p${j}`, j]));
  const read = (i: number, extra: Record<string, unknown>): Record<string, unknown> => ({ '@id': `#c${i}`, '@type': 'iep:Affordance',
    'iep:action': { '@id': `urn:c${i}` }, 'hydra:method': 'GET', 'hydra:title': `C${i}`, 'hydra:target': { '@id': `${base}/api` }, ...extra });
  const write = (i: number, extra: Record<string, unknown>) => ({ ...read(i, extra), 'hydra:method': 'POST' });
  const doc = (path: string, controls: unknown[], graph: unknown[], context: Record<string, unknown> = CTX) =>
    ({ '@context': context, '@id': `${base}${path}`, 'iep:affordance': controls, '@graph': graph });
  // n reads that each name one read-only annotation node of k keys under `key`, as `ref` names it.
  const hinted = (path: string, [n, k]: readonly [number, number], ref: (i: number) => Record<string, unknown>, context: Record<string, unknown> = CTX) =>
    doc(path, range(n).map(i => read(i, ref(i))), [{ '@id': '#ann', 'iep:readOnlyHint': true, ...keys(k) }], context);
  // One write expecting a hydra:Class of n supported properties that each name one hydra:property node.
  const supported = (path: string, n: number, property: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    doc(path, [write(0, { 'hydra:expects': { '@id': '#C' } })], [{ '@id': '#C', '@type': 'hydra:Class', 'hydra:supportedProperty': range(n).map(i =>
      ({ 'hydra:property': { '@id': '#p' }, 'sh:name': `f${i}`, ...extra })) }, { '@id': '#p', ...property }]);
  // n writes, each expecting a shape of its own that names one property node.
  const shapes = (path: string, n: number, property: Record<string, unknown>) => doc(path, range(n).map(i => write(i, { 'hydra:expects': { '@id': `#S${i}` } })),
    [...range(n).map(i => ({ '@id': `#S${i}`, '@type': 'sh:NodeShape', 'sh:property': { '@id': '#P' } })), { '@id': '#P', ...property }]);
  // One write expecting one shape of n properties that each say `input(i)`, beside `more`.
  const properties = (path: string, n: number, input: (i: number) => Record<string, unknown>, more: unknown[], context: Record<string, unknown> = CTX) =>
    doc(path, [write(0, { 'hydra:expects': { '@id': '#S' } })],
      [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:property': range(n).map(i => ({ 'sh:name': `f${i}`, ...input(i) })) }, ...more], context);
  // One read whose template has n mappings that all name one mapping node.
  const mappings = (path: string, n: number, mapping: Record<string, unknown>) =>
    doc(path, [read(0, { 'hydra:template': `${base}/api{?q}`, 'hydra:mapping': range(n).map(() => ({ '@id': '#m' })) })], [{ '@id': '#m', ...mapping }]);
  const s = SHARED_NODE_SIZES;
  return {
    '/work/hint-shared': hinted('/work/hint-shared', s.hint, () => ({ 'urn:x:annotations': { '@id': '#ann' } })),
    '/work/hint-string': hinted('/work/hint-string', s.hint, () => ({ annotations: '#ann' }),
      { ...CTX, annotations: { '@id': 'urn:x:annotations', '@type': '@id' } }),
    '/work/hint-list': hinted('/work/hint-list', [1, s.hintList[1]], () => ({ 'urn:x:annotations': { '@list': range(s.hintList[0]).map(() => '#ann') } })),
    '/work/target-keys': doc('/work/target-keys', range(s.target[0]).map(i => read(i, { 'hydra:target': { '@id': '#t' } })), [{ '@id': '#t', ...keys(s.target[1]) }]),
    '/work/target-types': doc('/work/target-types', range(s.types[0]).map(i => read(i, { 'hydra:target': { '@id': '#t' } })),
      [{ '@id': '#t', '@type': range(s.types[1]).map(j => `urn:x:T${j}`) }]),
    '/work/search-keys': doc('/work/search-keys', range(s.search[0]).map(i => {
      const control = read(i, { 'hydra:search': { '@id': '#T' } });
      delete control['hydra:target'];
      return control;
    }), [{ '@id': '#T', 'hydra:template': `${base}/api{?q}`, 'hydra:mapping': [{ 'hydra:variable': 'q' }], ...keys(s.search[1]) }]),
    '/work/mapping-keys': mappings('/work/mapping-keys', s.mapping[0], { 'hydra:variable': 'q', ...keys(s.mapping[1]) }),
    '/work/property-keys': shapes('/work/property-keys', s.property[0], { 'sh:path': { '@id': 'urn:x:m' }, 'sh:name': 'm', ...keys(s.property[1]) }),
    '/work/supported-keys': supported('/work/supported-keys', s.supported[0], { 'rdfs:label': 'p', ...keys(s.supported[1]) }),
    '/work/node-notes': properties('/work/node-notes', s.notes[0], i => ({ 'sh:path': { '@id': `urn:x:p${i}` }, 'sh:node': { '@id': '#T' } }),
      [{ '@id': '#T', ...Object.fromEntries(range(s.notes[1]).map(j => [`c${j}`, 0])) }],
      { ...CTX, ...Object.fromEntries(range(s.notes[1]).map(j => [`c${j}`, 'rdfs:comment'])) }),
    '/work/path-keys': properties('/work/path-keys', s.path[0], () => ({ 'sh:path': { '@id': 'urn:x:path' } }), [{ '@id': 'urn:x:path', ...keys(s.path[1]) }]),
    '/work/list-keys': properties('/work/list-keys', s.list[0], i => ({ 'sh:path': { '@id': `urn:x:p${i}` }, 'sh:in': { '@id': '#L' } }),
      [{ '@id': '#L', 'rdf:first': 'a', 'rdf:rest': { '@id': 'rdf:nil' }, ...keys(s.list[1]) }]),
    '/work/closed-ignored': doc('/work/closed-ignored', range(s.closed[0]).map(i => write(i, { 'hydra:expects': { '@id': '#S' },
      'hydra:template': `${base}/api{?v${i}}`, 'hydra:mapping': [{ 'hydra:variable': `v${i}`, 'hydra:property': { '@id': `urn:x:v${i}` } }] })),
    [{ '@id': '#S', '@type': 'sh:NodeShape', 'sh:closed': true, 'sh:property': [{ 'sh:path': { '@id': 'urn:x:m' }, 'sh:name': 'm' }],
      'sh:ignoredProperties': range(s.closed[1]).map(j => ({ '@id': `urn:x:v${j}` })) }]),
    '/work/range-values': supported('/work/range-values', s.range[0], { 'rdfs:range': range(s.range[1]).map(() => ({ '@id': 'xsd:string' })) }),
    '/work/comment-values': supported('/work/comment-values', s.comment[0], { 'rdfs:comment': [...range(s.comment[1]).map(() => ({ '@list': [] })), 'c'] },
      { 'sh:datatype': { '@id': 'xsd:string' } }),
    '/work/mapping-values': mappings('/work/mapping-values', s.mappingValues[0], { 'hydra:variable': range(s.mappingValues[1]).map(() => 'q') }),
    '/work/property-values': shapes('/work/property-values', s.propertyValues[0], Object.fromEntries(
      [['sh:path', { '@id': 'urn:x:m' }], ['sh:name', 'm'], ['sh:maxCount', 1], ['sh:datatype', { '@id': 'xsd:string' }], ['sh:description', { '@list': [] }]]
        .map(([key, value]) => [key, range(s.propertyValues[1]).map(() => value)]))),
    '/work/default-rounded': shapes('/work/default-rounded', s.rounded[0], { 'sh:path': { '@id': 'urn:x:m' }, 'sh:name': 'm',
      'sh:datatype': { '@id': 'xsd:decimal' }, 'sh:defaultValue': range(s.rounded[1]).map(() => 0), 'urn:x:n': 'INEXACT-NUMBER' }),
    '/work/range-distinct': supported('/work/range-distinct', s.rangeDistinct[0], { 'rdfs:range': range(s.rangeDistinct[1]).map(j => ({ '@id': `urn:x:type:${j}` })) }),
    '/work/mapping-distinct': mappings('/work/mapping-distinct', s.mappingDistinct[0], { 'hydra:variable': range(s.mappingDistinct[1]).map(j => `q${j}`) }),
    // Each write expects a closed shape of its own, and every shape's sh:ignoredProperties names one
    // RDF list, whose first member is the property the template's one variable fills.
    '/work/closed-shared': doc('/work/closed-shared', range(s.closedShared[0]).map(i => write(i, { 'hydra:target': { '@id': '#T' },
      'hydra:expects': { '@id': `#S${i}` } })), [
      { '@id': '#T', 'hydra:template': `${base}/api{?v}`, 'hydra:mapping': [{ 'hydra:variable': 'v', 'hydra:property': { '@id': 'urn:x:v' } }] },
      ...range(s.closedShared[0]).map(i => ({ '@id': `#S${i}`, 'sh:closed': true, 'sh:ignoredProperties': { '@id': '#I0' } })),
      ...range(s.closedShared[1]).map(j => ({ '@id': `#I${j}`, 'rdf:first': j ? `u${j}` : { '@id': 'urn:x:v' },
        'rdf:rest': { '@id': j === s.closedShared[1] - 1 ? 'rdf:nil' : `#I${j + 1}` } }))]),
  };
}

/**
 * Controls the documents above hold as jsonld.js reads them, each dry-run by both clients, as [path,
 * the IRI that names it, title, method, the address its plan sends to, or null for a control the
 * document gives no hydra:target, which goes to the Interego relay instead].
 */
export function jsonldPlans(base: string): ReadonlyArray<readonly [path: string, rel: string, title: string, method: string, url: string | null]> {
  return [
    ['/type-scoped', 'urn:scope:type', 'Type-scoped write', 'POST', `${base}/right`],
    ['/propagate', 'urn:scope:propagate', 'Unpropagated write', 'POST', `${base}/right`],
    ['/type-scoped-deep', 'urn:deep:type', 'Deep type read', 'GET', `${base}/api`],
    ['/property-scoped-deep', 'urn:deep:property', 'Deep property read', 'GET', `${base}/api`],
    ['/index-refs', 'urn:refs:remove', 'Remove', 'DELETE', `${base}/thing`],
    ['/index-refs', 'urn:refs:replace', 'Replace', 'PUT', `${base}/thing`],
    ['/graph-index', 'urn:graph:own', 'Own method', 'GET', `${base}/thing`],
    ['/graph-index', 'urn:graph:keyed', 'Keyed method', 'POST', `${base}/thing`],
    ['/nest-keywords', 'urn:nest:alias', 'Nested alias type', 'POST', `${base}/thing`],
    ['/nest-keywords', `${base}/nest-keywords#typed`, 'Nested type', 'POST', `${base}/thing2`],
    ['/defined-terms', 'urn:defined:target', 'Audience note', 'POST', null],
    ['/defined-terms', 'urn:defined:method', 'Approach note', 'POST', null],
    ['/two-terms', 'urn:two:read', 'Two-term read', 'GET', `${base}/api`],
    ['/two-terms', 'urn:two:write', 'Two-term write', 'POST', `${base}/api`],
    ['/prefix-terms', 'urn:prefix:expanded', 'Expanded prefix', 'POST', null],
    ['/prefix-terms', 'urn:prefix:simple', 'Simple prefix', 'POST', `${base}/collect`],
    ['/hint-values', 'urn:hint:read', 'Plain hint read', 'GET', `${base}/api`],
    ['/set-values', 'urn:set:read', 'Set object read', 'GET', `${base}/api`],
    ['/set-values', 'urn:set:nested', 'Nested set read', 'GET', `${base}/api`],
    ['/set-values', 'urn:set:list', 'List object read', 'GET', `${base}/api`],
    ['/set-values', 'urn:set:graph', 'Graph object read', 'GET', `${base}/api`],
    ['/set-values', 'urn:set:alias', 'Aliased set read', 'GET', `${base}/api`],
    ['/set-values', 'urn:set:method', 'Set method read', 'GET', `${base}/api`],
    ['/set-values', 'urn:set:tagged', 'Tagged method read', 'GET', `${base}/api`],
    ['/set-values', 'urn:set:shape', 'Set shape read', 'GET', `${base}/api`],
    ['/nested-ops', 'urn:nest:outer', 'Outer read', 'GET', `${base}/api`],
    ['/nested-ops', 'urn:nest:inner', 'Inner delete', 'DELETE', `${base}/thing`],
    ['/nested-ops', 'urn:nest:both', 'Operation and template', 'DELETE', `${base}/thing`],
    ['/nested-ops', 'urn:nest:template', 'Template with a method', 'DELETE', `${base}/thing`],
    ['/hm-lines', 'hm-ff', 'Form feed read', 'GET', `${base}/api`],
    ['/hm-lines', 'hm-cr-only', 'CR-only read', 'GET', `${base}/api`],
    // A hint container whose references loop back to itself and to the control is read once, and
    // says nothing unsafe.
    ['/ref-hints', 'urn:ref:loop', 'Looped flags', 'GET', `${base}/api`],
  ];
}

/**
 * Controls each client lists, as an unsafe one, and refuses to invoke, as [path, action, title,
 * the method shown, the problem it names].
 */
export function jsonldRefusals(base: string): ReadonlyArray<readonly [path: string, rel: string, title: string, method: string, problem: string]> {
  return [
    ['/index-order', 'urn:order:item', 'Delete item', 'DELETE',
      'two controls are both named urn:order:item, so which one is meant is not known; this control is not invoked'],
    ['/index-order-inline', 'urn:order:inline', 'Delete inline item', 'DELETE',
      'two controls are both named urn:order:inline, so which one is meant is not known; this control is not invoked'],
    ['/two-methods', 'urn:methods:keyed', 'Keyed delete', 'DELETE',
      'this control names more than one hydra:method (GET, DELETE), so what it does is not known; it is not invoked'],
    ['/two-methods', 'urn:methods:listed', 'Listed delete', 'DELETE',
      'this control names more than one hydra:method (GET, DELETE), so what it does is not known; it is not invoked'],
    ['/two-targets', 'urn:targets:two', 'Two targets', 'POST',
      `this control names more than one hydra:target (${base}/dest, ${base}/t), so where it sends is not known; it is not invoked`],
    ['/hint-values', 'urn:hint:two', 'Two hints', 'GET',
      'this control names more than one iep:destructiveHint (false, true), so whether it is safe is not known; it is not invoked'],
    ['/hint-values', 'urn:hint:merged', 'Merged hint', 'GET',
      'this control names more than one iep:destructiveHint (false, true), so whether it is safe is not known; it is not invoked'],
    ['/hint-values', 'urn:hint:listed', 'Listed hint', 'GET',
      'this control writes iep:destructiveHint as a JSON-LD @list, which this client does not read, so whether it is safe is not known; it is not invoked'],
    ['/value-forms', 'urn:form:list-method', 'Listed method', 'POST',
      'this control writes hydra:method as a JSON-LD @list, which this client does not read, so what it does is not known; it is not invoked'],
    ['/value-forms', 'urn:form:container-method', 'List container method', 'POST',
      'this control writes hydra:method as a JSON-LD @list, which this client does not read, so what it does is not known; it is not invoked'],
    ['/value-forms', 'urn:form:json-target', 'JSON target', 'GET',
      'this control writes hydra:target as a JSON literal (@json), which this client does not read, so where it sends is not known; it is not invoked'],
    ['/value-forms', 'urn:form:two-actions', 'Two actions', 'GET',
      'this control names more than one iep:action (urn:form:two-actions, urn:form:other), so which affordance it names is not known; it is not invoked'],
    ['/value-forms', 'urn:form:two-templates', 'Two templates', 'GET',
      `this control names more than one hydra:template (${base}/a{?q}, ${base}/b{?q}), so where it sends is not known; it is not invoked`],
    ['/value-forms', 'urn:form:template-and-address', 'Template and address', 'GET',
      `this control names more than one hydra:target (${base}/t{?q}, ${base}/api), so where it sends is not known; it is not invoked`],
    ['/value-forms', 'urn:form:two-shapes', 'Two shapes', 'POST',
      `this control names more than one hydra:expects (${base}/value-forms#S1, ${base}/value-forms#S2), so what it sends is not known; it is not invoked`],
    ['/value-forms', 'urn:form:two-media', 'Two media types', 'GET',
      'this control names more than one hydra:returnsContentType (application/json, text/html), so what it returns is not known; it is not invoked'],
    ['/value-forms', 'urn:form:two-variables', 'Two variables', 'GET',
      'this control names more than one hydra:variable in one hydra:mapping (q, r), so where it sends is not known; it is not invoked'],
    ['/value-forms', 'urn:form:two-datatypes', 'Two datatypes', 'POST',
      'the input "n" names more than one sh:datatype (http://www.w3.org/2001/XMLSchema#integer, http://www.w3.org/2001/XMLSchema#string), ' +
      'so what it takes is not known; this control is not invoked'],
    ['/value-forms', 'urn:form:two-counts', 'Two counts', 'POST',
      'the input "n" names more than one sh:maxCount (1, 2), so what it takes is not known; this control is not invoked'],
    ['/value-forms', 'urn:form:word-count', 'Word count', 'POST',
      'the input "n" names an sh:maxCount that is not a whole number (one), so what it takes is not known; this control is not invoked'],
    ['/value-forms', 'urn:form:sequence-path', 'Sequence path', 'POST',
      'the input "n" writes sh:path as a JSON-LD @list, which this client does not read, so what it takes is not known; this control is not invoked'],
    ['/value-forms', 'urn:form:two-defaults', 'Two defaults', 'POST',
      'the input "n" names more than one sh:defaultValue (a, b), so what it takes is not known; this control is not invoked'],
    ['/hm-repeat', 'hm-two-methods', 'Repeated method', 'DELETE',
      'this control block gives method more than once (DELETE, GET), so what it does is not known; it is not invoked'],
    ['/same-action', 'urn:same:action', 'Same-action read', 'GET',
      'two controls are both named urn:same:action, so which one is meant is not known; this control is not invoked'],
    ['/described-twice', 'urn:twice:method', 'Method elsewhere', 'DELETE',
      'this control names more than one hydra:method (DELETE, GET), so what it does is not known; it is not invoked'],
    ['/described-twice', 'urn:twice:graph', 'Target elsewhere', 'GET',
      `this control names more than one hydra:target (${base}/purge, ${base}/thing), so where it sends is not known; it is not invoked`],
    ['/described-twice', 'urn:twice:template', 'Template in place', 'GET',
      `this control names more than one hydra:template (${base}/b{?q}, ${base}/a{?q}), so where it sends is not known; it is not invoked`],
    ['/blank-ids', 'urn:blank:two', 'Blank no method', 'POST',
      'two controls are both named urn:blank:two, so which one is meant is not known; this control is not invoked'],
    ['/template-nodes', 'urn:tn:listed', 'Listed template', 'GET',
      'this control writes hydra:template as a JSON-LD @list, which this client does not read, so where it sends is not known; it is not invoked'],
    ['/template-nodes', 'urn:tn:none', 'No template', 'GET',
      'this control names a hydra:IriTemplate as its hydra:target with no hydra:template, so where it sends is not known; it is not invoked'],
    ['/template-nodes', 'urn:tn:search', 'Unread search', 'GET',
      'this control writes hydra:template as a JSON-LD @list, which this client does not read, so where it sends is not known; it is not invoked'],
    ['/template-nodes', 'urn:tn:empty-search', 'Empty search', 'GET',
      'this control names a hydra:IriTemplate as its hydra:search with no hydra:template, so where it sends is not known; it is not invoked'],
    ['/json-terms', 'urn:json:target', 'JSON term target', 'GET',
      'this control writes hydra:target as a JSON literal (@json), which this client does not read, so where it sends is not known; it is not invoked'],
    ['/json-terms', 'urn:json:method', 'JSON term method', 'POST',
      'this control writes hydra:method as a JSON literal (@json), which this client does not read, so what it does is not known; it is not invoked'],
    ['/complex-path', 'urn:path:inverse', 'Inverse path', 'POST',
      'the input "p" writes sh:path as a complex SHACL path, which this client does not read, so what it takes is not known; this control is not invoked'],
    ['/complex-path', 'urn:path:alternative', 'Alternative path', 'POST',
      'the input "pp" writes sh:path as a complex SHACL path, which this client does not read, so what it takes is not known; this control is not invoked'],
    ['/truthiness', `${base}/truthiness#obj`, 'Object method', 'POST',
      'this control writes hydra:method as a node written in place with no @id, which this client does not read, so what it does is not known; it is not invoked'],
    ['/truthiness', 'urn:truth:enum', 'Object enum', 'GET',
      'the input "q" writes enum as something other than a list, which this client does not read, so what it takes is not known; this control is not invoked'],
    ['/truthiness', 'urn:truth:required', 'Nested required', 'GET',
      'the JSON Schema writes required as something other than a list of names, which this client does not read, so which inputs it needs is not known; this control is not invoked'],
    ['/hm-lines', 'hm-cr-method', 'CR method', 'DELETE',
      'this control block gives method more than once (DELETE, GET), so what it does is not known; it is not invoked'],
    ['/hm-json', 'hm-nan', 'NaN fields', 'POST',
      'this control block writes fields as text that is not JSON, so what it sends is not known; it is not invoked'],
    ['/hm-json', 'hm-repeat-key', 'Repeated key fields', 'POST',
      'this control block writes fields as text that is not JSON, so what it sends is not known; it is not invoked'],
    ['/hm-json', 'hm-target-list', 'Target list', 'GET',
      'this control block writes target as a JSON array, which this client does not read there, so where it sends is not known; it is not invoked'],
    ['/hm-json', '["urn:hm:x"]', 'Rel list', 'GET',
      'this control block writes rel as a JSON array, which this client does not read there, so which affordance it names is not known; it is not invoked'],
    ['/hm-json', 'hm-two-fields', 'Two fields of one name', 'POST',
      "two input fields are both named 'a', so their values could not be told apart; this control is not invoked"],
    // A node named by reference is read as every description of it, and one the document does not
    // describe is a problem wherever it decides safety, the address or the inputs.
    ['/ref-hints', 'urn:ref:mixed', 'Mixed flags', 'GET',
      'this control names more than one iep:destructiveHint (false, true), so whether it is safe is not known; it is not invoked'],
    ['/ref-hints', 'urn:ref:missing', 'Missing flags', 'GET',
      `this control names annotations ${base}/ref-hints#nowhere, which this document does not describe, so whether it is safe is not known; it is not invoked`],
    ['/ref-hint-strings', 'urn:refstr:missing', 'Missing string flags', 'GET',
      `this control names annotations ${base}/ref-hint-strings#nowhere, which this document does not describe, so whether it is safe is not known; it is not invoked`],
    // An input whose other name (its path's local name or template variable) is another input's
    // name or other name: which one a value given under it fills is not known.
    ['/crossed-names', 'urn:crossed:name', 'Crossed names', 'POST',
      "the input fields 'a' and 'b' both take a value named 'b', so which one a value fills is not known; this control is not invoked"],
    ['/crossed-names', 'urn:crossed:path', 'Shared path name', 'POST',
      "the input fields 'a' and 'c' both take a value named 'x', so which one a value fills is not known; this control is not invoked"],
    ['/crossed-names', 'urn:crossed:variable', 'Crossed variable', 'POST',
      "the input fields 'z' and 'b' both take a value named 'z', so which one a value fills is not known; this control is not invoked"],
    ['/ref-inputs', 'urn:refin:mapping', 'Missing mapping', 'GET',
      `this control names a hydra:mapping ${base}/ref-inputs#m-missing, which this document does not describe, so where it sends is not known; it is not invoked`],
    ['/ref-inputs', 'urn:refin:prop', 'Missing property', 'POST',
      `the shape names a sh:property ${base}/ref-inputs#p-missing, which this document does not describe, so what it takes is not known; this control is not invoked`],
    ['/ref-inputs', 'urn:refin:class', 'Missing supported property', 'POST',
      `the class names a hydra:supportedProperty ${base}/ref-inputs#sp-missing, which this document does not describe, so what it takes is not known; this control is not invoked`],
    ['/ref-inputs', 'urn:refin:target', 'Blank target', 'GET',
      'this control names hydra:target _:nowhere, a blank node this document does not describe, so where it sends is not known; it is not invoked'],
    ['/ref-inputs', 'urn:refin:shape', 'Blank shape', 'POST',
      'this control names hydra:expects _:shapeless, a blank node this document does not describe, so what it sends is not known; it is not invoked'],
    ['/ref-inputs', 'urn:refin:list', 'Blank list', 'GET',
      'the input "q" writes sh:in as a malformed RDF list, which this client does not read, so what it takes is not known; this control is not invoked'],
    ['/ref-inputs', 'urn:refin:fields', 'Field reference', 'POST',
      `this control writes fields with an entry that names a node (${base}/ref-inputs#f2), which this client does not read there, so what it sends is not known; it is not invoked`],
    ['/ref-inputs', 'urn:refin:schema', 'Schema reference', 'POST',
      'the input "q" writes its JSON Schema as a reference ($ref), which this client does not read, so what it takes is not known; this control is not invoked'],
  ];
}

/**
 * What a host does with one request: answers it (a `type` given as a list is that many Content-Type
 * headers; with `headBody`, it writes the body even in answer to a HEAD, which HTTP forbids), sends
 * it to another address (with a 302 unless `status` names another redirect; with `body`, the
 * redirect carries that body, which neither client reads; with `unending`, it promises a body it
 * never finishes), or closes the connection without answering.
 */
export type HostAnswer =
  | { readonly status?: number; readonly type: string | readonly string[]; readonly body: string; readonly headBody?: true }
  | { readonly redirect: string; readonly status?: 301 | 302 | 303 | 307 | 308; readonly body?: string; readonly unending?: true }
  | 'no answer';

/** The body /landing answers with, which a GET that lands there reads and a HEAD never does. */
export const LANDING_BODY = 'landed';
/**
 * The request headers each test host records of every request it receives, by lower-case name:
 * the ones a followed request keeps or must not carry.
 */
export const HOP_HEADERS = ['accept', 'authorization', 'content-length', 'content-type', 'cookie', 'proxy-authorization'] as const;
export type HopHeaders = Partial<Record<(typeof HOP_HEADERS)[number], string>>;
/** HOP_HEADERS as a request carries them, from any headers object; one it does not carry is left out. */
export function hopHeaders(headers: Record<string, string | readonly string[] | undefined>): HopHeaders {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (value !== undefined && (HOP_HEADERS as readonly string[]).includes(key)) out[key] = typeof value === 'string' ? value : value.join(', ');
  }
  return out;
}
/**
 * What each request of a GET or HEAD /outcomes control carries of HOP_HEADERS, at the address shown
 * and at every address a redirect leads it to: the Accept its dcat:mediaType asks for, which fetch
 * keeps on each hop, and nothing else. Neither client sends a GET or HEAD a body, content headers,
 * credentials or cookies, and no host is sent Proxy-Authorization.
 */
export const OUTCOME_READ_HEADERS: HopHeaders = { accept: OUTCOME_MEDIA };
/** What each request of a descriptor load carries of HOP_HEADERS, on every hop: its Accept, and nothing else. */
export const LOAD_HEADERS: HopHeaders = {
  accept: 'application/ld+json, application/json;q=0.9, text/turtle;q=0.8, text/markdown;q=0.4, */*;q=0.1' };

/**
 * Descriptor addresses whose answer depends on the `format` a request asks for (null when it asks
 * for none), served to both clients. The page's test answers its fetch with them as a browser's fetch
 * would: 'no answer' rejects, and a redirect is followed at most 20 times and only to https, which
 * the page's connect-src allows, while one with an empty Location is no redirect, as Chromium reads
 * it, and its 302 is the answer. hmc.py's test serves them on 127.0.0.1, destroying the socket for
 * 'no answer'.
 */
export function fetchRoutes(base: string): Record<string, (format: string | null) => HostAnswer> {
  const markdown = (title: string): HostAnswer => ({ type: 'text/markdown', body: ['# Markdown', '',
    ':::control md-read', `title: ${title}`, 'method: GET', `target: ${base}/api`, ':::', ''].join('\n') });
  const text = (path: string, title: string, extra: Record<string, unknown> = {}) => JSON.stringify({ '@context': CTX, '@id': `${base}${path}`,
    'iep:affordance': [op('r', `urn:fetch${path.replace(/\//g, ':')}`, 'GET', title, { ...target('/api'), ...extra })] });
  const jsonld = (path: string, title: string): HostAnswer => ({ type: 'application/ld+json', body: text(path, title) });
  const turtle: HostAnswer = { type: 'text/turtle', body: '@prefix dct: <http://purl.org/dc/terms/> .\n<> dct:title "From Turtle" .\n' };
  const missing: HostAnswer = { status: 404, type: 'text/plain', body: 'missing' };
  const KEPT = 'Kept markdown read';
  // A body padded with spaces after it to `bytes` bytes.
  const padded = (body: string, bytes: number) => body + ' '.repeat(bytes - Buffer.byteLength(body));
  const reversed = (path: string): HostAnswer => ({ type: 'application/ld+json',
    body: text(path, 'Reverse read', { '@reverse': { 'hydra:operation': { '@id': `${base}${path}` } } }) });
  return {
    // A readable answer, then a ?format=jsonld retry that gets no JSON-LD: the connection closes, a
    // redirect leaves http(s), the status is 500, or the answer is Turtle. Each keeps the first answer.
    '/upgrade-lost': f => f === 'jsonld' ? 'no answer' : markdown(KEPT),
    '/upgrade-lost-ttl': f => f === 'jsonld' ? 'no answer' : turtle,
    '/upgrade-redirect': f => f === 'jsonld' ? { redirect: 'ftp://127.0.0.1:9/x' } : markdown(KEPT),
    '/upgrade-error': f => f === 'jsonld' ? { status: 500, type: 'application/ld+json', body: text('/upgrade-error', 'Error read') } : markdown(KEPT),
    '/upgrade-other': f => f === 'jsonld' ? turtle : markdown(KEPT),
    // A readable answer, then a ?format=jsonld retry that answers JSON-LD the client refuses whole: it
    // is not JSON, it marks the GET destructive and repeats a key, or it uses @reverse. The first answer
    // is still listed, and every control in it is refused, named; nothing in it is read as safe. Turtle,
    // which the page never reads, leaves nothing read, and the load ends naming the JSON-LD's problem.
    '/upgrade-not-json': f => f === 'jsonld' ? { type: 'application/ld+json', body: '{"@context": ' } : markdown(KEPT),
    '/upgrade-repeated': f => f === 'jsonld' ? { type: 'application/ld+json', body: text('/upgrade-repeated', 'Repeated read', { 'iep:destructiveHint': true })
      .replace('"hydra:method":"GET"', '"hydra:method":"GET","hydra:method":"GET"') } : markdown(KEPT),
    '/upgrade-reverse': f => f === 'jsonld' ? reversed('/upgrade-reverse') : markdown(KEPT),
    '/upgrade-refused-ttl': f => f === 'jsonld' ? reversed('/upgrade-refused-ttl') : turtle,
    // No readable answer at the address as given, and none at all to ?format=jsonld: nothing else is asked.
    '/fallback-lost': f => f === 'jsonld' ? 'no answer' : f === null ? missing : jsonld('/fallback-lost', 'Fallback read'),
    // Answers fetch does not count as readable: a 300 (not 2xx, and not a redirect), an empty JSON-LD
    // body, a body after U+001C (a space to Python's str.strip, not to String.prototype.trim), and
    // front matter under a type that only starts with text/plain. Each is asked for in other formats.
    '/not-ok': f => f === 'jsonld' ? jsonld('/not-ok', 'Format read') : { status: 300, type: 'application/ld+json', body: text('/not-ok', 'Multiple choices read') },
    '/empty-ld': f => f === 'jsonld' ? jsonld('/empty-ld', 'Format read') : { type: 'application/ld+json', body: '' },
    '/separator': f => f === 'jsonld' ? jsonld('/separator', 'Format read') : { type: 'application/ld+json', body: '\x1c' + text('/separator', 'Separator read') },
    '/plainish': f => f === null ? { type: 'text/plainish', body: '---\ntitle: Front matter only\n---\n' } : missing,
    // Answers fetch reads: JSON-LD after a byte order mark, which res.text() drops, and two
    // Content-Type headers, which Headers.get joins with ", ".
    '/bom': () => ({ type: 'application/ld+json', body: '﻿' + text('/bom', 'BOM read') }),
    '/two-types': f => f === null ? { type: ['application/ld+json', 'text/turtle'], body: text('/two-types', 'Two types read') } : missing,
    // A redirect to itself: fetch gives up after 20, as at the network. A 302 with an empty Location
    // is no redirect, as Chromium reads it: an answer that is not 2xx, asked for once.
    '/redirect-loop': () => ({ redirect: '/redirect-loop' }),
    '/empty-location': f => f === null ? { redirect: '' } : f === 'jsonld' ? jsonld('/empty-location', 'Format read') : missing,
    // A load that follows two redirects, a 301 and then a 308, to a document: a GET on each hop.
    '/moved': () => ({ redirect: '/moved-on', status: 301 }),
    '/moved-on': () => ({ redirect: '/bom', status: 308 }),
    // A descriptor of RESPONSE_MAX bytes, read; one of a byte more, which ends the load, named, as a
    // request that gets no answer does; and a ?format=jsonld retry answered so, which leaves the first
    // answer read. Each is JSON-LD a client would read, after whitespace that pads it to its size.
    '/largest-doc': () => ({ type: 'application/ld+json', body: padded(text('/largest-doc', 'Largest read'), RESPONSE_MAX) }),
    '/too-large-doc': () => ({ type: 'application/ld+json', body: padded(text('/too-large-doc', 'Too large read'), RESPONSE_MAX + 1) }),
    '/upgrade-too-large': f => f === 'jsonld'
      ? { type: 'application/ld+json', body: padded(text('/upgrade-too-large', 'Upgrade read'), RESPONSE_MAX + 1) } : markdown(KEPT),
    // An address that names Turtle, which a client that cannot read it asks for again as JSON-LD.
    '/named-ttl': f => f === 'jsonld' ? jsonld('/named-ttl', 'Named format read') : f === 'turtle' ? turtle : missing,
    // Where /outcomes' controls send, whatever the method: each redirect status to /landing, a
    // redirect to an address neither client sends to, one with an empty Location, and answers of
    // each kind that is not a redirect.
    ...Object.fromEntries(([301, 302, 303, 307, 308] as const).map(status => [`/answer/${status}`, () => ({ redirect: '/landing', status, body: 'moved' })])),
    '/answer/chain': () => ({ redirect: '/answer/307', status: 302 }),
    [LOOP[0]]: () => ({ redirect: LOOP[1], status: 302 }),
    [LOOP[1]]: () => ({ redirect: LOOP[2], status: 302 }),
    [LOOP[2]]: () => ({ redirect: LOOP[1], status: 302 }),
    '/answer/to-body': () => ({ redirect: '/landing-body', status: 302 }),
    '/answer/unending': () => ({ redirect: '/landing', status: 302, unending: true }),
    '/answer/to-ftp': () => ({ redirect: 'ftp://127.0.0.1:9/x', status: 307 }),
    '/answer/empty': () => ({ redirect: '', status: 307 }),
    '/answer/fragment': () => ({ redirect: '/landing#frag', status: 302 }),
    '/answer/odd': () => ({ redirect: '/landing{`}', status: 302 }),
    '/answer/backslash-path': () => ({ redirect: '/landing\\b', status: 302 }),
    '/answer/backslash-host': () => ({ redirect: '\\\\other.example/x', status: 302 }),
    '/answer/404-html': () => ({ status: 404, type: 'text/html', body: '<p>gone</p>' }),
    ...Object.fromEntries([200, 300, 404, 500].map(status => [`/answer/${status}`, () => ({ status, type: 'text/plain', body: `answered ${status}` })])),
    '/landing': () => ({ type: 'text/plain', body: LANDING_BODY }),
    '/landing%7B%60%7D': () => ({ type: 'text/plain', body: LANDING_BODY }),
    '/landing-body': () => ({ type: 'text/plain', body: LANDING_BODY, headBody: true }),
    // What /shown's controls read: responses whose layout once grew faster than their size, and honest ones.
    ...Object.fromEntries(shownCases().map(c => [`/shown/${c.name}`, () => ({ type: c.type, body: c.body })])),
  };
}

/**
 * What both clients make of loading each address above, as [address, outcome]. `asked` is the
 * formats requested there, each the first time it is (null for the address as given), and
 * `requests`, when given, how many requests went there. An outcome lists exactly `titles`, or fails
 * with `problem`: 'no answer' names the request that got none, 'turtle' names the Turtle answer kept,
 * which neither client reads without a Turtle parser, 'none readable' names the address, and
 * 'refused' is the problem of the JSON-LD a retry answered. `refused` is that problem as both
 * clients word it (true where each words it its own way, as JSON.parse and Python's json word a
 * syntax error). With `titles`, it means each control listed is unsafe and refused with a problem
 * naming it, and the descriptor names it too. `withTurtle` is the formats asked by a client that
 * reads Turtle (hmc.py with rdflib), which reads that Turtle answer instead.
 */
export type FetchOutcome = { readonly asked: ReadonlyArray<string | null>; readonly withTurtle?: ReadonlyArray<string | null>;
  readonly requests?: number; readonly refused?: string | true }
  & ({ readonly titles: readonly string[] } | { readonly problem: 'no answer' | 'too large' | 'turtle' | 'none readable' | 'refused' });
const REVERSE = 'This document uses @reverse, which this client does not read, so it is not read.';
export const FETCH_CASES: ReadonlyArray<readonly [address: string, outcome: FetchOutcome]> = [
  ['/upgrade-lost', { asked: [null, 'jsonld'], titles: ['Kept markdown read'] }],
  ['/upgrade-lost-ttl', { asked: [null, 'jsonld'], problem: 'turtle', withTurtle: [null, 'jsonld'] }],
  ['/upgrade-redirect', { asked: [null, 'jsonld'], titles: ['Kept markdown read'] }],
  ['/upgrade-error', { asked: [null, 'jsonld'], titles: ['Kept markdown read'] }],
  ['/upgrade-other', { asked: [null, 'jsonld'], titles: ['Kept markdown read'] }],
  ['/upgrade-not-json', { asked: [null, 'jsonld'], titles: ['Kept markdown read'], refused: true }],
  ['/upgrade-repeated', { asked: [null, 'jsonld'], titles: ['Kept markdown read'],
    refused: 'This document repeats the key "hydra:method" in one object, so which value it means is not known, and it is not read.' }],
  ['/upgrade-reverse', { asked: [null, 'jsonld'], titles: ['Kept markdown read'], refused: REVERSE }],
  ['/upgrade-refused-ttl', { asked: [null, 'jsonld'], problem: 'refused', refused: REVERSE, withTurtle: [null, 'jsonld'] }],
  ['/fallback-lost', { asked: [null, 'jsonld'], problem: 'no answer' }],
  ['/not-ok', { asked: [null, 'jsonld'], titles: ['Format read'] }],
  ['/empty-ld', { asked: [null, 'jsonld'], titles: ['Format read'] }],
  ['/separator', { asked: [null, 'jsonld'], titles: ['Format read'] }],
  ['/plainish', { asked: [null, 'jsonld', 'turtle', 'markdown'], problem: 'none readable' }],
  ['/bom', { asked: [null], titles: ['BOM read'] }],
  ['/two-types', { asked: [null], titles: ['Two types read'] }],
  ['/redirect-loop', { asked: [null], problem: 'no answer' }],
  ['/empty-location', { asked: [null, 'jsonld'], requests: 2, titles: ['Format read'] }],
  ['/moved', { asked: [null], titles: ['BOM read'] }],
  ['/named-ttl?format=turtle', { asked: ['turtle', 'jsonld'], titles: ['Named format read'], withTurtle: ['turtle'] }],
  ['/largest-doc', { asked: [null], titles: ['Largest read'] }],
  ['/too-large-doc', { asked: [null], problem: 'too large' }],
  ['/upgrade-too-large', { asked: [null, 'jsonld'], titles: ['Kept markdown read'] }],
];

/**
 * Every /outcomes control invoked by each client, a write confirmed, as [title, the action that
 * names it, the method, the address it sends to, how it ends, and each request the host receives,
 * as "METHOD /path"]. A write goes only to the address its dry run shows: a redirect is not followed
 * to its Location, re-sent there or turned into a GET, so the host receives it once. A GET or HEAD
 * follows a redirect, and the host receives it at each address in turn, with the same method. Where
 * the end is `backslash`, these are hmc.py's requests; the page's browser also sends one to `landed`.
 */
export function invokeOutcomes(base: string): ReadonlyArray<readonly [title: string, rel: string, method: string, url: string, end: InvokeEnd,
  reached: readonly string[]]> {
  return OUTCOMES.map(([title, method, answer, end]) => [title, outcomeRel(title), method, `${base}/answer/${answer}`, end,
    'loop' in end ? Array.from({ length: end.loop }, (_, i) => `${method} ${LOOP[i === 0 ? 0 : 2 - (i % 2)]}`)
      : [`${method} /answer/${answer}`, ...('via' in end && end.via ? end.via : []).map(path => `${method} ${path}`),
        ...(!('backslash' in end) && 'landed' in end && end.landed ? [`${method} ${end.landed}`] : [])]] as const);
}

/**
 * What each client says of an invoke that got an answer, word for word: a 2xx is done. A 301, 302,
 * 303, 307 or 308 that the request did not follow (every write, and every method but GET and HEAD)
 * is not done, in invokeNotFollowed's words. Any other answer is not a success: a 300 or 304, and a
 * redirect with an empty Location answered to a safe GET or HEAD, included. `landed` is where a GET
 * or HEAD that followed a redirect got its answer.
 */
export const invokeDone = (url: string, status: number, landed = url) =>
  `Done: ${url} ${landed === url ? '' : `was redirected to ${landed}, which `}answered ${status}.`;
export const invokeNotSuccess = (url: string, status: number, landed = url) =>
  `Not a success: ${url} ${landed === url ? '' : `was redirected to ${landed}, which `}answered ${status}; only a 2xx answer is a success.`;
/**
 * What each client says when the address a request was sent to answered with a redirect it does
 * not follow, word for word. `status` and `location` are what the client can see: hmc.py sees
 * both, Location resolved against the address; the page, which sends with fetch's redirect:
 * "manual", gets an opaque redirect that shows neither (status null), unless the Location is
 * empty, which Chromium does not read as a redirect, and the page sees its status (location null).
 */
export function invokeNotFollowed(method: string, url: string, status: number | null, location: string | null): string {
  const answered = status === null ? 'answered with a redirect, whose status and Location the browser does not show'
    : location ? `answered ${status}, a redirect to ${location}` : `answered ${status}, a redirect with no Location`;
  // fetch would turn a POST into a GET on a 301 or 302, and anything but a GET or HEAD on a 303.
  const asGet = method !== 'GET' && method !== 'HEAD' && (status === null || status === 303 || (method === 'POST' && (status === 301 || status === 302)));
  return `Not done: ${url} ${answered}. The ${method} was not re-sent${asGet ? ', or turned into a GET' : ''}: ` +
    `a request goes only to the address its dry run shows. Whether ${url} acted on it is not known.`;
}

/**
 * The most of a response either client reads, in bytes: past it the read stops, and nothing of the
 * response is shown, named (RESPONSE_TOO_LARGE), whatever its status says of the request.
 */
export const RESPONSE_MAX = 8 * 1024 * 1024;
export const RESPONSE_TOO_LARGE = `This response is larger than ${RESPONSE_MAX} bytes, so it was not read, and nothing of it is shown.`;
/**
 * What laying out a response of n bytes may add: LAYOUT_PER_BYTE units for each of its bytes, and
 * LAYOUT_FLOOR at least. The page's table of a SPARQL result counts CELL_UNITS for each cell (its
 * head's and each row included) and a unit for each character a cell shows; indenting JSON, in
 * either client, counts each character it adds. Past that the response is shown as its text, as a
 * body neither client recognises is, after a note naming why (tableAsText, jsonAsText).
 */
export const LAYOUT_PER_BYTE = 8;
export const LAYOUT_FLOOR = 10_000;
export const layoutBound = (bytes: number) => Math.max(LAYOUT_FLOOR, LAYOUT_PER_BYTE * bytes);
/**
 * What one cell of the page's table counts beyond the characters it shows: the markup of an empty
 * one, `<td></td>`. A head's cell and a row count as much, so a table has fewer elements than its
 * response has bytes, however few of those bytes it shows.
 */
export const CELL_UNITS = 9;
export const tableAsText = (rows: number, columns: number, bytes: number) =>
  `This result's table would have ${rows} row(s) x ${columns} column(s), more than a response of ${bytes} bytes is shown as; it is shown as text.`;
export const jsonAsText = (added: number, bytes: number) =>
  `This JSON, indented, would add ${added} characters, more than a response of ${bytes} bytes is shown as; it is shown as text.`;

/** How a client shows a response: as a table (the page only), as indented JSON, as its text, or nothing of it. */
export type Shown = 'table' | 'json' | 'text' | 'nothing';
export interface ShownCase {
  readonly name: string; readonly type: string; readonly body: string; readonly bytes: number;
  readonly page: Shown; readonly hmc: Shown; readonly pageNote: string | null; readonly hmcNote: string | null;
}
let shownMemo: ReadonlyArray<ShownCase> | null = null;
/**
 * The answers to /shown's GET controls, at /shown/<name>, with how each client shows each and the
 * note it writes first (null for none). Built once: two are 8 MB.
 *   - sparse: Codex's, a SPARQL result of 1,000 variables and 1,000 empty bindings, whose table the
 *     page built cell by cell, a million of them, 9 MB of markup for 9 KB;
 *   - dense: an honest result of 300 rows and 3 columns, every cell bound, still a table;
 *   - repeated: one row of a result that names one variable 1,000 times and binds it to 20,000
 *     characters, which the table showed in each of the 1,000 columns (20 MB for 26 KB);
 *   - indented: JSON of 40 arrays each nested 255 deep, which indenting wrote as 5 MB for 20 KB;
 *   - too-deep: JSON nested 5,000 deep, which neither client reads as JSON, so it is its text;
 *   - geo: honest GeoJSON, nested seven deep, still indented;
 *   - largest, too-large: text of RESPONSE_MAX bytes, shown, and of one byte more, not read;
 *   - long-names: 50 variables of 4,000 characters and 80,000 empty bindings, 440 KB, which the page
 *     looked up by name in each row, each lookup costing the name's length (24 s);
 *   - long-names-table: 2 variables of 16,000 characters, one no binding names, and a short one,
 *     with 8,000 bindings, whose table fits: each name was looked up in each row, twice;
 *   - padded: 400 variables and 400 empty bindings after 20,000 bytes of whitespace, which the page
 *     built as 160,000 cells, 7 for each byte, the bytes it never shows counted for them.
 * hmc.py shows no table: it writes a SPARQL result as the JSON it is, indented by the same rule.
 */
export function shownCases(): ReadonlyArray<ShownCase> {
  if (shownMemo) return shownMemo;
  const SPARQL = 'application/sparql-results+json';
  const sparql = (vars: readonly string[], bindings: readonly object[]) => JSON.stringify({ head: { vars }, results: { bindings } });
  // What indenting JSON adds: JSON.stringify(value, null, 2) beyond JSON.stringify(value).
  const added = (text: string) => { const v: unknown = JSON.parse(text); return JSON.stringify(v, null, 2).length - JSON.stringify(v).length; };
  const vars = Array.from({ length: 1000 }, (_, i) => `v${i}`);
  // `count` variable names of `length` characters each, told apart by their first characters.
  const named = (count: number, length: number) => Array.from({ length: count }, (_, i) => `v${i}`.padEnd(length, 'n'));
  const dense = Array.from({ length: 300 }, (_, i) => ({ s: { type: 'uri', value: `https://data.example/s/${i}` },
    p: { type: 'uri', value: 'https://data.example/p' }, o: { type: 'literal', value: `value ${i}` } }));
  const geo = { type: 'FeatureCollection', features: Array.from({ length: 20 }, (_, f) => ({ type: 'Feature', properties: { name: `f${f}` },
    geometry: { type: 'Polygon', coordinates: [Array.from({ length: 50 }, (_, i) => [i + 0.5, f + 0.25])] } })) };
  const indented = `[${Array.from({ length: 40 }, () => JSON.stringify(nested(255))).join(',')}]`;
  const none = () => null;
  const build = (name: string, type: string, body: string, page: Shown, hmc: Shown,
    pageNote: (bytes: number) => string | null, hmcNote: (bytes: number) => string | null = pageNote): ShownCase => {
    const bytes = Buffer.byteLength(body);
    return { name, type, body, bytes, page, hmc, pageNote: pageNote(bytes), hmcNote: hmcNote(bytes) };
  };
  shownMemo = [
    build('sparse', SPARQL, sparql(vars, Array(1000).fill({})), 'text', 'json', bytes => tableAsText(1000, 1000, bytes), none),
    build('dense', SPARQL, sparql(['s', 'p', 'o'], dense), 'table', 'json', none),
    build('repeated', SPARQL, sparql(Array(1000).fill('a'), [{ a: { type: 'literal', value: 'x'.repeat(20000) } }]), 'text', 'json',
      bytes => tableAsText(1, 1000, bytes), none),
    build('indented', 'application/json', indented, 'text', 'text', bytes => jsonAsText(added(indented), bytes)),
    build('too-deep', 'application/json', '['.repeat(5000) + ']'.repeat(5000), 'text', 'text', none),
    build('geo', 'application/geo+json', JSON.stringify(geo), 'json', 'json', none),
    build('largest', 'text/plain', 'x'.repeat(RESPONSE_MAX), 'text', 'text', none),
    build('too-large', 'text/plain', 'x'.repeat(RESPONSE_MAX + 1), 'nothing', 'nothing', () => RESPONSE_TOO_LARGE),
    build('long-names', SPARQL, sparql(named(50, 4000), Array(80000).fill({})), 'text', 'json', bytes => tableAsText(80000, 50, bytes), none),
    build('long-names-table', SPARQL, sparql([...named(2, 16000), 's'], Array.from({ length: 8000 }, (_, i) =>
      i < 2 ? { [i ? 's' : named(2, 16000)[1]!]: { type: 'uri', value: `https://data.example/bound/${i}` } } : {})), 'table', 'json', none),
    build('padded', SPARQL, sparql(vars.slice(0, 400), Array(400).fill({})) + ' '.repeat(20000), 'text', 'json',
      bytes => tableAsText(400, 400, bytes), none),
  ];
  return shownMemo;
}
