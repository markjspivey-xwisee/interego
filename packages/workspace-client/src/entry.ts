/**
 * Composing and appending one entry to the viewer's OWN log, compare-and-swap safe.
 *
 * The whole of the CAS discipline lives here so that the artifact and the desktop shell make
 * the same assertions and report the same outcomes. What is left to a shell is drawing them.
 */

import { footingTurtle, type StatedFooting } from '@interego/core/delegate';
import { escapeTurtleLiteral, IEP, PROV, WSP } from './turtle.js';
import { shortRef } from './format.js';
import { type ChainRow, orderChain, toChainRow } from './chain.js';
import type { WorkspaceClient, WorkspaceRecord } from './substrate.js';
import { refusal } from './transport.js';

/**
 * WHO COMPOSED THIS ENTRY, AND — SEPARATELY — WHAT FOOTING THEY WERE ON.
 *
 * ★ TWO CASES FOR THE AUTHOR, AND THE RECORD MUST NOT COLLAPSE THEM.
 *
 *  · `principal` — the person wrote these words. That covers the composer in the desktop shell
 *    AND the Discord bot relaying a message somebody typed: the bot is a conduit carrying their
 *    own speech, so the entry is theirs and is attributed to them. Nothing about the conduit
 *    belongs in the author position.
 *  · `delegate` — an agent the person authorised composed these words, and the person did not
 *    write them. The agent is the author.
 *
 * ★ AND A THIRD FACT THAT IS NOT THE AUTHOR AND WAS BEING WRITTEN AS IF IT FOLLOWED FROM THEM.
 * A delegate is ALWAYS the delegate of a specific human — that is standing, it lives on that
 * human's pod, and they revoke it. Whether a PARTICULAR sentence was said FOR them is a different
 * question with a different answer each time, and this type now makes a caller answer it: an agent
 * may speak for its human, in which case the human shares responsibility for what was said, or on
 * its own account, in which case the agent alone is answerable. Every entry used to declare the
 * first regardless, which laundered an agent's own positions into its delegator's.
 *
 * ★ NEITHER FIELD IS OPTIONAL, AND THAT IS THE POINT. If a delegate-authored entry declared its
 * footing and a human-authored one said nothing, then "nothing" would have to be read as one of
 * them — and absence is not evidence. Every entry this client writes states both, so a record that
 * states neither is a finding about that record rather than a default in anybody's favour. A READER
 * still has three answers (see `EntryFooting`); a WRITER has two, because a client that could write
 * an unfooted delegate entry would be a client that creates the ambiguity on purpose.
 */
export type EntryAuthor =
  | { readonly kind: 'principal'; readonly webId: string }
  | { readonly kind: 'delegate'; readonly agentId: string; readonly footing: StatedFooting };

/**
 * The Turtle for one entry.
 *
 * ★ EVERY INTERPOLATED IRI IS GUARDED AND EVERY LITERAL IS ESCAPED. An IRI reference ends at
 * the first `>`, so an unchecked IRI can close the reference and write a triple its author was
 * never authorised to assert. There is no escape for `>` in Turtle's IRIREF production — there
 * is nothing to escape it to — so the only correct handling is refusal. The author's identifier
 * is one of these: for a delegate it is a DID this client did not mint, and for a principal it
 * is a WebID read off a pod.
 *
 * ★ THE FOOTING BLOCK IS THE SUBSTRATE'S TRIPLES, NOT THIS FILE'S. `footingTurtle` composes them:
 * `prov:qualifiedDelegation` to a named `prov:Delegation` whose `prov:hadActivity` is this entry's
 * own act, or `iep:actedOnOwnAccount` over that same act. Which triples say "on this person's
 * behalf" is an Interego answer — the conduit, the shell and any later vertical must write the same
 * ones or a reader crossing two of them gets two answers to one question. What stays here is the
 * `wsp:Entry` itself. The guard above is handed down rather than copied, so there is one spelling
 * of the IRIREF rule in this path and it is the one that can name which argument was bad.
 */
