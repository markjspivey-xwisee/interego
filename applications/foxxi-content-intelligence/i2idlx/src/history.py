"""Change history of the I2IDL glossary, derived from its public git history.

One derivation, two projections: build.py groups the events into the i2idlx-changes
graph (PROV activities per release), build_app.py turns them into per-concept timelines.

Every fact that differs between two successive releases becomes exactly one event, so
the history reconciles: first release + additions - removals = current release, for
concepts, relationship pairs, collection memberships and evidence records.
"""
from __future__ import annotations

import json
import subprocess

# code, label, definition. The upstream README lists the event types it wants
# (concept added, definition revised, source changed, relationship added, collection
# membership changed, evidence reclassified, external mapping added or revised); these refine them
# where the git history distinguishes cases.
KINDS = [
    ("concept-added", "Concept added", "A concept IRI first appears in the release."),
    ("concept-removed", "Concept removed", "A concept IRI present in the previous release is absent."),
    ("label-changed", "Preferred label changed", "The concept's skos:prefLabel differs from the previous release."),
    ("alt-label-added", "Alternative label added", "A skos:altLabel was added to the concept."),
    ("alt-label-removed", "Alternative label removed", "A skos:altLabel was removed from the concept."),
    ("definition-revised", "Definition revised", "The concept's skos:definition text differs from the previous release."),
    ("explanation-revised", "Editorial explanation revised", "The concept's gs:editorialExplanation differs from the previous release."),
    ("type-changed", "Type changed", "The concept's gs:typeCollection differs from the previous release."),
    ("field-changed", "Primary field changed", "The concept's gs:fieldCollection differs from the previous release."),
    ("status-changed", "Editorial status changed", "The concept's gs:editorialStatus differs from the previous release."),
    ("relationship-added", "Relationship added", "A skos:related pair or a skos:broader / skos:narrower pair is new in the release."),
    ("relationship-removed", "Relationship removed", "A skos:related or skos:broader / skos:narrower pair of the previous release is absent."),
    ("membership-added", "Collection membership added", "A concept became a skos:member of a collection."),
    ("membership-removed", "Collection membership removed", "A concept stopped being a skos:member of a collection."),
    ("collection-added", "Collection added", "A skos:Collection first appears in the release."),
    ("collection-removed", "Collection removed", "A skos:Collection of the previous release is absent."),
    ("collection-revised", "Collection revised", "A collection's label, facet or description differs from the previous release."),
    ("source-added", "Source added", "A source (dcterms:BibliographicResource) first appears in the release."),
    ("source-removed", "Source removed", "A source of the previous release is absent."),
    ("source-revised", "Source revised", "A source's title, URL or rights statement differs from the previous release."),
    ("evidence-added", "Evidence added", "An evidence record (source + citation) was added to a concept's active definition."),
    ("evidence-removed", "Evidence removed", "An evidence record was removed from a concept's active definition."),
    ("evidence-classified", "Evidence classified", "An evidence record received its first evidence relation (direct or supporting)."),
    ("evidence-reclassified", "Evidence reclassified", "An evidence record's relation changed (for example supporting to direct)."),
    ("external-mapping-added", "External mapping added", "A crosswalk to an external vocabulary became an asserted mapping (for I2IDL-X: a mapping proposal was ratified). None yet."),
    ("external-mapping-revised", "External mapping revised", "An asserted crosswalk changed predicate or target, or was withdrawn. None yet."),
]
KIND_CODES = [k[0] for k in KINDS]
REL_PROPS = ("skos:broader", "skos:narrower", "skos:related")


def aslist(v):
    return [] if v is None else (v if isinstance(v, list) else [v])


def ids(v):
    return [x["@id"] if isinstance(x, dict) else x for x in aslist(v)]


