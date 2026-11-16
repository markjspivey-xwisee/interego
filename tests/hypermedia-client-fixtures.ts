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

/** Each path's document as the text served. */
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
      op('j', 'urn:values:json', 'POST', 'JSON value', { ...target('/num-target'), 'hydra:expects': { '@id': '#J' } }),
      op('b', 'urn:values:body', 'POST', 'JSON body', { ...target('/num-target'), 'hydra:expects': { '@id': '#B' } }),
      op('d', 'urn:values:default', 'POST', 'Large default', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { report: { type: 'object', default: { score: 'LARGE-SCORE' } } } } }),
      op('l', 'urn:values:length', 'POST', 'Schema lengths', { ...target('/num-target'), 'hydra:expects': { type: 'object',
        properties: { one: { type: 'string', maxLength: 1 }, two: { type: 'string', minLength: 2 } } } }),
      op('s', 'urn:values:shacl-length', 'POST', 'Shape lengths', { ...target('/num-target'), 'hydra:expects': { '@id': '#L' } }),
    ], '@graph': [
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
        { 'sh:path': { '@id': 'urn:p:picks' }, 'sh:name': 'picks', 'sh:in': ['x', 'y', 'z'], 'sh:defaultValue': ['z', 'w', 'x'] }] },
    ] },
  };
  // JSON.stringify writes 1.0 as 1, so the 1.0 is put in the text by hand.
  const out = Object.fromEntries(Object.entries(docs).map(([path, doc]) => [path, JSON.stringify(doc).replace('"ONE-POINT-ZERO"', '1.0')
    .replace('"REQUIRED-ONE"', '1.0')]));
  // JSON.stringify writes no number past a double, so the 1e400 is put in the text by hand. JSON's
  // grammar allows it, and both clients read it as an infinity.
  out['/values'] = out['/values']!.replace('"LARGE-SCORE"', '1e400').replace('"BIG-TEXT-DEFAULT"', `1${'0'.repeat(30)}`)
    .replace('"LARGE-BOUND"', `1${'0'.repeat(399)}`).replace('"TWO-POINT-ZERO"', '2.0').replace('"PAST-SAFE"', '9007199254740993');
  // JSON.stringify writes each key once, so a repeated key is put in the text by hand: JSON leaves
  // its meaning open, and a reader that takes the last "hydra:method" takes GET.
  out['/repeated-key'] = JSON.stringify({ '@context': CTX, '@id': `${base}/repeated-key`, 'iep:affordance': [
    op('d', 'urn:repeat:delete', 'DELETE', 'Repeated method', target('/thing'))] }).replace('"hydra:method":"DELETE"', '"hydra:method":"DELETE","hydra:method":"GET"');
  // NaN is not JSON: the page's JSON.parse refuses it, and hmc.py, whose json.loads would read it, does too.
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
      'fields: [{"name": "a", "defaultValue": "\\ud800"}]', ':::', ''].join('\n'),
  };
}

