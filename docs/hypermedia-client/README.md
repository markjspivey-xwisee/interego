# Generic hypermedia client

A descriptor-driven client for Interego / HyperMarkdown / Hydra documents. You give it any authority URL. It discovers every control, builds a form from the advertised fields, resolves the live `hydra:target` at invocation time, and renders the response. Nothing in the client is specific to the I2IDL glossary — that catalog is only the first document it was tested against.

These files live in `docs/hypermedia-client/`. GitHub Pages publishes the `docs/` folder on `master`, and `docs/.nojekyll` is already present, so Jekyll does not rewrite this directory.

## Hosted

Open the web app at:

<https://markjspivey-xwisee.github.io/interego/hypermedia-client/>

The descriptor field is already set to the i2idlx catalog (`https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-catalog`). Click **Load**, or open the page with `?url=` or `?autoload=1` so it fetches immediately:

<https://markjspivey-xwisee.github.io/interego/hypermedia-client/?autoload=1>

`relay.interego.xwisee.com`, `id.i2idl.org`, and `foxxi-bridge.interego.xwisee.com` send `Access-Control-Allow-Origin: *`, so the browser calls them directly. Leave the CORS proxy field empty on the hosted page. The proxy only matters for some other descriptor host that does not send those headers, and `proxy.py` is a local process — it is not part of the Pages site.

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
| `proxy.py` | Optional local static server and CORS proxy |

## How to run

CLI:

```bash
python3 hmc.py list https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-catalog
python3 hmc.py describe URL act-get-scheme
python3 hmc.py invoke URL act-get-scheme
python3 hmc.py invoke URL act-query-glossary   --field query='SELECT (COUNT(?c) AS ?n) WHERE { ?c a <http://www.w3.org/2004/02/skos/core#Concept> }'
python3 hmc.py invoke URL act-rest-listConcepts --field limit=2
python3 hmc.py invoke URL act-propose-mapping --field graph_iri=x --field graph_content='@prefix : <x:> . :a :b :c .'
```

The last command is a dry run: unsafe operations never send unless you pass `--confirm`.

Web app:

```bash
python3 proxy.py --port 8765
# then open http://127.0.0.1:8765/
```

`proxy.py` serves `index.html` and also exposes `GET/POST /proxy?url=...` with `Access-Control-Allow-Origin: *`. You do not need the proxy for the i2idlx catalog or `id.i2idl.org` reads — those hosts already send `Access-Control-Allow-Origin: *`. Use the proxy field in the UI (set it to `/proxy`) when some other descriptor host blocks the browser.

You can also open `index.html` directly as a file, or point any static server at this directory.

Deep link example:

```
index.html?url=https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-catalog&invoke=act-query-glossary&query=SELECT%20(COUNT(%3Fc)%20AS%20%3Fn)%20WHERE%20%7B%20%3Fc%20a%20%3Chttp://www.w3.org/2004/02/skos/core%23Concept%3E%20%7D
```

## How target resolution works

HyperMarkdown projections print a `target` that is often the document's own action junction (`#control-…`). The markdown itself says that projection may be stale and that the signed descriptor is the authority.

The client therefore:

1. Fetches the authority document, preferring JSON-LD (`Accept: application/ld+json`, then `?format=jsonld`), then Turtle, then HyperMarkdown `:::control` blocks.
2. Walks `iep:affordance` / `hmd:control` / `hydra:supportedOperation`, plus any node typed `hydra:Operation`, `iep:Affordance`, or `hmd:Control`.
3. Reads the live `hydra:target`, `hydra:method`, `hydra:expects`, `hydra:returns`, `dcat:mediaType` / `hydra:returnsContentType`, and any linked `hydra:IriTemplate`.
4. Classifies transport:
   - **http** — `hydra:target` is a normal `http(s)` URL, or a `hydra:IriTemplate` expands to one. GET fields with no template are appended as query parameters (this is how SPARQL `?query=` works).
   - **mcp** — `hydra:target` is an Interego tool junction (`https://<interego-relay-host>/tool/...`). A GET of `https://relay.interego.xwisee.com/tool/publish_context` returns HTTP 404 and CORS there is origin-restricted to the relay itself. These writes go through the Interego relay MCP: `invoke_affordance({descriptor_url, action_iri, payload})` or `act({descriptor_url, action_iri, method, payload})`. The client shows that call and does not POST it over raw HTTP.
   - **junction** — the target is still a fragment of the descriptor (markdown-style). The client tells you to use the authority document or MCP `invoke_affordance`.