def snapshot(doc: dict) -> dict:
    """The comparable facts of one release of public/glossary.jsonld."""
    g = [n for n in doc.get("@graph", []) if isinstance(n, dict)]
    by = {n.get("@id"): n for n in g}
    s = {"version": "?", "concepts": {}, "sources": {}, "collections": {}}
    for n in g:
        ts = aslist(n.get("@type"))
        if "skos:ConceptScheme" in ts:
            s["version"] = n.get("gs:publicationVersion", "?")
        elif "dcterms:BibliographicResource" in ts:
            s["sources"][n["@id"]] = {k: v for k, v in n.items() if k != "@id"}
        elif "skos:Collection" in ts:
            s["collections"][n["@id"]] = {
                "members": set(ids(n.get("skos:member"))),
                "meta": {k: v for k, v in n.items() if k not in ("@id", "skos:member")},
            }
    for n in g:
        if "skos:Concept" not in aslist(n.get("@type")):
            continue
        ad = ids(n.get("gs:activeDefinition"))
        dn = by.get(ad[0]) if ad else None
        ev: dict[tuple, str | None] = {}
        for e in aslist((dn or {}).get("gs:evidence")):
            src = ids(e.get("dcterms:source"))
            key = (src[0] if src else None, e.get("gs:citationDetail") or "")
            k = 0
            while key + (k,) in ev:  # two records with the same source and citation stay distinct
                k += 1
            ev[key + (k,)] = e.get("gs:evidenceRelation")
        s["concepts"][n["@id"]] = {
            "label": n.get("skos:prefLabel"), "alt": set(aslist(n.get("skos:altLabel"))),
            "definition": n.get("skos:definition"), "explanation": n.get("gs:editorialExplanation"),
            "type": (ids(n.get("gs:typeCollection")) or [None])[0],
            "field": (ids(n.get("gs:fieldCollection")) or [None])[0],
            "status": n.get("gs:editorialStatus"),
            "rel": {p: set(ids(n.get(p))) for p in REL_PROPS},
            "ev": ev,
        }
    return s


def pairs(s: dict) -> dict[str, set]:
    """Relationship pairs, direction-normalized: related as unordered pairs, broader as (narrower, broader)."""
    related, broader = set(), set()
    for c, x in s["concepts"].items():
        for o in x["rel"]["skos:related"]:
            related.add(tuple(sorted((c, o))))
        for o in x["rel"]["skos:broader"]:
            broader.add((c, o))
        for o in x["rel"]["skos:narrower"]:
            broader.add((o, c))
    return {"skos:related": related, "skos:broader": broader}


def memberships(s: dict) -> set:
    return {(m, col) for col, x in s["collections"].items() for m in x["members"]}


def evidence(s: dict) -> dict:
    return {(c,) + k: rel for c, x in s["concepts"].items() for k, rel in x["ev"].items()}


def changed_fields(a: dict, b: dict) -> dict[str, tuple]:
    """{property: (before, after)} for the properties of a record that differ."""
    return {k: (a.get(k), b.get(k)) for k in sorted(set(a) | set(b)) if a.get(k) != b.get(k)}


def diff(p: dict, s: dict) -> list[dict]:
    """Every fact that differs between release p and its successor s, as one event each."""
    ev: list[dict] = []
    pc, sc = p["concepts"], s["concepts"]
    for c in sorted(set(sc) - set(pc)):
        ev.append({"kind": "concept-added", "concept": c})
    for c in sorted(set(pc) - set(sc)):
        ev.append({"kind": "concept-removed", "concept": c})
    for c in sorted(set(sc) & set(pc)):
        a, b = pc[c], sc[c]
        for field, kind in (("label", "label-changed"), ("definition", "definition-revised"),
                            ("explanation", "explanation-revised"), ("type", "type-changed"),
                            ("field", "field-changed"), ("status", "status-changed")):
            if a[field] != b[field]:
                ev.append({"kind": kind, "concept": c, "prior": a[field], "new": b[field]})
        for alt in sorted(b["alt"] - a["alt"]):
            ev.append({"kind": "alt-label-added", "concept": c, "new": alt})
        for alt in sorted(a["alt"] - b["alt"]):
            ev.append({"kind": "alt-label-removed", "concept": c, "prior": alt})
    pp, sp = pairs(p), pairs(s)
    for prop in ("skos:related", "skos:broader"):
        for x, y in sorted(sp[prop] - pp[prop]):
            ev.append({"kind": "relationship-added", "property": prop, "a": x, "b": y})
        for x, y in sorted(pp[prop] - sp[prop]):
            ev.append({"kind": "relationship-removed", "property": prop, "a": x, "b": y})
    pm, sm = memberships(p), memberships(s)
    for m, col in sorted(sm - pm):
        ev.append({"kind": "membership-added", "concept": m, "collection": col})
    for m, col in sorted(pm - sm):
        ev.append({"kind": "membership-removed", "concept": m, "collection": col})
    for col in sorted(set(s["collections"]) - set(p["collections"])):
        ev.append({"kind": "collection-added", "collection": col})
    for col in sorted(set(p["collections"]) - set(s["collections"])):
        ev.append({"kind": "collection-removed", "collection": col})
    for col in sorted(set(s["collections"]) & set(p["collections"])):
        if s["collections"][col]["meta"] != p["collections"][col]["meta"]:
            ev.append({"kind": "collection-revised", "collection": col,
                       "fields": changed_fields(p["collections"][col]["meta"], s["collections"][col]["meta"])})
    for src in sorted(set(s["sources"]) - set(p["sources"])):
        ev.append({"kind": "source-added", "source": src})
    for src in sorted(set(p["sources"]) - set(s["sources"])):
        ev.append({"kind": "source-removed", "source": src})
    for src in sorted(set(s["sources"]) & set(p["sources"])):
        if s["sources"][src] != p["sources"][src]:
            ev.append({"kind": "source-revised", "source": src, "fields": changed_fields(p["sources"][src], s["sources"][src])})
    pe, se = evidence(p), evidence(s)
    for k in sorted(set(se) - set(pe), key=str):
        ev.append({"kind": "evidence-added", "concept": k[0], "source": k[1], "new": se[k]})
    for k in sorted(set(pe) - set(se), key=str):
        ev.append({"kind": "evidence-removed", "concept": k[0], "source": k[1], "prior": pe[k]})
    for k in sorted(set(se) & set(pe), key=str):
        if se[k] != pe[k]:
            kind = "evidence-classified" if pe[k] is None else "evidence-reclassified"
            ev.append({"kind": kind, "concept": k[0], "source": k[1], "prior": pe[k], "new": se[k] or "unclassified"})
    return ev


