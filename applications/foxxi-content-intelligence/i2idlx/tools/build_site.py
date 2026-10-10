"""Render the I2IDL-X reference page from the built graphs.

python3 -I tools/build_site.py <i2idlx-root>        → site/index.html

Every table on the page is read from dist/ (the graphs, published.json, the verification report and the
agent walkthrough) and from the pinned I2IDL clone (concept labels only), so the page cannot drift from
what is published. Canonical IRIs stay on Interego; the page links to them.
"""
import html
import json
import os
import pathlib
import re
import sys
import urllib.parse

from rdflib import Graph, Literal, Namespace, URIRef
from rdflib.collection import Collection
from rdflib.namespace import OWL, RDF, RDFS, SKOS

ROOT = pathlib.Path(sys.argv[1]).resolve()
cfg = json.loads((ROOT / "config.json").read_text())
# Machine-specific paths: an environment variable wins; a relative path is read from the package root.
for _keys, _env in ((("i2idl", "localClone"), "I2IDL_CLONE"), (("interegoCoreSrc",), "INTEREGO_CORE_SRC"), (("tsx",), "INTEREGO_TSX")):
    _holder = cfg
    for _k in _keys[:-1]:
        _holder = _holder[_k]
    _v = os.environ.get(_env) or _holder.get(_keys[-1], "")
    _holder[_keys[-1]] = str((ROOT / _v).resolve()) if _v and not os.path.isabs(_v) else _v
DIST = ROOT / "dist"
OUT = ROOT / "site" / "index.html"
BASE = f"{cfg['relayNsRoot']}/{cfg['owner']}"
SLUG = cfg["slugs"]
IRI = {k: f"{BASE}/{v}" for k, v in SLUG.items()}
NS = IRI["ontology"] + "#"
GSNS = "https://glossarystudio.app/ns/"
I2X = Namespace(NS)
CAT = Namespace(IRI["catalog"] + "#")
EN = Namespace(IRI["enactments"] + "#")
MP = Namespace(IRI["mappings"] + "#")
IEP = Namespace("https://markjspivey-xwisee.github.io/interego/ns/iep#")
IEH = Namespace("https://markjspivey-xwisee.github.io/interego/ns/harness#")
HYPRAGENT = Namespace("https://markjspivey-xwisee.github.io/interego/ns/hypragent#")
HYDRA = Namespace("http://www.w3.org/ns/hydra/core#")
DCAT = Namespace("http://www.w3.org/ns/dcat#")
PROV = Namespace("http://www.w3.org/ns/prov#")
ODRL = Namespace("http://www.w3.org/ns/odrl/2/")
DCT = Namespace("http://purl.org/dc/terms/")
ACTION_ROOT = "https://relay.interego.xwisee.com/ns/iep/action/"
ENDPOINT = "https://id.i2idl.org/sparql"
PACKAGE = f"i2idlx-{cfg['version']}.zip"

PREFIXES = sorted({
    "i2x": NS, "cat": IRI["catalog"] + "#", "en": IRI["enactments"] + "#", "mp": IRI["mappings"] + "#",
    "i2idl": "https://id.i2idl.org/concepts/", "i2idl-type": "https://id.i2idl.org/collections/type/",
    "i2idl-field": "https://id.i2idl.org/collections/field/", "gs": GSNS,
    "iep": str(IEP), "ieh": str(IEH), "ie": "https://markjspivey-xwisee.github.io/interego/ns/interego#",
    "hyprcat": "https://markjspivey-xwisee.github.io/interego/ns/hyprcat#", "hypragent": str(HYPRAGENT),
    "foxxi": "https://foxxi-bridge.interego.xwisee.com/ns/foxxi#",
    "ler": "https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#",
    "tla": "https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#",
    "xapi": "https://w3id.org/xapi/ontology#", "xapi-prof": "https://w3id.org/xapi/profiles/ontology#",
    "fxa": ACTION_ROOT + "foxxi/", "rla": ACTION_ROOT + "relay/", "hydra": str(HYDRA),
    "skos": str(SKOS), "schema": "https://schema.org/", "dct": str(DCT), "prov": str(PROV), "dcat": str(DCAT),
    "odrl": str(ODRL), "prof": "http://www.w3.org/ns/dx/prof/", "sh": "http://www.w3.org/ns/shacl#",
    "owl": str(OWL), "rdfs": str(RDFS), "rdf": str(RDF), "xsd": "http://www.w3.org/2001/XMLSchema#",
    "cred": "https://www.w3.org/2018/credentials#",
}.items(), key=lambda kv: -len(kv[1]))

# The same sample bindings build.py tests the stored queries with.
SAMPLES = {
    "concept-neighborhood": {"concept": "<https://id.i2idl.org/concepts/learning-record-store-lrs>"},
    "concept-search": {"text": '"record store"'},
    "definition-evidence": {"concept": "<https://id.i2idl.org/concepts/data-privacy>"},
    "collection-members": {"collection": "<https://id.i2idl.org/collections/curated/competency-and-assessment>"},
    "field-intersection": {"fieldA": "<https://id.i2idl.org/collections/field/learning-engineering>",
                           "fieldB": "<https://id.i2idl.org/collections/field/learning-sciences>"},
    "concepts-by-type": {"type": "<https://id.i2idl.org/collections/type/standard>"},
    "multi-field-concepts": {},
    "provenance-profile": {},
    "release-check": {"version": f'"{cfg["i2idl"]["release"]}"'},
    "classify": {},
    "concept-referents": {"concept": "<https://id.i2idl.org/concepts/formative-assessment>"},
}


def esc(s) -> str:
    return html.escape(str(s), quote=True)


def qname(iri: str) -> str:
    for p, ns in PREFIXES:
        if iri.startswith(ns) and len(iri) > len(ns):
            return f"{p}:{iri[len(ns):]}"
    return iri


DECLARED_GS: set[str] = set()  # gs: terms the ontology declares (filled once the source is scanned)


def anchor(iri: str) -> str | None:
    if iri.startswith(NS):
        return iri[len(NS):]
    if iri in DECLARED_GS:
        return "gs-" + iri[len(GSNS):]
    return None


def wbr(s) -> str:
    """Escape an IRI or media type and allow line breaks only at its natural seams."""
    t = esc(s)
    scheme, sep, rest = t.partition("://")
    if not sep:
        scheme, rest = "", t
    rest = (rest.replace("/", "/<wbr>").replace("?", "<wbr>?").replace("#", "<wbr>#")
            .replace("+", "+<wbr>").replace("&amp;", "<wbr>&amp;"))
    return f"{scheme}{sep}{rest}" if sep else rest


def ext(href: str, text: str, cls: str = "") -> str:
    c = f' class="{cls}"' if cls else ""
    return f'<a{c} href="{esc(href)}" target="_blank" rel="noopener">{text}</a>'


def term(node) -> str:
    if isinstance(node, URIRef):
        s = str(node)
        a = anchor(s)
        if a:
            return f'<a class="qn" href="#{esc(a)}">{esc(qname(s))}</a>'
        if s.startswith("https://id.i2idl.org/collections/"):  # upstream collection IRIs do not dereference
            return f'<code class="qn">{esc(qname(s))}</code>'
        return ext(s, esc(qname(s)), "qn")
    if isinstance(node, Literal):
        return esc(node)
    return "…"


def expr(g: Graph, n) -> str:
    if isinstance(n, (URIRef, Literal)):
        return term(n)
    if (n, RDF.first, None) in g:
        return " ∘ ".join(expr(g, x) for x in Collection(g, n))
    inter = g.value(n, OWL.intersectionOf)
    if inter is not None:
        return " ⊓ ".join(expr(g, x) for x in Collection(g, inter))
    if (n, RDF.type, OWL.Restriction) in g:
        p = g.value(n, OWL.onProperty)
        for kw, pred in (("value", OWL.hasValue), ("some", OWL.someValuesFrom), ("only", OWL.allValuesFrom)):
            v = g.value(n, pred)
            if v is not None:
                return f"({term(p)} {kw} {expr(g, v)})"
    return "…"


def text_of(g: Graph, s, *preds) -> str | None:
    for p in preds:
        vals = list(g.objects(s, p))
        if vals:
            en = [v for v in vals if isinstance(v, Literal) and v.language in (None, "en")]
            return str((en or vals)[0])
    return None


def code_inline(s: str) -> str:
    """Escape, then turn `backticks` into <code>."""
    return re.sub(r"`([^`]+)`", lambda m: f"<code>{m.group(1)}</code>", esc(s))


def json_script(obj) -> str:
    return json.dumps(obj, ensure_ascii=False).replace("</", "<\\/").replace("<!--", "<\\!--")


def load(slug_key: str) -> tuple[Graph, str]:
    path = DIST / f"{SLUG[slug_key]}.ttl"
    return Graph().parse(path, format="turtle"), path.read_text()


# ── Inputs ──────────────────────────────────────────────────────────────────────────────────────────
onto, onto_src = load("ontology")
cat, cat_src = load("catalog")
enact, enact_src = load("enactments")
maps, maps_src = load("mappings")
rels, rels_src = load("releases")
chg, chg_src = load("changes")
aligns, aligns_src = load("alignments")
refs, refs_src = load("referents")
sem = json.loads((DIST / "semantic-layer.json").read_text())
sspec = __import__("importlib.util").util.spec_from_file_location("semantic", ROOT / "src" / "semantic.py")
SEMM = __import__("importlib.util").util.module_from_spec(sspec)
sspec.loader.exec_module(SEMM)
pub = json.loads((DIST / "published.json").read_text())
plan = json.loads((DIST / "publish-plan.json").read_text())
report = (DIST / "verification-report.md").read_text()
walk = (DIST / "agent-walkthrough.md").read_text()

gl = Graph().parse(pathlib.Path(cfg["i2idl"]["localClone"]) / cfg["i2idl"]["graphPath"], format="json-ld",
                   base="https://id.i2idl.org/")
labels = {str(s): str(o) for s, o in gl.subject_objects(SKOS.prefLabel)}
n_concepts = len(set(gl.subjects(RDF.type, SKOS.Concept)))

# Ontology sections, in source order: the lettered headers group the terms that follow them.
sections, sec_of, order = [], {}, []
cur = None
for line in onto_src.splitlines():
    m = re.match(r"^#\s+([A-Z])\.\s+(.+?)\s*$", line)
    if m:
        cur = m.group(1)
        sections.append((cur, m.group(2).rstrip(".")))
        continue
    m = re.match(r"^(i2x|gs):([A-Za-z0-9_-]+)[\s;.]", line)
    if m and cur:
        iri = (NS if m.group(1) == "i2x" else GSNS) + m.group(2)
        if iri not in sec_of:
            sec_of[iri] = "H" if m.group(1) == "gs" else cur
            order.append(iri)
