/**
 * Membership as PUBLISHED RECORDS: the producer the field-binding gap was waiting on.
 *
 * ── WHAT WAS MISSING, AND WHY IT COULD NOT BE PATCHED IN THE FOLD ────────────
 *
 * `roster.ts` binds a SIGNER TO A RECORD. It has never bound a record to the FIELDS
 * CLAIMED FOR IT, because `Grant` and `Acceptance` arrived as caller-typed JavaScript
 * objects with an {@link Attestation} sitting beside them covering none of their fields.
 * Hand the fold one of a member's ordinary published log entries as their "acceptance" —
 * genuinely signed, genuinely bound to its own descriptor, genuinely content-bound,
 * because it really is their unmodified record — and they became an attested member of a
 * workspace they had never heard of, at whatever role the caller typed.
 *
 * The fold could not fix that. It is pure, and the missing evidence is a document: nothing
 * in this repo had ever WRITTEN a `wsp:MembershipGrant` or a `wsp:MembershipAcceptance`, so
 * there was no content to compare the typed fields against and no value other than
 * `'unbound'` that `Roster.recordFieldBinding` could honestly report. The published shapes
 * described records no code produced.
 *
 * This module produces them, reads them back, and parses the fields FROM THE PAYLOAD. A
 * `Grant` that comes out of {@link readGrantRecord} carries no field its caller chose: the
 * grantee, the role, the workspace and the revocation flag are all read out of the bytes the
 * signer signed. That is the whole point, and it is what {@link FieldProvenance} records.
 *
 * ── WHY THE PAYLOAD AND THE BINDING VERDICT MUST COME FROM ONE READ, AND FROM ONE REGION ──
 *
 * `get_descriptor` computes `authorship.contentBinding` by digesting the very
 * `graph.content` it returns in the same response — `observedGraphDigest({graphContent:
 * graph?.content, descriptorTurtle: turtle})` in the relay's handler. So one call yields both
 * the bytes and the verdict about those bytes, and `'bound'` means precisely "the triples
 * parsed below are the triples the signer signed". Fetching the payload in one call and the
 * attestation in another would let a pod change in between and quietly decouple the two,
 * which would leave field binding asserting something nobody checked. Hence
 * `attestationOfResponse`, and hence exactly one `get_descriptor` per record here.
 *
 * ★ ONE READ IS NOT ENOUGH ON ITS OWN, AND ASSUMING IT WAS COST THIS MODULE ITS HEADLINE
 * PROPERTY FOR A ROUND. The argument above is about WHICH READ; it says nothing about WHICH
 * REGION OF THAT READ, and the relay digests only the `<graphIri> { … }` block of the
 * document it serves. Parsing the whole document therefore read fields out of bytes the
 * `'bound'` verdict said nothing about. See {@link payloadOf} — every field below now comes
 * from `digestedGraphRegion`, the same function the digester calls.
 *
 * ── AND THE THIRD RECORD, WHICH SAYS WHO WAS ENTITLED TO GRANT ───────────────
 *
 * The paragraph that used to close this header said the module answered *does this record say
 * what the fold was told it says* and not *is the signer of the grant entitled to grant here*
 * — because `AttestationPolicy.convener` was a value the caller typed and nothing fetched the
 * workspace to check `wsp:convener` against it.
 *
 * {@link readWorkspaceRecord} and {@link workspaceTurtle} are that missing pair, and the
 * blocker was the same one twice: `wspsh:WorkspaceShape` has always required exactly one
 * `wsp:convener`, and no code in this repo had ever written a `wsp:Workspace`. The convener a
 * policy claimed had nothing to be compared against. It does now, through the same publish
 * path, the same shape gate, the same one read and the same `digestedGraphRegion`.
 *
 * ── WHAT THIS STILL DOES NOT ESTABLISH ───────────────────────────────────────
 *
 * Read {@link readAcceptanceRecord}'s note before concluding anything about authority, and
 * {@link readWorkspaceRecord}'s before concluding anything about the convener. In short: every
 * reader here is handed a descriptor URL and reads what is at it. None of them dereferences a
 * logical name to find that URL, so a caller that was handed the wrong URL is told the truth
 * about the wrong document. That residue is the same one `head` carries under a `slug-only`
 * binding, and it is residual gap 1.
 */

import {
  escapeTurtleLiteral, turtleIriRef, turtlePrefixedLocal,
  parseTrig, findSubjectsOfType,
  // ★ THE SAME FOLLOWER THE RELAY'S SHAPE GATE USES, composed rather than reimplemented. Our
  // own ontology IRIs answer 200 `text/html` — GitHub Pages ignores Accept — and every page we
  // publish advertises its Turtle with a `rel=alternate`. A second regex over untrusted markup
  // here is the duplication `alternate-turtle.ts` was carved out of the relay to prevent; see
  // the hop in `dereferenceRoleProfile`.
  followAlternateTurtle,
  type ParsedSubject, type ParsedTerm,
} from '@interego/core';
// ★ THE SAME FUNCTION THE RELAY'S DIGESTER CALLS. See `payloadOf`: a reader that decided the
// digested region for itself decided it wider than the digester did, and the difference was
// a manufactured participant.
import { digestedGraphRegion } from '@interego/solid';
import {
  WSP, WSP_SHAPES, attestationOfResponse, rejectExtraTriple,
  type StreamDeps,
} from './stream.js';
import type {
  Attestation, Grant, Acceptance, Principal, WorkspaceRecord, ConvenerEvidence,
  RoleDefinition, RoleProfileDocument, RoleTableEvidence,
  FieldProvenance as FieldProvenanceValue,
  EvidenceProvenance as EvidenceProvenanceValue,
} from './roster.js';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

/** The three record classes, and every predicate this module writes or reads. */
export const WSP_TERMS = {
  MembershipGrant: `${WSP}MembershipGrant`,
  MembershipAcceptance: `${WSP}MembershipAcceptance`,
  /**
   * ★ THE CLASS THAT MADE THE OTHER TWO CHECKABLE. `wspsh:WorkspaceShape` has always required
   * exactly one `wsp:convener` and exactly one `wsp:roleProfile`, and nothing in this repo had
   * ever written one — so the convener a policy claimed had nothing to be compared against and
   * `AttestationPolicy.convener` stayed a value the caller typed. Same story as the two
   * membership halves one round earlier: the shape described a record no code produced.
   */
  Workspace: `${WSP}Workspace`,
  /**
   * ★ THE FOURTH CLASS, AND THE ONE THE OTHER THREE ALL POINT AT WITHOUT ANYBODY READING IT.
   * `wsp:roleProfile` names a document; `permitsOf` in the fold is built from a table the CALLER
   * supplies and claims came from it. Nothing had ever opened that document, which was residual
   * gap 10. Unlike the other three, this class is NOT written by anything here — a role profile
   * is published governance, not a record this layer mints — so only the reading half exists.
   */
  RoleProfile: `${WSP}RoleProfile`,
  Role: `${WSP}Role`,
  permits: `${WSP}permits`,
  convener: `${WSP}convener`,
  roleProfile: `${WSP}roleProfile`,
  workspace: `${WSP}workspace`,
  grantedTo: `${WSP}grantedTo`,
  role: `${WSP}role`,
  revoked: `${WSP}revoked`,
  /**
   * ★ THE TERM THE PUBLISHED SHAPE USED NOT TO REQUIRE, AND NOW DOES.
   * `wspsh:MembershipAcceptanceShape` constrained `wsp:accepts`, `wsp:stream`,
   * `wsp:workspace` and `wsp:withdrawn` and said nothing about who was accepting, so the
   * publish gate admitted an acceptance attributed to nobody while
   * {@link readAcceptanceRecord} refused one. The guarantee rested on THIS reader rather
   * than on the contract we publish, which made publishing the shape an invitation to check
   * less than we check.
   *
   * `docs/applications/shared-workspace/wsp-shapes.ttl:103-115` now carries
   * `sh:minCount 1 ; sh:maxCount 1 ; sh:nodeKind sh:IRI ; sh:pattern "^https?://|^did:"` on
   * `wsp:member`. That is a live change to a deployed artifact — the relay caches the shape
   * for 60s and `conforms_to_shapes` points at this URL — so it is pinned by
   * `acceptance-no-member`, `acceptance-two-members` and `acceptance-urn-member` in
   * `tools/shacl-agreement/fixtures/`, where both engines must agree.
   *
   * ★ AND THE ASYMMETRY THAT USED TO RUN BOTH WAYS IS CLOSED — ON THIS FIELD AND ON SIX MORE.
   * What stood here said `oneIri` applied no scheme pattern, so a `urn:` member was refused by
   * the published SHAPE and admitted by this READER, and called it the one field where the
   * shape is the stricter of the two. Measured rather than re-read, it was never one field:
   * the shape patterns `wsp:convener`, `wsp:roleProfile`, `wsp:workspace`, `wsp:grantedTo`,
   * `wsp:role` and `wsp:accepts` too, and the reader admitted `urn:` on all of them. See
   * {@link PUBLISHED_IRI_PATTERN}, which is now consulted for every term `oneIri` reads and
   * is compared against the published file by a test.
   */
  member: `${WSP}member`,
  accepts: `${WSP}accepts`,
  stream: `${WSP}stream`,
  withdrawn: `${WSP}withdrawn`,
} as const;

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Shared serializer for both halves.
 *
 * ★ Every interpolated value goes through `turtleIriRef`, and the rule is the same one
 * `entryTurtle` learned the hard way three times: an IRI reference ends at the first `>`,
 * so an unchecked IRI can close the reference and write a triple its author was never
 * authorised to assert. `turtleIriRef` REFUSES rather than escaping, because Turtle's
 * IRIREF production has no escape for `>` — there is nothing to escape it to.
 *
 * That guard matters more here than it did on a log entry. These are authorization records:
 * a grant that could be made to carry a second `wsp:grantedTo`, or an `acl:agent` triple
 * about a third party, would be a membership forged through string concatenation.
 */
