/** A derived reference profile. The published canonical shapes remain unchanged. */
import { union, parseTurtle, nn, SH, type Store } from './rdf.js';
import { authoredIriRef as iri, resolveConceptIndex } from './authored-concepts.js';
type Row = Record<string, ReturnType<typeof JSON.parse>>;
export function authoredReferenceShapes(data: Row, original: Store): Store {
  const authored = [...resolveConceptIndex(data).values()].filter(c => c.origin.kind === 'authored');
  if (!authored.length) return original;
  const shapes = union(original);
  const patterns = shapes.getQuads(null, nn(SH + 'pattern'), null, null).filter(q => q.subject.termType === 'NamedNode' && q.subject.value.endsWith('#I2IDLConceptRef'));
  if (patterns.length !== 1 || patterns[0]!.object.termType !== 'Literal') throw new Error('The pinned reference shape cannot be extended safely.');
  const pattern = patterns[0]!;
  shapes.removeQuad(pattern);
  shapes.addQuads([...parseTurtle(`${iri(pattern.subject.value)} ${iri(SH + 'or')} ( [ ${iri(SH + 'pattern')} ${JSON.stringify(pattern.object.value)} ] [ ${iri(SH + 'in')} ( ${authored.map(c => iri(c.iri)).join(' ')} ) ] ) .`)]);
  return shapes;
}