DECLARED_GS.update(i for i in order if i.startswith(GSNS))


def concept_label(iri) -> str:
    return labels.get(str(iri), str(iri).rsplit("/", 1)[-1])


def concept_link(iri) -> str:
    return ext(str(iri), esc(concept_label(iri)))


def action_name(iri) -> str:
    s = str(iri)
    if s.startswith(ACTION_ROOT):
        return s[len(ACTION_ROOT):]
    return qname(s)


def action_link(iri) -> str:
    s = str(iri)
    a = anchor(s)
    if a:
        return f'<a class="qn" href="#{esc(a)}">{esc(a)}</a>'
    return ext(s, esc(action_name(s)), "qn")


# ── Graphs ──────────────────────────────────────────────────────────────────────────────────────────
DISPLAY = [
    ("catalog", "Agent catalog", "HyprCat entry point: ports, templates, stored queries and policies."),
    ("ontology", "Ontology", "The i2x: vocabulary: kinds, interpretants, enactment, governance and agent terms."),
    ("shapes", "Shapes", "SHACL contracts the relay enforces before a record is written."),
    ("rules", "Rules", "SHACL-AF TripleRules: kinds, modality, definition provenance, ratified triples."),
    ("enactments", "Enactments", "Concept-to-capability links, held as proposals."),
    ("mappings", "Mapping proposals", "SKOS crosswalks to external vocabularies, held for review."),
    ("releases", "Release feed", "Every I2IDL version since v0.0.54, chained."),
    ("changes", "Change history", "Every change between releases as PROV activities and typed events (I2IDL's roadmap, priority 4)."),
    ("alignments", "Alignments", "Referent categories, I2IDL's records, Interego and Foxxi aligned to upper ontologies and peer vocabularies."),
    ("referents", "Referents", "What each I2IDL concept classifies: one referent category per concept, with the reason."),
]
by_slug = {r["graph"]: r for r in pub["graphs"]}
graph_rows = []
for key, title, blurb in DISPLAY:
    slug = SLUG[key]
    rec = by_slug[slug]
    triples = len(Graph().parse(DIST / f"{slug}.ttl", format="turtle"))
    status = rec["modalStatus"]
    h = rec["contentHash"].split(":", 1)[-1]
    links = " · ".join([ext(IRI[key], "Page"), ext(IRI[key] + "?format=turtle", "Turtle"),
                        ext(IRI[key] + "?format=jsonld", "JSON-LD"), ext(IRI[key] + "?format=markdown", "Markdown")])
    graph_rows.append(
        f'<tr><td><div class="cell-title">{esc(title)}</div><code class="iri">{wbr(IRI[key])}</code>'
        f'<div class="muted small">{esc(blurb)}</div></td>'
        f'<td><span class="chip {status.lower()}">{esc(status)}</span></td>'
        f'<td class="num">{triples:,}</td><td class="links">{links}</td>'
        f'<td>{ext(rec["descriptor"], "Signed descriptor")}<div class="hash" title="{esc(rec["contentHash"])}">'
        f'sha256 <code>{esc(h[:12])}…</code> <button class="btn btn-tiny" type="button" data-copy="{esc(rec["contentHash"])}">'
        f'Copy hash</button></div></td></tr>')
deco_n = int(re.search(r"(\d+) concrete affordances materialized", report).group(1))
deco_mb = (DIST / f"{SLUG['decorations']}.ttl").stat().st_size / 1e6
graph_rows.append(
    '<tr class="local"><td><div class="cell-title">Decorations</div><code class="iri">'
    f'{esc(SLUG["decorations"])}.ttl</code><div class="muted small">Five followable controls per concept, '
    'materialized from the decorator registry.</div></td><td><span class="chip local">Local</span></td>'
    f'<td class="num">{deco_n:,} controls</td><td colspan="2" class="muted">In the package ({deco_mb:.1f} MB). '
    'Not published: an agent can derive it from the catalog templates.</td></tr>')

# ── Catalog controls ────────────────────────────────────────────────────────────────────────────────
listing = re.search(r"iep:affordance(.*?);\s*\n\s*rdfs:seeAlso", cat_src, re.S).group(1)
control_order = re.findall(r"cat:([A-Za-z0-9_-]+)", listing)
GROUPS = ["Reads on the live glossary", "Semantic layer (graphs on Interego)", "Per-concept templates",
          "Governed writes through Interego", "Foxxi capabilities", "Human-routed"]
SEMANTIC_PORTS = {"port-vocabulary", "port-alignments", "port-referents"}
grouped: dict[str, list[str]] = {g: [] for g in GROUPS}
n_followable = n_templates = 0
for local in control_order:
    s = CAT[local]
    action = cat.value(s, IEP.action)
    method = str(cat.value(s, HYDRA.method) or "POST")
    target = cat.value(s, HYDRA.target)
    tmpl_node = cat.value(s, I2X.targetTemplate)
    template = str(cat.value(tmpl_node, HYDRA.template)) if tmpl_node is not None else None
    media = cat.value(s, DCAT.mediaType)
    readonly = cat.value(s, IEP.readOnlyHint) == Literal(True)
    cap = cat.value(s, I2X.requiresCapability)
    routed = cat.value(s, IEP.externallyRouted) == Literal(True)
    label = text_of(cat, s, RDFS.label)
    desc = text_of(cat, s, HYDRA.description) or text_of(cat, s, HYDRA.title) or ""
    if routed:
        group = "Human-routed"
    elif local in SEMANTIC_PORTS:
        group = "Semantic layer (graphs on Interego)"
    elif str(action).startswith(ACTION_ROOT + "foxxi/"):
        group = "Foxxi capabilities"
    elif template:
        group = "Per-concept templates"
    elif not readonly:
        group = "Governed writes through Interego"
    else:
        group = "Reads on the live glossary"
    if target is not None:
        n_followable += 1
        where = f'<code class="iri">{wbr(target)}</code>'
    else:
        n_templates += 1
        where = f'<code class="iri tpl">{wbr(template)}</code> <span class="tag">template</span>'
    needs = term(cap) if cap is not None else '<span class="muted">—</span>'
    grouped[group].append(
        f'<tr id="{esc(local)}"><td><div class="cell-title">{esc(label)}</div><div class="muted small">{esc(desc)}</div></td>'
        f'<td>{action_link(action)}</td><td><span class="method {method.lower()}">{esc(method)}</span></td>'
        f'<td>{where}</td><td><code>{wbr(media or "")}</code></td><td>{needs}</td></tr>')
control_rows = []
for g in GROUPS:
    if grouped[g]:
        control_rows.append(f'<tr class="group"><th colspan="6">{esc(g)}</th></tr>')
        control_rows += grouped[g]
n_controls = n_followable + n_templates

# ── Stored queries ──────────────────────────────────────────────────────────────────────────────────
query_cards = []
for m in re.finditer(r"^cat:(q-[A-Za-z0-9-]+) a i2x:StoredQuery", cat_src, re.M):
    local = m.group(1)
    name = local[2:]
    s = CAT[local]
    sparql = str(cat.value(s, I2X.sparql))
    params = sorted({str(p) for p in cat.objects(s, I2X.parameter)}, key=lambda p: sparql.find("$" + p))
    bound = sparql
    for k, v in SAMPLES[name].items():
        bound = re.sub(r"\$" + re.escape(k) + r"\b", lambda _m, v=v: v, bound)
    run = ENDPOINT + "?query=" + urllib.parse.quote(bound, safe="")
    over = sorted(str(o).rsplit("#", 1)[-1] for o in cat.objects(s, I2X.runsOver))
    action_html = (f'<a class="btn btn-primary run" href="{esc(run)}" target="_blank" rel="noopener">Run on the live endpoint</a>' if not over else
                   '<span class="note">Runs client-side over ' + ", ".join(f'<a href="#{esc(o)}"><code>{esc(o)}</code></a>' for o in over)
                   + ' plus your own data (<code>i2x:runsOver</code>): follow those ports, load the results with your data into any SPARQL 1.1 engine, run it there.</span>')
    inputs = "".join(
        f'<div class="param"><label for="p-{esc(name)}-{esc(p)}">${esc(p)}</label>'
        f'<input id="p-{esc(name)}-{esc(p)}" data-param="{esc(p)}" value="{esc(SAMPLES[name].get(p, ""))}" '
        'spellcheck="false" autocomplete="off"></div>' for p in params)
    query_cards.append(
        f'<article class="query" id="{esc(local)}" data-name="{esc(name)}">'
        f'<div class="query-head"><h3>{esc(text_of(cat, s, RDFS.label))}</h3>'
        f'<span class="method">{esc(cat.value(s, I2X.queryForm))}</span></div>'
        f'<p class="muted">{code_inline(text_of(cat, s, DCT.description) or "")}</p>'
        + (f'<div class="params">{inputs}</div>' if params else "")
        + f'<pre><code id="code-{esc(name)}">{esc(bound.rstrip())}</code></pre>'
        f'<div class="row-actions"><button class="btn" type="button" data-copy-from="code-{esc(name)}">Copy query</button>'
        f'{action_html}</div>'
        f'<script type="application/json" class="q-src">{json_script(sparql)}</script></article>')

# ── Vocabulary ──────────────────────────────────────────────────────────────────────────────────────
KINDS = [(OWL.Class, "Class"), (OWL.ObjectProperty, "Object property"), (OWL.DatatypeProperty, "Datatype property"),
         (OWL.AnnotationProperty, "Annotation property"), (SKOS.ConceptScheme, "Concept scheme"), (SKOS.Concept, "Concept"),
         (I2X.ActionIdentity, "Action identity"), (HYPRAGENT.Capability, "Capability"),
         (IEH.DecoratorRegistry, "Decorator registry"), (IEH.AffordanceDecorator, "Decorator"), (ODRL.Action, "ODRL action")]
