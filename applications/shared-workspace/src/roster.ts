/**
 * The roster fold: who is in this workspace, and what may they actually do.
 *
 * ── WHY MEMBERSHIP IS TWO-SIDED ──────────────────────────────────────────────
 *
 * A grant lives on the convener's pod. An acceptance lives on the member's own pod. A roster
 * entry exists only where the two agree.
 *
 * That is not ceremony. The substrate has no way to make a person's pod hold a record they
 * did not write, so a one-sided roster would let a convener list participants who never
 * agreed to anything — and in a system whose whole claim is that people keep custody of what
 * they wrote, a manufactured participant is the worst possible failure.
 *
 * ★ THAT ARGUMENT WAS ABOUT WHERE THE RECORDS LIVE, AND THIS FUNCTION NEVER LOOKED.
 *
 * An independent review wrote both halves on one pod and the fold produced a member: the
 * only cross-check was that the acceptance named the grant and repeated the principal, both
 * of which the convener types. The live verifier that reported 13/13 built both halves
 * itself, so the property was demonstrated by construction and never established.
 *
 * The evidence that CAN distinguish the two is the substrate's `iep:authorshipProof`, which
 * `publish_context{sign_authorship: true}` embeds and `get_descriptor` verifies. This module
 * is pure, so it does not fetch it — it takes the verifier's answer as {@link Attestation}
 * on each record and, when {@link foldRoster} is given an {@link AttestationPolicy},
 * REFUSES any grant not signed for the convener and any acceptance not signed for the member
 * it names. Refusals are listed in {@link Roster.unattested}, never dropped.
 *
 * ★ AND IT STILL BINDS A SIGNER TO A RECORD, NEVER A RECORD TO THE FIELDS CLAIMED FOR IT.
 * Say this before anyone over-reads the paragraph above. `Grant.role`, `Grant.grantedTo`,
 * `Grant.revoked`, `Acceptance.member`, `Acceptance.accepts` and `Acceptance.stream` are
 * typed by whoever called this function; the {@link Attestation} sits BESIDE them and covers
 * none of them. A review handed the fold one of bee's ordinary published log entries as her
 * "acceptance" — genuinely signed, genuinely bound to its own descriptor, genuinely naming
 * bee — and bee became an ATTESTED member of a workspace she had never heard of, at whatever
 * role the caller typed. Every member who has ever published one signed public record is
 * that input.
 *
 * ★★ AND CONTENT BINDING DOES NOT NARROW IT, which is the thing most likely to be assumed
 * now that binding exists. The substrate can now prove a record STATES the triples its
 * signer signed — {@link AttestationPolicy.requireContentBinding} demands it and
 * {@link Roster.recordContentBinding} reports it. Bee's log entry passes that check at full
 * strength, because it really is her unmodified record. The lie is in which record was
 * submitted, not in the record, so a stronger guarantee about the record cannot reach it.
 *
 * So without field binding, "bee is an attested member" means *a record at this URL was
 * signed by bee, and it says what she signed*, and NOT *bee agreed to this*.
 *
 * ★★★ AND THAT IS THE GAP `membership.ts` CLOSES, FOR CALLERS THAT ASK.
 *
 * The blocker was never the fold. It was that nothing in the repo had ever WRITTEN a
 * `wsp:MembershipGrant` or a `wsp:MembershipAcceptance`, so there was no content to compare
 * the typed fields against. `membership.ts` serializes both halves, validates them against
 * the published shapes at publish, signs them, reads them back and parses every field out of
 * the payload — and marks the row with a {@link FieldProvenance} saying so.
 * {@link AttestationPolicy.requireFieldBinding} then refuses any row without one, and
 * {@link Roster.recordFieldBinding} reports `'bound'`. Bee's log entry no longer reaches the
 * fold at all: it declares no `wsp:MembershipAcceptance`, so the reader refuses it.
 *
 * `'unbound'` remains the default and remains reachable, because every hand-built caller
 * still produces exactly the rows described above and must keep being told so.
 *
 * ★ WHAT IS STILL OPEN, and it is named rather than absorbed: nothing establishes that
 * {@link AttestationPolicy.convener} is the workspace's convener. That principal is typed by
 * the caller, and neither this module nor `membership.ts` fetches the workspace descriptor
 * to check `wsp:convener` against it. Field binding makes every record state its own
 * membership; it does not make the policy state the right convener.
 *
 * Without that policy the fold still works exactly as before, and says so:
 * {@link Roster.membershipGrade} is `'asserted'` and {@link Roster.attributionNote} states
 * in words that nothing was checked. The grade is non-omittable for the same reason
 * `crossStreamOrderIsAdvisory` is — a caller cannot read `members` without having been told
 * what the list is worth.
 *
 * ── ★★ TURNING THE POLICY ON MUST NEVER GRANT MORE THAN LEAVING IT OFF ───────
 *
 * The first version of that gate filtered refused rows out of the grant list BEFORE the
 * revocation check, so a revocation nobody could attest was not refused — it was ERASED, and
 * the member kept everything. A second review turned a transient `get_descriptor` failure
 * into a silent reinstatement of a revoked member, with nothing in `unattested`, `explain()`
 * or `attributionNote` saying a revocation had failed to take effect. Turning a security
 * feature ON granted more authority than leaving it OFF, which is the worst possible shape
 * for one.
 *
 * The repair is not a patch on the revocation branch. It is a rule the whole fold obeys:
 *
 *   ★ A RECORD THAT FAILS ATTESTATION LOSES ITS POWER TO CONFER AND KEEPS ITS POWER TO
 *     RESTRICT.
 *
 * So the fold reads its inputs on TWO tracks. The CONFERRING track — membership, the role,
 * the stream, a pending invitation — sees only records that passed the gate. The RESTRICTING
 * track — revocation, withdrawal, and the intersection across forked heads — sees every
 * in-workspace record, attested or not. Anything a refused record could do is therefore a
 * subset of what the same record does with no policy at all, for every principal, which is
 * exactly the invariant `workspace-adversarial.test.ts` enumerates configurations to assert.
 *
 * The cost is named rather than hidden. Honouring an unattestable revocation means anyone who
 * can get a row into `grants` can evict a member — the argument the erasing version was built
 * on. That argument is real and it is the lesser evil: it is a denial of service the ASSERTED
 * configuration already permits in full, so refusing to honour it bought nothing except a
 * configuration that grants more than the weaker one. A wrongly-evicted member complains
 * within the hour; a wrongly-retained one is why the revocation was written.
 *
 * ── WHY A ROLE CANNOT ESCALATE ───────────────────────────────────────────────
 *
 * Effective capability is `role.permits ∩ delegatedScope`. A role is a CEILING on an
 * authority the principal already had, never a source of one. So a Convener whose agent holds
 * a read-only delegation still cannot write, and granting a role to an agent can never widen
 * the set of things its principal is exposed to.
 *
 * This is the property that distinguishes a published roster from a membership table. In a
 * table, being an admin IS the authority. Here it is only a bound on it.
 *
 * ── WHY DIVERGENCE IS REPORTED RATHER THAN RESOLVED ──────────────────────────
 *
 * Two concurrent writes to a grant chain leave two heads. The obvious move is last-write-wins.
 * That is wrong here: on an AUTHORIZATION record, silently picking a winner can silently
 * escalate privilege, and the loser's revocation would simply vanish.
 *
 * So the fold names both heads and applies the INTERSECTION of their capabilities.
 * Under-privileging a member is an operational annoyance someone notices and fixes;
 * over-privileging one is a security failure nobody notices at all.
 *
 * This module is pure. It performs no I/O, so it can be tested exhaustively and cannot become
 * a second place where authorization quietly happens.
 */

// ★ TYPE-ONLY, so this stays the pure module its header says it is — the import is erased
// and nothing here gains a runtime dependency. Both names are the SUBSTRATE's, imported
// rather than retyped: a local copy of `ContentBinding` that gained a value the verifier
// never emits, or lost one it does, would be a policy silently reading a vocabulary the
// relay does not speak.
import type { ContentBinding as SubstrateContentBinding, DescriptorBindingBasis } from '@interego/core';

/** A principal: a WebID for a person, a DID for an agent. No distinction is drawn between them. */
export type Principal = string;

