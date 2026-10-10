"""Snapshot the upper ontologies and peer vocabularies I2IDL-X aligns to, so every aligned term is checked to
exist and the reasoner uses each publisher's own axioms.

    python3 -I tools/refresh_upper.py <i2idlx-root>

Writes evidence/upper/<key>.ttl, evidence/upper/manifest.json, evidence/peer-terms.json and the Interego
namespace files evidence/interego-*.ttl. Sources are pinned (a release tag, commit or versioned IRI wherever the
publisher offers one) and every file's SHA-256 is recorded. Small ontologies are kept whole; large ones are cut to
an upward module around the terms src/semantic.py uses: each term, its named superclasses and superproperties
(through intersections), the domains and ranges of its properties, and the disjointness axioms among them.
Credential Engine's servers refuse scripted downloads, so CTDL and CTDL-ASN terms are recorded from the published
class index as read on the date below.
"""
import datetime as dt
import hashlib
import importlib.util
import json
import pathlib
import re
import sys
import time
import urllib.request

import rdflib
from rdflib import BNode, Graph, URIRef
from rdflib.collection import Collection
from rdflib.namespace import OWL, RDF, RDFS

ROOT = pathlib.Path(sys.argv[1]).resolve()
OUT = ROOT / "evidence" / "upper"
spec = importlib.util.spec_from_file_location("semantic", ROOT / "src" / "semantic.py")
sem = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sem)
P = sem.PREFIXES
BFO = "http://purl.obolibrary.org/obo/BFO_"

SOURCES = [
    {"key": "bfo", "prefixes": ["obo:BFO_"], "whole": True, "format": "turtle", "license": "CC BY 4.0",
     "version": "BFO 2020 (ISO/IEC 21838-2:2021), BFO-ontology/BFO-2020 commit bd1fb61",
     "url": "https://raw.githubusercontent.com/BFO-ontology/BFO-2020/bd1fb61c5fa4e358fc9690f0d214b1ac63fae594/21838-2/owl/bfo-core.ttl"},
    {"key": "iao", "prefixes": ["obo:IAO_"], "format": "xml", "license": "CC BY 4.0", "exclude": [BFO],
     "version": "IAO 2026-03-30", "url": "http://purl.obolibrary.org/obo/iao/2026-03-30/iao.owl"},
    {"key": "cco", "prefixes": ["cco:"], "format": "turtle", "license": "BSD 3-Clause", "exclude": [BFO],
     "version": "CCO 2 merged, CommonCoreOntologies commit be13b74 (2026-08-13)",
     "url": "https://raw.githubusercontent.com/CommonCoreOntology/CommonCoreOntologies/be13b74cccf85617739c5288f9fdac805437386c/src/cco-merged/CommonCoreOntologiesMerged.ttl"},
    {"key": "gist", "prefixes": ["gist:"], "whole": True, "format": "turtle", "license": "CC BY 4.0",
     "version": "gist 14.1.0", "url": "https://raw.githubusercontent.com/semanticarts/gist/v14.1.0/ontologies/gistCore.ttl"},
    {"key": "dul", "prefixes": ["dul:"], "whole": True, "format": "turtle", "license": "CC BY 4.0",
     "version": "DOLCE+DnS Ultralite (as served)", "url": "http://www.ontologydesignpatterns.org/ont/dul/DUL.owl"},
    {"key": "gufo", "prefixes": ["gufo:"], "whole": True, "format": "turtle", "license": "CC BY 4.0",
     "version": "gUFO 1.0.0", "url": "https://purl.org/nemo/gufo", "accept": "text/turtle"},
    {"key": "prov", "prefixes": ["prov:"], "whole": True, "format": "turtle", "license": "W3C Document License",
     "version": "PROV-O (W3C Recommendation 2013-04-30)", "url": "https://www.w3.org/ns/prov-o", "accept": "text/turtle"},
    {"key": "schema", "prefixes": ["schema:"], "format": "turtle", "license": "CC BY-SA 3.0",
     "version": "schema.org 30.1", "url": "https://raw.githubusercontent.com/schemaorg/schemaorg/v30.1/data/releases/30.1/schemaorg-current-https.ttl"},
    {"key": "org", "prefixes": ["org:"], "whole": True, "format": "turtle", "license": "W3C Document License",
     "version": "W3C Organization Ontology (2014-01-16)", "url": "https://www.w3.org/ns/org", "accept": "text/turtle"},
    {"key": "dct", "prefixes": ["dct:"], "format": "turtle", "license": "CC BY 4.0",
     "version": "DCMI Metadata Terms (as served)", "url": "https://www.dublincore.org/specifications/dublin-core/dcmi-terms/dublin_core_terms.ttl"},
    {"key": "dcat", "prefixes": ["dcat:"], "format": "turtle", "license": "W3C Software and Document License",
     "version": "DCAT 3 (as served)", "url": "https://www.w3.org/ns/dcat.ttl"},
    {"key": "lrmi", "prefixes": ["lrmi:"], "whole": True, "format": "turtle", "license": "CC BY 4.0",
     "version": "LRMI DCMI terms (as served)", "url": "https://purl.org/dcx/lrmi-terms/", "accept": "text/turtle"},
    {"key": "esco", "prefixes": ["esco:"], "format": "xml", "license": "European Commission reuse policy (see ESCO)",
     "version": "ESCO model (as served)", "englishOnly": True, "url": "https://data.europa.eu/esco/model", "accept": "application/rdf+xml"},
    {"key": "elm", "prefixes": ["elm:"], "format": "xml", "license": "European Commission reuse policy (see Europass)",
     "version": "European Learning Model 3 (as served)", "englishOnly": True, "url": "http://data.europa.eu/snb/model/elm", "accept": "application/rdf+xml"},
    {"key": "asn", "prefixes": ["asn:"], "format": "xml", "license": "CC BY 4.0 (University of Washington)",
     "version": "ASN core schema (as served)", "url": "http://purl.org/ASN/schema/core/", "accept": "application/rdf+xml"},
]
INTEREGO = {"interego": "https://markjspivey-xwisee.github.io/interego/ns/interego.ttl",
            "hypragent": "https://markjspivey-xwisee.github.io/interego/ns/hypragent.ttl",
            "hyprcat": "https://markjspivey-xwisee.github.io/interego/ns/hyprcat.ttl",
            "harness": "https://markjspivey-xwisee.github.io/interego/ns/harness.ttl"}