function membershipTurtle(args: {
  readonly subjectIri: string;
  readonly type: string;
  /** Predicate → IRI object, in emission order. Every one is guarded. */
  readonly iris: readonly (readonly [string, string])[];
  /** Predicate → boolean object, emitted only where the value is present. */
  readonly booleans: readonly (readonly [string, boolean | undefined])[];
  readonly supersedes?: string | null;
  readonly title?: string;
  readonly extraTriples?: readonly string[];
  /** Names the calling function in every error, so a refusal says which record was refused. */
  readonly what: string;
}): string {
  const guard = (iri: string, role: string): string => {
    const ref = turtleIriRef(iri);
    if (!ref) throw new Error(`${args.what}: ${role} is not serializable as a Turtle IRI: ${iri}`);
    return ref;
  };
  /**
   * A `wsp:` term as a prefixed name, derived from the SAME constant the reader matches on.
   *
   * ★ Deriving the local part rather than writing it out is what stops the writer and the
   * reader drifting: a serializer that emits `wsp:member` beside a reader looking for
   * `${WSP}memberOf` produces records that validate, publish, sign, and then read back as
   * "this acceptance does not say who is accepting" — a whole class of membership silently
   * failing to exist. One constant, both directions.
   */
  const term = (iri: string): string => {
    if (iri.startsWith(WSP)) {
      const local = turtlePrefixedLocal(iri.slice(WSP.length));
      if (local !== null) return `wsp:${local}`;
    }
    return guard(iri, 'a vocabulary term');
  };

  const lines: string[] = [
    `@prefix wsp: <${WSP}> .`,
    `@prefix iep: <${IEP}> .`,
    '@prefix dct: <http://purl.org/dc/terms/> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    guard(args.subjectIri, 'the record IRI'),
    `  a ${term(args.type)} ;`,
  ];

  for (const [predicate, object] of args.iris) {
    lines.push(`  ${term(predicate)} ${guard(object, `the object of <${predicate}>`)} ;`);
  }
  for (const [predicate, value] of args.booleans) {
    // ★ EMITTED ONLY WHERE PRESENT, and `false` is emitted as well as `true`. An absent
    // flag and an explicit `false` mean the same thing to the fold, but they do not mean
    // the same thing to a person auditing a chain: "this superseding grant deliberately
    // reinstates" is a statement, and dropping it would make a reinstatement look like a
    // record whose author had never considered revocation.
    if (value === undefined) continue;
    lines.push(`  ${term(predicate)} "${value ? 'true' : 'false'}"^^xsd:boolean ;`);
  }
  if (args.supersedes) {
    // Declared in the CONTENT rather than via auto_supersede_prior: exactly one link per
    // record, so a grant chain stays linear instead of growing a link to every ancestor.
    lines.push(`  iep:supersedes ${guard(args.supersedes, 'the prior head')} ;`);
  }
  if (args.title !== undefined) {
    lines.push(`  dct:title "${escapeTurtleLiteral(args.title)}" ;`);
  }
  // Same constraint as `entryTurtle.extraTriples`, for the same reason and with more at
  // stake: raw Turtle cannot be escaped, so anything that could end this statement or open
  // a new one is refused outright.
  for (const raw of args.extraTriples ?? []) {
    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    const rejection = rejectExtraTriple(trimmed);
    if (rejection !== null) {
      throw new Error(
        `${args.what}: extraTriples must be ONE predicate-object pair for the record itself `
        + `— ${rejection}: ${trimmed.slice(0, 80)}`,
      );
    }
    lines.push(`  ${trimmed} ;`);
  }

  const last = lines[lines.length - 1]!;
  lines[lines.length - 1] = last.replace(/ ;$/, ' .');
  return lines.join('\n') + '\n';
}

/**
 * Render the workspace itself — the record that says who may issue the grants below.
 *
 * ★ `title` IS REQUIRED HERE AND OPTIONAL ON THE OTHER TWO, and that is the published shape
 * speaking rather than a preference. `wspsh:WorkspaceShape` carries `sh:minCount 1` on
 * `dct:title` (the grant and acceptance shapes carry none), so a workspace without one is
 * refused at 422 before it reaches a pod. Typing it as required turns a runtime refusal from
 * the substrate into a compile error here, which is the cheaper place to find it.
 *
 * ★ AND THE SUBJECT IRI IS THE WORKSPACE'S OWN URL, not a name minted for the record. The fold
 * compares this subject against the workspace it is folding — see `WorkspaceRecord.workspace`
 * — so a record subject-named anything else is a record about a different workspace, whatever
 * URL it happens to be served from.
 */
export function workspaceTurtle(args: {
  /** The workspace's own dereferenceable URL. This becomes the record's subject. */
  readonly workspaceIri: string;
  readonly convener: Principal;
  readonly roleProfile: string;
  readonly title: string;
  readonly supersedes?: string | null;
  readonly extraTriples?: readonly string[];
}): string {
  return membershipTurtle({
    subjectIri: args.workspaceIri,
    type: WSP_TERMS.Workspace,
    iris: [
      [WSP_TERMS.convener, args.convener],
      [WSP_TERMS.roleProfile, args.roleProfile],
    ],
    // A workspace record has no restriction flag: there is no `wsp:revoked` for a convener,
    // and a workspace is unmade by superseding it rather than by carrying a boolean.
    booleans: [],
    supersedes: args.supersedes,
    title: args.title,
    extraTriples: args.extraTriples,
    what: 'workspaceTurtle',
  });
}

/** Render half a membership — the convener's half — as a `wsp:MembershipGrant`. */
export function grantTurtle(args: {
  readonly grantIri: string;
  readonly workspace: string;
  readonly grantedTo: Principal;
  readonly role: string;
  readonly revoked?: boolean;
  readonly supersedes?: string | null;
  readonly title?: string;
  readonly extraTriples?: readonly string[];
}): string {
  return membershipTurtle({
    subjectIri: args.grantIri,
    type: WSP_TERMS.MembershipGrant,
    iris: [
      [WSP_TERMS.workspace, args.workspace],
      [WSP_TERMS.grantedTo, args.grantedTo],
      [WSP_TERMS.role, args.role],
    ],
    booleans: [[WSP_TERMS.revoked, args.revoked]],
    supersedes: args.supersedes,
    title: args.title,
    extraTriples: args.extraTriples,
    what: 'grantTurtle',
  });
}

/**
 * Render the other half — the member's own — as a `wsp:MembershipAcceptance`.
 *
 * `accepts` must be the grant's DESCRIPTOR URL, which is what the fold matches against
 * `Grant.head` and what {@link readGrantRecord} was read from. Not the grant's graph IRI:
 * the two differ, and matching on the wrong one produces an acceptance that answers nothing
 * while looking complete.
 */
export function acceptanceTurtle(args: {
  readonly acceptanceIri: string;
  readonly workspace: string;
  readonly member: Principal;
  readonly accepts: string;
  readonly stream: string;
  readonly withdrawn?: boolean;
  readonly supersedes?: string | null;
  readonly title?: string;
  readonly extraTriples?: readonly string[];
}): string {
  return membershipTurtle({
    subjectIri: args.acceptanceIri,
    type: WSP_TERMS.MembershipAcceptance,
    iris: [
      [WSP_TERMS.workspace, args.workspace],
      [WSP_TERMS.member, args.member],
      [WSP_TERMS.accepts, args.accepts],
      [WSP_TERMS.stream, args.stream],
    ],
    booleans: [[WSP_TERMS.withdrawn, args.withdrawn]],
    supersedes: args.supersedes,
    title: args.title,
    extraTriples: args.extraTriples,
    what: 'acceptanceTurtle',
  });
}

// ── Publishing ───────────────────────────────────────────────────────────────

/** How long {@link publishMembershipRecord} waits for its own record to become readable. */
export const MEMBERSHIP_VISIBILITY_BUDGET_MS = 30_000;
const MEMBERSHIP_POLL_MS = 500;

export type PublishOutcome =
  | {
      readonly outcome: 'published';
      /** The record's dereferenceable identity, and what an acceptance's `accepts` names. */
      readonly descriptorUrl: string;
      readonly visibleAfterMs: number;
      /** See `AppendSigning` in stream.ts — a record published unsigned can never acquire a proof. */
      readonly signed: boolean | null;
      readonly note: string;
    }
  /**
   * Accepted, not yet readable. Distinct from success for the same reason `appendEntry`
   * makes the distinction: the next thing anyone does with a membership record is read it
   * back, and a caller that treated acceptance as visibility would conclude the record does
   * not exist and write a second one — two heads on an authorization chain, which the fold
   * then has to intersect.
   */
  | { readonly outcome: 'pending'; readonly descriptorUrl: string; readonly waitedMs: number; readonly message: string }
  | { readonly outcome: 'refused'; readonly code: number; readonly message: string };

/**
 * Publish one membership record and wait until it can actually be read back.
 *
 * ★ THE WAIT IS NOT POLITENESS. `publish_context` is DEFERRED unless `compliance`, `sync` or
 * `if_match` is set — `sign_authorship` does NOT force the synchronous path — so it returns
 * `status: "pending"` with a PREDICTED descriptorUrl and the record lands a few seconds
 * later. `verify-can-live.ts` learned this the expensive way: three records were published,
 * read back immediately, every read failed, and the fold refused both the genuine and the
 * forged acceptance. The section's two headline assertions passed for entirely the wrong
 * reason. A record nobody can read is not evidence of anything, in either direction.
 */