/** A capability IRI from the workspace's published role profile. */
export type Capability = string;

/** A role IRI, and what the published profile says it permits. */
export interface RoleDefinition {
  readonly role: string;
  readonly permits: readonly Capability[];
}

/** A role profile, as published. Roles are data; this is the parsed form of that data. */
export interface RoleProfile {
  readonly profile: string;
  readonly roles: readonly RoleDefinition[];
}

// ── Provenance ───────────────────────────────────────────────────────────────

/**
 * What a reader established about who actually signed a record — the substrate verifier's
 * answer, not the record's own say-so.
 *
 * Deliberately the shape of `get_descriptor`'s `authorship` block plus one field this layer
 * derives, so there is nothing to translate and nothing to get subtly wrong in the
 * translation. Populated by `readAttestation` in `stream.ts`; a pure caller can also build
 * one by hand, which is what the tests do.
 */
export interface Attestation {
  /** The relay re-derived the canonical payload and the ECDSA signature matched. */
  readonly authorshipVerified: boolean;
  /**
   * The agent IRI the proof names. NOT usually the workspace principal: a person's
   * principal is a WebID and the signer is one of their agent DIDs, which is why the
   * checks below go through a {@link SignerResolver} rather than comparing strings.
   */
  readonly signedBy: string | null;
  /**
   * Whether the proof's own `iep:descriptorId` names the descriptor it was read from.
   *
   * ★ A proof block is plain Turtle inside a public descriptor, and the relay's verifier
   * checks the signature WITHOUT checking what it is attached to. So a proof lifted verbatim
   * out of one of a member's real records and pasted into a record somebody else fabricated
   * verifies clean, with the member named as signer — which is exactly the manufactured
   * participant this file exists to prevent. See `readAttestation` for what can and cannot
   * be determined about the binding from outside the substrate.
   */
  readonly boundToDescriptor: boolean;
  /**
   * ON WHAT BASIS the flag above is `true`. Carried because the boolean is a two-valued
   * reading of a three-valued verdict, and the value it erases is the weak one.
   *
   * `'exact-url'` compared host, pod, container and name. `'slug-only'` compared ONE path
   * segment: the proof names a `urn:`, and `slugFromIri` relates a URN to a URL by its last
   * segment alone, so the host and the pod were not compared and cannot be. A record served
   * from `https://attacker.example/anything/1712345678901.ttl` reaches `bound: true,
   * slug-only` against a proof minted for a real record at
   * `https://css/bee-pod/context-graphs/1712345678901.ttl`. `stream.ts` used to drop this on
   * the floor at the boundary; it now travels with the verdict it qualifies.
   *
   * ★ AND NO POLICY HERE REFUSES ON IT — DECIDED AGAINST, AND MEASURED, NOT ASSUMED. The
   * tempting rule is "field binding requires `exact-url`". It would refuse EVERY record the
   * substrate mints: `publish_context` mints `descriptor_id` as `urn:iep:<pod>:<epoch-ms>`,
   * so every honest membership record in existence is `slug-only`, and the rule fails closed
   * on 100% of honest data — the failure direction this area has already shipped once.
   *
   * What it would buy, measured after the parse-scope fix: nothing that is conferred. A
   * relocated verbatim copy of a genuinely signed acceptance produces a roster IDENTICAL to
   * the honest one — `workspace`, `member`, `accepts`, `stream` and the role all come out of
   * the signed block, and two copies present at once raise the acceptance-fork divergence
   * rather than escalating anything. See `tests/workspace-membership.test.ts`.
   *
   * What it leaves open is NOT nothing, and it is named rather than folded away: `head` — the
   * URL an operator dereferences to audit a record, and the URL printed in `unattested` and
   * in every `divergence` — is chosen by whoever hosts the copy. A `slug-only` row sends a
   * reader to a document the attacker controls. That is residual gap 1 in the README.
   *
   * Optional because a hand-built {@link Attestation} records no basis, and absent must never
   * read as `'exact-url'`.
   */
  readonly descriptorBindingBasis?: DescriptorBindingBasis;
  /**
   * Whether the substrate verified the proof against the CONTENT served with the record,
   * as opposed to only against the proof's own bytes. Read from
   * `get_descriptor.authorship.contentBinding` through an allowlist, not passed through:
   * see `readContentBinding` in `stream.ts` for why an unrecognised value must land on
   * `'unbound'` and why `'mismatched'` must not.
   *
   *   bound       the signed digest was recomputed over the payload actually served and
   *               matched. The record STATES the triples the signer signed. Not the same as
   *               byte-identity — see below.
   *   mismatched  the digest was recomputed and did NOT match. The signature is authentic
   *               and covers different content: the record was altered after signing.
   *   declared    the proof commits to a digest and nothing checked it — the payload was
   *               unreadable here, the digest is an older form no reader can recompute, or
   *               the signature failed before the content was reached.
   *   unbound     the proof carries no digest. Every proof written before content binding
   *               existed, plus any payload the digester could not parse. Silent about
   *               content.
   *
   * ★ `'bound'` IS TRIPLE-IDENTITY, NOT BYTE-IDENTITY, and the difference is deliberate.
   * The digest is taken over the graph's triples, so two documents sharing no bytes — a
   * different alias for the same namespace, statements reordered, reflowed, reindented —
   * produce the same digest and both verify. They have to: `publish()` rewrites the payload
   * on the way to the pod, so the bytes a reader is served are never the bytes the signer
   * signed, and a byte comparison would fail every honest record. What `'bound'` rules out
   * is a change in what the graph SAYS.
   *
   * Optional because a caller may hand-build an {@link Attestation} and because an older
   * relay does not return the field at all. Absent is read as `'unbound'` by
   * {@link refuseAttestation} — the value that claims least — so an unchanged relay can
   * never satisfy a policy that requires binding.
   */
  readonly contentBinding?: ContentBinding;
  /** The verifier's diagnostic when it refused, or this layer's when it could not read. */
  readonly reason?: string;
}

/**
 * Re-exported from the substrate rather than redeclared, so the two cannot drift into
 * meaning different things by the same name.
 *
 * ★ AND IT NOW ACTUALLY IS. This said "re-exported rather than redeclared" above a
 * hand-written copy of the union — the drift the sentence promised to prevent, sitting under
 * the sentence. It is an alias of `@interego/core`'s type now, so adding a value there is a
 * compile error here rather than a policy quietly not recognising it.
 */
export type ContentBinding = SubstrateContentBinding;

/** Re-exported for the same reason. See {@link Attestation.descriptorBindingBasis}. */
export type { DescriptorBindingBasis };

/**
 * Which grade of attribution a result carries. Two grades, never conflated — the same
 * discipline `compose.ts` applies to ordering, in the position where getting it wrong
 * invents a participant rather than reordering a feed.
 *
 *   asserted   the principal on a record is a LABEL, taken from whoever assembled the
 *              inputs. Nothing was verified.
 *   attested   every record folded in carried an `iep:authorshipProof` that the substrate
 *              verified, signed by an agent the expected principal vouches for.
 */
export type AttributionGrade = 'asserted' | 'attested';

/**
 * Who does this signer act for?
 *
 * A signature names an agent DID; a roster names principals. The mapping between them is
 * the agent registry on the principal's OWN pod — a claim only that principal can write,
 * which is what makes it evidence rather than assertion. Injected rather than looked up so
 * this module stays pure; `signerIndexFromRegistry` in `can.ts` builds one from the same
 * registry `scopesFromRegistry` already reads.
 */
export type SignerResolver = (signedBy: string) => Principal | SignerFinding | null;

/**
 * What a registry actually says about one signer, when a bare principal cannot say it.
 *
 * A resolver may still return a plain {@link Principal}, and {@link signerIsSelf} does, so
 * every resolver written against the older signature keeps working. The richer form exists
 * because two of a registry's possible answers are not a "who" at all, and both used to come
 * back indistinguishable from a clean attribution:
 *
 *   revoked     the delegation was WITHDRAWN. The union in `scopesFromRegistry` hides this
 *               completely whenever the principal has a second live agent: a review had an
 *               entry signed by a key its owner had already thrown out counted at the
 *               `attested` grade, because a different agent of the same person was live.
 *   contested   TWO principals' registries claim the same signing key. Anyone can write
 *               their own registry, so anyone can add a rival's key to it; answering with
 *               either claimant states one of two conflicting claims as established, and
 *               which one it is depends on the order the rows arrived in.
 */
