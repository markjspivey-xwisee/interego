## 2026-11-15 — The generic hypermedia client is on the docs site

A client that follows Interego, HyperMarkdown and Hydra descriptors by what they
say, not by a catalog built into it. Give it an authority URL and it lists the
document's controls, builds a form from each one's SHACL shape, JSON Schema or
IRI template, resolves the live `hydra:target`, and shows the response. It is in
`docs/hypermedia-client/`: `index.html`, a self-contained web page, and `hmc.py`,
the same client as a Python library and command line. GitHub Pages serves the
page at <https://markjspivey-xwisee.github.io/interego/hypermedia-client/>.

Non-normative, Layer 3. It reads the protocol and adds nothing to it: no
package, ontology or conformance change.

POST, PUT, PATCH and DELETE, and anything marked `iep:destructiveHint true` or
`iep:readOnlyHint false`, are unsafe. An unsafe operation is a dry run that shows
the exact request until it is confirmed: a checkbox on the page, `--confirm` in
the command line. The page never confirms a write from its own address.

**`proxy.py` was dropped.** The branch shipped an optional local forwarding
proxy. Code scanning raised a server-side request forgery alert on it that its
own hardening did not clear, and the page does not need it: the hosts it was
written against send `Access-Control-Allow-Origin: *`. The proxy field stays.
It is optional, takes the absolute `https://` URL of a CORS proxy the person runs
themselves, and is empty unless they type into it; the page no longer reads a
`proxy` parameter from its own address, so a link cannot route someone's
requests, and the writes they confirm, through another server. The README dates
its live counts to 2026-11-09 instead of stating them as current.

**Remote data stays text.** The page shares the `markjspivey-xwisee.github.io`
origin with `docs/client-sign.html`, and it renders whatever the hosts a person
types in send back, so markup from a remote document must not reach the DOM as
markup. Before this change:

- The Markdown renderer ran its bare-URL pass over the link markup it had just
  built, so a remote link could split one of the page's own attributes. Its
  patterns also restarted at every `[`, which took about 8 s on a 230,000
  character response.
- An HTML response was put in a sandboxed `srcdoc` frame. It is now shown as
  source.
- Remote field names were written as the form controls' `name`. In a browser a
  form exposes those names as its own properties, so a field named like one of
  the form's methods replaced it: in Chromium the submit handler was never
  attached, and **Dry run** submitted the form natively, reloading the page with
  the descriptor's field defaults as its address parameters. Names now go in
  `data-field`.
- A `seeAlso`, target or SPARQL value that was not an `http(s)` URL was still
  written into a followable attribute; a method string became a CSS class; a
  `@context` term named like an `Object.prototype` member, or a HyperMarkdown
  value that was not a string, stopped the document loading.

Now every remote string is escaped as it is placed and built markup is never
scanned again. Only an `https` URL becomes followable, written as the URL
parser normalises it, and following it fetches it; the page has no link a remote
document can make the browser navigate. A badge's class is a method the
stylesheet knows or `other`. Maps keyed by remote names have no prototype, and
non-string values are shown as their JSON. Requests go over `https` only.

**A confirmation belongs to one control.** A JSON Schema property whose `type`
was the name of an `Object.prototype` member (`toString`, `constructor`, ...)
was looked up through the prototype and made the detail view throw. The view
was then left showing the previous control's form, confirmation and all, while
the page had already selected the new control, so **Invoke** sent the new
control's request under the old one's confirmation. Now the type is looked up
among four known names only; the detail view is cleared before a control is
drawn, and one that cannot be drawn shows a warning and no form; and a form
invokes only the control it was built for, while that control is the one
selected. The HyperMarkdown parser's key map has no prototype either, so a
`__proto__:` line is an ordinary key.

**Remote text costs linear time.** A field's `pattern` came from the remote
document and was run as a regular expression, by the page's own check and by the
browser's validation of the `pattern` attribute, and by `hmc.py`. A crafted
pattern and default doubled the work with each character, and a page link that
names a control to invoke ran it on opening. Neither client runs a remote
pattern now: it is shown in the field's hint (and by `hmc.py describe`) and the
server that receives the value enforces it. Two smaller patterns were quadratic
in their input: the one that shortens `rest-param-...` field names, in both
clients, and the page's trim of trailing punctuation from a URL in a response.
Both are now scans that give the same results. Tests run each case with a 3 s
budget: through an invoke link in the page, and as a `python3 -I hmc.py`
process (`tests/hypermedia-client-cli.test.ts`, which needs `python3`); each
took 8 s or more before. That new module raises the lint gate's `MIN_FILES` to
682, the number the gate named. It also used the last of the test-module
floor's headroom over 690; master has since raised `MIN_TEST_MODULES` to 700 for
a module of its own, which leaves room for this one, so the floor is master's.

**Requests go only where they should.** With the proxy field empty, the page
refused any target that was not `https`; with it filled in, it checked only
that the proxy's own address was `https`, so a descriptor's GET control could
hand the person's proxy a `file:`, `gopher:` or plain-`http` address, or a
loopback or cloud-metadata host. The target must now be `https` either way,
and a proxy is never handed a loopback, private, link-local, shared or
unspecified address written as a literal, or a `localhost` name. A public name
that resolves to such an address is the proxy's to refuse; the page cannot see
what a name resolves to. `http` IRIs are no longer drawn as links the page would
then refuse to follow; they are text, and a Markdown link to one is shown as it
was written. A host that answers in Turtle is asked again for
`?format=jsonld` whether or not a proxy is set; the retry used to depend on the
proxy, a leftover from the proxy that converted Turtle.

