#!/usr/bin/env python3
"""Build and verify I2IDL-X.

    python3 -I build.py [--live]

Reads the pinned I2IDL release from a local clone, renders the ontology / shapes / rules /
catalog templates, generates the enactments and mappings graphs from src/crosswalk.py
(refusing any row that does not resolve), materializes per-concept decorations, and runs
every check it can: Turtle parsing, SHACL (upstream contract + superset), SHACL-AF rules,
stored queries, and Interego's own affordance extractor. --live adds HTTP checks against
id.i2idl.org, the relay and the Foxxi bridge.
"""
import datetime as dt
import os
import importlib.util
import json
import pathlib
import re
import subprocess
import sys
import urllib.parse
import urllib.request

import rdflib
from rdflib import Graph, Literal, Namespace, URIRef
from rdflib.namespace import RDF, RDFS, SKOS, OWL, DCTERMS, XSD
from pyshacl import validate as shacl_validate

ROOT = pathlib.Path(__file__).resolve().parent
SRC, DIST, EVID, EX = ROOT / "src", ROOT / "dist", ROOT / "evidence", ROOT / "examples"
LIVE = "--live" in sys.argv

cfg = json.loads((ROOT / "config.json").read_text())
# Machine-specific paths: an environment variable wins; a relative path is read from the package root.
for _keys, _env in ((("i2idl", "localClone"), "I2IDL_CLONE"), (("interegoCoreSrc",), "INTEREGO_CORE_SRC"), (("tsx",), "INTEREGO_TSX")):
    _holder = cfg
    for _k in _keys[:-1]:
        _holder = _holder[_k]
    _v = os.environ.get(_env) or _holder.get(_keys[-1], "")
    _holder[_keys[-1]] = str((ROOT / _v).resolve()) if _v and not os.path.isabs(_v) else _v
BASE = f"{cfg['relayNsRoot']}/{cfg['owner']}"
IRI = {k: f"{BASE}/{v}" for k, v in cfg["slugs"].items()}
NS = IRI["ontology"] + "#"
I2X = Namespace(NS)
CAT = Namespace(IRI["catalog"] + "#")
EN = Namespace(IRI["enactments"] + "#")
MP = Namespace(IRI["mappings"] + "#")
GS = Namespace("https://glossarystudio.app/ns/")
IEP = Namespace("https://markjspivey-xwisee.github.io/interego/ns/iep#")
HYDRA = Namespace("http://www.w3.org/ns/hydra/core#")
PROV = Namespace("http://www.w3.org/ns/prov#")
SH = Namespace("http://www.w3.org/ns/shacl#")
ACTION_ROOT = "https://relay.interego.xwisee.com/ns/iep/action/"
SCHEME = URIRef("https://id.i2idl.org/scheme")
CONCEPT_BASE = "https://id.i2idl.org/concepts/"

spec = importlib.util.spec_from_file_location("crosswalk", SRC / "crosswalk.py")
cw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cw)
lspec = importlib.util.spec_from_file_location("layer", SRC / "layer.py")
layer_mod = importlib.util.module_from_spec(lspec)
lspec.loader.exec_module(layer_mod)
hspec = importlib.util.spec_from_file_location("history", SRC / "history.py")
hist = importlib.util.module_from_spec(hspec)
hspec.loader.exec_module(hist)

report: list[str] = []
failures: list[str] = []


def log(line: str = "") -> None:
    print(line)
    report.append(line)


def check(ok: bool, what: str) -> None:
    log(f"- {'PASS' if ok else 'FAIL'} — {what}")
    if not ok:
        failures.append(what)


def sh(cmd: list[str], cwd=None) -> str:
    return subprocess.run(cmd, cwd=cwd, check=True, capture_output=True, text=True).stdout


# ── 1. Pinned I2IDL release ─────────────────────────────────────────────────────
clone = cfg["i2idl"]["localClone"]
gpath = cfg["i2idl"]["graphPath"]
commit = sh(["git", "log", "-1", "--format=%H", "--", gpath], cwd=clone).strip()
commit_date = sh(["git", "log", "-1", "--format=%cI", "--", gpath], cwd=clone).strip()
raw = sh(["git", "show", f"{commit}:{gpath}"], cwd=clone)
glossary_bytes = len(raw.encode("utf-8"))
gl = Graph()
gl.parse(data=raw, format="json-ld", base="https://id.i2idl.org/")
release = str(gl.value(SCHEME, GS.publicationVersion))
assert release == cfg["i2idl"]["release"], f"clone is at {release}, config pins {cfg['i2idl']['release']}"

concepts = {str(c) for c in gl.subjects(RDF.type, SKOS.Concept)}
concept_ids = {str(gl.value(URIRef(c), DCTERMS.identifier)): c for c in concepts}
related_pairs = sum(1 for _ in gl.triples((None, SKOS.related, None))) // 2
broader_pairs = sum(1 for _ in gl.triples((None, SKOS.broader, None)))

# Reproducible builds: I2IDLX_BUILT_DATE / I2IDLX_MODIFIED / I2IDLX_NOW pin the stamps that end up in
# published graphs; I2IDLX_NOW_<GRAPH> (e.g. I2IDLX_NOW_ENACTMENTS) keeps an unchanged graph's own stamp.
BUILT = os.environ.get("I2IDLX_BUILT_DATE") or dt.date.today().isoformat()
MODIFIED = os.environ.get("I2IDLX_MODIFIED") or dt.date.today().isoformat()
TOKENS = {
    "{{NS}}": NS, "{{ONTO}}": IRI["ontology"], "{{SHAPES}}": IRI["shapes"], "{{RULES}}": IRI["rules"],
    "{{CATALOG}}": IRI["catalog"], "{{ENACT}}": IRI["enactments"], "{{MAPPINGS}}": IRI["mappings"],
    "{{DECOR}}": IRI["decorations"], "{{RELEASES}}": IRI["releases"], "{{CHANGES}}": IRI["changes"],
    "{{ALIGNMENTS}}": IRI["alignments"], "{{REFERENTS}}": IRI["referents"],
    "{{VERSION}}": cfg["version"], "{{BUILT}}": BUILT, "{{MODIFIED}}": MODIFIED,
    "{{COMMIT}}": commit, "{{I2IDL_RELEASE}}": release, "{{GRAPH_BYTES}}": str(glossary_bytes),
    "{{N_CONCEPTS}}": str(len(concepts)), "{{N_RELATED}}": str(related_pairs), "{{N_BROADER}}": str(broader_pairs),
}


def render(text: str) -> str:
    for k, v in TOKENS.items():
        text = text.replace(k, v)
    left = re.findall(r"\{\{[A-Z_]+\}\}", text)
    assert not left, f"unrendered tokens: {left}"
    return text


def lit(s: str) -> str:
    """Turtle short string literal."""
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


def long_lit(s: str) -> str:
    """Turtle long string literal (for SPARQL text)."""
    assert '"""' not in s
    # The publish path strips four leading spaces from lines inside long literals,
    # so a query indented that deep would not survive publication verbatim.
    deep = [l for l in s.splitlines() if l.startswith("    ")]
    assert not deep, f"long literal line indented 4+ spaces (would be altered on publish): {deep[0]!r}"
    return '"""' + s.replace("\\", "\\\\") + '"""'


DIST.mkdir(exist_ok=True)
EVID.mkdir(exist_ok=True)
for stale in DIST.glob("*-violations.txt"):
    stale.unlink()

log(f"# I2IDL-X build and verification report")
log()
log(f"- Built: {dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')}")
log(f"- I2IDL release: **{release}** (commit `{commit[:12]}`, {commit_date}), {glossary_bytes:,} bytes, {len(gl):,} triples")
log(f"- Concepts: {len(concepts)}; related pairs: {related_pairs}; broader/narrower pairs: {broader_pairs}")
log(f"- Namespace: `{NS}`")
log()

# ── 2. Reference data the crosswalk is checked against (snapshots in evidence/) ──
foxxi = json.loads((EVID / "foxxi-affordances.json").read_text())
foxxi_by_key = {r["action"].split("/ns/iep/action/")[-1]: r for r in foxxi if r.get("action")}
ops = json.loads((EVID / "relay-operations.json").read_text())
relay_keys = {m["action"].split("/ns/iep/action/")[-1] for m in ops["hydra:member"]}
known_actions = set(foxxi_by_key) | relay_keys

external_terms: set[str] = set(cw.VERIFIED_EXTERNAL)
unesco = json.loads((EVID / "unesco-thesaurus.json").read_text())
external_terms |= set(unesco["terms"])  # fetched from UNESCO's Skosmos API by tools/refresh_unesco.py
for f in ["xapi-ontology.ttl", "xapi-profile-ontology.ttl", "ns_ieee-ler.ttl", "ns_adl-tla.ttl", "iep.ttl"]:
    g = Graph().parse(EVID / f, format="turtle")
    external_terms |= {str(s) for s in g.subjects() if isinstance(s, URIRef)}


def action_iri(key: str) -> str:
    assert key in known_actions, f"unknown action {key}"
    return ACTION_ROOT + key


def concept_iri(cid: str) -> str:
    assert cid in concept_ids, f"concept '{cid}' is not in I2IDL {release}"
    return concept_ids[cid]


# ── 3. Static templates ──────────────────────────────────────────────────────────
change_kinds = "\n".join(
    f"i2x:change-{code} a skos:Concept ; skos:inScheme i2x:ChangeKinds ; skos:topConceptOf i2x:ChangeKinds ;\n"
    f"    skos:prefLabel {lit(label)}@en ; skos:definition {lit(definition)}@en ."
    for code, label, definition in hist.KINDS)
change_kinds = ("i2x:ChangeKinds skos:hasTopConcept " + " , ".join(f"i2x:change-{c}" for c in hist.KIND_CODES) + " .\n" + change_kinds)

# What's whose: the origin labels the workbench and the reference page share (src/origins.json).
collection_iris = {str(s) for s in gl.subjects(RDF.type, SKOS.Collection)}
ORIGIN_COUNTS = {"{n" + k.capitalize() + "s}": str(sum(1 for c in collection_iris if f"/collections/{k}/" in c))
                 for k in ("type", "field")}
ORIGIN_COUNTS["{nCurated}"] = str(sum(1 for c in collection_iris if "/collections/curated/" in c))
ORIGIN_COUNTS["{nSources}"] = str(len({s for s in gl.subjects() if str(s).startswith("https://id.i2idl.org/sources/")}))
_origins_text = (SRC / "origins.json").read_text()
for _k, _v in ORIGIN_COUNTS.items():
    _origins_text = _origins_text.replace(_k, _v)
ORIGINS = json.loads(_origins_text)
HELD_TOKENS = {"{" + k + "}": v for k, v in IRI.items()} | {"{foxxiManifest}": cfg["foxxiManifest"]}


def held_in(items: list[str]) -> list[str]:
    out = [HELD_TOKENS.get(h, h) for h in items]
    assert all(re.fullmatch(r"https://[^\s<>\"{}]+", h) for h in out), f"unresolved origin location in {items}"
    return out


origin_groups = {g["id"]: g for g in ORIGINS["groups"]}
origin_tops: list[str] = []
for o in ORIGINS["origins"]:
    top = o.get("broader") or o["id"]
    assert top == o["id"] or top in origin_groups, f"origin {o['id']}: unknown group {top}"
    if top not in origin_tops:
        origin_tops.append(top)
origin_blocks = ["i2x:Origins skos:hasTopConcept " + " , ".join(f"i2x:origin-{t}" for t in origin_tops) + " ."]
for gid, grp in origin_groups.items():
    members = [o["id"] for o in ORIGINS["origins"] if o.get("broader") == gid]
    origin_blocks.append(
        f"i2x:origin-{gid} a skos:Concept ; skos:inScheme i2x:Origins ; skos:topConceptOf i2x:Origins ;\n"
        f"    skos:notation {lit(gid)} ; skos:prefLabel {lit(grp['label'])}@en ;\n"
        f"    skos:definition {lit(grp['definition'])}@en ;\n"
        f"    skos:narrower " + " , ".join(f"i2x:origin-{m}" for m in members)
        + "".join(f" ;\n    i2x:heldIn <{h}>" for h in held_in(grp.get("heldIn", []))) + " .")
for o in ORIGINS["origins"]:
    place = (f"skos:broader i2x:origin-{o['broader']}" if o.get("broader") else "skos:topConceptOf i2x:Origins")
    held = held_in(o.get("heldIn", []))
    origin_blocks.append(
        f"i2x:origin-{o['id']} a skos:Concept ; skos:inScheme i2x:Origins ; {place} ;\n"
        f"    skos:notation {lit(o['id'])} ; skos:prefLabel {lit(o['label'])}@en ;\n"
        f"    skos:definition {lit(o.get('definition') or o['what'])}@en ;\n"
        f"    skos:scopeNote {lit(o.get('scope') or o['trust'])}@en"
        + (" ;\n    i2x:heldIn " + " , ".join(f"<{h}>" for h in held) if held else "") + " .")