export async function publishMembershipRecord(args: {
  readonly graphIri: string;
  readonly graphContent: string;
  readonly podName?: string;
  readonly agentDid?: string;
  /** Gate the write on a known prior head, when superseding one. */
  readonly ifMatch?: string;
  readonly budgetMs?: number;
}, deps: StreamDeps): Promise<PublishOutcome> {
  const res = await deps.publish({
    graph_iri: args.graphIri,
    graph_content: args.graphContent,
    visibility: 'public',
    auto_supersede_prior: false,
    // The shape gate runs BEFORE any pod write, so a malformed membership never lands even
    // briefly — a grant naming two principals is refused at 422 rather than becoming a
    // record a reader has to decide what to do with.
    conforms_to_shapes: [WSP_SHAPES],
    // Without this the record cannot be attributed to anyone, ever: the bytes are immutable
    // and the key moves on, so an unsigned membership record is unattributable forever.
    sign_authorship: true,
    ...(args.ifMatch ? { if_match: args.ifMatch } : {}),
    ...(args.podName ? { pod_name: args.podName } : {}),
    ...(args.agentDid ? { agent_did: args.agentDid } : {}),
  });

  const code = typeof res.code === 'number' ? res.code : null;
  if (res.error !== undefined) {
    return { outcome: 'refused', code: code ?? 0, message: String(res.message ?? res.error) };
  }
  const descriptorUrl = typeof res.descriptorUrl === 'string' ? res.descriptorUrl : '';
  if (descriptorUrl === '') {
    return {
      outcome: 'refused', code: code ?? 0,
      message: 'publish_context returned no descriptorUrl, so the record has no identity to '
        + 'cite, read back, or accept. Treating that as success would produce an acceptance '
        + 'naming nothing.',
    };
  }

  // The relay catches a signing failure, warns, and publishes anyway — so `signed` is read
  // off the response rather than assumed from having asked. `null` means the relay said
  // nothing either way, which is not the same claim as "it did not sign".
  const authorship = res.authorship as Record<string, unknown> | undefined | null;
  const signed = authorship === undefined || authorship === null || typeof authorship.signed !== 'boolean'
    ? null
    : authorship.signed;

  const budget = args.budgetMs ?? MEMBERSHIP_VISIBILITY_BUDGET_MS;
  const clock = deps.now ?? Date.now;
  const started = clock();
  let waited = 0;
  for (;;) {
    if (deps.getDescriptor === undefined) {
      return {
        outcome: 'refused', code: 0,
        message: 'publishMembershipRecord needs a `getDescriptor` dependency to confirm the '
          + 'record became readable. Returning at acceptance would report a record nobody '
          + 'can read as published, which is how three live assertions passed vacuously.',
      };
    }
    let readable = false;
    try {
      const got = await deps.getDescriptor({ url: descriptorUrl });
      readable = got !== null && typeof got === 'object' && !Array.isArray(got) && got.error === undefined;
    } catch { readable = false; }
    if (readable) {
      return {
        outcome: 'published', descriptorUrl, visibleAfterMs: waited, signed,
        note: signed === true
          ? 'The relay reports the iep:authorshipProof was embedded.'
          : signed === false
            ? 'The relay REFUSED OR FAILED to sign and published anyway. This record is '
              + 'unattributable FOREVER and no attestation policy will ever admit it.'
            : 'The publish response did not say whether it signed. Read the record back '
              + 'before relying on its authorship.',
      };
    }
    waited = clock() - started;
    if (waited >= budget) {
      return {
        outcome: 'pending', descriptorUrl, waitedMs: waited,
        message: `The substrate accepted the record but it was not readable within ${budget}ms. `
          + 'Do NOT publish it again: a duplicate is a second head on an authorization chain, '
          + 'and the fold answers a fork with the INTERSECTION rather than a winner.',
      };
    }
    await (deps.sleep ? deps.sleep(MEMBERSHIP_POLL_MS) : new Promise<void>(r => { setTimeout(r, MEMBERSHIP_POLL_MS); }));
  }
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * What one `get_descriptor` established about a membership record.
 *
 * ★ `record` AND `problems` ARE BOTH POPULATED IN THE ORDINARY CASE OF A DAMAGED RECORD, and
 * that is not sloppiness — it is the restricting-track rule from `roster.ts` applied one
 * layer earlier. A record that fails to parse cleanly may still carry a REVOCATION or a
 * WITHDRAWAL, and dropping it here would delete a restriction before the fold ever saw it:
 * the reader would have quietly reinstated a member who had been removed, which is the exact
 * failure shape ("turning a check on grants more than leaving it off") that this area has
 * produced in four consecutive rounds.
 *
 * So `record` is null ONLY where there is nothing to fold at all — the payload is not of
 * this type, is unreadable, or names its subject ambiguously. Everything else comes back as
 * a record WITH its problems attached, and the fold's own gate decides what it may confer.
 */
export interface MembershipRead<T> {
  /** Null only when no record could be constructed at all. See the note above. */
  readonly record: T | null;
  /** Every reason this record is less than it should be. Empty on a clean read. */
  readonly problems: readonly string[];
  /** The substrate's verdict on who signed it, from the same response the fields came from. */
  readonly attestation: Attestation;
}

/**
 * Where a record's fields came from.
 *
 * Re-exported shape rather than a boolean, because "these fields were parsed" and "parsed
 * from WHICH record" are different claims and only the pair is worth anything. See
 * `refuseFieldBinding` in roster.ts for what the fold does with it.
 */
export type {
  FieldProvenance, WorkspaceRecord, ConvenerEvidence,
  // Produced here by `dereferenceWorkspaceRecord` and by nothing else, for the reason
  // `FieldProvenance` is produced here and by nothing else: it is a statement about an act of
  // reading, and only the thing that did the reading can make it honestly.
  EvidenceProvenance,
  // The fourth document, and the only one this module reads without ever writing: a role
  // profile is published governance, not a record this layer mints. See `dereferenceRoleProfile`.
  RoleProfileDocument, RoleTableEvidence,
} from './roster.js';

const problem = (s: string): string => s;

/**
 * ★★ THE ONE PLACE A {@link FieldProvenance} COMES INTO EXISTENCE IN THIS REPOSITORY.
 *
 * `FieldProvenance` is a branded type: it intersects a private-membered ambient class that
 * `roster.ts` does not export, so the literal `{source: 'payload', descriptor}` does not
 * typecheck anywhere — including here. Somebody has to make the first one, and this assertion
 * is that somebody. It is deliberately the ONLY one, so "who can claim a record's fields were
 * parsed from its own bytes" is answerable by grepping for `FieldProvenanceValue` rather than
 * by auditing every construction site of a `Grant`, an `Acceptance` and a `WorkspaceRecord`.
 *
 * ★ THE ARGUMENT IS THE DESCRIPTOR THE BYTES WERE ACTUALLY READ FROM, and every caller below
 * passes the `descriptorUrl` its own `fetchDescriptor` was given. Passing anything else is the
 * forgery, one call frame in from where the brand stopped it, and no type can prevent that here
 * — this file is the trusted producer, which is exactly what makes it worth keeping small.
 * `refuseFieldBinding` in `roster.ts` still compares the value against the row's `head`, so a
 * mismatch introduced here is caught there, in the ordinary way, by the check that predates
 * this brand.
 */
function parsedFromPayload(descriptor: string): FieldProvenanceValue {
  // `as unknown as` where a bare `as` would also compile — the branded type is assignable to
  // the plain pair, so tsc calls the two "comparable" and permits the shorter form. Neither
  // spelling is checked by anything, so the longer one is chosen for being unmistakable in a
  // diff: this is the line that manufactures the guarantee, and it should not read like a tidy
  // annotation.
  return { source: 'payload', descriptor } as unknown as FieldProvenanceValue;
}

/**
 * A {@link FieldProvenance} for a record whose conferring field WAS readable, and nothing
 * for one whose was not.
 *
 * ★ Shared by both readers so the rule cannot be applied to one half and forgotten on the
 * other — which is how a grant would end up field-bound on a role it never states while the
 * matching acceptance was correctly refused, and the roster would report
 * `recordFieldBinding: 'bound'` over the pair.
 */
function provenanceUnless(
  conferringFieldMissing: boolean,
  descriptor: string,
): { fieldProvenance?: FieldProvenanceValue } {
  return conferringFieldMissing ? {} : { fieldProvenance: parsedFromPayload(descriptor) };
}

/** Every object of `predicate` on `subject`, so multiplicity is visible rather than silently resolved. */
function termsOf(subject: ParsedSubject, predicate: string): readonly ParsedTerm[] {
  return subject.properties.get(predicate as never) ?? [];
}

/**
 * Exactly one IRI object, or a reason there is not.
 *
 * ★ NOT `readIriValue`, WHICH RETURNS THE FIRST MATCH. First-match on an authorization
 * record is last-write-wins wearing a different hat: a grant carrying two `wsp:grantedTo`
 * triples does not name a grantee, it names two, and picking whichever the parser emitted
 * first makes the membership depend on statement order inside a document. `roster.ts`
 * refuses to do that with duplicate role and scope rows; a reader must not undo it.
 *
 * The published shape's `sh:maxCount 1` refuses this at publish — but only for records
 * written through a publish path that ran the gate, and a reader that assumed every record
 * it meets came through its own front door would be assuming away the attack.
 */
/** Every predicate {@link oneIri} is asked for — the IRI-valued half of {@link WSP_TERMS}. */
type IriValuedTerm =
  | typeof WSP_TERMS.convener | typeof WSP_TERMS.roleProfile | typeof WSP_TERMS.workspace
  | typeof WSP_TERMS.grantedTo | typeof WSP_TERMS.role | typeof WSP_TERMS.member
  | typeof WSP_TERMS.accepts | typeof WSP_TERMS.stream;

/**
 * The `sh:pattern` the PUBLISHED shape puts on each of these predicates, copied verbatim.
 *
 * ★ WHY THIS TABLE EXISTS: THE READER AND THE CONTRACT DISAGREED, ON SEVEN FIELDS.
 *
 * The recorded defect was one field — "a `urn:` member passes `oneIri` where
 * `wspsh:MembershipAcceptanceShape` refuses it" — and it was filed low because the publish
 * gate validates first, so no such record reaches a pod through our own front door. Measured
 * before this table was written, against the readers rather than against the sentence, it was
 * never one field: `wsp-shapes.ttl` puts a scheme pattern on `wsp:convener`, `wsp:roleProfile`,
 * `wsp:workspace`, `wsp:grantedTo`, `wsp:role`, `wsp:member` AND `wsp:accepts`, and `oneIri`
 * applied none of them. A grant naming `<urn:example:ws>`, `<urn:example:who>` and
 * `<urn:example:role>` parsed clean with no problems at all, and so did a workspace record
 * declaring `<urn:example:conv>` and `<urn:example:roles>`. The row that said "this one field"
 * understated its own scope sevenfold — which is the same staleness the README's own ledger
 * keeps apologising for, in the ledger.
 *
 * ★ AND WHY IT IS A TABLE AND NOT ONE PATTERN. A single reader-wide rule would reintroduce the
 * disagreement pointing the other way: `wsp:role`, `wsp:accepts`, `wsp:workspace` and
 * `wsp:roleProfile` are `^https?://` only, so admitting `did:` on them would be looser than
 * the contract, and `wsp:stream` carries NO pattern at all, so refusing anything on it would
 * be stricter than the contract. Both directions are the same defect. The values are the
 * shape's own strings so the comparison is exact, and `tests/workspace-membership.test.ts`
 * parses `docs/applications/shared-workspace/wsp-shapes.ttl` and asserts this table equals what
 * is published — the drift is a test failure rather than a paragraph nobody re-checks.
 *
 * `null` means the published shape constrains the scheme of this term and nothing else. It is
 * written out rather than omitted so that "the contract says nothing here" and "somebody
 * forgot this term" are different states; the type makes the second a compile error.
 */
const PUBLISHED_IRI_PATTERN: Record<IriValuedTerm, string | null> = {
  [WSP_TERMS.convener]: '^https?://|^did:',
  [WSP_TERMS.roleProfile]: '^https?://',
  [WSP_TERMS.workspace]: '^https?://',
  [WSP_TERMS.grantedTo]: '^https?://|^did:',
  [WSP_TERMS.role]: '^https?://',
  [WSP_TERMS.member]: '^https?://|^did:',
  [WSP_TERMS.accepts]: '^https?://',
  // No `sh:pattern` on `wsp:stream` in the published shape. A stream is named by whatever the
  // member's pod serves it at, and the shape deliberately does not narrow it — so neither does
  // this reader.
  [WSP_TERMS.stream]: null,
};

/** Exported for the drift test only; see {@link PUBLISHED_IRI_PATTERN}. */
export const WSP_PUBLISHED_IRI_PATTERNS: Readonly<Record<string, string | null>> = PUBLISHED_IRI_PATTERN;

function oneIri(subject: ParsedSubject, predicate: IriValuedTerm, label: string): { iri: string } | { why: string } {
  const terms = termsOf(subject, predicate);
  const iris = terms.filter((t): t is Extract<ParsedTerm, { kind: 'iri' }> => t.kind === 'iri');
  if (terms.length === 0) return { why: problem(`it carries no <${predicate}>, so it does not state ${label}`) };
  if (terms.length > 1) {
    return { why: problem(
      `it carries ${terms.length} <${predicate}> values, so it does not state ${label} — it `
      + 'states several, and choosing one would make the record mean whatever order its '
      + 'triples happened to be written in',
    ) };
  }
  if (iris.length !== 1) {
    return { why: problem(`its <${predicate}> is not an IRI, so ${label} is not dereferenceable`) };
  }
  const iri = iris[0]!.iri;
  const pattern = PUBLISHED_IRI_PATTERN[predicate];
  // `new RegExp(p).test(v)` and not an anchored match, because that is SHACL's own semantics
  // for `sh:pattern`: the constraint holds where the regex finds a match anywhere in the
  // lexical form. The published patterns anchor themselves with `^` on each alternative, so
  // the effect is a prefix test — but re-anchoring here would make this reader refuse a value
  // the gate admits, which is the disagreement one direction over.
  if (pattern !== null && !new RegExp(pattern).test(iri)) {
    return { why: problem(
      `its <${predicate}> is <${iri}>, which the published shape refuses (sh:pattern `
      + `"${pattern}"), so ${label} is not stated in a form anyone else can resolve. The gate `
      + 'refuses this at publish; a reader that admitted it would be checking less than the '
      + 'contract we publish, and a record read from a pod we do not control never passed that '
      + 'gate',
    ) };
  }
  return { iri };
}

/**
 * A boolean flag, read the SAFE way when it cannot be read at all.
 *
 * ★ AN UNREADABLE RESTRICTION FLAG READS AS SET. `wsp:revoked "yes"` is not a boolean, and
 * the tempting answers are both wrong: refusing the whole record deletes the revocation it
 * was probably trying to express, and coercing to `false` reinstates a member on the
 * strength of a typo. Erring towards removal is the direction `roster.ts` already chose and
 * for the same reason — a wrongly-removed member complains within the hour and a wrongly
 * retained one is why the revocation was written. The problem is reported either way, so the
 * reading is never silent.
 *
 * Absent is `undefined`, which is different again and genuinely means "this record says
 * nothing about revocation".
 */
function safeBoolean(
  subject: ParsedSubject, predicate: string, problems: string[],
): boolean | undefined {
  const terms = termsOf(subject, predicate);
  if (terms.length === 0) return undefined;
  if (terms.length > 1) {
    problems.push(problem(
      `it carries ${terms.length} <${predicate}> values; read as SET, because the safe reading `
      + 'of a contradictory restriction flag is the restricting one',
    ));
    return true;
  }
  const t = terms[0]!;
  if (t.kind === 'literal' && (t.datatype === undefined || t.datatype === XSD_BOOLEAN)) {
    if (t.value === 'true') return true;
    if (t.value === 'false') return false;
  }
  problems.push(problem(
    `its <${predicate}> is not a readable boolean (${t.kind === 'literal' ? JSON.stringify(t.value) : t.kind}); `
    + 'read as SET, because the safe reading of an unreadable restriction flag is the '
    + 'restricting one — coercing it to false would reinstate on the strength of a typo',
  ));
  return true;
}

/**
 * The bytes of this response the substrate's digest actually covered, or a reason there are
 * none to parse.
 *
 * ★ PARSE SCOPE MUST EQUAL DIGEST SCOPE, AND IT DID NOT. This used to hand `graph.content`
 * — the WHOLE served document — to `parseTrig`, while the relay digested only the
 * `<graphIri> { … }` block inside it. Everything outside that block was parsed and never
 * digested, so `contentBinding: 'bound'` was a statement about a strict subset of the bytes
 * these fields were read from. Measured: inserting a `wsp:MembershipAcceptance` subject into
 * the DEFAULT graph of a document whose block was a verbatim copy of one of a member's real
 * signed records left the digest at the identical
 * `graph-nquads-sha256:19b2cf81f1418ca3e13d1b5b7a7ebb090875b43e0c835cf2f1aa0c4527cde629`, and
 * the roster reported that member as a participant at the convener's chosen role with
 * `recordContentBinding: 'bound'`, `recordFieldBinding: 'bound'` and an empty `unattested` —
 * with no cooperation from the member at all. That is precisely the property this module
 * exists to establish, refuted by the module itself.
 *
 * It also ran the other way: one decoy `wsp:MembershipAcceptance` outside the block made an
 * honest acceptance read as "declares 2 … subjects" and vanish, while binding still said
 * `'bound'` — silent denial of membership through un-digested bytes.
 *
 * ★ SO THE REGION COMES FROM `digestedGraphRegion`, THE SAME FUNCTION THE DIGESTER CALLS,
 * with the same two strings out of the same response. Not a second call to
 * `extractNamedGraphTurtle`: the graph IRI has to be derived the same way too, and a reader
 * free to derive it its own way is a reader free to parse a region nobody digested.
 *
 * ★ AND THERE IS NO FALLBACK TO THE WHOLE DOCUMENT. The top-level `res.content` this used to
 * fall back to is exactly such bytes: `get_descriptor` digests `graph.content` and nothing
 * else, so a record served only as top-level content has no covered region and must be
 * refused rather than read. Refusing costs a reader that could otherwise have parsed a
 * payload; the fallback costs the whole guarantee.
 */
function payloadOf(res: Record<string, unknown>): { content: string } | { why: string } {
  const graph = res.graph as Record<string, unknown> | undefined | null;
  const graphContent = graph !== undefined && graph !== null && typeof graph.content === 'string'
    ? graph.content : null;
  const descriptorTurtle = typeof res.turtle === 'string' ? res.turtle : null;

  const region = digestedGraphRegion({ descriptorTurtle, graphContent });
  if (region.ok) return { content: region.turtle };

  // Three ordinary causes, kept apart because they send a reader to three different places.
  if (region.why === 'no-content') {
    return { why: problem(
      'get_descriptor returned no graph payload for this record, so there are no fields to '
      + 'read from it. The record may exist and be perfectly good — this says the reader '
      + 'could not see its content, which is not the same as the content being absent',
    ) };
  }
  if (region.why === 'no-graph-iri') {
    return { why: problem(
      'the descriptor does not say which graph it describes (no iep:describes), so there is '
      + 'no way to tell which region of the served document its signature covers. The fields '
      + 'are not read from bytes nobody can locate',
    ) };
  }
  return { why: problem(
    'the served document carries no named-graph block for the graph this descriptor '
    + 'describes, so no region of it is covered by the signed digest. Reading the fields out '
    + 'of the rest of the document would report values the substrate never digested — which '
    + 'is exactly how a record with a verbatim copy of somebody else\'s signed block, and a '
    + 'membership written outside it, passed as that person\'s own acceptance',
  ) };
}

/** One subject of `type` in the payload, or a reason there is not exactly one. */
function oneSubjectOfType(
  content: string, type: string, kind: string,
): { subject: ParsedSubject } | { why: string } {
  let subjects: readonly ParsedSubject[];
  try {
    subjects = findSubjectsOfType(parseTrig(content), type as never);
  } catch (err) {
    return { why: problem(`its payload is not parseable Turtle: ${err instanceof Error ? err.message : String(err)}`) };
  }
  if (subjects.length === 0) {
    // ★ THE BRANCH THAT KILLS THE MANUFACTURED PARTICIPANT. One of a member's ordinary
    // published log entries — genuinely signed, genuinely content-bound, genuinely theirs —
    // is a `wsp:Entry`, and it stops here. Before this module the same record was handed to
    // the fold as an `Acceptance` with the fields typed alongside it and became a
    // membership. Nothing about the record changed; what changed is that somebody finally
    // asked it what it says.
    return { why: problem(
      `its payload declares no <${type}>, so it is not ${kind} at all. A record can be `
      + 'genuinely signed, genuinely content-bound and genuinely its author\'s own and still '
      + 'not be this: that combination is exactly the manufactured participant, where the '
      + 'lie is in which record was submitted rather than in the record',
    ) };
  }
  if (subjects.length > 1) {
    return { why: problem(
      `its payload declares ${subjects.length} <${type}> subjects. Which one the record IS `
      + 'cannot be decided by a reader, and picking one would let the author choose the '
      + 'answer by ordering',
    ) };
  }
  return { subject: subjects[0]! };
}

/** rdf:type must be checked on the SUBJECT too — used to reject a bnode-subject record. */
function subjectIriOf(subject: ParsedSubject): string | null {
  return typeof subject.subject === 'string' ? subject.subject : null;
}

/**
 * The role table a `wsp:RoleProfile` document declares, or a reason there is none to read.
 *
 * ★ THE ROLES ARE COLLECTED FROM THE WHOLE DOCUMENT, NOT FROM THE PROFILE SUBJECT'S PROPERTIES,
 * and that is what the deployed artifact actually looks like rather than what would be tidy.
 * `docs/applications/shared-workspace/wsp-roles-default.ttl` declares its five `wsp:Role`s as
 * TOP-LEVEL SUBJECTS with no predicate linking them back to the `wsp:RoleProfile` — `wspr:
 * Convener a wsp:Role ; wsp:permits …`, and nothing on the profile pointing at it. A reader that
 * walked outwards from the profile subject would parse the published profile as declaring NO
 * ROLES AT ALL, refuse every honest fold, and be indistinguishable from a working check until
 * somebody read the file.
 *
 * ★ AND EXACTLY ONE `wsp:RoleProfile` IS REQUIRED, WHICH IS WHAT MAKES THIS A ROLE PROFILE AT
 * ALL. Without it any Turtle document carrying a `wsp:Role` would answer the question — the same
 * branch `oneSubjectOfType` calls "the one that kills the manufactured participant", one class
 * over. Two of them is refused rather than resolved: which profile the document IS cannot be
 * decided by a reader, and picking one would let the author choose by ordering.
 *
 * ★ A NON-IRI `wsp:permits` REFUSES THE WHOLE DOCUMENT rather than being skipped. Skipping would
 * silently NARROW the published table, and a narrower document makes the caller's table look
 * WIDER than it is — so a malformed capability would manufacture the exact disagreement this
 * check reports, on an honest profile. Refusing is loud; dropping is a wrong answer that looks
 * like a right one.
 */
function roleTableOf(content: string): { roles: RoleDefinition[] } | { why: string } {
  let doc;
  try {
    doc = parseTrig(content);
  } catch (err) {
    return { why: problem(`its payload is not parseable Turtle: ${err instanceof Error ? err.message : String(err)}`) };
  }
  const profiles = findSubjectsOfType(doc, WSP_TERMS.RoleProfile as never);
  if (profiles.length === 0) {
    return { why: problem(
      `it declares no <${WSP_TERMS.RoleProfile}>, so it is not a role profile at all. A document `
      + 'can be perfectly good Turtle, served from exactly the right URL, and still not be the '
      + 'governance this workspace declares — an HTML error page and somebody else\'s ontology '
      + 'both land here',
    ) };
  }
  if (profiles.length > 1) {
    return { why: problem(
      `it declares ${profiles.length} <${WSP_TERMS.RoleProfile}> subjects. Which profile the `
      + 'document IS cannot be decided by a reader, and picking one would let the author choose '
      + 'the answer by ordering',
    ) };
  }
  const roleSubjects = findSubjectsOfType(doc, WSP_TERMS.Role as never);
  if (roleSubjects.length === 0) {
    return { why: problem(
      `it declares a <${WSP_TERMS.RoleProfile}> and not one <${WSP_TERMS.Role}>, so it permits `
      + 'nothing to anybody. An empty table is not read as a permissive one — every grant in the '
      + 'workspace would name a role it does not declare',
    ) };
  }
  const roles: RoleDefinition[] = [];
  for (const subject of roleSubjects) {
    const iri = subjectIriOf(subject);
    if (iri === null) {
      return { why: problem(
        'one of its roles is a blank node, so it names no role at all. A grant names a role by '
        + 'IRI and the fold matches on that IRI; a role with no URL can never be the one a grant '
        + 'names, and reading the table around it would report a profile with a row nothing can '
        + 'reach',
      ) };
    }
    const terms = termsOf(subject, WSP_TERMS.permits);
    const nonIri = terms.filter(t => t.kind !== 'iri');
    if (nonIri.length > 0) {
      return { why: problem(
        `<${iri}> has a <${WSP_TERMS.permits}> value that is not an IRI, so what it permits is `
        + 'not a capability anything can be compared against. The whole document is refused '
        + 'rather than the value skipped: skipping narrows the published table, which makes an '
        + 'honest fold look as though it had widened it',
      ) };
    }
    roles.push({
      role: iri,
      permits: terms.map(t => (t as Extract<ParsedTerm, { kind: 'iri' }>).iri),
    });
  }
  return { roles };
}

/**
 * Read a `wsp:Workspace` back off a pod and parse who it says convenes it.
 *
 * ★ WHAT THIS EXISTS TO ANSWER. `AttestationPolicy.convener` is the principal every grant is
 * attested against, and it was a value the caller typed. A roster could be field-bound,
 * content-bound and signer-checked — both binding fields reporting `'bound'` — and be about
 * entirely the wrong memberships, because the party it treated as entitled to grant was
 * whoever the caller nominated. `verify-can-live.ts` §8 demonstrated it live: naming BEE as
 * convener changed the roster and the fold reported field binding as bound either way.
 *
 * A workspace IS a dereferenceable graph URL whose content declares `wsp:convener`, so the
 * answer was readable all along and nothing was reading it. Same treatment as the two
 * membership halves, through the same `payloadOf` and therefore the same digested region:
 * ONE `get_descriptor`, fields out of the bytes the substrate re-digested, provenance naming
 * the record they came from.
 *
 * ★ WHAT IT STILL DOES NOT ESTABLISH, and read this before extending the claim. This reader is
 * handed a descriptor URL; it does not dereference the workspace to find one. So what a caller
 * gets is "a record whose subject is <W> says X convenes it, and it is X's own signed record"
 * — not "this is what <W> resolves to". A caller that obtained the URL by dereferencing <W>
 * has both; a caller handed a URL by whoever assembled the fold has only the first. The
 * structurally identical residue on `head` is residual gap 1.
 */
export async function readWorkspaceRecord(
  descriptorUrl: string,
  deps: StreamDeps,
): Promise<MembershipRead<WorkspaceRecord>> {
  const got = await fetchDescriptor(descriptorUrl, deps);
  if ('why' in got) {
    return { record: null, problems: [got.why], attestation: got.attestation };
  }
  const { res, attestation } = got;
  const problems: string[] = [];

  const payload = payloadOf(res);
  if ('why' in payload) return { record: null, problems: [payload.why], attestation };
  const found = oneSubjectOfType(payload.content, WSP_TERMS.Workspace, 'a workspace');
  if ('why' in found) return { record: null, problems: [found.why], attestation };
  const subject = found.subject;

  // ★ THE SUBJECT IS THE WORKSPACE, so a record with no subject IRI is a record of no
  // workspace. Refused rather than read: the fold's whole use of this record is to compare
  // this value against the workspace it is folding, and a blank node compares to nothing —
  // which, left to the fold, would be a record that quietly matched no workspace and quietly
  // refused every roster it was handed to, for a reason nobody could see.
  const workspaceIri = subjectIriOf(subject);
  if (workspaceIri === null) {
    return { record: null, problems: [problem(
      'the workspace is a blank node, so it names no workspace at all. A workspace IS its URL '
      + '— the fold compares this subject against the workspace it is folding — and a record '
      + 'with no URL cannot be compared with anything',
    )], attestation };
  }

  const convener = oneIri(subject, WSP_TERMS.convener, 'who convenes it');
  const roleProfile = oneIri(subject, WSP_TERMS.roleProfile, 'which role profile governs it');
  for (const [field, r] of [['convener', convener], ['roleProfile', roleProfile]] as const) {
    if ('why' in r) problems.push(`wsp:${field}: ${r.why}`);
  }
  if ('why' in convener) {
    // ★ NULL, AND NOT THE HALF-RECORD THE OTHER TWO READERS RETURN. A grant that cannot state
    // its role still REVOKES and a damaged acceptance still WITHDRAWS, so both survive with
    // their conferring field emptied and their restriction intact. A workspace record has no
    // restricting half at all — no `wsp:revoked`, no `wsp:withdrawn`, nothing that takes
    // authority away — so a record that does not say who convenes answers no question and
    // there is nothing to preserve by keeping it.
    return { record: null, problems, attestation };
  }

  return {
    record: {
      head: descriptorUrl,
      workspace: workspaceIri,
      convener: convener.iri,
      // Parsed because the published shape requires it and reading a record means reading it;
      // carried because a caller may want to check the role profile it folded against. Not
      // fatal when unreadable: nothing in the fold consults it, so refusing the whole record
      // over it would withhold a convener the record does state. Named in `problems` instead.
      roleProfile: 'why' in roleProfile ? '' : roleProfile.iri,
      attestation,
      // ★ UNCONDITIONAL, WHERE THE OTHER TWO READERS USE `provenanceUnless`. The two-track
      // rule collapses here for the reason above: the conferring field of a workspace record
      // is its convener, and a record that could not state one returned null a few lines up.
      // Everything reaching this line stated its convener inside the digested region, so
      // there is no case where the record survives without provenance — and writing
      // `provenanceUnless(false, …)` would imply one exists.
      fieldProvenance: parsedFromPayload(descriptorUrl),
    },
    problems,
    attestation,
  };
}

/**
 * Turn a workspace read into the {@link ConvenerEvidence} the fold takes.
 *
 * ★ THE POINT OF THIS ONE-LINER IS THE FAILING BRANCH. A caller that wrote
 * `ws.record ? {kind: 'declared', record: ws.record} : undefined` would have a fold that
 * silently stops checking the convener whenever `get_descriptor` has a bad minute — a
 * transient read failure quietly reopening the gap, with `convenerBinding: 'unchecked'` the
 * only trace and nobody reading it. This maps an unreadable workspace onto `'unreadable'`
 * instead, which refuses to confer. Asking and getting silence is not the same as not asking,
 * and the shortest correct spelling of that should be the one in front of callers.
 */
export function convenerEvidenceOf(read: MembershipRead<WorkspaceRecord>): ConvenerEvidence {
  if (read.record !== null) return { kind: 'declared', record: read.record };
  return {
    kind: 'unreadable',
    why: read.problems.length > 0
      ? read.problems.join('; ')
      : 'the read produced no workspace record and no reason, which is itself a reason not to '
        + 'confer anything',
  };
}

/**
 * The `/ns/<owner>/<slug>` owner segment of a workspace IRI, or null if it has none.
 *
 * ★ A VERBATIM COPY OF THE DEPLOYED ROUTE'S OWN DERIVATION, and it is here rather than in
 * `roster.ts` for the same reason {@link PUBLISHED_IRI_PATTERN} is here: this file is the one
 * that talks to the substrate, and the fold is pure. `resolveNsGraph`
 * (`deploy/mcp-relay/server.ts:11653-11657`) matches the same two segments and builds
 * `podUrl = CSS_URL + owner + '/'`, and `handleResolveLinkedData` parses an IRI with
 * `/\/ns\/([^/]+)\/([^/?#]+)/`. That is the whole reason a workspace IRI names an authority:
 * the owner segment IS a pod segment, and the substrate refuses everyone but its holder a
 * write there.
 *
 * Null for any other IRI shape, and the caller fails closed on it — see
 * {@link dereferenceWorkspaceRecord}. Guessing a pod for an IRI whose authority we cannot read
 * would be the substitution this whole layer exists to stop making.
 */
export function nsOwnerSegmentOf(workspaceIri: string): string | null {
  const m = /^https?:\/\/[^/]+\/ns\/([^/?#]+)\/([^/?#]+)$/.exec(workspaceIri);
  if (m === null) return null;
  try { return decodeURIComponent(m[1]!); } catch { return m[1]!; }
}

/**
 * Obtain the workspace record by DEREFERENCING the workspace, and say so.
 *
 * ★★ THE PRODUCER RESIDUAL GAP 9 NEEDED, and it is `membership.ts`'s job for the third time.
 * `readWorkspaceRecord` above is handed a descriptor URL and reads it; it does not and cannot
 * say the URL is the one the workspace answers with. Measured live: bee published a
 * `wsp:Workspace` for alice's workspace IRI on her own pod, and a fold handed it reported
 * `convenerBinding: 'bound'` and admitted her. Every check the fold had passes on that record,
 * because its subject is a triple bee wrote.
 *
 * What this does instead is ask the workspace. `<relay>/ns/<owner>/<slug>` resolves against the
 * pod its owner segment names and no other, so `get_current_head{urn: <workspace>, pod_name:
 * <owner>}` returns whatever THAT pod publishes at that IRI — alice's record, and nothing bee
 * writes can become it (`403 scope_violation`, measured both ways). The returned
 * {@link ConvenerEvidence} carries the resulting {@link EvidenceProvenance}, and
 * `refuseEvidenceProvenance` in `roster.ts` refuses evidence without one.
 *
 * ★ IT RETURNS THE EVIDENCE, NOT THE RECORD PLUS A CLAIM, and that shape is the point — the
 * same point `convenerEvidenceOf` makes one function up. A signature returning
 * `{record, provenance}` separately invites a caller to attach this provenance to a record it
 * obtained some other way, which is the forgery with an extra step. There is no honest way to
 * build the pair except by having done the dereference, so the pair is only ever built here.
 *
 * ★★ AND "ONLY EVER BUILT HERE" IS NOW THE COMPILER'S STATEMENT RATHER THAN THIS COMMENT'S.
 * The sentence above was true of the code as written and asserted nothing about the code
 * anybody else writes: `EvidenceProvenance` was a plain pair of strings, so a caller could put
 * one beside a record it forged and `refuseEvidenceProvenance` would pass it. That was residual
 * gap 9's remaining medium row. The type is now branded on a private-membered class `roster.ts`
 * does not export, so that literal is a COMPILE ERROR at the point of writing and
 * {@link dereferencedFrom} below is the only assertion in the tree that mints one. See
 * `EvidenceProvenance` in `roster.ts` for what a compile-time brand does not close.
 *
 * ★ AND EVERY FAILING BRANCH IS `'unreadable'`, WHICH REFUSES. A workspace IRI with no owner
 * segment, a missing dependency, a substrate error, a forked chain and an absent head all mean
 * the same thing to the fold: this policy asked what `<workspace>` dereferences to and did not
 * get an answer. Asking and getting silence is not the same as not asking.
 */
export async function dereferenceWorkspaceRecord(
  workspaceIri: string,
  deps: StreamDeps,
): Promise<ConvenerEvidence> {
  const unreadable = (why: string): ConvenerEvidence => ({ kind: 'unreadable', why });
  const owner = nsOwnerSegmentOf(workspaceIri);
  if (owner === null) {
    return unreadable(
      `<${workspaceIri}> is not a <relay>/ns/<owner>/<slug> IRI, so this reader cannot tell `
      + 'which pod has authority over it. The owner segment is what makes a workspace IRI name '
      + 'an authority — it selects the pod the relay resolves the IRI against — and guessing '
      + 'one for an IRI that carries none would be choosing whose record to believe, which is '
      + 'the whole of what this function exists not to do',
    );
  }
  if (deps.currentHead === undefined) {
    return unreadable(
      'no `currentHead` dependency was supplied, so nothing dereferenced the workspace. '
      + 'Returning the record at a caller-chosen URL instead would be reporting a check that '
      + 'did not happen — see `StreamDeps.currentHead`',
    );
  }
  let res: Record<string, unknown>;
  try {
    res = await deps.currentHead({ urn: workspaceIri, pod_name: owner });
  } catch (e) {
    return unreadable(`get_current_head on <${workspaceIri}> threw: ${(e as Error).message}`);
  }
  if (res.error !== undefined) {
    return unreadable(
      `get_current_head on <${workspaceIri}> at pod '${owner}' failed: `
      + String(res.message ?? res.error),
    );
  }
  if (res.forked === true) {
    // The same rule the fold applies to a forked grant chain, one record earlier: under
    // disagreement the weaker reading is the only safe one, and here there is no weaker
    // reading — two unresolved heads mean the workspace states two conveners and picking
    // either would let whichever descriptor sorted first decide who may grant.
    const heads = Array.isArray(res.heads) ? res.heads.length : 2;
    return unreadable(
      `<${workspaceIri}> has ${heads} unresolved chain heads on pod '${owner}', so it does not `
      + 'state who convenes it — it states several, and choosing one would make the answer '
      + 'depend on which descriptor the walk reached first. Republish a single clean head',
    );
  }
  const head = res.head as { descriptorUrl?: unknown } | undefined | null;
  const descriptorUrl = typeof head?.descriptorUrl === 'string' ? head.descriptorUrl : '';
  if (descriptorUrl === '') {
    return unreadable(
      `nothing is published at <${workspaceIri}> on pod '${owner}' — the IRI resolves to no `
      + 'workspace record, so the workspace has not declared who convenes it',
    );
  }
  const read = await readWorkspaceRecord(descriptorUrl, deps);
  if (read.record === null) {
    return unreadable(
      read.problems.length > 0
        ? read.problems.join('; ')
        : `<${workspaceIri}> resolved to <${descriptorUrl}> and the read produced no workspace `
          + 'record and no reason, which is itself a reason not to confer anything',
    );
  }
  return {
    kind: 'declared',
    record: read.record,
    // ★ BOTH ARGUMENTS COME FROM THE DEREFERENCE THIS FUNCTION JUST PERFORMED, and that is the
    // whole content of the claim. `workspaceIri` is what the caller asked for and what
    // `get_current_head` was given; `descriptorUrl` is what came back from the pod the IRI's
    // own owner segment names. `read.record.head` is `descriptorUrl` by construction —
    // `readWorkspaceRecord` sets `head` to the URL it was handed — so the two are not compared
    // here. `refuseEvidenceProvenance` compares them anyway, and must keep doing so: it is
    // guarding against a caller that is not this function.
    provenance: dereferencedFrom(workspaceIri, descriptorUrl),
  };
}

/**
 * ★★ THE ONE PLACE AN {@link EvidenceProvenance} COMES INTO EXISTENCE IN THIS REPOSITORY, and
 * the sibling of {@link parsedFromPayload} above.
 *
 * Local to `dereferenceWorkspaceRecord` in every sense that matters — not exported, called
 * once, and defined immediately below its only caller so the two are read together. A shared
 * "mint a provenance" helper serving both brands was considered and rejected: it would take the
 * brand as a parameter, and a producer that can be pointed at either claim is a producer that
 * can be pointed at the wrong one.
 *
 * ★ WHY IT TAKES TWO STRINGS AND NOT THE RECORD. Handing it the `WorkspaceRecord` and reading
 * `resolvedTo` off its `head` would make the pair SELF-CERTIFYING — `provenance.resolvedTo`
 * would equal `ws.head` for any record at all, and `refuseEvidenceProvenance`'s second check
 * would become a tautology that passes for the forged record as readily as the real one. The
 * two values must come from the act of dereferencing, which is why only a function that has
 * just performed one can supply them.
 */
function dereferencedFrom(dereferenced: string, resolvedTo: string): EvidenceProvenanceValue {
  // See `parsedFromPayload` for why the assertion is spelled the long way.
  return { dereferenced, resolvedTo } as unknown as EvidenceProvenanceValue;
}

/**
 * Read a `wsp:RoleProfile` back off a POD and parse its role table from the digested region.
 *
 * The signed half of {@link dereferenceRoleProfile}, and the same treatment the other three
 * records get: ONE `get_descriptor`, the table out of `payloadOf` and therefore out of the bytes
 * the substrate re-digested, the verifier's answer carried beside it. A profile published to
 * `<relay>/ns/<owner>/<slug>` is a pod record like any other, so there is no reason for it to be
 * read any more weakly than the grant it governs.
 *
 * ★ `dereferenced` IS A PARAMETER RATHER THAN THE DESCRIPTOR URL, and that is the whole reason
 * this is not simply exported for callers to point wherever they like. The descriptor URL is
 * where the BYTES were; the IRI is what the fold compares against the profile its table claims.
 * Only a function that has just dereferenced that IRI knows both, which is why the honest way in
 * is {@link dereferenceRoleProfile} and why this one is not exported.
 */
async function readRoleProfileRecord(
  descriptorUrl: string,
  dereferenced: string,
  deps: StreamDeps,
): Promise<MembershipRead<RoleProfileDocument>> {
  const got = await fetchDescriptor(descriptorUrl, deps);
  if ('why' in got) {
    return { record: null, problems: [got.why], attestation: got.attestation };
  }
  const { res, attestation } = got;

  const payload = payloadOf(res);
  if ('why' in payload) return { record: null, problems: [payload.why], attestation };
  const table = roleTableOf(payload.content);
  if ('why' in table) return { record: null, problems: [table.why], attestation };

  return {
    record: {
      head: descriptorUrl,
      dereferenced,
      roles: table.roles,
      // ★ SET HERE AND NOWHERE ELSE, so the label cannot be attached to bytes that did not come
      // through `payloadOf`. `refuseRoleTableAuthority` reads it to decide whether to run the
      // authorship branch at all, which makes it the one field on this document whose value
      // selects a check — and a producer that could stamp it onto a plain fetch would be
      // claiming a signature nobody made.
      authority: 'signed-record',
      attestation,
    },
    // No `problems` half-record here, unlike the two membership readers: a role profile has no
    // restricting field to preserve. Every failure above returned null, so anything reaching
    // this line parsed completely.
    problems: [],
    attestation,
  };
}

/**
 * Obtain the ROLE TABLE by dereferencing the profile IRI, and say how.
 *
 * ★★ THE PRODUCER RESIDUAL GAP 10 NEEDED, and it is `membership.ts`'s job for the fourth time.
 * `refuseRoleProfileAuthority` in `roster.ts` compares the IRI the workspace declares with the
 * IRI the caller's table claims — an IRI against an IRI — and the fold is pure, so nothing had
 * ever opened the document. `{profile: <the declared IRI>, roles: [anything]}` agreed with every
 * check that existed, and `permitsOf` is built from `roles`.
 *
 * ── TWO PATHS, BECAUSE A ROLE PROFILE IS NOT ALWAYS A POD RECORD ─────────────
 *
 * `<relay>/ns/<owner>/<slug>` is resolved through the pod its owner segment names, exactly as
 * {@link dereferenceWorkspaceRecord} resolves a workspace, and what comes back is a SIGNED
 * record. Anything else is fetched over HTTPS and is worth what an HTTPS fetch is worth. The
 * distinction is carried in `RoleProfileDocument.authority` rather than smoothed over, because
 * they are not the same evidence and reporting them identically would be the overclaim.
 *
 * ★ AND THE DEPLOYED PROFILE IS THE SECOND KIND, AND CANNOT BE THE FIRST.
 * `<…github.io/interego/applications/shared-workspace/wsp-roles-default>` is a static file. No
 * `publish_context` wrote it, so it carries no `iep:authorshipProof` and there is no key to
 * check one against — not because nobody has got round to signing it, but because a Pages file
 * has nowhere to put a proof that a reader could bind to the document. What this function can
 * establish about it is exactly: THIS ORIGIN SERVED THESE BYTES AT THIS URL. That is the honest
 * ceiling and `roster.ts` renders it into the roster's own note.
 *
 * ★ AND THAT IRI ANSWERS `text/html`, WHICH IS NOT A DEFECT AND USED TO BE READ AS ONE.
 * GitHub Pages serves no extensionless path and falls back to `<name>.html`, so the declared
 * IRI returns the human-readable projection with `<link rel="alternate" type="text/turtle">`
 * pointing at the Turtle beside it. The hop below follows that link. What this function returns
 * on the ordinary-web path is therefore the table out of `wsp-roles-default.ttl`, reached from
 * the IRI the workspace actually declares, at `'transport-only'` either way.
 *
 * ── THE FOUR GUARDS ON THE FETCH, AND WHY EACH ONE ──────────────────────────
 *
 * ★ `https:` ONLY, AND `http:` REFUSED THOUGH THE PUBLISHED SHAPE ALLOWS IT. `wsp-shapes.ttl`
 * patterns `wsp:roleProfile` as `^https?://`, so a workspace may legally declare a cleartext
 * profile — and for a document whose ENTIRE evidence is the transport, a cleartext fetch is
 * evidence of nothing at all. Anyone on the path chooses what a role permits. This is the one
 * place the reader is deliberately stricter than the contract, and it is stated out loud
 * because `PUBLISHED_IRI_PATTERN` exists precisely to stop the two drifting silently.
 *
 * ★ A CROSS-ORIGIN REDIRECT REFUSES. The authority here IS the origin; following a redirect off
 * it hands the answer to a different party while the caller still believes it asked the declared
 * one. Same-origin redirects are allowed, because a host serving `/x` as `/x.ttl` has not
 * changed who is answering.
 *
 * ★ A CROSS-ORIGIN `rel=alternate` REFUSES FOR THE SAME REASON, and it is a SEPARATE guard from
 * the one above rather than the same one restated. A redirect is the server choosing where the
 * answer comes from; an alternate link is the DOCUMENT choosing, which is a claim written by
 * whoever can write the page. Both routes end somewhere the declared origin does not vouch for,
 * so both are refused — and the follower checks the landed URL of the hop too, because a
 * same-origin href that redirects away would otherwise reach what a foreign href cannot.
 *
 * ★ EVERY FAILING BRANCH IS `'unreadable'`, WHICH REFUSES TO CONFER. A missing dependency, a
 * non-200, a redirect off the origin, a page that advertises no Turtle, an unparseable body, a
 * document that is not a role profile — all of them mean the same thing to the fold: this policy
 * asked what the profile IRI returns and did not get an answer. Asking and getting silence is
 * not the same as not asking.
 */
export async function dereferenceRoleProfile(
  profileIri: string,
  deps: StreamDeps,
): Promise<RoleTableEvidence> {
  const unreadable = (why: string): RoleTableEvidence => ({ kind: 'unreadable', why });

  // ── the pod-hosted path ──
  const owner = nsOwnerSegmentOf(profileIri);
  if (owner !== null) {
    if (deps.currentHead === undefined) {
      return unreadable(
        `<${profileIri}> is a <relay>/ns/<owner>/<slug> IRI and no \`currentHead\` dependency `
        + 'was supplied, so nothing dereferenced it. Reading a document at a caller-chosen URL '
        + 'instead would be reporting a check that did not happen',
      );
    }
    let res: Record<string, unknown>;
    try {
      res = await deps.currentHead({ urn: profileIri, pod_name: owner });
    } catch (e) {
      return unreadable(`get_current_head on <${profileIri}> threw: ${(e as Error).message}`);
    }
    if (res.error !== undefined) {
      return unreadable(
        `get_current_head on <${profileIri}> at pod '${owner}' failed: `
        + String(res.message ?? res.error),
      );
    }
    if (res.forked === true) {
      // The same rule the fold applies to a forked grant chain and `dereferenceWorkspaceRecord`
      // applies to a forked workspace: two unresolved heads mean the IRI states two role tables,
      // and picking either would let whichever descriptor sorted first decide what a role
      // permits.
      const heads = Array.isArray(res.heads) ? res.heads.length : 2;
      return unreadable(
        `<${profileIri}> has ${heads} unresolved chain heads on pod '${owner}', so it does not `
        + 'state one role table — it states several, and choosing one would make what a role '
        + 'permits depend on which descriptor the walk reached first. Republish a single clean '
        + 'head',
      );
    }
    const head = res.head as { descriptorUrl?: unknown } | undefined | null;
    const descriptorUrl = typeof head?.descriptorUrl === 'string' ? head.descriptorUrl : '';
    if (descriptorUrl === '') {
      return unreadable(
        `nothing is published at <${profileIri}> on pod '${owner}' — the IRI resolves to no role `
        + 'profile, so the governance the workspace names does not exist there',
      );
    }
    const read = await readRoleProfileRecord(descriptorUrl, profileIri, deps);
    if (read.record === null) {
      return unreadable(
        read.problems.length > 0
          ? read.problems.join('; ')
          : `<${profileIri}> resolved to <${descriptorUrl}> and the read produced no role `
            + 'profile and no reason, which is itself a reason not to confer anything',
      );
    }
    return { kind: 'declared', document: read.record };
  }

  // ── the ordinary-web path ──
  if (!profileIri.startsWith('https://')) {
    return unreadable(
      `<${profileIri}> is neither a <relay>/ns/<owner>/<slug> IRI nor an https:// URL, so there `
      + 'is nothing this reader can dereference. A role profile served over cleartext is refused '
      + 'DELIBERATELY even though the published shape permits http:// — nobody signs these '
      + 'documents, so the transport is the entire evidence, and a fetch anyone on the path can '
      + 'rewrite is evidence that anyone on the path decides what a role permits',
    );
  }
  if (deps.fetchDocument === undefined) {
    return unreadable(
      'no `fetchDocument` dependency was supplied, so nothing dereferenced the role profile. '
      + 'The same posture `currentHead` takes: a caller that does not want this check is not '
      + 'obliged to supply the dependency, and a caller that asks for it without one gets a '
      + 'refusal rather than a silent pass — see `StreamDeps.fetchDocument`',
    );
  }
  let res: { status: number; url: string; contentType: string | null; body: string };
  try {
    res = await deps.fetchDocument(profileIri);
  } catch (e) {
    return unreadable(`fetching <${profileIri}> threw: ${(e as Error).message}`);
  }
  if (res.status !== 200) {
    return unreadable(
      `<${profileIri}> answered ${res.status}, so the profile the workspace declares does not `
      + 'dereference. A role profile IRI that returns nothing states no governance — which was '
      + 'the state of the DEPLOYED artifact until docs/ shipped a page at the extensionless IRI',
    );
  }
  // ★ COMPARED ON ORIGIN, NOT ON THE WHOLE URL. A host that serves the extensionless name as a
  // file has redirected honestly and is still the party the IRI names; a redirect that leaves
  // the origin has handed the answer to somebody else while the caller still believes it asked
  // this one.
  let landedElsewhere = false;
  try {
    landedElsewhere = new URL(res.url).origin !== new URL(profileIri).origin;
  } catch {
    // An unparseable final URL is not a same-origin answer, and reading it as one would make a
    // malformed response the way past this guard.
    landedElsewhere = true;
  }
  if (landedElsewhere) {
    return unreadable(
      `dereferencing <${profileIri}> ended at <${res.url}>, which is a different origin. A role `
      + 'profile carries no signature, so its origin IS its authority — following a redirect off '
      + 'it would let whoever controls the destination decide what every role in this workspace '
      + 'permits, while the fold reported the declared profile as read',
    );
  }
  /**
   * ★★ THE PAGE'S OWN ADVERTISED TURTLE, FOLLOWED — AND THE COMPOSED FOLLOWER, NOT A NEW ONE.
   *
   * The deployed profile IRI answered 404 until `wsp-roles-default.html` shipped so the
   * vocabulary's extensionless IRIs would dereference. It now answers 200 `text/html`, because
   * GitHub Pages ignores Accept and falls back to `<name>.html` — and this reader called the
   * only role profile in existence `unreadable: … unknown bareword "Default"`. The published
   * governance was there, at the declared IRI, and the reader could not see it.
   *
   * ★ AND IT IS STILL NOT A GUESS. Appending `.ttl` remains refused, for the reason this
   * docstring gave when the IRI 404'd: choosing a URL on the workspace's behalf is what
   * `nsOwnerSegmentOf` refuses to do one document over. What is followed is what the PAGE
   * says about itself — `<link rel="alternate" type="text/turtle">`, which every page we
   * publish carries and which the relay's shape gate has followed since the same problem bit
   * the publish path. `followAlternateTurtle` is that follower, moved to @interego/core so
   * there is one parser of the markup rather than two.
   *
   * ★ THE HOP CHANGES NOTHING ABOUT THE GRADE, AND MUST NOT. `authority` below is
   * `'transport-only'` whether or not a hop happened: a static Pages file carries no
   * authorship proof and no digested region at either end of the link, and the follower's
   * same-origin refusal is what keeps the hop from making the evidence WEAKER than the fetch
   * that preceded it. A reader that graded a followed document above an unfollowed one would
   * be reporting a guarantee nobody made.
   */
  const followed = await followAlternateTurtle(res, deps.fetchDocument);
  if ('why' in followed) {
    return unreadable(
      `<${profileIri}> answered 200 with ${res.contentType ?? 'no stated content type'} and `
      + `${followed.why}`,
    );
  }
  const table = roleTableOf(followed.representation.body);
  if ('why' in table) {
    return unreadable(
      `<${profileIri}> answered 200 with ${res.contentType ?? 'no stated content type'} and `
      + `${table.why}`,
    );
  }
  return {
    kind: 'declared',
    document: {
      // The url the TABLE's bytes came from, so an operator following this field opens what
      // this fold compared against rather than the name it was asked for. The two differ on any
      // same-origin redirect and on every followed `rel=alternate` — which, against the
      // deployed artifact, is every read: the declared IRI serves the human-readable page.
      head: followed.representation.url,
      dereferenced: profileIri,
      roles: table.roles,
      // ★ NEVER `'signed-record'` ON THIS PATH, and the value is written rather than defaulted:
      // a plain GET returns no proof, so there is nothing an attestation could be built from,
      // and `refuseRoleTableAuthority` refuses a `'transport-only'` document that carries one.
      authority: 'transport-only',
    },
  };
}

/**
 * Read a `wsp:MembershipGrant` back off a pod and parse its fields from the payload.
 *
 * ONE `get_descriptor`. The returned `Grant` carries `head` = the descriptor URL it was read
 * from, so it is the value an acceptance's `wsp:accepts` must name and the value the fold
 * groups on.
 */
export async function readGrantRecord(
  descriptorUrl: string,
  deps: StreamDeps,
): Promise<MembershipRead<Grant>> {
  const got = await fetchDescriptor(descriptorUrl, deps);
  if ('why' in got) {
    return { record: null, problems: [got.why], attestation: got.attestation };
  }
  const { res, attestation } = got;
  const problems: string[] = [];

  const payload = payloadOf(res);
  if ('why' in payload) return { record: null, problems: [payload.why], attestation };
  const found = oneSubjectOfType(payload.content, WSP_TERMS.MembershipGrant, 'a membership grant');
  if ('why' in found) return { record: null, problems: [found.why], attestation };
  const subject = found.subject;

  if (subjectIriOf(subject) === null) {
    return { record: null, problems: [problem(
      'the grant is a blank node, so it has no identity an acceptance could name. The two '
      + 'halves are linked by the grant\'s own URL, and a record with no URL cannot be one half',
    )], attestation };
  }

  const workspace = oneIri(subject, WSP_TERMS.workspace, 'which workspace it belongs to');
  const grantedTo = oneIri(subject, WSP_TERMS.grantedTo, 'who it grants to');
  const role = oneIri(subject, WSP_TERMS.role, 'which role it grants');
  // ★ READ BEFORE THE BAIL-OUT BELOW. A grant missing its role still carries its revocation,
  // and the whole restricting-track discipline turns on that record reaching the fold.
  const revoked = safeBoolean(subject, WSP_TERMS.revoked, problems);

  for (const [field, r] of [['workspace', workspace], ['grantedTo', grantedTo], ['role', role]] as const) {
    if ('why' in r) problems.push(`wsp:${field}: ${r.why}`);
  }
  if ('why' in workspace || 'why' in grantedTo) {
    // Without a workspace the fold cannot tell whether this record is even ours, and without
    // a grantee a revocation has nobody to apply to. Either way there is no row to build.
    return { record: null, problems, attestation };
  }

  return {
    record: {
      head: descriptorUrl,
      workspace: workspace.iri,
      grantedTo: grantedTo.iri,
      // A role the profile does not declare contributes no capability; a grant with an
      // UNREADABLE role must not silently become one that grants nothing quietly, so the
      // record still exists (it may revoke) and the problem is named. The empty string is
      // never a declared role, so `permitsOf.has()` misses and the fold contributes nothing.
      role: 'why' in role ? '' : role.iri,
      ...(revoked === undefined ? {} : { revoked }),
      attestation,
      // ★ THE TWO-TRACK RULE, APPLIED AT THE READER: a record whose CONFERRING field could
      // not be read loses its power to confer and keeps its power to restrict. The role is
      // what a grant confers, so a grant that does not state one gets no provenance —
      // `requireFieldBinding` then refuses it for the conferring track while the row still
      // reaches the fold and its revocation still removes the member.
      //
      // Without this the record was field-bound on the strength of fields it does not have:
      // it would have conferred membership under the strictest policy available while
      // `role: ''` quietly carried no capability, and the roster would have reported
      // `recordFieldBinding: 'bound'` over a record that states no role at all.
      ...provenanceUnless('why' in role, descriptorUrl),
    },
    problems,
    attestation,
  };
}

/**
 * Read a `wsp:MembershipAcceptance` back off the MEMBER's pod and parse its fields.
 *
 * ★ WHAT THE PAIR OF READERS ESTABLISHES, PRECISELY. With
 * `AttestationPolicy.requireFieldBinding` set, a member exists only where:
 *
 *   — a record on the convener's side SAYS `wsp:grantedTo <p>`, `wsp:role <r>`,
 *     `wsp:workspace <w>`, and was signed by an agent the convener's registry vouches for,
 *     over content the substrate re-digested and matched;
 *   — a record on <p>'s side SAYS `wsp:member <p>`, `wsp:accepts <that grant's URL>`,
 *     `wsp:stream <s>`, `wsp:workspace <w>`, and was signed by an agent <p>'s OWN registry
 *     vouches for, over content the substrate re-digested and matched.
 *
 * Neither record's fields were chosen by whoever called the fold. That is the sentence the
 * README's headline claim rests on, and it is the whole of what is new.
 *
 * ★ WHAT IT DOES NOT ESTABLISH, and read this before extending the claim:
 *
 *   — that the convener is entitled to convene, UNLESS the caller also reads <w> with
 *     {@link readWorkspaceRecord} and passes the result as
 *     `AttestationPolicy.workspaceEvidence`. Without that, `AttestationPolicy.convener` is
 *     still a value the CALLER types and a stranger who signs a grant is refused only because
 *     the caller named someone else as convener. With it, the policy's convener must be the
 *     one <w>'s own record declares, in bytes that record's signer signed.
 *   — that the role profile the fold computed capabilities from is the one <w> declares,
 *     unless the caller passed the same `workspaceEvidence`. `refuseRoleProfileAuthority`
 *     compares the declared `wsp:roleProfile` against `RoleProfile.profile` — an IRI against
 *     an IRI. Neither this reader nor the fold fetches the profile DOCUMENT, so the role table
 *     itself remains the caller's; see `Roster.roleProfileBinding`.
 *   — anything about a record whose `contentBinding` is not `'bound'`. Fields parsed from
 *     bytes nobody re-digested are fields that may have been changed after signing, which
 *     is why `requireFieldBinding` forces `requireContentBinding` on in the fold rather
 *     than leaving the two to be set independently.
 */
export async function readAcceptanceRecord(
  descriptorUrl: string,
  deps: StreamDeps,
): Promise<MembershipRead<Acceptance>> {
  const got = await fetchDescriptor(descriptorUrl, deps);
  if ('why' in got) {
    return { record: null, problems: [got.why], attestation: got.attestation };
  }
  const { res, attestation } = got;
  const problems: string[] = [];

  const payload = payloadOf(res);
  if ('why' in payload) return { record: null, problems: [payload.why], attestation };
  const found = oneSubjectOfType(payload.content, WSP_TERMS.MembershipAcceptance, 'a membership acceptance');
  if ('why' in found) return { record: null, problems: [found.why], attestation };
  const subject = found.subject;

  const workspace = oneIri(subject, WSP_TERMS.workspace, 'which workspace it belongs to');
  const member = oneIri(subject, WSP_TERMS.member, 'who is accepting');
  const accepts = oneIri(subject, WSP_TERMS.accepts, 'which grant it answers');
  const stream = oneIri(subject, WSP_TERMS.stream, 'which stream the member will write to');
  // Read before the bail-out, for the same reason as `revoked`: a withdrawal must reach the
  // fold even on a record that is otherwise damaged.
  const withdrawn = safeBoolean(subject, WSP_TERMS.withdrawn, problems);

  for (const [field, r] of [
    ['workspace', workspace], ['member', member], ['accepts', accepts], ['stream', stream],
  ] as const) {
    if ('why' in r) problems.push(`wsp:${field}: ${r.why}`);
  }
  if ('why' in workspace || 'why' in member || 'why' in accepts) {
    // No workspace, no member or no grant answered means there is no half of a membership
    // here — not a damaged one, an absent one. A withdrawal that names nobody withdraws
    // nothing, and inventing a subject for it would be worse than reporting it lost.
    return { record: null, problems, attestation };
  }

  return {
    record: {
      head: descriptorUrl,
      workspace: workspace.iri,
      member: member.iri,
      accepts: accepts.iri,
      // An acceptance with no readable stream still WITHDRAWS, so the record survives with
      // an empty stream and a named problem. The fold only reads `stream` for a member it
      // is already admitting, and `''` is not a pod anyone will follow.
      stream: 'why' in stream ? '' : stream.iri,
      ...(withdrawn === undefined ? {} : { withdrawn }),
      attestation,
      // ★ Same two-track rule as the grant side. Naming the stream is the conferring act of
      // an acceptance — `roster.ts` calls it out as the one field that stays on the
      // conferring track — so an acceptance that does not state one gets no provenance and
      // cannot confer under `requireFieldBinding`, while its withdrawal still applies.
      ...provenanceUnless('why' in stream, descriptorUrl),
    },
    problems,
    attestation,
  };
}

/** One `get_descriptor`, with every failure mode turned into a reason rather than a throw. */
async function fetchDescriptor(
  descriptorUrl: string,
  deps: StreamDeps,
): Promise<{ res: Record<string, unknown>; attestation: Attestation } | { why: string; attestation: Attestation }> {
  if (deps.getDescriptor === undefined) {
    // A programming error, not a data condition — the same call this refusal is modelled on
    // (`readAttestation`). Answering "no record" would render a missing dependency as an
    // absent membership, and an absent membership is a result somebody acts on.
    throw new Error(
      'readGrantRecord/readAcceptanceRecord need a `getDescriptor` dependency (the '
      + '`get_descriptor` tool). Reading the fields FROM THE RECORD is the entire point of '
      + 'this module, and it cannot be done without fetching the record.',
    );
  }
  let res: Record<string, unknown>;
  try {
    res = await deps.getDescriptor({ url: descriptorUrl });
  } catch (err) {
    const why = `get_descriptor threw for <${descriptorUrl}>: ${err instanceof Error ? err.message : String(err)}`;
    return { why, attestation: { authorshipVerified: false, signedBy: null, boundToDescriptor: false, reason: why } };
  }
  const attestation = attestationOfResponse(res, descriptorUrl);
  if (res === null || typeof res !== 'object' || Array.isArray(res)) {
    return { why: `get_descriptor did not return a result object for <${descriptorUrl}>`, attestation };
  }
  if (res.error !== undefined) {
    return { why: `get_descriptor failed for <${descriptorUrl}>: ${String(res.message ?? res.error)}`, attestation };
  }
  return { res, attestation };
}
