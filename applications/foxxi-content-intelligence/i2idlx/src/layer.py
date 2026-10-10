"""Render the I2IDL-X semantic layer from src/semantic.py, and reason over it.

  ontology_section()  → Turtle for the ontology's section L (classification vocabulary, referent categories)
  alignments_ttl()    → graph i2idlx-alignments: categories, records, properties, Interego and Foxxi aligned to
                         upper ontologies and peers, plus OWL bridges derived from the crosswalk proposals
  referents_ttl()     → graph i2idlx-referents: each I2IDL concept's referent category, with the reason, and
                         I2IDL's own services classified by I2IDL's own concepts
  tbox()              → every snapshot the reasoner needs (evidence/upper, Interego, Foxxi, xAPI)
  closure()           → OWL 2 RL closure (owlrl) with the inconsistencies it found
"""
import importlib.util
import json
import pathlib

import rdflib
from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import OWL, RDF, RDFS

I2IDL = "https://id.i2idl.org/concepts/"
BFO_BEARER_OF, BFO_ROLE = "obo:BFO_0000196", "obo:BFO_0000023"
TBOX_FILES = ["xapi-ontology.ttl", "xapi-profile-ontology.ttl", "ns_ieee-ler.ttl", "ns_adl-tla.ttl", "iep.ttl",
              "interego-interego.ttl", "interego-hypragent.ttl", "interego-hyprcat.ttl", "interego-harness.ttl"]