GS_TYPE = URIRef("https://glossarystudio.app/ns/typeCollection")
layer_concepts = {str(gl.value(URIRef(c), DCTERMS.identifier)): {"iri": c, "type": str(gl.value(URIRef(c), GS_TYPE)).rsplit("/", 1)[-1]}
                  for c in concepts}
LAYER = layer_mod.Layer(ROOT, NS, IRI, layer_concepts, cw.MAPPINGS, release, commit)
onto_ttl = render((SRC / "i2idlx.ttl").read_text().replace("{{CHANGE_KINDS}}", change_kinds)
                  .replace("{{REFERENT_CATEGORIES}}", LAYER.ontology_section())
                  .replace("{{ORIGINS}}", "\n".join(origin_blocks))
                  .replace("{{ORIGINS_LABEL}}", ORIGINS["scheme"]["label"].replace('"', '\\"'))
                  .replace("{{ORIGINS_DEFINITION}}", ORIGINS["scheme"]["definition"].replace('"', '\\"')))
onto = Graph().parse(data=onto_ttl, format="turtle")
shapes_ttl = render((SRC / "i2idlx-shapes.ttl").read_text()
                    .replace("{{CHANGE_KIND_LIST}}", " ".join(f"i2x:change-{c}" for c in hist.KIND_CODES))
                    .replace("{{REFERENT_CATEGORY_LIST}}", " ".join(f"i2x:category-{c['id']}" for c in LAYER.sem.CATEGORIES)))
shapes = Graph().parse(data=shapes_ttl, format="turtle")

# Rules generated from the ontology's own annotations.
kind_rules, mapping_rules, enact_rules = [], [], []
for kind, coll in sorted(onto.subject_objects(I2X.kindForTypeCollection)):
    kind_rules.append(
        f"    sh:rule [ a sh:TripleRule ; sh:order 3 ;\n"
        f"        rdfs:comment {lit('Type collection ' + str(coll).rsplit('/', 1)[-1] + ' ⇒ ' + kind.n3(onto.namespace_manager))}@en ;\n"
        f"        sh:condition [ a sh:NodeShape ; sh:property [ sh:path gs:typeCollection ; sh:hasValue <{coll}> ] ] ;\n"
        f"        sh:subject sh:this ; sh:predicate rdf:type ; sh:object <{kind}> ]")
for pred in ["exactMatch", "closeMatch", "relatedMatch", "broadMatch", "narrowMatch"]:
    mapping_rules.append(
        f"    sh:rule [ a sh:TripleRule ; sh:order 4 ;\n"
        f"        rdfs:comment \"Ratified {pred} proposal ⇒ the mapping triple.\"@en ;\n"
        f"        sh:condition [ a sh:NodeShape ; sh:property [ sh:path i2x:reviewStatus ; sh:hasValue i2x:status-ratified ] ] ,\n"
        f"                     [ a sh:NodeShape ; sh:property [ sh:path i2x:proposedPredicate ; sh:hasValue skos:{pred} ] ] ;\n"
        f"        sh:subject [ sh:path i2x:proposedSubject ] ; sh:predicate skos:{pred} ; sh:object [ sh:path i2x:proposedObject ] ]")
for role, prop in sorted(onto.subject_objects(I2X.asProperty)):
    enact_rules.append(
        f"    sh:rule [ a sh:TripleRule ; sh:order 4 ;\n"
        f"        rdfs:comment {lit('Enactment with role ' + str(role).rsplit('#', 1)[-1] + ', not rejected ⇒ the plain link.')}@en ;\n"
        f"        sh:condition [ a sh:NodeShape ; sh:property [ sh:path i2x:enactmentRole ; sh:hasValue <{role}> ] ] ,\n"
        f"                     [ a sh:NodeShape ; sh:not [ a sh:NodeShape ; sh:property [ sh:path i2x:reviewStatus ; sh:hasValue i2x:status-rejected ] ] ] ;\n"
        f"        sh:subject [ sh:path i2x:enactedConcept ] ; sh:predicate <{prop}> ; sh:object [ sh:path i2x:viaAction ] ]")
# Referent rules: what the ontology's OWL axioms entail for classified data, as TripleRules (one condition shape per
# category; one rule per category and each class it entails, so no rule depends on another rule's output).
ref_rules = [
    "    sh:rule [ a sh:TripleRule ; sh:order 5 ;\n"
    "        rdfs:comment \"Classified by an I2IDL concept that has a referent category ⇒ i2x:Referent.\"@en ;\n"
    "        sh:condition [ a sh:NodeShape ; sh:property [ sh:path i2x:isClassifiedBy ; sh:qualifiedMinCount 1 ;\n"
    "            sh:qualifiedValueShape [ a sh:NodeShape ; sh:property [ sh:path i2x:referentCategory ; sh:minCount 1 ] ] ] ] ;\n"
    "        sh:subject sh:this ; sh:predicate rdf:type ; sh:object i2x:Referent ]"]
ref_conds = []
for _c in LAYER.sem.CATEGORIES:
    _cond = f"i2xr:classified-as-{_c['id']}"
    ref_conds.append(
        f"{_cond} a sh:NodeShape ;\n"
        f"    rdfs:label {lit('Classified by a concept in the category ' + _c['label'])}@en ;\n"
        f"    sh:property [ sh:path i2x:isClassifiedBy ; sh:qualifiedMinCount 1 ;\n"
        f"        sh:qualifiedValueShape [ a sh:NodeShape ; sh:property [ sh:path i2x:referentCategory ; sh:hasValue i2x:category-{_c['id']} ] ] ] .")
    for _k in [_c["id"]] + LAYER.ancestors(_c["id"]):
        ref_rules.append(
            f"    sh:rule [ a sh:TripleRule ; sh:order 5 ; sh:condition {_cond} ;\n"
            f"        rdfs:comment {lit('Category ' + _c['label'] + ' ⇒ i2x:' + LAYER.cat[_k]['cls'] + '.')}@en ;\n"
            f"        sh:subject sh:this ; sh:predicate rdf:type ; sh:object i2x:{LAYER.cat[_k]['cls']} ]")
rules_ttl = render((SRC / "i2idlx-rules.ttl").read_text()
                   .replace("{{REFERENT_RULES}}", " ;\n".join(ref_rules))
                   .replace("{{REFERENT_CONDITIONS}}", "\n".join(ref_conds))
                   .replace("{{KIND_RULES}}", " ;\n".join(kind_rules))
                   .replace("{{MAPPING_RULES}}", " ;\n".join(mapping_rules))
                   .replace("{{ENACTMENT_RULES}}", " ;\n".join(enact_rules)))
rules = Graph().parse(data=rules_ttl, format="turtle")

# Stored queries, reflexive exemplars and specification links → catalog.
sq_blocks = []
stored = {}
for f in sorted((SRC / "queries" / "stored").glob("*.rq")):
    text = f.read_text()
    meta = dict(re.findall(r"^# (\w+): ?(.*)$", text, flags=re.M))
    body = render("\n".join(l for l in text.splitlines() if not l.startswith("# ")).strip() + "\n")
    slug = re.sub(r"^\d+-", "", f.stem)
    stored[slug] = (meta, body)
    params = [p for p in meta.get("params", "").split() if p]
    over = [p for p in meta.get("runsOver", "").split() if p]
    where = (f"    i2x:runsOver " + " , ".join(f"cat:{p}" for p in over) + " ;\n" if over
             else "    i2x:runsAgainst cat:port-sparql-get , cat:port-sparql-post ;\n")
    sq_blocks.append(
        f"cat:q-{slug} a i2x:StoredQuery ;\n"
        f"    rdfs:label {lit(meta['label'])}@en ;\n"
        f"    dct:description {lit(meta['description'])}@en ;\n"
        f"    i2x:queryForm {lit(meta['form'])} ;\n"
        + "".join(f"    i2x:parameter {lit(p)} ;\n" for p in params) + where +
        f"    i2x:sparql {long_lit(body)} .\n")
sq_blocks.append("\n# ── Reflexive exemplars: the glossary's concepts, instantiated by the machinery serving it ──\n")
for cid, target in cw.EXEMPLARS:
    target = target.replace("{CATALOG}", IRI["catalog"]).replace("{ENACT}", IRI["enactments"])
    sq_blocks.append(f"<{concept_iri(cid)}> i2x:exemplifiedBy <{target}> .")
sq_blocks.append("\n# ── Specification documents for standard concepts ──\n")
for cid, target in cw.SPECS:
    sq_blocks.append(f"<{concept_iri(cid)}> i2x:specification <{target}> .")
catalog_ttl = render((SRC / "i2idlx-catalog.ttl").read_text().replace("{{STORED_QUERIES}}", "\n".join(sq_blocks)))
catalog = Graph().parse(data=catalog_ttl, format="turtle")

# ── 4. Crosswalk graphs ──────────────────────────────────────────────────────────
HEADER_PREFIXES = f"""@prefix i2x:   <{NS}> .
@prefix en:    <{IRI['enactments']}#> .
@prefix mp:    <{IRI['mappings']}#> .
@prefix i2idl: <{CONCEPT_BASE}> .
@prefix fxa:   <{ACTION_ROOT}foxxi/> .
@prefix rla:   <{ACTION_ROOT}relay/> .
@prefix iep:   <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix skos:  <http://www.w3.org/2004/02/skos/core#> .
@prefix dct:   <http://purl.org/dc/terms/> .
@prefix prov:  <http://www.w3.org/ns/prov#> .
@prefix owl:   <http://www.w3.org/2002/07/owl#> .
@prefix rdfs:  <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd:   <http://www.w3.org/2001/XMLSchema#> .
"""
DRAFTER = '"Claude (Anthropic), drafting for Mark Spivey / Foxxi Mediums Inc."'
NOW = os.environ.get("I2IDLX_NOW") or dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()


def now_for(key: str) -> str:
    return os.environ.get(f"I2IDLX_NOW_{key.upper()}") or NOW


def qn(iri: str) -> str:
    """Compact well-known IRIs for readability; fall back to <...>."""
    for pfx, base in (("i2idl:", CONCEPT_BASE), ("fxa:", ACTION_ROOT + "foxxi/"), ("rla:", ACTION_ROOT + "relay/")):
        if iri.startswith(base) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]*", iri[len(base):]):
            return pfx + iri[len(base):]
    return f"<{iri}>"


def local(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9-]+", "-", s)


role_prop = {str(r).rsplit("role-", 1)[-1]: str(p) for r, p in onto.subject_objects(I2X.asProperty)}
role_alias = {"operationalizes": "operationalizes", "realizes": "realizes", "implements": "implements",
              "measures": "measures", "records": "records", "credentials": "credentials",
              "enforces": "enforces", "explains": "explains"}

en_lines = [HEADER_PREFIXES, f"""
# ══════════════════════════════════════════════════════════════════════════════
#  I2IDL-X enactments — I2IDL concepts → the Foxxi / Interego affordances that
#  enact them (pragmatic interpretants), plus role capabilities.
#  AI-DRAFTED. Publish with modal status Hypothetical. Each record carries its
#  rationale and confidence; the plain i2x:*By triple is materialized beside it.
#  Action IRIs dereference (302) to the manifest that defines target, method
#  and input shape — this graph links capabilities, it never redefines them.
# ══════════════════════════════════════════════════════════════════════════════

<{IRI['enactments']}> a owl:Ontology ;
    dct:title "I2IDL-X enactments"@en ;
    dct:description "Concept-to-capability links from the I2IDL glossary ({release}) to live Foxxi bridge and Interego relay affordances."@en ;
    dct:conformsTo <{IRI['shapes']}> ;
    owl:imports <{IRI['ontology']}> ;
    prov:wasAttributedTo {DRAFTER} ;
    prov:generatedAtTime "{now_for('enactments')}"^^xsd:dateTime ;
    prov:wasDerivedFrom <https://github.com/blakeplock/i2idl-linked-data/blob/{commit}/public/glossary.jsonld> , <{cfg['foxxiManifest']}> , <https://relay.interego.xwisee.com/.well-known/operations> ;
    rdfs:comment "Modal status Hypothetical until ratified by i2x:RatificationVote. Role capabilities tagged [learning-engineer] are derived from the Foxxi manifest's own role tags."@en .
"""]
seen_en = set()
for cid, role, akey, conf, why in cw.ENACTMENTS:
    c, a = concept_iri(cid), action_iri(akey)
    assert role in role_alias, role
    node = f"en:e-{local(cid)}--{local(akey)}"
    assert node not in seen_en, f"duplicate enactment {node}"
    seen_en.add(node)
    prop = role_prop[role_alias[role]].rsplit("#", 1)[-1]
    en_lines.append(
        f"{node} a i2x:Enactment ;\n"
        f"    i2x:enactedConcept {qn(c)} ; i2x:viaAction {qn(a)} ; i2x:enactmentRole i2x:role-{role} ;\n"
        f"    i2x:rationale {lit(why)}@en ;\n"
        f"    i2x:confidence \"{conf:.2f}\"^^xsd:decimal ; i2x:reviewStatus i2x:status-proposed ; i2x:mappingMethod i2x:method-ai-drafted .\n"
        f"{qn(c)} i2x:{prop} {qn(a)} .\n")
