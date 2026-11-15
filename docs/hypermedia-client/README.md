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

The last command is a dry run: unsafe operations never send unless you pass `--confirm`. Its values have to satisfy the shape the catalog publishes: on 2026-11-15 that asked for a `graph_content` of at least 40 characters. Both clients check a shape's required fields, lengths, ranges and enumerations before they plan a request, and leave patterns to the server.

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
2. Walks `iep:affordance` / `hmd:control` / `hydra:supportedOperation`, plus any node typed `hydra:Operation`, `iep:Affordance`, or `hmd:Control`.
3. Reads the live `hydra:target`, `hydra:method`, `hydra:expects`, `hydra:returns`, `dcat:mediaType` / `hydra:returnsContentType`, and any linked `hydra:IriTemplate`.
4. Classifies transport:
   - **http** — `hydra:target` is a normal `http(s)` URL, or a `hydra:IriTemplate` expands to one. GET fields with no template are appended as query parameters (this is how SPARQL `?query=` works).
   - **mcp** — `hydra:target` is an Interego tool junction (`https://<interego-relay-host>/tool/...`). A GET of `https://relay.interego.xwisee.com/tool/publish_context` returns HTTP 404 and CORS there is origin-restricted to the relay itself. These writes go through the Interego relay MCP: `invoke_affordance({descriptor_url, action_iri, payload})` or `act({descriptor_url, action_iri, method, payload})`. The client shows that call and does not POST it over raw HTTP.
   - **junction** — the target is still a fragment of the descriptor (markdown-style). The client tells you to use the authority document or MCP `invoke_affordance`.

The Interego `act` kernel verb was verified against `act-get-scheme`: given the catalog URL and that action IRI, it re-resolved `hydra:target` to `https://id.i2idl.org/scheme.ttl` and returned the same Turtle as a direct HTTP GET.

SHACL `NodeShape` property constraints (name, datatype, minCount/maxCount, pattern, defaultValue, maxLength/minLength, description, `sh:in`, min/maxInclusive) become form fields. A `pattern` is shown next to its field and left to the server to enforce: neither client runs a regular expression from a remote document, because a crafted one can take time exponential in the input. If `hydra:expects` is an inline JSON Schema object (as on the Foxxi affordance manifest), those properties are used instead. Hydra template variables are merged onto the same fields.

JSON Schema `object` and `array` properties, SHACL properties with `sh:node` or `sh:nodeKind sh:BlankNode`, and `rdf:JSON` datatypes are parsed as JSON. A field such as Foxxi's `document` or `concept_ids` is sent as a real object or array in a JSON body, and a list is expanded as an RFC 6570 list when it fills a URI template. Other fields stay strings.

URI templates use RFC 6570 percent-encoding of UTF-8 (`encodeURIComponent` semantics). `café` becomes `caf%C3%A9`. A `+` operator still leaves ASCII reserved characters unescaped.

## Safety

- GET / HEAD / OPTIONS are treated as safe and may be sent.
- POST, PUT, PATCH, DELETE, anything with `iep:destructiveHint true`, or `iep:readOnlyHint false` is unsafe.
- Unsafe operations default to a dry run that prints the exact URL, headers, body, and MCP call. The web UI requires an explicit checkbox before Invoke is enabled. The CLI requires `--confirm`.
- The web app shows everything a remote document or response contains as text. An HTML response is shown as source, not rendered. Only an `https` URL becomes followable, and following one fetches it as a descriptor; an `http` IRI is shown as text. Nothing a remote document sends becomes a link the browser navigates, a script, a style, an event handler, or a form field's `name`.
- The page sends requests over `https` only, with or without a proxy, and does not hand a proxy an internal address (see [The proxy field](#the-proxy-field)).
- Next to **Invoke**, the page names the host the control sends to (or says that a template decides it, and the dry run shows where).
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