export type SignerFinding =
  | {
      readonly acts: 'for';
      readonly principal: Principal;
      /** The registry row carries `revoked`. {@link refuseAttestation} refuses on it. */
      readonly revoked?: boolean;
    }
  | {
      readonly acts: 'contested';
      /** Every principal that claimed this signer. Deliberately not one of them. */
      readonly claimedBy: readonly Principal[];
    };

/** A signer is only itself. The safe default: it vouches for nobody it is not. */
export const signerIsSelf: SignerResolver = (signedBy: string) => signedBy;

/** Read a resolver's answer in whichever of its two forms it came back. */
function asFinding(answer: Principal | SignerFinding | null): SignerFinding | null {
  if (answer === null) return null;
  return typeof answer === 'string' ? { acts: 'for', principal: answer } : answer;
}

/** Require an attestation on every record, checked against the two parties named here. */
export interface AttestationPolicy {
  /**
   * Who is entitled to grant here. Mandatory rather than optional: "require attestation but
   * do not say against whom" has no safe answer, and expressing it in the type as a field
   * that can be left out is how it ends up being left out.
   */
  readonly convener: Principal;
  /** Defaults to {@link signerIsSelf}, which suits principals that sign as themselves. */
  readonly signerOf?: SignerResolver;
  /**
   * Also require that each record's proof was verified against the content served for it —
   * `contentBinding === 'bound'`. Refuses `'mismatched'`, `'declared'` and `'unbound'`
   * alike: one is proof the content was swapped, the other two establish nothing about the
   * record in front of the reader.
   *
   * Off by default, and deliberately: every proof written before content binding existed
   * is `'unbound'`, so defaulting this on would refuse every historical record in every
   * workspace at once. Turning it on only ever refuses MORE — see the monotonicity rule in
   * this module's header — so it is safe to raise, and the fold reports in
   * {@link Roster.recordContentBinding} whether it was.
   */
  readonly requireContentBinding?: boolean;
  /**
   * Also require that each conferring record's FIELDS were parsed from its own payload —
   * {@link FieldProvenance} present, naming this record. Refuses every hand-built row.
   *
   * ★ THIS IMPLIES {@link requireContentBinding}, IN CODE, AND MAY NOT BE SET WITHOUT IT.
   * Fields parsed out of bytes nobody re-digested are fields that may have been changed
   * after signing: the parse would faithfully report a role somebody edited in. "Read from
   * the record" is only worth something when the record is known to state what its signer
   * signed, so the fold ORs the two rather than letting a caller pick the combination that
   * looks strict and checks half.
   *
   * Off by default, and it has to be: nothing in the repo produced a grant or an acceptance
   * until `membership.ts`, so every existing caller hand-builds its rows and turning this on
   * by default would empty every roster at once. Turning it on only ever refuses MORE — see
   * the monotonicity rule in this module's header — and the fold reports in
   * {@link Roster.recordFieldBinding} whether it was on.
   */
  readonly requireFieldBinding?: boolean;
}

/**
 * Why this record cannot be attributed to `expected`, or null when it can.
 *
 * Every branch refuses. There is no path where a missing or unreadable attestation is
 * treated as an absent objection — an authorization record nobody could verify is not the
 * same as one that verified, and reading it as one is the whole defect.
 */
export function refuseAttestation(
  attestation: Attestation | undefined,
  expected: Principal,
  signerOf: SignerResolver = signerIsSelf,
  /**
   * Require `contentBinding === 'bound'` as well. Defaults OFF so an existing caller keeps
   * exactly its current behaviour; see {@link AttestationPolicy.requireContentBinding}.
   */
  requireContentBinding = false,
): string | null {
  if (attestation === undefined) {
    return 'it carries no attestation at all — nobody read its authorship proof, and an '
      + 'unchecked record is not a verified one';
  }
  if (!attestation.authorshipVerified) {
    return `its iep:authorshipProof did not verify (${attestation.reason ?? 'no reason given'})`;
  }
  if (!attestation.boundToDescriptor) {
    // ★ REFUSE WITHOUT ACCUSING. This branch used to say the proof "was copied in from
    // another record", stated as fact — and `readAttestation` sets the flag false for four
    // different situations, only one of which is a forgery. A descriptor named by the
    // PGSL-primary path (`holon-<hash>.ttl`) is refused here too, and a record's real author
    // was being called a forger in the one channel operators are told to watch. The
    // attestation's own reason distinguishes them; the verdict is the same either way.
    return 'its authorship proof does not name this descriptor'
      + (attestation.reason !== undefined ? ` (${attestation.reason})` : '')
      + ' — either the proof was minted for another record and copied in, or this record does '
      + 'not follow the naming convention the binding is compared on. Both are refused; only '
      + 'one of them is a forgery, and this layer cannot tell which';
  }
  if (requireContentBinding && attestation.contentBinding !== 'bound') {
    // ★ REFUSE WITHOUT ACCUSING — EXCEPT ON THE ONE VALUE THAT IS AN ACCUSATION. Three of
    // the four causes are age or blindness rather than mischief, and a message implying a
    // swap would be wrong about almost every record it fires on. `'mismatched'` is the
    // exception and has to read as one: it is a digest that was recomputed and did not
    // match. Giving it the same "not evidence of tampering" sentence as the others is how
    // the substrate's sharpest signal gets skimmed past. An absent field lands on
    // `'unbound'`: a relay too old to report binding has not checked it.
    const observed = attestation.contentBinding ?? 'unbound';
    if (observed === 'mismatched') {
      return 'this record\'s content does NOT match what its proof was signed over '
        + '(contentBinding: mismatched) — the digest was recomputed over the payload served '
        + 'and differed. The signature is authentic, so this is an authentic signature over '
        + 'different content: the record was altered after signing. This one IS evidence of '
        + 'tampering';
    }
    return 'this policy requires the proof to cover the record\'s CONTENT and it does not '
      + `(contentBinding: ${observed})`
      + (observed === 'unbound'
        // Not "every record published before content binding existed" — the publish path
        // still mints `unbound` today for any payload `canonicalGraphDigest` cannot parse
        // (JSON-LD graph_content, for one), so an operator told this was legacy data may be
        // looking at a record written seconds ago.
        ? ' — the proof carries no content digest at all. That is every record published '
          + 'before content binding existed, and also any record whose payload the digester '
          + 'could not parse, which includes ones written moments ago. It is intact and says '
          + 'nothing about what the record now contains'
        : ' — the proof commits to a digest but nothing was checked against it, usually '
          + 'because the payload could not be read here or the digest is a form no reader '
          + 'can recompute. Not evidence of tampering, and not evidence against it');
  }
  if (attestation.signedBy === null) {
    return 'the proof verified but names no signer, so it attributes the record to nobody';
  }
  const finding = asFinding(signerOf(attestation.signedBy));
  if (finding === null) {
    return `it was signed by ${attestation.signedBy}, and no agent registry vouches for that `
      + 'signer as acting for anyone';
  }
  if (finding.acts === 'contested') {
    // Reporting one of the claimants would state a false mapping as fact and let whoever
    // wrote their registry last decide it. A contested key is evidence of nothing.
    return `it was signed by ${attestation.signedBy}, and ${finding.claimedBy.length} registries `
      + `claim that signer (${finding.claimedBy.join(', ')}). A key two principals both claim `
      + 'attributes a record to neither of them';
  }
  if (finding.principal !== expected) {
    return `it was signed by ${attestation.signedBy}, who acts for ${finding.principal} — `
      + `not for ${expected}`;
  }
  if (finding.revoked === true) {
    // ★ A WITHDRAWN KEY DOES NOT ATTEST, even though it still identifies. The registry cannot
    // tell a routine rotation from a compromise, and the safe reading of an authorization
    // statement that has been withdrawn is that it authorises nothing — the same rule
    // `capabilitiesOfAgent` applies. A review signed an entry with a key its owner had
    // already revoked and it was admitted at the `attested` grade, because the union in
    // `scopesFromRegistry` still found the principal a live agent. What this costs is real
    // and is stated where it is paid: rotating a key withholds everything it signed until
    // the retired row is put back live. Withheld and NAMED, never silently dropped.
    return `it was signed by ${attestation.signedBy}, whose delegation from ${expected} is `
      + 'REVOKED. The row still identifies the signer, and a withdrawn delegation is not '
      + 'evidence the owner stands behind what it signed — a rotation and a compromised key '
      + 'are the same row';
  }
  return null;
}