n_role = 0
en_lines.append("\n# ── Role capabilities (role-bearing concept → action an agent in that role wields) ──\n")
for cid, akey, conf, why in cw.ROLE_CAPABILITIES:
    en_lines.append(f"{qn(concept_iri(cid))} i2x:roleCapability {qn(action_iri(akey))} .  # {conf:.2f} — {why}")
    n_role += 1
for tag, (cid, conf, why) in cw.ROLE_TAGS.items():
    tagged = sorted(k for k, r in foxxi_by_key.items() if r["title"].startswith(tag))
    for k in tagged:
        en_lines.append(f"{qn(concept_iri(cid))} i2x:roleCapability {qn(action_iri(k))} .  # derived: {tag} in manifest title")
        n_role += 1
enact_ttl = "\n".join(en_lines) + "\n"
enact = Graph().parse(data=enact_ttl, format="turtle")

mp_lines = [HEADER_PREFIXES, f"""
# ══════════════════════════════════════════════════════════════════════════════
#  I2IDL-X mapping proposals — I2IDL concepts → external vocabularies (UNESCO
#  Thesaurus, xAPI ontology, xAPI Profiles ontology, Foxxi-served IEEE LER and
#  ADL TLA layers, schema.org, W3C VC, Interego). PROPOSALS, not assertions: no skos:*Match
#  triple appears here. A mapping triple exists only after ratification
#  (rules in i2idlx-rules). Every object IRI was checked to exist in its
#  vocabulary at build time.
# ══════════════════════════════════════════════════════════════════════════════

<{IRI['mappings']}> a owl:Ontology ;
    dct:title "I2IDL-X mapping proposals"@en ;
    dct:description "SKOS crosswalk proposals from the I2IDL glossary ({release}) to external vocabularies, held for editorial review."@en ;
    dct:conformsTo <{IRI['shapes']}> ;
    owl:imports <{IRI['ontology']}> ;
    prov:wasAttributedTo {DRAFTER} ;
    prov:generatedAtTime "{now_for('mappings')}"^^xsd:dateTime ;
    dct:references <{unesco['scheme']['iri']}> ;
    rdfs:comment "Uses SKOS mapping predicates with the meanings in I2IDL's SEMANTIC-RELATIONSHIPS.md. standards-text proposals rest on the same normative text; evidence-cited proposals turn a citation I2IDL already makes (i2x:citedIn names the definition) into a mapping, with the predicate read from both texts; ai-drafted proposals need editorial review before ratification. UNESCO Thesaurus terms are © UNESCO, CC BY-SA 3.0 IGO."@en .
"""]
counter: dict[str, int] = {}
for cid, pred, target, conf, method, why in cw.MAPPINGS:
    assert target in external_terms, f"external target does not resolve in its vocabulary: {target}"
    assert pred in {"exactMatch", "closeMatch", "relatedMatch", "broadMatch", "narrowMatch"}
    assert method in {cw.ST, cw.AI, cw.EC}, method
    counter[cid] = counter.get(cid, 0) + 1
    node = f"mp:m-{local(cid)}-{counter[cid]}"
    cited = ""
    if method == cw.EC:  # the citation must be I2IDL's own: the target's snapshot lists this concept's definition
        cites = [c for c in unesco["terms"].get(target, {}).get("citedBy", []) if c["concept"] == cid]
        assert cites, f"{cid} → {target}: I2IDL's evidence does not cite this target"
        cited = f"    i2x:citedIn <{cites[0]['definition']}> ; rdfs:seeAlso <{unesco['terms'][target]['page']}> ;\n"
    mp_lines.append(
        f"{node} a i2x:MappingProposal ;\n"
        f"    i2x:proposedSubject {qn(concept_iri(cid))} ; i2x:proposedPredicate skos:{pred} ; i2x:proposedObject <{target}> ;\n"
        f"    i2x:rationale {lit(why)}@en ;\n" + cited +
        f"    i2x:confidence \"{conf:.2f}\"^^xsd:decimal ; i2x:reviewStatus i2x:status-proposed ;\n"
        f"    i2x:mappingMethod i2x:method-{method} .\n")
mappings_ttl = "\n".join(mp_lines) + "\n"
mappings = Graph().parse(data=mappings_ttl, format="turtle")

# ── 4b. Release feed derived from the upstream git history ──────────────────────
def snapshot(rev: str) -> dict:
    d = json.loads(sh(["git", "show", f"{rev}:{gpath}"], cwd=clone))
    snap = {"defs": {}, "related": 0, "broader": 0, "fieldMembers": 0, "version": "?"}
    for n in d.get("@graph", []):
        ts = n.get("@type")
        ts = ts if isinstance(ts, list) else [ts]
        if "skos:ConceptScheme" in ts:
            snap["version"] = n.get("gs:publicationVersion", "?")
        if "skos:Concept" in ts:
            snap["defs"][n["@id"]] = n.get("skos:definition", "")
            for key, name in (("skos:related", "related"), ("skos:broader", "broader")):
                v = n.get(key)
                snap[name] += len(v) if isinstance(v, list) else (1 if v else 0)
        if "skos:Collection" in ts and n.get("gs:facet") == "field":
            m = n.get("skos:member")
            snap["fieldMembers"] += len(m) if isinstance(m, list) else (1 if m else 0)
    snap["related"] //= 2
    return snap


history = sh(["git", "log", "--reverse", "--format=%H %cI", "--", gpath], cwd=clone).split("\n")
by_version: dict[str, dict] = {}
for line in filter(None, history):
    h, when = line.split(" ", 1)
    s = snapshot(h)
    entry = by_version.setdefault(s["version"], {"commits": 0})
    entry.update({"commit": h, "date": when, "snap": s})
    entry["commits"] += 1
REL = IRI["releases"] + "#"
rel_lines = [HEADER_PREFIXES, f"""
# ══════════════════════════════════════════════════════════════════════════════
#  I2IDL release feed — derived from the public git history of
#  blakeplock/i2idl-linked-data (last commit per gs:publicationVersion).
#  Lets an agent answer "what changed since the release my decorations were
#  built against?" before trusting them. Facts about upstream; not editorial.
# ══════════════════════════════════════════════════════════════════════════════

<{IRI['releases']}> a owl:Ontology ;
    dct:title "I2IDL release feed (derived)"@en ;
    dct:description "One i2x:GlossaryRelease per published I2IDL version, chained by prov:wasRevisionOf, with concept additions, removals, definition revisions and relationship counts."@en ;
    dct:conformsTo <{IRI['shapes']}> ;
    prov:wasDerivedFrom <https://github.com/blakeplock/i2idl-linked-data> ;
    prov:generatedAtTime "{now_for('releases')}"^^xsd:dateTime .
"""]
prev = None
for version, e in by_version.items():
    s = e["snap"]
    node = f"<{REL}{version}>"
    parts = [f"{node} a i2x:GlossaryRelease ;",
             f"    i2x:releaseVersion {lit(version)} ; i2x:releaseCommit {lit(e['commit'])} ;",
             f"    prov:generatedAtTime \"{e['date']}\"^^xsd:dateTime ;",
             f"    i2x:conceptCount {len(s['defs'])} ; i2x:relatedPairCount {s['related']} ; i2x:broaderPairCount {s['broader']} ;",
             f"    rdfs:comment {lit(str(e['commits']) + ' upstream commit(s) carried this version label; ' + str(s['fieldMembers']) + ' field memberships.')}@en"]
    if prev:
        pv, ps = prev
        added = sorted(set(s["defs"]) - set(ps["defs"]))
        removed = sorted(set(ps["defs"]) - set(s["defs"]))
        revised = sorted(c for c in set(s["defs"]) & set(ps["defs"]) if s["defs"][c] != ps["defs"][c])
        parts[-1] += " ;"
        parts.append(f"    prov:wasRevisionOf <{REL}{pv}> ;")
        parts.append(f"    rdfs:seeAlso <https://github.com/blakeplock/i2idl-linked-data/compare/{by_version[pv]['commit'][:12]}...{e['commit'][:12]}>")
        for pred, items in (("addedConcept", added), ("removedConcept", removed), ("revisedDefinitionOf", revised)):
            if items:
                parts[-1] += " ;"
                parts.append(f"    i2x:{pred} " + " , ".join(qn(c) for c in items))
    rel_lines.append("\n".join(parts) + " .\n")
    prev = (version, s)
releases_ttl = "\n".join(rel_lines)
releases = Graph().parse(data=releases_ttl, format="turtle")

# ── 4c. Change history (I2IDL README "Next development priorities" 4) ───────────
# Same git history, finer grain: src/history.py turns every fact that differs between
# successive releases into one event; here they are grouped per release and kind.
hrels = hist.releases(clone, gpath)
assert [r["version"] for r in hrels] == list(by_version), "history and release feed disagree on the release list"
CH = IRI["changes"] + "#"


def vslug(v: str) -> str:
    return local(v.replace(".", "-"))


def tail(iri: str) -> str:
    return iri.rsplit("/collections/", 1)[-1].replace("/", "-") if "/collections/" in iri else iri.rsplit("/", 1)[-1]


SCALAR = {"label-changed", "definition-revised", "explanation-revised", "type-changed", "field-changed", "status-changed"}
groups: dict[tuple, dict] = {}
for r in hrels[1:]:
    for e in r["events"]:
        k = e["kind"]
        if k in SCALAR or k.startswith("alt-label"):
            key = (k, e["concept"])
        elif k.startswith("relationship-"):
            key = (k, e["property"])
        elif k.startswith("membership-") or k.startswith("collection-"):
            key = (k, e["collection"])
        elif k.startswith("source-") or k in ("evidence-added", "evidence-removed"):
            key = (k, e["source"])
        elif k in ("evidence-classified", "evidence-reclassified"):
            key = (k, e["source"], e.get("prior") or "", e["new"])
        else:
            key = (k,)
        g = groups.setdefault((r["version"],) + key, {"release": r["version"], "kind": k, "events": []})
        g["events"].append(e)
ch_lines = [HEADER_PREFIXES + f"@prefix ch:    <{CH}> .\n", f"""
# ══════════════════════════════════════════════════════════════════════════════
#  I2IDL change history — derived from the public git history of
#  blakeplock/i2idl-linked-data, one PROV activity per release and one event
#  per kind of change, naming what each touched. It reconciles exactly: the
#  baseline release plus every addition minus every removal equals {release}
#  for concepts, relationship pairs, memberships, evidence, sources and
#  collections. Facts about upstream; not editorial judgement.
# ══════════════════════════════════════════════════════════════════════════════

<{IRI['changes']}> a owl:Ontology ;
    dct:title "I2IDL change history (derived)"@en ;
    dct:description "Machine-readable change history for the I2IDL Digital Learning Glossary: every release change since {hrels[0]['version']} as a prov:Activity that used the previous release and generated the next, with typed change events (concept added, relationship added, membership added, evidence classified or reclassified, source revised, ...)."@en ;
    dct:conformsTo <{IRI['shapes']}> ;
    owl:imports <{IRI['ontology']}> ;
    i2x:baselineRelease <{REL}{hrels[0]['version']}> ;
    prov:wasDerivedFrom <https://github.com/blakeplock/i2idl-linked-data> , <{IRI['releases']}> ;
    prov:generatedAtTime "{now_for('changes')}"^^xsd:dateTime ;
    rdfs:seeAlso <https://github.com/blakeplock/i2idl-linked-data/blob/{commit}/README.md#4-add-machine-readable-change-history> ;
    rdfs:comment {lit("Implements, as a derived projection, the change dataset I2IDL's README proposes (priority 4). Change kinds are i2x:ChangeKinds. Set-valued changes name the concepts, collection or source they touched; the exact before and after values live in the two release snapshots (each release records its commit). The baseline " + hrels[0]['version'] + " is the first commit of " + gpath + "; earlier states are not in the public record.")}@en .
"""]
for r in hrels[1:]:
    mine = [g for (v, *_), g in groups.items() if v == r["version"]]
    n = len(r["events"])
    note = "" if n else (" ;\n    rdfs:comment " + lit("No change to the published graph; the version label moved with other repository changes.") + "@en")
    ch_lines.append(
        f"ch:{vslug(r['version'])} a i2x:ReleaseChange ;\n"
        f"    rdfs:label {lit(r['previous'] + ' → ' + r['version'])}@en ;\n"
        f"    prov:used <{REL}{r['previous']}> ; prov:generated <{REL}{r['version']}> ;\n"
        f"    prov:endedAtTime \"{r['date']}\"^^xsd:dateTime ;\n"
        f"    i2x:changeCount {n}{note} .\n")
    for g in sorted(mine, key=lambda g: (hist.KIND_CODES.index(g["kind"]), str(g["events"][0]))):
        e0, k = g["events"][0], g["kind"]
        parts = [k]
        lines = [f"    i2x:partOfChange ch:{vslug(r['version'])} ; i2x:changeKind i2x:change-{k}",
                 f"    i2x:changeCount {len(g['events'])}"]
        touched = sorted({c for e in g["events"] for c in hist.touched(e)})
        if "property" in e0:
            parts.append(e0["property"].split(":")[1])
            lines.append(f"    i2x:viaProperty {e0['property']}")
        if "collection" in e0:
            parts.append(tail(e0["collection"]))
            lines.append(f"    i2x:changedCollection <{e0['collection']}>")
        if "source" in e0 and e0["source"]:
            parts.append(tail(e0["source"]))
            lines.append(f"    i2x:changedSource <{e0['source']}>")
        if k in ("evidence-classified", "evidence-reclassified"):
            parts += [e0.get("prior") or "", e0["new"]]
            if e0.get("prior"):
                lines.append(f"    i2x:priorValue {lit(e0['prior'])}")
            lines.append(f"    i2x:newValue {lit(e0['new'])}")
        elif k in SCALAR:
            parts.append(tail(e0["concept"]))
            for which in ("prior", "new"):
                v = e0.get(which)
                if v is not None:
                    pred = "i2x:priorValue" if which == "prior" else "i2x:newValue"
                    lines.append(f"    {pred} " + (f"<{v}>" if str(v).startswith("https://") else lit(str(v))))
        elif k.startswith("alt-label"):
            parts.append(tail(e0["concept"]))
            pred = "i2x:newValue" if k.endswith("added") else "i2x:priorValue"
            lines.append(f"    {pred} " + " , ".join(lit(e.get("new") or e.get("prior")) for e in g["events"]))
        elif "fields" in e0:  # a revised source or collection record: name the properties, carry short values
            f = e0["fields"]
            lines.append(f"    rdfs:comment {lit('Changed ' + ', '.join(f) + '.')}@en")
            if len(f) == 1:
                before, after = next(iter(f.values()))
                if isinstance(before, str) and isinstance(after, str) and len(before) + len(after) < 400:
                    lines += [f"    i2x:priorValue {lit(before)}", f"    i2x:newValue {lit(after)}"]
        if touched:
            lines.append("    i2x:changedConcept " + " ,\n        ".join(qn(c) for c in touched))
        node = f"ch:{vslug(r['version'])}--" + "--".join(local(x) for x in parts if x)
        ch_lines.append(f"{node} a i2x:ChangeEvent ;\n" + " ;\n".join(lines) + " .\n")
