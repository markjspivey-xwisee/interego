"""Build Interpretant, the Foxxi workbench for the I2IDL glossary, from the same sources as I2IDL-X.

python3 -I tools/build_app.py <i2idlx-root> [--data-only]

1. Extract: the pinned I2IDL glossary (JSON-LD) joined with the built I2IDL-X graphs in dist/, the
   publication record and the evidence snapshots (tools/refresh_app_evidence.py) → app/build/data.json.
   Every derived fact is checked against the graph it comes from (kinds, provenance, decorated
   controls), so the app cannot drift from what is published.
2. Lay out the whole-glossary map once, deterministically (app/tools/layout.mjs, d3-force).
3. Bundle app/src with esbuild and assemble site/app.html (data inline, React/d3 from cdnjs).

Never touches the network.
"""
import datetime as dt
import html
import json
import os
import pathlib
import re
import subprocess
import sys
import urllib.parse

from rdflib import Graph, Literal, Namespace, URIRef
from rdflib.namespace import OWL, RDF, RDFS, SKOS
import importlib.util

ROOT = pathlib.Path(sys.argv[1]).resolve()
DATA_ONLY = "--data-only" in sys.argv
cfg = json.loads((ROOT / "config.json").read_text())
# Machine-specific paths: an environment variable wins; a relative path is read from the package root.
for _keys, _env in ((("i2idl", "localClone"), "I2IDL_CLONE"), (("interegoCoreSrc",), "INTEREGO_CORE_SRC"), (("tsx",), "INTEREGO_TSX")):
    _holder = cfg
    for _k in _keys[:-1]:
        _holder = _holder[_k]
    _v = os.environ.get(_env) or _holder.get(_keys[-1], "")
    _holder[_keys[-1]] = str((ROOT / _v).resolve()) if _v and not os.path.isabs(_v) else _v
DIST, EV, APP = ROOT / "dist", ROOT / "evidence", ROOT / "app"
BASE = f"{cfg['relayNsRoot']}/{cfg['owner']}"
SLUG = cfg["slugs"]
IRI = {k: f"{BASE}/{v}" for k, v in SLUG.items()}
NS = IRI["ontology"] + "#"
I2X = Namespace(NS)
CAT = Namespace(IRI["catalog"] + "#")
EN = Namespace(IRI["enactments"] + "#")
MP = Namespace(IRI["mappings"] + "#")
DEC = Namespace(IRI["decorations"] + "#")
IEP = Namespace("https://markjspivey-xwisee.github.io/interego/ns/iep#")
IEH = Namespace("https://markjspivey-xwisee.github.io/interego/ns/harness#")
IE = "https://markjspivey-xwisee.github.io/interego/ns/interego#"
HYDRA = Namespace("http://www.w3.org/ns/hydra/core#")
DCAT = Namespace("http://www.w3.org/ns/dcat#")
PROV = Namespace("http://www.w3.org/ns/prov#")
DCT = Namespace("http://purl.org/dc/terms/")
SH = Namespace("http://www.w3.org/ns/shacl#")
ACTION_ROOT = "https://relay.interego.xwisee.com/ns/iep/action/"
I2IDL = "https://id.i2idl.org/"
CONCEPTS = I2IDL + "concepts/"
GS = "https://glossarystudio.app/ns/"
ENDPOINT = "https://id.i2idl.org/sparql"
SHAPES = IRI["shapes"]

failures: list[str] = []


