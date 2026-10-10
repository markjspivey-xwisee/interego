"""Cross-check the app's client logic against the graphs.

python3 -I tools/check_app_logic.py <i2idlx-root>

1. The client's per-concept control recipe (data.js controlsFor) reproduces every materialized target in
   the decorations graph.
2. Each stored query evaluated by the client (queries.js runLocal) returns what rdflib returns for the same
   bound SPARQL over the pinned glossary.
3. Exports the smoke test saved parse, and the governed-write records conform to the I2IDL-X shapes.
"""
import csv
import io
import json
import os
import pathlib
import subprocess
import sys

from pyshacl import validate
from rdflib import Graph, URIRef
from rdflib.namespace import RDF, SKOS

ROOT = pathlib.Path(sys.argv[1]).resolve()
APP = ROOT / "app"
cfg = json.loads((ROOT / "config.json").read_text())
# Machine-specific paths: an environment variable wins; a relative path is read from the package root.
for _keys, _env in ((("i2idl", "localClone"), "I2IDL_CLONE"), (("interegoCoreSrc",), "INTEREGO_CORE_SRC"), (("tsx",), "INTEREGO_TSX")):
    _holder = cfg
    for _k in _keys[:-1]:
        _holder = _holder[_k]
    _v = os.environ.get(_env) or _holder.get(_keys[-1], "")
    _holder[_keys[-1]] = str((ROOT / _v).resolve()) if _v and not os.path.isabs(_v) else _v
failures = []