changes_ttl = "\n".join(ch_lines)
changes = Graph().parse(data=changes_ttl, format="turtle")

# ── 4d. Semantic layer: alignments to upper ontologies and peers, and what each concept classifies ──
UPPER_TBOX = layer_mod.tbox(ROOT)
upper_classes = ({str(s) for s in UPPER_TBOX.subjects(RDF.type, OWL.Class)}
                 | {str(s) for s in UPPER_TBOX.subjects(RDF.type, RDFS.Class)})
mapping_class_targets = {row[2] for row in cw.MAPPINGS if row[2] in upper_classes}
alignments_ttl = LAYER.alignments_ttl(now_for("alignments"), mapping_class_targets, IRI["mappings"])
referents_ttl = LAYER.referents_ttl(now_for("referents"))
alignments = Graph().parse(data=alignments_ttl, format="turtle")
referents = Graph().parse(data=referents_ttl, format="turtle")

# ── 5. Write the publishable graphs ──────────────────────────────────────────────
outputs = {
    "ontology": onto_ttl, "shapes": shapes_ttl, "rules": rules_ttl, "catalog": catalog_ttl,
    "enactments": enact_ttl, "mappings": mappings_ttl, "releases": releases_ttl, "changes": changes_ttl,
    "alignments": alignments_ttl, "referents": referents_ttl,
}
for key, text in outputs.items():
    (DIST / f"{cfg['slugs'][key]}.ttl").write_text(text)

# ── 6. Verification ──────────────────────────────────────────────────────────────
log("## Parsing and size")
for key, text in outputs.items():
    g = Graph().parse(data=text, format="turtle")
    check(len(g) > 0, f"`{cfg['slugs'][key]}.ttl` parses: {len(g):,} triples, {len(text.encode()):,} bytes")
log()

log("## What's whose (origin labels)")
ORIGIN_SCHEME = I2X["Origins"]
origin_nodes = sorted(onto.subjects(SKOS.inScheme, ORIGIN_SCHEME))
notations = {str(onto.value(n, SKOS.notation)): n for n in origin_nodes}
want = [o["id"] for o in ORIGINS["origins"]]
check(set(notations) == set(want) | set(origin_groups),
      f"the ontology's What's whose scheme has the {len(want)} origin labels the workbench uses "
      f"({', '.join(str(onto.value(notations[w], SKOS.prefLabel)) for w in want)}) and {len(origin_groups)} group")
check(all(onto.value(notations[w], SKOS.definition) and onto.value(notations[w], SKOS.scopeNote) for w in want),
      "every origin says what it covers and how far to trust it (skos:definition, skos:scopeNote)")
held_graphs = {str(o) for o in onto.objects(None, I2X.heldIn)}
unheld = sorted(k for k in outputs if IRI[k] not in held_graphs)
check(not unheld, "every published I2IDL-X graph is held by an origin" + (f" (not: {', '.join(unheld)})" if unheld else ""))
check(str(onto.value(notations["i2idl"], SKOS.prefLabel)) == "I2IDL"
      and all(str(h).startswith("https://id.i2idl.org/") for h in onto.objects(notations["i2idl"], I2X.heldIn)),
      "only I2IDL's own services are held by the I2IDL origin")
log()

log("## Upstream contract (I2IDL release satisfies what I2IDL-X assumes)")
up_shapes = Graph()
for t in shapes.triples((None, None, None)):
    up_shapes.add(t)
conforms, _, text = shacl_validate(gl, shacl_graph=up_shapes, inference="none", advanced=True)
viol = text.count("Constraint Violation")
check(conforms, f"I2IDL {release} conforms to the upstream contract shapes ({viol} violations)")
if not conforms:
    (DIST / "upstream-violations.txt").write_text(text)
log()

log("## SHACL-AF rules (TripleRule only) over the glossary")
from pyshacl import shacl_rules
expanded_raw = shacl_rules(gl + enact + mappings, shacl_graph=rules, advanced=True, iterate_rules=True)
expanded = Graph()
for row in expanded_raw:
    expanded.add(tuple(row[:3]))
base_union = gl + enact + mappings
inferred = Graph()
for t in expanded:
    if t not in base_union:
        inferred.add(t)
log(f"- INFO — rules inferred {len(inferred):,} new triples")
kinds = {}
for k in ["NotionConcept", "EnactableConcept", "SystemConcept", "StandardConcept", "FrameworkConcept",
          "ActorConcept", "NormativeConcept", "DomainConcept"]:
    kinds[k] = sum(1 for _ in inferred.subjects(RDF.type, I2X[k]))
n_glossary = sum(1 for _ in inferred.subjects(RDF.type, I2X.GlossaryConcept))
check(n_glossary == len(concepts), f"every concept classified i2x:GlossaryConcept ({n_glossary}/{len(concepts)})")
check(sum(kinds.values()) == len(concepts), "every concept gets exactly one agentic kind: " + ", ".join(f"{k} {v}" for k, v in kinds.items()))
n_grounded = sum(1 for _ in inferred.subjects(RDF.type, I2X.SourceGroundedDefinition))
n_synth = sum(1 for _ in inferred.subjects(RDF.type, I2X.SynthesizedDefinition))
n_defs = sum(1 for _ in gl.subjects(RDF.type, GS.Definition))
check(n_grounded + n_synth == n_defs, f"definition provenance: {n_grounded} source-grounded + {n_synth} synthesized = {n_defs}")
n_asserted = sum(1 for _ in inferred.subject_objects(I2X.editorialModality))
check(n_asserted == len(concepts), f"editorial modality derived for {n_asserted} concepts")
n_plain = sum(1 for p in role_prop.values() for _ in inferred.triples((None, URIRef(p), None)))
check(n_plain == 0, "enactment rules add nothing the enactments graph does not already state (plain links already materialized)")
n_map_triples = sum(1 for p in ["exactMatch", "closeMatch", "relatedMatch", "broadMatch", "narrowMatch"]
                    for _ in inferred.triples((None, SKOS[p], None)))
check(n_map_triples == 0, "no mapping triple is materialized while every proposal is unratified")
log()

log("## Superset shapes over the published graphs")
for key, g in [("catalog", catalog), ("enactments", enact), ("mappings", mappings), ("releases", releases), ("changes", changes),
               ("alignments", alignments), ("referents", referents)]:
    ok, _, text = shacl_validate(g, shacl_graph=shapes, ont_graph=onto, inference="rdfs", advanced=True)
    check(ok, f"`{cfg['slugs'][key]}` conforms to I2IDL-X shapes")
    if not ok:
        (DIST / f"{key}-violations.txt").write_text(text)
log()

# Negative tests: the shapes must REJECT what they claim to reject.
log("## Negative tests (shapes must reject)")
bad = Graph().parse(data=f"""@prefix i2x: <{NS}> . @prefix skos: <http://www.w3.org/2004/02/skos/core#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<urn:x:internal> a i2x:MappingProposal ; i2x:proposedSubject <https://id.i2idl.org/concepts/verb> ; i2x:proposedPredicate skos:exactMatch ;
  i2x:proposedObject <https://id.i2idl.org/concepts/activity> ; i2x:rationale "an internal relation smuggled in as a crosswalk" ;
  i2x:confidence "0.9"^^xsd:decimal ; i2x:reviewStatus i2x:status-proposed ; i2x:mappingMethod i2x:method-ai-drafted .
<urn:x:lexical> a i2x:MappingProposal ; i2x:proposedSubject <https://id.i2idl.org/concepts/verb> ; i2x:proposedPredicate skos:exactMatch ;
  i2x:proposedObject <https://w3id.org/xapi/ontology#Verb> ; i2x:rationale "label similarity only, then ratified" ;
  i2x:confidence "0.9"^^xsd:decimal ; i2x:reviewStatus i2x:status-ratified ; i2x:mappingMethod i2x:method-lexical .
<urn:x:pred> a i2x:MappingProposal ; i2x:proposedSubject <https://id.i2idl.org/concepts/verb> ; i2x:proposedPredicate skos:related ;
  i2x:proposedObject <https://w3id.org/xapi/ontology#Verb> ; i2x:rationale "uses an internal SKOS relation" ;
  i2x:confidence "1.5"^^xsd:decimal ; i2x:reviewStatus i2x:status-proposed ; i2x:mappingMethod i2x:method-ai-drafted .
<urn:x:uncited> a i2x:MappingProposal ; i2x:proposedSubject <https://id.i2idl.org/concepts/unesco-curriculum> ; i2x:proposedPredicate skos:exactMatch ;
  i2x:proposedObject <http://vocabularies.unesco.org/thesaurus/concept49> ; i2x:rationale "claims a citation but names no definition" ;
  i2x:confidence "0.9"^^xsd:decimal ; i2x:reviewStatus i2x:status-proposed ; i2x:mappingMethod i2x:method-evidence-cited .
""", format="turtle")
ok, rg, _ = shacl_validate(bad, shacl_graph=shapes, ont_graph=onto, inference="rdfs", advanced=True)
focus = {str(o) for o in rg.objects(None, SH.focusNode)}
check(not ok and {"urn:x:internal", "urn:x:lexical", "urn:x:pred", "urn:x:uncited"} <= focus,
      "rejects internal-target mappings, ratified lexical candidates, non-mapping predicates, out-of-range confidence and evidence-cited proposals without the citing definition")
bad = Graph().parse(data=f"""@prefix i2x: <{NS}> . @prefix prov: <http://www.w3.org/ns/prov#> . @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
<urn:x:rc> a i2x:ReleaseChange ; prov:used <urn:x:r1> ; prov:generated <urn:x:r2> ; prov:endedAtTime "2026-10-08T00:00:00Z"^^xsd:dateTime ; i2x:changeCount 3 .
<urn:x:nothing> a i2x:ChangeEvent ; i2x:partOfChange <urn:x:rc> ; i2x:changeKind i2x:change-concept-added ; i2x:changeCount 1 .
<urn:x:zero> a i2x:ChangeEvent ; i2x:partOfChange <urn:x:rc> ; i2x:changeKind i2x:change-concept-added ; i2x:changeCount 0 ;
  i2x:changedConcept <https://id.i2idl.org/concepts/verb> .
<urn:x:kind> a i2x:ChangeEvent ; i2x:partOfChange <urn:x:rc> ; i2x:changeKind i2x:change-something-else ; i2x:changeCount 1 ;
  i2x:changedConcept <https://example.org/not-i2idl> .
""", format="turtle")
ok, rg, _ = shacl_validate(bad, shacl_graph=shapes, ont_graph=onto, inference="rdfs", advanced=True)
focus = {str(o) for o in rg.objects(None, SH.focusNode)}
check(not ok and {"urn:x:nothing", "urn:x:zero", "urn:x:kind"} <= focus,
      "rejects change events that touch nothing, count nothing, use an unknown kind or name a non-I2IDL concept")