def check(ok: bool, what: str) -> None:
    print(("PASS " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


def clean(s) -> str | None:
    if s is None:
        return None
    return " ".join(str(s).split())


def ids(v) -> list[str]:
    if v is None:
        return []
    if isinstance(v, dict) or isinstance(v, str):
        v = [v]
    return [x["@id"] if isinstance(x, dict) else x for x in v]


def aslist(v) -> list:
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def local(iri: str, root: str) -> str:
    assert iri.startswith(root), (iri, root)
    return iri[len(root):]


def ttl(slug_key: str) -> Graph:
    return Graph().parse(DIST / f"{SLUG[slug_key]}.ttl", format="turtle")


def text(g: Graph, s, *preds) -> str | None:
    for p in preds:
        vals = list(g.objects(s, p))
        if vals:
            en = [v for v in vals if isinstance(v, Literal) and v.language in (None, "en")]
            return clean((en or vals)[0])
    return None


# ── Sources of truth ────────────────────────────────────────────────────────────────────────────────
glossary_path = pathlib.Path(cfg["i2idl"]["localClone"]) / cfg["i2idl"]["graphPath"]
gl = json.loads(glossary_path.read_text())
nodes = gl["@graph"]
by_id = {n["@id"]: n for n in nodes}
commit = subprocess.run(["git", "-C", cfg["i2idl"]["localClone"], "log", "-1", "--format=%H|%cI", "--",
                         cfg["i2idl"]["graphPath"]], capture_output=True, text=True, check=True).stdout.strip()
commit_sha, commit_date = commit.split("|")

onto, cat, enact, maps, rels, deco, chg = (ttl(k) for k in
                                            ("ontology", "catalog", "enactments", "mappings", "releases", "decorations", "changes"))
hspec = importlib.util.spec_from_file_location("history", ROOT / "src" / "history.py")
hist = importlib.util.module_from_spec(hspec)
hspec.loader.exec_module(hist)
unesco = json.loads((EV / "unesco-thesaurus.json").read_text())
published = json.loads((DIST / "published.json").read_text())
fx = Graph().parse(EV / "foxxi-manifest.ttl", format="turtle")
relay_ops = json.loads((EV / "relay-operations.json").read_text())["hydra:member"]
relay_inputs = json.loads((EV / "relay-inputs.json").read_text())
ext_terms = json.loads((EV / "external-terms.json").read_text())
for iri, term in unesco["terms"].items():  # UNESCO targets come from their own snapshot (tools/refresh_unesco.py)
    ext_terms[iri] = {"label": term["label"], "definition": term["scopeNote"] or term["definition"], "alt": term["alt"],
                      "page": term["page"], "noteKind": "scope note" if term["scopeNote"] else None}

scheme = by_id[I2IDL + "scheme"]
release = scheme["gs:publicationVersion"]
check(release == cfg["i2idl"]["release"], f"glossary release {release} is the pinned release")

# ── Vocabulary the app speaks (from the ontology) ───────────────────────────────────────────────────
KIND_ORDER = ["NotionConcept", "EnactableConcept", "SystemConcept", "StandardConcept", "DomainConcept",
              "FrameworkConcept", "ActorConcept", "NormativeConcept"]
kinds, kind_of_type = [], {}
for cls in KIND_ORDER:
    s = I2X[cls]
    types = sorted(local(str(o), I2IDL + "collections/type/") for o in onto.objects(s, I2X.kindForTypeCollection))
    kid = cls.replace("Concept", "").lower()
    for t in types:
        kind_of_type[t] = kid
    kinds.append({"id": kid, "cls": str(s), "label": cls.replace("Concept", ""),
                  "def": text(onto, s, RDFS.comment), "types": types})
check(len(kinds) == 8 and all(k["def"] for k in kinds), "8 agentic kinds, each with its ontology definition")

roles = []
for s in onto.subjects(SKOS.inScheme, I2X.EnactmentRoles):
    prop = onto.value(s, I2X.asProperty)
    roles.append({"id": local(str(s), NS + "role-"), "label": text(onto, s, SKOS.prefLabel),
                  "prop": local(str(prop), NS), "by": text(onto, prop, RDFS.label) or "",
                  "def": text(onto, s, SKOS.definition)})
ROLE_ORDER = ["operationalizes", "realizes", "implements", "measures", "records", "credentials", "enforces", "explains"]
roles.sort(key=lambda r: ROLE_ORDER.index(r["id"]))
check(len(roles) == 8 and all(r["by"] for r in roles), "8 enactment roles with their materialized properties")

statuses = [{"id": local(str(s), NS + "status-"), "label": text(onto, s, SKOS.prefLabel), "def": text(onto, s, SKOS.definition)}
            for s in onto.subjects(SKOS.inScheme, I2X.ReviewStatuses)]
methods = [{"id": local(str(s), NS + "method-"), "label": text(onto, s, SKOS.prefLabel), "def": text(onto, s, SKOS.definition)}
           for s in onto.subjects(SKOS.inScheme, I2X.MappingMethods)]

QORDER = ["What", "Why", "WhatKind", "Where", "Whose", "How", "HowMuch", "Whether"]
interrogatives = []
for p, q in onto.subject_objects(I2X.answersInterrogative):
    interrogatives.append({"q": local(str(q), IE), "prop": str(p),
                           "label": text(onto, p, RDFS.label) or ("definition" if p == SKOS.definition else str(p))})
interrogatives.sort(key=lambda r: QORDER.index(r["q"]))
check([r["q"] for r in interrogatives] == QORDER, "the eight Interego interrogatives the ontology answers")

# ── Collections ────────────────────────────────────────────────────────────────────────────────────
collections = {"field": [], "type": [], "curated": []}
members: dict[str, list[str]] = {}
for n in nodes:
    if "skos:Collection" not in ids(n.get("@type")) and n.get("@type") != "skos:Collection":
        continue
    facet = n["gs:facet"]
    cid = local(n["@id"], I2IDL + f"collections/{facet}/")
    mem = sorted(local(m, CONCEPTS) for m in ids(n.get("skos:member")))
    members[n["@id"]] = mem
    rec = {"id": cid, "label": n["skos:prefLabel"], "n": len(mem)}
    if n.get("dcterms:description"):
        rec["desc"] = clean(n["dcterms:description"])
    if facet == "type":
        rec["kind"] = kind_of_type[cid]
    collections[facet].append(rec)
for f in collections:
    collections[f].sort(key=lambda r: (-r["n"], r["label"]))
check((len(collections["field"]), len(collections["type"]), len(collections["curated"])) == (12, 16, 3),
      "31 collections: 12 field, 16 type, 3 curated")
check(set(kind_of_type) == {c["id"] for c in collections["type"]}, "every type collection has exactly one agentic kind")

# ── Sources and rights ─────────────────────────────────────────────────────────────────────────────


def rights_class(r: str) -> str:
    u = r.upper()
    if "NC" in u.split("-") or "-NC" in u:
        return "nc"
    if "PERMISSION" in u or "TERMS APPLY" in u:
        return "permission"
    if "SA" in u.replace("-", " ").split():
        return "sharealike"
    return "open"


sources, src_index = [], {}
short_label = {}
for n in nodes:
    for ev in aslist(n.get("gs:evidence")):
        short_label.setdefault(ev["dcterms:source"]["@id"], ev["gs:sourceLabel"])
for n in sorted((n for n in nodes if n.get("@type") == "dcterms:BibliographicResource"), key=lambda n: n["@id"]):
    sid = local(n["@id"], I2IDL + "sources/")
    rights = n.get("dcterms:rights", "")
    rec = {"id": sid, "iri": n["@id"], "title": n["dcterms:title"], "label": short_label.get(n["@id"], n["dcterms:title"]),
           "url": n.get("schema:url"), "rights": rights, "rightsUrl": n.get("gs:rightsUrl"), "rc": rights_class(rights)}
    for k, jk in (("creator", "dcterms:creator"), ("publisher", "dcterms:publisher"), ("date", "dcterms:date"),
                  ("doi", "dcterms:identifier"), ("page", "gs:publicationPage"), ("cite", "gs:preferredCitation"),
                  ("adapt", "gs:adaptationNotice"), ("disclaimer", "gs:adaptationDisclaimer"),
                  ("thirdParty", "gs:thirdPartyMaterialNotice")):
        if n.get(jk):
            rec[k] = clean(n[jk]) if isinstance(n[jk], str) else n[jk]
    src_index[n["@id"]] = len(sources)
    sources.append(rec)
check(len(sources) == 14, "14 evidence sources with rights")
print("     rights classes:", {s["label"]: s["rc"] for s in sources})

# ── Concepts ───────────────────────────────────────────────────────────────────────────────────────
concept_nodes = sorted((n for n in nodes if "skos:Concept" in ids(n.get("@type"))), key=lambda n: n["skos:prefLabel"].lower())
field_of: dict[str, list[str]] = {}
curated_of: dict[str, list[str]] = {}
for col_iri, mem in members.items():
    facet = col_iri.split("/collections/")[1].split("/")[0]
    cid = col_iri.rsplit("/", 1)[-1]
    for m in mem:
        if facet == "field":
            field_of.setdefault(m, []).append(cid)
        elif facet == "curated":
            curated_of.setdefault(m, []).append(cid)

KIND_CLASS = {k["cls"]: k["id"] for k in kinds}
concepts = []
n_ev = 0
for n in concept_nodes:
    cid = n["dcterms:identifier"]
    iri = n["@id"]
    check_iri = iri == CONCEPTS + cid
    if not check_iri:
        failures.append(f"concept IRI {iri} is not built from its identifier")
    d = by_id[n["gs:activeDefinition"]["@id"]]
    ev = []
    for e in aslist(d.get("gs:evidence")):
        rec = {"s": src_index[e["dcterms:source"]["@id"]], "r": "d" if e["gs:evidenceRelation"] == "direct" else "s",
               "c": clean(e.get("gs:citationDetail")), "u": e.get("schema:url")}
        if e.get("gs:pdfPage") is not None:
            rec["p"] = e["gs:pdfPage"]
        if e.get("gs:pdfPrintedPage") is not None:
            rec["pp"] = e["gs:pdfPrintedPage"]
        if e.get("gs:host"):
            rec["h"] = e["gs:host"]
        if e.get("gs:adaptationNotice"):
            rec["an"] = clean(e["gs:adaptationNotice"])
        if e.get("gs:adaptationDisclaimer"):
            rec["ad"] = clean(e["gs:adaptationDisclaimer"])
        ev.append(rec)
    n_ev += len(ev)
    primary_field = local(n["gs:fieldCollection"]["@id"], I2IDL + "collections/field/")
    type_id = local(n["gs:typeCollection"]["@id"], I2IDL + "collections/type/")
    fields = sorted(set(field_of.get(cid, [])), key=lambda f: (f != primary_field, f))
    # kind: from the materialized decorations (the rule output), cross-checked against the type mapping
    deco_kinds = [KIND_CLASS[str(t)] for t in deco.objects(URIRef(iri), RDF.type) if str(t) in KIND_CLASS]
    kind = kind_of_type[type_id]
    if deco_kinds != [kind]:
        failures.append(f"kind of {cid}: decorations say {deco_kinds}, type mapping says {kind}")
    prov = "g" if any(e["r"] == "d" for e in ev) else "s"
    deco_prov = {str(t) for t in deco.objects(URIRef(d["@id"]), RDF.type)}
    want = NS + ("SourceGroundedDefinition" if prov == "g" else "SynthesizedDefinition")
    if want not in deco_prov:
        failures.append(f"provenance of {cid}: computed {prov}, decorations say {sorted(deco_prov)}")
    if clean(n["skos:definition"]) != clean(d["rdf:value"]):
        failures.append(f"definition text of {cid} differs from its active definition")
    concepts.append({
        "id": cid, "l": n["skos:prefLabel"], "a": aslist(n.get("skos:altLabel")),
        "d": clean(n["skos:definition"]), "x": clean(n.get("gs:editorialExplanation")),
        "st": n.get("gs:editorialStatus"), "t": type_id, "f": fields, "pf": primary_field,
        "cu": sorted(curated_of.get(cid, [])), "k": kind, "pv": prov,
        "b": sorted(local(x, CONCEPTS) for x in ids(n.get("skos:broader"))),
        "n": sorted(local(x, CONCEPTS) for x in ids(n.get("skos:narrower"))),
        "r": sorted(local(x, CONCEPTS) for x in ids(n.get("skos:related"))),
        "di": d["@id"], "ds": d.get("gs:editorialStatus"), "dq": d.get("gs:definitionSequence"),
        "dc": ids(d.get("dcterms:creator"))[0] if d.get("dcterms:creator") else None, "dl": d.get("dcterms:language"),
        "ev": ev,
    })
cidx = {c["id"]: i for i, c in enumerate(concepts)}
check(len(concepts) == 397, f"{len(concepts)} concepts extracted")
check(n_ev == 541, f"{n_ev} evidence records extracted")
check(all(c["pf"] in c["f"] for c in concepts), "every concept's primary field is among its field memberships")
check(not [f for f in failures if f.startswith(("kind of", "provenance of", "definition text", "concept IRI"))],
      "kinds and definition provenance agree with the materialized decorations")
for c in concepts:
    for rel in ("b", "n", "r"):
        for x in c[rel]:
            if x not in cidx:
                failures.append(f"{c['id']} {rel} → unknown {x}")

# Specifications and exemplars (asserted facts in the catalog)
for c in concepts:
    s = URIRef(CONCEPTS + c["id"])
    specs = sorted(str(o) for o in cat.objects(s, I2X.specification))
    exs = sorted(str(o) for o in cat.objects(s, I2X.exemplifiedBy))
    if specs:
        c["spec"] = specs
    if exs:
        c["exm"] = exs
check(sum(1 for c in concepts if c.get("spec")) == 9 and sum(1 for c in concepts if c.get("exm")) == 10,
      "9 specification links and 10 exemplars from the catalog")

# ── Decorated controls: the client derives the five per-concept targets; prove it here ──────────────
neigh_q = str(cat.value(CAT["q-concept-neighborhood"], I2X.sparql))


def controls_for(c) -> dict[str, str]:
    iri = "<" + CONCEPTS + c["id"] + ">"
    q = re.sub(r"\$concept\b", lambda _m: iri, neigh_q)
    return {"card": "https://www.i2idl.org/glossary#" + c["id"],
            "definition": c["di"] + ".ttl",
            "neighborhood": ENDPOINT + "?query=" + urllib.parse.quote(q, safe=""),
            "resolve": CONCEPTS + c["id"] + ".ttl",
            "resolve-json": CONCEPTS + c["id"] + ".jsonld"}


bad = 0
for c in concepts:
    want = controls_for(c)
    got = {}
    for a in deco.objects(URIRef(CONCEPTS + c["id"]), IEP.affordance):
        got[str(a).split("--", 1)[1]] = str(deco.value(a, HYDRA.target))
    if got != want:
        bad += 1
        if bad < 3:
            print("     control mismatch", c["id"], {k: (got.get(k), want[k]) for k in want if got.get(k) != want[k]})
check(bad == 0, "the client's control recipe reproduces all 1,985 decorated targets exactly")

# ── Actions (Foxxi manifest + relay operations) ────────────────────────────────────────────────────
actions = {}
for s in sorted(set(fx.subjects(RDF.type, IEP.Affordance)), key=str):
    a = str(fx.value(s, IEP.action))
    ex = fx.value(s, HYDRA.expects)
    inputs = []
    if ex is not None:
        for sp in fx.objects(ex, HYDRA.supportedProperty):
            prop = fx.value(sp, HYDRA.property)
            name = text(fx, prop, RDFS.label) if prop is not None else None
            dt_ = fx.value(sp, SH.datatype)
            inputs.append({"n": name or "?", "req": fx.value(sp, HYDRA.required) == Literal(True),
                           "c": text(fx, sp, RDFS.comment), "t": str(dt_).rsplit("#", 1)[-1] if dt_ is not None else None})
    inputs.sort(key=lambda i: (not i["req"], i["n"]))

    def hint(p):
        v = fx.value(s, p)
        return None if v is None else (v == Literal(True))
    vertical, aname = local(a, ACTION_ROOT).split("/", 1)
    actions[a] = {"sys": vertical, "n": aname, "t": text(fx, s, HYDRA.title),
                  "lb": text(fx, s, RDFS.label), "d": text(fx, s, RDFS.comment), "m": str(fx.value(s, HYDRA.method)),
                  "u": str(fx.value(s, HYDRA.target)), "mt": text(fx, s, DCAT.mediaType), "ro": hint(IEP.readOnlyHint),
                  "de": hint(IEP.destructiveHint), "ix": hint(IEP.idempotentHint), "xr": hint(IEP.externallyRouted),
                  "co": sorted(str(o) for o in fx.objects(s, IEP.appliesToCollection)), "in": inputs}
n_fx = len(actions)
for op in relay_ops:
    a = op["action"]
    name = local(a, ACTION_ROOT + "relay/")
    schema = relay_inputs.get(name) or {}
    req = set(schema.get("required", []))
    inputs = [{"n": k, "req": k in req, "c": clean(v.get("description"))[:280] if v.get("description") else None,
               "t": v.get("type") if isinstance(v.get("type"), str) else None}
              for k, v in (schema.get("properties") or {}).items()]
    inputs.sort(key=lambda i: (not i["req"], i["n"]))
    actions[a] = {"sys": "relay", "n": name, "t": clean(op.get("title")), "lb": clean(op.get("title")),
                  "d": clean(op.get("description")), "m": op.get("method"), "u": op.get("target"), "mt": "application/json",
                  "ro": None, "de": None, "ix": None, "xr": None, "co": [], "in": inputs, "cls": op.get("classification"),
                  "auth": any(h.get("hydra:headerName") == "Authorization" and h.get("hydra:required")
                              for h in op.get("hydra:expectsHeader", []))}
check((n_fx, len(actions) - n_fx) == (139, 51), f"{n_fx} bridge affordances and {len(actions) - n_fx} relay operations")
print("     bridge verticals:", dict(sorted(__import__("collections").Counter(v["sys"] for v in actions.values()).items())))

# ── Enactments, inheritance, role capabilities ─────────────────────────────────────────────────────
enact_src = (DIST / f"{SLUG['enactments']}.ttl").read_text()
enactments = []
for m in re.finditer(r"^en:([A-Za-z0-9_.-]+) a i2x:Enactment", enact_src, re.M):
    s = EN[m.group(1)]
    a = str(enact.value(s, I2X.viaAction))
    c = local(str(enact.value(s, I2X.enactedConcept)), CONCEPTS)
    enactments.append({"id": m.group(1), "c": c, "a": a, "r": local(str(enact.value(s, I2X.enactmentRole)), NS + "role-"),
                       "cf": float(enact.value(s, I2X.confidence)), "w": text(enact, s, I2X.rationale),
                       "s": local(str(enact.value(s, I2X.reviewStatus)), NS + "status-"),
                       "m": local(str(enact.value(s, I2X.mappingMethod)), NS + "method-")})
check(len(enactments) == 89 and all(e["a"] in actions and e["c"] in cidx for e in enactments),
      "89 enactments, every action in the live catalogs and every concept in the release")

ancestors: dict[str, list[str]] = {}


def ancestors_of(cid: str, seen=None) -> list[str]:
    seen = seen or set()
    out = []
    for b in concepts[cidx[cid]]["b"]:
        if b not in seen:
            seen.add(b)
            out.append(b)
            out += ancestors_of(b, seen)
    return out


direct = {(e["c"], e["a"]) for e in enactments}
inherited = []
for s, o in deco.subject_objects(I2X.inheritedEnactedBy):
    c = local(str(s), CONCEPTS)
    via = next((anc for anc in ancestors_of(c) if (anc, str(o)) in direct), None)
    inherited.append({"c": c, "a": str(o), "via": via})
inherited.sort(key=lambda r: (r["c"], r["a"]))
check(len(inherited) == 7 and all(r["via"] for r in inherited), "7 inherited enactments, each traced to the broader concept that enacts it")

role_caps = []
for m in re.finditer(r"^i2idl:([A-Za-z0-9-]+) i2x:roleCapability (fxa|rla):([A-Za-z0-9_-]+) \.\s+#\s*(.*)$", enact_src, re.M):
    role_caps.append({"c": m.group(1), "a": ACTION_ROOT + ("foxxi/" if m.group(2) == "fxa" else "relay/") + m.group(3),
                      "note": m.group(4).strip()})
check(len(role_caps) == 26 and all(r["a"] in actions for r in role_caps), "26 role capabilities, all live actions")

# ── Mapping proposals ──────────────────────────────────────────────────────────────────────────────
VOCABS = [("http://vocabularies.unesco.org/thesaurus/", "UNESCO Thesaurus"),
          ("https://w3id.org/xapi/profiles/ontology#", "xAPI Profiles"), ("https://w3id.org/xapi/ontology#", "xAPI"),
          ("https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#", "IEEE LER"),
          ("https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#", "ADL TLA"), ("https://schema.org/", "schema.org"),
          ("https://www.w3.org/2018/credentials#", "W3C VC"), ("https://markjspivey-xwisee.github.io/interego/ns/", "Interego")]
maps_src = (DIST / f"{SLUG['mappings']}.ttl").read_text()
mappings = []
for m in re.finditer(r"^mp:([A-Za-z0-9_.-]+) a i2x:MappingProposal", maps_src, re.M):
    s = MP[m.group(1)]
    obj = str(maps.value(s, I2X.proposedObject))
    term = ext_terms.get(obj) or {}
    od = term.get("definition")
    if od:
        od = re.sub(r"\[\[([^\]]+)\]\]", r"\1", od)
    rec = {"id": m.group(1), "c": local(str(maps.value(s, I2X.proposedSubject)), CONCEPTS),
           "p": str(maps.value(s, I2X.proposedPredicate)).rsplit("#", 1)[-1], "o": obj,
           "v": next(v for ns, v in VOCABS if obj.startswith(ns)), "ol": term.get("label"), "od": od,
           "cf": float(maps.value(s, I2X.confidence)), "w": text(maps, s, I2X.rationale),
           "s": local(str(maps.value(s, I2X.reviewStatus)), NS + "status-"),
           "m": local(str(maps.value(s, I2X.mappingMethod)), NS + "method-")}
    cited = maps.value(s, I2X.citedIn)
    if cited is not None:
        rec["ci"] = str(cited)
        rec["pg"] = str(maps.value(s, RDFS.seeAlso))
        rec["oa"] = term.get("alt") or []
        if term.get("noteKind"):
            rec["on"] = term["noteKind"]
    mappings.append(rec)
n_unesco = sum(1 for m in mappings if m["v"] == "UNESCO Thesaurus")
check(len(mappings) == 62 and all(m["c"] in cidx for m in mappings), "62 mapping proposals on concepts in the release")
check(n_unesco == 13 and all(m.get("ci") and m["m"] == "evidence-cited" for m in mappings if m["v"] == "UNESCO Thesaurus"),
      "13 UNESCO Thesaurus proposals, each citing the I2IDL definition whose evidence names its target")
check(all(any(c["concept"] == m["c"] and c["definition"] == m["ci"] for c in unesco["terms"][m["o"]]["citedBy"])
          for m in mappings if m.get("ci")), "every evidence-cited proposal's definition really cites its target (UNESCO snapshot)")
check(sum(1 for m in mappings if m["od"] and m["v"] != "UNESCO Thesaurus") >= 47,
      f"{sum(1 for m in mappings if m['od'] and m['v'] != 'UNESCO Thesaurus')} of 49 other targets carry their own vocabulary's definition; "
      f"{sum(1 for m in mappings if m['od'] and m['v'] == 'UNESCO Thesaurus')} of 13 UNESCO targets carry a scope note")

# ── Releases ───────────────────────────────────────────────────────────────────────────────────────
releases = []
for s in rels.subjects(RDF.type, I2X.GlossaryRelease):
    cmp_ = rels.value(s, RDFS.seeAlso)
    releases.append({"v": str(rels.value(s, I2X.releaseVersion)), "commit": str(rels.value(s, I2X.releaseCommit)),
                     "at": str(rels.value(s, PROV.generatedAtTime)), "n": int(rels.value(s, I2X.conceptCount)),
                     "rel": int(rels.value(s, I2X.relatedPairCount)), "br": int(rels.value(s, I2X.broaderPairCount)),
                     "add": sorted(local(str(o), CONCEPTS) for o in rels.objects(s, I2X.addedConcept)),
                     "rem": sorted(local(str(o), CONCEPTS) for o in rels.objects(s, I2X.removedConcept)),
                     "rev": sorted(local(str(o), CONCEPTS) for o in rels.objects(s, I2X.revisedDefinitionOf)),
                     "diff": str(cmp_) if cmp_ is not None else None, "note": text(rels, s, RDFS.comment)})
releases.sort(key=lambda r: tuple(int(x) for x in r["v"].lstrip("v").split(".")))
check(len(releases) == 17 and releases[-1]["v"] == release and releases[-1]["n"] == 397,
      "17 releases ending at the pinned release with 397 concepts")

# ── Change history: the same derivation (src/history.py) as the published i2idlx-changes graph ─────
hrels = hist.releases(cfg["i2idl"]["localClone"], cfg["i2idl"]["graphPath"])
check([h["version"] for h in hrels] == [r["v"] for r in releases], "change history covers exactly the releases in the release feed")
n_facts = sum(len(h["events"]) for h in hrels)
graph_facts = sum(int(o) for s in chg.subjects(RDF.type, I2X.ChangeEvent) for o in chg.objects(s, I2X.changeCount))
check(n_facts == graph_facts, f"{n_facts:,} fact-level changes, the same total the published change graph carries")
recon = hist.reconcile(hrels)
check(all(a == b for a, b in recon.values()), "history reconciles: baseline + additions − removals = this release, for every count")
change_kinds = [{"id": code, "label": label, "def": d} for code, label, d in hist.KINDS]
from collections import Counter
for r, h in zip(releases, hrels):
    tally = Counter(e["kind"] for e in h["events"])
    r["ch"] = {k: tally[k] for k in hist.KIND_CODES if tally[k]}
    r["nch"] = len(h["events"])
baseline = set(local(c, CONCEPTS) for c in hrels[0]["snap"]["concepts"])
for c in concepts:
    c["h0"] = 1 if c["id"] in baseline else 0
for ri, h in enumerate(hrels):
    if ri == 0:
        continue
    per: dict[str, dict] = {}
    for e in h["events"]:
        k = e["kind"]
        for iri in hist.touched(e):
            cid = local(iri, CONCEPTS)
            if cid not in cidx:
                continue
            rec = per.setdefault(cid, {})
            if k == "concept-added":
                rec["add"] = 1
            elif k == "concept-removed":
                rec["rem"] = 1
            elif k.startswith("relationship-"):
                other = local(e["b"] if iri == e["a"] else e["a"], CONCEPTS)
                if e["property"] == "skos:related":
                    key = "r"
                else:  # (a narrower, b broader): a gained a broader, b gained a narrower
                    key = "b" if iri == e["a"] else "n"
                key += "+" if k.endswith("added") else "-"
                if other in cidx:
                    rec.setdefault(key, []).append(cidx[other])
            elif k.startswith("membership-"):
                rec.setdefault("m" + ("+" if k.endswith("added") else "-"), []).append(e["collection"].split("/collections/")[1])
            elif k in ("evidence-added", "evidence-removed"):
                key = "e" + ("+" if k.endswith("added") else "-")
                rec[key] = rec.get(key, 0) + 1
            elif k == "evidence-classified":
                rec.setdefault("ec", {})
                rec["ec"][e["new"]] = rec["ec"].get(e["new"], 0) + 1
            elif k == "evidence-reclassified":
                src = src_index.get(e["source"])
                rec.setdefault("er", []).append([e.get("prior"), e["new"], src])
            elif k.startswith("alt-label"):
                rec.setdefault("al" + ("+" if k.endswith("added") else "-"), []).append(e.get("new") or e.get("prior"))
            else:  # scalar: label, definition, explanation, type, field, status
                rec.setdefault("s", {})[k] = [e.get("prior"), e.get("new")]
    for cid, rec in per.items():
        concepts[cidx[cid]].setdefault("h", []).append([ri, rec])
n_hist = sum(len(c.get("h", [])) for c in concepts)
check(n_hist > 0 and all(c["h0"] or any("add" in r for _, r in c.get("h", [])) for c in concepts),
      f"every concept is either in the baseline {hrels[0]['version']} or has an 'added' event; {n_hist} concept-release history rows")
changes_meta = {"baseline": hrels[0]["version"], "baselineDate": hrels[0]["date"], "facts": n_facts,
                "events": sum(1 for _ in chg.subjects(RDF.type, I2X.ChangeEvent)),
                "releaseChanges": sum(1 for _ in chg.subjects(RDF.type, I2X.ReleaseChange)),
                "withChanges": sum(1 for h in hrels[1:] if h["events"]),
                "byKind": {k: n for k, n in Counter(e["kind"] for h in hrels for e in h["events"]).items()},
                "reconcile": {k: v[1] for k, v in recon.items()}, "baselineCounts": hist.totals(hrels[0]["snap"])}
print("     history:", changes_meta["byKind"])

# ── I2IDL's own roadmap, read from its README at the pinned commit (credited, not paraphrased) ─────
readme = subprocess.run(["git", "-C", cfg["i2idl"]["localClone"], "show", f"{commit_sha}:README.md"],
                        capture_output=True, text=True, check=True).stdout
phases = []
for mm in re.finditer(r"^### Phase (\d+): (.+?)\n+\*\*(.+?)\*\*", readme, re.M):
    phases.append({"n": int(mm.group(1)), "title": mm.group(2).strip(), "status": mm.group(3).strip().rstrip(".")})
prio_block = readme.split("## Next development priorities", 1)[1].split("\n## ", 1)[0]
priorities = []
for mm in re.finditer(r"^### (\d+)\. (.+)$", prio_block, re.M):
    priorities.append({"n": int(mm.group(1)), "title": mm.group(2).strip(),
                       "anchor": re.sub(r"[^a-z0-9 -]", "", (mm.group(1) + ". " + mm.group(2)).lower()).replace(" ", "-")})
principle = " ".join(readme.split("## Development principle", 1)[1].split("\n## ", 1)[0].split())
principle = re.sub(r"`([^`]+)`", r"\1", principle)
routes = re.findall(r"^(/api/[^\s]+)$", prio_block, re.M)
prov_lines = re.findall(r"^Definition provenance: (.+)$", prio_block, re.M)
check(len(phases) == 7 and len(priorities) == 4 and len(routes) == 3 and len(prov_lines) == 2,
      f"I2IDL's README at {commit_sha[:7]}: {len(phases)} phases, {len(priorities)} next priorities, {len(routes)} example API routes, {len(prov_lines)} provenance wordings")
check(prov_lines == ["Direct source definition", "I2IDL synthesis supported by source evidence"],
      "the app's provenance wording is I2IDL's own: " + " / ".join(prov_lines))
upstream = {"phases": phases, "priorities": priorities, "principle": principle, "routes": routes, "provenance": prov_lines,
            "readme": f"{cfg['i2idl']['repo']}/blob/{commit_sha}/README.md"}

# ── UNESCO microthesaurus groups I2IDL cites (a group is not a concept: no mapping predicate applies) ─
unesco_groups = []
for c in concepts:
    mts = [e for e in c["ev"] if e.get("u") and re.search(r"vocabularies\.unesco\.org/unesco/en/page/mt[\d.]+$", e["u"])]
    concs = [e for e in c["ev"] if e.get("u") and re.search(r"vocabularies\.unesco\.org/unesco/en/page/concept\d+$", e["u"])]
    for e in mts:
        unesco_groups.append({"c": c["id"], "page": e["u"], "cite": e["c"], "only": not concs})
check(sum(1 for g in unesco_groups if g["only"]) == 3, f"{len(unesco_groups)} UNESCO microthesaurus citations; 3 concepts cite only a group")
unesco_meta = {"scheme": unesco["scheme"], "fetchedAt": unesco["fetchedAt"], "groups": unesco_groups}

# ── Catalog: ports, templates, stored queries, limits ──────────────────────────────────────────────
cat_src = (DIST / f"{SLUG['catalog']}.ttl").read_text()
listing = re.search(r"iep:affordance(.*?);\s*\n\s*rdfs:seeAlso", cat_src, re.S).group(1)
order = re.findall(r"cat:([A-Za-z0-9_-]+)", listing)


def shape_props(shape) -> list[dict]:
    out = []
    for p in cat.objects(shape, SH.property):
        out.append({"n": text(cat, p, SH.name) or str(cat.value(p, SH.path)).rsplit("#", 1)[-1],
                    "req": (cat.value(p, SH.minCount) or Literal(0)).toPython() >= 1,
                    "c": text(cat, p, SH.description), "def": text(cat, p, SH.defaultValue),
                    "pat": text(cat, p, SH.pattern), "max": (cat.value(p, SH.maxLength) or Literal(0)).toPython() or None})
    out.sort(key=lambda r: (not r["req"], r["n"]))
    return out


ports = []
for name in order:
    s = CAT[name]
    tmpl = cat.value(s, I2X.targetTemplate)
    exp = cat.value(s, HYDRA.expects)
    rec = {"id": name, "label": text(cat, s, RDFS.label), "title": text(cat, s, HYDRA.title),
           "desc": text(cat, s, HYDRA.description), "action": str(cat.value(s, IEP.action)),
           "m": str(cat.value(s, HYDRA.method)), "mt": text(cat, s, DCAT.mediaType),
           "ro": cat.value(s, IEP.readOnlyHint) == Literal(True), "de": cat.value(s, IEP.destructiveHint) == Literal(True),
           "routed": cat.value(s, IEP.externallyRouted) == Literal(True)}
    if cat.value(s, HYDRA.target) is not None:
        rec["u"] = str(cat.value(s, HYDRA.target))
    if tmpl is not None:
        rec["tpl"] = str(cat.value(tmpl, HYDRA.template))
        rec["vars"] = [{"v": str(cat.value(mp, HYDRA.variable)), "p": str(cat.value(mp, HYDRA.property))}
                       for mp in cat.objects(tmpl, HYDRA.mapping)]
    if exp is not None:
        rec["expects"] = {"id": str(exp).rsplit("#", 1)[-1], "label": text(cat, exp, RDFS.label),
                          "note": text(cat, exp, RDFS.comment), "props": shape_props(exp)}
    if cat.value(s, I2X.delegatesTo) is not None:
        rec["via"] = str(cat.value(s, I2X.delegatesTo))
    cap = cat.value(s, I2X.requiresCapability)
    if cap is not None:
        rec["cap"] = str(cap).rsplit("#", 1)[-1]
    ports.append(rec)
check(len(ports) == 23 and {"port-change-history", "port-vocabulary", "port-alignments", "port-referents", "port-publish-classified"} <= {p["id"] for p in ports},
      "23 catalog controls in catalog order, including the change history and the semantic layer")

SAMPLES = {
    "concept-neighborhood": {"concept": "learning-record-store-lrs"},
    "concept-search": {"text": "record store"},
    "definition-evidence": {"concept": "data-privacy"},
    "collection-members": {"collection": "curated/competency-and-assessment"},
    "field-intersection": {"fieldA": "field/learning-engineering", "fieldB": "field/learning-sciences"},
    "concepts-by-type": {"type": "type/standard"},
    "multi-field-concepts": {},
    "provenance-profile": {},
    "release-check": {"version": release},
    "classify": {},
    "concept-referents": {"concept": "formative-assessment"},
}
queries = []
for m in re.finditer(r"^cat:(q-[A-Za-z0-9-]+) a i2x:StoredQuery", cat_src, re.M):
    s = CAT[m.group(1)]
    sparql = str(cat.value(s, I2X.sparql))
    params = sorted({str(p) for p in cat.objects(s, I2X.parameter)}, key=lambda p: sparql.find("$" + p))
    name = m.group(1)[2:]
    over = sorted(str(o).rsplit("#", 1)[-1] for o in cat.objects(s, I2X.runsOver))
    q = {"id": m.group(1), "name": name, "label": text(cat, s, RDFS.label), "desc": text(cat, s, DCT.description),
         "form": str(cat.value(s, I2X.queryForm)), "sparql": sparql, "params": params, "sample": SAMPLES[name]}
    if over:
        q["over"] = over
    queries.append(q)
check(len(queries) == 11 and sum(1 for q in queries if q.get("over")) == 2, "11 stored queries, 2 of them client-side over the semantic-layer ports")

lim = cat.value(None, RDF.type, I2X.ServiceLimits) if False else next(cat.subjects(RDF.type, I2X.ServiceLimits))
limits = {}
for p, o in cat.predicate_objects(lim):
    if p == RDF.type:
        continue
    key = str(p).rsplit("#", 1)[-1].rsplit("/", 1)[-1]
    v = o.toPython() if isinstance(o, Literal) else str(o)
    if isinstance(v, dt.timedelta):
        key, v = key + "Seconds", int(v.total_seconds())
    limits.setdefault(key, []).append(v)
limits = {k: (v[0] if len(v) == 1 else sorted(v)) for k, v in limits.items()}
print("     limits:", limits)

# ── Graphs as published ────────────────────────────────────────────────────────────────────────────
GRAPH_TITLES = {"ontology": "Ontology", "shapes": "Shapes", "rules": "Rules", "catalog": "Agent catalog",
                "enactments": "Enactments", "mappings": "Mapping proposals", "releases": "Release feed",
                "changes": "Change history", "alignments": "Alignments", "referents": "Referents"}
graphs = []
pub_by_slug = {r["graph"]: r for r in published["graphs"]}
unpublished = [k for k in GRAPH_TITLES if SLUG[k] not in pub_by_slug]
check(not unpublished or os.environ.get("I2IDLX_ALLOW_UNPUBLISHED") == "1",
      "every graph the app links is published" + (f" (not yet: {', '.join(unpublished)})" if unpublished else ""))
for key in ["catalog", "ontology", "shapes", "rules", "enactments", "mappings", "releases", "changes", "alignments", "referents"]:
    r = pub_by_slug.get(SLUG[key], {"modalStatus": None, "descriptor": None, "contentHash": None})
    graphs.append({"key": key, "slug": SLUG[key], "iri": IRI[key], "title": GRAPH_TITLES[key], "status": r["modalStatus"],
                   "descriptor": r["descriptor"], "hash": r["contentHash"], "validFrom": r.get("validFrom"),
                   "triples": len(ttl(key))})

# ── Mentions: definitions as hypertext, and unlinked mentions as editorial suggestions ─────────────
# A label links where it appears as a whole word. Single-word labels link only between concepts I2IDL
# already relates (a bare "activity" or "actor" is too often the everyday word); multi-word labels and
# acronym-style alternate labels link anywhere, and those unlinked appearances become suggestions.


def surface_forms(c) -> list[tuple[str, bool]]:
    out = [(c["l"], len(c["l"].split()) > 1 or bool(re.search(r"[A-Z].*[A-Z]|[0-9]", c["l"])))]
    m = re.match(r"^(.*?)\s*\(([^)]+)\)$", c["l"])  # "Learning Record Store (LRS)" → "Learning Record Store", "LRS"
    if m:
        out.append((m.group(1), len(m.group(1).split()) > 1))
        out.append((m.group(2), bool(re.search(r"[A-Z].*[A-Z]|[0-9]", m.group(2)))))
    for a in c["a"]:
        acronym = bool(re.fullmatch(r"[A-Za-z0-9-]*[A-Z][A-Za-z0-9-]*[A-Z0-9][A-Za-z0-9-]*", a)) and len(a) >= 2
        out.append((a, len(a.split()) > 1 or acronym))
    seen, uniq = set(), []
    for form, strong in out:
        k = form.lower()
        if len(form) >= 2 and k not in seen:
            seen.add(k)
            uniq.append((form, strong))
    return uniq


claims: dict[str, list[tuple[str, bool, bool]]] = {}  # lowercased form → [(concept, strong, from_label)]
for c in concepts:
    label_forms = {f.lower() for f, _ in surface_forms({"l": c["l"], "a": []})}
    for form, strong in surface_forms(c):
        claims.setdefault(form.lower(), []).append((c["id"], strong, form.lower() in label_forms))
forms = []  # (pattern, form, target, strong)
ambiguous = []
for c in concepts:
    for form, strong in surface_forms(c):
        owners = claims[form.lower()]
        if len(owners) > 1:
            # A shared surface form links to the concept whose own label carries it — the shortest such
            # label when several do ("xAPI" → Experience API (xAPI), not the IEEE standard's title).
            by_label = sorted((o for o in owners if o[2]), key=lambda o: (len(concepts[cidx[o[0]]]["l"]), o[0]))
            if not by_label or by_label[0][0] != c["id"]:
                ambiguous.append(form)
                continue
        case = re.search(r"[A-Z].*[A-Z]", form) and len(form) <= 6  # short acronyms match case-sensitively
        pat = re.compile(r"(?<![\w-])" + re.escape(form) + r"(?![\w-])", 0 if case else re.I)
        forms.append((pat, form, c["id"], strong))
forms.sort(key=lambda f: -len(f[1]))
print(f"     {len(set(a.lower() for a in ambiguous))} ambiguous surface forms left unlinked: {sorted(set(ambiguous))[:12]}")


def find_mentions(textv: str, self_id: str, linked: set[str]):
    spans, taken = [], [False] * len(textv)
    for pat, form, target, strong in forms:
        if target == self_id or (not strong and target not in linked):
            continue
        for mm in pat.finditer(textv):
            a, b = mm.span()
            if any(taken[a:b]):
                continue
            for i in range(a, b):
                taken[i] = True
            spans.append([a, b, cidx[target]])
            break  # first occurrence of each surface form is enough
    spans.sort()
    # one link per target per text
    seen, out = set(), []
    for sp in spans:
        if sp[2] not in seen:
            seen.add(sp[2])
            out.append(sp)
    return out


suggestions = []
for c in concepts:
    linked = set(c["b"]) | set(c["n"]) | set(c["r"])
    for field in ("d", "x"):
        spans = find_mentions(c[field] or "", c["id"], linked)
        if spans:
            c["m" + field] = spans
        for a, b, t in spans:
            tid = concepts[t]["id"]
            if tid not in linked:
                suggestions.append({"a": c["id"], "b": tid, "in": field, "at": [a, b]})
uniq_s, seen = [], set()
for s in suggestions:
    if (s["a"], s["b"]) not in seen:
        seen.add((s["a"], s["b"]))
        uniq_s.append(s)
suggestions = uniq_s
annotate_forms = []
for pat, form, target, strong in forms:
    annotate_forms.append([form, cidx[target], 1 if strong else 0, 0 if pat.flags & re.I else 1])
n_links = sum(len(c.get("md", [])) + len(c.get("mx", [])) for c in concepts)
print(f"     {n_links} in-text links; {len(suggestions)} unlinked mentions between {len({s['a'] for s in suggestions})} concepts")
check(n_links > 0, "definitions and explanations are hypertext")

# ── What's whose: the origin labels, from the same source the published ontology uses ──────────────
otext = (ROOT / "src" / "origins.json").read_text()
for k, v in {"{nTypes}": len(collections["type"]), "{nFields}": len(collections["field"]),
             "{nCurated}": len(collections["curated"]), "{nSources}": len(sources)}.items():
    otext = otext.replace(k, str(v))
origin_src = json.loads(otext)
where_tokens = {"{release}": release, "{commit7}": commit_sha[:7], "{base}": BASE.removeprefix("https://"),
                "{foxxi}": cfg["foxxiManifest"].removeprefix("https://")}


def fill(s: str) -> str:
    for k, v in where_tokens.items():
        s = s.replace(k, v)
    assert "{" not in s, f"unfilled token in origin wording: {s}"
    return s


origins = [{"id": o["id"], "label": o["label"], "group": o["group"], "what": o["what"], "trust": o["trust"],
            "where": fill(o["where"])} for o in origin_src["origins"]]
og = Graph().parse(ROOT / "dist" / f"{SLUG['ontology']}.ttl", format="turtle")
published_origins = {}
for n in og.subjects(SKOS.inScheme, URIRef(NS + "Origins")):
    published_origins[str(og.value(n, SKOS.notation))] = (
        str(og.value(n, SKOS.prefLabel)), str(og.value(n, SKOS.definition)), str(og.value(n, SKOS.scopeNote)))
check(all(o["id"] in published_origins and published_origins[o["id"]][0] == o["label"]
          and published_origins[o["id"]][1] == (src.get("definition") or o["what"])
          and published_origins[o["id"]][2] == (src.get("scope") or o["trust"])
          for o, src in zip(origins, origin_src["origins"])),
      f"the {len(origins)} origin labels and their wording are the ontology's What's whose scheme (i2x:Origins)")

# ── Semantic layer: what each concept classifies, aligned to upper ontologies and peer vocabularies ───
# Read from the published graphs (ontology section L, i2idlx-alignments, i2idlx-referents) and the build's
# reasoning record (dist/semantic-layer.json); src/semantic.py only supplies order, grouping and vocabulary names.
sspec = importlib.util.spec_from_file_location("semantic", ROOT / "src" / "semantic.py")
SEMM = importlib.util.module_from_spec(sspec)
sspec.loader.exec_module(SEMM)
al_g, ref_g = ttl("alignments"), ttl("referents")
semj = json.loads((DIST / "semantic-layer.json").read_text())
PFX = dict(SEMM.PREFIXES) | {"i2x": NS, "i2idl": CONCEPTS}
OWL_ON, OWL_HAS = OWL.onProperty, OWL.hasValue


def curie(iri: str) -> str:
    best = max(((p, b) for p, b in PFX.items() if iri.startswith(b)), key=lambda pb: len(pb[1]), default=None)
    return f"{best[0]}:{iri[len(best[1]):]}" if best else iri


def restriction(g: Graph, node, prop) -> URIRef | None:
    """The owl:hasValue of a restriction on prop, or None."""
    if g.value(node, OWL_ON) == prop:
        return g.value(node, OWL_HAS)
    return None


cat_nodes = {str(onto.value(n, SKOS.notation)): n for n in onto.subjects(SKOS.inScheme, I2X.ReferentCategories)}
check(set(cat_nodes) == {c["id"] for c in SEMM.CATEGORIES}, f"{len(cat_nodes)} referent categories in the published ontology")
concept_level: dict[str, list[str]] = {}
for r, o in al_g.subject_objects(RDFS.subClassOf):
    v = restriction(al_g, r, I2X.referentCategory)
    if v is not None and isinstance(o, URIRef):
        concept_level.setdefault(str(onto.value(v, SKOS.notation)), []).append(curie(str(o)))
sem_cats = []
for c in SEMM.CATEGORIES:
    n = cat_nodes[c["id"]]
    cls = onto.value(n, I2X.referentClass)
    own = sorted(curie(str(o)) for o in al_g.objects(cls, RDFS.subClassOf) if isinstance(o, URIRef))
    if own != sorted(c.get("referent", [])):
        failures.append(f"category {c['id']}: published alignments {own} differ from src/semantic.py")
    sem_cats.append({"id": c["id"], "label": text(onto, n, SKOS.prefLabel), "def": text(onto, n, SKOS.definition),
                     "cls": curie(str(cls)), "parent": c.get("broader"), "group": c["group"],
                     "mode": str(onto.value(n, I2X.classificationMode)), "abstract": bool(c.get("abstract")),
                     "own": own, "cc": sorted(concept_level.get(c["id"], [])),
                     "ex": sorted(curie(str(o)) for o in al_g.objects(n, I2X.expressibleAs)),
                     "why": text(al_g, n, I2X.alignmentRationale), "role": bool(c.get("bearsRole"))})
check(all(sc["why"] and sc["label"] and sc["def"] for sc in sem_cats), "every category has a label, a definition and an alignment rationale")
# Every class a referent of each category joins, exactly as q-classify reaches it: referentClass/rdfs:subClassOf*
# over the vocabulary and the alignments (named classes only).
vocab_al = onto + al_g
for sc in sem_cats:
    start = URIRef(PFX["i2x"] + sc["cls"].split(":", 1)[1])
    sc["all"] = sorted(curie(str(x)) for x in vocab_al.transitive_objects(start, RDFS.subClassOf) if isinstance(x, URIRef))
cat_of_node = {n: k for k, n in cat_nodes.items()}
n_assigned = 0
for c in concepts:
    s = URIRef(CONCEPTS + c["id"])
    cat_node = ref_g.value(s, I2X.referentCategory)
    if cat_node is None:
        failures.append(f"{c['id']}: no referent category in i2idlx-referents")
        continue
    c["rc"] = cat_of_node[cat_node]
    c["rb"] = "t" if str(ref_g.value(s, I2X.assignmentBasis)) == "type" else "d"
    c["rw"] = text(ref_g, s, I2X.categoryRationale)
    n_assigned += 1
check(n_assigned == len(concepts), f"all {n_assigned} concepts carry their referent category, basis and reason")
bridges = []
prop_of = {}
for p in maps.subjects(RDF.type, I2X.MappingProposal):
    prop_of[(str(maps.value(p, I2X.proposedSubject)), str(maps.value(p, I2X.proposedObject)))] = str(p).rsplit("#", 1)[-1]
for t, r in al_g.subject_objects(OWL.equivalentClass):
    v = restriction(al_g, r, I2X.isClassifiedBy)
    if v is not None:
        bridges.append({"t": curie(str(t)), "c": local(str(v), CONCEPTS), "k": "exact"})
for a, b in al_g.subject_objects(RDFS.subClassOf):
    va, vb = restriction(al_g, a, I2X.isClassifiedBy), restriction(al_g, b, I2X.isClassifiedBy)
    if vb is not None and isinstance(a, URIRef):
        bridges.append({"t": curie(str(a)), "c": local(str(vb), CONCEPTS), "k": "narrow"})
    elif va is not None and isinstance(b, URIRef):
        bridges.append({"t": curie(str(b)), "c": local(str(va), CONCEPTS), "k": "broad"})
for br in bridges:
    br["m"] = prop_of.get((CONCEPTS + br["c"], PFX[br["t"].split(":")[0]] + br["t"].split(":", 1)[1]))
bridges.sort(key=lambda b: (b["c"], b["t"]))
check(len(bridges) == semj["bridges"] and all(b["m"] for b in bridges),
      f"{len(bridges)} crosswalk bridges, each traced to the mapping proposal it executes")
own_services = []
for s in sorted(set(ref_g.subjects(I2X.isClassifiedBy, None)), key=str):
    own_services.append({"iri": str(s), "types": sorted(curie(str(o)) for o in ref_g.objects(s, RDF.type)),
                         "by": sorted(local(str(o), CONCEPTS) for o in ref_g.objects(s, I2X.isClassifiedBy)),
                         "why": text(ref_g, s, RDFS.comment)})


def aligned(rows, with_peers=False) -> list[dict]:
    out = []
    for row in rows:
        subj, targets, why = row[0], row[1], row[2]
        have = sorted(curie(str(o)) for o in al_g.objects(URIRef(PFX[subj.split(":")[0]] + subj.split(":", 1)[1]), RDFS.subClassOf)
                      if isinstance(o, URIRef))
        if sorted(targets) != have:
            failures.append(f"{subj}: published alignment {have} differs from src/semantic.py {sorted(targets)}")
        rec = {"s": subj, "t": list(targets), "why": why}
        if with_peers and row[3]:
            rec["peers"] = list(row[3])
        out.append(rec)
    return out


sem_records, sem_interego, sem_foxxi = aligned(SEMM.RECORDS), aligned(SEMM.INTEREGO), aligned(SEMM.FOXXI, True)
check(not [f for f in failures if "published alignment" in f or f.startswith("category ")],
      f"records ({len(sem_records)}), Interego ({len(sem_interego)}) and Foxxi ({len(sem_foxxi)}) alignments are what i2idlx-alignments publishes")
sem_props = [{"s": s, "p": p, "o": o, "why": w} for s, p, o, w in SEMM.PROPERTIES]
vocabs = [{"p": v["prefix"], "col": v["column"], "kind": v["kind"], "title": v["title"], "short": v["short"], "home": v["home"],
           "ns": SEMM.PREFIXES[v["prefix"]]} for v in SEMM.VOCABS]
snap = json.loads((EV / "upper" / "manifest.json").read_text())
snapshots = [{"key": s["key"], "version": s.get("version"), "license": s.get("license"), "url": s["url"], "sha256": s.get("sha256"),
              "mode": s.get("mode"), "kept": s.get("kept"), "triples": s.get("triples")} for s in snap["sources"]]
EXAMPLE_TTL = (ROOT / "examples" / "industry-context.ttl").read_text()
CLASH_TTL = (ROOT / "examples" / "industry-context-clash.ttl").read_text()
semantic = {
    "columns": [{"id": k, "label": v} for k, v in SEMM.COLUMNS], "vocabs": vocabs, "categories": sem_cats, "prefixes": PFX,
    "bridges": bridges, "own": own_services, "records": sem_records, "interego": sem_interego, "foxxi": sem_foxxi,
    "props": sem_props, "labels": semj["labels"], "disjoint": semj["disjoint"], "snapshots": snapshots,
    "example": EXAMPLE_TTL, "clash": CLASH_TTL,
    "reasoning": {"owlrl": {k: semj["owlrl"][k] for k in ("input", "closed", "seconds")} | {"errors": len(semj["owlrl"]["errors"])},
                  "records": semj["records"], "conceptLevel": semj["conceptLevel"], "hermit": semj["hermit"],
                  "rules": semj["rules"], "classify": {k: semj["classify"][k] for k in ("typings", "sampleTypings", "sound", "complete")},
                  "classifyByResource": semj["classify"]["byResource"],
                  "disjointCheck": semj["disjointCheck"], "clash": semj["clash"]["rejectedBy"], "expected": semj["expected"],
                  "terms": semj["terms"], "byVocabulary": semj["byVocabulary"], "byBasis": semj["byBasis"]},
}
check(semantic["reasoning"]["classify"]["sound"] and semantic["reasoning"]["classify"]["complete"] and semantic["reasoning"]["rules"]["agree"]
      and semantic["reasoning"]["disjointCheck"]["agree"], "the build's reasoning record says q-classify, the SHACL rules and the disjointness table agree with OWL 2 RL")

# ── Meta ───────────────────────────────────────────────────────────────────────────────────────────
built = os.environ.get("I2IDLX_NOW") or dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()
data_license = (pathlib.Path(cfg["i2idl"]["localClone"]) / "DATA-LICENSE.md").read_text()
holder = re.search(r"^(©[^\n]+)$", data_license, re.M).group(1).strip()
meta = {
    "app": "Interpretant", "version": cfg["version"], "built": built,
    "release": release, "commit": commit_sha, "commitDate": commit_date, "repo": cfg["i2idl"]["repo"],
    "scheme": {"iri": I2IDL + "scheme", "title": scheme["dcterms:title"], "rights": clean(scheme.get("dcterms:rights")),
               "publisher": ids(scheme.get("dcterms:publisher"))[0], "profile": scheme.get("gs:semanticProfileVersion"),
               "status": scheme.get("gs:editorialStatus")},
    "license": {"holder": holder, "name": "CC BY 4.0", "url": "https://creativecommons.org/licenses/by/4.0/",
                "file": cfg["i2idl"]["repo"] + "/blob/" + commit_sha + "/DATA-LICENSE.md"},
    "endpoint": ENDPOINT, "human": "https://www.i2idl.org/glossary", "jsonld": "https://id.i2idl.org/glossary.jsonld",
    "ns": NS, "base": BASE, "iri": IRI, "shapes": SHAPES, "actionRoot": ACTION_ROOT,
    "foxxiManifest": cfg["foxxiManifest"], "relayOps": "https://relay.interego.xwisee.com/.well-known/operations",
    "graphs": graphs, "limits": limits,
    "counts": {"concepts": len(concepts), "evidence": n_ev, "sources": len(sources),
               "related": sum(len(c["r"]) for c in concepts) // 2, "broader": sum(len(c["b"]) for c in concepts),
               "altLabels": sum(len(c["a"]) for c in concepts), "enactments": len(enactments),
               "mappings": len(mappings), "roleCaps": len(role_caps), "inherited": len(inherited),
               "actions": len(actions), "releases": len(releases), "grounded": sum(1 for c in concepts if c["pv"] == "g"),
               "links": n_links, "suggestions": len(suggestions), "unesco": n_unesco},
    "neighborhoodQuery": neigh_q,
    "changes": changes_meta, "upstream": upstream, "unesco": unesco_meta, "origins": origins,
}

# ── A recorded orchestrated run (Orchestrate replays it; tools/check_orchestra.py proves it replays exactly) ──
RUN_FILE = ROOT / "examples" / "orchestra" / "kestrel-point-run.json"
orchestra = json.loads(RUN_FILE.read_text()) if RUN_FILE.exists() else None
if orchestra:
    kinds_ok = all(e.get("k") in ("step", "say", "call", "result", "decision") for e in orchestra["events"])
    check(kinds_ok and orchestra.get("v") == 1, f"recorded run: {len(orchestra['events'])} events of known kinds")

data = {"meta": meta, "kinds": kinds, "roles": roles, "statuses": statuses, "methods": methods,
        "interrogatives": interrogatives, "collections": collections, "sources": sources, "concepts": concepts,
        "actions": actions, "enactments": enactments, "inherited": inherited, "roleCaps": role_caps,
        "mappings": mappings, "releases": releases, "ports": ports, "queries": queries, "suggestions": suggestions,
        "changeKinds": change_kinds, "forms": annotate_forms, "semantic": semantic, "orchestra": orchestra}

(APP / "build").mkdir(parents=True, exist_ok=True)
out = APP / "build" / "data.json"
out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
print(f"     data.json {out.stat().st_size / 1e3:.0f} kB")

if failures:
    print("\nFAILURES:\n  " + "\n  ".join(failures[:40]))
    sys.exit(1)
if DATA_ONLY:
    sys.exit(0)

# ── 2. Map layout (deterministic, build time) ──────────────────────────────────────────────────────
NODE = os.environ.get("NODE", "node")
subprocess.run([NODE, str(APP / "tools" / "layout.mjs"), str(out), str(APP / "build" / "layout.json")], check=True, cwd=APP)
layout = json.loads((APP / "build" / "layout.json").read_text())
check(set(layout["xy"]) == {c["id"] for c in concepts}, "every concept has a place on the map")
data["layout"] = layout
out.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))

