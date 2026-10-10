"""Check that each published graph dereferences at its /ns IRI and matches the local build.

python3 -I tools/verify_published.py <i2idlx-root> [slug ...]

Each IRI is fetched as Turtle, JSON-LD and HyperMarkdown. The Turtle and the JSON-LD must each be
isomorphic to the build (RDF isomorphism); the HyperMarkdown view must resolve. Exits 1 on any miss.
"""
import json
import pathlib
import sys
import urllib.error
import urllib.request

import rdflib
from rdflib.compare import isomorphic

ROOT = pathlib.Path(sys.argv[1])
only = set(sys.argv[2:])
plan = json.loads((ROOT / "dist" / "publish-plan.json").read_text())
failed = []
for g in plan["graphs"]:
    slug = g["graph_iri"].rsplit("/", 1)[-1]
    if only and slug not in only:
        continue
    local = rdflib.Graph().parse(ROOT / "dist" / g["file"], format="turtle")
    out = {"slug": slug}
    for fmt, accept in (("turtle", "text/turtle"), ("jsonld", "application/ld+json"), ("markdown", "text/markdown")):
        req = urllib.request.Request(g["graph_iri"], headers={"Accept": accept, "User-Agent": "i2idlx-verify/0.2"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                body, ctype, status = r.read().decode("utf-8", "replace"), r.headers.get("Content-Type", ""), r.status
        except urllib.error.HTTPError as e:
            body, ctype, status = "", e.headers.get("Content-Type", ""), e.code
        out[fmt] = f"{status} {ctype.split(';')[0]}"
        ok = status == 200
        if ok and fmt in ("turtle", "jsonld"):
            remote = rdflib.Graph().parse(data=body, format="turtle" if fmt == "turtle" else "json-ld")
            out[f"{fmt}Triples"] = f"{len(remote)} remote / {len(local)} local"
            out[f"{fmt}Isomorphic"] = ok = isomorphic(remote, local)
        if not ok:
            failed.append(f"{slug} ({fmt})")
    print(json.dumps(out))
print(f"{'FAIL ' + ', '.join(failed) if failed else 'ok'}: Turtle and JSON-LD isomorphic to the build, HyperMarkdown resolves")
sys.exit(1 if failed else 0)
