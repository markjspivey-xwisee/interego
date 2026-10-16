"""Independent SHACL checks for the decorated REST URL argument contracts."""
from pathlib import Path
import json
from rdflib import Graph, Namespace, URIRef, Literal
from rdflib.namespace import RDF, XSD, SH
from pyshacl import validate

root = Path(__file__).resolve().parents[1]
base = "https://example.org/catalog"
cat = Namespace(base + "#")
text = (root / "src/i2idlx-rest-api.ttl.tmpl").read_text()
text = text.replace("{{CATALOG}}", base).replace("{{NS}}", "https://example.org/i2x#")
contract = Graph().parse(data=text, format="turtle")


def check(operation, bindings, expected):
    shapes = Graph()
    for triple in contract:
        shapes.add(triple)
    request = URIRef("urn:test:request")
    shapes.add((cat["rest-input-" + operation], SH.targetNode, request))
    data = Graph()
    for parameter, value in bindings.items():
        data.add((request, cat[f"rest-param-{operation}-{parameter}"], Literal(value)))
    conforms, _, report = validate(data, shacl_graph=shapes, inference="none")
    assert bool(conforms) is expected, (operation, bindings, report)


check("listConcepts", {"limit": 1, "offset": 0, "q": "learning"}, True)
check("listConcepts", {"limit": 101}, False)
check("listConcepts", {"offset": 100001}, False)
check("listConcepts", {"q": "a" * 161}, False)
check("listConcepts", {"notAParameter": "ignored?"}, False)
check("collectionMembers", {"type": "field", "id": "learning-sciences", "limit": 20}, True)
check("collectionMembers", {"type": "unknown", "id": "learning-sciences"}, False)
check("conceptContext", {"id": "learning-engineering", "depth": 0, "maxRelated": 0}, True)
check("conceptContext", {"id": "../outside"}, False)
check("conceptContext", {"depth": 1}, False)
check("conceptContext", {"id": "learning-engineering", "depth": 2}, False)
check("conceptContext", {"id": "learning-engineering", "maxRelated": 21}, False)
print(json.dumps({"shaclCases": 12, "passed": True, "engine": "pySHACL"}))
