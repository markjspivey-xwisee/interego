/**
 * THE DOCUMENTS A WORKSPACE IS MADE OF, serialised in one place.
 *
 * A workspace is not an object on a server. It is five documents on the convener's pod plus
 * two on each member's, and this file is the whole of what any client of this package WRITES.
 * It lived in the published artifact's hand-written script, which meant a second client had to
 * either restate it or read a workspace it could not create.
 *
 * ★ EVERY INTERPOLATED IRI IS GUARDED HERE AND WAS NOT GUARDED THERE.
 * `entryTurtle` has refused an unserialisable IRI since it was written; these six writers did
 * not, and they interpolate values that come off OTHER PEOPLE'S PODS. The concrete path:
 * `resolveInvitee` reads the invitee's WebID out of `get_pod_status.registry.owner` — a field
 * on the INVITEE's pod, under the invitee's control — and hands it to {@link grantTurtle},
 * which wrote `wsp:grantedTo <…>` with no check. A Turtle IRI reference ends at the first `>`
 * and the production has no escape for one, so a WebID containing `>` closes the reference and
 * every byte after it is parsed as more triples — in a document published on the CONVENER's
 * pod, under the convener's signature. Refusal is the only correct handling, so these throw.
 */

import { escapeTurtleLiteral, WSP } from './turtle.js';

/**
 * One IRI reference, or a throw naming which argument was not serialisable.
 *
 * Shared with nothing: `entryTurtle` has its own copy inline because it predates this file and
 * moving it would change bytes the artifact's no-drift test pins. The character class is the
 * same set — Turtle's IRIREF production — and `tests/workspace-documents.test.ts` asserts the
 * two agree, so they cannot come apart without a red test.
 */
