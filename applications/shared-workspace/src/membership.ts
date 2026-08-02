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
 * ── WHAT THIS STILL DOES NOT ESTABLISH ───────────────────────────────────────
 *
 * Read {@link readAcceptanceRecord}'s note before concluding anything about authority. In
 * short: this closes *does this record say what the fold was told it says*. It does not
 * close *is the signer of the grant entitled to grant here* — `AttestationPolicy.convener`
 * is still a value the caller types, and nothing here fetches the workspace descriptor to
 * check `wsp:convener` against it. Named as residual gap 6 in the README rather than
 * quietly folded into the headline.
 */

import {
  escapeTurtleLiteral, turtleIriRef, turtlePrefixedLocal,
  parseTrig, findSubjectsOfType,
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
  Attestation, Grant, Acceptance, Principal,
  FieldProvenance as FieldProvenanceValue,
} from './roster.js';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const XSD_BOOLEAN = 'http://www.w3.org/2001/XMLSchema#boolean';

/** The two record classes, and every predicate this module writes or reads. */
export const WSP_TERMS = {
  MembershipGrant: `${WSP}MembershipGrant`,
  MembershipAcceptance: `${WSP}MembershipAcceptance`,
  workspace: `${WSP}workspace`,
  grantedTo: `${WSP}grantedTo`,
  role: `${WSP}role`,
  revoked: `${WSP}revoked`,
  /**
   * ★ THE ONE TERM THE PUBLISHED SHAPE DOES NOT REQUIRE, and the reason it is called out
   * here rather than left to be noticed. `wspsh:MembershipAcceptanceShape` constrains
   * `wsp:accepts`, `wsp:stream`, `wsp:workspace` and `wsp:withdrawn` — it says nothing
   * about who is accepting, because until this module there was no reader that needed to
   * know from the document. So the publish gate will accept an acceptance with no
   * `wsp:member`, and {@link readAcceptanceRecord} refuses one.
   *
   * Refusing more than the shape does is the safe direction and it is deliberate, but it
   * means the guarantee here rests on THIS reader rather than on the published contract.
   * Closing that needs `sh:minCount 1` on the published shape, which is a change to a
   * deployed artifact and is named as residual gap 7 in the README instead of made
   * silently.
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
export type { FieldProvenance } from './roster.js';

const problem = (s: string): string => s;

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
  return conferringFieldMissing ? {} : { fieldProvenance: { source: 'payload', descriptor } };
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
function oneIri(subject: ParsedSubject, predicate: string, label: string): { iri: string } | { why: string } {
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
  return { iri: iris[0]!.iri };
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
 *   — that the convener is entitled to convene. `AttestationPolicy.convener` is a value the
 *     CALLER types. Nothing here fetches <w> and checks `wsp:convener`. A stranger who
 *     signs a grant is refused only because the caller named someone else as convener.
 *   — that `wsp:member` was required of the record. The published shape does not constrain
 *     it; this reader does. See {@link WSP_TERMS.member}.
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
