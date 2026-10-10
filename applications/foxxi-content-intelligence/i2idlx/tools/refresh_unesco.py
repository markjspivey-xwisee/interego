"""Snapshot the UNESCO Thesaurus terms that I2IDL's own evidence cites as preferred terms.

python3 -I tools/refresh_unesco.py <i2idlx-root>

Reads the pinned I2IDL graph, finds every evidence record whose URL is a UNESCO Thesaurus
concept page cited as "Preferred term", fetches each concept from UNESCO's Skosmos REST API
(retrying: the service drops connections intermittently) and writes evidence/unesco-thesaurus.json
with label, alternative labels, scope note, broader terms, microthesaurus groups, licence and
which I2IDL definitions cite it. build.py accepts a UNESCO target only if it is in this file.
Responses are parsed as data in a fresh temporary directory.
"""
import datetime as dt
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request

from rdflib import Graph, URIRef
from rdflib.namespace import SKOS, DCTERMS

ROOT = pathlib.Path(sys.argv[1]).resolve()
cfg = json.loads((ROOT / "config.json").read_text())
# Machine-specific paths: an environment variable wins; a relative path is read from the package root.
for _keys, _env in ((("i2idl", "localClone"), "I2IDL_CLONE"), (("interegoCoreSrc",), "INTEREGO_CORE_SRC"), (("tsx",), "INTEREGO_TSX")):
    _holder = cfg
    for _k in _keys[:-1]:
        _holder = _holder[_k]
    _v = os.environ.get(_env) or _holder.get(_keys[-1], "")
    _holder[_keys[-1]] = str((ROOT / _v).resolve()) if _v and not os.path.isabs(_v) else _v
clone, gpath = cfg["i2idl"]["localClone"], cfg["i2idl"]["graphPath"]
API = "https://vocabularies.unesco.org/rest/v1/unesco/data?format=application/ld%2Bjson&uri="
SCHEME = "http://vocabularies.unesco.org/thesaurus"
PAGE = re.compile(r"^https?://vocabularies\.unesco\.org/unesco/en/page/(concept\d+)$")
tmp = pathlib.Path(tempfile.mkdtemp(prefix="i2idlx-unesco-"))


def aslist(v):
    return [] if v is None else (v if isinstance(v, list) else [v])


def ids(v):
    return [x["@id"] if isinstance(x, dict) else x for x in aslist(v)]


def fetch(iri: str) -> Graph:
    url = API + urllib.parse.quote(iri, safe="")
    last = None
    for attempt in range(8):
        try:
            req = urllib.request.Request(url, headers={"Accept": "application/ld+json", "User-Agent": "i2idlx-refresh/1.0"})
            with urllib.request.urlopen(req, timeout=45) as r:
                body = r.read()
            path = tmp / (re.sub(r"\W+", "_", iri) + ".jsonld")
            path.write_bytes(body)
            return Graph().parse(path, format="json-ld")
        except Exception as e:  # connection resets and empty replies are routine here
            last = e
            time.sleep(2 + attempt * 2)
    raise SystemExit(f"UNESCO API unreachable for {iri}: {last}")


def en(g: Graph, s, p) -> list[str]:
    return sorted(str(o) for o in g.objects(s, p) if getattr(o, "language", None) == "en")


# 1. Which UNESCO terms does I2IDL cite, and where?
doc = json.loads(subprocess.run(["git", "show", f"HEAD:{gpath}"], cwd=clone, capture_output=True, text=True, check=True).stdout)
nodes = doc["@graph"]
by = {n.get("@id"): n for n in nodes}
version = next(n.get("gs:publicationVersion") for n in nodes if "skos:ConceptScheme" in aslist(n.get("@type")))
assert version == cfg["i2idl"]["release"], f"clone is at {version}, config pins {cfg['i2idl']['release']}"
cited: dict[str, list[dict]] = {}
for n in nodes:
    if "skos:Concept" not in aslist(n.get("@type")):
        continue
    for d in ids(n.get("gs:activeDefinition")):
        for e in aslist(by.get(d, {}).get("gs:evidence")):
            m = PAGE.match(str(e.get("schema:url", "")))
            if m and "Preferred term" in str(e.get("gs:citationDetail", "")):
                cited.setdefault(f"{SCHEME}/{m.group(1)}", []).append({
                    "concept": n["@id"].rsplit("/", 1)[-1], "definition": d, "relation": e.get("gs:evidenceRelation"),
                    "citation": e.get("gs:citationDetail"), "page": e.get("schema:url")})

# 2. Scheme metadata (licence, modified) and each cited term.
sg = fetch(SCHEME)
scheme = URIRef(SCHEME)
out = {
    "fetchedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
    "i2idlRelease": version,
    "scheme": {"iri": SCHEME, "title": (en(sg, scheme, SKOS.prefLabel) or ["UNESCO Thesaurus"])[0],
               "license": str(sg.value(scheme, DCTERMS.license) or ""), "rightsHolder": str(sg.value(scheme, DCTERMS.rightsHolder) or ""),
               "modified": str(sg.value(scheme, DCTERMS.modified) or "")},
    "terms": {},
}
for iri in sorted(cited, key=lambda s: int(s.rsplit("concept", 1)[-1])):
    g = fetch(iri)
    c = URIRef(iri)
    label = en(g, c, SKOS.prefLabel)
    assert label, f"{iri}: no English preferred label in UNESCO's response"
    groups = [s for s in g.subjects(SKOS.member, c)]
    out["terms"][iri] = {
        "label": label[0],
        "alt": en(g, c, SKOS.altLabel),
        "scopeNote": " ".join(en(g, c, SKOS.scopeNote)) or None,
        "definition": " ".join(en(g, c, SKOS.definition)) or None,
        "broader": [{"iri": str(b), "label": (en(g, b, SKOS.prefLabel) or [None])[0]} for b in sorted(g.objects(c, SKOS.broader))],
        "narrowerCount": len(set(g.objects(c, SKOS.narrower))),
        "groups": [{"iri": str(s), "label": (en(g, s, SKOS.prefLabel) or [None])[0]} for s in sorted(groups)],
        "inScheme": str(g.value(c, SKOS.inScheme) or ""),
        "page": f"https://vocabularies.unesco.org/unesco/en/page/{iri.rsplit('/', 1)[-1]}",
        "citedBy": cited[iri],
    }
    print(f"{iri.rsplit('/', 1)[-1]:<10} {label[0]:<28} broader={len(out['terms'][iri]['broader'])} groups={len(groups)} cited by {', '.join(x['concept'] for x in cited[iri])}")

(ROOT / "evidence" / "unesco-thesaurus.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
print(f"unesco-thesaurus.json: {len(out['terms'])} terms; licence {out['scheme']['license']}")