/**
 * Where a record's own fields came from.
 *
 * ★ THE EVIDENCE `Attestation` COULD NEVER CARRY. An attestation is a statement about a
 * SIGNATURE; this is a statement about the FIELDS sitting next to it. The two were the same
 * gap for four rounds: the substrate could prove a record was signed, then prove it stated
 * what was signed, and the fold still read `role`, `grantedTo` and `stream` off an object
 * whoever called it had typed. `membership.ts` is the only thing that produces this — its
 * readers parse every field out of the payload `get_descriptor` served, in the same response
 * the binding verdict came from.
 *
 * ★ AND IT IS STILL A CLAIM THIS PURE MODULE CANNOT CHECK, exactly like `Attestation`. A
 * caller can hand-build `{source: 'payload', descriptor: head}` beside invented fields, and
 * nothing here can tell. What the fold CAN do — and does, in {@link refuseFieldBinding} — is
 * the one check that is not self-certifying: `descriptor` must be the record's own `head`.
 * That catches the realistic failure, which is not a liar but a composer reading many pods
 * and attaching one record's parsed fields to another record's head.
 */
export interface FieldProvenance {
  /**
   * `'payload'` — every field on this record was parsed from the record's own bytes.
   *
   * A single-valued union rather than a boolean so that a future second source has to be
   * named and reasoned about rather than folded into `true`.
   */
  readonly source: 'payload';
  /**
   * The descriptor URL those bytes were read from. MUST equal the record's `head`; see
   * {@link refuseFieldBinding}.
   */
  readonly descriptor: string;
}

/** Half a membership, from the convener's pod. `head` is the descriptor URL of this version. */
export interface Grant {
  readonly head: string;
  readonly workspace: string;
  readonly grantedTo: Principal;
  readonly role: string;
  readonly revoked?: boolean;
  /** What the substrate's verifier said about who signed this grant. See {@link Attestation}. */
  readonly attestation?: Attestation;
  /**
   * Set by `readGrantRecord` when these fields were parsed from the record's payload rather
   * than typed by a caller. Absent on every hand-built grant, which is the safe default.
   */
  readonly fieldProvenance?: FieldProvenance;
}

/** The other half, from the member's own pod. */
export interface Acceptance {
  readonly head: string;
  readonly workspace: string;
  readonly member: Principal;
  readonly accepts: string;
  readonly stream: string;
  readonly withdrawn?: boolean;
  /** What the substrate's verifier said about who signed this acceptance. */
  readonly attestation?: Attestation;
  /** Set by `readAcceptanceRecord`. See {@link Grant.fieldProvenance}. */
  readonly fieldProvenance?: FieldProvenance;
}

/**
 * Why these fields cannot be treated as the record's own, or null when they can.
 *
 * Separate from {@link refuseAttestation} because it answers a different question about a
 * different part of the row — who signed this, versus where did these values come from —
 * and collapsing the two would produce a single verdict that cannot say which half failed.
 *
 * Every branch refuses, and the default refuses: a record with no provenance is a record
 * whose fields somebody typed, which is the condition this whole gate exists to notice.
 */
export function refuseFieldBinding(
  provenance: FieldProvenance | undefined,
  head: string,
  requireFieldBinding = false,
): string | null {
  if (!requireFieldBinding) return null;
  if (provenance === undefined) {
    return 'its fields were typed by whoever called this fold rather than read from the '
      + 'record — the role, the grantee and the stream are caller-supplied, so one of a '
      + 'member\'s ordinary signed records would pass every signature check as their '
      + 'acceptance. Read it with readGrantRecord/readAcceptanceRecord in membership.ts';
  }
  // `!== 'payload'` rather than a positive test: this arrives as JSON in a federated
  // composer, and a value the type says is impossible must not come out the admitting end.
  if (provenance.source !== 'payload') {
    return `its fields claim an unrecognised source (${String(provenance.source)}), and an `
      + 'unknown provenance establishes nothing about where a value came from';
  }
  if (provenance.descriptor !== head) {
    // ★ THE ONE CHECK HERE THAT IS NOT SELF-CERTIFYING, and it catches a real shape rather
    // than a hypothetical one. A composer that reads several pods holds many parsed records
    // at once; attaching the fields parsed from <a> to the row for <b> produces a membership
    // assembled from two different documents, each individually genuine. The mismatch is
    // visible without trusting anybody's say-so, so it is checked.
    return `its fields were parsed from <${provenance.descriptor}> and this row is <${head}> — `
      + 'the values and the record they are attributed to came from different documents, so '
      + 'neither one states what the other says';
  }
  return null;
}

/** A record the fold refused to use, and why. Reported so a refusal is diagnosable. */
export interface UnattestedRecord {
  readonly kind: 'grant' | 'acceptance';
  /** The descriptor URL of the refused record. */
  readonly head: string;
  /** Who the record claims to be about — the grantee for a grant, the member for an acceptance. */
  readonly principal: Principal;
  readonly because: string;
  /**
   * Whether this record still TOOK EFFECT despite being refused, because what it carries is a
   * restriction rather than a conferral.
   *
   * ★ Non-omittable, and it is the field that makes a refusal readable. A refused revocation
   * and a refused grant used to render identically here — `{kind: 'grant', because: 'it
   * carries no attestation at all…'}` — so a revocation that had (in the erasing version)
   * failed to take effect was indistinguishable from a grant that had failed to create a
   * member, and the difference between those two is whether somebody still holds authority
   * they were supposed to have lost. Now both the fact and its direction are here: `true`
   * means the member was removed anyway.
   */
  readonly restrictionStillApplied: boolean;
}

/** What a principal's own delegation already permits, independent of any workspace. */
export interface DelegatedScope {
  readonly principal: Principal;
  readonly capabilities: readonly Capability[];
}

export interface Member {
  readonly principal: Principal;
  readonly role: string;
  readonly stream: string;
  /** role.permits ∩ delegatedScope — what this principal may ACTUALLY do here. */
  readonly effective: readonly Capability[];
  /** Permitted by the role but absent from the delegation, so withheld. Explains a refusal. */
  readonly withheldByDelegation: readonly Capability[];
  /** Set when this member's grant or acceptance chain had more than one head. */
  readonly divergence?: Divergence;
}

export interface Divergence {
  readonly kind: 'grant' | 'acceptance' | 'scope' | 'role';
  readonly heads: readonly string[];
  readonly note: string;
  /**
   * The distinct roles the forked heads name, for `kind: 'grant'`.
   *
   * ★ Carried so {@link explain} can tell a fork that CAUSES a refusal from one that merely
   * accompanies it. Two heads both naming Observer intersect to Observer, so a refused
   * `append` has nothing to do with the fork — and `explain` was blaming it anyway, and
   * prescribing "republish a single clean head", which changes the answer by not one byte.
   */
  readonly roles?: readonly string[];
}