bad = Graph().parse(data=f"""@prefix i2x: <{NS}> . @prefix i2idl: <{CONCEPT_BASE}> . @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<urn:x:thing-iri> i2x:isClassifiedBy <https://example.org/not-a-concept> .
<urn:x:thing-literal> i2x:isClassifiedBy "learning record store" .
i2idl:verb i2x:referentCategory i2x:category-process , i2x:category-information ; i2x:assignmentBasis "type" ;
    i2x:categoryRationale "two categories for one concept leave its referents ambiguous"@en .
i2idl:activity i2x:referentCategory i2x:category-vibes ; i2x:assignmentBasis "type" ;
    i2x:categoryRationale "a category outside the referent categories"@en .
i2idl:actor i2x:referentCategory i2x:category-person ; i2x:assignmentBasis "gut feeling" ;
    i2x:categoryRationale "a basis other than I2IDL's type or the definition"@en .
<https://example.org/my-term> i2x:referentCategory i2x:category-person ; i2x:assignmentBasis "type" ;
    i2x:categoryRationale "a category for a term I2IDL does not publish"@en .
<urn:x:q-both> a i2x:StoredQuery ; rdfs:label "both" ; i2x:sparql "ASK {{}}" ; i2x:queryForm "ASK" ;
    i2x:runsAgainst <urn:x:port-a> ; i2x:runsOver <urn:x:port-b> .
<urn:x:q-neither> a i2x:StoredQuery ; rdfs:label "neither" ; i2x:sparql "ASK {{}}" ; i2x:queryForm "ASK" .
""", format="turtle")
ok, rg, _ = shacl_validate(bad, shacl_graph=shapes, ont_graph=onto, inference="rdfs", advanced=True)
focus = {str(o) for o in rg.objects(None, SH.focusNode)}
want_rejected = {"urn:x:thing-iri", "urn:x:thing-literal", CONCEPT_BASE + "verb", CONCEPT_BASE + "activity", CONCEPT_BASE + "actor",
                 "https://example.org/my-term", "urn:x:q-both", "urn:x:q-neither"}
check(not ok and want_rejected <= focus,
      "rejects classification by anything but an I2IDL concept IRI, two categories for one concept, an unknown category, "
      "a basis other than type or definition, a category for a term I2IDL does not publish, and stored queries that "
      "both run against a port and run client-side, or neither" + (f" (not rejected: {sorted(want_rejected - focus)})" if not want_rejected <= focus else ""))
log()

log("## Change history reconciles with the release")
for name, (replayed, actual) in hist.reconcile(hrels).items():
    check(replayed == actual, f"{name}: baseline {hrels[0]['version']} + additions − removals = {replayed} (release has {actual})")
n_events = sum(len(r["events"]) for r in hrels)
n_ch = sum(1 for _ in changes.subjects(RDF.type, I2X.ChangeEvent))
check(sum(int(o) for s in changes.subjects(RDF.type, I2X.ChangeEvent) for o in changes.objects(s, I2X.changeCount)) == n_events,
      f"{n_events:,} fact-level changes across {len(hrels) - 1} release changes, grouped into {n_ch} events with no fact lost")
seen_up = {k for k in ("concept-added", "definition-revised", "source-revised", "relationship-added", "membership-added",
                       "evidence-reclassified", "external-mapping-added") if k in hist.KIND_CODES}
check(len(seen_up) == 7, "every event type the I2IDL README lists has a change kind (source changed → source-revised, membership changed → membership-added/removed)")
log()

log("## Semantic layer: upper ontologies, peer vocabularies, inference")
SEM = LAYER.sem
known_terms = layer_mod.snapshot_terms(ROOT)
used_terms: set[str] = set()
for c in SEM.CATEGORIES:
    used_terms |= set(c.get("referent", [])) | set(c.get("concept", [])) | set(c.get("expressible", []))
for subj, targets, _ in SEM.RECORDS + SEM.INTEREGO:
    used_terms |= {subj, *targets}
for subj, targets, _, peers in SEM.FOXXI:
    used_terms |= {subj, *targets, *peers}
for subj, _, obj, _ in SEM.PROPERTIES:
    used_terms |= {subj, obj}
for _, types, _, _ in SEM.INDIVIDUALS:
    used_terms |= set(types)
own_terms = {str(s) for s in onto.subjects() if isinstance(s, URIRef)}
unknown_terms = sorted(t for t in used_terms
                       if LAYER.expand(t) not in known_terms and LAYER.expand(t) not in own_terms
                       and not t.startswith("gs:"))
by_vocab: dict[str, int] = {}
for t in used_terms:
    by_vocab[t.split(":")[0]] = by_vocab.get(t.split(":")[0], 0) + 1
check(not unknown_terms, f"all {len(used_terms)} aligned terms exist in pinned snapshots of their vocabularies"
      + (f" — unknown: {unknown_terms[:8]}" if unknown_terms else ""))
upper_manifest = json.loads((EVID / "upper" / "manifest.json").read_text())
log("- INFO — terms per vocabulary: " + ", ".join(f"{k} {v}" for k, v in sorted(by_vocab.items(), key=lambda kv: -kv[1])))
check(all(not src.get("missing") for src in upper_manifest["sources"]),
      f"{len(upper_manifest['sources'])} snapshots pinned with SHA-256 ({', '.join(s['key'] for s in upper_manifest['sources'] if 'version' in s)})")
assign = LAYER.assignments()
check(set(assign) == set(layer_concepts) and all(cat in LAYER.cat for cat, _, _ in assign.values()),
      f"every one of the {len(assign)} concepts has exactly one referent category")
n_by_cat: dict[str, int] = {}
for cat, _, basis in assign.values():
    n_by_cat[cat] = n_by_cat.get(cat, 0) + 1
n_def = sum(1 for _, _, b in assign.values() if b == "definition")
log(f"- INFO — {len(assign) - n_def} categories follow I2IDL's own type; {n_def} are decided by the definition, each with its reason")
log("- INFO — categories: " + ", ".join(f"{LAYER.cat[k]['label']} {v}" for k, v in sorted(n_by_cat.items(), key=lambda kv: -kv[1])))
stale = sorted(k for k in SEM.CONCEPT_CATEGORY if k not in layer_concepts)
check(not stale, "every per-concept category names a concept in the release" + (f" (not: {stale})" if stale else ""))
cols = {"bfo": ("obo:",), "cco": ("cco:",), "gist": ("gist:",), "dul": ("dul:",), "gufo": ("gufo:",), "prov": ("prov:",),
        "schema": ("schema:", "org:", "dct:")}
gaps = []
for c in SEM.CATEGORIES:
    if c.get("mode", "classify") != "classify":
        continue
    have = LAYER.referent_classes(c["id"])
    n = sum(1 for col, pfx in cols.items() if any(t.startswith(pfx) for t in have))
    if n < 2:
        gaps.append(c["id"])
check(not gaps, f"every classifying category is aligned in at least two upper ontologies ({sum(1 for c in SEM.CATEGORIES if c.get('mode', 'classify') == 'classify')} categories)")
n_bridge = sum(1 for _ in LAYER.class_bridges(mapping_class_targets))
log(f"- INFO — {n_bridge} crosswalk proposals made executable as OWL bridges (exactMatch ≡, broadMatch ⊒, narrowMatch ⊑); "
    f"{sum(1 for r in cw.MAPPINGS if r[2] in mapping_class_targets) - n_bridge} close/related matches stay SKOS")

# OWL 2 RL closure over everything: upper TBoxes, I2IDL-X, I2IDL's release, I2IDL-X's records and the sample.
sample = Graph().parse(EX / "industry-context.ttl", format="turtle")
clash = Graph().parse(EX / "industry-context-clash.ttl", format="turtle")
reason_in = Graph()
for part in (UPPER_TBOX, onto, alignments, referents, gl, enact, mappings, releases, changes, sample):
    for t in part:
        reason_in.add(t)
import time as _time
_t0 = _time.time()
closed, rl_errors = layer_mod.closure(reason_in)
rl_secs = _time.time() - _t0
check(not rl_errors, f"OWL 2 RL closure over {len(reason_in):,} triples is consistent ({len(closed):,} after inference, {rl_secs:.0f} s)"
      + (f": {rl_errors[:3]}" if rl_errors else ""))
SHORT = {v: k for k, v in LAYER.prefixes.items()}


def short(iri: str) -> str:
    for ns, pfx in sorted(SHORT.items(), key=lambda kv: -len(kv[0])):
        if iri.startswith(ns):
            return f"{pfx}:{iri[len(ns):]}"
    return iri


def types_of(node) -> set[str]:
    return {short(str(o)) for o in closed.objects(node, RDF.type) if isinstance(o, URIRef)}


GLOSS_SCHEME = URIRef("https://id.i2idl.org/scheme")
record_checks = [
    ("concepts", list(concepts), ["obo:IAO_0000030", "cco:ont00000958", "gist:KnowledgeConcept", "dul:Concept", "obo:BFO_0000031"]),
    ("definitions", list(gl.subjects(RDF.type, GS.Definition)), ["obo:IAO_0000300", "gist:Text", "dul:InformationObject"]),
    ("evidence records", list(gl.subjects(RDF.type, GS.Evidence)), ["obo:IAO_0000030", "gist:Content", "dul:InformationObject"]),
    ("sources", [s for s in gl.subjects(RDF.type, DCTERMS.BibliographicResource)], ["obo:IAO_0000310", "cco:ont00002039", "schema:CreativeWork"]),
    ("collections", list(gl.subjects(RDF.type, SKOS.Collection)), ["dul:Collection", "gist:Collection", "schema:DefinedTermSet"]),
    ("release changes", list(changes.subjects(RDF.type, I2X.ReleaseChange)), ["obo:BFO_0000015", "cco:ont00000005", "gist:Event", "schema:UpdateAction"]),
]
record_summary = {}
for name, nodes, want in record_checks:
    nodes = [URIRef(n) if type(n) is str else n for n in nodes]
    ok = [n for n in nodes if all(w in types_of(n) for w in want)]
    record_summary[name] = {"count": len(nodes), "typed": len(ok), "as": want}
    check(len(ok) == len(nodes) and nodes, f"all {len(nodes)} I2IDL {name} are inferred {', '.join(want)}")
scheme_types = types_of(GLOSS_SCHEME)
check({"gist:ControlledVocabulary", "i2x:InformationReferent", "obo:IAO_0000030"} <= scheme_types,
      "I2IDL's scheme is a gist ControlledVocabulary and, classified by I2IDL's own 'Controlled vocabulary', an information artifact")
concept_level = {}
for cid, (cat, _, _) in assign.items():
    ct = types_of(URIRef(CONCEPT_BASE + cid))
    for want in LAYER.concept_classes(cat):
        concept_level.setdefault(want, 0)
        if want in ct:
            concept_level[want] += 1
check(all(concept_level[w] == sum(1 for _, (cat, _, _) in assign.items() if w in LAYER.concept_classes(cat)) for w in concept_level),
      "concepts carry their concept-level types: " + ", ".join(f"{k} {v}" for k, v in sorted(concept_level.items())))

EXPECT = {
    "academy": ["obo:BFO_0000027", "cco:ont00000564", "gist:Organization", "dul:Organization", "prov:Organization", "schema:EducationalOrganization", "org:Organization"],
    "teacher-1": ["obo:BFO_0000030", "cco:ont00001262", "gist:Person", "dul:Person", "gufo:Object", "prov:Person", "schema:Person"],
    "lrs-main": ["obo:IAO_0000010", "obo:BFO_0000031", "gist:System", "dul:InformationObject", "schema:SoftwareApplication"],
    "statements-api": ["obo:IAO_0000010", "schema:WebAPI"],
    "quiz-2026-10-01": ["obo:BFO_0000015", "cco:ont00000636", "gist:Determination", "dul:Action", "gufo:Event", "prov:Activity"],
    "mentoring-07": ["obo:BFO_0000015", "cco:ont00000234", "dul:Action", "gufo:Event", "schema:Action"],
    "course-le101": ["obo:IAO_0000104", "cco:ont00000974", "dul:Plan", "prov:Plan", "schema:Course", "ceterms:LearningOpportunity"],
    "badge-le101": ["obo:IAO_0000310", "cco:ont00002002", "schema:EducationalOccupationalCredential", "ler:Credential", "cred:VerifiableCredential"],
    "skill-t1-digital": ["obo:BFO_0000016", "cco:ont00001379", "gist:IntellectualProperty", "dul:Quality", "gufo:IntrinsicMode"],
    "statement-42": ["obo:IAO_0000027", "cco:ont00000853", "dul:InformationObject", "xapi:Statement"],
    "campus-north": ["obo:BFO_0000040", "cco:ont00000995", "gist:PhysicalIdentifiableItem", "dul:PhysicalArtifact"],
    "ai-use-policy": ["obo:IAO_0000033", "cco:ont00000965", "gist:Requirement", "dul:Norm"],
    "le-team": ["obo:BFO_0000027", "cco:ont00000300", "dul:Collective", "gufo:Collection"],
    "reading-2026": ["obo:IAO_0000027", "cco:ont00001163", "gist:Magnitude", "dul:SocialObjectAttribute", "gufo:QualityValue"],
    "spaced-plan": ["obo:IAO_0000104", "gist:TaskTemplate", "dul:Method", "prov:Plan"],
    "statement-43": ["i2x:DataReferent", "obo:IAO_0000027"],
    "lrs-transactional": ["i2x:ApplicationReferent", "obo:IAO_0000010", "schema:SoftwareApplication"],
}
EXNS = "https://example.org/academy/"
sample_types = {}
missing_expect = []
for ind, want in EXPECT.items():
    have = types_of(URIRef(EXNS + ind))
    sample_types[ind] = sorted(have)
    missing_expect += [f"{ind} ⊄ {w}" for w in want if w not in have]
