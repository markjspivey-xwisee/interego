"""One-time migration oracle; never called by the TypeScript application."""
import importlib.util
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("i2idl_history_oracle", root.parent / "src" / "history.py")
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)

def serialize(s):
    concepts = {}
    for c in sorted(s["concepts"]):
        x = s["concepts"][c]
        concepts[c] = {
            "label": x["label"], "alt": sorted(x["alt"]),
            "definition": x["definition"], "explanation": x["explanation"],
            "type": x["type"], "field": x["field"], "status": x["status"],
            "rel": {p: sorted(x["rel"][p]) for p in history.REL_PROPS},
            "ev": [[list(k), x["ev"][k]] for k in sorted(x["ev"], key=str)],
            "match": [[k, sorted(x["match"][k])] for k in sorted(x["match"])],
            "assoc": [[list(k), x["assoc"][k]] for k in sorted(x["assoc"], key=str)],
        }
    return {
        "version": s["version"], "concepts": concepts, "sources": s["sources"],
        "collections": {c: {"members": sorted(x["members"]), "meta": x["meta"]}
                        for c, x in sorted(s["collections"].items())},
    }

def main():
    if len(sys.argv) not in (3, 4):
        raise SystemExit("Usage: python history-parity.py CLONE GLOSSARY_PATH [OUTPUT]")
    rels = history.releases(sys.argv[1], sys.argv[2])
    fixture = json.loads((root / "fixtures" / "history.json").read_text(encoding="utf-8"))
    before, after = history.snapshot(fixture["before"]), history.snapshot(fixture["after"])
    result = {
        "kinds": history.KINDS,
        "releases": [{**r, "snap": serialize(r["snap"])} for r in rels],
        "reconciliation": history.reconcile(rels),
        "totals": [history.totals(r["snap"]) for r in rels],
        "fixture": {"before": serialize(before), "after": serialize(after), "events": history.diff(before, after)},
    }
    text = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if len(sys.argv) == 4:
        pathlib.Path(sys.argv[3]).write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)

if __name__ == "__main__":
    main()