# ── 3. Bundle and assemble ─────────────────────────────────────────────────────────────────────────
bundle = APP / "build" / "app.js"
subprocess.run([str(APP / "node_modules" / ".bin" / "esbuild"), str(APP / "src" / "main.jsx"), "--bundle", "--format=iife",
                "--jsx-factory=React.createElement", "--jsx-fragment=React.Fragment", "--target=es2020", "--minify",
                "--legal-comments=none", "--log-level=warning", f"--outfile={bundle}"], check=True, cwd=APP)
css = (APP / "src" / "styles.css").read_text()
app_url = cfg.get("appArtifactUrl", "")


def inline_json(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/").replace("<!--", "<\\!--")


def inline_js(src: str) -> str:
    return src.replace("</script", "<\\/script")


CDN = ["https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js",
       "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js",
       "https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"]
FONTS = ("https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,500;0,6..72,600;1,6..72,400"
         "&family=Red+Hat+Display:wght@500;700;800&family=Red+Hat+Mono:wght@400;500&family=Red+Hat+Text:wght@400;500;600;700&display=swap")
page = f"""<title>Interpretant Glossary Workbench</title>
<meta name="description" content="A workbench for the I2IDL Digital Learning Glossary ({release}), decorated with the Interego and Foxxi layer I2IDL-X.">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="{FONTS}">
<style>
{css}
</style>
<div id="root"><noscript><p style="padding:24px;font-family:system-ui">Interpretant needs JavaScript. The glossary itself is at <a href="https://www.i2idl.org/glossary">i2idl.org/glossary</a>.</p></noscript></div>
<script type="application/json" id="i2-data">{inline_json(data)}</script>
<script>window.__APP_URL__ = {json.dumps(app_url)};</script>
{"".join(f'<script src="{u}" crossorigin="anonymous"></script>' + chr(10) for u in CDN)}<script>
{inline_js(bundle.read_text())}
</script>
"""
site = ROOT / "site" / "app.html"
site.write_text(page)
size = site.stat().st_size
check(size < 16_000_000, f"site/app.html is {size / 1e6:.2f} MB (limit 16 MB)")
if failures:
    print("\nFAILURES:\n  " + "\n  ".join(failures[:40]))
    sys.exit(1)
print(f"\nwrote {site} ({size / 1e3:.0f} kB)")
