/**
 * How a member that is a PROCESS tells a workspace it can be asked to do something.
 *
 * ── THE HOLE THIS FILLS ──────────────────────────────────────────────────────
 *
 * The published artifact has had an "ask this member" control since the round that built it.
 * The way it decides whether to offer that control is to look on the member's OWN pod for a
 * document at `<convener pod>--<slug>-affordances`, read an `iep:action` out of it, and follow
 * that action through the relay's `invoke_affordance`. Nothing about the control is written by
 * the page: whether it exists, what it is called and what it invokes all come out of that
 * document.
 *
 * ★ AND NOTHING IN THIS REPOSITORY EVER WROTE ONE. Every member in every test workspace was
 * either a person (who publishes no endpoint, correctly) or an agent whose bridge advertises
 * its capability at its OWN deployment URL — a manifest at `/affordances` that the workspace
 * page never looks at, because a workspace member is addressed by their pod and not by a
 * hostname. So the control was never offered, the call was never made, and the artifact was
 * published carrying a request shape that had never been observed against the live relay.
 *
 * ── WHY THE DOCUMENT LIVES ON THE MEMBER'S POD AND NOT ANYWHERE ELSE ─────────
 *
 * The same reason the log does. A capability advertised in the convener's workspace record
 * would be the convener saying what another participant will do; a capability advertised only
 * at the bridge's own hostname is reachable by whoever already knows the hostname, which is
 * not what a workspace member is. Published here it is a signed statement, by the member,
 * about the member, at an address derived from the workspace they are in — and it disappears
 * from the workspace the moment they stop publishing it, without anyone else's cooperation.
 *
 * ★ THE TARGET IS RE-RESOLVED AT INVOCATION AND THIS IS NOT DECORATION. `invoke_affordance`
 * dereferences the descriptor and reads `hydra:target` out of the signed graph at execution
 * time. A caller therefore cannot redirect the call by supplying a target, and a member can
 * move their endpoint by republishing this one document.
 */

// IEP and WSP are IMPORTED, not restated. Both namespaces are already spelled once in
// `@interego/workspace-client`, and a second spelling here is the shape of drift that puts a
// document at an IRI no reader of the first spelling resolves.
import { escapeTurtleLiteral, IEP, WSP } from '@interego/workspace-client';
import type { StreamDeps } from './stream.js';

const DCT = 'http://purl.org/dc/terms/';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';

/**
 * One IRI reference, or a throw naming which argument was not serialisable.
 *
 * ★ REFUSAL, NOT ESCAPING, AND THE REASON IS THE SAME AS IN `documents.ts`. A Turtle IRI
 * reference ends at the first `>` and the production has no escape for one, so an action IRI
 * or a target containing `>` would close the reference and every byte after it would parse as
 * further triples — in a document published under this agent's own signature. The `target`
 * here is the most exposed of the three: it is composed from a deployment URL supplied by
 * whoever runs the process, and a bridge deployed behind a URL somebody else chose would
 * otherwise be a triple-injection vector into its own capability document.
 */