`hmc.py` passed any URL to `urlopen`, which also opens `file:`, `ftp:` and
`data:` URLs, and called every template an `http` control. A descriptor's GET
control could make `hmc.py invoke` print a local file. It now sends requests
to `http` and `https` URLs only, through an opener without the file, FTP and
data handlers, follows a redirect only to `http` or `https`, and lists a
template that does not start with one as `unknown`. The new CLI tests serve
such descriptors and redirects from 127.0.0.1 and check that each is refused
and nothing local is printed; each failed before.

**Smaller fixes.** Markdown with CRLF line endings rendered as one paragraph;
line endings are normalised first, as the earlier renderer did. An enum entry
that was not a string was offered as its JSON but validated as
`[object Object]`, so it could never be chosen, and a `null` entry added a
second blank option; both sides now use the JSON text and `null` adds nothing.
A followable IRI's apostrophe, which the URL parser leaves in a path, is
percent-encoded too, so the attribute holds no quote of any kind. The page
names the host a control sends to next to its **Invoke** button, so a form
cannot pass for one that goes elsewhere, and it does not run inside another
page's frame: it disables its controls and says to open it in a tab of its own.
`hmc.py` printed remote titles, descriptions, field names and response bodies
to the terminal as they were, so a document could set the window title, recolour
or erase lines, or ask the terminal to write the clipboard; in text mode every
C0 and C1 control character except newline and tab is now shown as a `\xNN`
escape. Each of these has a test that failed before. The README's example of
a dry run failed the catalog's current shape (`graph_content` needs 40
characters); the new example was dry-run against the live catalog.

**Lists and numbers in a form.** A SHACL `sh:in` written as a JSON-LD list
object, `{"@list": ["draft", "published"]}` alone or in a one-element array, was
read as a single entry, the list's own JSON, so both clients refused `draft`.
Both now take the list's members, unwrapping `@value` and `@id` as they do any
literal, and still read RDF `rdf:first` / `rdf:rest` lists and plain arrays; an
empty list object restricts nothing, as an empty enum does. On the page a
decimal, double or float field turned any text that was not a number into
`NaN` and sent it as `null`; `hmc.py` refused most such text but took `NaN`,
`nan`, `inf` and `1_000`. The range checks let `NaN` through, and the page cut
`1.5` in an integer field to `1`. A number field now takes only a sign, digits,
a fraction and an exponent, with spaces around them ignored, and otherwise
reports `<name>: not a number` or `<name>: not an integer`, so **Dry run**,
**Invoke** and `hmc.py invoke` refuse and send nothing. A value that is not a
number fails a numeric `minInclusive` or `maxInclusive` instead of passing it.
`long`, `short`, `byte` and the other XSD integer types are read as integers
too; the bounds those types imply are left to the server, as `int`'s were. The
page refuses an integer past 2^53 rather than round it; `hmc.py` sends exactly
any integer Python reads (up to 4,300 digits) and reports a longer one as
`integer too long`. Each case but these two limits has a page and a
command-line test that failed before; the 2^53 refusal has a page test.

**Numbers in an enum, and exact decimals.** A number field's `sh:in` was then
checked against the text of the number it held, so the page offered entries it
would never accept: `"1.0"^^xsd:decimal`, `"2.50"`, `"1.0E0"^^xsd:double`, and
`+1` or `02` in a `long` field each failed once chosen, while `hmc.py`, which
compared the text typed, accepted them. Both clients now accept a value when an
entry, read as a number of the field's type, is the same number, so `1` and
`1.0` both match `"1.0"^^xsd:decimal`. A decimal was also rounded to a double
without a word: 2^53 + 1 (9007199254740993) was sent as 2^53, `1e-400` as `0`,
and `10.0000000000000001` as `10`, which then passed a `maxInclusive` of 10. An
`xsd:decimal` is exact, so both clients now refuse one whose JSON number would
write another decimal, with `<name>: decimal cannot be sent exactly`, as the
page refuses an integer past 2^53. A double or float field still takes the
double nearest its text, which is the value XSD gives that text. And the two
clients trimmed different characters around a number: the page's `trim` took
U+FEFF, and Python's `strip` took U+001C to U+001F and U+0085. Both now trim
space, tab, CR and LF only. Each of the three changes has a page test and a
command-line test that failed before. The CSP script hash is updated.