export interface Roster {
  readonly workspace: string;
  readonly members: readonly Member[];
  /** Grants nobody has accepted yet: offers, not members. Surfaced so they are not invisible. */
  readonly pendingInvitations: readonly { principal: Principal; role: string; grant: string }[];
  /** Every divergence found, so an operator can republish a clean head. */
  readonly divergences: readonly Divergence[];
  /**
   * Whether the two-sidedness of this roster was VERIFIED or merely assumed.
   *
   * ★ Non-omittable, and that is the point. `members` used to be a list whose provenance
   * lived only in a README claim, and the claim was false. A caller now cannot obtain the
   * list without also holding the answer to "who checked?" — modelled on
   * `crossStreamOrderIsAdvisory`, which exists so nobody can consume a merged feed without
   * having seen that its cross-member order is a guess.
   */
  readonly membershipGrade: AttributionGrade;
  /** The same fact in a sentence, because a two-value enum is easy to not branch on. */
  readonly attributionNote: string;
  /**
   * Records refused for failing the attestation policy. Empty when no policy was given —
   * an unchecked record is not a refused one, and `membershipGrade` is what distinguishes
   * the two.
   *
   * A refused record still restricts: see {@link UnattestedRecord.restrictionStillApplied}
   * and the monotonicity note in this module's header.
   */
  readonly unattested: readonly UnattestedRecord[];
  /**
   * Whether every record that CONFERRED membership here had its authorship proof verified
   * against the content served for it, rather than only against the record's URL.
   *
   *   bound     `attestation.requireContentBinding` was set, so each conferring grant and
   *             acceptance carried `contentBinding: 'bound'` — the substrate recomputed the
   *             signed digest over the payload it served and matched it. The record states
   *             the triples that were signed.
   *   unbound   no policy, or the policy did not require binding. Nothing here was checked
   *             against a record's content.
   *
   * ★ WHAT `'bound'` STILL DOES NOT MEAN — read this before relying on it. It establishes
   * that the record SAYS what was signed. It does NOT establish byte-identity: the digest
   * is over triples, and a re-serialisation that changes every byte still matches. And it
   * does not establish that what the record says is what the fold was told it says — see
   * {@link Roster.recordFieldBinding}, the half that is still open and a separate field for
   * exactly that reason.
   */
  readonly recordContentBinding: 'bound' | 'unbound';
  /**
   * Whether the FIELDS of every conferring record were read out of that record, rather than
   * typed by whoever called this fold.
   *
   *   bound     `attestation.requireFieldBinding` was set, so each conferring grant and
   *             acceptance carried a {@link FieldProvenance} naming itself — the values were
   *             parsed from the payload `get_descriptor` served, in the same response whose
   *             `contentBinding` was `'bound'`. The record SAYS what this roster reports it
   *             says. Produced only by `readGrantRecord` / `readAcceptanceRecord`.
   *   unbound   no policy, or the policy did not require it. `Grant.role`,
   *             `Grant.grantedTo`, `Acceptance.member`, `Acceptance.stream` and the rest are
   *             whatever the caller typed, and the attestation beside them covers none of
   *             them. One of a member's ordinary published log entries — genuinely signed,
   *             genuinely content-bound, genuinely theirs — passes as their acceptance at
   *             whatever role the caller chose.
   *
   * Non-omittable for the reason `crossStreamOrderIsAdvisory` is: the two rosters look
   * identical, and a caller must not be able to read `members` without having been handed
   * the difference.
   *
   * ★ WHICH VALUES IT COVERS, EXACTLY — AND {@link Member.role} IS NOT ONE OF THEM.
   *
   * `'bound'` is a statement about every CONFERRING RECORD: each one's `workspace`,
   * `grantedTo`, `role`, `member`, `accepts` and `stream` were parsed from its own payload.
   * It is NOT a statement about the DERIVED fields this fold computes across records, and
   * the two were being read as one.
   *
   * `Member.role` and `Member.effective` are both folded across the RESTRICTING track —
   * every in-workspace grant for the principal, including ones this policy refused — because
   * a refusal must never widen an intersection or widen a printed label. A row whose fields
   * the caller typed, which appears in `unattested` and confers nothing, can therefore still
   * decide the role LABEL a field-bound member is printed with, and still narrow their
   * capabilities. Measured: a grant with no attestation and no provenance, listed in
   * `unattested`, changed the printed role of an otherwise field-bound member while this
   * field read `'bound'`.
   *
   * That is not an escalation and it cannot become one — the direction is fixed by
   * construction, and the enumeration in `tests/workspace-adversarial.test.ts` is what fixes
   * it: `knownRole` is the NARROWEST role across `gs` and `roleCaps` is the INTERSECTION
   * across `gs`, so an extra row can only ever subtract. But "bound" was being read as
   * covering the label, and it does not. Binding the label instead would mean choosing it off
   * the conferring track, which is exactly the change that let a stricter policy print
   * `Convener` beside an `Observer`'s capabilities — an escalation of the word.
   *
   * ★ WHAT `'bound'` STILL DOES NOT MEAN, and this is the line most at risk of being
   * over-read now that the value is reachable. It establishes that each record states the
   * membership this roster reports. It does NOT establish that the SIGNER of the grant was
   * entitled to grant: `AttestationPolicy.convener` is a principal the caller names, and
   * nothing in this fold or in `membership.ts` fetches the workspace descriptor to check
   * `wsp:convener` against it. A workspace whose convener is misidentified produces a
   * perfectly field-bound roster of the wrong memberships. That is residual gap 6 in the
   * README and it is open.
   */
  readonly recordFieldBinding: 'bound' | 'unbound';
}

const uniqueSorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();

/** Intersection, order-independent and duplicate-free. */
function intersect(a: readonly string[], b: readonly string[]): string[] {
  const inB = new Set(b);
  return uniqueSorted(a.filter(x => inB.has(x)));
}

/** Group by a key, preserving input order within each group. */
function groupBy<T>(xs: readonly T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    const g = m.get(k);
    if (g) g.push(x); else m.set(k, [x]);
  }
  return m;
}

/**
 * Fold grant heads and acceptance heads into a roster.
 *
 * Inputs are HEADS — the current version of each chain — not whole histories. Resolving a
 * chain to its head is the substrate's job (supersession), not this module's; conflating the
 * two would put chain-walking logic in an authorization path where it does not belong.
 */