export function turtleIri(u: string, what: string): string {
  if (typeof u !== 'string' || !u) throw new Error('turtleIri: ' + what + ' is missing, so the document cannot be written');
  if (/[\s<>"{}|\\^`]/.test(u)) {
    throw new Error('turtleIri: ' + what + ' is not serializable as a Turtle IRI reference and there is no escape for the '
      + 'characters in it, so this document is refused rather than written with a reference that ends somewhere else: ' + u);
  }
  return '<' + u + '>';
}

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const DCT = 'http://purl.org/dc/terms/';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const SHACL = 'http://www.w3.org/ns/shacl#';
const DCTYPE = 'http://purl.org/dc/dcmitype/';

/** `dct:created "…"^^xsd:dateTime`, injected so a test can pin the bytes. */
const created = (iso?: string): string => '"' + (iso ?? new Date().toISOString()) + '"^^xsd:dateTime';

/**
 * The three shapes a workspace validates its own documents against.
 *
 * Published FIRST, because everything after it is sent with `conforms_to_shapes` naming it and
 * the relay refuses a write whose shape does not resolve rather than publishing it unvalidated.
 */
export function shapesTurtle(shapeIri: string): string {
  const s = shapeIri;
  turtleIri(s, 'the shape IRI');           // the fragments below are appended to it
  return '@prefix sh: <' + SHACL + '> .\n'
    + '@prefix wsp: <' + WSP + '> .\n'
    + '@prefix dct: <' + DCT + '> .\n\n'
    + '<' + s + '#EntryShape>\n'
    + '  a sh:NodeShape ; sh:targetClass wsp:Entry ;\n'
    + '  sh:property [ sh:path wsp:workspace ; sh:minCount 1 ; sh:nodeKind sh:IRI ] ;\n'
    + '  sh:property [ sh:path dct:description ; sh:minCount 1 ; sh:maxCount 1 ] ;\n'
    + '  sh:property [ sh:path dct:created ; sh:minCount 1 ; sh:maxCount 1 ] .\n\n'
    + '<' + s + '#GrantShape>\n'
    + '  a sh:NodeShape ; sh:targetClass wsp:MembershipGrant ;\n'
    + '  sh:property [ sh:path wsp:workspace ; sh:minCount 1 ; sh:nodeKind sh:IRI ] ;\n'
    + '  sh:property [ sh:path wsp:grantedTo ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] ;\n'
    + '  sh:property [ sh:path wsp:role ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] .\n\n'
    + '<' + s + '#AcceptanceShape>\n'
    + '  a sh:NodeShape ; sh:targetClass wsp:MembershipAcceptance ;\n'
    + '  sh:property [ sh:path wsp:workspace ; sh:minCount 1 ; sh:nodeKind sh:IRI ] ;\n'
    + '  sh:property [ sh:path wsp:member ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] ;\n'
    + '  sh:property [ sh:path wsp:accepts ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] ;\n'
    + '  sh:property [ sh:path wsp:stream ; sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ] .\n';
}

/**
 * The role table, emitted as Turtle at a relay `/ns/` IRI — which serves `text/turtle`, so the
 * role reader resolves it in ONE hop with no HTML alternate to follow.
 *
 * ROLES ARE DATA. A workspace names a profile document and a reader reads it; a client that
 * held an enum would be asserting its own governance under the workspace's name.
 */
export function rolesTurtle(iri: string): string {
  turtleIri(iri, 'the role profile IRI');
  const cap = (frag: string, label: string, comment: string): string =>
    '<' + iri + '#' + frag + '> a wsp:Capability ; rdfs:label "' + escapeTurtleLiteral(label)
    + '" ; rdfs:comment "' + escapeTurtleLiteral(comment) + '" .\n';
  const role = (frag: string, label: string, comment: string, permits: readonly string[]): string =>
    '<' + iri + '#' + frag + '> a wsp:Role ; rdfs:label "' + escapeTurtleLiteral(label)
    + '" ; rdfs:comment "' + escapeTurtleLiteral(comment) + '" ;\n  wsp:permits '
    + permits.map((p) => '<' + iri + '#' + p + '>').join(', ') + ' .\n';
  return '@prefix wsp: <' + WSP + '> .\n'
    + '@prefix rdfs: <' + RDFS + '> .\n\n'
    + cap('Read', 'Read the channel', 'Fold every member\'s log into one view.')
    + cap('Post', 'Post to the channel', 'Append an entry to your own log in this workspace.')
    + cap('Convene', 'Invite and revoke', 'Publish and withdraw membership grants for this workspace. Only the convener\'s pod holds grants a reader will count, so only the convener can exercise this.')
    + '\n'
    + role('Convener', 'Convener', 'Holds the pod the grants are read from. Can invite, can revoke, and writes to their own log like anybody else.', ['Read', 'Post', 'Convene'])
    + role('Contributor', 'Contributor', 'Reads the channel and writes to their own log. Cannot seat or unseat anyone.', ['Read', 'Post'])
    + role('Reader', 'Reader', 'Reads the channel. Publishes nothing to it.', ['Read']);
}

/** The workspace record: what a reader holding only the workspace IRI can find everything from. */
export function workspaceTurtle(args: {
  readonly workspace: string;
  readonly title: string;
  readonly convenerWebId: string;
  readonly rolesIri: string;
  readonly shapeIri: string;
  readonly createdIso?: string;
}): string {
  const ws = turtleIri(args.workspace, 'the workspace IRI');
  const conv = turtleIri(args.convenerWebId, 'the convener WebID');
  const roles = turtleIri(args.rolesIri, 'the role profile IRI');
  const shape = turtleIri(args.shapeIri, 'the shape IRI');
  return '@prefix wsp: <' + WSP + '> .\n'
    + '@prefix dct: <' + DCT + '> .\n'
    + '@prefix xsd: <' + XSD + '> .\n\n'
    + ws + '\n'
    + '  a wsp:Workspace ;\n'
    + '  dct:title "' + escapeTurtleLiteral(args.title) + '" ;\n'
    + '  wsp:convener ' + conv + ' ;\n'
    + '  wsp:roleProfile ' + roles + ' ;\n'
    + '  wsp:entryShape ' + shape + ' ;\n'
    + '  wsp:grantCapability <' + args.rolesIri + '#Convene> ;\n'
    + '  dct:created ' + created(args.createdIso) + ' .\n';
}

/**
 * A membership grant. Half of a seat, and the half the convener owns.
 *
 * `revoked` republishes the SAME IRI with `wsp:revoked true`. Nothing reaches into the member's
 * pod: their acceptance and everything they wrote are untouched. What changes is that a reader
 * folding this workspace stops counting them.
 */
export function grantTurtle(args: {
  readonly grant: string;
  readonly workspace: string;
  readonly granteeWebId: string;
  readonly role: string;
  readonly revoked?: boolean;
  readonly createdIso?: string;
}): string {
  const g = turtleIri(args.grant, 'the grant IRI');
  const ws = turtleIri(args.workspace, 'the workspace IRI');
  // ★ THE ONE THAT COMES OFF SOMEBODY ELSE'S POD. See the header.
  const to = turtleIri(args.granteeWebId, 'the grantee WebID, which was read from the invitee\'s own pod');
  const role = turtleIri(args.role, 'the role IRI');
  return '@prefix wsp: <' + WSP + '> .\n'
    + '@prefix dct: <' + DCT + '> .\n'
    + '@prefix xsd: <' + XSD + '> .\n\n'
    + g + '\n'
    + '  a wsp:MembershipGrant ;\n'
    + '  wsp:workspace ' + ws + ' ;\n'
    + '  wsp:grantedTo ' + to + ' ;\n'
    + '  wsp:role ' + role + ' ;\n'
    + (args.revoked ? '  wsp:revoked true ;\n' : '')
    + '  dct:created ' + created(args.createdIso) + ' .\n';
}

/**
 * A membership acceptance. The other half of a seat, on the member's OWN pod.
 *
 * ★ `wsp:accepts` IS A URL YOU CAN OPEN. It used to be the grant's DESCRIPTOR URL — an address
 * on the relay's internal storage host, which no reader outside the fleet can dereference. The
 * grant's own `/ns/` IRI goes here instead and the revision it was accepted at is pinned
 * separately in `wsp:acceptsCid`. The guarantee is unchanged: re-granting moves the head, the
 * CID stops matching, and the stale acceptance stops seating — see the two-form test in
 * `foldRoster`.
 */
export function acceptanceTurtle(args: {
  readonly acceptance: string;
  readonly workspace: string;
  readonly memberWebId: string;
  readonly grant: string;
  readonly grantCid: string | null;
  readonly stream: string;
  readonly createdIso?: string;
}): string {
  const acc = turtleIri(args.acceptance, 'the acceptance IRI');
  const ws = turtleIri(args.workspace, 'the workspace IRI');
  const me = turtleIri(args.memberWebId, 'your own WebID');
  const grant = turtleIri(args.grant, 'the grant IRI being accepted');
  const stream = turtleIri(args.stream, 'the stream IRI');
  return '@prefix wsp: <' + WSP + '> .\n'
    + '@prefix dct: <' + DCT + '> .\n'
    + '@prefix xsd: <' + XSD + '> .\n\n'
    + acc + '\n'
    + '  a wsp:MembershipAcceptance ;\n'
    + '  wsp:workspace ' + ws + ' ;\n'
    + '  wsp:member ' + me + ' ;\n'
    + '  wsp:accepts ' + grant + ' ;\n'
    + (args.grantCid ? '  wsp:acceptsCid "' + escapeTurtleLiteral(args.grantCid) + '" ;\n' : '')
    + '  wsp:stream ' + stream + ' ;\n'
    + '  dct:created ' + created(args.createdIso) + ' .\n';
}

/**
 * The canvas: ONE graph IRI with a supersession chain behind it.
 *
 * There is no canvas object on a server and no special type. What makes it a shared document is
 * the PRECONDITION on the write — see `saveCanvas`.
 */
export function canvasTurtle(args: {
  readonly canvas: string;
  readonly workspace: string;
  readonly slug: string;
  readonly body: string;
}): string {
  const c = turtleIri(args.canvas, 'the canvas IRI');
  const ws = turtleIri(args.workspace, 'the workspace IRI');
  return '@prefix dct: <' + DCT + '> .\n'
    + '@prefix dctype: <' + DCTYPE + '> .\n'
    + '@prefix wsp: <' + WSP + '> .\n\n'
    + c + '\n'
    + '  a dctype:Text ;\n'
    + '  wsp:workspace ' + ws + ' ;\n'
    + '  dct:title "Canvas — ' + escapeTurtleLiteral(args.slug) + '" ;\n'
    + '  dct:description "' + escapeTurtleLiteral(args.body) + '" .\n';
}