PRED_LABEL = {
    RDFS.subClassOf: "Subclass of", RDFS.subPropertyOf: "Subproperty of", RDFS.domain: "Domain", RDFS.range: "Range",
    OWL.equivalentClass: "Equivalent to", OWL.propertyChainAxiom: "Property chain",
    I2X.kindForTypeCollection: "Type collections", I2X.asProperty: "Materializes as", SKOS.inScheme: "In scheme",
    SKOS.closeMatch: "Close match", SKOS.broadMatch: "Broad match", I2X.answersInterrogative: "Answers",
    I2X.hasDecorator: "Decorators", SKOS.hasTopConcept: "Concepts", IEH.decoratorId: "Decorator id",
    IEH.decoratorName: "Name", IEH.priority: "Priority", IEH.domain: "Vertical", I2X.selects: "Applies to",
    RDFS.isDefinedBy: "Defined by", RDFS.seeAlso: "See also", SKOS.example: "Example",
}
SKIP = {RDF.type, RDFS.label, SKOS.prefLabel, RDFS.comment, SKOS.definition, SKOS.topConceptOf}
vocab_html, n_terms = [], 0
section_titles = dict(sections)
for letter, title in sections:
    terms_here = [i for i in order if sec_of[i] == letter]
    arts = []
    for iri in terms_here:
        s = URIRef(iri)
        types = set(onto.objects(s, RDF.type))
        kind = next((lbl for t, lbl in KINDS if t in types), "Term")
        if OWL.FunctionalProperty in types:
            kind += " · functional"
        label = text_of(onto, s, RDFS.label, SKOS.prefLabel)
        comment = text_of(onto, s, RDFS.comment, SKOS.definition)
        facts = {}
        for p, o in onto.predicate_objects(s):
            if p in SKIP:
                continue
            facts.setdefault(p, []).append(o)
        dl = "".join(
            f'<div><dt>{esc(PRED_LABEL.get(p, qname(str(p))))}</dt><dd>'
            + ", ".join(expr(onto, o) for o in sorted(os, key=lambda o: qname(str(o)))) + "</dd></div>"
            for p, os in sorted(facts.items(), key=lambda kv: PRED_LABEL.get(kv[0], "~" + qname(str(kv[0])))))
        search = " ".join(x for x in [qname(iri), label or "", comment or "", kind] if x).lower()
        arts.append(
            f'<article class="term" id="{esc(anchor(iri))}" data-search="{esc(search)}">'
            f'<div class="term-head"><code class="term-qn">{esc(qname(iri))}</code><span class="kind">{esc(kind)}</span></div>'
            + (f"<h4>{esc(label)}</h4>" if label else "")
            + (f"<p>{esc(comment)}</p>" if comment else "")
            + (f'<dl class="facts">{dl}</dl>' if dl else "") + "</article>")
        n_terms += 1
    extra = ""
    if letter == "G":
        pairs = sorted(onto.subject_objects(I2X.answersInterrogative), key=lambda so: (qname(str(so[1])), qname(str(so[0]))))
        extra = ('<div class="table-wrap narrow"><table><thead><tr><th>Property</th><th>Answers</th></tr></thead><tbody>'
                 + "".join(f"<tr><td>{term(p)}</td><td>{term(o)}</td></tr>" for p, o in pairs) + "</tbody></table></div>")
    vocab_html.append(
        f'<div class="vocab-section" data-letter="{letter}"><h3><span class="letter">{letter}</span> {esc(title)}</h3>'
        + extra + "".join(arts) + "</div>")

# ── Enactments ──────────────────────────────────────────────────────────────────────────────────────
enact_rows, roles_seen = [], {}
for m in re.finditer(r"^en:([A-Za-z0-9_.-]+) a i2x:Enactment", enact_src, re.M):
    s = EN[m.group(1)]
    concept = enact.value(s, I2X.enactedConcept)
    action = enact.value(s, I2X.viaAction)
    role = enact.value(s, I2X.enactmentRole)
    role_label = text_of(onto, role, SKOS.prefLabel) or qname(str(role))
    roles_seen[role_label] = roles_seen.get(role_label, 0) + 1
    conf = float(enact.value(s, I2X.confidence))
    rationale = text_of(enact, s, I2X.rationale) or ""
    search = f"{concept_label(concept)} {action_name(action)} {role_label} {rationale}".lower()
    enact_rows.append(
        f'<tr data-role="{esc(role_label)}" data-search="{esc(search)}"><td>{concept_link(concept)}</td>'
        f'<td>{esc(role_label)}</td><td>{action_link(action)}</td><td class="num">{conf:.2f}</td>'
        f'<td class="small">{esc(rationale)}</td></tr>')
role_caps: dict[str, list[tuple[str, str]]] = {}
for m in re.finditer(r"^i2idl:([A-Za-z0-9-]+) i2x:roleCapability (fxa|rla):([A-Za-z0-9_-]+) \.\s+#\s*(.*)$", enact_src, re.M):
    concept = "https://id.i2idl.org/concepts/" + m.group(1)
    role_caps.setdefault(concept, []).append((ACTION_ROOT + ("foxxi/" if m.group(2) == "fxa" else "relay/") + m.group(3), m.group(4)))
role_html = []
for concept, acts in role_caps.items():
    derived = all(n.startswith("derived") for _, n in acts)
    chips = " ".join(f'<span class="cap" title="{esc(n)}">{action_link(a)}</span>' for a, n in acts)
    note = ('<div class="muted small">Derived from the role tags in Foxxi\'s own manifest.</div>' if derived else "")
    role_html.append(f'<div class="role"><div class="cell-title">{concept_link(concept)} <span class="muted">{len(acts)}</span></div>{chips}{note}</div>')
n_role_caps = sum(len(v) for v in role_caps.values())

# ── Mapping proposals ───────────────────────────────────────────────────────────────────────────────
VOCABS = [("http://vocabularies.unesco.org/thesaurus/", "UNESCO Thesaurus"),
          ("https://w3id.org/xapi/profiles/ontology#", "xAPI Profiles"), ("https://w3id.org/xapi/ontology#", "xAPI"),
          ("https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#", "IEEE LER"),
          ("https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#", "ADL TLA"), ("https://schema.org/", "schema.org"),
          ("https://www.w3.org/2018/credentials#", "W3C VC"),
          ("https://markjspivey-xwisee.github.io/interego/ns/", "Interego")]
map_rows, vocab_counts, method_counts = [], {}, {}
for m in re.finditer(r"^mp:([A-Za-z0-9_.-]+) a i2x:MappingProposal", maps_src, re.M):
    s = MP[m.group(1)]
    subj, pred, obj = (maps.value(s, p) for p in (I2X.proposedSubject, I2X.proposedPredicate, I2X.proposedObject))
    vocab = next(v for ns, v in VOCABS if str(obj).startswith(ns))
    vocab_counts[vocab] = vocab_counts.get(vocab, 0) + 1
    method = text_of(onto, maps.value(s, I2X.mappingMethod), SKOS.prefLabel) or ""
    method_counts[method] = method_counts.get(method, 0) + 1
    conf = float(maps.value(s, I2X.confidence))
    rationale = text_of(maps, s, I2X.rationale) or ""
    search = f"{concept_label(subj)} {qname(str(obj))} {vocab} {rationale}".lower()
    map_rows.append(
        f'<tr data-vocab="{esc(vocab)}" data-search="{esc(search)}"><td>{concept_link(subj)}</td>'
        f'<td><code>{esc(str(pred).rsplit("#", 1)[-1])}</code></td><td>{ext(str(obj), esc(qname(str(obj))), "qn")}'
        f'<div class="muted small">{esc(vocab)}</div></td><td>{esc(method)}</td><td class="num">{conf:.2f}</td>'
        f'<td class="small">{esc(rationale)}</td></tr>')

# ── Releases ────────────────────────────────────────────────────────────────────────────────────────
rel_rows = []
releases = sorted(rels.subjects(RDF.type, I2X.GlossaryRelease),
                  key=lambda s: tuple(int(x) for x in str(rels.value(s, I2X.releaseVersion)).lstrip("v").split(".")),
                  reverse=True)
for s in releases:
    version = str(rels.value(s, I2X.releaseVersion))
    commit = str(rels.value(s, I2X.releaseCommit))
    when = rels.value(s, PROV.generatedAtTime).toPython().date().isoformat()
    added = sorted(rels.objects(s, I2X.addedConcept), key=concept_label)
    removed = sorted(rels.objects(s, I2X.removedConcept), key=concept_label)
    revised = sorted(rels.objects(s, I2X.revisedDefinitionOf), key=concept_label)
    changes = []
    if added:
        changes.append(f"<strong>Added {len(added)}:</strong> " + ", ".join(concept_link(c) for c in added))
    if removed:
        changes.append(f"<strong>Removed {len(removed)}:</strong> " + ", ".join(esc(concept_label(c)) for c in removed))
    if revised:
        changes.append(f"<strong>Revised {len(revised)}:</strong> " + ", ".join(concept_link(c) for c in revised))
    cmp_ = rels.value(s, RDFS.seeAlso)
    diff = f' · {ext(str(cmp_), "diff")}' if cmp_ is not None else ""
    rel_rows.append(
        f'<tr><td><strong>{esc(version)}</strong></td><td class="num">{esc(when)}</td>'
        f'<td>{ext("https://github.com/blakeplock/i2idl-linked-data/commit/" + commit, f"<code>{esc(commit[:7])}</code>")}{diff}</td>'
        f'<td class="num">{int(rels.value(s, I2X.conceptCount))}</td><td class="num">{int(rels.value(s, I2X.relatedPairCount))}</td>'
        f'<td class="num">{int(rels.value(s, I2X.broaderPairCount))}</td>'
        f'<td class="small">{"<br>".join(changes) or "<span class=muted>No concept changes</span>"}</td></tr>')


# ── What's whose (the ontology's i2x:Origins scheme) ────────────────────────────────────────────────
ORIGINS_SCHEME = URIRef(NS + "Origins")
origin_rows = []
for o in json.loads((ROOT / "src" / "origins.json").read_text())["origins"]:
    node = next(n for n in onto.subjects(SKOS.inScheme, ORIGINS_SCHEME) if str(onto.value(n, SKOS.notation)) == o["id"])
    held = sorted(str(h) for h in onto.objects(node, I2X.heldIn))
    origin_rows.append(
        f'<tr><td><span class="origin o-{esc(o["id"])}">{esc(text_of(onto, node, SKOS.prefLabel))}</span></td>'
        f'<td class="small">{esc(text_of(onto, node, SKOS.definition))}</td><td class="small">{esc(text_of(onto, node, SKOS.scopeNote))}</td>'
        f'<td class="small">{"<br>".join(ext(h, wbr(h.replace("https://", ""))) for h in held) or "<span class=muted>—</span>"}</td></tr>')

