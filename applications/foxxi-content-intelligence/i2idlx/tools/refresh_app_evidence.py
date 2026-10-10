"""Snapshot the live inputs the workbench app shows beside the glossary.

python3 -I tools/refresh_app_evidence.py <i2idlx-root>

Writes, under evidence/:
  foxxi-manifest.ttl      the full Foxxi bridge affordance manifest (titles, full descriptions, input properties)
  relay-inputs.json       the JSON Schema of every relay operation's input, keyed by operation name
  external-terms.json     label + definition of every external mapping target, from its own vocabulary

Downloads land in a fresh temporary directory and are parsed as data only. build_app.py reads these
snapshots and never touches the network, so the app build is reproducible.
"""
import json
import pathlib
import sys
import tempfile
import urllib.request

from rdflib import Graph, URIRef
from rdflib.namespace import RDFS, SKOS

ROOT = pathlib.Path(sys.argv[1]).resolve()
EV = ROOT / "evidence"
cfg = json.loads((ROOT / "config.json").read_text())
UA = {"User-Agent": "i2idlx-refresh/1.0"}


def get(url: str, accept: str | None = None) -> bytes:
    headers = dict(UA)
    if accept:
        headers["Accept"] = accept
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=60) as r:
        return r.read()


tmp = pathlib.Path(tempfile.mkdtemp(prefix="i2idlx-app-evidence-"))

# 1. Foxxi manifest, verbatim.
manifest = get(cfg["foxxiManifest"], "text/turtle")
Graph().parse(data=manifest.decode("utf-8"), format="turtle")  # must parse before it is kept
(EV / "foxxi-manifest.ttl").write_bytes(manifest)
print("foxxi-manifest.ttl", len(manifest), "bytes")

# 2. Relay operation input schemas.
ops = json.loads((EV / "relay-operations.json").read_text())["hydra:member"]
inputs = {}
for op in ops:
    url = op.get("expects")
    if not url or not url.startswith("https://relay.interego.xwisee.com/"):
        continue
    name = op["action"].rsplit("/", 1)[-1]
    try:
        inputs[name] = json.loads(get(url, "application/json"))
    except Exception as e:  # keep going; the app shows "input shape not published" for gaps
        print("  no input schema for", name, "-", e)
(EV / "relay-inputs.json").write_text(json.dumps(inputs, indent=1, ensure_ascii=False, sort_keys=True))
print("relay-inputs.json", len(inputs), "operations")

# 3. External mapping targets: label + definition from each target's own vocabulary.
maps = Graph().parse(ROOT / "dist" / f"{cfg['slugs']['mappings']}.ttl", format="turtle")
I2X = cfg["relayNsRoot"] + "/" + cfg["owner"] + "/" + cfg["slugs"]["ontology"] + "#"
targets = sorted({str(o) for o in maps.objects(None, URIRef(I2X + "proposedObject"))})
vocab_graphs = []
for f in ["xapi-ontology.ttl", "xapi-profile-ontology.ttl", "ns_ieee-ler.ttl", "ns_adl-tla.ttl", "iep.ttl"]:
    vocab_graphs.append((f, Graph().parse(EV / f, format="turtle")))
sdo_path = tmp / "schemaorg.jsonld"
sdo_path.write_bytes(get("https://schema.org/version/latest/schemaorg-current-https.jsonld", "application/ld+json"))
sdo = json.loads(sdo_path.read_text())
sdo_by_id = {n.get("@id"): n for n in sdo.get("@graph", [])}
vc_path = tmp / "vc.ttl"
vc_path.write_bytes(get("https://www.w3.org/2018/credentials", "text/turtle"))
vocab_graphs.append(("w3.org/2018/credentials", Graph().parse(vc_path, format="turtle")))


def lit(v):
    if isinstance(v, dict):
        return v.get("@value")
    if isinstance(v, list):
        en = [x for x in v if isinstance(x, dict) and x.get("@language", "en") == "en"]
        return lit(en[0] if en else v[0])
    return v


terms = {}
for t in targets:
    rec = None
    if t.startswith("https://schema.org/"):
        n = sdo_by_id.get("schema:" + t.rsplit("/", 1)[-1])
        if n:
            rec = {"label": lit(n.get("rdfs:label")), "definition": lit(n.get("rdfs:comment")), "from": "schema.org"}
    else:
        for name, g in vocab_graphs:
            s = URIRef(t)
            label = g.value(s, RDFS.label) or g.value(s, SKOS.prefLabel)
            comment = g.value(s, SKOS.definition) or g.value(s, RDFS.comment)
            if label is not None or comment is not None:
                rec = {"label": str(label) if label is not None else None,
                       "definition": " ".join(str(comment).split()) if comment is not None else None, "from": name}
                break
    terms[t] = rec or {"label": None, "definition": None, "from": None}
    if rec is None:
        print("  no definition found for", t)
(EV / "external-terms.json").write_text(json.dumps(terms, indent=1, ensure_ascii=False, sort_keys=True))
print("external-terms.json", sum(1 for v in terms.values() if v["definition"]), "of", len(terms), "targets defined")