export function foldRoster(args: {
  readonly workspace: string;
  readonly profile: RoleProfile;
  readonly grants: readonly Grant[];
  readonly acceptances: readonly Acceptance[];
  readonly scopes: readonly DelegatedScope[];
  /**
   * Require each half to have been signed by the party it is supposed to come from.
   *
   * Omitting it is legal and is what every existing caller does, so this is not a gate that
   * can be forgotten silently: the omission is reported as `membershipGrade: 'asserted'`
   * with {@link Roster.attributionNote} spelling out that a convener holding both records
   * could have written both halves.
   */
  readonly attestation?: AttestationPolicy;
}): Roster {
  const { workspace, profile, grants, acceptances, scopes } = args;
  const signerOf = args.attestation?.signerOf ?? signerIsSelf;

  // ★ A ROLE DECLARED TWICE IS INTERSECTED, NOT OVERWRITTEN — the same rule as the scope
  // rows below it, and it was a plain `new Map` two lines above them. A profile declaring
  // `#Observer` narrow then wide gave the Observer append, grant and revoke; reversed, none
  // of the three; `divergences` was empty both ways and `explain()` affirmed whichever
  // answer came out. Order-dependent privilege in a published governance document, decided
  // by which triple the parser emitted last.
  const permitsOf = new Map<string, string[]>();
  const duplicatedRoles = new Set<string>();
  for (const r of profile.roles) {
    const permits = uniqueSorted([...r.permits]);
    const prior = permitsOf.get(r.role);
    if (prior === undefined) { permitsOf.set(r.role, permits); continue; }
    duplicatedRoles.add(r.role);
    permitsOf.set(r.role, intersect(prior, permits));
  }
  // ★ A PRINCIPAL APPEARING TWICE IS INTERSECTED, NOT OVERWRITTEN.
  //
  // `new Map(scopes.map(...))` silently last-wins, which is last-write-wins on a
  // DELEGATION record — the exact thing this module's header says it never does on
  // authorization data. An independent review demonstrated it through the documented
  // builder: `[{alice, ReadOnly}, {alice, ReadWrite}]` gave alice append and revoke;
  // reversed, neither; and `divergences` was empty both times. Order-dependent authority,
  // unreported, in the direction that grants.
  //
  // Two rows for one principal is not exotic: a federated composer reads one agent
  // registry per pod, so it produces one row per (principal, pod). The intersection is
  // the same choice the grant-head divergence makes, for the same reason — under
  // disagreement, the weaker reading is the only safe one — and it is REPORTED so the
  // duplicate can be resolved rather than silently tolerated.
  const scopeOf = new Map<Principal, string[]>();
  const duplicatedScopes = new Set<Principal>();
  for (const s of scopes) {
    const caps = uniqueSorted([...s.capabilities]);
    const prior = scopeOf.get(s.principal);
    if (prior === undefined) { scopeOf.set(s.principal, caps); continue; }
    duplicatedScopes.add(s.principal);
    scopeOf.set(s.principal, intersect(prior, caps));
  }

  // Records naming a different workspace are not ours to interpret. Dropping them silently
  // is correct: a pod holds many workspaces' records and seeing another's is not an error.
  const inWorkspaceGrants = grants.filter(g => g.workspace === workspace);
  const inWorkspaceAcceptances = acceptances.filter(a => a.workspace === workspace);

  // ★ THE PROVENANCE GATE, AND IT RUNS BEFORE ANYTHING ELSE READS THESE ROWS.
  //
  // Placed here rather than inside the per-principal loop so there is exactly one place a
  // record can enter the fold from. The grant side is checked against the CONVENER and the
  // acceptance side against the member it names — different parties, which is the whole of
  // what "two-sided" means once it is a fact instead of a layout convention.
  //
  // Refused records are named, not dropped: a convener who fabricated an acceptance sees
  // their grant surface as a PENDING INVITATION plus a line in `unattested` saying who
  // actually signed the acceptance. Dropping it would render identically to a grant nobody
  // has answered yet, which is the one reading that hides what happened.
  //
  // ★★ AND WHAT THE GATE PRODUCES IS THE CONFERRING TRACK ONLY. The restricting track below
  // it is `inWorkspaceGrants` / `inWorkspaceAcceptances` — every row, refused or not — and
  // the two are read separately for the rest of this function. That split is the whole of
  // the monotonicity guarantee in the header: a refused record can still revoke, still
  // withdraw and still narrow an intersection, so no configuration of this fold grants more
  // than a weaker one. Reversing it is what made a revocation nobody could attest vanish.
  const unattested: UnattestedRecord[] = [];
  let conferringGrants = inWorkspaceGrants;
  let conferringAcceptances = inWorkspaceAcceptances;
  const requireFields = args.attestation?.requireFieldBinding === true;
  // ★ FIELD BINDING FORCES CONTENT BINDING ON, and the OR is the enforcement. Reading the
  // fields out of a payload the substrate never re-digested would report, faithfully and
  // precisely, whatever somebody edited into the record after it was signed — a strictly
  // worse answer than admitting the fields were untrusted, because it looks checked. The
  // combination `requireFieldBinding: true, requireContentBinding: false` is therefore not
  // reachable rather than merely discouraged. See `AttestationPolicy.requireFieldBinding`.
  const requireBinding = args.attestation?.requireContentBinding === true || requireFields;
  if (args.attestation) {
    const convener = args.attestation.convener;
    conferringGrants = inWorkspaceGrants.filter(g => {
      // Attestation first: "who signed this" is the more fundamental question and its
      // refusals name a party, which is what an operator acts on.
      const why = refuseAttestation(g.attestation, convener, signerOf, requireBinding)
        ?? refuseFieldBinding(g.fieldProvenance, g.head, requireFields);
      if (why === null) return true;
      unattested.push({
        kind: 'grant', head: g.head, principal: g.grantedTo, because: why,
        restrictionStillApplied: g.revoked === true,
      });
      return false;
    });
    conferringAcceptances = inWorkspaceAcceptances.filter(a => {
      const why = refuseAttestation(a.attestation, a.member, signerOf, requireBinding)
        ?? refuseFieldBinding(a.fieldProvenance, a.head, requireFields);
      if (why === null) return true;
      unattested.push({
        kind: 'acceptance', head: a.head, principal: a.member, because: why,
        restrictionStillApplied: a.withdrawn === true,
      });
      return false;
    });
  }

  const divergences: Divergence[] = [];
  for (const role of [...duplicatedRoles].sort()) {
    divergences.push({
      kind: 'role',
      heads: [profile.profile],
      note:
        `${role} is declared more than once in <${profile.profile}>. No winner is chosen: the `
        + 'INTERSECTION of its permits applies. Whichever declaration a parser emitted last '
        + 'would otherwise decide the role, so the same published profile would confer '
        + 'different authority depending on how it was read.',
    });
  }
  for (const principal of [...duplicatedScopes].sort()) {
    divergences.push({
      kind: 'scope',
      heads: [principal],
      note:
        `${principal} has more than one delegated-scope record. No winner is chosen: the `
        + 'INTERSECTION applies. Last-write-wins on a delegation record makes authority '
        + 'depend on the order rows happened to arrive in, which is not a decision anyone made.',
    });
  }
  const members: Member[] = [];
  const pending: { principal: Principal; role: string; grant: string }[] = [];

  // The CONFERRING track: only records that passed the gate can create a member, name a
  // role, choose a stream or raise an invitation.
  const grantsByPrincipal = groupBy(conferringGrants, g => g.grantedTo);
  const acceptancesByGrant = groupBy(conferringAcceptances, a => a.accepts);
  // The RESTRICTING track: every in-workspace record, refused or not. Read ONLY where a
  // record takes authority away — revocation, withdrawal, and the intersection across forked
  // heads. Identical to the conferring track when no policy was given, which is why the two
  // configurations cannot diverge in the granting direction.
  const restrictingGrantsByPrincipal = groupBy(inWorkspaceGrants, g => g.grantedTo);
  const restrictingAcceptancesByGrant = groupBy(inWorkspaceAcceptances, a => a.accepts);

  // ★ THE WALK IS OVER THE RESTRICTING TRACK, AND `conferring` MAY BE EMPTY. Walking the
  // conferring grants meant a principal whose every grant was refused was never visited at
  // all — so the fork on their heads went unreported under exactly the policy that had the
  // most evidence of it, while a weaker policy named it. Divergence reporting is now a
  // function of the restricting track alone, which is the same set under every policy, so no
  // configuration can be quieter than another.
  //
  // Nothing is granted by widening the walk: a member needs a conferring grant AND a
  // conferring acceptance, and a pending invitation is raised from `conferring` — both empty
  // here, so an all-refused principal produces warnings and `unattested` rows and nothing else.
  for (const [principal, gs] of [...restrictingGrantsByPrincipal].sort((x, y) => x[0].localeCompare(y[0]))) {
    const conferring = grantsByPrincipal.get(principal) ?? [];
    // ── grant side ──
    // ★ COUNT HEADS, NOT ROWS. Gating on `gs.length` reported a fork for a principal whose
    // single grant simply arrived twice: "2 concurrent grant heads" above a `heads` list of
    // length one. The duplicate is ordinary — the same federated composer that produces two
    // scope rows per principal reads the convener's pod through two registries — and this is
    // the one channel operators are told to act on, so a phantom on it sends someone hunting
    // a divergence that does not exist and erodes trust in the ones that do.
    const grantHeads = uniqueSorted(gs.map(g => g.head));
    const grantRoles = uniqueSorted(gs.map(g => g.role));

    // Revocation is decisive in either direction: if ANY head revokes, the member is out.
    // Erring towards removal is the safe direction — a wrongly-removed member complains, a
    // wrongly-retained one does not.
    //
    // ★ READ OFF THE RESTRICTING TRACK, so a revocation nobody could attest still removes.
    // The erasing version filtered it out above and the member kept everything: turning the
    // policy on granted more than leaving it off, and `unattested` rendered the dropped
    // revocation identically to a dropped grant. Honouring it means a row anyone can inject
    // can evict — a denial of service the asserted configuration already permits in full,
    // and the strictly lesser evil. `restrictionStillApplied` on the `unattested` entry is
    // where a reader is told the refusal did not save the member.
    const revoked = gs.some(g => g.revoked === true);

    let grantDivergence: Divergence | undefined;
    if (grantHeads.length > 1) {
      grantDivergence = {
        kind: 'grant',
        heads: grantHeads,
        roles: grantRoles,
        // ★ The note used to be pushed before the revocation check and said an intersection
        // applied to a principal who had just been removed entirely. A divergence report
        // that asserts an outcome that did not happen sends an operator to repair a live
        // member's authority when there is no live member.
        note: revoked
          ? `${grantHeads.length} concurrent grant heads for ${principal}, one of which REVOKES. `
            + 'No intersection applies and no winner is chosen: the principal is removed. A '
            + 'revocation on any head is decisive, because a wrongly-removed member complains '
            + 'and a wrongly-retained one does not.'
          : `${grantHeads.length} concurrent grant heads for ${principal}. No winner is chosen: the `
            + 'intersection of their capabilities applies. Last-write-wins on an authorization '
            + 'record can silently escalate privilege, so this is reported instead.',
      };
      divergences.push(grantDivergence);
    }

    if (revoked) continue;

    // ★ INTERSECTED ACROSS THE RESTRICTING TRACK. Refusing one of two heads would delete the
    // narrower one and hand the member the wider head's capabilities outright: heads
    // {Convener attested, Observer unattested} gave `read` with no policy and four
    // capabilities with one. A refusal must never widen an intersection.
    const roleCaps = gs
      .map(g => permitsOf.get(g.role) ?? [])
      .reduce((acc, caps) => (acc === null ? [...caps] : intersect(acc, caps)), null as string[] | null)
      ?? [];

    // A grant naming a role the profile does not declare contributes nothing. The publish
    // shape should already have refused it; this is the second line, because a profile can
    // be superseded after a grant was written and the fold must not then invent authority.
    //
    // ★ OFF THE RESTRICTING TRACK, NARROWEST HEAD WINS — the same rule as `roleCaps`, and it
    // has to be, because this is the label printed beside those capabilities. Reading
    // `conferring.find(...)` instead let a stricter policy WIDEN the label: with heads
    // {Observer unbound, Convener bound}, refusing the Observer head made `knownRole` skip
    // to Convener, so `requireContentBinding: true` reported a Convener whose capabilities
    // were still the Observer intersection `[read]`. Capabilities never widened and `may()`
    // stayed correct — but the role is what a person reads, and a security output that
    // escalates the word while holding the permissions is still an escalation.
    //
    // `gs` is identical under every policy, so any deterministic choice over it is monotone;
    // narrowest-first is chosen so a refused head can only ever narrow the label. Ties broken
    // lexicographically for stability.
    const knownRole = uniqueSorted(gs.map(g => g.role).filter(r => permitsOf.has(r)))
      .sort((a, b) => ((permitsOf.get(a)?.length ?? 0) - (permitsOf.get(b)?.length ?? 0)) || a.localeCompare(b))[0];

    // ★ WITHDRAWAL OFF THE RESTRICTING TRACK, for the same reason as revocation: an
    // acceptance carrying `withdrawn` that could not be attested must still remove the
    // member, or the policy retains someone the weaker configuration lets go.
    //
    // Computed BEFORE the pending branch, and the monotonicity enumeration is what found
    // that it had to be. With the withdrawal on a refused record, the conferring track saw
    // NO acceptance at all and raised a pending invitation — so a principal who had left was
    // rendered as one who had never answered, under the strong configuration only, sending
    // the convener to chase somebody for a reply they had already given and then retracted.
    const withdrawn = gs
      .flatMap(g => restrictingAcceptancesByGrant.get(g.head) ?? [])
      .some(a => a.member === principal && a.withdrawn === true);

    const accepted = conferring
      .flatMap(g => acceptancesByGrant.get(g.head) ?? [])
      .filter(a => a.member === principal);

    // Counting rows here was worse than on the grant side, because `accepted` is re-fetched
    // once per grant head: one duplicated grant row pulled the SAME acceptance in twice and
    // manufactured a second, entirely fictional fork on a member's own chain — a pod the
    // operator would then go and inspect for a conflict that was never written there.
    //
    // ★ COUNTED OFF THE RESTRICTING TRACK, like `grantHeads` above. Counted off `accepted`
    // instead, a stricter policy DELETED this warning: with two acceptance heads where one
    // could not be attested, the loose configuration said "their stream is ambiguous until
    // one head is republished cleanly" and the strict configuration said nothing — while
    // still reporting a different stream than the loose one had. A warning is not a grant,
    // so refusing a record must never remove it; the whole point of the ambiguity note is
    // that the fold cannot tell which head is the real one, and refusing one head does not
    // make the fold able to tell.
    const acceptanceHeads = uniqueSorted(
      gs.flatMap(g => restrictingAcceptancesByGrant.get(g.head) ?? [])
        .filter(a => a.member === principal)
        .map(a => a.head),
    );
    //
    // ★ AND RAISED BEFORE THE "no acceptance at all" BAIL-OUT, for the same reason. When a
    // policy refuses EVERY head the member falls through to a pending invitation, and this
    // note used to be skipped entirely on that path — so the configuration with the most
    // evidence of a fork was the one that mentioned it least.
    let acceptanceDivergence: Divergence | undefined;
    if (acceptanceHeads.length > 1) {
      acceptanceDivergence = {
        kind: 'acceptance',
        heads: acceptanceHeads,
        // Same correction as the grant note: "the member is included" was emitted for a
        // principal the withdrawal check below had already removed.
        note: withdrawn
          ? `${acceptanceHeads.length} concurrent acceptance heads for ${principal}, and one of `
            + 'them WITHDRAWS. The member is NOT included: a withdrawal on any head is '
            + 'decisive, so the ambiguity about which stream is theirs does not arise.'
          : accepted.length === 0
            ? `${acceptanceHeads.length} concurrent acceptance heads for ${principal}, and NONE of `
              + 'them could be attested under this policy. The member is not included and is '
              + 'listed as invited instead — but they did answer, more than once, and `unattested` '
              + 'says why each answer was refused.'
            : `${acceptanceHeads.length} concurrent acceptance heads for ${principal}. The member is `
              + 'included, but their stream is ambiguous until one head is republished cleanly.',
      };
      divergences.push(acceptanceDivergence);
    }

    if (accepted.length === 0) {
      if (!withdrawn) {
        for (const g of conferring) pending.push({ principal, role: g.role, grant: g.head });
      }
      continue;
    }

    if (withdrawn) continue;

    const scope = scopeOf.get(principal);
    // ★ NO SCOPE MEANS NO CAPABILITY, not full capability. A principal whose delegation could
    // not be resolved is unauthenticated as far as this fold is concerned. Defaulting the
    // other way would make an outage into a privilege grant.
    const effective = scope === undefined ? [] : intersect(roleCaps, scope);
    const withheld = scope === undefined ? uniqueSorted(roleCaps) : roleCaps.filter(c => !scope.includes(c));

    members.push({
      principal,
      role: knownRole ?? uniqueSorted(gs.map(g => g.role))[0]!,
      // ★ THE ONE FIELD THAT STAYS ON THE CONFERRING TRACK, AND IT CAN DIFFER BETWEEN
      // POLICIES. Naming the stream IS a conferring act — it decides which pod a reader goes
      // to for this member's records — so an acceptance nobody could attest must not choose
      // it. The consequence is that refusing a head re-picks `accepted[0]` and a stricter
      // policy can name a stream a weaker one never named. That is not an escalation (no
      // authority moves with it) but it IS a difference a caller acts on, so it is never
      // silent: `acceptanceHeads` is counted off the restricting track above, so whenever
      // two heads exist to disagree about, BOTH configurations raise the `acceptance`
      // divergence saying the stream is ambiguous. The enumeration asserts exactly that
      // pairing — see the acceptance-count axis in tests/workspace-adversarial.test.ts.
      stream: accepted[0]!.stream,
      effective,
      withheldByDelegation: uniqueSorted(withheld),
      ...(grantDivergence ?? acceptanceDivergence
        ? { divergence: grantDivergence ?? acceptanceDivergence! }
        : {}),
    });
  }

  return {
    workspace,
    members,
    pendingInvitations: pending.sort((a, b) => a.principal.localeCompare(b.principal)),
    divergences,
    membershipGrade: args.attestation ? 'attested' : 'asserted',
    attributionNote: args.attestation
      ? `Membership is ATTESTED: every grant folded in carries an iep:authorshipProof the `
        + `substrate verified and traced to ${args.attestation.convener}, and every acceptance `
        + 'one traced to the member it names. '
        + `${unattested.length} record(s) were refused and are listed in \`unattested\`. `
        + 'A refused record still RESTRICTS — a revocation or a withdrawal takes effect '
        + 'whether or not it can be attributed, so turning this policy on never grants more '
        + 'than leaving it off; `restrictionStillApplied` says which refusals did. '
        + (requireBinding
          ? 'Content binding was REQUIRED and every conferring record met it: the substrate '
            + 'recomputed each signed digest over the payload it served and matched it, so '
            + 'each record STATES what its signer signed. That is triple-identity, not '
            + 'byte-identity — the digest is over the graph\'s triples, so a record can be '
            + 'reordered, reindented or re-prefixed and still match. What it rules out is a '
            + 'change in what the record says. The digest covers ONE REGION of each served '
            + 'document — the named-graph block — and the fields above were parsed from that '
            + 'same region and no other. '
          : 'Content binding was NOT required, so nothing here was checked against a '
            + 'record\'s content; pass `requireContentBinding` to demand it. ')
        + (requireFields
          ? 'Field binding was REQUIRED and every conferring record met it: the role, the '
            + 'grantee, the stream and the grant each acceptance answers were PARSED FROM THE '
            + 'RECORD, in the same read whose content binding matched — not typed by whoever '
            + 'called this fold. One of a member\'s ordinary signed log entries no longer '
            + 'passes as their acceptance: it is a wsp:Entry, it declares no '
            + 'wsp:MembershipAcceptance, and the reader refuses it before the fold sees it. '
            // ★ SCOPED, because it was being read as covering more than it does. `Member.role`
            // and `Member.effective` are folded across the RESTRICTING track, so a refused,
            // caller-typed row can still narrow both. It only ever subtracts — but "bound"
            // was standing in for "and the label is bound too", and it is not.
            + 'That covers each RECORD. `Member.role` and `Member.effective` are folded '
            + 'ACROSS records including refused ones, so a row listed in `unattested` can '
            + 'still narrow a member\'s role label and capabilities — never widen them. '
            + 'RESIDUAL, and it is the one left: nothing checked that the convener named in '
            + `this policy (${args.attestation.convener}) is the workspace's convener. That is `
            + 'a value the caller typed, and no record here was read from <'
            + `${workspace}> to confirm it. See \`recordFieldBinding\`.`
          : 'Residual, and it is not small, and content binding does not reduce it: every '
            + 'field here — the role, the grantee, the stream — is as the CALLER TYPED IT '
            + 'rather than read from the record, so one of a member\'s ordinary signed '
            + 'records passes this gate as their acceptance. That record is genuinely theirs '
            + 'and genuinely unmodified, which is why binding its content changes nothing '
            + 'about the attack. Pass `requireFieldBinding` and read the records with '
            + 'membership.ts to close it. See `recordFieldBinding`. A proof lifted out of a '
            + 'principal\'s real record and pasted into a fabricated one is narrowed '
            + 'separately — see `readAttestation`.')
      : 'Membership is ASSERTED, not attested: no grant or acceptance was checked for an '
        + 'authorship proof, so a convener who holds both records could have written both '
        + 'halves and this list would look identical. Pass `attestation` to foldRoster to '
        + 'require that the grant was signed for the convener and the acceptance for the member.',
    unattested,
    // 'bound' ONLY when the policy demanded it, never merely because the records happened
    // to arrive bound. The field reports what this fold ENFORCED: a caller that did not ask
    // for content binding did not get a guarantee of it, and reporting one off the back of
    // whatever the inputs happened to carry would be a claim about data rather than about
    // the check — which is the same substitution the substrate was making.
    recordContentBinding: requireBinding ? 'bound' : 'unbound',
    // Same rule, one question further in, and still a report of what was ENFORCED rather
    // than of what the inputs happened to carry: rows that arrive with a `fieldProvenance`
    // under a policy that never demanded one were not checked by this fold, and reporting
    // 'bound' off the back of them would be data standing in for a guarantee. Kept a
    // separate field from the line above because the two answer different questions and
    // `requireContentBinding: true` alone must never read as though the fields were bound.
    recordFieldBinding: requireFields ? 'bound' : 'unbound',
  };
}