**Compact and relative IRIs.** Both clients read a JSON-LD document's keys
through its context but took its IRI values as they were written. A compacted
descriptor's `"sh:datatype": {"@id": "xsd:integer"}` stayed `xsd:integer`, which
the number, boolean and JSON checks did not recognise, so an integer field took
`abc` and sent `12` as a string, and a boolean or `rdf:JSON` field was a string
too. A relative target such as `"hydra:target": {"@id": "/api"}` stayed `/api`,
which neither client took for an address, so it was offered as an MCP call. Now
each client expands every IRI once, as it reads the document: each `@id`, and
each value of a term the context types as `@id` or `@vocab` (as the kernel's
context types `target` and `action`), through the context's prefixes and
`@vocab`, with a relative IRI resolved against the context's `@base` or else
the address the document was fetched from. A datatype is then matched by its
full XSD or RDF IRI, or by a plain `xsd:` or `rdf:` string where nothing expands
one (a HyperMarkdown block, or a `sh:datatype` written as a literal); a name
after a `#` in another namespace no longer counts. A node shape typed
`rdf:JSON` now takes a request body that must parse as JSON and sends it as
written, as `application/json`, and `hmc.py` sends a boolean body as `true`
rather than `True`. The https rule applies to the resolved address, so an
`@base` of `http:` gives a target the page refuses, and one of `file:` gives
`hmc.py` nothing to fetch. A target that is the document's own IRI with a
fragment is an action junction whether it is written `#frag` or in full: once
resolved they are the same IRI, and the full form used to be an `http` control
that could only reach the descriptor again. A name given to `?invoke=` or to
`hmc.py` is expanded the same way, so `iep:x` still finds an action the context
expanded. The page also read a compact key with a second colon, `ex:a:b`, as
`ex:a`, and it now knows the `prov:` and `skos:` prefixes `hmc.py` already
did, so a compact IRI expands alike in both. Page and command-line tests cover compact `xsd:integer`, `xsd:boolean`
and `rdf:JSON` datatypes in property shapes and node-level shapes, terms typed
`@id` and `@vocab`, the targets `/api`, `api`, `../x`, `#frag` and a full
fragment at a known address and under an explicit `@base`, and an `@base` of
`http:` or `file:`. Each failed before; in the last two only the resolved
address was new, and nothing was sent before either. The CSP script hash is
updated.

**JSON-LD read as JSON-LD reads it, and requests that go where they say.** A
review served both clients documents that jsonld.js reads one way and they read
another. A GET marked `iep:destructiveHint true` under `@nest` (MCP's
`annotations` shape), through a term written before the prefix it uses, or in a
node's own `@context` was a safe read that `hmc.py` and an `?invoke=` link sent
unconfirmed. Keyword aliases (`"id": "@id"`), a term with no `@id` under
`@vocab`, a named graph, `@included`, `@index` and `@id` maps, a JSON Schema in a
`@json` value object, and `"@vocab": "#"` each lost a control, its target or its
fields, and a flattened document took its title from whichever node sorted
first. Each client now puts the whole document in one form before reading it:
context terms in dependency order, aliases, `@nest`, node, property and type
scoped contexts, containers and expanded types, with the descriptor taken as
the node at its address. Both resolve IRIs by RFC 3986 on the text as written,
against the address a document landed at after redirects (except after a 303 in
`hmc.py`; the page cannot tell one apart), so `/dir` answered from `/dir/` no
longer sends `items` to `/items`, and a field named by `#prénom` is `prénom` on
the page too. A document that needs more context work than a fixed budget is
refused. A control with no `hydra:method` is now a POST, as the kernel's follower
sends it, so it is unsafe (a HyperMarkdown block too, which is why the
`__proto__` test now expects `post`), and a `destructiveHint` under an unknown
prefix or in an object directly inside a control makes it unsafe. A
`hydra:IriTemplate` given as the `hydra:target`, as Foxxi's decoration catalogs
write it, is read as a template; a relative template resolves against the base;
`{id:2}` cuts its value; two mappings with no `hydra:property` stay two fields
on the page; and the page names a template's host only when no variable can
extend it, and checks that host before sending. A GET sends a whole-body field
as a parameter named after it, a body is labelled by its own type rather than
the type the control returns, `hmc.py` sends non-ASCII targets percent-encoded
and writes numbers as the page does (`2`, `1e-7`), and the page replaces a query
parameter a field names. In forms, a SHACL property with no `sh:maxCount` takes
a list, as Interego's shapes mean it, so the I2IDL catalog's
`conforms_to_shapes` goes as the JSON array the relay reads, with its count
checked; `hydra:supportedProperty` and `hydra:operation` give fields and
controls; a plain `schema:query` mapping property matches its shape again; an
enum compares by JSON text (`true`, not `True`); a count written `1.0` reads in
both; two fields of one name refuse the control; and a name that is no field's
is an error rather than dropped. Existing fixtures whose fields take one value
now carry `sh:maxCount 1`. Both test files serve the same documents, from
`tests/hypermedia-client-fixtures.ts`, and each finding has a page or
command-line test, mostly both, that failed before. That module raises the lint
gate's `MIN_FILES` to 683, the number the gate named; with master's own new
files merged in since, the scope is 723 and the gate named 688, the value this
change leaves. The CSP script hash is updated.

**The address shown is the address sent.** A review found that the page's dry
run showed an address as RFC 3986 reads it while fetch requested the one the URL
parser writes, and the two can name different hosts: a template
`https://evil.example\@good.example{?q}` dry-ran as an address that reads as
good.example and was fetched from evil.example, as was `https:{+u}` with `u` set
to `@evil.example/x`, and a target ending `/notes/%2e%2e/%2e%2e/admin` dry-ran as
written and fetched `/admin`. `hmc.py` sent what it printed, but failed on a
space and on a host it could not resolve, so the clients also disagreed on what
was sent. Both now refuse, before anything is sent, an address a parser reads
differently from its text: one with a backslash, a space or a control
character, `http(s):` with no `//`, user information, a host that is neither a
plain name nor a bracketed IPv6 address, a port past 65535, or a host written as
a number in a form other than four decimal parts. Every other address is shown
and sent as the parser writes it, with no fragment: the page has the browser's
parser write it, and `hmc.py` writes the same string. On some 10,000 generated
addresses the two clients gave the same string or the same refusal, except for
the hosts with ß that `hmc.py` refuses. Fields go into a query as
`URLSearchParams` writes them in both, so `~` is `%7E` and `*` is left as it is,
where `hmc.py` wrote the reverse, and `hmc.py` rewrites a query the address
already carries only when a field is added, as the page does. A target with an
upper-case scheme is an `http` control in both, not an MCP call. `hmc.py`
refuses a host with ß, ς, ZWJ or ZWNJ, which Python's IDNA 2003 maps to another
domain than a browser does, and its docstring no longer claims fetch's IDNA; the
page keeps the port of a bracketed IPv6 host after non-ASCII user information
in an address it shows but does not send. The README's Safety section says all
of this.

