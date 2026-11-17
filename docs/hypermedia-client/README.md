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

The address the page sends to through a proxy is the proxy's, so a dry run shows it as `via`, next to the target's `url`. A proxy may also follow a redirect itself, which the page cannot see or stop: a write sent through one that does may be re-sent to another address. The page sends a write with `redirect: "manual"` either way (see [Writes go where they say](#writes-go-where-they-say)), so a redirect the proxy passes back is reported as not done, but only a proxy that does not follow redirects keeps a write at the address shown.

This directory used to ship a local forwarding proxy, `proxy.py`. It was removed: a server that fetches whatever URL it is handed has to defend every address it can reach, and the hosted page does not need one for the hosts it was written against.

## How target resolution works

HyperMarkdown projections print a `target` that is often the document's own action junction (`#control-…`). The markdown itself says that projection may be stale and that the signed descriptor is the authority.

The client therefore:

1. Fetches the authority document, preferring JSON-LD (`Accept: application/ld+json`, then `?format=jsonld`), then Turtle (read by `hmc.py` when `rdflib` is installed; the page cannot parse it), then HyperMarkdown `:::control` blocks. Both clients take the same steps:
   - An answer counts when its status is 2xx and its body, read as `fetch` reads one (UTF-8 with a byte order mark dropped, and two `Content-Type` headers joined by `, `), is JSON-LD, Turtle or HyperMarkdown. A 3xx with no `Location`, or an empty one, is not followed, as a browser does not follow it, so it is an answer that does not count.
   - An answer that counts but is not JSON-LD is asked for again as `?format=jsonld`, unless the address names a format the client reads (`hmc.py` without `rdflib`, like the page, asks again for one that names Turtle). That retry is optional: when it gets no answer, or answers anything but 2xx JSON-LD, the first answer is read as if the retry had not been asked. JSON-LD it answers is the authority for the first answer, so when the client refuses it (see [Fail closed](#fail-closed)) the first answer is still listed, but not read as safe: the JSON-LD's problem is named with it, and every control in it is listed as unsafe and refused with that problem, since what the authority says of each is not known. When the first answer is not read either (Turtle, on the page), the load ends with the JSON-LD's problem named.
   - When the address names no format and its answer does not count, `?format=jsonld`, `turtle` and `markdown` are asked in turn.
   - A request that gets no answer at all (the connection fails or closes, a redirect leaves http(s) or goes past the 20 `fetch` follows, or it times out) ends the load with its problem named, unless it was the optional retry. `hmc.py` gives up on a request after 60 seconds without data; the page leaves that to the browser.
2. Indexes every node object in the document, wherever it is written, merging the descriptions of one `@id` into one node, and walks `iep:affordance` / `hmd:control` / `hydra:supportedOperation` / `hydra:operation`, plus any node typed `hydra:Operation`, `iep:Affordance`, or `hmd:Control`, or naming a `hydra:method` and an action, a target or a template, wherever the document puts it: at the top, in `@graph` (and a named graph's `@graph` within it), in `@included`, in an `@index` or `@id` map, or written in place inside another node.
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

Both clients read the JSON-LD forms they model, and fail closed on the rest. Where a property that decides safety, method, target, datatype or cardinality has more than one distinct value, or a document uses a JSON-LD structure the reader does not model, the control is listed as unsafe and refused with a problem that names it, or the whole document is refused with a named problem. Neither client reads the first of several values, or skips a form it does not read; where the choice is between refusing and reading more of JSON-LD, they refuse.

- Every node object is indexed wherever it is written, and the descriptions of one `@id` are one node, as JSON-LD merges them: a hint, a method or a target written on an object with a control's `@id`, under any property or inside another `@graph` node, is the control's, and so is a template or a shape written in place with an `@id` the document describes elsewhere too. A node with no `@id` is a blank node, its own node: it never takes its action, or the label it is shown by, as an `@id`. Two nodes that name one action are refused, whatever each sends; one node named twice is one control.
- Everything that decides what a control does is read with all its values, merged descriptions of one `@id` included: `hydra:method`, `hydra:target`, `hydra:template`, `iep:action`, the hints, `hydra:expects`, the media type, a template mapping's variable, property and `hydra:required`, and an input's `sh:path`, `sh:name`, `sh:datatype`, counts, lengths, `sh:pattern`, `sh:in`, `sh:defaultValue` and bounds. More than one distinct value, or a value in a form not read there (a `@list`, a JSON literal, a node written in place with no `@id`, a malformed RDF list, a count that is not a whole number), lists the control with the writes and refuses it with a problem that names the property.
- A template node (a target, a `hydra:search` or a template-named key's value with a `hydra:template` or typed `hydra:IriTemplate`) with no template it reads is a problem: its own IRI is never sent to, and the control's other target is not a fallback. A value of a term typed `@json` is a JSON literal, never an address, a method or a node, and a JSON literal under `hydra:expects` is read only when it holds a JSON Schema (an object whose `properties` is an object), whose `required` must be a list of names and each `enum` a list. A `sh:path` that is a blank node, or an inverse, alternative or repeated path, is a problem, not a field.
- An object that names a node by its `@id` (aliased, compact or relative) is read as that node, every description of it merged, never as the object itself: a control's `annotations`, a template's mapping, a shape's `sh:property`, a class's `hydra:supportedProperty`, a template or a list. So is a string that names one, as JSON-LD reads a string under a term typed `@id` or `@vocab`, alone or in a `@list`; where a control's hints are read, a string under any term that names a node the document describes counts, typed or not, since reading more hints can only make a control less safe. One the document does not describe is a problem where it decides safety, the address or the inputs: annotations (an object or a string), a mapping, a property or a supported property it does not describe, and a target, a `hydra:expects` or an `sh:in` that is a blank node it does not describe. A field of a control's own `fields` list that names a node, and a JSON Schema property written as a reference (`$ref` or `@id`), are refused rather than read. Each is read one level deep, so references that loop cost nothing more.
- A property with no value is absent: null and `[]` are no value, while `{}`, `false`, `0` and `""` are values, alike in both clients.
- A value a link (`field.<name>=`) or `--field` gives is checked as it was given, never as a form control would change it, and is never replaced by a default: a choice that is none of the options, a number field given text or only spaces, and a list given only blank lines are refused by name; a multiple choice is sent in the order and number given; a line break or carriage return in text is kept. An empty value is no value, as an empty input is: `field.scope=`, `--field scope=`, a repeated one whose last value is empty, or an input you clear, sends the default, or nothing where there is none. A default is checked as a value given is, so a number field's default of only spaces, and a list's default whose entries are all blank, are refused by name. The page invokes its form with a link's values, as given, until you change the input one fills, and shows a value with a line break in a text area. A number field is a text input. A default is shown in the form only when the form holds it as it is; otherwise the field is left empty and the default itself is checked and sent, required or not, since the form leaves validation to the page's own checks, which name each problem. A link that invokes is refused, naming the parameter, when it carries one the page does not read (anything but `url`, `invoke`, `dry`, `query`, `autoload` and `field.<name>`), as `hmc.py` refuses an option it does not know.
- A field takes a value under its name, its template variable or its path's local name. A control where one of those names is another field's (its name or one of its other names) is refused, since which input a value fills is not known. A descriptor address is checked as it is given too: one with a tab, a line break or a space in it is refused, where the page's address field and Python's `urlsplit` would drop the character.
- A title, label or description is only shown, so the first value that reads as one is shown.
- Read: node objects and `@id` references; value objects with `@type`, `@language` or `@direction`; a `@json` schema under `hydra:expects`; keyword aliases, `@nest`, embedded and scoped contexts and container maps; a `@set` object anywhere, as what it holds; a `@list` or graph object where operations, a shape's properties or a template's mappings go, as its members; a `@list` under `sh:in`; `@graph` and `@included` at the top or inside another `@graph`. A remote `@context` is not fetched: the clients' own names for Hydra and Interego terms (`method`, `target`, `action` and the rest) stand in for it, and are used before `@vocab`, so a document that leaves one of those names to `@vocab` is read as naming the Hydra or Interego term.
- Refused whole, with the problem named: `@reverse`; a `@graph` or `@included` inside a node, and a term whose values are graphs (`"@container": "@graph"`) anywhere but where operations, a shape's properties or mappings go; `@import` in a context, which a JSON-LD processor fetches; a `@set` object with another key, inside a `@list` or with a `@context` of its own; a keyword given twice in one node, through an alias or a `@nest`; another keyword inside a `@nest`; and a key repeated in one JSON object. When the refused document is the JSON-LD a `?format=jsonld` retry answered, the HyperMarkdown or Turtle answer it was asked for instead of is listed with the problem named, and none of its controls is invoked (see [How target resolution works](#how-target-resolution-works)).
- A HyperMarkdown block is read line by line, a line ending being CR LF, CR or LF and nothing else, with each key and value trimmed of space and tab only. A block that gives `rel`, `method`, `target`, `expects`, `mediaType` or `fields` twice, writes one of the first five as a JSON array or object, writes `fields` as anything but a JSON array of objects (read as a document's JSON is, so `NaN` and a repeated key are not JSON), or has two fields of one name is refused. A name that matches two controls, a link with two `url` or `invoke` parameters, and values given under two names of one input are refused too.
- A field's name is used as written: one with a line break in it is never shortened. The page matches each input of a form to its field by position, so a name holding a character HTML rewrites in an attribute, such as CR, is still the field's.

## Safety

- GET / HEAD / OPTIONS are treated as safe and may be sent.
- POST, PUT, PATCH, DELETE, anything with `iep:destructiveHint true`, or `iep:readOnlyHint false` is unsafe. So is a control that names no method: it is a POST, as the substrate's own follower sends it. Every value of a hint counts: a `destructiveHint` true or `readOnlyHint` false under any prefix, in an object written directly inside the control (MCP's `annotations`), on the node such an object names by its `@id` or a string names, wherever the document describes it, or in a HyperMarkdown block makes it unsafe, and so does a hint that is not a boolean (`true`, `false`, `1`, `0` or an `xsd:boolean` literal). True and false together refuse it. Neither hint ever makes a control safe.
- Unsafe operations default to a dry run that prints the exact URL, headers, body, and MCP call. The web UI requires an explicit checkbox before Invoke is enabled. The CLI requires `--confirm`. A confirmed write is sent to that URL and nowhere else (see [Writes go where they say](#writes-go-where-they-say)).
- Only a 2xx answer is a success. After an invoke each client names the address and the status, and where a GET or HEAD was redirected to, in one of three outcomes: `Done:` for a 2xx; `Not done:` for a 301, 302, 303, 307 or 308 that the request did not follow (every write, and every method but GET and HEAD; see [Writes go where they say](#writes-go-where-they-say)); and `Not a success:` for any other answer, a 300 or 304, or a redirect with an empty `Location` answered to a safe GET or HEAD, included. `hmc.py` exits 0 for a dry run or a 2xx answer, 3 when the control has no plain-HTTP transport and nothing was sent, and 4 for any other answer, in text and `--json` mode alike; `--json` also gives `done` and `outcome`, the same words.
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

### Writes go where they say

A request goes only to the address its dry run shows. A confirmed write, and any request other than a GET or HEAD, never follows a redirect (301, 302, 303, 307 or 308) in either client: `hmc.py` sends it with no redirect handler, and the page sends it with `fetch`'s `redirect: "manual"`. Followed, a 307 or 308 would send the write again, body and all, to an address nobody confirmed, and a 301, 302 or 303 would turn it into a GET there.

A redirect answer is reported as not done, in words both clients share: the address answered with a redirect; the request was not re-sent (nor turned into a GET, where `fetch` would have turned it into one: a POST on a 301 or 302, anything but a GET or HEAD on a 303, and any request on a redirect whose status the page cannot see); and whether the address acted on it is not known. `hmc.py` names the status and the `Location`, resolved against the address, prints them in text mode and gives them as `redirect` in `--json`, and exits 4. The page gets an opaque redirect, which shows neither, and says so; when the `Location` is empty, which Chromium does not read as a redirect, it sees the status and names it. A 3xx that is not a redirect status (300, 304) is an answer that is not a success.

In a browser a cross-origin answer goes through the CORS check before the redirect mode applies, so a redirect without `Access-Control-Allow-Origin`, like any other answer without it, makes `fetch` fail, though the host received the request. The page does not call such a request refused: for a request it sends without following, it says that no answer it can read came back, that the request may have reached the address (a redirect, or any answer without CORS headers, reads this way, as a network error does), and that whether the address acted on it is not known.

A GET or HEAD from a control listed as safe follows redirects as a descriptor load does, alike in both clients: over `https` only on the page, `http` or `https` in `hmc.py`, at most 20, a redirect to another scheme refused, and one with an empty `Location` not followed. Each hop is the request `fetch` sends: a HEAD stays a HEAD and a GET a GET on a 301, 302, 303, 307 or 308 (`urllib` before Python 3.13 sends a HEAD on as a GET, which `hmc.py` does not let it do), with the same `Accept` and no body, and a HEAD's answer has no body, whatever the host sends. A redirect is followed on its headers; its own body is not read. Given an HTTP proxy in its environment, `hmc.py` sends that proxy's `Proxy-Authorization` only on a hop through the proxy, never to a host it reaches directly, as a browser never sends one to a host. Its outcome names the address it landed at, as `fetch` writes it: `hmc.py` resolves the `Location` and sends it as it writes a request URL (see [Safety](#safety)), so the address has no fragment and `{`, `}` and the backtick are percent-encoded, as in the page's `res.url`. A `Location` that a URL parser reads otherwise than its text, which `hmc.py` refuses as an address (a backslash, a space, a control character, user information, a host written as a number), is a redirect `hmc.py` refuses too, naming it, and nothing is sent there. The page cannot see a `Location` before its browser follows it, and the browser follows such a one as its URL parser reads it: a backslash as a slash, so `\\other.example/x` leads to another host. OPTIONS is safe but is not followed: a 303 would turn it into a GET.

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