# ── Change history (graph i2idlx-changes) ───────────────────────────────────────────────────────────
kind_label = {str(k): text_of(onto, k, SKOS.prefLabel) for k in onto.subjects(SKOS.inScheme, URIRef(NS + "ChangeKinds"))}
chg_rows = []
for rc in sorted(chg.subjects(RDF.type, I2X.ReleaseChange), key=lambda s: str(chg.value(s, PROV.endedAtTime)), reverse=True):
    kinds: dict[str, int] = {}
    for ev in chg.subjects(I2X.partOfChange, rc):
        k = kind_label.get(str(chg.value(ev, I2X.changeKind)), "?")
        kinds[k] = kinds.get(k, 0) + int(chg.value(ev, I2X.changeCount))
    n = int(chg.value(rc, I2X.changeCount))
    chg_rows.append(
        f'<tr><td><strong>{esc(text_of(chg, rc, RDFS.label))}</strong></td><td class="num">{esc(str(chg.value(rc, PROV.endedAtTime))[:10])}</td>'
        f'<td class="num">{n:,}</td><td class="small">{", ".join(f"{v:,} {esc(k)}" for k, v in sorted(kinds.items(), key=lambda kv: -kv[1])) or "<span class=muted>No change to the published graph</span>"}</td></tr>')
n_change_facts = sum(int(chg.value(rc, I2X.changeCount)) for rc in chg.subjects(RDF.type, I2X.ReleaseChange))

# ── Semantic layer (graphs i2idlx-alignments and i2idlx-referents, and the build's reasoning record) ──
SPFX = sorted(SEMM.PREFIXES.items(), key=lambda kv: -len(kv[1]))
SCOL = {v["prefix"]: v["column"] for v in SEMM.VOCABS}
SCAT = {c["id"]: c for c in SEMM.CATEGORIES}
LABELS = sem["labels"]


def s_expand(curie: str) -> str:
    pfx, loc = curie.split(":", 1)
    return SEMM.PREFIXES[pfx] + loc


SSHORT = {v["prefix"]: v["short"] for v in SEMM.VOCABS}
MIXED_COLS = {"schema", "peer"}  # columns that hold terms from several vocabularies: each chip names its own


def s_term(curie: str, dim: bool = False, tag: bool = False) -> str:
    label = LABELS.get(curie) or re.sub(r"([a-z])([A-Z])", r"\1 \2", curie.split(":", 1)[1])
    cls = "sterm dim" if dim else "sterm"
    tv = f'<span class="tv">{esc(SSHORT.get(curie.split(":")[0], curie.split(":")[0]))}</span>' if tag else ""
    return f'<a class="{cls}" href="{esc(s_expand(curie))}" target="_blank" rel="noopener" title="{esc(curie)}">{tv}{esc(label)}</a>'


def s_chain(cid: str) -> list[str]:
    out = [cid]
    while SCAT[out[-1]].get("broader"):
        out.append(SCAT[out[-1]]["broader"])
    return out


n_in_cat: dict[str, int] = {}
for _s, o in refs.subject_objects(I2X.referentCategory):
    k = str(o).rsplit("category-", 1)[-1]
    n_in_cat[k] = n_in_cat.get(k, 0) + 1
sem_rows, last_group = [], None
for c in SEMM.CATEGORIES:
    if c["group"] != last_group:
        sem_rows.append(f'<tr class="group"><th colspan="{len(SEMM.COLUMNS) + 1}">{esc(c["group"])}</th></tr>')
        last_group = c["group"]
    cells = []
    for col, _ in SEMM.COLUMNS:
        terms = []
        for k in s_chain(c["id"]):
            for tt in SCAT[k].get("referent", []):
                if SCOL.get(tt.split(":")[0]) == col and tt not in [x for x, _ in terms]:
                    terms.append((tt, k != c["id"]))
        if col == "peer":
            terms += [(tt, True) for tt in c.get("expressible", []) if tt not in [x for x, _ in terms]]
        cells.append("<td>" + " ".join(s_term(tt, dim, tag=col in MIXED_COLS) for tt, dim in terms) + "</td>")
    depth = len(s_chain(c["id"])) - 1
    mode = {"subject": ' <span class="tag">subject only</span>', "none": ' <span class="tag">no single category</span>'}.get(c.get("mode", "classify"), "")
    sem_rows.append(f'<tr><td style="padding-left:{12 + depth * 14}px"><div class="cell-title">{esc(c["label"])}{mode}</div>'
                    f'<div class="muted small">{n_in_cat.get(c["id"], 0)} concepts · <code>i2x:{esc(c["cls"])}</code></div></td>' + "".join(cells) + "</tr>")
hermit = sem.get("hermit", {})
reason_items = [
    f'OWL 2 RL closure over the upper ontologies, I2IDL-X, I2IDL\'s whole release and a sample organization: {sem["owlrl"]["input"]:,} → {sem["owlrl"]["closed"]:,} triples, consistent.',
    *[f'HermiT (OWL 2 DL), {esc(g)} + I2IDL\'s release + I2IDL-X + the sample: {"consistent" if r.get("sample", {}).get("consistent") else "NOT consistent"}.' for g, r in hermit.items()],
    f'A thing classified as both a formative assessment and a classroom teacher is rejected under {", ".join(sem["clash"]["rejectedBy"])}, by OWL 2 RL and HermiT alike.',
    f'{len(sem["disjoint"])} of {sem["disjointCheck"]["pairs"]} pairs of referent categories can never share a member; one individual per pair, OWL 2 RL rejects exactly those pairs.',
    f'The SHACL-AF referent rules (TripleRules, no OWL) reach the same referent classes as OWL 2 RL for all {sem["rules"]["explicit"]} explicitly classified resources.',
    f'q-classify (plain SPARQL) concludes nothing OWL 2 RL does not and finds every referent class it finds: {sem["classify"]["sampleTypings"]} typings of the sample organization and {sem["classify"]["typings"] - sem["classify"]["sampleTypings"]} of the I2IDL services I2IDL-X classifies.',
    f'All {sem["terms"]} aligned terms exist in pinned snapshots of their publishers\' files.',
]
n_assigned = sum(n_in_cat.values())
n_by_def = sum(1 for _ in refs.subject_objects(I2X.assignmentBasis) if str(_[1]) == "definition")

# ── For I2IDL: its own roadmap, read from its README by the app build ────────────────────────────────
app_meta = json.loads((ROOT / "app" / "build" / "data.json").read_text())["meta"]
upstream = app_meta["upstream"]
n_unesco = sum(1 for _ in maps.subjects(I2X.citedIn, None))
prio_do = {
    1: f'{len(list(maps.subjects(RDF.type, I2X.MappingProposal)))} crosswalk proposals, {n_unesco} of them to the UNESCO Thesaurus drawn from citations your editors already made; a mapping triple appears only after ratification. <a href="#mappings">Mappings</a>',
    2: f'Your three example routes answered as stored queries against your own SPARQL service, inside your published limits, behind a HyprCat catalog of {n_controls} controls. <a href="#queries">Stored queries</a>',
    3: f'Your two provenance wordings, computed for every definition from your own evidence relations, and published as SHACL rules any engine can rerun. <a href="#SourceGroundedDefinition">Rules</a>',
    4: f'Every change since the first public release as PROV: {len(chg_rows)} release changes, {n_change_facts:,} fact-level changes, reconciling exactly with {esc(cfg["i2idl"]["release"])}. <a href="#history">Change history</a>',
}

# ── Verification report ─────────────────────────────────────────────────────────────────────────────
check_groups, cur_g = [], None
for line in report.splitlines():
    if line.startswith("## "):
        cur_g = {"title": line[3:].strip(), "items": []}
        check_groups.append(cur_g)
    elif line.startswith("- ") and cur_g is not None:
        m = re.match(r"- (PASS|FAIL|INFO) — (.*)", line)
        cur_g["items"].append((m.group(1), m.group(2)) if m else ("NOTE", line[2:]))
n_pass = sum(1 for g in check_groups for k, _ in g["items"] if k == "PASS")
n_fail = sum(1 for g in check_groups for k, _ in g["items"] if k == "FAIL")
checks_html = "".join(
    f'<div class="check-group"><h3>{esc(g["title"])}</h3><ul class="checklist">'
    + "".join(f'<li class="{k.lower()}"><span class="mark">{esc(k)}</span><span>{code_inline(t)}</span></li>' for k, t in g["items"])
    + "</ul></div>" for g in check_groups if g["items"] and g["title"] != "Summary")

# ── Live walkthrough facts ──────────────────────────────────────────────────────────────────────────
codes = re.findall(r"→ \*\*(\d{3})\*\*", walk)
found = re.search(r'"label": "([^"]+)"', walk)
ntrip = re.search(r"\*\*200\*\*, (\d+) triples", walk)
enacted_by = re.search(r"- `(\w+)` → `([^`]+)`", walk)
chain = []
if len(codes) >= 5:
    steps = [("Read the catalog", codes[0]),
             (f'Search “record store” → {found.group(1) if found else "a concept"}', codes[1]),
             (f'Follow its neighborhood control ({ntrip.group(1) if ntrip else "?"} triples)', codes[2]),
             (f'Follow {enacted_by.group(1) if enacted_by else "an enactment"} → {action_name(enacted_by.group(2)) if enacted_by else ""}', codes[3]),
             ("Invoke it: GET /xapi/about on Foxxi", codes[4])]
    sem_walk = re.search(r"## 6\. Type your own data.*?Result: \*\*(\d+) typings\*\*", walk, re.S)
    if sem_walk:
        port_codes = re.findall(r"`port-[a-z]+`: `GET [^`]+` \(Accept: [^)]+\) → \*\*(\d{3})\*\*", walk)
        steps.append((f"Follow the semantic-layer ports and run q-classify locally: {sem_walk.group(1)} typings of a sample organization",
                      max(port_codes) if port_codes else "?"))
    chain = [f'<li><span class="status s{c[0]}">{esc(c)}</span> {esc(t)}</li>' for t, c in steps]

# ── Page ────────────────────────────────────────────────────────────────────────────────────────────
cat_desc = by_slug[SLUG["catalog"]]["descriptor"]
release = cfg["i2idl"]["release"]
commit = re.search(r"commit `([0-9a-f]+)`", report)
commit_short = commit.group(1)[:7] if commit else ""
search_q = str(cat.value(CAT["q-concept-search"], I2X.sparql)).replace("$text", '"record store"').rstrip()
act_example = json.dumps({"descriptor_url": IRI["catalog"], "action_iri": NS + "act-query-glossary-post",
                          "payload": search_q}, indent=2, ensure_ascii=False)