**Cost follows a document's size, not its shape.** The same review measured two
ways a few hundred kilobytes made both clients' work grow as the product of two
sizes: nodes that each named one node holding many operations walked those
operations again for every naming node, and controls whose `hydra:expects`
named one shape each built that shape's fields. Three more turned up while
fixing them: controls sharing one IRI template each read all its mappings; each
mapping searched every field before it, so 7,000 mappings in one control took
the page 13 s; and nodes naming one `hydra:Class` each listed its operations
again. Now one walk covers the whole document, and a node that gains keys from
a later object with its `@id` has just those keys walked; a template node and a
class are read once; a control's fields, and the problem and warning they give,
are built when first read, so the page's list builds none and `hmc.py describe`
builds one control's; `hmc.py` builds each shape's fields once, and its listing
writes a shared list's names once; and mappings are matched through maps and a
heap per name. The results are the ones the old code gave: the new matching
agreed with the page's old search on 4,000 random cases, and the new walk with
the old one on 1,500 random documents, in both clients. Five such documents, of
80 to 510 kB, are in the shared fixtures, and a test in each file opens each one
with a 3 s budget; before, they took the page 7 to 17 s and `hmc.py` 6 to 8 s.

**One field per mapping name.** `hmc.py` looked mappings up in maps built once,
before any mapping renamed a field, so two mappings of one variable, or a
mapping that renamed a shape's field followed by a bare mapping of the name it
gave, made two fields of one name, and the control was refused where the page
made one field. `hmc.py` now matches as the page does. The test is shared: the
page's half passed before and pins what it already did, and `hmc.py`'s failed.
Every other new test in both files failed before. The CSP script hash is
updated.

**Container values, and how many values a JSON field holds.** A review found two
more places where both clients read a document otherwise than it says. First,
they read any object under a container term as a map, so a single inline
operation with no `@id` under a `@set` or `@list` term became a list of its
property values, and an advertised GET became a POST with no target. Now only
an `@language`, `@index`, `@id` or `@type` container holds a map (alone or with
`@set`, and `@index` or `@id` also with `@graph`), and there every object is
one, even one keyed by `@id`, as jsonld.js reads it; under any other container
one node object stays one node. An `@id` map's key under `@graph` names the
graph, not the node; a key aliased to `@none` names nothing; a node's own `@id`
or `@type` written through an alias is kept; and a term whose `@index` names a
property gives each node its key as that property's value, so
`"@index": "hydra:method"` keeps the method. Second, a SHACL property with
`sh:node` or `sh:nodeKind sh:BlankNode` takes a JSON array, and that array
skipped the only check of `sh:minCount` and `sh:maxCount`, so `[]` and four
objects both went through where two to three were asked for; a JSON Schema
array's `minItems` and `maxItems` were not read at all. Both clients now count
a JSON array's items once it parses, and a single object as one, against those
bounds, on a dry run and a confirmed write alike, and refuse with a named error
such as `members: needs at least 2 values, got 0`; `hmc.py describe` shows the
bounds as `minItems` and `maxItems`. The documents are in the shared fixtures,
and the four new tests, one per finding in each file, failed before. The CSP
script hash is updated.

A further review found eight more places where the clients read JSON-LD
otherwise than jsonld.js. A type's scoped context now holds for that node's
own keys only, and an embedded context with `"@propagate": false` for its own
node only: an operation written under such a node reads the document's
context again, so its `target` is the document's `hydra:target` and not the
address a catalog's context gave another term. Neither copies the whole
context per level any more, so a 3,000-term context 80 levels deep is read,
not refused; a term's scoped context met again inside its own value adds
nothing either. A string in an `@index` map whose term holds IRIs names a
node, which the map's `"@index"` property reaches, so `"DELETE": "#remove"`
is a DELETE; under `@graph` that property is the graph's, not the
operation's. A JSON Schema under `hydra:expects` with an `@id`, in a context
that aliases `type`, keeps its property types, so numbers and array counts
are checked. A `@type` or `@id` inside a `@nest` object is the node's. A key
the context defines as another property is no longer read as `hydra:target`
or `hydra:method` by its name. Two terms for one property are both read. A
map's keys are read in sorted order in both clients, so they meet its values
in one order. A control that names two methods or two targets, or shares its
name with another that sends something else, is listed with the writes and
refused with a named problem instead of one of them being picked. Smaller
fixes: an expanded term definition is a prefix only with `"@prefix": true`, a
reserved template expansion keeps `%2F` as it is, `hmc.py` refuses an
`xn--` host the page's URL parser refuses, and its retry with
`?format=jsonld` keeps repeated query parameters. The documents are in the
shared fixtures; every new test failed before. The CSP script hash is
updated.

