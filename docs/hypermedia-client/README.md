# Generic hypermedia client

A descriptor-driven client for Interego / HyperMarkdown / Hydra documents. You give it any authority URL. It discovers every control, builds a form from the advertised fields, resolves the live `hydra:target` at invocation time, and renders the response. Nothing in the client is specific to the I2IDL glossary — that catalog is only the first document it was tested against.

These files live in `docs/hypermedia-client/`. GitHub Pages publishes the `docs/` folder on `master`, and `docs/.nojekyll` is already present, so Jekyll does not rewrite this directory.

## Hosted

Open the web app at:

<https://markjspivey-xwisee.github.io/interego/hypermedia-client/>

The descriptor field is already set to the i2idlx catalog (`https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-catalog`). Click **Load**, or open the page with `?url=` or `?autoload=1` so it fetches immediately:

<https://markjspivey-xwisee.github.io/interego/hypermedia-client/?autoload=1>

`relay.interego.xwisee.com`, `id.i2idl.org`, and `foxxi-bridge.interego.xwisee.com` sent `Access-Control-Allow-Origin: *` when they were checked on 2026-11-09, so the browser calls them directly. Leave the CORS proxy field empty on the hosted page. It only matters for some other descriptor host that does not send those headers, and then it takes a proxy you run yourself (see [The proxy field](#the-proxy-field)).

Unsafe operations stay a dry run until you check **I confirm this write**. The same `?url=` deep links work on the hosted page, for example:

```
https://markjspivey-xwisee.github.io/interego/hypermedia-client/?url=https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-catalog&invoke=act-query-glossary&query=SELECT%20(COUNT(%3Fc)%20AS%20%3Fn)%20WHERE%20%7B%20%3Fc%20a%20%3Chttp://www.w3.org/2004/02/skos/core%23Concept%3E%20%7D
```

That link runs a safe SPARQL GET. Do not add a write control to `invoke` without meaning to send it, and do not pass anything that would check the confirmation box — the page never confirms a write from the query string.

## Files

| Path | Role |
| --- | --- |
| `index.html` | Self-contained web app (HTML + JS, no build step) |
| `hmc.py` | Python library + CLI |

## How to run

CLI:

```bash
python3 hmc.py list https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-catalog
python3 hmc.py describe URL act-get-scheme
python3 hmc.py invoke URL act-get-scheme
python3 hmc.py invoke URL act-query-glossary   --field query='SELECT (COUNT(?c) AS ?n) WHERE { ?c a <http://www.w3.org/2004/02/skos/core#Concept> }'
python3 hmc.py invoke URL act-rest-listConcepts --field limit=2
python3 hmc.py invoke URL act-propose-mapping --field graph_iri=x --field graph_content='@prefix : <urn:x:> . :subject :predicate :object .'
```

The last command is a dry run: unsafe operations never send unless you pass `--confirm`. Its values have to satisfy the shape the catalog publishes: on 2026-11-15 that asked for a `graph_content` of at least 40 characters. Both clients check a shape's required fields, lengths, ranges and enumerations, and that a number field holds a number of its type, before they plan a request, and leave patterns to the server. A number field's enumeration is checked by value, so `1` matches an entry written `1.0`. An integer or decimal that a JSON number would change is refused rather than rounded (the page's integers stop at 2^53); a double or float field takes the double nearest what was typed.

Web app: use the hosted page, open `index.html` directly as a file, or point any static server at this directory. There is no build step and nothing to install.

The web app reads JSON-LD and HyperMarkdown, not Turtle. When a host answers in Turtle, the page asks it again with `?format=jsonld`. For a host that serves only Turtle, use `hmc.py`, which reads Turtle when `rdflib` is installed.

Deep link example:

```
index.html?url=https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-catalog&invoke=act-query-glossary&query=SELECT%20(COUNT(%3Fc)%20AS%20%3Fn)%20WHERE%20%7B%20%3Fc%20a%20%3Chttp://www.w3.org/2004/02/skos/core%23Concept%3E%20%7D
```

### The proxy field

The proxy field is optional, and it is empty unless you type into it. The page never fills it from its own address, so a link cannot route your requests through someone else's server.

It takes the absolute `https://` URL of a CORS proxy you run yourself. The page sends each request to that URL with the target appended as a `url` query parameter (`<proxy>?url=<encoded target>`, or `&url=` when the proxy URL already has a query). Use it only for a descriptor host that does not send `Access-Control-Allow-Origin`.

The targets the page hands a proxy are the ones it would fetch without one: `https` URLs only. It also never hands a proxy a loopback, private, link-local or shared address written as a literal, or a `localhost` name, because a proxy on your own machine can reach those and the page cannot. A public name that resolves to such an address is not caught by the page; only the proxy sees the address a name resolves to, so a proxy you run should refuse those itself.

A proxy sees every request sent through it, including the body of any write you confirm. Use one you control.

This directory used to ship a local forwarding proxy, `proxy.py`. It was removed: a server that fetches whatever URL it is handed has to defend every address it can reach, and the hosted page does not need one for the hosts it was written against.

## How target resolution works

HyperMarkdown projections print a `target` that is often the document's own action junction (`#control-…`). The markdown itself says that projection may be stale and that the signed descriptor is the authority.

The client therefore:

1. Fetches the authority document, preferring JSON-LD (`Accept: application/ld+json`, then `?format=jsonld`), then Turtle (read by `hmc.py` when `rdflib` is installed; the page cannot parse it), then HyperMarkdown `:::control` blocks.
2. Walks `iep:affordance` / `hmd:control` / `hydra:supportedOperation` / `hydra:operation`, plus any node typed `hydra:Operation`, `iep:Affordance`, or `hmd:Control`, wherever the document puts it: at the top, in `@graph` (and a named graph's `@graph` within it), in `@included`, or in an `@index` or `@id` map.
3. Reads the live `hydra:target`, `hydra:method`, `hydra:expects`, `hydra:returns`, `dcat:mediaType` / `hydra:returnsContentType`, and any linked `hydra:IriTemplate`. Every IRI in a JSON-LD document, each `@id` and each value of a term its context types as `@id` or `@vocab`, is expanded first, through the document's prefixes and `@vocab`, and a relative one is resolved against the context's `@base` or else the address the document was fetched from. So `{"@id": "/api"}` is an address on the descriptor's host, and `{"@id": "xsd:integer"}` is XSD's integer. The context is read as JSON-LD 1.1 reads it: keyword aliases (`"id": "@id"`), properties nested under `@nest`, a term defined before the prefix it uses, a term with no `@id` under `@vocab`, a node's own `@context` and a term's or type's scoped one, container maps, and `@json` value objects. The base is the address the document landed at after redirects, so `/dir` answered from `/dir/` puts `items` at `/dir/items`; after a 303 See Other `hmc.py` keeps the address it asked for, as JSON-LD says, and the page, which cannot tell a 303 from another redirect, uses where it landed. Resolution follows RFC 3986 on the text as written, so an IRI keeps its non-ASCII characters and `"@vocab": "#"` keeps its `#`; a request carries the URI form, written as a URL parser writes it (see [Safety](#safety)). A document with more `@context` work than a fixed budget is refused rather than read slowly, and no other shape of document makes reading it cost more than its size: a node many nodes name, a template or shape many controls share and a class many nodes name are each read once, and a control's fields are built when it is opened or invoked.
4. Classifies transport:
   - **http** — `hydra:target` is a normal `http(s)` URL, or a `hydra:IriTemplate` (written as the `hydra:target` itself, as Interego's decoration catalogs do, or reached by `hydra:search`) expands to one. A relative template resolves against the base. A GET sends no body: its fields go in the query, and a field that is a whole request body goes there as a parameter named after it (this is how SPARQL `?query=` works). A body sent whole is labelled by its own type (JSON, a SPARQL query, or plain text); the control's media type is what it returns and goes in `Accept`.
   - **mcp** — `hydra:target` is an Interego tool junction (`https://<interego-relay-host>/tool/...`). A GET of `https://relay.interego.xwisee.com/tool/publish_context` returns HTTP 404 and CORS there is origin-restricted to the relay itself. These writes go through the Interego relay MCP: `invoke_affordance({descriptor_url, action_iri, payload})` or `act({descriptor_url, action_iri, method, payload})`. The client shows that call and does not POST it over raw HTTP.
   - **junction** — the target is a fragment of the descriptor itself, whether written `#control-…` or in full; once resolved, the two are the same IRI. The client tells you to use the authority document or MCP `invoke_affordance`.

The Interego `act` kernel verb was verified against `act-get-scheme`: given the catalog URL and that action IRI, it re-resolved `hydra:target` to `https://id.i2idl.org/scheme.ttl` and returned the same Turtle as a direct HTTP GET.

SHACL `NodeShape` property constraints (name, datatype, minCount/maxCount, pattern, defaultValue, maxLength/minLength, description, `sh:in` as a plain array, an RDF list or a JSON-LD `@list`, min/maxInclusive) become form fields, and so does each `hydra:supportedProperty` of a `hydra:Class` (named by its property's IRI, or by the label of a property written in place, as Interego's manifests write one). A SHACL property with no `sh:maxCount`, or one above 1, takes a list, as Interego's own shapes mean it (a single value carries `sh:maxCount 1`): on the page one value per line or a JSON array, or a multiple select when it has choices; in `hmc.py` the `--field` repeated. It is sent as a JSON array, or as an RFC 6570 list in a template, and its count is checked against `sh:minCount` and `sh:maxCount`. A field that takes one value takes the last one given. A name that is no field's is refused, not dropped, and a control with two fields of one name is not invoked. A `pattern` is shown next to its field and left to the server to enforce: neither client runs a regular expression from a remote document, because a crafted one can take time exponential in the input. If `hydra:expects` is an inline JSON Schema object (as on the Foxxi affordance manifest), those properties are used instead. Hydra template variables are merged onto the same fields.

JSON Schema `object` and `array` properties, SHACL properties with `sh:node` or `sh:nodeKind sh:BlankNode`, and `rdf:JSON` datatypes are parsed as JSON; a node shape whose own datatype is `rdf:JSON` takes a request body that must parse as JSON, and sends it as written. A field such as Foxxi's `document` or `concept_ids` is sent as a real object or array in a JSON body, and a list is expanded as an RFC 6570 list when it fills a URI template. Other fields stay strings.

URI templates use RFC 6570 percent-encoding of UTF-8 (`encodeURIComponent` semantics). `café` becomes `caf%C3%A9`. A `+` operator still leaves ASCII reserved characters unescaped.

## Fail closed

Both clients read the JSON-LD forms they model and refuse the rest. They never act on the first of several values, and never skip a form they do not read.

- Everything that decides what a control does is read with all its values, merged descriptions of one `@id` included: `hydra:method`, `hydra:target`, `hydra:template`, `iep:action`, the hints, `hydra:expects`, the media type, a template mapping's variable, property and `hydra:required`, and an input's `sh:path`, `sh:name`, `sh:datatype`, counts, lengths, `sh:pattern`, `sh:in`, `sh:defaultValue` and bounds. More than one distinct value, or a value in a form not read there (a `@list`, a JSON literal, a node written in place with no `@id`, a malformed RDF list, a count that is not a whole number), lists the control with the writes and refuses it with a problem that names the property.
- A title, label or description is only shown, so the first value that reads as one is shown.
- Read: node objects and `@id` references; value objects with `@type`, `@language` or `@direction`; a `@json` schema under `hydra:expects`; keyword aliases, `@nest`, embedded and scoped contexts and container maps; a `@set` object anywhere, as what it holds; a `@list` or graph object where operations, a shape's properties or a template's mappings go, as its members; a `@list` under `sh:in`; `@graph` and `@included` at the top or inside another `@graph`. A remote `@context` is not fetched: the clients' own names for Hydra and Interego terms stand in for it.
- Refused whole, with the problem named: `@reverse`; a `@graph` or `@included` inside a node; a `@set` object with another key; a keyword given twice in one node, through an alias or a `@nest`; another keyword inside a `@nest`; and a key repeated in one JSON object.
- A HyperMarkdown block that gives `rel`, `method`, `target`, `expects`, `mediaType` or `fields` twice is refused. A name that matches two controls, a link with two `url` or `invoke` parameters, and values given under two names of one input are refused too.

## Safety

- GET / HEAD / OPTIONS are treated as safe and may be sent.
- POST, PUT, PATCH, DELETE, anything with `iep:destructiveHint true`, or `iep:readOnlyHint false` is unsafe. So is a control that names no method: it is a POST, as the substrate's own follower sends it. Every value of a hint counts: a `destructiveHint` true or `readOnlyHint` false under any prefix, in an object written directly inside the control (MCP's `annotations`), or in a HyperMarkdown block makes it unsafe, and so does a hint that is not a boolean (`true`, `false`, `1`, `0` or an `xsd:boolean` literal). True and false together refuse it. Neither hint ever makes a control safe.
- Unsafe operations default to a dry run that prints the exact URL, headers, body, and MCP call. The web UI requires an explicit checkbox before Invoke is enabled. The CLI requires `--confirm`.
- The URL a dry run shows is the one sent, as the URL Standard's parser writes it: lower-case scheme and host, no default port, dot segments removed (`%2e%2e` is `..` to the parser), the characters it percent-encodes encoded, no fragment, and fields added to the query as `URLSearchParams` writes them (`~` as `%7E`, `*` as it is). The page has the browser's parser write it; `hmc.py` writes the same string. An address a parser reads differently from its text is refused before anything is sent: one with a backslash, a space or a control character; `http(s):` with no `//` before the host; user information before an `@`; a host that is neither a name of letters, digits, `.`, `-` and `_` nor a bracketed IPv6 address; a port that is not a number up to 65535; or a host written as a number in any form other than four decimal parts (`0x7f.1`, `2130706433`). `hmc.py` also refuses a host with ß, ς, ZWJ or ZWNJ, which Python's IDNA 2003 sends to another domain than a browser does (`straße.example` is `strasse.example` to one and `xn--strae-oqa.example` to the other).
- The web app shows everything a remote document or response contains as text. An HTML response is shown as source, not rendered. Only an `https` URL becomes followable, and following one fetches it as a descriptor; an `http` IRI is shown as text. Nothing a remote document sends becomes a link the browser navigates, a script, a style, an event handler, or a form field's `name`.
- The page sends requests over `https` only, with or without a proxy, and does not hand a proxy an internal address (see [The proxy field](#the-proxy-field)).
- Next to **Invoke**, the page names the host the control sends to, or says that a template decides it when a template variable comes before the host is complete, and the dry run shows where. A named host is checked against the address before anything is sent.
- The page does not run inside another page's frame. Open it in a tab of its own.
- A control that cannot be drawn shows a warning and no form, and a form only ever invokes the control it was built for.
- `hmc.py` sends requests to `http` and `https` URLs only, and follows a redirect only to another of those. A descriptor that names a `file:`, `ftp:` or `data:` URL, or a redirect to one, is refused before anything is read.
- In text mode, `hmc.py` shows control characters in remote text as `\xNN` escapes, so a document cannot send the terminal control sequences. `--json` output escapes them as JSON does.
- The page carries a Content-Security-Policy: no source by default, its own inline script and stylesheet allowed by SHA-256 hash only, no inline event handlers, `connect-src https:`, and `object-src`, `base-uri` and `form-action` set to `'none'`. Editing the inline script or `<style>` changes its hash, so the policy has to be updated with it; `tests/hypermedia-client-rendering.test.ts` fails and prints the expected hash when they disagree. That test also loads the page with hostile documents and responses and checks what reaches the DOM.
- Do not live-invoke write controls such as `act-propose-mapping`, `act-ratify`, `act-publish-classified`, `act-align-course-concept`, `write-xapi-statements-signed`, `act-request-upstream-review` (it opens a GitHub issue form), or `coverage-query`.

## CORS

Checked against live responses on 2026-11-09:

- `https://relay.interego.xwisee.com/ns/...` (catalog and related graphs): `access-control-allow-origin: *` on GET.
- `https://id.i2idl.org/scheme.ttl`, `/sparql`, `/api/v1/concepts`: `access-control-allow-origin: *`.
- `https://foxxi-bridge.interego.xwisee.com/affordances`: `access-control-allow-origin: *`.
- `https://relay.interego.xwisee.com/tool/publish_context`: not a public HTTP resource (GET 404); CORS allow-origin is `https://relay.interego.xwisee.com` only.

So the browser can load the tested catalogs and follow their public HTTP reads without a proxy. A host that does not send those headers needs a CORS proxy you run yourself (see [The proxy field](#the-proxy-field)).

## What was verified live

These results are from 2026-11-09, when the client was written. The catalog and the Foxxi manifest have changed since, so the counts below are a record of that day, not of today; `python3 hmc.py list URL` gives the current numbers.

Against `https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-catalog` (authority JSON-LD):

- **list** discovered 50 operations: 25 GET affordances, 9 HEAD and 9 OPTIONS companions on the REST resources (present in the signed descriptor, omitted from the markdown projection), and 7 POST operations. The five ODRL policy nodes in the same graph are not treated as controls.
- **act-get-scheme** → `GET https://id.i2idl.org/scheme.ttl` → HTTP 200 `text/turtle`. `gs:publicationVersion` `v0.0.93`; title "I2IDL Glossary of Digital Learning".
- **act-query-glossary** with `SELECT (COUNT(?c) AS ?n) WHERE { ?c a <http://www.w3.org/2004/02/skos/core#Concept> }` → `GET https://id.i2idl.org/sparql?query=...` → HTTP 200, `n = 420`.
- **act-rest-listConcepts** `--field limit=2` → expanded `https://id.i2idl.org/api/v1/concepts{?q,field,type,source,collection,limit,offset}` to `https://id.i2idl.org/api/v1/concepts?limit=2&offset=0` → HTTP 200, `total: 420`, first items `a-b-testing` and `about-resource`.
- **act-propose-mapping** was only dry-run. Transport: MCP. Declared target `https://relay.interego.xwisee.com/tool/publish_context`. Defaults filled `modal_status=Hypothetical`, `visibility=shared`, `conforms_to_shapes=.../i2idlx-shapes`. Nothing was sent.

Against the catalog's `rdfs:seeAlso` link `https://foxxi-bridge.interego.xwisee.com/affordances` (a compacted JSON-LD manifest, 166 affordances on that date):

- **list** found 16 GET and 150 POST controls from embedded `affordances` and JSON Schema `expects` objects.
- **urn:iep:action:foxxi:discover-lrs** → `GET https://foxxi-bridge.interego.xwisee.com/xapi/about` → HTTP 200, xAPI versions `2.0.0` through `1.0.0`.

Interego MCP `act({descriptor_url, action_iri})` for `act-get-scheme` independently resolved the same `hydra:target` (`https://id.i2idl.org/scheme.ttl`) and returned the same Turtle.

Not live-invoked: any write (`propose-mapping`, `ratify`, `publish-classified`, `align-course-concept`, `write-xapi-statements-signed`, `coverage-query`) and `act-request-upstream-review` (GET that opens a GitHub new-issue form). SPARQL POST was also not sent; the SELECT was run via the GET form.