check(not missing_expect, f"the sample organization's {len(EXPECT)} individuals land in BFO/IAO/CCO, gist, DUL, gUFO, PROV-O, "
      f"schema.org and peer classes as expected" + (f" — missing: {missing_expect[:6]}" if missing_expect else ""))
check("i2x:DataReferent" in sample_types["statement-43"] and "i2x:ApplicationReferent" in sample_types["lrs-transactional"],
      "data typed only with peer classes is classified through the crosswalk bridges (xapi:Statement, tla:TransactionalLRS)")
# The SHACL-AF referent rules (the path for engines without OWL) reach the same referent classes as OWL 2 RL for
# everything classified explicitly: the sample organization and I2IDL's own services.
rules_in = Graph()
for part in (sample, referents):
    for t in part:
        rules_in.add(t)
ruled = Graph()
for row in shacl_rules(rules_in, shacl_graph=rules, advanced=True, iterate_rules=True):
    ruled.add(tuple(row[:3]))


def referent_types(g: Graph, node) -> set[str]:
    return {str(o) for o in g.objects(node, RDF.type) if str(o).startswith(NS) and str(o).endswith("Referent")}


explicit = sorted(set(rules_in.subjects(I2X.isClassifiedBy, None)), key=str)
disagree = [short(str(n)) for n in explicit if referent_types(ruled, n) != referent_types(closed, n)]
n_rule_types = sum(len(referent_types(ruled, n)) for n in explicit)
check(explicit and not disagree,
      f"SHACL-AF referent rules agree with OWL 2 RL on all {len(explicit)} explicitly classified resources ({n_rule_types} referent typings)"
      + (f" — disagree: {disagree[:5]}" if disagree else ""))
clash_in = Graph()
for part in (UPPER_TBOX, onto, alignments, referents, clash):
    for t in part:
        clash_in.add(t)
_closed_clash, clash_errors = layer_mod.closure(clash_in)
clash_by = sorted({k for k, ns in (("BFO", "obo/BFO_"), ("DUL", "dul/DUL.owl"), ("gUFO", "nemo/gufo")) for e in clash_errors if ns in e})
check(len(clash_by) == 3, f"a thing classified as both a formative assessment and a classroom teacher is rejected: disjointness in {', '.join(clash_by)}")

# HermiT (OWL 2 DL) per upper ontology: complete consistency checking where OWL 2 RL is sound but incomplete.
hermit_results = {}
if os.environ.get("I2IDLX_HERMIT", "1") == "1":
    groups = {"BFO 2020 · IAO · CCO": ["bfo", "iao", "cco"], "gist": ["gist"], "DUL": ["dul"], "gUFO": ["gufo"],
              "PROV-O · schema.org · peers": ["prov", "schema", "org", "dct", "dcat", "lrmi", "esco", "elm", "asn"]}
    for gname, files in groups.items():
        for which, extra in (("sample", (gl, enact, mappings, releases, changes, sample)), ("clash", (clash,))):
            g_in = Graph()
            for f in files:
                g_in.parse(EVID / "upper" / f"{f}.ttl", format="turtle")
            for part in (onto, alignments, referents) + extra:
                for t in part:
                    g_in.add(t)
            try:
                ok, secs, detail = layer_mod.hermit(g_in, DIST / ".reasoning" / f"{gname.split()[0].lower()}-{which}")
                hermit_results.setdefault(gname, {})[which] = {"consistent": ok, "seconds": round(secs, 1), "detail": detail,
                                                                "triples": len(g_in)}
            except Exception as exc:  # Java missing or HermiT refused the input
                hermit_results.setdefault(gname, {})[which] = {"error": str(exc)[:300]}
    for gname, r in hermit_results.items():
        s = r.get("sample", {})
        check(s.get("consistent") is True, f"HermiT (OWL 2 DL): {gname} + I2IDL's release + I2IDL-X + the sample organization is consistent "
              f"({s.get('triples', 0):,} triples, {s.get('seconds', '?')} s)" + (f" — {s.get('error') or s.get('detail')}" if s.get("consistent") is not True else ""))
    clash_dl = sorted(g for g, r in hermit_results.items() if r.get("clash", {}).get("consistent") is False)
    clash_rl = {"BFO 2020 · IAO · CCO": "BFO", "DUL": "DUL", "gUFO": "gUFO"}
    check(sorted(clash_rl[g] for g in clash_dl if g in clash_rl) == clash_by and len(clash_dl) == len(clash_by),
          f"HermiT agrees with OWL 2 RL on the category clash: rejected under {', '.join(clash_dl) or 'none'}, "
          f"consistent under {', '.join(g for g, r in hermit_results.items() if r.get('clash', {}).get('consistent') is True) or 'none'}")
else:
    log("- INFO — HermiT skipped (I2IDLX_HERMIT=0)")

# Which referent categories can never share a member, and why: read off the closure's class hierarchy and the
# disjointness axioms OWL 2 RL applies (owl:disjointWith, owl:AllDisjointClasses), then confirmed by reasoning —
# one individual per pair of categories, typed with both classes; OWL 2 RL must reject exactly the pairs listed,
# under exactly the ontologies listed. The workbench's inference playground flags clashes from this table.
from rdflib.collection import Collection as RDFList
VOCAB_OF = [("http://purl.obolibrary.org/obo/BFO_", "BFO"), ("http://purl.obolibrary.org/obo/IAO_", "IAO"),
            ("https://www.commoncoreontologies.org/", "CCO"), ("https://w3id.org/semanticarts/ns/ontology/gist/", "gist"),
            ("http://www.ontologydesignpatterns.org/ont/dul/DUL.owl#", "DUL"), ("http://purl.org/nemo/gufo#", "gUFO"),
            ("http://www.w3.org/ns/prov#", "PROV-O"), ("https://schema.org/", "schema.org")]


def vocab_of(iri: str) -> str:
    return next((v for ns, v in VOCAB_OF if iri.startswith(ns)), short(iri).split(":")[0])


cat_cls = {c["id"]: URIRef(NS + c["cls"]) for c in SEM.CATEGORIES}
sup = {cid: {k} | {o for o in closed.objects(k, RDFS.subClassOf) if isinstance(o, URIRef)} for cid, k in cat_cls.items()}
DISJ: set[frozenset] = {frozenset((a, b)) for a, b in closed.subject_objects(OWL.disjointWith)}
for adc in closed.subjects(RDF.type, OWL.AllDisjointClasses):
    for lst in closed.objects(adc, OWL.members):
        members = list(RDFList(closed, lst))
        DISJ |= {frozenset((a, b)) for i, a in enumerate(members) for b in members[i + 1:]}
cat_ids = [c["id"] for c in SEM.CATEGORIES]
disjoint: dict[str, dict] = {}
for i, c1 in enumerate(cat_ids):
    for c2 in cat_ids[i + 1:]:
        wit = {}
        for a in sorted(sup[c1], key=str):
            for b in sorted(sup[c2], key=str):
                if frozenset((a, b)) in DISJ and vocab_of(str(a)) not in wit:
                    wit[vocab_of(str(a))] = [short(str(a)), short(str(b))]
        if wit:
            disjoint[f"{c1}|{c2}"] = wit
pairs_in = Graph()
for part in (UPPER_TBOX, onto, alignments):
    for t in part:
        pairs_in.add(t)
PAIR = "urn:i2idlx:pair:"
for i, c1 in enumerate(cat_ids):
    for c2 in cat_ids[i + 1:]:
        x = URIRef(f"{PAIR}{c1}--{c2}")
        pairs_in.add((x, RDF.type, cat_cls[c1]))
        pairs_in.add((x, RDF.type, cat_cls[c2]))
_t0 = _time.time()
_, pair_errors = layer_mod.closure(pairs_in)
pair_secs = _time.time() - _t0
rl_disjoint: dict[str, set] = {}
odd = []
for e in pair_errors:
    m = re.fullmatch(r"Disjoint classes (\S+) and (\S+) have a common individual " + re.escape(PAIR) + r"(\S+)", e)
    if m:
        rl_disjoint.setdefault(m.group(3).replace("--", "|"), set()).add(vocab_of(m.group(1)))
    else:
        odd.append(e)
same = {k: sorted(v) for k, v in rl_disjoint.items()} == {k: sorted(v) for k, v in disjoint.items()}
check(same and not odd, f"category disjointness table: {len(disjoint)} of {len(cat_ids) * (len(cat_ids) - 1) // 2} pairs of referent "
      f"categories can never share a member, and OWL 2 RL rejects exactly those pairs under exactly those ontologies ({pair_secs:.0f} s)"
      + (f" — differs: {sorted(set(rl_disjoint) ^ set(disjoint))[:4]}" if not same else "") + (f" — other errors: {odd[:2]}" if odd else ""))
check("assessment|person" in disjoint and sorted(disjoint["assessment|person"]) == clash_by,
      f"the table explains the sample clash: assessment vs person disjoint under {', '.join(sorted(disjoint.get('assessment|person', {})))}")
by_vocab_disj: dict[str, int] = {}
for w in disjoint.values():
    for v in w:
        by_vocab_disj[v] = by_vocab_disj.get(v, 0) + 1
log("- INFO — disjoint pairs by ontology: " + ", ".join(f"{k} {v}" for k, v in sorted(by_vocab_disj.items(), key=lambda kv: -kv[1])))

# Labels for every class the workbench shows, from the pinned snapshots (and peer contexts).
peer_labels = {k: v.get("label") for k, v in json.loads((EVID / "peer-terms.json").read_text())["terms"].items()}
want_labels = set(used_terms) | {w for pair in disjoint.values() for ab in pair.values() for w in ab} | {f"i2x:{c['cls']}" for c in SEM.CATEGORIES}


def best_label(iri: URIRef) -> str | None:
    """English label first (DUL tags its English labels and leaves Italian ones untagged), then untagged, then any."""
    for g in (UPPER_TBOX, onto):
        cands = sorted((o for pred in (SKOS.prefLabel, RDFS.label) for o in g.objects(iri, pred) if isinstance(o, Literal)), key=str)
        en = [o for o in cands if o.language and o.language.lower().startswith("en")]
        plain = [o for o in cands if not o.language and not str(o).endswith("{it}")]
        if en or plain or cands:
            return str((en or plain or cands)[0])
    return peer_labels.get(str(iri))


term_labels = {}
for curie in sorted(want_labels):
    lbl = best_label(URIRef(LAYER.expand(curie)))
    if lbl:
        term_labels[curie] = lbl
check(len(term_labels) >= 0.95 * len(want_labels), f"labels for {len(term_labels)} of {len(want_labels)} aligned terms come from their publishers' files")