**Fail closed.** The clients now read the JSON-LD forms they model and refuse
the rest. Every value of what decides a control (method, target, template,
action, hints, shape, media type, and an input's path, name, datatype, counts,
lengths, pattern, choices, default and bounds) is read, merged descriptions of
one `@id` included; two distinct values, or a form not read there such as a
`@list` or a JSON literal, list the control with the writes and refuse it with
a problem that names the property. Any `destructiveHint` true or
`readOnlyHint` false, or a hint that is no boolean, makes a control unsafe, so
`[false, true]` no longer reads as false. A `@set` object is read as what it
holds wherever it is, and a `@list` or graph object as its members where
operations, a shape's properties or mappings go, so an operation under
`{"@set": [...]}` is found. A document that uses `@reverse`, puts `@graph` or
`@included` inside a node, gives a node one keyword twice or repeats a JSON key
is refused whole, as is `NaN` in `hmc.py`, which the page's JSON parser already
refused; so are a HyperMarkdown block that gives its method twice, a name two
controls share and a link with two `invoke` values. Titles and descriptions
still show their first value. The new tests failed before, but for four that
pin what already worked. The CSP script hash is updated.

The rule behind this work: the clients read the JSON-LD forms they model and
fail closed on the rest. Where a property that decides safety, method, target,
datatype or cardinality has more than one distinct value, or a document uses a
structure they do not model, the control is listed as unsafe and refused with a
named problem, or the document is, and refusing is preferred to reading more
of JSON-LD. A further review found where that did not yet hold, each now fixed
in both clients. Every node object is indexed wherever it is written and one
`@id` is one node, so a hint, method or target on an object with a control's
`@id` under any property is the control's; a node with no `@id` stays its own
node instead of taking its action as one; and two nodes that name one action
are refused, whatever each sends. Refused too: a template node with no template
read (its own IRI was sent to), a value of a term typed `@json`, a complex
`sh:path`, a JSON Schema `required` or `enum` that is not a list, `@import`, a
`@graph` container where no members go, and in HyperMarkdown `fields` that are
not JSON and a rel or target written as JSON. A HyperMarkdown line ends at CR
LF, CR or LF in both clients, an empty array is no value and `{}` is one in
both, a name with a line break is never shortened, and the page matches a
form's inputs to their fields by position, since HTML rewrites a CR in an
attribute. Most new shared cases failed before in one client or both. Of 1,500
random documents the clients read 382 differently at the PR head; of 12,000
they now read none differently. The CSP script hash is updated.

A review then found two more. `hmc.py` read a field's JSON with plain
`json.loads`, which takes `NaN` and `Infinity`, and `json.dumps` wrote them back,
so a confirmed write sent a body that is not JSON. A JSON or rdf:JSON field and
a whole JSON body are now read as a document is, in both clients, refusing those
and a repeated key (defaults and HyperMarkdown values already were); a number no
double holds, such as `1e400`, which the page sent as `null`, is refused in both;
and `hmc.py` refuses to write NaN or an infinity into request JSON, while its
`--json` output stays JSON. The page counted `minLength` and `maxLength` in
UTF-16 code units, so an emoji failed `maxLength: 1`; it now counts code points,
as `hmc.py` does. 27 of the new shared-fixture tests failed before; the rest pin
what already held. The CSP script hash is updated.