function iriRef(u: string, what: string): string {
  if (typeof u !== 'string' || u === '') {
    throw new Error(`advertise: ${what} is missing, so the capability document cannot be written`);
  }
  if (/[\s<>"{}|\\^`]/.test(u)) {
    throw new Error(`advertise: ${what} is not serializable as a Turtle IRI reference and there is no escape `
      + `for the characters in it, so this document is refused rather than written with a reference that `
      + `ends somewhere else: ${u}`);
  }
  return `<${u}>`;
}

export interface CapabilityDraft {
  /** The document's own IRI — `<relay>/ns/<member pod>/<convener pod>--<slug>-affordances`. */
  readonly iri: string;
  /** The workspace this capability is offered in. */
  readonly workspace: string;
  /** The `iep:action` a client names when invoking. Dereferenceable, per the URL-identifier rule. */
  readonly action: string;
  /** The HTTP endpoint the relay POSTs to once it has resolved this document. */
  readonly target: string;
  /** What a reader shows on the control. Read from here, never composed by the page. */
  readonly title: string;
  readonly description: string;
  readonly createdIso?: string;
}

/**
 * The capability document, as Turtle.
 *
 * The subject is the document's own IRI because that is the region an `/ns/` reader locates:
 * the artifact calls `graphRegion(content, iri)` and then reads `iep:action` and
 * `hydra:target` out of what that returns. A document whose statements hung off some other
 * subject would publish, dereference, and read as "this member advertises nothing".
 */
export function capabilityTurtle(draft: CapabilityDraft): string {
  const self = iriRef(draft.iri, 'the capability document IRI');
  const ws = iriRef(draft.workspace, 'the workspace IRI');
  const action = iriRef(draft.action, 'the action IRI');
  const target = iriRef(draft.target, 'the hydra:target, which comes from this deployment\'s own configuration');
  const created = draft.createdIso ?? new Date().toISOString();
  return `@prefix iep: <${IEP}> .\n`
    + `@prefix hydra: <${HYDRA}> .\n`
    + `@prefix dct: <${DCT}> .\n`
    + `@prefix wsp: <${WSP}> .\n`
    + '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n'
    + `${self}\n`
    + '  a iep:Affordance, hydra:Operation ;\n'
    + `  wsp:workspace ${ws} ;\n`
    + `  iep:action ${action} ;\n`
    + `  hydra:target ${target} ;\n`
    + '  hydra:method "POST" ;\n'
    + `  hydra:title "${escapeTurtleLiteral(draft.title)}" ;\n`
    + `  dct:description "${escapeTurtleLiteral(draft.description)}" ;\n`
    + `  dct:created "${created}"^^xsd:dateTime .\n`;
}

export type AdvertiseOutcome =
  | { readonly outcome: 'published'; readonly iri: string; readonly descriptorUrl: string | null; readonly status: string }
  | { readonly outcome: 'refused'; readonly iri: string; readonly message: string };

/**
 * Publish the capability document on the agent's own pod.
 *
 * ★ NO `pod_name`, DELIBERATELY, AND FOR THE SAME REASON `agent-session.ts` has none. The
 * relay resolves this bearer to exactly one pod; a `pod_name` argument here would make the
 * pod a caller's choice, and a capability document is a statement about WHO can be asked —
 * the one field that must not be pointable at somebody else.
 *
 * Signed, because an unsigned capability document is an unattributable instruction to POST
 * somewhere. The bytes are immutable once published and the key moves on, so a document that
 * was not signed at write time can never be attributed afterwards.
 */
export async function publishCapability(
  draft: CapabilityDraft,
  // `Pick`, not the whole `StreamDeps`. This writes one document and reads nothing, so asking
  // for `discover` / `getDescriptor` / `currentHead` / `fetchDocument` would force every caller
  // to supply four functions it will not call — and the driver that did exactly that reached
  // for `as never` to get past the compiler, which is a cast that would have hidden a genuine
  // signature change just as effectively as it hid the four unused fields.
  deps: Pick<StreamDeps, 'publish'>,
): Promise<AdvertiseOutcome> {
  const res = await deps.publish({
    graph_iri: draft.iri,
    graph_content: capabilityTurtle(draft),
    visibility: 'public',
    // The page reads the CURRENT head of this IRI, so republishing must move the head rather
    // than fork it. There is no chain to preserve here — unlike a log, a capability document
    // has no history a reader walks — so the substrate's own supersession is the right one.
    auto_supersede_prior: true,
    // ★ NO `conforms_to_shapes`, ON PURPOSE. The sibling writers pass `[WSP_SHAPES]` because
    // that file constrains exactly what they emit — wsp:Entry, wsp:MembershipGrant,
    // wsp:MembershipAcceptance. It says nothing about a capability document, so declaring
    // conformance to it here would put a green "validated" on a gate that targets no node in
    // this graph and could not fail. When a shape for this document exists, name it.
    sign_authorship: true,
  });
  if (res['error'] !== undefined) {
    return { outcome: 'refused', iri: draft.iri, message: String(res['message'] ?? res['error']) };
  }
  const descriptorUrl = typeof res['descriptorUrl'] === 'string' ? res['descriptorUrl'] : null;
  return { outcome: 'published', iri: draft.iri, descriptorUrl, status: String(res['status'] ?? 'ok') };
}