invoke_example = json.dumps({"descriptor_url": IRI["catalog"], "action_iri": NS + "act-get-scheme", "payload": {}},
                            indent=2, ensure_ascii=False)
follow_example = json.dumps({"descriptor_url": cfg["foxxiManifest"], "action_iri": ACTION_ROOT + "foxxi/discover-lrs",
                             "payload": {}}, indent=2, ensure_ascii=False)
curl_example = (f"curl -H 'Accept: text/turtle' {IRI['catalog']}\n\n"
                f"curl -X POST {ENDPOINT} \\\n  -H 'Content-Type: application/sparql-query' \\\n  --data-binary @query.rq")

jsonld = {
    "@context": {"dcat": str(DCAT), "dct": str(DCT), "prov": str(PROV), "iep": str(IEP)},
    "@type": "dcat:Catalog",
    "dct:title": "I2IDL-X",
    "dct:description": "Interego/Foxxi agentic superset of the I2IDL Digital Learning Glossary.",
    "dct:creator": "Mark Spivey (Foxxi Mediums Inc.)",
    "dct:license": {"@id": "https://creativecommons.org/licenses/by/4.0/"},
    "prov:wasDerivedFrom": {"@id": "https://id.i2idl.org/scheme"},
    "dcat:dataset": [{
        "@id": IRI[key], "@type": "dcat:Dataset", "dct:title": title,
        "iep:modalStatus": {"@id": str(IEP) + by_slug[SLUG[key]]["modalStatus"]},
        "dcat:distribution": [{"@type": "dcat:Distribution", "dcat:accessURL": {"@id": IRI[key] + f"?format={f}"},
                               "dcat:mediaType": mt}
                              for f, mt in (("turtle", "text/turtle"), ("jsonld", "application/ld+json"),
                                            ("markdown", "text/markdown"))],
    } for key, title, _ in DISPLAY],
}

TOC = [("graphs", "Graphs", len(DISPLAY)), ("whose", "What's whose", len(origin_rows)), ("for-i2idl", "For I2IDL", len(prio_do)),
       ("agents", "Use it as an agent", None), ("semantic", "Semantic layer", len(SEMM.CATEGORIES)),
       ("controls", "Controls", n_controls), ("queries", "Stored queries", len(query_cards)), ("vocabulary", "Vocabulary", n_terms),
       ("enactments", "Enactments", len(enact_rows)), ("mappings", "Mappings", len(map_rows)),
       ("releases", "Releases", len(rel_rows)), ("history", "Change history", len(chg_rows)), ("checks", "Checks", n_pass)]
section_ids = {t[0] for t in TOC}
term_ids = set(re.findall(r'<article class="term" id="([^"]+)"', "".join(vocab_html)))
assert not (section_ids & term_ids), f"anchor collision: {section_ids & term_ids}"

CSS = r"""
:root {
  /* Layout: a masthead over a two-column reference (sticky section index, content); one column below 960px. */
  --paper: #f4f7f8;
  --surface: #ffffff;
  --ink: #142029;
  --muted: #566873;
  --rule: #d6dfe4;
  --accent: #1b6a86;
  --accent-soft: #e2eff4;
  --pencil: #7a8792;
  --pass: #2c7a4b;
  --code: #eaf0f2;
  --o-i2idl: #1f5f99; --o-x: #6a55c2; --o-proposed: #a87400; --o-interego: #0f7c86; --o-foxxi: #c2541b; --o-team: #2f8a3a;
  --font-display: "Red Hat Display", "Segoe UI", system-ui, sans-serif;
  --font-body: "Red Hat Text", "Segoe UI", system-ui, sans-serif;
  --font-mono: "Red Hat Mono", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #0c1216; --surface: #121a1f; --ink: #e1e8ec; --muted: #93a3ae; --rule: #24313a;
    --accent: #6bb6d1; --accent-soft: #15303a; --pencil: #8693a0; --pass: #63b787; --code: #17222a;
    --o-i2idl: #6fa8e0; --o-x: #a796f0; --o-proposed: #e0ad3a; --o-interego: #4fc0c9; --o-foxxi: #f08a52; --o-team: #6cc777;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #0c1216; --surface: #121a1f; --ink: #e1e8ec; --muted: #93a3ae; --rule: #24313a;
  --accent: #6bb6d1; --accent-soft: #15303a; --pencil: #8693a0; --pass: #63b787; --code: #17222a;
  --o-i2idl: #6fa8e0; --o-x: #a796f0; --o-proposed: #e0ad3a; --o-interego: #4fc0c9; --o-foxxi: #f08a52; --o-team: #6cc777;
  color-scheme: dark;
}
body { background: var(--paper); color: var(--ink); font-family: var(--font-body); font-size: 15px; line-height: 1.55; }
a { color: var(--accent); text-decoration-thickness: 1px; text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 3px; }
code, pre, .iri { font-family: var(--font-mono); }
code { font-size: 0.92em; }
.muted { color: var(--muted); }
.small { font-size: 13px; }

.shell { max-width: 1220px; margin: 0 auto; padding-inline: max(16px, 3vw); padding-block: 28px 72px;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 28px; }
@media (min-width: 960px) {
  .shell { grid-template-columns: 188px minmax(0, 1fr); column-gap: 44px; }
  .masthead, .site-foot { grid-column: 1 / -1; }
  .toc { position: sticky; top: calc(env(safe-area-inset-top, 0px) + 20px); align-self: start; }
  .toc ul { flex-direction: column; }
}
main { min-width: 0; display: grid; gap: 64px; }
main > section { min-width: 0; scroll-margin-top: 16px; }

.masthead { display: grid; gap: 18px; padding-bottom: 8px; border-bottom: 1px solid var(--rule); }
.eyebrow { margin: 0; font-family: var(--font-mono); font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
h1 { margin: 0; font-family: var(--font-display); font-weight: 900; font-size: clamp(52px, 10vw, 104px);
  line-height: 0.92; letter-spacing: -0.03em; }
.lede { margin: 0; font-size: 18px; max-width: 66ch; text-wrap: pretty; }
.meta { margin: 0; color: var(--muted); font-size: 13px; }
.entry { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 12px 14px;
  background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; max-width: 900px; }
.entry .label { width: 100%; font-size: 11.5px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); }
.entry code { flex: 1 1 340px; min-width: 0; font-size: 14px; overflow-wrap: anywhere; }
.facts-row { display: flex; flex-wrap: wrap; gap: 14px 34px; margin: 0; }
.facts-row div { display: flex; flex-direction: column-reverse; }
.facts-row dt { font-size: 12px; color: var(--muted); }
.facts-row dd { margin: 0; font-family: var(--font-display); font-weight: 700; font-size: 28px; line-height: 1.1;
  font-variant-numeric: tabular-nums; }
.package { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 14px; }
.fine { margin: 0; font-size: 13px; color: var(--muted); max-width: 90ch; }

.toc ul { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 16px; }
.toc a { display: flex; justify-content: space-between; gap: 10px; text-decoration: none; color: var(--ink); font-size: 14px; padding: 3px 0; }
.toc a:hover { color: var(--accent); }
.toc .n { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 12.5px; }

h2 { margin: 0 0 8px; font-family: var(--font-display); font-weight: 700; font-size: 30px; letter-spacing: -0.015em; text-wrap: balance; }
h3 { margin: 0; font-family: var(--font-display); font-weight: 700; font-size: 19px; text-wrap: balance; }
h4 { margin: 4px 0 2px; font-size: 15px; font-weight: 600; }
.intro { margin: 0 0 18px; max-width: 72ch; color: var(--muted); }
.intro strong { color: var(--ink); font-weight: 600; }

.chip { display: inline-block; font-size: 12px; line-height: 1; padding: 5px 9px; border-radius: 999px; white-space: nowrap; }
.chip.asserted { background: var(--ink); color: var(--paper); }
.chip.hypothetical { border: 1px dashed var(--pencil); color: var(--muted); padding: 4px 8px; }
.chip.local { border: 1px solid var(--rule); color: var(--muted); padding: 4px 8px; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 18px; align-items: center; margin: 0 0 14px; font-size: 13px; color: var(--muted); }
.method { display: inline-block; font-family: var(--font-mono); font-size: 12px; padding: 2px 6px; border: 1px solid var(--rule); border-radius: 4px; white-space: nowrap; }
.method.post { background: var(--accent-soft); border-color: var(--accent-soft); }
.tag { font-size: 11.5px; color: var(--muted); border: 1px dashed var(--pencil); border-radius: 4px; padding: 1px 5px; white-space: nowrap; }
.kind { font-size: 12.5px; color: var(--muted); }

.table-wrap { overflow-x: auto; background: var(--surface); border: 1px solid var(--rule); border-radius: 8px; }
.table-wrap.narrow { max-width: 620px; margin: 6px 0 10px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
.wide table { min-width: 860px; }
th, td { text-align: left; vertical-align: top; padding: 10px 12px; border-bottom: 1px solid var(--rule); }
thead th { font-size: 11.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
tr.group th { background: var(--paper); font-size: 11.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); }
td .iri, td code { font-size: 12.5px; overflow-wrap: break-word; }
.iri.tpl { color: var(--muted); }
.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.cell-title { font-weight: 600; }
td.links { white-space: nowrap; font-size: 13.5px; }
.hash { margin-top: 4px; font-size: 12.5px; color: var(--muted); display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; }
tr.local td { background: var(--paper); }
a.qn { font-family: var(--font-mono); font-size: 0.9em; text-decoration: none; border-bottom: 1px solid var(--rule); }
a.qn:hover { border-bottom-color: var(--accent); }
code.qn { font-size: 0.9em; }

.btn { display: inline-flex; align-items: center; gap: 6px; font: 500 13px/1 var(--font-body); padding: 8px 12px;
  border: 1px solid var(--rule); border-radius: 6px; background: var(--surface); color: var(--ink); cursor: pointer; text-decoration: none; }
.btn:hover { border-color: var(--accent); }
.btn-primary { background: var(--accent); border-color: var(--accent); color: var(--paper); }
.btn-primary:hover { filter: brightness(1.08); }
.btn-tiny { padding: 3px 7px; font-size: 12px; }
.btn[disabled] { opacity: 0.55; cursor: default; }
.note { font-size: 13px; color: var(--muted); }
.copy-fallback { font: 12px var(--font-mono); padding: 4px 6px; border: 1px solid var(--rule); border-radius: 4px; background: var(--surface); color: var(--ink); width: min(100%, 420px); }

pre { margin: 0; padding: 12px 14px; background: var(--code); border-radius: 6px; overflow-x: auto; font-size: 13px; line-height: 1.5; }
pre code { font-size: inherit; white-space: pre; }

.steps { margin: 0 0 22px; padding-left: 22px; display: grid; gap: 16px; max-width: 900px; }
.steps li { padding-left: 4px; min-width: 0; }
.steps p { margin: 2px 0 8px; }
.chain { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.chain li { background: var(--surface); border: 1px solid var(--rule); border-radius: 6px; padding: 7px 10px; font-size: 13px; }
.status { font-family: var(--font-mono); font-weight: 500; margin-right: 4px; }
.status.s2 { color: var(--pass); }
.status.s3 { color: var(--accent); }

.queries { display: grid; gap: 30px; }
.query { display: grid; gap: 10px; min-width: 0; padding-top: 18px; border-top: 1px solid var(--rule); }
.query p { margin: 0; max-width: 78ch; }
.query-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; }
.params { display: flex; flex-wrap: wrap; gap: 8px 18px; }
.param { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; min-width: 0; flex: 1 1 320px; }
.param label { font-family: var(--font-mono); font-size: 13px; color: var(--muted); }
.param input, .filters input, .filters select { font: 13.5px var(--font-body); padding: 7px 9px; border: 1px solid var(--rule);
  border-radius: 6px; background: var(--surface); color: var(--ink); min-width: 0; }
.param input { font-family: var(--font-mono); font-size: 13px; flex: 1 1 260px; }
.row-actions { display: flex; flex-wrap: wrap; gap: 8px; }

.filters { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin: 0 0 12px; }
.filters input[type="search"] { flex: 1 1 260px; max-width: 420px; }
.count { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }

.vocab { display: grid; gap: 34px; }
.vocab-section { display: grid; gap: 0; min-width: 0; }
.vocab-section > h3 { margin-bottom: 8px; }
.letter { font-family: var(--font-mono); font-weight: 500; color: var(--accent); margin-right: 4px; }
.term { padding: 14px 0 12px; border-top: 1px solid var(--rule); scroll-margin-top: 16px; min-width: 0; }
.term:target { background: var(--accent-soft); box-shadow: 0 0 0 8px var(--accent-soft); }
.term-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; }
.term-qn { font-size: 14.5px; font-weight: 500; overflow-wrap: anywhere; }
.term p { margin: 2px 0 6px; max-width: 76ch; }
.facts { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 16px; margin: 4px 0 0; font-size: 13.5px; }
.facts div { display: contents; }
.facts dt { color: var(--muted); }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
@media (max-width: 560px) {
  .facts { grid-template-columns: minmax(0, 1fr); gap: 0; }
  .facts dd { margin-bottom: 6px; }
}

.roles { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr)); gap: 16px 28px; margin-top: 18px; }
.role { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 8px; min-width: 0; }
.role .cell-title { width: 100%; }
.cap a.qn { font-size: 12.5px; }

.checks { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: 22px 32px; }
.check-group h3 { font-size: 16px; margin-bottom: 6px; }
.checklist { list-style: none; margin: 0; padding: 0; display: grid; gap: 5px; font-size: 13.5px; }
.checklist li { display: grid; grid-template-columns: 44px minmax(0, 1fr); gap: 8px; }
.checklist li > span:last-child { min-width: 0; overflow-wrap: anywhere; }
.mark { font-family: var(--font-mono); font-size: 11.5px; padding-top: 2px; }
.checklist .pass .mark { color: var(--pass); }
.checklist .fail .mark { color: #c0392b; }
.checklist .info .mark, .checklist .note .mark { color: var(--muted); }

.site-foot { border-top: 1px solid var(--rule); padding-top: 18px; display: grid; gap: 6px; font-size: 13px; color: var(--muted); }
.site-foot p { margin: 0; max-width: 100ch; }

.origin { display: inline-block; font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 999px; border: 1px solid var(--rule); white-space: nowrap; }
.origin.o-i2idl { color: var(--o-i2idl); border-color: var(--o-i2idl); }
.origin.o-derived, .origin.o-added { color: var(--o-x); border-color: var(--o-x); }
.origin.o-proposed { color: var(--o-proposed); border: 1px dashed var(--o-proposed); }
.origin.o-interego { color: var(--o-interego); border-color: var(--o-interego); }
.origin.o-foxxi { color: var(--o-foxxi); border-color: var(--o-foxxi); }
.origin.o-team { color: var(--o-team); border-color: var(--o-team); }
.sem-matrix td { min-width: 120px; }
.sem-matrix td:first-child { min-width: 220px; }
.sterm { display: inline-block; margin: 0 3px 4px 0; padding: 1px 6px; border-radius: 5px; background: var(--code); color: var(--ink);
  font-size: 12.5px; font-weight: 600; text-decoration: none; }
.sterm.dim { background: transparent; border: 1px solid var(--rule); color: var(--muted); font-weight: 400; }
.sterm:hover { outline: 1px solid var(--accent); }
.sterm .tv { margin-right: 5px; padding-right: 5px; border-right: 1px solid var(--rule); color: var(--muted); font-size: 10.5px; font-weight: 700; }
@media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; transition: none !important; } }
"""