/** Documents each client refuses whole, as [path, the problem it names]; nothing is listed or sent. */
export const DOCUMENT_REFUSALS: ReadonlyArray<readonly [path: string, problem: string]> = [
  ['/nested-graph', 'This document holds a @graph inside a node, which this client does not read, so it is not read.'],
  ['/nested-included', 'This document holds @included inside a node that is not at its top or in a @graph, which this client does not read, so it is not read.'],
  ['/reverse', 'This document uses @reverse, which this client does not read, so it is not read.'],
  ['/set-extra', 'This document has a @set object with a key other than @set and @index, which JSON-LD does not allow, so it is not read.'],
  ['/colliding', 'This document gives one node @id twice, which JSON-LD does not allow, so it is not read.'],
  ['/nest-id', 'This document gives one node @id twice, which JSON-LD does not allow, so it is not read.'],
  ['/repeated-key', 'This document repeats the key "hydra:method" in one object, so which value it means is not known, and it is not read.'],
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
    // A JSON integer past 2^53 is the double nearest it, as JSON.parse reads it, in an object and in
    // a list alike; the double is written as JavaScript writes it.
    ['/values', 'urn:values:query', { filter: '{"c":12345678901234567890}' },
      { url: `${base}/num-target?${new URLSearchParams({ filter: '{"c":12345678901234567000}' })}`, body: null }],
    ['/values', 'urn:values:list', { tags: '[1000000000000000000000000000000, 9007199254740993]' },
      { url: `${base}/num-target?tags=1e%2B30&tags=9007199254740992`, body: null }],
    ['/values', 'urn:values:list', { short: `[1${'0'.repeat(30)}]` }, { url: `${base}/num-target?short=1e%2B30`, body: null }],
    ['/values', 'urn:values:list', { counts: '[1.0, 2]' }, { url: `${base}/num-target?counts=1&counts=2`, body: null }],
    ['/required-text', 'urn:required:spaced', {}, { error: "missing required field 'q'" }],
    ['/required-text', 'urn:required:whole', {}, { error: "missing required field 'q'" }],
    ['/required-text', 'urn:required:nbsp', {}, { url: `${base}/api`, body: null }],
  ];
}

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
 *     defaults are one per line, or the options a multiple choice selects;
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
  // A text field's default that is not a string is its text, as the form holds it; a JSON integer
  // past 2^53 is the double nearest it; an integer field's default of 2.0 is 2, and one past 2^53
  // cannot be sent exactly; a bound no double holds is none, and a list's number past a double is
  // not a number.
  ['/values', 'urn:values:text-default', 'Text defaults', {}, { body: { big: '1e+30', small: '5', flag: 'true', object: '{"a":[1]}' } }],
  ['/values-md', 'hm-big-default', 'Big text default', {}, { body: { a: '1e+30' } }],
  ['/values', 'urn:values:whole-default', 'Whole default', {}, { body: { n: 2 } }],
  ['/values', 'urn:values:unsafe-default', 'Past 2^53 default', {}, { error: 'n: integer too large to send exactly' }],
  ['/values', 'urn:values:bound', 'Large bound', { amount: '5' }, { body: { amount: 5 } }],
  ['/values', 'urn:values:list', 'List values', { nums: `[1${'0'.repeat(400)}]` }, { error: 'nums: not a number' }],
  ['/values', 'urn:values:list', 'List values', { counts: '[1, 9007199254740993]' }, { error: 'counts: integer too large to send exactly' }],
  // A list's defaults are what the form holds: one per line, or the options a multiple choice
  // selects, in the options' order.
  ['/values', 'urn:values:list-default', 'List defaults', {}, { body: { lines: ['a', 'b', 'c'], picks: ['x', 'z'] } }],
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

/**
 * Confirmed writes whose body each client sends as the page's JSON.stringify(values, null, 2) writes
 * it, byte for byte, as [path, action, title, fields, the body sent]: each number as JavaScript
 * writes it (1.0 as 1, 1e-7 and 0.000001 as they are, -0 as 0, 2^53 + 1 and a 20-digit integer as
 * the double nearest each) and an object's array-index keys first, in numeric order.
 */
export const BODY_TEXTS: ReadonlyArray<readonly [path: string, action: string, title: string, fields: Record<string, string>, body: string]> = [
  ['/values', 'urn:values:object', 'Object value', { document: '{"b":1.0,"a":1e-7,"c":-0.0,"2":[1E2,{}],"1":12345678901234567890,"d":[]}' },
    '{\n  "document": {\n    "1": 12345678901234567000,\n    "2": [\n      100,\n      {}\n    ],\n    "b": 1,\n    "a": 1e-7,\n' +
    '    "c": 0,\n    "d": []\n  }\n}'],
  ['/values', 'urn:values:json', 'JSON value', { data: '[0.000001,1e21,-1e-7,9007199254740993]' },
    '{\n  "data": [\n    0.000001,\n    1e+21,\n    -1e-7,\n    9007199254740992\n  ]\n}'],
];

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
 *     node listed again.
 */
export const COST_CASES: ReadonlyArray<readonly [path: string, rel: string, controls: number, fields: number]> = [
  ['/cost/harvest', 'urn:op5', 1501, 0], ['/cost/shape', 'urn:c399', 400, 400], ['/cost/template', 'urn:c399', 400, 400],
  ['/cost/mappings', 'urn:c', 1, 8000], ['/cost/class', 'urn:op5', 1500, 0],
];

/** Each COST_CASES path's document as the text served; build it once per test file. */
export function costDescriptors(base: string): Record<string, string> {
  const get = (rel: string, title: string, extra: Record<string, unknown> = {}) =>
    ({ 'iep:action': { '@id': rel }, 'hydra:method': 'GET', 'hydra:title': title, 'hydra:target': { '@id': `${base}/api` }, ...extra });
  const range = (n: number) => Array.from({ length: n }, (_, i) => i);
  const props = (n: number) => range(n).map(j => ({ 'sh:path': { '@id': `urn:p${j}` }, 'sh:name': `p${j}`, 'sh:maxCount': 1 }));
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
  };
  return Object.fromEntries(Object.entries(docs).map(([path, doc]) => [path, JSON.stringify(doc)]));
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
  ];
}
