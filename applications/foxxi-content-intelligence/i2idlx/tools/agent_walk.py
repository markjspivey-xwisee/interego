"""A read-only agent walk over I2IDL-X, executed live, written up as Markdown.

python3 -I agent_walk.py <i2idlx-root>
"""
import json
import pathlib
import sys
import urllib.parse
import urllib.request

import rdflib
from rdflib import Graph, URIRef
from rdflib.namespace import RDF, SKOS

ROOT = pathlib.Path(sys.argv[1])
cfg = json.loads((ROOT / "config.json").read_text())
BASE = f"{cfg['relayNsRoot']}/{cfg['owner']}"
NS = f"{BASE}/{cfg['slugs']['ontology']}#"
CAT_IRI = f"{BASE}/{cfg['slugs']['catalog']}"
I2X = rdflib.Namespace(NS)
CAT = rdflib.Namespace(CAT_IRI + "#")
IEP = rdflib.Namespace("https://markjspivey-xwisee.github.io/interego/ns/iep#")
HYDRA = rdflib.Namespace("http://www.w3.org/ns/hydra/core#")
DIST = ROOT / "dist"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def get(url, accept="*/*", follow=True):
    opener = urllib.request.build_opener() if follow else urllib.request.build_opener(NoRedirect)
    req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "i2idlx-agent-walk/0.1"})
    try:
        with opener.open(req, timeout=30) as r:
            return r.status, dict(r.headers), r.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), ""


st_cat, _, cat_body = get(CAT_IRI, "text/turtle")
if st_cat == 200:
    cat, cat_source = Graph().parse(data=cat_body, format="turtle"), f"the live graph at `{CAT_IRI}`"
else:
    cat, cat_source = Graph().parse(DIST / f"{cfg['slugs']['catalog']}.ttl", format="turtle"), "the local `dist/` copy (not yet published)"
enact = Graph().parse(DIST / f"{cfg['slugs']['enactments']}.ttl", format="turtle")
out = ["# Agent walkthrough (executed live)", "",
       "A read-only walk an agent can make with nothing but the I2IDL-X catalog. Every network step below",
       "was executed against the live services while building this package; outputs are trimmed, not edited.", ""]

limits = cat.value(CAT["sparql-service"], I2X.serviceLimits)
lim = {p.split('#')[-1]: str(cat.value(limits, I2X[p.split('#')[-1]])) for p in
       ["maxQueryLength", "rateLimitPerMinute", "maxResultRows", "executionTimeout"]}
ports = sorted(str(cat.value(s, HYDRA.title)) for s in cat.subjects(RDF.type, IEP.Affordance) if cat.value(s, HYDRA.title))
out += ["## 1. Read the catalog", "",
        f"`GET {CAT_IRI}` (Accept: text/turtle or text/markdown) → **{st_cat}**; this run read {cat_source}.",
        f"The agent finds {len(ports)} titled controls and the SPARQL service's published limits before spending a call:",
        f"`{json.dumps(lim)}`.", ""]

# Run the stored query exactly as Interego's follower would: the port's own target, method and dcat:mediaType
# (sent as Content-Type), with the query text as the body. Nothing below is hard-coded except the port's name.
port = CAT["port-sparql-post"]
p_target, p_method = str(cat.value(port, HYDRA.target)), str(cat.value(port, HYDRA.method))
p_media = str(cat.value(port, URIRef("http://www.w3.org/ns/dcat#mediaType")))
p_action = str(cat.value(port, IEP.action))
q = str(cat.value(CAT["q-concept-search"], I2X.sparql)).replace("$text", '"record store"')
req = urllib.request.Request(p_target, data=q.encode("utf-8"), method=p_method,
                             headers={"Content-Type": p_media, "Accept": p_media, "User-Agent": "i2idlx-agent-walk/0.1"})
try:
    with urllib.request.urlopen(req, timeout=30) as r:
        st, body = r.status, r.read().decode("utf-8", "replace")
except urllib.error.HTTPError as e:
    st, body = e.code, ""
rows = json.loads(body)["results"]["bindings"] if st == 200 else []
found = rows[0]["concept"]["value"] if rows else None
out += ["## 2. Find a concept with a stored query", "",
        "`cat:q-concept-search` with `$text` bound to `\"record store\"`, sent through `cat:port-sparql-post` the way",
        "Interego's follower sends it (the port's `dcat:mediaType` as Content-Type, the query text as the body). Through the",
        f"connector this is `act(descriptor_url=<catalog descriptor>, action_iri=\"{p_action}\", payload=<query string>)`.", "",
        f"`{p_method} {p_target}` (Content-Type: {p_media}) → **{st}**", "", "```json",
        json.dumps([{k: v["value"] for k, v in r.items()} for r in rows], indent=1), "```", ""]

deco = Graph().parse(DIST / f"{cfg['slugs']['decorations']}.ttl", format="turtle")
nb = deco.value(URIRef(f"{BASE}/{cfg['slugs']['decorations']}#" + found.rsplit('/', 1)[-1] + "--neighborhood"), HYDRA.target)
st, hd, body = get(str(nb), "text/turtle")
ng = Graph().parse(data=body, format="turtle") if st == 200 else Graph()
labels = sorted({str(o) for o in ng.objects(None, SKOS.prefLabel)})
out += ["## 3. Follow the decorated neighborhood control", "",
        f"The decorator projection gives `{found}` a concrete, strictly followable control whose target embeds",
        "`cat:q-concept-neighborhood` with the concept bound:", "",
        f"`GET {str(nb)[:110]}…` → **{st}**, {len(ng)} triples. Labels in the neighborhood:", "",
        ", ".join(labels), ""]