def releases(clone: str, gpath: str) -> list[dict]:
    """One entry per gs:publicationVersion (its last commit), oldest first, with its snapshot."""
    sh = lambda a: subprocess.run(a, cwd=clone, capture_output=True, text=True, check=True).stdout
    by_version: dict[str, dict] = {}
    for line in filter(None, sh(["git", "log", "--reverse", "--format=%H %cI", "--", gpath]).split("\n")):
        h, when = line.split(" ", 1)
        s = snapshot(json.loads(sh(["git", "show", f"{h}:{gpath}"])))
        e = by_version.setdefault(s["version"], {"version": s["version"], "commits": 0})
        e.update({"commit": h, "date": when, "snap": s})
        e["commits"] += 1
    out = list(by_version.values())
    for prev, cur in zip(out, out[1:]):
        cur["events"] = diff(prev["snap"], cur["snap"])
        cur["previous"] = prev["version"]
    if out:
        out[0]["events"] = []
        out[0]["previous"] = None
    return out


def touched(e: dict) -> list[str]:
    """The concepts an event touches."""
    if "a" in e:
        return [e["a"], e["b"]]
    return [e["concept"]] if "concept" in e else []


def totals(s: dict) -> dict[str, int]:
    p = pairs(s)
    return {"concepts": len(s["concepts"]), "related": len(p["skos:related"]), "broader": len(p["skos:broader"]),
            "memberships": len(memberships(s)), "evidence": len(evidence(s)), "sources": len(s["sources"]),
            "collections": len(s["collections"])}


def reconcile(rels: list[dict]) -> dict[str, tuple[int, int]]:
    """first + additions - removals for each count, against the last release. → {name: (replayed, actual)}"""
    first, last = totals(rels[0]["snap"]), totals(rels[-1]["snap"])
    signed = {"concepts": ("concept-added", "concept-removed"), "memberships": ("membership-added", "membership-removed"),
              "evidence": ("evidence-added", "evidence-removed"), "sources": ("source-added", "source-removed"),
              "collections": ("collection-added", "collection-removed")}
    out = {}
    for name, (plus, minus) in signed.items():
        n = first[name]
        for r in rels[1:]:
            n += sum(1 for e in r["events"] if e["kind"] == plus) - sum(1 for e in r["events"] if e["kind"] == minus)
        out[name] = (n, last[name])
    for name, prop in (("related", "skos:related"), ("broader", "skos:broader")):
        n = first[name]
        for r in rels[1:]:
            n += sum(1 for e in r["events"] if e.get("property") == prop and e["kind"] == "relationship-added")
            n -= sum(1 for e in r["events"] if e.get("property") == prop and e["kind"] == "relationship-removed")
        out[name] = (n, last[name])
    return out
