#!/usr/bin/env python3
"""Run pySHACL over the same fixtures our engine just validated, and write theirs.json.

Deliberately dumb: read the fixture's own `# shape:` declaration, validate, record the
verdict. Any cleverness here would be a place for the two runs to diverge for reasons
that have nothing to do with the shapes.
"""
import json
import pathlib
import re
import sys

from pyshacl import validate
from rdflib import Graph

HERE = pathlib.Path(__file__).parent
FIXTURES = HERE / "fixtures"

results = {}
for path in sorted(FIXTURES.glob("*.data.ttl")):
    text = path.read_text(encoding="utf-8")
    m = re.search(r"^#\s*shape:\s*(\S+)", text, re.M)
    if not m:
        print(f"{path.name}: no '# shape:' declaration", file=sys.stderr)
        sys.exit(2)

    data = Graph().parse(data=text, format="turtle")
    shapes = Graph().parse(data=(FIXTURES / m.group(1)).read_text(encoding="utf-8"), format="turtle")

    conforms, _report_graph, _text = validate(
        data,
        shacl_graph=shapes,
        # No inference: our engine seeds subclass closure from the data and shapes graphs
        # only, so asking pySHACL for RDFS entailment would compare two different questions.
        inference="none",
        advanced=True,
    )
    results[path.name] = {"conforms": bool(conforms)}

(HERE / "theirs.json").write_text(json.dumps(results, indent=2), encoding="utf-8")
print(f"pySHACL validated {len(results)} fixture(s) -> theirs.json")