JS = r"""
(function () {
  function flash(btn, text) {
    var old = btn.dataset.label || btn.textContent;
    btn.dataset.label = old;
    btn.textContent = text;
    setTimeout(function () { btn.textContent = old; }, 1600);
  }
  function fallback(btn, text) {
    var box = btn.parentNode.querySelector('.copy-fallback');
    if (!box) {
      box = document.createElement('input');
      box.className = 'copy-fallback';
      box.readOnly = true;
      btn.insertAdjacentElement('afterend', box);
    }
    box.value = text;
    box.focus();
    box.select();
    flash(btn, 'Selected');
  }
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-copy], [data-copy-from]');
    if (!btn) return;
    var src = btn.dataset.copyFrom ? document.getElementById(btn.dataset.copyFrom) : null;
    var text = src ? src.textContent : btn.dataset.copy;
    try {
      navigator.clipboard.writeText(text).then(function () { flash(btn, 'Copied'); }, function () {
        if (src) { var r = document.createRange(); r.selectNodeContents(src); var s = getSelection(); s.removeAllRanges(); s.addRange(r); flash(btn, 'Selected'); }
        else fallback(btn, text);
      });
    } catch (err) { fallback(btn, text); }
  });

  // Stored queries: rebind parameters, update the shown query and its live link.
  document.querySelectorAll('.query').forEach(function (card) {
    var src = card.querySelector('.q-src');
    if (!src) return;
    var template = JSON.parse(src.textContent);
    var code = card.querySelector('pre code');
    var run = card.querySelector('a.run');
    var inputs = card.querySelectorAll('input[data-param]');
    function bind() {
      var q = template;
      inputs.forEach(function (inp) {
        var re = new RegExp('\\$' + inp.dataset.param + '\\b', 'g');
        q = q.replace(re, function () { return inp.value; });
      });
      code.textContent = q.replace(/\s+$/, '');
      if (run) run.href = '__ENDPOINT__?query=' + encodeURIComponent(q);
    }
    inputs.forEach(function (inp) { inp.addEventListener('input', bind); });
  });

  // Row filters.
  function wire(opts) {
    var box = document.getElementById(opts.search);
    var sel = opts.select ? document.getElementById(opts.select) : null;
    var rows = Array.prototype.slice.call(document.querySelectorAll(opts.rows));
    var count = document.getElementById(opts.count);
    function apply() {
      var q = (box.value || '').trim().toLowerCase();
      var v = sel ? sel.value : '';
      var shown = 0;
      rows.forEach(function (r) {
        var ok = (!q || r.dataset.search.indexOf(q) !== -1) && (!v || r.getAttribute(opts.attr) === v);
        r.hidden = !ok;
        if (ok) shown++;
      });
      if (opts.after) opts.after();
      count.textContent = shown === rows.length ? rows.length + ' shown' : shown + ' of ' + rows.length + ' shown';
    }
    box.addEventListener('input', apply);
    if (sel) sel.addEventListener('change', apply);
    apply();
  }
  wire({ search: 'enact-q', select: 'enact-role', attr: 'data-role', rows: '#enact-table tbody tr', count: 'enact-count' });
  wire({ search: 'map-q', select: 'map-vocab', attr: 'data-vocab', rows: '#map-table tbody tr', count: 'map-count' });
  wire({ search: 'vocab-q', rows: '.term', count: 'vocab-count', after: function () {
    document.querySelectorAll('.vocab-section').forEach(function (sec) {
      sec.hidden = !sec.querySelector('.term:not([hidden])') && !!document.getElementById('vocab-q').value.trim();
    });
  } });

  // Package download: the package's files are published next to this page as text; on request they are
  // zipped in the browser (JSZip, loaded only then) and offered through the downloads capability.
  var btn = document.getElementById('save-package');
  var note = document.getElementById('save-note');
  var files = JSON.parse(document.getElementById('pkg-manifest').textContent);
  function loadZip() {
    if (window.JSZip) return Promise.resolve(window.JSZip);
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = '__JSZIP__';
      s.onload = function () { window.JSZip ? resolve(window.JSZip) : reject({ code: 'zip' }); };
      s.onerror = function () { reject({ code: 'zip' }); };
      document.head.appendChild(s);
    });
  }
  var ready = (window.claude && typeof window.claude.use === 'function') ? window.claude.use('downloads') : Promise.resolve(null);
  ready.then(function (dl) {
    if (!dl) { btn.hidden = true; note.textContent = 'Saving the package isn’t available in this view. Every graph is linked below.'; return; }
    btn.addEventListener('click', function () {
      btn.disabled = true;
      var done = 0;
      note.textContent = 'Collecting files…';
      loadZip().then(function (JSZip) {
        var zip = new JSZip();
        var queue = files.slice();
        function next() {
          var path = queue.shift();
          if (!path) return Promise.resolve();
          return fetch(path).then(function (r) {
            if (!r.ok) throw { code: 'fetch' };
            return r.arrayBuffer();
          }).then(function (buf) {
            zip.file(path, buf);
            done++;
            note.textContent = 'Collecting files… ' + done + ' of ' + files.length;
            return next();
          });
        }
        var lanes = [];
        for (var i = 0; i < 6; i++) lanes.push(next());
        return Promise.all(lanes).then(function () {
          note.textContent = 'Zipping…';
          return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
        });
      }).then(function (blob) {
        return dl.save({ filename: '__PACKAGE__', data: blob });
      }).then(function () {
        note.textContent = 'Package saved.';
      }, function (err) {
        var c = err && err.code;
        note.textContent = c === 'declined' ? 'Not saved.' : c === 'rate_limited' ? 'A save prompt is already open.'
          : c === 'fetch' ? 'A package file could not be loaded. Try again.'
          : c === 'zip' ? 'The zip tool did not load. Try again in a moment.' : 'Saving isn’t available here.';
      }).then(function () { btn.disabled = false; });
    });
  }, function () { btn.hidden = true; });
})();
""".replace("__ENDPOINT__", ENDPOINT).replace("__PACKAGE__", PACKAGE).replace(
    "__JSZIP__", "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js")