CONTEXTS = [
    {"prefix": "ob3", "url": "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json", "title": "Open Badges 3.0 JSON-LD context"},
    {"prefix": "case", "url": "https://purl.imsglobal.org/spec/case/v1p0/context/imscasev1p0_context_v1p0.jsonld", "title": "CASE 1.0 JSON-LD context"},
]
# Read from the published class indexes on 2026-10-09 (the term pages and scripted downloads return 403).
CTDL_INDEX = {
    "checked": "2026-10-09",
    "source": {"ceterms": "https://purl.org/ctdl/terms", "ceasn": "https://purl.org/ctdlasn/terms"},
    "terms": {
        "ceterms:Credential": None, "ceterms:Occupation": None, "ceterms:Course": None, "ceterms:LearningProgram": None,
        "ceterms:AssessmentProfile": None, "ceterms:CredentialOrganization": None,
        "ceterms:WorkRole": "Collection of tasks and competencies that embody a particular function in one or more jobs.",
        "ceterms:Task": "Specific activity, typically related to performing a function or achieving a goal.",
        "ceterms:LearningOpportunity": "Structured and unstructured learning and development opportunities based in direct experience, formal and informal study…",
        "ceterms:Pathway": "Resource composed of a structured set of PathwayComponents defining points along a route to fulfillment of a goal or objective.",
        "ceasn:Competency": None, "ceasn:CompetencyFramework": None,
    },
}


def expand(curie: str) -> str:
    pfx, local = curie.split(":", 1)
    return P[pfx] + local


def fetch(url: str, accept: str | None = None) -> bytes:
    headers = {"User-Agent": "i2idlx-refresh-upper/0.3"}
    if accept:
        headers["Accept"] = accept
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as r:
                return r.read()
        except Exception:
            if attempt == 3:
                raise
            time.sleep(2 * (attempt + 1))


def referenced_terms() -> set[str]:
    """Every CURIE src/semantic.py uses (alignment targets, record subjects, properties)."""
    found = set()
    text = (ROOT / "src" / "semantic.py").read_text()
    for m in re.finditer(r'"((?:%s):[A-Za-z0-9_.-]+)"' % "|".join(re.escape(k) for k in P), text):
        found.add(m.group(1))
    return found


STRUCT_UP = {RDFS.subClassOf, OWL.equivalentClass, RDFS.subPropertyOf, OWL.equivalentProperty, OWL.inverseOf,
             RDFS.domain, RDFS.range}


def named_up(g: Graph, node, out: set) -> None:
    """Named classes/properties reachable upward from a class expression: the node itself, or the named operands
    of an intersection. Restriction fillers and union operands are kept as axioms but not followed."""
    if isinstance(node, URIRef):
        out.add(node)
    elif isinstance(node, BNode):
        inter = g.value(node, OWL.intersectionOf)
        if inter is not None:
            for x in Collection(g, inter):
                named_up(g, x, out)


def copy_node(g: Graph, keep: Graph, s) -> None:
    for p, o in g.predicate_objects(s):
        if p == OWL.imports:
            continue
        keep.add((s, p, o))
        if isinstance(o, BNode):
            copy_node(g, keep, o)