def load_semantic(root: pathlib.Path):
    spec = importlib.util.spec_from_file_location("semantic", root / "src" / "semantic.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def lit(s: str) -> str:
    return '"' + s.replace("\\", "\\\\").replace('"', '\\"').replace("\n", "\\n") + '"'


class Layer:
    def __init__(self, root: pathlib.Path, ns: str, iri: dict, concepts: dict, mappings: list, release: str, commit: str):
        """concepts: I2IDL concept id → {'iri', 'type'}; mappings: crosswalk rows (concept, predicate, target, conf, method, why)."""
        self.root, self.ns, self.iri, self.concepts = root, ns, iri, concepts
        self.sem = load_semantic(root)
        self.mappings, self.release, self.commit = mappings, release, commit
        self.cat = {c["id"]: c for c in self.sem.CATEGORIES}
        self.prefixes = dict(self.sem.PREFIXES) | {"i2x": ns, "i2idl": I2IDL}

    # ── helpers ──────────────────────────────────────────────────────────────────────────────────────
    def expand(self, curie: str) -> str:
        if curie.startswith("http"):
            return curie
        pfx, local = curie.split(":", 1)
        return self.prefixes[pfx] + local

    def qn(self, curie_or_iri: str) -> str:
        """A Turtle term: CURIEs whose local part Turtle accepts stay CURIEs, everything else becomes <IRI>."""
        if curie_or_iri.startswith("http"):
            return f"<{curie_or_iri}>"
        pfx, local = curie_or_iri.split(":", 1)
        if all(ch.isalnum() or ch in "_-" for ch in local) and not local[0].isdigit() or pfx == "obo":
            return curie_or_iri
        return f"<{self.expand(curie_or_iri)}>"

    def ancestors(self, cid: str) -> list[str]:
        out, cur = [], self.cat[cid].get("broader")
        while cur:
            out.append(cur)
            cur = self.cat[cur].get("broader")
        return out

    def referent_classes(self, cid: str, inherited: bool = True) -> list[str]:
        """External classes a referent of this category joins, own first, then inherited."""
        out = list(self.cat[cid].get("referent", []))
        if inherited:
            for a in self.ancestors(cid):
                out += [c for c in self.cat[a].get("referent", []) if c not in out]
        return out

    def concept_classes(self, cid: str) -> list[str]:
        out = list(self.cat[cid].get("concept", []))
        for a in self.ancestors(cid):
            out += [c for c in self.cat[a].get("concept", []) if c not in out]
        return out

    def assignments(self) -> dict:
        """concept id → (category id, why, basis) for every concept in the release."""
        out = {}
        for cid, c in sorted(self.concepts.items()):
            if cid in self.sem.CONCEPT_CATEGORY:
                cat, why = self.sem.CONCEPT_CATEGORY[cid]
                out[cid] = (cat, why, "definition")
            elif c["type"] in self.sem.TYPE_DEFAULT:
                out[cid] = (self.sem.TYPE_DEFAULT[c["type"]], self.sem.TYPE_DEFAULT_WHY[c["type"]], "type")
            else:
                raise ValueError(f"{cid}: no referent category (type {c['type']})")
        return out

    def class_bridges(self, class_targets: set[str]) -> list[tuple]:
        """OWL bridges from crosswalk proposals whose target is a class: (target, axiom, concept, row)."""
        out = []
        for row in self.mappings:
            cid, pred, target = row[0], row[1], row[2]
            if target not in class_targets or pred in ("closeMatch", "relatedMatch"):
                continue
            out.append((target, pred, cid, row))
        return out

    # ── ontology section L ───────────────────────────────────────────────────────────────────────────
    def ontology_section(self) -> str:
        lines = []
        tops = [c["id"] for c in self.sem.CATEGORIES if not c.get("broader")]
        lines.append("i2x:ReferentCategories skos:hasTopConcept " + " , ".join(f"i2x:category-{t}" for t in tops) + " .")
        for c in self.sem.CATEGORIES:
            place = (f"skos:broader i2x:category-{c['broader']}" if c.get("broader") else "skos:topConceptOf i2x:ReferentCategories")
            parent = f"i2x:{self.cat[c['broader']]['cls']}" if c.get("broader") else "i2x:Referent"
            mode = c.get("mode", "classify")
            lines.append(
                f"i2x:category-{c['id']} a skos:Concept ; skos:inScheme i2x:ReferentCategories ; {place} ;\n"
                f"    skos:notation {lit(c['id'])} ; skos:prefLabel {lit(c['label'])}@en ;\n"
                f"    skos:definition {lit(c['definition'])}@en ;\n"
                f"    i2x:referentClass i2x:{c['cls']} ; i2x:classificationMode {lit(mode)} .")
            lines.append(
                f"i2x:{c['cls']} a owl:Class ; rdfs:subClassOf {parent} ;\n"
                f"    rdfs:label {lit(c['label'] + ' (referent)')}@en ;\n"
                f"    rdfs:comment {lit('Anything an I2IDL concept in the referent category “' + c['label'] + '” classifies.')}@en .")
            lines.append(
                f"[ a owl:Restriction ; owl:onProperty i2x:isClassifiedBy ;\n"
                f"  owl:someValuesFrom [ a owl:Restriction ; owl:onProperty i2x:referentCategory ; owl:hasValue i2x:category-{c['id']} ] ]\n"
                f"    rdfs:subClassOf i2x:{c['cls']} .")
        return "\n".join(lines)

    # ── graph i2idlx-alignments ──────────────────────────────────────────────────────────────────────
    def alignments_ttl(self, now: str, class_targets: set[str], mapping_iri) -> str:
        S = self.sem
        out = [self._prefixes(), "",
               "# ══════════════════════════════════════════════════════════════════════════════",
               "#  I2IDL-X alignments — the semantic layer's TBox bridges. Each referent category,",
               "#  each kind of I2IDL record, and the Interego and Foxxi vocabularies are aligned to",
               "#  BFO 2020 (with IAO and CCO), gist, DOLCE-UltraLite, gUFO, PROV-O, schema.org and",
               "#  peer learning vocabularies. Proposals: published Hypothetical; a reasoner using",
               "#  them reaches Hypothetical conclusions. Rationale is on each subject.",
               "# ══════════════════════════════════════════════════════════════════════════════", "",
               f"<{self.iri['alignments']}> a owl:Ontology ;",
               f"    dct:title {lit('I2IDL-X alignments to upper ontologies and peer vocabularies')}@en ;",
               f"    dct:description {lit('Bridge axioms that let any data classified by I2IDL concepts be typed in BFO 2020 (IAO, CCO), gist, DOLCE-UltraLite, gUFO, PROV-O and schema.org, and line I2IDL, I2IDL-X, Interego and Foxxi up with CTDL, CTDL-ASN, ESCO, ELM, LRMI, ASN, Open Badges, CASE and xAPI.')}@en ;",
               f"    dct:conformsTo <{self.iri['shapes']}> ;",
               f"    owl:imports <{self.iri['ontology']}> ;",
               f"    prov:wasDerivedFrom <{self.iri['ontology']}> , <{mapping_iri}> ;",
               f"    prov:generatedAtTime \"{now}\"^^xsd:dateTime ;",
               f"    rdfs:seeAlso <{self.iri['referents']}> ;",
               f"    rdfs:comment {lit('Upper ontologies and peer vocabularies are referenced, not copied: each term was checked against a pinned snapshot of its publisher’s file. Reasoning over these axioms (OWL 2 RL or a DL reasoner) types I2IDL’s records and any data that uses i2x:isClassifiedBy.')}@en .", ""]
        out.append("# ── Referent categories → upper ontologies and peers ─────────────────────────────")
        for c in S.CATEGORIES:
            own = c.get("referent", [])
            parts = []
            if own:
                parts.append("rdfs:subClassOf " + " , ".join(self.qn(t) for t in own))
            if c.get("bearsRole"):
                parts.append(f"rdfs:subClassOf [ a owl:Restriction ; owl:onProperty {BFO_BEARER_OF} ; owl:someValuesFrom {BFO_ROLE} ]")
            if parts:
                out.append(f"i2x:{c['cls']} " + " ;\n    ".join(parts) + " .")
            notes = [f"i2x:alignmentRationale {lit(c['why'])}@en"]
            if c.get("expressible"):
                notes.append("i2x:expressibleAs " + " , ".join(self.qn(t) for t in c["expressible"]))
            out.append(f"i2x:category-{c['id']} " + " ;\n    ".join(notes) + " .")
            if self.concept_classes(c["id"]):
                out.append(f"[ a owl:Restriction ; owl:onProperty i2x:referentCategory ; owl:hasValue i2x:category-{c['id']} ]\n"
                           f"    rdfs:subClassOf " + " , ".join(self.qn(t) for t in self.concept_classes(c["id"])) + " .")
        out.append("")
        out.append("# ── What I2IDL's records are ──────────────────────────────────────────────────────")
        for subj, targets, why in S.RECORDS:
            out.append(f"{self.qn(subj)} rdfs:subClassOf " + " , ".join(self.qn(t) for t in targets) + " ;\n"
                       f"    i2x:alignmentRationale {lit(why)}@en .")
        out.append("")
        out.append("# ── Classification and aboutness relations ─────────────────────────────────────────")
        for subj, pred, obj, why in S.PROPERTIES:
            out.append(f"{self.qn(subj)} {pred} {self.qn(obj)} .  # {why}")
        out.append("")
        out.append("# ── Interego ───────────────────────────────────────────────────────────────────────")
        for subj, targets, why in S.INTEREGO:
            out.append(f"{self.qn(subj)} rdfs:subClassOf " + " , ".join(self.qn(t) for t in targets) + " ;\n"
                       f"    i2x:alignmentRationale {lit(why)}@en .")
        out.append("")
        out.append("# ── Foxxi (IEEE LER and ADL TLA vocabularies on the Foxxi bridge) ───────────────────")
        for subj, targets, why, peers in S.FOXXI:
            body = f"{self.qn(subj)} rdfs:subClassOf " + " , ".join(self.qn(t) for t in targets)
            if peers:
                body += " ;\n    skos:closeMatch " + " , ".join(self.qn(p) for p in peers)
            out.append(body + f" ;\n    i2x:alignmentRationale {lit(why)}@en .")
        out.append("")
        out.append("# ── Crosswalk proposals made executable ───────────────────────────────────────────")
        out.append("#  A proposal that maps an I2IDL concept to a *class* becomes an OWL bridge through")
        out.append("#  i2x:isClassifiedBy: exactMatch ≡, broadMatch (class is broader) ⊒, narrowMatch")
        out.append("#  (class is narrower) ⊑. closeMatch and relatedMatch stay SKOS: they license no typing.")
        for target, pred, cid, row in self.class_bridges(class_targets):
            restr = f"[ a owl:Restriction ; owl:onProperty i2x:isClassifiedBy ; owl:hasValue i2idl:{cid} ]"
            if pred == "exactMatch":
                out.append(f"{self.qn(target)} owl:equivalentClass {restr} .")
            elif pred == "narrowMatch":
                out.append(f"{self.qn(target)} rdfs:subClassOf {restr} .")
            elif pred == "broadMatch":
                out.append(f"{restr} rdfs:subClassOf {self.qn(target)} .")
        return "\n".join(out) + "\n"

    # ── graph i2idlx-referents ───────────────────────────────────────────────────────────────────────
    def referents_ttl(self, now: str) -> str:
        S = self.sem
        assign = self.assignments()
        counts = {}
        for cat, _, _ in assign.values():
            counts[cat] = counts.get(cat, 0) + 1
        out = [self._prefixes(), "",
               "# ══════════════════════════════════════════════════════════════════════════════",
               f"#  I2IDL-X referents — what each I2IDL {self.release} concept classifies. One",
               "#  referent category per concept (see i2x:ReferentCategories); the reason is either",
               "#  I2IDL's own type collection or the concept's definition. Proposals: published",
               "#  Hypothetical, reviewable one by one.",
               "# ══════════════════════════════════════════════════════════════════════════════", "",
               f"<{self.iri['referents']}> a owl:Ontology ;",
               f"    dct:title {lit('What I2IDL concepts classify (derived and proposed)')}@en ;",
               f"    dct:description {lit(f'The referent category of every concept in I2IDL {self.release}, so data classified by an I2IDL concept can be typed in upper ontologies and peer vocabularies through i2idlx-alignments.')}@en ;",
               f"    dct:conformsTo <{self.iri['shapes']}> ;",
               f"    owl:imports <{self.iri['alignments']}> ;",
               f"    i2x:builtAgainstRelease {lit(self.release)} ;",
               f"    prov:wasDerivedFrom <https://github.com/blakeplock/i2idl-linked-data/blob/{self.commit}/public/glossary.jsonld> ;",
               f"    prov:generatedAtTime \"{now}\"^^xsd:dateTime ;",
               f"    rdfs:comment {lit('Category counts: ' + ', '.join(f'{self.cat[k]["label"]} {v}' for k, v in sorted(counts.items(), key=lambda kv: -kv[1])) + '.')}@en .", ""]
        out.append("# ── I2IDL classifying the services that publish it ─────────────────────────────────")
        for iri, types, classified_by, why in S.INDIVIDUALS:
            parts = []
            if types:
                parts.append("a " + " , ".join(self.qn(t) for t in types))
            parts.append("i2x:isClassifiedBy " + " , ".join(f"i2idl:{c}" for c in classified_by))
            parts.append(f"rdfs:comment {lit(why)}@en")
            out.append(f"<{iri}> " + " ;\n    ".join(parts) + " .")
        out.append("")
        out.append("# ── Referent category of every concept ─────────────────────────────────────────────")
        for cid, (cat, why, basis) in assign.items():
            out.append(f"i2idl:{cid} i2x:referentCategory i2x:category-{cat} ; i2x:categoryRationale {lit(why)}@en ; i2x:assignmentBasis {lit(basis)} .")
        return "\n".join(out) + "\n"

    def _prefixes(self) -> str:
        keep = ["i2x", "i2idl", "obo", "cco", "gist", "dul", "gufo", "prov", "schema", "org", "dct", "dcat", "lrmi", "asn",
                "esco", "elm", "ceterms", "ceasn", "ob3", "case", "cred", "xapi", "xprof", "ler", "tla", "iep", "ie", "ieh",
                "hyprcat", "hypragent", "skos", "gs"]
        rows = [f"@prefix {p + ':':<11}<{self.prefixes[p]}> ." for p in keep]
        rows += ["@prefix owl:       <http://www.w3.org/2002/07/owl#> .",
                 "@prefix rdfs:      <http://www.w3.org/2000/01/rdf-schema#> .",
                 "@prefix xsd:       <http://www.w3.org/2001/XMLSchema#> ."]
        return "\n".join(rows)


# ── Reasoning ────────────────────────────────────────────────────────────────────────────────────────
def tbox(root: pathlib.Path) -> Graph:
    g = Graph()
    for f in sorted((root / "evidence" / "upper").glob("*.ttl")):
        g.parse(f, format="turtle")
    for name in TBOX_FILES:
        g.parse(root / "evidence" / name, format="turtle")
    return g


def snapshot_terms(root: pathlib.Path) -> set[str]:
    """Every IRI that a snapshot defines or describes (subjects), plus peer terms read from contexts and indexes."""
    terms = set()
    g = tbox(root)
    terms |= {str(s) for s in g.subjects() if isinstance(s, URIRef)}
    peers = json.loads((root / "evidence" / "peer-terms.json").read_text())["terms"]
    terms |= set(peers)
    return terms


def closure(data: Graph) -> tuple[Graph, list[str]]:
    """OWL 2 RL closure. Returns the closed graph and the inconsistencies owlrl reported."""
    import owlrl
    g = Graph()
    for t in data:
        g.add(t)
    closure_obj = owlrl.DeductiveClosure(owlrl.OWLRL_Semantics, rdfs_closure=False, axiomatic_triples=False,
                                         datatype_axioms=False)
    closure_obj.expand(g)
    from owlrl.Namespaces import ERRNS
    errors = sorted(str(m) for e in g.subjects(RDF.type, ERRNS.ErrorMessage) for m in g.objects(e, ERRNS.error))
    errors += [f"{s} is owl:Nothing" for s in g.subjects(RDF.type, OWL.Nothing)]
    return g, errors


OWL2_DATATYPES = {f"http://www.w3.org/2001/XMLSchema#{d}" for d in (
    "decimal integer nonNegativeInteger nonPositiveInteger positiveInteger negativeInteger long int short byte "
    "unsignedLong unsignedInt unsignedShort unsignedByte double float string normalizedString token language Name "
    "NCName NMTOKEN boolean hexBinary base64Binary anyURI dateTime dateTimeStamp").split()} | {
    "http://www.w3.org/2002/07/owl#real", "http://www.w3.org/2002/07/owl#rational",
    "http://www.w3.org/1999/02/22-rdf-syntax-ns#PlainLiteral", "http://www.w3.org/1999/02/22-rdf-syntax-ns#XMLLiteral",
    "http://www.w3.org/2000/01/rdf-schema#Literal"}
DATA_RANGE_PREDICATES = {OWL.allValuesFrom, OWL.someValuesFrom, OWL.onDataRange, RDFS.range, OWL.onDatatype}


def dl_ready(g: Graph) -> Graph:
    """A copy a DL reasoner (HermiT) accepts: annotations and data values on named resources are dropped (they do
    not bear on consistency of the class axioms), and datatypes outside the OWL 2 datatype map are widened to
    rdfs:Literal. owl:imports are dropped so the reasoner never fetches."""
    out = Graph()
    xsd = "http://www.w3.org/2001/XMLSchema#"
    for s, p, o in g:
        if p == OWL.imports:
            continue
        if isinstance(o, Literal):
            if not isinstance(s, BNode):
                continue
            if o.datatype is not None and str(o.datatype) not in OWL2_DATATYPES:
                o = Literal(str(o))
            elif o.language:
                o = Literal(str(o))
        elif p in DATA_RANGE_PREDICATES and isinstance(o, URIRef) and (str(o).startswith(xsd) or str(o).endswith("#langString")) \
                and str(o) not in OWL2_DATATYPES:
            o = RDFS.Literal
        out.add((s, p, o))
    return out


def hermit(g: Graph, workdir: pathlib.Path, memory_mb: int = 3000, timeout: int = 600) -> tuple[bool | None, float, str]:
    """OWL 2 DL consistency with HermiT (the copy bundled with owlready2), run as HermiT's own command line with
    -k: is owl:Thing satisfiable? That is the consistency question, without classifying or realizing everything
    (which takes minutes on DOLCE-UltraLite and adds nothing to it). Returns (consistent, seconds, detail);
    consistent is None when HermiT could not answer within the timeout."""
    import subprocess
    import time
    import owlready2
    workdir.mkdir(parents=True, exist_ok=True)
    path = workdir / "reasoning-input.nt"
    dl_ready(g).serialize(path, format="nt", encoding="utf-8")
    hdir = pathlib.Path(owlready2.__file__).parent / "hermit"
    cmd = [owlready2.JAVA_EXE, f"-Xmx{memory_mb}M", "-cp", f"{hdir}:{hdir / 'HermiT.jar'}",
           "org.semanticweb.HermiT.cli.CommandLine", "-k", path.resolve().as_uri()]
    t0 = time.time()
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, time.time() - t0, f"no answer within {timeout} s"
    secs = time.time() - t0
    text = out.stdout + out.stderr
    if "InconsistentOntologyException" in text:
        return False, secs, "inconsistent"
    if out.returncode == 0 and "owl#Thing is satisfiable" in text:
        return True, secs, "consistent"
    lines = [l for l in text.splitlines() if l.strip() and not l.startswith("Picked up JAVA_TOOL_OPTIONS")]
    raise RuntimeError("HermiT: " + " | ".join(lines[:3])[:300])
