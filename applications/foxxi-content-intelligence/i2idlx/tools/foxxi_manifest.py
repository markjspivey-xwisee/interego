import sys, json, rdflib
from rdflib import Namespace, URIRef
IEP = Namespace('https://markjspivey-xwisee.github.io/interego/ns/iep#')
HYDRA = Namespace('http://www.w3.org/ns/hydra/core#')
RDFS = rdflib.RDFS
g = rdflib.Graph(); g.parse(sys.argv[1], format='turtle')
out = []
for s in set(g.subjects(rdflib.RDF.type, IEP.Affordance)):
    act = g.value(s, IEP.action)
    out.append({
      'subject': str(s), 'action': str(act) if act else None,
      'target': str(g.value(s, HYDRA.target)) if g.value(s, HYDRA.target) else None,
      'method': str(g.value(s, HYDRA.method)) if g.value(s, HYDRA.method) else None,
      'title': str(g.value(s, HYDRA.title) or g.value(s, RDFS.label) or ''),
      'desc': ' '.join(str(g.value(s, HYDRA.description) or g.value(s, RDFS.comment) or '').split())[:240],
      'expects': str(g.value(s, HYDRA.expects)) if g.value(s, HYDRA.expects) else None,
      'collections': sorted(str(o) for o in g.objects(s, IEP.appliesToCollection)),
      'readOnly': str(g.value(s, IEP.readOnlyHint)) if g.value(s, IEP.readOnlyHint) is not None else None,
    })
out.sort(key=lambda r: r['action'] or '')
json.dump(out, open(sys.argv[2], 'w'), indent=1)
from collections import Counter
print('affordances:', len(out), 'verticals:', Counter((r['action'] or '').split('/ns/iep/action/')[-1].split('/')[0] for r in out))
