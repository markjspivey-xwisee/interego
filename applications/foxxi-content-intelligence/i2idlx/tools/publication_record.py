"""Record what is published: fetch each signed descriptor listed in publications.json, check it
describes the graph IRI the publish plan expects, and write dist/published.json.

python3 -I tools/publication_record.py <i2idlx-root>
"""
import json
import pathlib
import sys
import urllib.request

import rdflib

IEP = rdflib.Namespace("https://markjspivey-xwisee.github.io/interego/ns/iep#")
ROOT = pathlib.Path(sys.argv[1])
pubs = json.loads((ROOT / "publications.json").read_text())
plan = json.loads((ROOT / "dist" / "publish-plan.json").read_text())
expected = {g["graph_iri"].rsplit("/", 1)[-1]: g for g in plan["graphs"]}


def fetch(url: str) -> rdflib.Graph:
    req = urllib.request.Request(url, headers={"Accept": "text/turtle", "User-Agent": "i2idlx-record/0.1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return rdflib.Graph().parse(data=r.read().decode("utf-8"), format="turtle")


def one(g: rdflib.Graph, p) -> str | None:
    v = next(g.objects(None, p), None)
    return str(v) if v is not None else None


record, problems = [], []
for slug, url in pubs["descriptors"].items():
    g = fetch(url)
    describes = one(g, IEP.describes)
    modal = one(g, IEP.modalStatus)
    row = {
        "graph": slug,
        "graphIri": describes,
        "descriptor": url,
        "modalStatus": modal.rsplit("#", 1)[-1] if modal else None,
        "validFrom": one(g, IEP.validFrom),
        "contentHash": one(g, IEP.contentHash),
        "signer": one(g, IEP.signerAddress),
        "supersedes": sorted(str(o) for o in g.objects(None, IEP.supersedes)),
    }
    plan_row = expected.get(slug)
    if not plan_row:
        problems.append(f"{slug}: not in the publish plan")
    else:
        if describes != plan_row["graph_iri"]:
            problems.append(f"{slug}: descriptor describes {describes}, plan says {plan_row['graph_iri']}")
        if row["modalStatus"] != plan_row["modal_status"]:
            problems.append(f"{slug}: descriptor modal status {row['modalStatus']}, plan says {plan_row['modal_status']}")
    if not row["contentHash"]:
        problems.append(f"{slug}: no signed content hash")
    record.append(row)

missing = sorted(set(expected) - set(pubs["descriptors"]))
if missing:
    problems.append("unpublished: " + ", ".join(missing))
out = {"owner": plan["owner"], "graphs": record, "superseded": pubs.get("superseded", {}), "problems": problems}
(ROOT / "dist" / "published.json").write_text(json.dumps(out, indent=2) + "\n")
for r in record:
    print(f"{r['graph']:<18} {r['modalStatus']:<12} {r['validFrom']}  {(r['contentHash'] or '')[:40]}…")
print("problems:", problems or "none")
sys.exit(1 if problems else 0)