def module(g: Graph, seeds: set[URIRef], exclude: list[str]) -> tuple[Graph, set]:
    keep, seen, queue = Graph(), set(), list(seeds)
    while queue:
        s = queue.pop()
        if s in seen:
            continue
        seen.add(s)
        if any(str(s).startswith(x) for x in exclude):
            continue
        copy_node(g, keep, s)
        nxt: set = set()
        for p in STRUCT_UP:
            for o in g.objects(s, p):
                named_up(g, o, nxt)
        queue.extend(n for n in nxt if n not in seen)
    for a, b in g.subject_objects(OWL.disjointWith):
        if a in seen and b in seen:
            keep.add((a, OWL.disjointWith, b))
    for adc in g.subjects(RDF.type, OWL.AllDisjointClasses):
        members = list(Collection(g, g.value(adc, OWL.members)))
        if sum(1 for m in members if m in seen) >= 2:
            copy_node(g, keep, adc)
    for ont in g.subjects(RDF.type, OWL.Ontology):
        copy_node(g, keep, ont)
    for pfx, ns in g.namespaces():
        keep.bind(pfx, ns)
    return keep, seen


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    terms = referenced_terms()
    manifest = {"fetchedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(), "sources": []}
    for src in SOURCES:
        raw = fetch(src["url"], src.get("accept"))
        g = Graph().parse(data=raw, format=src["format"])
        seeds = {URIRef(expand(t)) for t in terms if any(t.startswith(p) for p in src["prefixes"])}
        missing = sorted(str(s) for s in seeds if (s, None, None) not in g)
        if src.get("whole"):
            keep = Graph()
            for t in g:
                if t[1] != OWL.imports:
                    keep.add(t)
            for pfx, ns in g.namespaces():
                keep.bind(pfx, ns)
        else:
            keep, _ = module(g, seeds, src.get("exclude", []))
        if src.get("englishOnly"):  # multilingual vocabularies: keep English and untagged literals
            for t in [t for t in keep if isinstance(t[2], rdflib.Literal) and t[2].language and not t[2].language.startswith("en")]:
                keep.remove(t)
        path = OUT / f"{src['key']}.ttl"
        path.write_text(f"# Snapshot of {src['url']}\n# {src['version']} — {src['license']}\n" + keep.serialize(format="turtle"))
        manifest["sources"].append({
            "key": src["key"], "url": src["url"], "version": src["version"], "license": src["license"],
            "sha256": hashlib.sha256(raw).hexdigest(), "triples": len(g), "kept": len(keep),
            "mode": "whole" if src.get("whole") else "upward module", "seeds": len(seeds), "missing": missing,
            "file": f"evidence/upper/{path.name}"})
        print(f"{src['key']:<7} {len(g):>7} → {len(keep):>6} triples   seeds {len(seeds):>3}   missing {missing}")
    for name, url in INTEREGO.items():
        raw = fetch(url)
        Graph().parse(data=raw, format="turtle")
        (ROOT / "evidence" / f"interego-{name}.ttl").write_bytes(raw)
        manifest["sources"].append({"key": f"interego-{name}", "url": url, "sha256": hashlib.sha256(raw).hexdigest(),
                                    "file": f"evidence/interego-{name}.ttl", "mode": "whole"})
        print(f"interego-{name}: {len(raw):,} bytes")
    peers = {"checked": manifest["fetchedAt"][:10], "terms": {}}
    for ctx in CONTEXTS:
        raw = fetch(ctx["url"])
        data = json.loads(raw)["@context"]
        prefix_ns = P[ctx["prefix"]]

        def walk(c, out):
            for k, v in c.items():
                iri = v if isinstance(v, str) else (v.get("@id") if isinstance(v, dict) else None)
                if isinstance(iri, str):
                    if iri.startswith(ctx["prefix"] + ":"):
                        iri = prefix_ns + iri.split(":", 1)[1]
                    elif ":" in iri and iri.split(":", 1)[0] in c and isinstance(c[iri.split(":", 1)[0]], str):
                        iri = c[iri.split(":", 1)[0]] + iri.split(":", 1)[1]
                    if iri.startswith(prefix_ns):
                        out.setdefault(iri, {"label": k, "source": ctx["url"], "method": "JSON-LD context"})
                if isinstance(v, dict) and isinstance(v.get("@context"), dict):
                    walk(v["@context"], out)
        found: dict = {}
        walk(data, found)
        peers["terms"].update(found)
        manifest["sources"].append({"key": ctx["prefix"], "url": ctx["url"], "sha256": hashlib.sha256(raw).hexdigest(),
                                    "mode": "context terms", "terms": len(found)})
        print(f"{ctx['prefix']}: {len(found)} context terms")
    for curie, definition in CTDL_INDEX["terms"].items():
        pfx = curie.split(":")[0]
        peers["terms"][expand(curie)] = {"label": curie.split(":")[1], "definition": definition,
                                         "source": CTDL_INDEX["source"][pfx], "method": f"class index, read {CTDL_INDEX['checked']}"}
    (ROOT / "evidence" / "peer-terms.json").write_text(json.dumps(peers, indent=2, sort_keys=True) + "\n")
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    unknown = []
    for t in sorted(terms):
        iri = expand(t)
        pfx = t.split(":")[0]
        if pfx in {"ceterms", "ceasn", "ob3", "case"} and iri not in peers["terms"]:
            unknown.append(t)
    print("peer terms not found:", unknown or "none")


if __name__ == "__main__":
    main()
