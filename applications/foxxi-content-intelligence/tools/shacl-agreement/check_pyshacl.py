"""Hold pySHACL to the verdicts the Foxxi tests hold the substrate's SHACL processor to.

emit.ts writes each reading (<id>.nq), the published shapes it is checked against (<shapes>.shapes.ttl)
and its verdict (expected.json). This validates each reading's default graph with pySHACL — no
inference, as the tests run — and compares:
  - level "property": the property shapes named by violations, and by warnings, exactly;
  - level "node": whether it conforms, and the node shapes the violations belong to (a property
    shape belongs to the node shape that lists it with sh:property) — exactly, or, where "includes"
    is set, at least those.
A reading pySHACL gives another verdict fails the job: two SHACL processors that disagree on a
published shape mean it says two things.

usage: python3 check_pyshacl.py <dir written by emit.ts>
"""
import json
import logging
import os
import sys

import pyshacl
from rdflib import RDF, Dataset, Graph, Namespace
from rdflib.graph import DATASET_DEFAULT_GRAPH_ID

SH = Namespace('http://www.w3.org/ns/shacl#')
# rdflib logs a traceback for every ill-typed literal it reads (a case that writes an xsd:dateTime that
# is not one does so on purpose); pySHACL still reports it as a violation, which is what is checked.
logging.getLogger('rdflib.term').setLevel(logging.ERROR)


def local(iri):
    return str(iri).split('#', 1)[-1]


def main(d):
    expected = json.load(open(os.path.join(d, 'expected.json'), encoding='utf-8'))
    shapes = {}
    failed = 0
    for rid, e in sorted(expected.items()):
        if e['shapes'] not in shapes:
            shapes[e['shapes']] = Graph().parse(os.path.join(d, e['shapes'] + '.shapes.ttl'), format='turtle')
        sg = shapes[e['shapes']]
        owner = {o: s for s, o in sg.subject_objects(SH.property)}
        ds = Dataset()
        ds.parse(os.path.join(d, rid + '.nq'), format='nquads')
        data = Graph()
        for t in ds.graph(DATASET_DEFAULT_GRAPH_ID):
            data.add(t)
        conforms, report, _ = pyshacl.validate(data, shacl_graph=sg, inference='none', advanced=True, allow_warnings=True)
        violations, warnings = set(), set()
        # The report's own results: a result pySHACL nests under one (sh:detail, for a value that does
        # not conform to an sh:node shape) is the same breach, which the outer result already reports.
        for r in (x for rep in report.subjects(RDF.type, SH.ValidationReport) for x in report.objects(rep, SH.result)):
            source = report.value(r, SH.sourceShape)
            if e['level'] == 'node':
                source = owner.get(source, source)
            (violations if report.value(r, SH.resultSeverity) == SH.Violation else warnings).add(local(source))
        want = set(e['violates'])
        if e['level'] == 'property':
            ok = sorted(violations) == sorted(want) and sorted(warnings) == sorted(e.get('warns', []))
            got = f"violates {sorted(violations)} warns {sorted(warnings)}"
            wanted = f"violates {sorted(want)} warns {sorted(e.get('warns', []))}"
        else:
            ok = (not violations) == e['conforms'] and (want <= violations if e.get('includes') else violations == want)
            got = f"{'conforms' if not violations else 'violates ' + str(sorted(violations))}"
            wanted = f"{'conforms' if e['conforms'] else ('violates at least ' if e.get('includes') else 'violates ') + str(sorted(want))}"
        if not ok:
            failed += 1
            print(f"DISAGREE {rid} ({e['name']}): pySHACL {got}; the tests hold {wanted}")
        else:
            print(f"agree    {rid}")
    print(f"{len(expected) - failed} of {len(expected)} readings get the verdict the Foxxi tests hold, from pySHACL {pyshacl.__version__}")
    return 1 if failed else 0


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit('usage: check_pyshacl.py <dir>')
    sys.exit(main(sys.argv[1]))