acts = [(p.split('#')[-1], str(o)) for p, o in [(str(p), o) for p, o in enact.predicate_objects(URIRef(found))] if p.startswith(NS)]
out += ["## 4. Ask how the concept is enacted", ""]
for prop, act in acts:
    st, hd, _ = get(act, follow=False)
    loc = hd.get("Location") or hd.get("location")
    out += [f"- `{prop}` → `{act}` — `GET` → **{st}** `Location: {loc}`"]
out += [""]

manifest = json.loads((ROOT / "evidence" / "foxxi-affordances.json").read_text())
aff = next((r for r in manifest if acts and r["action"] == acts[0][1]), None)
if aff:
    st, hd, body = get(aff["target"], "application/json")
    try:
        about = json.loads(body)
    except Exception:
        about = {"raw": body[:400]}
    out += ["## 5. Invoke the enacting affordance", "",
            f"The manifest defines `{aff['action'].rsplit('/', 2)[-2]}/{aff['action'].rsplit('/', 1)[-1]}` as "
            f"`{aff['method']} {aff['target']}` (read-only: {aff['readOnly']}).", "",
            f"`{aff['method']} {aff['target']}` → **{st}**", "", "```json", json.dumps(about, indent=1)[:1500], "```", ""]

# The semantic layer: follow the three ports the catalog names for q-classify (i2x:runsOver), add the agent's own
# data, run the stored query locally. Ports, media types and the query text all come from the catalog.
q_node = CAT["q-classify"]
over = sorted(cat.objects(q_node, I2X.runsOver), key=str)
union = Graph()
port_lines = []
for port in over:
    target = str(cat.value(port, HYDRA.target))
    media = str(cat.value(port, URIRef("http://www.w3.org/ns/dcat#mediaType")))
    st, _, body = get(target, media)
    n = 0
    if st == 200:
        g = Graph().parse(data=body, format="turtle")
        n = len(g)
        for tr in g:
            union.add(tr)
    port_lines.append(f"- `{str(port).rsplit('#', 1)[-1]}`: `GET {target}` (Accept: {media}) → **{st}**, {n:,} triples")
mine = Graph().parse(ROOT / "examples" / "industry-context.ttl", format="turtle")
for tr in mine:
    union.add(tr)
typed = union.query(str(cat.value(q_node, I2X.sparql))).graph if over else Graph()
EX = "https://example.org/academy/"
mine_subjects = {s for s in mine.subjects()}
n_typed = sum(1 for s, _ in typed.subject_objects(RDF.type) if s in mine_subjects)
lrs = sorted(str(o) for o in typed.objects(URIRef(EX + "lrs-main"), RDF.type))
short = lambda iri: next((p + ":" + iri[len(ns):] for p, ns in [("obo", "http://purl.obolibrary.org/obo/"), ("cco", "https://www.commoncoreontologies.org/"),
                                                              ("gist", "https://w3id.org/semanticarts/ns/ontology/gist/"), ("dul", "http://www.ontologydesignpatterns.org/ont/dul/DUL.owl#"),
                                                              ("gufo", "http://purl.org/nemo/gufo#"), ("prov", "http://www.w3.org/ns/prov#"), ("schema", "https://schema.org/"),
                                                              ("i2x", NS)] if iri.startswith(ns)), iri)
out += ["## 6. Type your own data through the semantic layer", "",
        "`cat:q-classify` names the ports it runs over (`i2x:runsOver`). The agent follows them, adds its own data (here the",
        "fictional `examples/industry-context.ttl`: an academy, its LRS, a teacher, a quiz session, a badge…) and runs the",
        "query locally — plain SPARQL, no reasoner:", ""] + port_lines + ["",
        f"Result: **{n_typed} typings** of the {len(mine_subjects)} resources. The academy's LRS (`ex:lrs-main`, classified by",
        "`i2idl:learning-record-store-lrs`) is now:", "", ", ".join(f"`{short(x)}`" for x in lrs), ""]

stmt = json.loads((ROOT / "examples" / "usage-statement.json").read_text())
out += ["## 7. Record what was done, tagged with the concept (not executed)", "",
        "Writing requires a signed request as the actor, so the walk stops at the payload. Through `cat:port-record-usage`",
        "(which fronts Foxxi's `write-xapi-statements-signed`), the statement carries I2IDL IRIs in Foxxi's existing",
        "`foxxi#conceptIds` extension; its projection is an `i2x:UsageRecord` (see `examples/usage-record.ttl`).", "",
        "```json", json.dumps(stmt["context"], indent=1), "```", "",
        "## 8. Propose a crosswalk (not executed)", "",
        "Through `cat:port-propose-mapping`: `publish_context` with `modal_status: \"Hypothetical\"` and",
        f"`conforms_to_shapes: [\"{BASE}/{cfg['slugs']['shapes']}\"]`, so the relay validates the proposal before",
        "anything is written (see `examples/mapping-proposal.ttl`). A reviewer then votes through `cat:port-ratify`;",
        "only a ratified proposal yields a `skos:*Match` triple (rules in `i2idlx-rules`).", ""]
(ROOT / "dist" / "agent-walkthrough.md").write_text("\n".join(out) + "\n")
print("\n".join(out))