export function entryTurtle(args: {
  readonly streamIri: string;
  readonly workspace: string;
  readonly seq: number;
  readonly body: string;
  readonly prior: string | null;
  readonly author: EntryAuthor;
  readonly createdIso?: string;
}): string {
  const iri = (u: string, what: string): string => {
    if (typeof u !== 'string' || !u) throw new Error('entryTurtle: ' + what + ' is missing, so this entry is refused rather than written without it');
    if (/[\s<>"{}|\\^`]/.test(u)) throw new Error('entryTurtle: ' + what + ' is not serializable as a Turtle IRI reference: ' + u);
    return '<' + u + '>';
  };
  if (!Number.isInteger(args.seq) || args.seq < 0) throw new Error('entryTurtle: seq must be a non-negative integer, got ' + String(args.seq));
  const entryIri = args.streamIri + '/e/' + args.seq;
  const subject = iri(entryIri, 'the entry IRI');
  const workspace = iri(args.workspace, 'the workspace IRI');
  const prior = args.prior === null ? null : iri(args.prior, 'the prior head');
  const a = args.author;
  const author = a.kind === 'delegate'
    ? iri(a.agentId, 'the delegate agent id this entry is attributed to')
    : iri(a.webId, 'the WebID this entry is attributed to');
  const created = args.createdIso ?? new Date().toISOString();
  // A person composing their own words has no footing question to answer — there is no second
  // agent for a delegation to be between — so nothing is written for them, and nothing is implied.
  const footing = a.kind === 'delegate'
    ? footingTurtle({ entryIri, agentId: a.agentId, footing: a.footing, iri, endedIso: created })
    : null;
  return '@prefix wsp: <' + WSP + '> .\n'
    + '@prefix iep: <' + IEP + '> .\n'
    + '@prefix prov: <' + PROV + '> .\n'
    + '@prefix dct: <http://purl.org/dc/terms/> .\n'
    + '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n\n'
    + subject + '\n'
    + '  a wsp:Entry ;\n'
    + '  wsp:workspace ' + workspace + ' ;\n'
    + '  wsp:seq "' + args.seq + '"^^xsd:nonNegativeInteger ;\n'
    + (prior ? '  iep:supersedes ' + prior + ' ;\n' : '')
    + '  prov:wasAttributedTo ' + author + ' ;\n'
    + (footing ? footing.generatedBy : '')
    + '  dct:created "' + created + '"^^xsd:dateTime ;\n'
    + '  dct:description "' + escapeTurtleLiteral(args.body) + '" .\n'
    + (footing ? footing.blocks : '');
}

/**
 * A RETURNED PRECONDITION BLOCK IS DATA, NOT A VERDICT.
 *
 * Both write panels used to print "passed" from the PRESENCE of the field, without ever
 * comparing the two CIDs inside it — in a client whose whole argument is that an
 * acknowledgement is not a verification. The comparison is done here, once.
 *
 * MEASURED: this relay's block is `{ passed, expectedCid, observedCid }`. Its own `passed` is
 * reported as its CLAIM and the CID comparison as the CHECK; where the two disagree, that
 * disagreement is the finding and is printed. Returns null when nothing was sent, because
 * what "none" means differs per call site and each supplies its own sentence.
 */
export function preconditionLine(pc: unknown, sent: string | null, sentKind: string | null): string | null {
  if (pc && typeof pc === 'object') {
    const b = pc as { expectedCid?: string; observedCid?: string; passed?: unknown };
    const exp = b.expectedCid;
    const obs = b.observedCid;
    const said = typeof b.passed === 'boolean' ? b.passed : null;
    const claim = said === null ? 'the response reported no pass/fail flag' : 'the relay says passed:' + said;
    if (exp && obs) {
      const match = exp === obs;
      const dis = said !== null && said !== match
        ? ' — AND THESE DISAGREE: the flag and the CIDs in the same block do not say the same thing, so neither is being taken as the verdict'
        : '';
      return (match ? 'CIDs match' : 'CIDs DO NOT MATCH')
        + ' · expected ' + shortRef(exp) + ' · observed ' + shortRef(obs)
        + ' (compared here) · ' + claim + dis;
    }
    return 'the response returned a precondition block reporting '
      + (exp ? 'an expected CID and no observed one' : obs ? 'an observed CID and no expected one' : 'neither CID')
      + ', so there is nothing in it to compare — ' + claim + ', which is not being treated as a check';
  }
  return sent
    ? 'sent ' + shortRef(sent) + (sentKind ? ' (' + sentKind + ')' : '') + ', and the response did not report a precondition result'
    : null;
}

/**
 * FOUR ANSWERS ABOUT THE ENTRY SHAPE, NOT TWO.
 *
 * "The record names this shape" and "the record was read and names none" were the only two
 * this could say, so a post made before the record had been read reported the SECOND — a
 * positive statement about a document nobody had opened, on a workspace that does name one.
 * Absence is not evidence, and "not read yet" is its own answer.
 */
export function entryShapeAnswer(
  shape: string | null,
  record: { readonly kind: 'record'; readonly record: WorkspaceRecord } | { readonly kind: 'forked'; readonly heads: readonly unknown[] } | { readonly kind: 'missing' } | { readonly kind: 'error' } | null,
  workspaceIri: string,
): string {
  if (shape) return shape;
  if (!record) return 'the workspace record has not been read, so whether it names a wsp:entryShape is not established — nothing validated this entry';
  if (record.kind === 'error') return 'the read of the workspace record failed, so whether it names a wsp:entryShape is not established — nothing validated this entry';
  if (record.kind === 'forked') return 'the workspace record\'s chain has ' + record.heads.length
    + ' unresolved heads, so which record governs here — and therefore which shape, if any — is not decided; nothing validated this entry';
  if (record.kind === 'missing') return 'no workspace record is published at ' + workspaceIri
    + ', so there is no wsp:entryShape to send and nothing validated this entry';
  return 'this workspace\'s record was read and names no wsp:entryShape, so nothing validated this entry';
}

/** Every way an append can end, kept apart because each licenses a different next move. */
export type PostOutcome =
  | { readonly kind: 'read-failed'; readonly error: unknown }
  /** Not one head. Picking one would be guessing which append survived, so nothing is posted. */
  | { readonly kind: 'forked'; readonly heads: number; readonly anyLinks: boolean }
  | { readonly kind: 'refused'; readonly code: number | null; readonly body: Record<string, unknown> }
  /** The relay did not answer. A write whose outcome is unknown must NOT be repeated. */
  | { readonly kind: 'unreachable'; readonly error: unknown; readonly relayAnswered: boolean }
  | {
      readonly kind: 'accepted';
      readonly descriptorUrl: string | null;
      readonly committed: boolean;
      readonly seq: number;
      readonly shapeSent: string | null;
      readonly ifMatch: string | null;
      readonly ifMatchKind: string | null;
      readonly response: Record<string, unknown>;
    };

/**
 * Append one entry to `streamIri` on `podName`, deriving position from the chain first.
 *
 * ★ ONE 412 RETRY, AND EXACTLY ONE. A 412 means somebody appended between the read and the
 * write, which is the ordinary case for a log and the right move is to re-derive and try
 * again. A second 412 is reported rather than retried: a client that retries indefinitely is
 * a client that will eventually write a duplicate.
 *
 * ★ AND `author` IS REQUIRED, WHICH IS THE WHOLE OF THE DELEGATE CORRECTION AT THIS LAYER.
 * There is still exactly ONE writer — a delegate that had its own would be a delegate whose
 * writes skipped the chain derivation, the 412 retry, the shape assertion and the readback.
 * What changes is that the writer now has to be TOLD who is speaking, so no caller can append
 * without having answered the question. `client` is whoever the relay authenticated: for a
 * principal that is their own session, and for a delegate it is the delegate's own — see
 * `delegates.ts`. The two must agree, and `podName` is the DELEGATOR's pod either way.
 */
export async function postEntry(
  client: WorkspaceClient,
  args: {
    readonly podName: string;
    readonly streamIri: string;
    readonly workspace: string;
    readonly body: string;
    readonly author: EntryAuthor;
    readonly entryShape: string | null;
    readonly onAttempt?: (attempt: number) => void;
  },
): Promise<PostOutcome> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    args.onAttempt?.(attempt);
    let rows: readonly ChainRow[];
    try {
      rows = (await client.manifest(args.podName, args.streamIri)).map(toChainRow);
    } catch (e) {
      return { kind: 'read-failed', error: e };
    }
    const ch = orderChain(rows);
    if (ch.forked) {
      // Two causes produce this shape and a manifest alone cannot tell them apart, so both are
      // named instead of inventing the dramatic one.
      return { kind: 'forked', heads: ch.heads, anyLinks: rows.some((r) => r.supersedes.length > 0) };
    }
    const prior = ch.ordered.length ? ch.ordered[ch.ordered.length - 1] as ChainRow : null;
    const seq = ch.ordered.length;
    const publishArgs: Record<string, unknown> = {
      // ★ THE APPEND LANDS ON THE POD THE CHAIN WAS READ FROM. `podName` used to drive only the
      // manifest read above; the publish named no pod and the relay filled it from the session.
      // For a client that is the pod owner those are the same pod and nothing showed. For a
      // client acting for SOMEBODY ELSE under a delegation they are never the same pod: the
      // sequence number, the prior head and the `if_match` were all derived from the member's
      // log, and the entry asserting them landed on the caller's own — a chain link pointing at
      // a descriptor on a different pod, and a member's log that stayed empty while the client
      // reported the append accepted.
      pod_name: args.podName,
      graph_iri: args.streamIri,
      graph_content: entryTurtle({ streamIri: args.streamIri, workspace: args.workspace, seq, body: args.body, prior: prior ? prior.url : null, author: args.author }),
      visibility: 'public',
      auto_supersede_prior: false,
      sign_authorship: true,
    };
    // ★ THE SHAPE IS THE WORKSPACE'S, NOT THIS CLIENT'S. A workspace that names none gets no
    // shape sent, and the caller says the post was not validated against anything rather than
    // implying it was.
    if (args.entryShape) publishArgs['conforms_to_shapes'] = [args.entryShape];
    // What is asserted may be the prior entry's content CID or, when the manifest reported
    // none for it, its descriptor URL. Which one it is gets recorded rather than described as
    // "that revision's content CID" either way — they are not the same assertion.
    let ifMatchKind: string | null = null;
    if (prior) {
      publishArgs['if_match'] = prior.cid ?? prior.url;
      ifMatchKind = prior.cid ? "the prior entry's content CID"
        : "the prior entry's descriptor URL — the manifest reported no CID for it";
    }

    let res: Record<string, unknown>;
    try { res = await client.tool('publish_context', publishArgs) as Record<string, unknown>; }
    catch (e) {
      // `tool_error` means the relay ANSWERED and reported a failure; only the transport codes
      // mean it did not answer. Copy that says "the relay did not answer" above an error box
      // titled "the relay reported a failure" is a client contradicting itself.
      return { kind: 'unreachable', error: e, relayAnswered: (e as { code?: string })?.code === 'tool_error' };
    }
    const bad = refusal(res);
    if (bad) {
      const code = typeof bad['code'] === 'number' ? bad['code'] as number : null;
      if (code === 412 && attempt < 2) continue;
      return { kind: 'refused', code, body: bad };
    }
    return {
      kind: 'accepted',
      descriptorUrl: (res['descriptorUrl'] as string) ?? null,
      committed: res['status'] === 'committed',
      seq,
      shapeSent: args.entryShape,
      ifMatch: (publishArgs['if_match'] as string) ?? null,
      ifMatchKind,
      response: res,
    };
  }
  /* istanbul ignore next — the loop returns on every path; this satisfies the compiler. */
  return { kind: 'refused', code: 412, body: { error: 'precondition_failed' } };
}