# The package as published next to the page: every file under the package root, at its package path.
PKG_PARENT = ROOT.parent
manifest = sorted({str(p.relative_to(PKG_PARENT)) for p in ROOT.rglob("*")
                   if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"
                   and not any(part.startswith(".") for part in p.relative_to(ROOT).parts)  # build scratch (.reasoning)
                   # Other publishers' ontology files are referenced, not redistributed: tools/refresh_upper.py fetches
                   # them again from the pinned sources that evidence/upper/manifest.json records, with their SHA-256.
                   and not (p.parent == ROOT / "evidence" / "upper" and p.suffix == ".ttl")
                   and not (p.parent == ROOT / "evidence" and p.name.startswith("interego-") and p.suffix == ".ttl")
                   and not (p.parent == ROOT / "evidence" and p.name.startswith("xapi-") and p.suffix == ".ttl")
                   and "node_modules" not in p.parts and not p.relative_to(ROOT).as_posix().startswith("app/build/")}
                  | {str(OUT.relative_to(PKG_PARENT))})
pkg_mb = sum((PKG_PARENT / m).stat().st_size for m in manifest if (PKG_PARENT / m).exists()) / 1e6

role_options = "".join(f'<option value="{esc(r)}">{esc(r)} ({n})</option>' for r, n in sorted(roles_seen.items()))
vocab_options = "".join(f'<option value="{esc(v)}">{esc(v)} ({vocab_counts[v]})</option>'
                        for _, v in VOCABS if v in vocab_counts)
method_summary = ", ".join(f"{n} {m}" for m, n in sorted(method_counts.items(), key=lambda kv: -kv[1]))

