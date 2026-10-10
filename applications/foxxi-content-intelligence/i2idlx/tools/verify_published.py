"""Check that each published graph dereferences at its /ns IRI and is isomorphic to the local build.

python3 -I tools/verify_published.py <i2idlx-root> [slug ...]
"""
import json
import pathlib
import sys
import urllib.request

import rdflib
from rdflib.compare import isomorphic

ROOT = pathlib.Path(sys.argv[1])
only = set(sys.argv[2:])
plan = json.loads((ROOT / "dist" / "publish-plan.json").read_text())
rows = []
for g in plan["graphs"]:
    slug = g["graph_iri"].rsplit("/", 1)[-1]
    if only and slug not in only:
        continue
    local = rdflib.Graph().parse(ROOT / "dist" / g["file"], format="turtle")
    out = {"slug": slug}
    for fmt, accept in (("turtle", "text/turtle"), ("jsonld", "application/ld+json"), ("markdown", "text/markdown")):
        req = urllib.request.Request(g["graph_iri"], headers={"Accept": accept, "User-Agent": "i2idlx-verify/0.1"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body, ctype, status = r.read().decode("utf-8", "replace"), r.headers.get("Content-Type", ""), r.status
        except urllib.error.HTTPError as e:
            body, ctype, status = "", e.headers.get("Content-Type", ""), e.code
        out[fmt] = f"{status} {ctype.split(';')[0]}"
        if fmt == "turtle" and status == 200:
            remote = rdflib.Graph().parse(data=body, format="turtle")
            out["triples"] = f"{len(remote)} remote / {len(local)} local"
            out["isomorphic"] = isomorphic(remote, local)
        if fmt == "jsonld" and status == 200:
            out["jsonldTriples"] = len(rdflib.Graph().parse(data=body, format="json-ld"))
    rows.append(out)
    print(json.dumps(out))