/**
 * May this principal do this, here?
 *
 * The only question an authorization check should ask, and it reads off the fold rather than
 * recomputing anything — so there is exactly one place where the intersection happens.
 */
export function may(roster: Roster, principal: Principal, capability: Capability): boolean {
  const m = roster.members.find(x => x.principal === principal);
  return m !== undefined && m.effective.includes(capability);
}

/**
 * Why was that allowed or refused? Returned to callers so a refusal is explainable rather
 * than merely final — "you are an Editor but your agent's delegation is read-only" is
 * actionable, "403" is not.
 */
export function explain(roster: Roster, principal: Principal, capability: Capability): string {
  const m = roster.members.find(x => x.principal === principal);
  if (!m) {
    // ★ A REFUSED RECORD MUST NOT EXPLAIN ITSELF AS AN UNANSWERED INVITATION.
    //
    // A convener who wrote both halves gets a pending invitation plus a refused acceptance,
    // and the invitation sentence — "was offered Contributor but has not accepted" — is a
    // true statement that describes the wrong event entirely. It sends whoever reads it to
    // chase the member for an answer they already appear to have given, and the forgery is
    // the thing nobody is told about. Named first, for that reason.
    const refused = roster.unattested.filter(u => u.principal === principal);
    if (refused.length > 0) {
      return `${principal} is not a member of ${roster.workspace}: `
        + refused.map(u => (u.restrictionStillApplied
          // ★ "Refused" is the wrong word for a revocation, and the difference decides what
          // an operator does next. Re-signing a refused GRANT restores a member; re-signing
          // a refused REVOCATION removes them again. The single sentence used to be the
          // former in both cases.
          ? `their ${u.kind} <${u.head}> could not be attributed (${u.because}) — but it `
            + 'WITHDRAWS authority, and a withdrawal applies whether or not it can be '
            + 'attributed, so it took effect'
          : `their ${u.kind} <${u.head}> was refused because ${u.because}`)).join('; ')
        + '.';
    }
    const invited = roster.pendingInvitations.find(p => p.principal === principal);
    return invited
      ? `${principal} was offered ${invited.role} but has not accepted, so is not yet a member.`
      : `${principal} is not a member of ${roster.workspace}.`;
  }
  if (m.effective.includes(capability)) {
    return `${principal} holds ${m.role}, which permits ${capability}, and their delegation carries it.`;
  }
  if (m.withheldByDelegation.includes(capability)) {
    return `${principal} holds ${m.role}, which permits ${capability} — but their own delegated `
      + 'scope does not carry it, so it is withheld. A role is a ceiling, never a grant.';
  }
  // ★ UNDER A FORKED GRANT CHAIN THE ROLE IS NOT THE REASON, AND NAMING IT STATES A FALSE ONE.
  // `member.role` is whichever head the profile happens to declare first, so with heads
  // {Convener, Observer} this said "holds Convener, which does not permit grant" — Convener
  // permits grant — and with the rows reversed it blamed Observer instead. Same fork, two
  // different explanations, neither of them the cause.
  //
  // The damage is the remedy it implies: an operator told the role is too narrow widens the
  // role. Capabilities here are the INTERSECTION across heads, so widening one head is
  // intersected straight back away, and the second attempt is to widen both — which is how a
  // fork gets resolved upwards, silently, on an authorization record. The only repair is one
  // clean head. An acceptance fork is left to fall through: it makes the STREAM ambiguous,
  // not the role, and blaming it would send someone to repair the wrong chain.
  //
  // ★ AND ONLY WHEN THE HEADS ACTUALLY DISAGREE. The first fix over-corrected: it took this
  // branch for ANY grant fork, so two heads both naming Observer produced "roles that may
  // disagree … republish a single clean head" for a refusal Observer would have produced on
  // its own. Republishing changes the answer by not one byte. The old bug named the role
  // instead of the fork; that one named the fork instead of the role — the same false cause,
  // pointing the other way.
  if (m.divergence?.kind === 'grant' && new Set(m.divergence.roles ?? []).size > 1) {
    return `${principal} has ${m.divergence.heads.length} concurrent grant heads `
      + `(${m.divergence.heads.join(', ')}) naming roles that may disagree. Their capabilities `
      + `are the INTERSECTION across those heads and ${capability} is not in it. Republish a `
      + 'single clean head before reading anything off the role: widening one head would be '
      + 'intersected away.';
  }
  return `${principal} holds ${m.role}, which does not permit ${capability}.`;
}