page = f"""<title>I2IDL-X</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Red+Hat+Display:wght@700;900&family=Red+Hat+Mono:wght@400;500&family=Red+Hat+Text:ital,wght@0,400;0,500;0,600;1,400&display=swap">
<style>{CSS}</style>
<script type="application/ld+json">{json_script(jsonld)}</script>
<script type="application/json" id="pkg-manifest">{json_script(manifest)}</script>
<div class="shell">
<header class="masthead">
  <p class="eyebrow">@prefix i2x: &lt;{esc(NS)}&gt; .</p>
  <h1>I2IDL-X</h1>
  <p class="lede">An agentic superset of the I2IDL Digital Learning Glossary. It gives all {n_concepts} concepts agentic kinds,
  interpretant layers, hypermedia controls and governed crosswalks to Foxxi and Interego, and makes the glossary a semantic
  layer for the industry's data: what each concept classifies, aligned with BFO 2020, gist, DOLCE-UltraLite, gUFO, PROV-O,
  schema.org and the learning-industry vocabularies. Nothing in the glossary is copied or changed. The graphs are published
  as linked data on Interego; this page is their reference.</p>
  <p class="meta">Version {esc(cfg['version'])} · built against I2IDL {esc(release)} (commit <code>{esc(commit_short)}</code>) ·
  pod <code>{esc(cfg['owner'])}</code></p>
  <div class="entry"><span class="label">Agent entry point</span><code id="entry-iri">{wbr(IRI['catalog'])}</code>
    <button class="btn" type="button" data-copy-from="entry-iri">Copy</button>{ext(IRI['catalog'], 'Open', 'btn')}</div>
  <dl class="facts-row">
    <div><dt>concepts decorated</dt><dd>{n_concepts}</dd></div>
    <div><dt>catalog controls</dt><dd>{n_controls}</dd></div>
    <div><dt>stored queries</dt><dd>{len(query_cards)}</dd></div>
    <div><dt>enactments, proposed</dt><dd>{len(enact_rows)}</dd></div>
    <div><dt>mapping proposals</dt><dd>{len(map_rows)}</dd></div>
    <div><dt>releases tracked</dt><dd>{len(rel_rows)}</dd></div>
    <div><dt>referent categories</dt><dd>{len(SEMM.CATEGORIES)}</dd></div>
    <div><dt>aligned terms</dt><dd>{sem["terms"]}</dd></div>
    <div><dt>build checks passing</dt><dd>{n_pass}/{n_pass + n_fail}</dd></div>
  </dl>
  <div class="package"><button class="btn btn-primary" type="button" id="save-package">Save the package (.zip)</button>
    <span class="note" id="save-note">Sources, build, all graphs, decorations and reports: {len(manifest)} files, {pkg_mb:.1f} MB, zipped in your browser.</span></div>
  {f'<div class="entry"><span class="label">Workbench for people</span><span>Interpretant: search, entries, map, compare, review, packs, insights, Ask Claude and Orchestrate — a team of Claude agents working the workbench in front of you — over the glossary and these graphs.</span>{ext(cfg["appArtifactUrl"], "Open Interpretant", "btn btn-primary")}</div>' if cfg.get("appArtifactUrl") else ""}
  <p class="fine">Independent work by Mark Spivey (Foxxi Mediums Inc.), drafted with Claude. Not affiliated with or endorsed by I2IDL.
  Concept labels on this page come from the I2IDL Digital Learning Glossary (CC BY 4.0).</p>
</header>
<nav class="toc" aria-label="Sections"><ul>
{"".join(f'<li><a href="#{i}">{esc(t)}<span class="n">{n if n is not None else ""}</span></a></li>' for i, t, n in TOC)}
</ul></nav>
<main>
<section id="graphs" aria-labelledby="h-graphs">
  <h2 id="h-graphs">Graphs</h2>
  <p class="intro">{len(DISPLAY)} graphs are published to the Interego pod <code>{esc(cfg['owner'])}</code>. Each IRI serves an HTML page
  to a browser and Turtle, JSON-LD or HyperMarkdown on request. The signed descriptor is the authority for a graph's
  provenance and content hash.</p>
  <div class="legend"><span><span class="chip asserted">Asserted</span> committed</span>
    <span><span class="chip hypothetical">Hypothetical</span> proposed, awaiting review</span></div>
  <div class="table-wrap wide"><table>
    <thead><tr><th>Graph</th><th>Status</th><th class="num">Triples</th><th>Open as</th><th>Authority</th></tr></thead>
    <tbody>{"".join(graph_rows)}</tbody></table></div>
</section>


<section id="whose" aria-labelledby="h-whose">
  <h2 id="h-whose">What's whose</h2>
  <p class="intro">Everything shown alongside I2IDL carries one of these labels. They are the ontology's own
  <a class="qn" href="#Origins">i2x:Origins</a> scheme, and the workbench uses the same wording.</p>
  <div class="table-wrap wide"><table>
    <thead><tr><th>Label</th><th>What it covers</th><th>How far to trust it</th><th>Held in</th></tr></thead>
    <tbody>{"".join(origin_rows)}</tbody></table></div>
</section>

<section id="for-i2idl" aria-labelledby="h-for-i2idl">
  <h2 id="h-for-i2idl">For I2IDL</h2>
  <p class="intro">I2IDL made the glossary linked data: stable IRIs, first-class definitions, classified evidence, sources
  that keep their own rights and a SPARQL service with published limits. That is why everything here works without a copy
  of the glossary or a change to it. Here are I2IDL's own next development priorities, from
  {ext(upstream["readme"], "its README at " + esc(commit_short))}, and what I2IDL-X runs for each today.</p>
  <div class="table-wrap wide"><table>
    <thead><tr><th>I2IDL's priority</th><th>Running today in I2IDL-X</th></tr></thead>
    <tbody>{"".join(f'<tr><td><div class="cell-title">{p["n"]}. {esc(p["title"])}</div>{ext(upstream["readme"] + "#" + p["anchor"], "README", "small")}</td><td class="small">{prio_do[p["n"]]}</td></tr>' for p in upstream["priorities"])}</tbody></table></div>
  <p class="intro" style="margin-top:14px">Beyond the roadmap: every concept says what kind of thing it names, so data that links to
  I2IDL's IRIs is typed in the upper ontologies and peer vocabularies (see <a href="#semantic">Semantic layer</a>).
  {ext(cfg["appArtifactUrl"] + "#for-i2idl", "The workbench's For I2IDL view") + " walks through all of it and exports an editorial packet." if cfg.get("appArtifactUrl") else ""}</p>
</section>

<section id="agents" aria-labelledby="h-agents">
  <h2 id="h-agents">Use it as an agent</h2>
  <p class="intro">An agent needs only the catalog IRI. Everything else is discovered from it.</p>
  <ol class="steps">
    <li><strong>Read the catalog.</strong><p>GET the catalog IRI as Turtle, or with <code>?format=markdown</code> to see
      its controls as readable blocks. It states the SPARQL service's limits before you spend a call.</p></li>
    <li><strong>Pick a control by its action IRI.</strong><p>Read ports name the capability they need. Write ports also
      name the shape the relay checks before anything is stored, and write only to your own pod.</p></li>
    <li><strong>Act through Interego.</strong><p>Pass the catalog IRI as the descriptor. It stays the same when the
      catalog is republished, and the follower re-resolves each target from the published graph. For SPARQL, send
      the query text itself as a string payload to the POST port:</p>
      <pre><code id="ex-act">act {esc(act_example)}</code></pre>
      <div class="row-actions" style="margin:8px 0 12px"><button class="btn" type="button" data-copy-from="ex-act">Copy</button></div>
      <p>Reads without input take an empty payload:</p>
      <pre><code id="ex-invoke">invoke_affordance {esc(invoke_example)}</code></pre></li>
    <li><strong>Follow an enactment to the capability.</strong><p>The enactments graph links a concept to action IRIs
      through <code>i2x:realizedBy</code>, <code>i2x:measuredBy</code> and the other roles. Each action IRI redirects
      to the manifest that defines it; pass that manifest as the descriptor:</p>
      <pre><code id="ex-follow">invoke_affordance {esc(follow_example)}</code></pre></li>
    <li><strong>Or call the services directly.</strong><p>Plain HTTP works too. The SPARQL GET port takes
      <code>?query=</code>; the POST port takes the query as the body.</p>
      <pre><code id="ex-curl">{esc(curl_example)}</code></pre></li>
  </ol>
  <h3>Last live run</h3>
  <p class="intro" style="margin-top:4px">Read-only, executed against the live services when this package was built.</p>
  <ol class="chain">{"".join(chain)}</ol>
</section>


<section id="semantic" aria-labelledby="h-semantic">
  <h2 id="h-semantic">Semantic layer</h2>
  <p class="intro">An I2IDL concept is a term. The things it classifies (an LRS deployment, a quiz session, a teacher, a badge)
  are typed in upper ontologies and peer vocabularies from one link, <a class="qn" href="#isClassifiedBy">i2x:isClassifiedBy</a>.
  Each of the {n_assigned} concepts has one of {len(SEMM.CATEGORIES)} referent categories: {n_assigned - n_by_def} follow I2IDL's own type,
  {n_by_def} are decided by the definition, each with its reason ({ext(IRI["referents"], "i2idlx-referents")}). Each category is aligned once, with a
  rationale, in {ext(IRI["alignments"], "i2idlx-alignments")}, together with I2IDL's own record types and the Interego and Foxxi vocabularies.
  <strong>All of it is proposed</strong> (Hypothetical): a reasoner using it reaches Hypothetical conclusions.</p>
  <div class="table-wrap wide sem-matrix"><table>
    <thead><tr><th>Category</th>{"".join(f"<th>{esc(lbl)}</th>" for _, lbl in SEMM.COLUMNS)}</tr></thead>
    <tbody>{"".join(sem_rows)}</tbody></table></div>
  <p class="note" style="margin-top:8px">Bold: the category's own alignments; plain: inherited from its parent category, or (peers) a class to publish
  descriptions as. Labels are each publisher's own, from pinned snapshots of their files.</p>
  <h3 style="margin-top:22px">What the build proves before anything is published</h3>
  <ul class="checklist" style="margin-top:8px">{"".join(f'<li class="pass"><span class="mark">PASS</span><span>{x}</span></li>' for x in reason_items)}</ul>
  <h3 style="margin-top:22px">Using it</h3>
  <ol class="steps" style="margin-top:8px">
    <li><strong>Follow three ports.</strong><p><a href="#port-vocabulary">port-vocabulary</a>, <a href="#port-alignments">port-alignments</a> and
      <a href="#port-referents">port-referents</a> carry the whole layer.</p></li>
    <li><strong>Classify without a reasoner.</strong><p>Load what they return with your own data and run <a href="#q-classify">q-classify</a>, plain
      SPARQL 1.1: it reaches what OWL 2 RL reaches for your data's types.</p></li>
    <li><strong>Or reason in full.</strong><p>Add the upper ontologies' own files and run an OWL 2 RL engine or a DL reasoner to find
      contradictions such as a quiz that is also a teacher.</p></li>
    <li><strong>Publish your context graph.</strong><p><a href="#port-publish-classified">port-publish-classified</a> writes your resources,
      classified by I2IDL concepts, to your own pod; the relay checks them against the shapes first.</p></li>
  </ol>
</section>

<section id="controls" aria-labelledby="h-controls">
  <h2 id="h-controls">Controls</h2>
  <p class="intro">{n_controls} controls in the catalog. {n_followable} have a concrete target and can be followed as they are.
  The {n_templates} templates are expanded per concept by an agent, or materialized by the decorator projection.</p>
  <div class="table-wrap wide"><table>
    <thead><tr><th>Control</th><th>Action</th><th>Method</th><th>Target</th><th>Media type</th><th>Needs</th></tr></thead>
    <tbody>{"".join(control_rows)}</tbody></table></div>
</section>

<section id="queries" aria-labelledby="h-queries">
  <h2 id="h-queries">Stored queries</h2>
  <p class="intro">Parameterized queries for the SPARQL ports, shown with sample bindings. Edit a parameter and the query
  and its live link update; results open in a new tab. The I2IDL endpoint allows 30 requests a minute,
  12,000-character queries and 5,000 result rows, with no Update, SERVICE or FROM.</p>
  <div class="queries">{"".join(query_cards)}</div>
</section>

<section id="vocabulary" aria-labelledby="h-vocabulary">
  <h2 id="h-vocabulary">Vocabulary</h2>
  <p class="intro">The <code>i2x:</code> terms, grouped as in the ontology source. A term's anchor here matches its
  fragment, so <code>i2x:GlossaryConcept</code> is <a href="#GlossaryConcept">#GlossaryConcept</a> on this page.
  The canonical definitions live at <a href="{esc(IRI['ontology'])}" target="_blank" rel="noopener">{esc(IRI['ontology'])}</a>.</p>
  <div class="filters"><input type="search" id="vocab-q" placeholder="Filter terms" aria-label="Filter terms">
    <span class="count" id="vocab-count"></span></div>
  <div class="vocab">{"".join(vocab_html)}</div>
</section>

<section id="enactments" aria-labelledby="h-enactments">
  <h2 id="h-enactments">Enactments</h2>
  <p class="intro">Links from I2IDL concepts to the live Foxxi and Interego capabilities that enact them, each with a role,
  a rationale and a confidence. <strong>AI-drafted and published as Hypothetical</strong> until a reviewer ratifies them.
  Each action IRI redirects to the manifest that defines the capability.</p>
  <div class="filters"><input type="search" id="enact-q" placeholder="Filter by concept, action or rationale" aria-label="Filter enactments">
    <select id="enact-role" aria-label="Role"><option value="">All roles</option>{role_options}</select>
    <span class="count" id="enact-count"></span></div>
  <div class="table-wrap wide"><table id="enact-table">
    <thead><tr><th>I2IDL concept</th><th>Role</th><th>Action</th><th class="num">Conf.</th><th>Rationale</th></tr></thead>
    <tbody>{"".join(enact_rows)}</tbody></table></div>
  <h3 style="margin-top:26px">Role capabilities</h3>
  <p class="intro" style="margin-top:4px">{n_role_caps} actions an agent acting in an I2IDL role is expected to wield.</p>
  <div class="roles">{"".join(role_html)}</div>
</section>

<section id="mappings" aria-labelledby="h-mappings">
  <h2 id="h-mappings">Mapping proposals</h2>
  <p class="intro">SKOS crosswalks from I2IDL concepts to external vocabularies ({esc(method_summary)}). Every target
  was checked to exist. Proposals are records, not triples: a <code>skos:*Match</code> triple appears only after a
  ratification vote, and the shapes reject internal targets and ratified lexical-only candidates.</p>
  <div class="filters"><input type="search" id="map-q" placeholder="Filter by concept, term or rationale" aria-label="Filter mappings">
    <select id="map-vocab" aria-label="Vocabulary"><option value="">All vocabularies</option>{vocab_options}</select>
    <span class="count" id="map-count"></span></div>
  <div class="table-wrap wide"><table id="map-table">
    <thead><tr><th>I2IDL concept</th><th>Relation</th><th>External term</th><th>Method</th><th class="num">Conf.</th><th>Rationale</th></tr></thead>
    <tbody>{"".join(map_rows)}</tbody></table></div>
</section>

<section id="releases" aria-labelledby="h-releases">
  <h2 id="h-releases">Releases</h2>
  <p class="intro">Every I2IDL version, derived from the public git history of
  {ext("https://github.com/blakeplock/i2idl-linked-data", "blakeplock/i2idl-linked-data")}, newest first. An agent
  checks the release before trusting decorations; the catalog's release-check query answers in one call.</p>
  <div class="table-wrap wide"><table>
    <thead><tr><th>Version</th><th class="num">Date</th><th>Commit</th><th class="num">Concepts</th><th class="num">Related pairs</th><th class="num">Broader pairs</th><th>Concept changes</th></tr></thead>
    <tbody>{"".join(rel_rows)}</tbody></table></div>
</section>


<section id="history" aria-labelledby="h-history">
  <h2 id="h-history">Change history</h2>
  <p class="intro">I2IDL's roadmap asks for machine-readable change history (priority 4). {ext(IRI["changes"], "i2idlx-changes")} derives it from
  the public git history: one <code>prov:Activity</code> per release change, which <code>prov:used</code> the previous release and
  <code>prov:generated</code> the next, with typed events naming what each touched. {n_change_facts:,} fact-level changes; the baseline plus every
  addition minus every removal equals the current release.</p>
  <div class="table-wrap wide"><table>
    <thead><tr><th>Release change</th><th class="num">Date</th><th class="num">Facts</th><th>By kind</th></tr></thead>
    <tbody>{"".join(chg_rows)}</tbody></table></div>
</section>

<section id="checks" aria-labelledby="h-checks">
  <h2 id="h-checks">Checks</h2>
  <p class="intro">From the last build: {n_pass} checks pass and {n_fail} fail. Live checks ran against id.i2idl.org, the Foxxi
  bridge and the Interego relay.</p>
  <div class="checks">{checks_html}</div>
</section>
</main>
<footer class="site-foot">
  <p>I2IDL-X {esc(cfg['version'])}. Licensed CC BY 4.0. Creator: Mark Spivey (Foxxi Mediums Inc.). Drafted with Claude (Anthropic);
  the crosswalks await human ratification.</p>
  <p>The I2IDL Digital Learning Glossary is published by I2IDL at {ext("https://www.i2idl.org/glossary", "i2idl.org/glossary")}.
  I2IDL-X decorates it and is not affiliated with or endorsed by I2IDL.</p>
  <p>Canonical IRIs live on Interego under <code>{esc(BASE)}/</code>. This page is a generated reference; regenerate it with
  <code>tools/build_site.py</code>.</p>
</footer>
</div>
<script>{JS}</script>
"""

ids = set(re.findall(r'\sid="([^"]+)"', page))
dangling = sorted({h for h in re.findall(r'href="#([^"]+)"', page)} - ids)
assert not dangling, f"in-page links with no target: {dangling}"

OUT.parent.mkdir(exist_ok=True)
OUT.write_text(page)
print(f"{OUT}: {len(page):,} bytes; {n_terms} terms, {n_controls} controls, {len(query_cards)} queries, "
      f"{len(enact_rows)} enactments, {n_role_caps} role capabilities, {len(map_rows)} mappings, {len(rel_rows)} releases, "
      f"{n_pass} checks pass, {n_fail} fail; walkthrough chain {len(chain)} steps")