The Interego `act` kernel verb was verified against `act-get-scheme`: given the catalog URL and that action IRI, it re-resolved `hydra:target` to `https://id.i2idl.org/scheme.ttl` and returned the same Turtle as a direct HTTP GET.

SHACL `NodeShape` property constraints (name, datatype, minCount/maxCount, pattern, defaultValue, maxLength/minLength, description, `sh:in`, min/maxInclusive) become form fields. If `hydra:expects` is an inline JSON Schema object (as on the Foxxi affordance manifest), those properties are used instead. Hydra template variables are merged onto the same fields.

## Safety

- GET / HEAD / OPTIONS are treated as safe and may be sent.
- POST, PUT, PATCH, DELETE, anything with `iep:destructiveHint true`, or `iep:readOnlyHint false` is unsafe.
- Unsafe operations default to a dry run that prints the exact URL, headers, body, and MCP call. The web UI requires an explicit checkbox before Invoke is enabled. The CLI requires `--confirm`.
- Do not live-invoke write controls such as `act-propose-mapping`, `act-ratify`, `act-publish-classified`, `act-align-course-concept`, `write-xapi-statements-signed`, `act-request-upstream-review` (it opens a GitHub issue form), or `coverage-query`.

## CORS

Checked against live responses:

- `https://relay.interego.xwisee.com/ns/...` (catalog and related graphs): `access-control-allow-origin: *` on GET.
- `https://id.i2idl.org/scheme.ttl`, `/sparql`, `/api/v1/concepts`: `access-control-allow-origin: *`.
- `https://foxxi-bridge.interego.xwisee.com/affordances`: `access-control-allow-origin: *`.
- `https://relay.interego.xwisee.com/tool/publish_context`: not a public HTTP resource (GET 404); CORS allow-origin is `https://relay.interego.xwisee.com` only.

So the browser can load the tested catalogs and follow their public HTTP reads without the proxy. The proxy is there for hosts that do not send those headers, and as a one-command way to serve the app.

## What was verified live

Against `https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc/i2idlx-catalog` (authority JSON-LD):

- **list** discovered 50 operations: 25 GET affordances, 9 HEAD and 9 OPTIONS companions on the REST resources (present in the signed descriptor, omitted from the markdown projection), and 7 POST operations. The five ODRL policy nodes in the same graph are not treated as controls.
- **act-get-scheme** → `GET https://id.i2idl.org/scheme.ttl` → HTTP 200 `text/turtle`. `gs:publicationVersion` `v0.0.93`; title "I2IDL Glossary of Digital Learning".
- **act-query-glossary** with `SELECT (COUNT(?c) AS ?n) WHERE { ?c a <http://www.w3.org/2004/02/skos/core#Concept> }` → `GET https://id.i2idl.org/sparql?query=...` → HTTP 200, `n = 420`.
- **act-rest-listConcepts** `--field limit=2` → expanded `https://id.i2idl.org/api/v1/concepts{?q,field,type,source,collection,limit,offset}` to `https://id.i2idl.org/api/v1/concepts?limit=2&offset=0` → HTTP 200, `total: 420`, first items `a-b-testing` and `about-resource`.
- **act-propose-mapping** was only dry-run. Transport: MCP. Declared target `https://relay.interego.xwisee.com/tool/publish_context`. Defaults filled `modal_status=Hypothetical`, `visibility=shared`, `conforms_to_shapes=.../i2idlx-shapes`. Nothing was sent.

Against the catalog's `rdfs:seeAlso` link `https://foxxi-bridge.interego.xwisee.com/affordances` (a compacted JSON-LD manifest, 166 affordances):

- **list** found 16 GET and 150 POST controls from embedded `affordances` and JSON Schema `expects` objects.
- **urn:iep:action:foxxi:discover-lrs** → `GET https://foxxi-bridge.interego.xwisee.com/xapi/about` → HTTP 200, xAPI versions `2.0.0` through `1.0.0`.

Interego MCP `act({descriptor_url, action_iri})` for `act-get-scheme` independently resolved the same `hydra:target` (`https://id.i2idl.org/scheme.ttl`) and returned the same Turtle.

Not live-invoked: any write (`propose-mapping`, `ratify`, `publish-classified`, `align-course-concept`, `write-xapi-statements-signed`, `coverage-query`) and `act-request-upstream-review` (GET that opens a GitHub new-issue form). SPARQL POST was also not sent; the SELECT was run via the GET form.