def check(ok, what):
    print(("PASS " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


subprocess.run([str(APP / "node_modules/.bin/esbuild"), "tools/check_entry.js", "--bundle", "--platform=node", "--format=cjs",
                "--outfile=build/check.cjs", "--log-level=warning",
                "--banner:js=globalThis.document={getElementById:()=>({textContent:require('fs').readFileSync(process.argv[2],'utf8')})};globalThis.window={};"],
               cwd=APP, check=True)
out = json.loads(subprocess.run(["node", "build/check.cjs", "build/data.json"], cwd=APP, check=True, capture_output=True, text=True).stdout)

# 0. annotation and the editorial packet
data = json.loads((APP / "build" / "data.json").read_text())
labels = {c["id"]: c["l"] for c in data["concepts"]}
whole = [cid for cid, spans in out["selfMatch"].items() if len(spans) == 1 and spans[0][0] == 0 and spans[0][1] == len(labels[cid])]
own = [cid for cid in whole if out["selfMatch"][cid][0][2] == cid]
shared = {f.lower() for c in data["concepts"] for f in [c["l"]] if sum(1 for d in data["concepts"] if d["l"].lower() == f.lower() or f.lower() in (a.lower() for a in d["a"])) > 1}
check(len(own) >= len(labels) - len(shared) - 2, f"Annotate finds {len(own)} of {len(labels)} concepts from their own label as one whole-label span ({len(shared)} labels are shared with another concept)")
check({"learning-record-store-lrs", "experience-api-xapi"} <= set(out["example"]) or "learning-record-store-lrs" in out["example"], f"Annotate's example sentence finds {out['example']}")
pk = out["packet"]
sec = lambda title: pk.split(title, 1)[1].split("\n## ", 1)[0] if title in pk else ""
unesco_rows = [l for l in sec("## 1. UNESCO Thesaurus crosswalk candidates").splitlines() if l.startswith("| [")]
other_rows = [l for l in sec("## 2. Other crosswalk candidates").splitlines() if l.startswith("| [")]
change_rows = [l for l in sec("## 4. Change history").splitlines() if l.startswith("| v")]
todo = [l for l in sec("## 5. Unlinked mentions").splitlines() if l.startswith("- [ ]")]
n_mentions = sum(l.count("(in the ") for l in todo)
check(len(unesco_rows) == 13 and len(other_rows) == len(data["mappings"]) - 13,
      f"editorial packet: {len(unesco_rows)} UNESCO rows and {len(other_rows)} other crosswalk rows")
check(len(change_rows) == len(data["releases"]) - 1 and n_mentions == len(data["suggestions"]) and len(todo) == len({s["a"] for s in data["suggestions"]}),
      f"editorial packet: {len(change_rows)} release rows, {n_mentions} unlinked mentions as {len(todo)} checklist items")
check(data["meta"]["commit"][:7] in pk and "not affiliated with or endorsed by I2IDL" in pk and "CC BY-SA 3.0 IGO" in pk,
      "editorial packet names the pinned commit, the independence statement and UNESCO's licence")
(APP / "build" / "editorial-packet.md").write_text(pk)

# 1. controls
deco = Graph().parse(ROOT / "dist" / f"{cfg['slugs']['decorations']}.ttl", format="turtle")
IEP = "https://markjspivey-xwisee.github.io/interego/ns/iep#"
HYDRA = "http://www.w3.org/ns/hydra/core#"
bad = 0
for cid, ctl in out["controls"].items():
    got = {str(a).split("--", 1)[1]: str(deco.value(a, URIRef(HYDRA + "target"))) for a in deco.objects(URIRef("https://id.i2idl.org/concepts/" + cid), URIRef(IEP + "affordance"))}
    if got != ctl:
        bad += 1
check(bad == 0 and len(out["controls"]) == 397, f"client controls match all {len(out['controls']) * 5} materialized targets ({bad} concepts differ)")

# 2. stored queries
gl = Graph().parse(pathlib.Path(cfg["i2idl"]["localClone"]) / cfg["i2idl"]["graphPath"], format="json-ld", base="https://id.i2idl.org/")
short = lambda v: str(v).replace("https://id.i2idl.org/concepts/", "")
# client-side queries run over what their ports return (vocabulary, alignments, referents) plus the sample data
over = Graph()
for key in ("ontology", "alignments", "referents"):
    over.parse(ROOT / "dist" / f"{cfg['slugs'][key]}.ttl", format="turtle")
sample_g = Graph().parse(ROOT / "examples" / "industry-context.ttl", format="turtle")
over += sample_g
SAMPLE_SUBJECTS = {str(s) for s in sample_g.subjects()}  # the referents graph also classifies I2IDL's own services
PFX = sorted(data["semantic"]["prefixes"].items(), key=lambda kv: -len(kv[1]))


def curie(iri: str) -> str:
    return next((f"{p}:{iri[len(ns):]}" for p, ns in PFX if iri.startswith(ns) and len(iri) > len(ns)), iri)


qmeta = {q["name"]: q for q in data["queries"]}
for name, q in out["queries"].items():
    if qmeta[name].get("over"):
        res = over.query(q["sparql"])
        local = q["result"]
        if res.type == "CONSTRUCT":
            want = sorted([str(s), curie(str(o))] for s, o in res.graph.subject_objects(RDF.type) if str(s) in SAMPLE_SUBJECTS)
            have = sorted([str(a), str(b)] for a, b in local["rows"])
            check(want == have, f"{name}: the client's classifier reaches exactly what the stored query reaches ({len(have)} typings over the sample organization)")
        else:
            want = [[str(r[v]) for v in res.vars] for r in res]
            have = [[str(x) for x in r] for r in local["rows"]]
            check(want == have and len(have) > 0, f"{name}: {len(have)} rows agree, in order, over the semantic-layer graphs")
        continue
    res = gl.query(q["sparql"])
    local = q["result"]
    if res.type == "ASK":
        check(bool(res.askAnswer) == local["ask"], f"{name}: ASK agrees ({res.askAnswer})")
        continue
    if res.type == "CONSTRUCT":
        g = res.graph
        if name == "concept-neighborhood":
            want = sorted((p.split("#")[1], short(o)) for s, p, o in g if str(p) in (str(SKOS.broader), str(SKOS.narrower), str(SKOS.related)))
            have = sorted((r[0].split(":")[1], r[1]) for r in local["rows"] if r[0] != "skos:prefLabel")
            check(want == have, f"{name}: {len(have)} neighbors agree")
        else:
            GS = "https://glossarystudio.app/ns/"
            want = sorted(str(o) for s, p, o in g if str(p) == GS + "citationDetail")
            have = sorted(r[2] for r in local["rows"] if r[2])
            check(want == have, f"{name}: {len(have)} evidence citations agree")
        continue
    cols = [str(v) for v in res.vars]
    rows = [[short(r[v]) if r[v] is not None else "" for v in res.vars] for r in res]
    have = [[str(x) for x in r] for r in local["rows"]]
    want = [[str(x) for x in r] for r in rows]
    check(want == have, f"{name}: {len(have)} rows agree, in order ({', '.join(cols)})")

# 2b. the semantic-layer playground
sem = out["semantic"]
semj = json.loads((ROOT / "dist" / "semantic-layer.json").read_text())
ex = sem["example"]
check({r["iri"]: sorted(r["classes"]) for r in ex["resources"]} == {k: v for k, v in semj["classify"]["byResource"].items() if k in SAMPLE_SUBJECTS},
      f"playground: the sample organization's {len(ex['resources'])} resources get exactly the classes the build's q-classify run gave them ({ex['typings']} typings)")
check(ex["clashes"] == 0 and all(not r["problems"] for r in ex["resources"]), "playground: no clash or problem in the sample organization")
cl = sem["clash"]
check(cl["clashes"] == 1 and cl["resources"][0]["clashes"][0]["on"] == sorted(semj["clash"]["rejectedBy"]),
      f"playground: the clash example is flagged under exactly the ontologies OWL 2 RL and HermiT reject it in ({', '.join(semj['clash']['rejectedBy'])})")
edge = {r["iri"].rsplit("/", 1)[-1]: r for r in sem["edge"]["resources"]}
check(edge["a"]["notes"] == ["subject"] and edge["b"]["problems"] == ["unknown"] and edge["c"]["problems"] == ["literal"]
      and edge["d"]["clashes"] and edge["d"]["clashes"][0]["on"],
      "playground: a discipline used as a type is flagged as a subject, unknown concepts and literals are refused, and an LRS that is also a teacher clashes")
check("error" in sem["bad"], "playground: unparseable Turtle is reported, not guessed at")

# 3. exports and governed writes
shapes = Graph().parse(ROOT / "dist" / f"{cfg['slugs']['shapes']}.ttl", format="turtle")
onto = Graph().parse(ROOT / "dist" / f"{cfg['slugs']['ontology']}.ttl", format="turtle")
samples_dir = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else APP / "build"
samples = json.loads((samples_dir / "export-samples.json").read_text())
for fn, body in samples.items():
    if fn.endswith(".jsonld.json"):
        g = Graph().parse(data=body, format="json-ld")
        members = list(g.objects(None, SKOS.member))
        check(len(members) >= 1 and all(str(m).startswith("https://id.i2idl.org/concepts/") for m in members), f"{fn}: JSON-LD collection of I2IDL IRIs ({len(members)})")
    elif fn.endswith(".csv"):
        rows = list(csv.reader(io.StringIO(body)))
        check(rows[0][0] == "term" and len(rows) >= 2 and all(len(r) == len(rows[0]) for r in rows), f"{fn}: CSV with {len(rows) - 1} rows")
    elif fn.endswith(".ttl.txt"):
        g = Graph().parse(data=body, format="turtle")
        ok, _, report = validate(g, shacl_graph=shapes, ont_graph=onto, inference="none")
        check(ok and len(list(g.subjects(RDF.type, None))) >= 1, f"{fn}: Turtle conforms to the I2IDL-X shapes")
    elif fn.endswith("-xapi-tags.json"):
        x = json.loads(body)
        ids = x["contextExtensions"]["https://foxxi-bridge.interego.xwisee.com/ns/foxxi#conceptIds"]
        check(all(i.startswith("https://id.i2idl.org/concepts/") for i in ids), f"{fn}: conceptIds are I2IDL IRIs")
ledger = (samples_dir / "ledger-sample.ttl").read_text()
g = Graph().parse(data=ledger, format="turtle")
ok, _, report = validate(g, shacl_graph=shapes, ont_graph=onto, inference="none")
check(ok, "review ledger parses and its votes conform to RatificationVoteShape")
mine = samples_dir / "my-votes-sample.ttl"
if mine.exists():
    # the modal shows one document per vote, each with its own prefixes; parse them one by one
    docs = [d for d in mine.read_text().split("@prefix i2x:") if d.strip()]
    allok = True
    for d in docs:
        g = Graph().parse(data="@prefix i2x:" + d, format="turtle")
        ok, _, _ = validate(g, shacl_graph=shapes, ont_graph=onto, inference="none")
        allok = allok and ok and len(list(g.subjects(RDF.type, URIRef(cfg["relayNsRoot"] + "/" + cfg["owner"] + "/" + cfg["slugs"]["ontology"] + "#RatificationVote")))) == 1
    check(allok and len(docs) >= 1, f"each of the {len(docs)} 'My votes' records is one RatificationVote that conforms to the shapes")
print(f"\n{len(failures)} failures")
sys.exit(1 if failures else 0)
