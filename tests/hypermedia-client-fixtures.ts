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
  };
  // JSON.stringify writes 1.0 as 1, so the 1.0 is put in the text by hand.
  return Object.fromEntries(Object.entries(docs).map(([path, doc]) => [path, JSON.stringify(doc).replace('"ONE-POINT-ZERO"', '1.0')]));
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