semantic_summary = {
    "terms": len(used_terms), "byVocabulary": by_vocab, "categories": n_by_cat, "byBasis": {"type": len(assign) - n_def, "definition": n_def},
    "bridges": n_bridge, "owlrl": {"input": len(reason_in), "closed": len(closed), "seconds": round(rl_secs, 1), "errors": rl_errors},
    "records": record_summary, "conceptLevel": concept_level, "sample": sample_types, "expected": EXPECT,
    "clash": {"owlrl": clash_errors, "rejectedBy": clash_by}, "hermit": hermit_results,
    "rules": {"count": len(ref_rules), "explicit": len(explicit), "typings": n_rule_types, "agree": not disagree},
    "disjoint": disjoint, "disjointCheck": {"pairs": len(cat_ids) * (len(cat_ids) - 1) // 2, "seconds": round(pair_secs, 1), "agree": same and not odd},
    "labels": term_labels,
}
log()

log("## Stored queries (run locally over the pinned release)")
samples = {
    "concept-neighborhood": {"concept": f"<{CONCEPT_BASE}learning-record-store-lrs>"},
    "concept-search": {"text": '"record store"'},
    "definition-evidence": {"concept": f"<{CONCEPT_BASE}data-privacy>"},
    "collection-members": {"collection": "<https://id.i2idl.org/collections/curated/competency-and-assessment>"},
    "field-intersection": {"fieldA": "<https://id.i2idl.org/collections/field/learning-engineering>",
                           "fieldB": "<https://id.i2idl.org/collections/field/learning-sciences>"},
    "concepts-by-type": {"type": "<https://id.i2idl.org/collections/type/standard>"},
    "multi-field-concepts": {},
    "provenance-profile": {},
    "release-check": {"version": f'"{release}"'},
    "classify": {},
    "concept-referents": {"concept": f"<{CONCEPT_BASE}formative-assessment>"},
}
# Client-side queries run over what their ports return (vocabulary, alignments, referents) plus the agent's own data:
# here, the sample organization.
over_graph = Graph()
for part in (onto, alignments, referents, sample):
    for t in part:
        over_graph.add(t)
PORT_GRAPHS = {"port-vocabulary": onto, "port-alignments": alignments, "port-referents": referents}
query_results = {}
for slug, (meta, body) in stored.items():
    q = body
    for k, v in samples[slug].items():
        q = q.replace("$" + k, v)
    over = [p for p in meta.get("runsOver", "").split() if p]
    assert all(p in PORT_GRAPHS for p in over), f"{slug}: runsOver names an unknown port"
    res = (over_graph if over else gl).query(q)
    if meta["form"] == "CONSTRUCT" and over:
        query_results[slug] = res.graph
    if meta["form"] == "ASK":
        n = bool(res.askAnswer)
        ok = n is True
    elif meta["form"] == "CONSTRUCT":
        n = len(res.graph)
        ok = n > 0
    else:
        rows = list(res)
        n = len(rows)
        ok = n > 0
        query_results[slug] = rows
    check(ok and len(body) <= 12000, f"`{slug}` ({meta['form']}) → {n} result(s), {len(body)} chars")
prov_rows = {str(r[0]): int(r[1]) for r in query_results.get("provenance-profile", [])}
check(prov_rows.get("source-grounded") == n_grounded and prov_rows.get("synthesized", 0) == n_synth,
      f"stored query and SHACL rules agree on definition provenance {prov_rows}")
# q-classify is the no-reasoner path: everything it concludes OWL 2 RL also concludes, and it finds every referent
# class OWL 2 RL finds for the sample organization (crosswalk-bridged data included).
qc = query_results["classify"]
q_types = {(s, o) for s, o in qc.subject_objects(RDF.type)}
unsound = sorted(f"{short(str(s))} a {short(str(o))}" for s, o in q_types if (s, RDF.type, o) not in closed)
n_sample_types = sum(1 for s, _ in q_types if str(s).startswith(EXNS))
check(not unsound, f"q-classify concludes nothing OWL 2 RL does not ({len(q_types)} typings: {n_sample_types} of the sample "
      f"organization's {len(EXPECT)} resources, {len(q_types) - n_sample_types} of the I2IDL services i2idlx-referents classifies)"
      + (f" — extra: {unsound[:5]}" if unsound else ""))
missed = sorted(f"{ind} ⊄ {t}" for ind in EXPECT for t in types_of(URIRef(EXNS + ind))
                if t.startswith("i2x:") and t.endswith("Referent") and (URIRef(EXNS + ind), RDF.type, URIRef(LAYER.expand(t))) not in qc)
check(not missed, f"q-classify finds every referent class OWL 2 RL finds for the {len(EXPECT)} sample individuals"
      + (f" — missed: {missed[:5]}" if missed else ""))
upper_hit = {short(str(o)).split(":")[0] for _, o in q_types}
check({"obo", "cco", "gist", "dul", "gufo", "prov", "schema"} <= upper_hit,
      "without a reasoner, q-classify already types the sample in BFO/IAO, CCO, gist, DUL, gUFO, PROV-O and schema.org")
semantic_summary["classify"] = {"typings": len(q_types), "sampleTypings": n_sample_types, "sound": not unsound, "complete": not missed,
                                "byResource": {short(str(s)): sorted(short(str(o)) for o in qc.objects(s, RDF.type))
                                               for s in sorted(set(qc.subjects(RDF.type, None)), key=str)}}
(DIST / "semantic-layer.json").write_text(json.dumps(semantic_summary, indent=2, ensure_ascii=False) + "\n")
log()

# ── 7. Decorations (local materialization) ───────────────────────────────────────
log("## Decorator projection")
dq = render((SRC / "queries" / "build" / "decorations.rq").read_text())
deco = (gl + catalog).query(dq).graph
for t in inferred.triples((None, None, None)):
    if t[1] in (RDF.type, I2X.editorialModality) and (str(t[0]).startswith(CONCEPT_BASE) or str(t[0]).startswith("https://id.i2idl.org/definitions/")):
        deco.add(t)
for t in enact.triples((None, None, None)):
    if str(t[1]).startswith(NS) and str(t[0]).startswith(CONCEPT_BASE):
        deco.add(t)
inh = (gl + enact + onto).query(f"""
PREFIX skos: <http://www.w3.org/2004/02/skos/core#> PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#> PREFIX i2x: <{NS}>
CONSTRUCT {{ ?c i2x:inheritedEnactedBy ?a }} WHERE {{
  ?c skos:broader+ ?b . ?b ?p ?a . ?p rdfs:subPropertyOf+ i2x:enactedBy .
  FILTER NOT EXISTS {{ ?c ?p2 ?a . ?p2 rdfs:subPropertyOf+ i2x:enactedBy }} }}""").graph
for t in inh:
    deco.add(t)
deco.add((URIRef(IRI["decorations"]), RDF.type, OWL.Ontology))
deco.add((URIRef(IRI["decorations"]), DCTERMS.title, Literal("I2IDL-X decorations (materialized)", lang="en")))
deco.add((URIRef(IRI["decorations"]), PROV.wasDerivedFrom, URIRef(IRI["catalog"])))
deco.add((URIRef(IRI["decorations"]), PROV.wasDerivedFrom, URIRef(f"https://github.com/blakeplock/i2idl-linked-data/blob/{commit}/public/glossary.jsonld")))
for p, n in [("i2x", NS), ("cat", IRI["catalog"] + "#"), ("dec", IRI["decorations"] + "#"), ("iep", str(IEP)),
             ("ieh", "https://markjspivey-xwisee.github.io/interego/ns/harness#"), ("hydra", str(HYDRA)),
             ("dcat", "http://www.w3.org/ns/dcat#"), ("prov", str(PROV)), ("i2idl", CONCEPT_BASE),
             ("fxa", ACTION_ROOT + "foxxi/"), ("rla", ACTION_ROOT + "relay/")]:
    deco.bind(p, n)
deco_path = DIST / f"{cfg['slugs']['decorations']}.ttl"
deco.serialize(deco_path, format="turtle")
n_aff = sum(1 for _ in deco.subjects(RDF.type, IEP.Affordance))
check(n_aff == 5 * len(concepts), f"{n_aff} concrete affordances materialized (5 × {len(concepts)} concepts), {deco_path.stat().st_size:,} bytes")
check(len(inh) > 0, f"{len(inh)} inherited enactments along skos:broader+")
ok, _, text = shacl_validate(deco, shacl_graph=shapes, ont_graph=onto, inference="rdfs", advanced=True)
check(ok, "materialized decorations conform to I2IDL-X shapes")
if not ok:
    (DIST / "decorations-violations.txt").write_text(text)
log()

# ── 8. Interego's own extractor and HyperMarkdown renderer (optional) ──────────
log("## Interego affordance extractor and HyperMarkdown renderer")
icore, tsx = cfg.get("interegoCoreSrc", ""), cfg.get("tsx", "")
if not (icore and tsx and pathlib.Path(icore).exists() and pathlib.Path(tsx).exists()):
    log("- INFO — skipped: set interegoCoreSrc and tsx in config.json to run Interego's own extractor (see README)")
else:
    def run_ts(script: str, *args: str) -> dict:
        return json.loads(subprocess.run([tsx, str(ROOT / "tools" / script), *args], capture_output=True, text=True,
                                         cwd=pathlib.Path(tsx).parents[2], env={**__import__("os").environ, "ICORE": icore},
                                         check=True).stdout)
    for key, path, expect in [("catalog", DIST / f"{cfg['slugs']['catalog']}.ttl", None), ("decorations", deco_path, 5 * len(concepts))]:
        out = run_ts("interego-extract.mts", str(path), IRI[key])
        if expect is None:
            n_ports = sum(1 for s in catalog.subjects(RDF.type, IEP.Affordance) if catalog.value(s, HYDRA.target))
            n_tmpl = sum(1 for s in catalog.subjects(RDF.type, IEP.Affordance) if not catalog.value(s, HYDRA.target))
            check(out["strictCount"] == n_ports,
                  f"catalog: {out['strictCount']} strictly followable controls (= every port with a hydra:target); {n_tmpl} templated controls left to the agent / projection")
        else:
            check(out["strictCount"] == expect, f"decorations: {out['strictCount']} strictly followable controls")
    (DIST / "preview").mkdir(exist_ok=True)
    hmd = run_ts("hmd-render.mts", str(DIST / f"{cfg['slugs']['catalog']}.ttl"), IRI["catalog"], cfg["owner"],
                 cfg["slugs"]["catalog"], str(DIST / "preview" / "i2idlx-catalog.hmd.md"))
    check(hmd["controls"] == sum(1 for _ in catalog.subjects(RDF.type, IEP.Affordance)),
          f"HyperMarkdown projection of the catalog (relay's nsMarkdown path) renders all {hmd['controls']} controls")
    sample = Graph()
    lrs = URIRef(CONCEPT_BASE + "learning-record-store-lrs")
    for s_, p_, o_ in deco.triples((lrs, None, None)):
        sample.add((s_, p_, o_))
        if p_ == IEP.affordance:
            for t in deco.triples((o_, None, None)):
                sample.add(t)
    sample_path = DIST / "preview" / "concept-learning-record-store-lrs.ttl"
    sample.namespace_manager = deco.namespace_manager
    sample.serialize(sample_path, format="turtle")
    run_ts("hmd-render.mts", str(sample_path), IRI["decorations"], cfg["owner"], "learning-record-store-lrs (decorated)",
           str(DIST / "preview" / "concept-learning-record-store-lrs.hmd.md"))
for key, g in [("catalog", catalog), ("decorations", deco)]:
    acts = [str(g.value(s, IEP.action)) for s in g.subjects(RDF.type, IEP.Affordance) if g.value(s, HYDRA.target)]
    dupes = sorted({a for a in acts if acts.count(a) > 1})
    check(not dupes, f"{key}: every followable control has its own action, so invoke_affordance(descriptor, action) is unambiguous ({len(acts)} controls){'; shared: ' + ', '.join(dupes) if dupes else ''}")
log()

# ── 9. Live checks ───────────────────────────────────────────────────────────────
live_notes = []
if LIVE:
    log("## Live checks")

    def http(url: str, accept: str = "*/*", method: str = "GET") -> tuple[int, str, str]:
        class NoRedirect(urllib.request.HTTPRedirectHandler):
            def redirect_request(self, *a, **k):
                return None
        opener = urllib.request.build_opener(NoRedirect)
        req = urllib.request.Request(url, headers={"Accept": accept, "User-Agent": "i2idlx-build/0.1"}, method=method)
        try:
            with opener.open(req, timeout=30) as r:
                return r.status, r.headers.get("Content-Type", ""), r.read(400_000).decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Content-Type", ""), e.headers.get("Location", "") or ""

    actions = sorted({str(o) for o in enact.objects() if str(o).startswith(ACTION_ROOT)})
    statuses = {a: http(a)[0] for a in actions}
    bad_a = [a for a, s in statuses.items() if s != 302]
    check(not bad_a, f"all {len(actions)} linked action IRIs dereference (302 → defining manifest){'; failing: ' + ', '.join(bad_a) if bad_a else ''}")
    sample_ids = ["data-privacy", "learning-record-store-lrs", "xapi-statement", "competency", "a-b-testing"]
    okc = all(http(f"{CONCEPT_BASE}{i}.ttl", "text/turtle")[0] == 200 for i in sample_ids)
    check(okc, f"sample of materialized resolve targets return 200 text/turtle ({', '.join(sample_ids)})")
    nb = next(deco.objects(URIRef(IRI["decorations"] + "#learning-record-store-lrs--neighborhood"), HYDRA.target))
    st, ct, body = http(str(nb), "text/turtle")
    ng = Graph()
    if st == 200:
        ng.parse(data=body, format="turtle")
    check(st == 200 and len(ng) > 0, f"live neighborhood control for learning-record-store-lrs → {st} {ct.split(';')[0]}, {len(ng)} triples")
    live_notes.append(("neighborhood", str(nb), st, len(ng), body[:1800]))
    q = stored["provenance-profile"][1]
    st, ct, body = http("https://id.i2idl.org/sparql?query=" + urllib.parse.quote(q), "application/sparql-results+json")
    live_rows = {}
    if st == 200:
        for b in json.loads(body)["results"]["bindings"]:
            live_rows[b["provenance"]["value"]] = int(b["definitions"]["value"])
    check(live_rows == prov_rows, f"stored provenance query against the live endpoint matches the local run {live_rows}")
    q = stored["release-check"][1].replace("$version", f'"{release}"')
    st, ct, body = http("https://id.i2idl.org/sparql?query=" + urllib.parse.quote(q), "application/sparql-results+json")
    still = st == 200 and json.loads(body).get("boolean") is True
    check(still, f"live glossary still reports {release}")
    live_notes.append(("release-check", q, st, still, body[:300]))

    # Interego's follower contract (packages/core/src/affordance/follow.ts): a control's dcat:mediaType
    # is sent as BOTH Content-Type and Accept, a GET carries no body, and a string payload is sent as-is.
    # Replay every read-only catalog port exactly that way, so a port that only works for hand-written
    # HTTP clients is caught here rather than by an agent at run time.
    DCAT_MEDIA = URIRef("http://www.w3.org/ns/dcat#mediaType")

    def follow(target: str, method: str, media: str | None, body: str | None = None) -> tuple[int, str, str]:
        headers = {"Content-Type": media or "application/json", "Accept": media or "application/json, */*",
                   "User-Agent": "i2idlx-build/0.1"}
        data = body.encode("utf-8") if (body is not None and method != "GET") else None
        req = urllib.request.Request(target, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.status, r.headers.get("Content-Type", ""), r.read(400_000).decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            return e.code, e.headers.get("Content-Type", ""), ""

    followed, unfollowable = [], []
    for port in sorted(set(catalog.subjects(RDF.type, IEP.Affordance)), key=str):
        target = catalog.value(port, HYDRA.target)
        action = str(catalog.value(port, IEP.action))
        if target is None or catalog.value(port, IEP.readOnlyHint) != Literal(True) or action.startswith(ACTION_ROOT):
            continue  # templated, a write, or another vertical's affordance (its own manifest owns that contract)
        method = str(catalog.value(port, HYDRA.method) or "POST")
        media = catalog.value(port, DCAT_MEDIA)
        media = str(media) if media is not None else None
        name = str(port).rsplit("#", 1)[-1]
        if method == "GET" and catalog.value(port, HYDRA.expects) is not None:
            continue  # input travels in the URL, which the follower cannot add; the port says so and points to POST
        st, ct, body = follow(str(target), method, media, q if method != "GET" else None)
        ok = 200 <= st < 300
        if ok and media == "application/sparql-query":
            ok = json.loads(body).get("boolean") is True
        (followed if ok else unfollowable).append(f"{name} {st}")
    check(not unfollowable and followed,
          f"read-only catalog ports answer when followed as Interego's follower sends them ({', '.join(followed)})"
          f"{'; failing: ' + ', '.join(unfollowable) if unfollowable else ''}")
    from rdflib.compare import isomorphic
    for key in ("shapes", "ontology", "rules", "catalog", "enactments", "mappings", "releases", "changes", "alignments", "referents"):
        slug = cfg["slugs"][key]
        st, ct, body = http(f"{BASE}/{slug}", "text/turtle")
        if st == 200:
            try:
                same = isomorphic(Graph().parse(data=body, format="turtle"), Graph().parse(DIST / f"{slug}.ttl", format="turtle"))
            except Exception:
                same = False
            state = "published, identical to this build" if same else "published, DIFFERS from this build (republish it)"
        else:
            state = "not yet published" if st == 404 else f"unexpected status {st}"
        log(f"- INFO — `{BASE}/{slug}`: {state}")
    log()

# ── 9b. Worked examples ──────────────────────────────────────────────────────────
log("## Worked examples")
(DIST / "examples").mkdir(exist_ok=True)
stmt = json.loads((EX / "usage-statement.json").read_text())
tagged = stmt["context"]["extensions"]["https://foxxi-bridge.interego.xwisee.com/ns/foxxi#conceptIds"]
check(all(t in concepts for t in tagged), f"usage statement tags {len(tagged)} concepts, all present in I2IDL {release}")
proj = Graph()
rec = URIRef("urn:example:usage:" + stmt["id"].split("-")[0])
proj.add((rec, RDF.type, I2X.UsageRecord))
proj.add((rec, I2X.statement, URIRef("urn:uuid:" + stmt["id"])))
proj.add((rec, I2X.usageVerb, URIRef(stmt["verb"]["id"])))
proj.add((rec, I2X.usageActivity, URIRef(stmt["object"]["id"])))
for t in tagged:
    proj.add((rec, I2X.aboutConcept, URIRef(t)))
proj.add((rec, URIRef("https://markjspivey-xwisee.github.io/interego/ns/interego#forAgent"), URIRef("urn:example:learner")))
proj.add((rec, PROV.generatedAtTime, Literal(stmt["timestamp"], datatype=XSD.dateTime)))
proj.bind("i2x", NS)
proj.serialize(DIST / "examples" / "usage-record.ttl", format="turtle")
(DIST / "examples" / "usage-statement.json").write_text(json.dumps(stmt, indent=2) + "\n")
ex_graphs = {"usage-record.ttl": proj}
for f in sorted(EX.glob("*.ttl")):
    text = render(f.read_text())
    (DIST / "examples" / f.name).write_text(text)
    ex_graphs[f.name] = Graph().parse(data=text, format="turtle")
for name, g in ex_graphs.items():
    ok, _, text = shacl_validate(g, shacl_graph=shapes, ont_graph=onto, inference="rdfs", advanced=True)
    check(ok, f"example `{name}` conforms to I2IDL-X shapes ({len(g)} triples)")
voted = {str(o) for g in ex_graphs.values() for o in g.objects(None, I2X.votesOn)}
check(voted <= {str(s) for s in mappings.subjects(RDF.type, I2X.MappingProposal)}, "the example vote targets a proposal that exists in the mappings graph")
log()

# ── 10. Companion artifacts ──────────────────────────────────────────────────────
context = {
    "@context": {
        "@version": 1.1,
        "i2x": NS, "i2idl": CONCEPT_BASE, "iep": str(IEP), "ieh": "https://markjspivey-xwisee.github.io/interego/ns/harness#",
        "hyprcat": "https://markjspivey-xwisee.github.io/interego/ns/hyprcat#",
        "hypragent": "https://markjspivey-xwisee.github.io/interego/ns/hypragent#",
        "ie": "https://markjspivey-xwisee.github.io/interego/ns/interego#",
        "foxxi": "https://foxxi-bridge.interego.xwisee.com/ns/foxxi#", "xapi": "https://w3id.org/xapi/ontology#",
        "skos": str(SKOS), "dct": str(DCTERMS), "prov": str(PROV), "hydra": str(HYDRA), "xsd": str(XSD),
        "Enactment": "i2x:Enactment", "MappingProposal": "i2x:MappingProposal", "RatificationVote": "i2x:RatificationVote",
        "UsageRecord": "i2x:UsageRecord", "CourseConceptAlignment": "i2x:CourseConceptAlignment",
        "ReleaseChange": "i2x:ReleaseChange", "ChangeEvent": "i2x:ChangeEvent",
        "partOfChange": {"@id": "i2x:partOfChange", "@type": "@id"},
        "changeKind": {"@id": "i2x:changeKind", "@type": "@id"},
        "changeCount": {"@id": "i2x:changeCount", "@type": "xsd:integer"},
        "changedConcept": {"@id": "i2x:changedConcept", "@type": "@id", "@container": "@set"},
        "changedCollection": {"@id": "i2x:changedCollection", "@type": "@id"},
        "changedSource": {"@id": "i2x:changedSource", "@type": "@id"},
        "citedIn": {"@id": "i2x:citedIn", "@type": "@id"},
        "enactedConcept": {"@id": "i2x:enactedConcept", "@type": "@id"},
        "viaAction": {"@id": "i2x:viaAction", "@type": "@id"},
        "enactmentRole": {"@id": "i2x:enactmentRole", "@type": "@id"},
        "proposedSubject": {"@id": "i2x:proposedSubject", "@type": "@id"},
        "proposedPredicate": {"@id": "i2x:proposedPredicate", "@type": "@id"},
        "proposedObject": {"@id": "i2x:proposedObject", "@type": "@id"},
        "reviewStatus": {"@id": "i2x:reviewStatus", "@type": "@id"},
        "mappingMethod": {"@id": "i2x:mappingMethod", "@type": "@id"},
        "rationale": "i2x:rationale",
        "confidence": {"@id": "i2x:confidence", "@type": "xsd:decimal"},
        "votesOn": {"@id": "i2x:votesOn", "@type": "@id"},
        "vote": {"@id": "i2x:vote", "@type": "@id"},
        "aboutConcept": {"@id": "i2x:aboutConcept", "@type": "@id", "@container": "@set"},
        "statement": {"@id": "i2x:statement", "@type": "@id"},
        "usageVerb": {"@id": "i2x:usageVerb", "@type": "@id"},
        "usageActivity": {"@id": "i2x:usageActivity", "@type": "@id"},
        "courseConcept": {"@id": "i2x:courseConcept", "@type": "@id"},
        "alignedTo": {"@id": "i2x:alignedTo", "@type": "@id"},
        "alignmentPredicate": {"@id": "i2x:alignmentPredicate", "@type": "@id"},
        "enactedBy": {"@id": "i2x:enactedBy", "@type": "@id", "@container": "@set"},
        "generatedAtTime": {"@id": "prov:generatedAtTime", "@type": "xsd:dateTime"},
        "attributedTo": {"@id": "prov:wasAttributedTo", "@type": "@id"},
        "Referent": "i2x:Referent",
        "isClassifiedBy": {"@id": "i2x:isClassifiedBy", "@type": "@id", "@container": "@set"},
        "classifies": {"@id": "i2x:classifies", "@type": "@id", "@container": "@set"},
        "referentCategory": {"@id": "i2x:referentCategory", "@type": "@id"},
        "categoryRationale": {"@id": "i2x:categoryRationale", "@language": "en"},
        "assignmentBasis": "i2x:assignmentBasis",
        "exemplifiedBy": {"@id": "i2x:exemplifiedBy", "@type": "@id"},
        "subject": {"@id": "dct:subject", "@type": "@id", "@container": "@set"},
    }
}
(DIST / "i2idlx.context.jsonld").write_text(json.dumps(context, indent=2) + "\n")

plan = []
order = [("shapes", "Asserted", 0.95, []), ("ontology", "Asserted", 0.9, []), ("rules", "Asserted", 0.9, []),
         ("catalog", "Asserted", 0.9, [IRI["shapes"]]), ("enactments", "Hypothetical", 0.7, [IRI["shapes"]]),
         ("mappings", "Hypothetical", 0.7, [IRI["shapes"]]), ("releases", "Asserted", 0.95, [IRI["shapes"]]),
         ("changes", "Asserted", 0.95, [IRI["shapes"]]), ("alignments", "Hypothetical", 0.7, [IRI["shapes"]]),
         ("referents", "Hypothetical", 0.7, [IRI["shapes"]])]
for key, modal, conf, shapes_iri in order:
    path = DIST / f"{cfg['slugs'][key]}.ttl"
    size = path.stat().st_size
    plan.append({"order": len(plan) + 1, "graph_iri": IRI[key], "file": path.name, "bytes": size,
                 "approxTokens": round(size / 3.6), "modal_status": modal, "confidence": conf,
                 "visibility": "public", "conforms_to_shapes": shapes_iri,
                 "note": "public is required for /ns dereference; there is no unpublish"})
(DIST / "publish-plan.json").write_text(json.dumps({"owner": cfg["owner"], "relayNsRoot": cfg["relayNsRoot"],
                                                     "graphs": plan, "localOnly": [deco_path.name]}, indent=2) + "\n")

log("## Summary")
log(f"- Enactments: {len(cw.ENACTMENTS)} reified concept→affordance links over {len({e[0] for e in cw.ENACTMENTS})} concepts and "
    f"{len({e[2] for e in cw.ENACTMENTS})} distinct actions; {n_role} role capabilities")
log(f"- Mapping proposals: {len(cw.MAPPINGS)} ({sum(1 for m in cw.MAPPINGS if m[4] == cw.ST)} standards-text, "
    f"{sum(1 for m in cw.MAPPINGS if m[4] == cw.EC)} evidence-cited, {sum(1 for m in cw.MAPPINGS if m[4] == cw.AI)} AI-drafted); 0 asserted")
log(f"- Change history: {len(hrels) - 1} release changes since {hrels[0]['version']}, {n_ch} change events, {n_events:,} fact-level changes")
log(f"- Semantic layer: {len(SEM.CATEGORIES)} referent categories over {len(assign)} concepts; {len(used_terms)} aligned terms in "
    f"{len(by_vocab)} vocabularies; {n_bridge} crosswalk bridges; {len(ref_rules)} SHACL-AF referent rules")
log(f"- Stored queries: {len(stored)} ({sum(1 for m, _ in stored.values() if m.get('runsOver'))} client-side); "
    f"catalog controls: {sum(1 for _ in catalog.subjects(RDF.type, IEP.Affordance))}")
log(f"- Failures: {len(failures)}")
(DIST / "verification-report.md").write_text("\n".join(report) + "\n")
if live_notes:
    (DIST / "live-notes.json").write_text(json.dumps(live_notes, indent=1))
sys.exit(1 if failures else 0)