A second review found more. A value holding an unpaired surrogate, such as
`\ud800` in a JSON field, a list or a default, made `hmc.py` fail to encode the
request while the page sent it; both now refuse it. `hmc.py` read a JSON integer
past 2^53 exactly where the page's `JSON.parse` reads the nearest double, so
lengths, list items, addresses and bounds differed; it now reads one as the page
does (an integer field's own text is still exact), and writes request JSON as
`JSON.stringify` does: `1.0` as `1`, `1e-07` as `1e-7`, and an object's index keys
first. A default is what the page's form holds, so a text field's default of `5`
is sent as `"5"`. A boolean field and `hydra:required` are trimmed of space, tab,
CR and LF only, and `hmc.py` no longer names a field twice in one message. 42 new
or tightened tests failed before; the CSP script hash is updated.

A third review found two more. Annotations written as a reference were read as
the reference object, so a GET whose `destructiveHint` was on that node elsewhere
was a safe read a link could send; both clients now read every object that names
a node as that node, all its descriptions merged, and refuse a mapping, property
or annotations the document does not describe. A link's value the form could not
hold was replaced: `field.scope=invalid` sent the default `scope=all`. The page
now invokes with a link's values as given, as `hmc.py` does with `--field`; number
fields take text; a default the form cannot hold is sent as written; and spaces
in a number field, blank lines in a list, or a tab or line break in a descriptor
address are refused. 47 new or tightened tests failed before; the CSP script
hash is updated.

A fourth review found more. Annotations named by a string, as a term typed `@id`
or `@vocab` writes a reference, were skipped where hints are read, so such a GET
was a safe read a link could send; both clients now read the node any string
names there, and refuse a string naming a node the document does not describe.
A number default of only spaces and a list default of blank entries are refused
in both, where the page refused and `hmc.py` sent. The page's form leaves
validation to its own checks, so a required input whose default it cannot show
no longer stops Dry run and Invoke without a word. A control where one input's
path name or template variable is another input's name is refused in both, and
the page refuses an invoke link carrying a parameter it does not read. 19 new or
tightened tests failed before; the CSP script hash is updated.

A fifth review found more. When the optional `?format=jsonld` retry got no
answer, `hmc.py` dropped the HyperMarkdown or Turtle it had already read; both
clients now keep the first answer whenever that retry gets no answer or no 2xx
JSON-LD. `hmc.py` also read a 300 answer as a
document, an empty JSON body as JSON-LD, missed JSON-LD after a byte order mark
or under two `Content-Type` headers, and answered a redirect loop with its last
redirect; it now reads each answer as `fetch` does, and without `rdflib` asks an
address that names Turtle again for JSON-LD, as the page does. A request that
gets no answer still ends the load, named. 15 of 32 new shared-fixture tests
failed before; the CSP script hash is updated.

A sixth review found two more. When that retry answered JSON-LD the client
refuses whole (not JSON, a repeated key, `@reverse`), both clients read the first
answer as if nothing had come back, so a GET the JSON-LD marked destructive was
listed as safe. The first answer is still listed, but with the JSON-LD's problem
named, and every control in it is unsafe and refused with that problem. `hmc.py`
also followed a 3xx with an empty `Location` back to the same address up to 20
times; a browser does not follow it, and now neither does `hmc.py`. 7 of the 38
shared-fixture tests failed before; the CSP script hash is updated.

A seventh review found that a confirmed write did not always go only where its
dry run said. `hmc.py` sent a POST answered 301, 302 or 303 on to the `Location`
as a GET, and reported a 307 or 308, or any redirect of a PUT, PATCH or DELETE,
as success with exit 0 though nothing reached the destination; the page let
`fetch` re-send the write, body and all, on a 307 or 308 and turn it into a GET
on the others. Now neither client follows a redirect for a write, or for any
request but a GET or HEAD: `hmc.py` sends it with no redirect handler and the
page with `redirect: "manual"`, and the redirect is reported as not done, with
its status and `Location` where the client can see them, saying the request was
not re-sent and that whether the address acted on it is not known. Only a 2xx is
a success: both clients say `Done:` for a 2xx, `Not done:` for a redirect the
request did not follow, and `Not a success:` for any other answer; `hmc.py` exits
4 for any answer but a 2xx, and 3 when the control has no plain-HTTP transport
and nothing was sent, in `--json` mode as in text. Through a proxy the page's
dry run shows the address it sends to as `via`. 27 of 28 shared invoke cases
failed before in each client, 13 of them on the page by re-sending or
redirecting the request; the CSP script hash is updated.

An eighth review found that a safe GET or HEAD `hmc.py` followed to an unusual
`Location` went to, or named, another address than the page: it kept a fragment,
sent `{`, `}` and the backtick as written, and sent a backslash where a browser
reads a slash (to another host, for `\\other.example/x`). `hmc.py` now sends a
`Location` as it writes a request URL, so both clients name the same address, and
refuses one it would refuse as an address, a backslash included, while the
page's browser follows it, as the README says. A write whose answer had no CORS
headers, a redirect included, read on the page as refused though the host got
it; the page now says no answer it can read came back and the write may have
reached the address. A PUT, PATCH or DELETE answered 301 or 302 no longer says it
was not turned into a GET, and a body note is no longer green under an answer
that is not a success. 5 of 7 new shared invoke cases failed before in `hmc.py`,
and on the page the HTML and CORS cases; the CSP script hash is updated.

The page also carries a Content-Security-Policy `<meta>`: `default-src 'none'`,
its own inline script and stylesheet allowed by SHA-256 hash and nothing else (so
no inline event handlers or style attributes), `connect-src https:`, and
`object-src`, `base-uri` and `form-action` set to `'none'`. Editing the inline
script or `<style>` means updating its hash.

`tests/hypermedia-client-rendering.test.ts` loads the real page in jsdom, as the
signing-page tests do, and answers its fetches with hostile documents: script and
style tags, event-handler attributes, `javascript:`, `data:` and `vbscript:`
links, Markdown with embedded HTML, quotes that would close an attribute in IRIs,
labels and field names, `@context` keys named like prototype members,
HyperMarkdown values that are not strings, and a 230,000 character Markdown body
with a 3 s budget. For the descriptor list, every control's detail view, a dry
run, and Markdown, HTML, JSON, SPARQL and plain-text responses, it checks that
only element and attribute kinds the page itself writes appear, that no element
has an event handler, a style attribute, a `name`, or an id the page did not
choose, that every
`href`/`src` is `http(s)` or a fragment and every followable IRI is `https`,
that every class is one the stylesheet defines, that the hostile strings show up
as text verbatim, and that nothing ran. It also checks that a `proxy` parameter
in the page address is ignored, that a non-`https` URL is refused before any
request, that an unsafe control sends nothing on a dry run, and that the
policy's two hashes match the inline script and style exactly. Every case failed
before the change. Two later cases select a confirmed write and then a second
write whose schema names prototype members, or whose form fails to draw, and
check that the second gets a fresh form or a warning and that nothing is sent;
both failed before the fix.

Not covered: jsdom does not enforce CSP and does not expose form controls as
form properties, so the test checks both structurally. They were checked once
by hand in Chromium (the page loads and invokes under its policy with no
violation; the old page's **Dry run** reloaded it), and that check is not in CI.
GitHub Pages cannot send response headers, and a `<meta>` policy cannot set
`frame-ancestors`, so the page checks for itself whether it is framed; a browser
that ran it with scripts off would show its static markup, which does nothing.
The page still shares its origin with `docs/client-sign.html`, so keeping that
page's stored token out of reach rests on this file's escaping and policy. Only
hosting the client on an origin of its own would not; that is the owner's
decision, and it is not made here.

CodeQL raised five high alerts on the rendering test itself, not on the
client: three JSON strings built by escaping only double quotes (a backslash
would have passed through), and two places that found the page's `<script>` and `<style>`
with a lower-case pattern. The strings are now written with `JSON.stringify`,
which gives the same text for these values, and the CSP checks read the page
with jsdom's parser. That parser also sees what the patterns missed: with a
second `<SCRIPT>` added to the page, the hash test now fails, where the
pattern would have let it pass. An `onclick` and a `JavaScript:` link added to
the markup still fail their test.

A ninth review found that `hmc.py` sent a followed HEAD on as a GET: `urllib`
before Python 3.13 (Ubuntu 24.04's `python3` is 3.12) rewrites it at every
redirect, so the landing host was asked for, and sent, a body the HEAD did not
want, where the page's `fetch` keeps the HEAD. `hmc.py` now sends each hop as `fetch` does,
the same method on every redirect status, with the same `Accept` and no body.
The same sweep found it read a redirect's own body before following it, so one
that never ended held the request until it timed out, and behind an HTTP proxy
named in its environment it copied the proxy's `Proxy-Authorization` onto a hop
to a host it reaches directly. Both are gone. Both tests' hosts now record each
hop's method and headers; of the new shared cases (HEAD and GET on each status,
a chain, a loop of 21, a HEAD answered with a body, a redirect that never ends)
and the proxy cases, 12 failed in `hmc.py` before under Python 3.12 and 3 under
3.13. The page needed no change; its test's `fetch` now gives a HEAD's answer no
body, as `fetch` does.

A tenth review found that `hmc.py` still read the body of a redirect it does not
follow (a write's, a destructive GET's, an OPTIONS'), so a write answered with a
redirect whose body never ends waited out the 60 s timeout and exited 1 with no
outcome, where the page's opaque redirect has no body and is reported not done at
once. `hmc.py` now reads only its headers, and `--json` gives `bodyText` as `""`.
A chain past 20 redirects is named by the address the invoke was sent to, not its
last hop; the loop rows now enter a loop of two other addresses, so the two
differ. The paragraph above miscounted: of the cases it lists, 11 failed in
`hmc.py` before under Python 3.12 (12 with the existing HEAD odd Location row)
and 3 under 3.13, and its "redirect that never ends" is a redirect whose body
never ends. The page needed no change; no CSP hash moves.

An eleventh review found that both clients skipped a JSON Schema enumeration
for an array or an object, so `{"type":"array","enum":[["allowed"]]}` let
`["not-allowed"]` be sent. An enumeration or a const now admits a value of any
kind that is the same JSON value as an entry (arrays in order, objects in any
key order, numbers by value, and no string or boolean equal to a number), and a
choice in a field whose type leaves its kind open is sent as the entry it names,
null included, never as its text. The sweep that followed checks every other
value constraint by its standard: lengths only on text and bounds only on
numbers in a JSON Schema, exclusive bounds, a schema inside an array or an
object, integer types' ranges, node kinds and `sh:hasValue`; refuses by name a
value for a constraint neither client checks (`uniqueItems`, `sh:class`, a date
datatype, a bound that is no number), and one an address would leave out. Of
the 91 new shared rows, 68 failed in each client before, as did the changed row
for a bound past a double, which had let any number through. The README's new
Values section lists every decision; the page's CSP hash moves.

A twelfth review found constraints still passed over, and checks that cost the
square of a value's size. Both clients now refuse a body schema's `enum` or
`const`, a property shape's own `sh:property` or `sh:closed`, `readOnly`, a
float past the largest float, a value constraint on a shape that has
properties, and any key a field written in place gives beyond the ten the
HyperMarkdown lift writes; check a body sent whole against its shape's `sh:in`,
`sh:hasValue`, bounds and `sh:nodeKind`, a template variable that is no
property against `additionalProperties`, and `sh:nodeKind` on each item of a
JSON array; read an rdf:JSON value as a literal and a JSON Schema bound written
as text as no number; and check a default as the document gives it, never as
the choice its text names. An entry past a double, or past 2^53 in an integer
field, is not offered. A value's first problem is the one named and entries are
keyed once, so a 50,000-item default against a 50,000-entry enum is checked in
under a second, where `hmc.py` took over 30 s and the page ran out of memory.
Of 44 new shared rows, 35 failed in each client before; the CSP hash moves.

A thirteenth review found constraints still passed over, and a default the two
clients sent differently. Now, in both, an empty value and an untouched form
send the default as the document gives it, and one of another kind than its
field takes is refused by name; `sh:maxCount 0` takes no value; a field written
in place counts its values and reads `rdf:JSON`, and beside a shape the document
describes is checked against it; a schema with no `properties`, a closed shape,
a SHACL bound on text, a body's `readOnly` and an entry past 2^53 are applied;
and a choice list two inputs share, RDF lists that share nodes and JSON nested
past 256 levels are refused, so none costs more than the document's size. Dates
and times are checked as XSD 1.1 writes them; their bounds are still refused.
"A value's first problem" above holds for JSON Schema values. Of 67 new shared
rows, 51 failed in `hmc.py` and 49 on the page before; on the live catalogs only
a warning on HyperMarkdown controls changed. The CSP hash moves.

A fourteenth review found a default, a description or a pattern that many
template variables share copied once for each (a 23 KB document planned a 4 MB
address), and constraints still passed over. Now, in both, that sharing keeps
the control from being invoked; a shape the document describes with no
properties is still the shape, so a closed one refuses a template variable and
fields written in place, and its warning says it is described; a JSON Schema
default is checked as written, never converted, a null default is sent as null
where its schema allows it, and a list default with a blank value is refused; a
nested `@id` schema, a count written in place that is no whole number and a
negative count are refused; and an entry past 2^53 matches no value at any
depth. Of 44 new shared rows, 34 failed in each client before. The CSP hash
moves.

A fifteenth review found `hmc.py`'s `list --json` writing a shared field list
once per control (168 MB for a 34 KB document), a list's `sh:hasValue` and
bounds read again for each value (9 s in each client), an empty-text default
dropped, numbers sent rounded inside JSON values and defaults, JSON-LD keywords
inside a schema passed over, and integers past 2^53 refused only on the page.
Now a node a shape names many times is one input; `list` and `list --json` write
a shared field list once and no fields for a refused control; constraints are
read once per field and a list's check stops at its first bad value; an
empty-text default is sent, or refused by name; a default holding a number
reading JSON may have rounded, and JSON text holding one a double would change,
are refused; keywords such as `@set` inside a schema are named and refused; and
both clients refuse an integer past 2^53 - 1. Of 40 new shared rows, 32 failed
in `hmc.py` and 28 on the page before. The CSP hash moves.

A sixteenth review found `hmc.py`'s `list --json` writing a template's
variables, a property node's field and an `sh:in` list once for each control
that shares them (540 MB for 252 KB), one long prefix or `@base` costing either
client gigabytes, a hint inside a JSON Schema passed over, a decimal past 2^53
sent as another number, and bounds and entries compared as doubles. Now `list`
writes each shared field, list and template once and builds per-control joins
within a budget; both clients refuse a document whose IRIs expand to far more
than it holds, or whose JSON Schema holds a node or a JSON-LD keyword, and read
an object outside `hydra:expects` as JSON-LD; a bound or an entry whose number
may not be the one written is not compared; a boolean takes only XSD's four
forms; and a blank list default is named as the default's. Of 63 new shared
rows, 50 failed in `hmc.py` and 35 on the page before; the rows that pin a
list's stop at its first bad value fail in both once the stop is removed. The
CSP hash moves.

A seventeenth review found more shapes of a small document that made either
client do or write far more than its size: a comment each of 2,000 fields took,
a template or a quoted problem written for each control, a template's fields
copied into each control's, and, found while testing, one variable a template
repeats 20,000 times. Rather than another specific limit, both clients now count
each step (reading, listing, opening a control, checking values, building the
request) against one budget of 64 units per byte of the document, and 2,000,000
at least, and refuse a step past it by name, sending nothing; on the live
catalogs no step uses more than 2.1% of it. The review also found a field cache
that read a node as whichever kind first met it, a hint under a JSON Schema
keyword that `@vocab` or a term makes a property, and numbers named as the
doubles reading gave: the cache is keyed by kind, a schema holding a key its
context gives a meaning (or any under a remote context) is refused, and numbers
are named as written. Of 31 new shared rows, 25 failed in `hmc.py` and 20 on the
page before. The CSP hash moves.

An eighteenth review found one template expression that names a variable many
times expanded whole before it was charged (2 GB from 90 KB), a type a JSON
Schema names whose scoped context gives a keyword a meaning passed over, and
Turtle that `rdflib` expanded before `hmc.py` charged anything. Now each
variable's part is charged as it is made; a schema is checked in the context
JSON-LD reads its own keys in, and where it sits; `hmc.py` charges Turtle's
expansions and terms before `rdflib` reads it, writes where a check failed only
for the problem it reports, and names running out of memory. Of 5 new shared
rows, all failed in each client before, and so did 5 Turtle rows. The CSP hash
moves.

A nineteenth review found that both clients read an empty `sh:in` as no
constraint, so any value was sent. A list given empty is now the empty list:
an empty `sh:in`, `sh:or`, `sh:xone`, `sh:languageIn` or `enum` allows no
value, an empty `sh:and` asks nothing, `rdf:nil` is no entry, and a required
input that allows none keeps its control from being invoked. An empty `allOf`,
`anyOf`, `oneOf` or `prefixItems` is malformed. Of 52 new shared rows, 36
failed in each client before. The CSP hash moves.

`hmc.py describe` and `list --json` now name, for each field, the constraint
whose list is given empty (`empty`), since `in` alone does not tell an empty
list from none, and the README's rule that `[]` is no value names the SHACL
list parameters as its exception.

The page's work-budget rows allowed each step 3 s, and its dry run of the
largest honest document, a form of 2,500 inputs that takes about 2 s in jsdom,
once took 3.1 s on a busy CI runner. Those rows now allow 3 s, or 1 ms for
each 80 bytes of the document where that is more, as the budget grows with the
document; the refusals and the size of what is shown are still checked exactly.

Both clients read a node that many controls, inputs or mappings name once for
each document: its keys, its hints, and what its values for a property read
as. Before, 3,000 controls naming one annotation node of 3,000 keys took the
page 15 s, and naming a target, template, mapping, property or list node, or a
shape's ignored properties, was alike. Each hint scan is charged once, and so
is the text of the values each problem lists as it is written.

An RDF list that many closed shapes name as their ignored properties is now
made a set once, not once for each shape: 1,500 shapes sharing one list of
5,000 made hmc.py's list build 820 MB. The kept readings of a node's values
are now tested to stay apart by kind, and two of the page's slowest work rows
use fewer controls.
