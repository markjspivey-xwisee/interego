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
 * ★★★★ AND THE CONVENER IS CHECKABLE TOO, FOR CALLERS THAT READ THE WORKSPACE.
 *
 * What used to stand here said nothing establishes that {@link AttestationPolicy.convener} is
 * the workspace's convener — the principal was typed by the caller, and no code fetched the
 * workspace to compare. A roster could be field-bound, content-bound and signer-checked, with
 * both binding fields reporting `'bound'`, and be about ENTIRELY THE WRONG MEMBERSHIPS.
 *
 * A workspace IS a dereferenceable graph URL whose content declares `wsp:convener`, so the
 * convener is readable from the workspace itself. `membership.ts` now writes, publishes,
 * shape-validates, signs, reads back and PARSES that record through the same
 * `digestedGraphRegion` path as the two membership halves, and
 * {@link AttestationPolicy.workspaceEvidence} carries the result in as
 * {@link ConvenerEvidence}. {@link refuseConvenerAuthority} compares it against the policy and
 * {@link Roster.convenerBinding} reports which of its three answers came back.
 *
 * ★ AND THE DIRECTION IS THE WHOLE OF IT, BECAUSE THE OBVIOUS IMPLEMENTATION IS AN ESCALATION.
 * The tempting one line is `const convener = workspaceRecord?.convener ?? policy.convener` —
 * read the convener from the workspace and use it. That GRANTS MORE THAN NOT PASSING THE
 * EVIDENCE AT ALL: a policy naming a stranger, handed a workspace that names the real
 * convener, would start admitting every grant the same policy refuses on its own. Supplying
 * evidence would widen authority, which is the exact shape this file has already had to undo.
 *
 * So a disagreement only ever REFUSES CONFERRAL, and it refuses it on the conferring track
 * alone. The restricting track never sees this check, so a policy that disagrees with the
 * workspace cannot erase a revocation or a withdrawal by disagreeing — it removes the power to
 * make members, not the records that unmake them.
 *
 * ★★★★★★ AND THE EVIDENCE'S OWN PROVENANCE WAS THE HOLE UNDER ALL OF IT — RESIDUAL GAP 9.
 *
 * What stood here said the descriptor URL was chosen by whoever assembled the fold, and filed
 * that as a residue. It was an escalation, and it undid the close above. Measured against
 * production with two real bearers: BEE published a `wsp:Workspace` for ALICE'S workspace IRI,
 * on HER OWN pod, naming herself convener. It published, parsed with no problems, content-
 * bound. Handed to the fold as evidence, the same fold that refuses her self-convened
 * membership on alice's record reported `convenerBinding: 'bound'` and ADMITTED her. The
 * subject is a triple its writer chooses, so "is this record about this workspace" is not a
 * question anybody fails.
 *
 * What closes it is that a workspace IS a dereferenceable URL and only one party can decide
 * what it returns. `<relay>/ns/<owner>/<slug>` resolves against the pod named by its OWNER
 * SEGMENT (`resolveNsGraph`, `deploy/mcp-relay/server.ts:11657`) and against no other, and the
 * substrate refuses everyone else a write there. Same run: an anonymous `GET <WS>` returned
 * alice's record with bee's absent, `get_current_head{urn, pod_name: <owner>}` returned alice's
 * descriptor unforked, and bee writing to alice's pod was refused `403 scope_violation`.
 *
 * So {@link EvidenceProvenance} carries which IRI was dereferenced and which document that
 * resolved to, {@link refuseEvidenceProvenance} refuses evidence that is not the record
 * `<workspace>` answers with, {@link AttestationPolicy.requireEvidenceProvenance} turns it on
 * and {@link Roster.evidenceProvenanceBinding} reports which of its three answers came back.
 * `dereferenceWorkspaceRecord` in `membership.ts` is the producer — it resolves the workspace
 * through its own owner segment's pod, which is what bee cannot reach.
 *
 * ★ AND THE PAIR IS STILL THE CALLER'S CLAIM AT RUNTIME, exactly as `FieldProvenance` is. This
 * module is pure and fetches nothing. What it checks is the two relations that are not
 * self-certifying — the IRI dereferenced is the workspace being folded, and the document that
 * dereference resolved to is the record's own `head` — which catch the realistic failure, a
 * composer holding one workspace record per pod it read and attaching the wrong one.
 *
 * ★★ WHAT USED TO STAND HERE SAID A CALLER HAND-WRITING THE PAIR BESIDE A FORGED RECORD "IS
 * NOT CAUGHT, AND CANNOT BE", and filed it as the producer's residue. The premise was that the
 * only place to intervene is the check, and it is not: a claim nobody can WRITE never reaches
 * one. Both `EvidenceProvenance` and `FieldProvenance` are now BRANDED — each intersects a
 * non-exported ambient class with a private member, so the hand-written literal is a COMPILE
 * ERROR rather than a runtime pass, and only `membership.ts` mints either. Read those two
 * types for the exact guarantee, including the three escape hatches (`as`, `Object.assign`,
 * and anything arriving as `any` from JSON) that a compile-time brand does not and cannot
 * close — which is why every runtime check below stays exactly where it was.
 *
 * ★★★★★ AND THE ROLE PROFILE IS THE SAME QUESTION ONE FIELD OVER.
 *
 * `wspsh:WorkspaceShape` has always required exactly one `wsp:roleProfile` beside the
 * `wsp:convener`, and the same record carries both. The convener decides WHO may grant; the
 * profile decides WHAT a granted role permits — `permitsOf` above is built from it and it
 * feeds every `effective` capability in the roster. `args.profile` was the caller's, and
 * {@link WorkspaceRecord.roleProfile} sat beside it uncompared: measured, a roster reporting
 * `convenerBinding: 'bound'` and `recordFieldBinding: 'bound'` with an empty `unattested`
 * handed an `#Observer` the `grant` and `revoke` capabilities, because the caller folded
 * against a profile document the workspace never declared.
 *
 * {@link refuseRoleProfileAuthority} compares the two and {@link Roster.roleProfileBinding}
 * reports which of its three answers came back. Everything the convener check learned applies
 * unchanged and is not re-derived here: the workspace's profile is EVIDENCE and never a
 * SOURCE (there is no `profile = ws.roleProfile ?? args.profile`, for the same reason there is
 * no such line for the convener), and a disagreement refuses on the CONFERRING TRACK ALONE.
 *
 * ★ AND WHAT IT ESTABLISHES IS AN IRI, NOT A ROLE TABLE — which was residual gap 10, and it is
 * closed one paragraph down rather than here. `RoleProfile.profile` is the caller's own claim
 * about where its `roles` came from, so `roleProfileBinding: 'bound'` means *the caller's role
 * table CLAIMS to be the profile <workspace> declares* and nothing more. A caller that writes
 * `{profile: <the declared IRI>, roles: [anything]}` agrees with every IRI anybody compares.
 *
 * ★★★★★★★ SO THE TABLE IS READ TOO — RESIDUAL GAP 10, AND THE LAST OF THE GAP-6 FAMILY.
 *
 * Four checks now stand between a caller and a membership, and every one of them compares a
 * NAME: the convener the workspace declares, the profile IRI it declares, the descriptor the
 * workspace dereferences to. Not one of them had ever opened the document those names point at,
 * and that document decides more than any of them — `permitsOf` is built from `profile.roles`,
 * so every `effective` capability in the roster comes out of a table the caller typed. Measured
 * before the check existed: `convenerBinding: 'bound'`, `roleProfileBinding: 'bound'`,
 * `recordFieldBinding: 'bound'`, `unattested: []`, and an `#Observer` holding `grant` and
 * `revoke`.
 *
 * `dereferenceRoleProfile` in `membership.ts` is the producer — it asks the IRI — and
 * {@link refuseRoleTableAuthority} compares what came back with what the fold used, role for
 * role and capability for capability, under {@link normaliseRoleTable}, which is literally the
 * function that builds `permitsOf` rather than a second copy of its rule. The three directions
 * gaps 6, 8 and 9 established are copied unchanged and are not re-derived here: the document is
 * EVIDENCE and never a SOURCE (there is no `profile.roles = document.roles`, and the
 * substitution is worse here than for the convener because a caller with a NARROWER table would
 * be handed the published one and start conferring more), a disagreement refuses on the
 * CONFERRING TRACK ALONE, and `'unchecked'` is a third value distinct from `'refused'`.
 *
 * ★ AND THE GRADE IS SMALLER THAN THE OTHER THREE — say this before anyone reads
 * {@link Roster.roleTableBinding} as a proof. A workspace IRI names a POD, and the substrate
 * refuses everyone but its holder a write there, which is what made gap 9 closable by sourcing.
 * A role profile IRI names a HOST. The profile every workspace here declares is a static file
 * on GitHub Pages: it cannot carry an `iep:authorshipProof`, it has no digested region, and no
 * signer exists to compare anything against — so for that document `'bound'` means *this origin
 * served these bytes at this URL at the moment of the read*, defended by TLS and by whoever
 * holds the host, and by nothing that can be re-checked afterwards by a third party.
 * {@link RoleTableAuthority} carries which of the two grades was reached and
 * {@link Roster.attributionNote} states it in words, because the enum cannot. A profile
 * published to `<relay>/ns/<owner>/<slug>` IS a signed pod record and gets the stronger reading;
 * the deployed one is not, and no policy flag demands it, because a rule that refused the only
 * role table in existence is the `exact-url` mistake with a different name.
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
  /**
   * What the WORKSPACE says about who convenes it, so {@link convener} can be checked against
   * something other than the caller's own opinion of it.
   *
   * Optional, and absent means exactly one thing: this fold was not asked. It reports
   * {@link Roster.convenerBinding} as `'unchecked'` and behaves as it always did — a policy
   * whose convener is a value somebody typed. Every caller that predates this field is in that
   * state and must keep being told so.
   *
   * ★ THIS IS EVIDENCE, NOT A SOURCE. The convener grants are attested against is
   * {@link convener}, and only ever {@link convener}. This field can REFUSE that principal; it
   * can never supply one. See this module's header for why the substitution would be an
   * escalation rather than a fix.
   */
  readonly workspaceEvidence?: ConvenerEvidence;
  /**
   * Also require that {@link workspaceEvidence} is the record `<workspace>` DEREFERENCES TO,
   * and not merely a record about it — {@link EvidenceProvenance} present, naming this
   * workspace and this record.
   *
   * ★ THIS IS RESIDUAL GAP 9'S GATE, and without it every check above is only as strong as the
   * caller's choice of which workspace record to believe. Anyone can mint one: measured live,
   * bee published a `wsp:Workspace` for alice's workspace IRI on her own pod and the fold
   * reported `convenerBinding: 'bound'` and admitted her.
   *
   * Off by default, and it has to be: every caller written before this field hands the fold a
   * descriptor URL it chose, so turning it on by default would refuse them all at once.
   * Turning it on only ever refuses MORE — see the monotonicity rule in this module's header —
   * and the fold reports in {@link Roster.evidenceProvenanceBinding} whether it was on.
   *
   * ★ AND IT DOES NOT IMPLY {@link requireContentBinding} OR {@link requireFieldBinding}, WHERE
   * THOSE TWO IMPLY EACH OTHER. Those two compose — fields parsed from bytes nobody re-digested
   * are worthless — and this one is orthogonal: it says where the document came from, not what
   * is inside it. A caller may reasonably demand the dereferenced record while still admitting
   * historical proofs, and ORing them here would refuse a workspace whose record predates
   * content binding for a reason that has nothing to do with its provenance.
   */
  readonly requireEvidenceProvenance?: boolean;
  /**
   * The ROLE TABLE read out of the document {@link RoleProfile.profile} names, so the fold's
   * `roles` can be checked against something other than the caller's own opinion of them.
   *
   * ★ THE ONLY EVIDENCE FIELD HERE THAT IS NOT ABOUT THE WORKSPACE RECORD. `workspaceEvidence`
   * answers who may grant and which profile governs; both come off one `wsp:Workspace`. This is
   * the document that profile IRI NAMES, and it is what decides every capability in the roster
   * — `permitsOf` is built from `profile.roles` and nothing had ever fetched the document those
   * roles claim to have come from. That was residual gap 10.
   *
   * Optional, and absent means exactly one thing: this fold was not asked. It reports
   * {@link Roster.roleTableBinding} as `'unchecked'` and behaves as it always did — a role table
   * the caller typed, agreeing with the workspace on an IRI and on nothing else. Every caller
   * that predates this field is in that state and must keep being told so.
   *
   * ★ THIS IS EVIDENCE, NOT A SOURCE — the third time this file has had to say it, and the
   * reason it is said again rather than cross-referenced is that the substitution is MORE
   * tempting here than it was for the convener. The fold holds the whole document, so
   * `profile.roles = evidence.document.roles` is one line and it looks like a fix. It is the
   * escalation: a caller folding against a table narrower than the published one would start
   * conferring everything the published one permits, so supplying evidence would WIDEN
   * authority. This field can refuse the caller's table; it can never replace it.
   */
  readonly roleTableEvidence?: RoleTableEvidence;
}

/**
 * A workspace's own statement of who convenes it, parsed out of the workspace record.
 *
 * ★ THE THIRD RECORD, AND IT IS THE SAME KIND OF THING AS THE OTHER TWO. `Grant` says who was
 * offered what, `Acceptance` says who agreed, and this says who was entitled to offer at all.
 * All three were once answered by whoever called this fold; the first two stopped being in the
 * round `membership.ts` landed, and this is the last of them.
 *
 * Produced by `readWorkspaceRecord`, which parses every field below out of the region of the
 * served document the substrate's digest covers. Hand-buildable, exactly like the other two,
 * and refused for it under {@link AttestationPolicy.requireFieldBinding} for the same reason.
 */
export interface WorkspaceRecord {
  /** The descriptor URL these fields were read from. Must equal {@link FieldProvenance.descriptor}. */
  readonly head: string;
  /**
   * The workspace this record IS — the `wsp:Workspace` subject's own IRI, not a value pointing
   * at one.
   *
   * ★ THE SUBJECT, DELIBERATELY. A record carrying `wsp:workspace <somewhere>` would be a
   * record ABOUT a workspace, and any pod may write one of those about any workspace. Being
   * the subject is what makes this a record OF the workspace, and
   * {@link refuseConvenerAuthority} compares it against the workspace being folded.
   */
  readonly workspace: string;
  /** `wsp:convener`. The one field this fold reads. */
  readonly convener: Principal;
  /**
   * `wsp:roleProfile`, the governance document the workspace declares.
   *
   * ★ NOW CONSULTED, BY {@link refuseRoleProfileAuthority}, and the direction is the convener's
   * direction: it can refuse the caller's {@link RoleProfile} and it can never supply one. What
   * it is compared against is `RoleProfile.profile` — an IRI, not a role table — so see that
   * function and this module's header for the half that stays open.
   *
   * Empty string where the record stated none readably — reported in `problems`, and never a
   * profile IRI anything will match. The empty case is refused EXPLICITLY rather than left to
   * the comparison, because a caller whose own `RoleProfile.profile` is also empty would
   * otherwise compare equal to it and be reported as bound off two blanks.
   */
  readonly roleProfile: string;
  /** What the substrate's verifier said about who signed the workspace's own declaration. */
  readonly attestation?: Attestation;
  /** Set by `readWorkspaceRecord`. See {@link Grant.fieldProvenance}. */
  readonly fieldProvenance?: FieldProvenance;
}

/**
 * What a caller found when it went and asked the workspace who convenes it.
 *
 * ★ TWO MEMBERS, AND THE SECOND IS THE ONE THAT MATTERS. A bare optional `WorkspaceRecord`
 * would collapse "I did not ask" and "I asked and the substrate could not answer" into the
 * same absent field — and the second silently reopens the gap the first honestly reports as
 * open. A transient `get_descriptor` failure would turn a checked roster back into an
 * unchecked one with nothing saying so, which is the same shape that once turned a read
 * failure into the reinstatement of a revoked member.
 *
 * So a caller that asked says so even when the answer was nothing, and the fold refuses to
 * confer. Asking and getting silence is not the same as not asking.
 */
export type ConvenerEvidence =
  | {
      readonly kind: 'declared';
      readonly record: WorkspaceRecord;
      /**
       * How the caller came by this record. Absent means it was HANDED a descriptor URL —
       * which is residual gap 9 — and {@link AttestationPolicy.requireEvidenceProvenance}
       * refuses it. See {@link EvidenceProvenance}.
       */
      readonly provenance?: EvidenceProvenance;
    }
  | {
      readonly kind: 'unreadable';
      /** Why the workspace record could not be read. Rendered into every refusal it causes. */
      readonly why: string;
    };

/**
 * How a caller came by the workspace record it is offering as evidence.
 *
 * ★★ RESIDUAL GAP 9, AND IT UNDID GAP 6'S CLOSE. {@link refuseConvenerAuthority} asks a
 * {@link ConvenerEvidence} three questions — is its subject THIS workspace, does it name THIS
 * policy's convener, does it hold up as a signed content-bound record — and never asked where
 * the evidence came from. Measured against production on 2026-08-02, with two real bearers:
 * BEE published a `wsp:Workspace` for ALICE'S workspace IRI, on HER OWN pod, naming herself
 * convener. It published, it parsed with `problems: []`, it content-bound. Handed to the fold
 * as evidence, the same fold that refuses her self-convened membership on alice's record
 * reported `convenerBinding: 'bound'` and ADMITTED her — `members: 1`. The subject is a triple
 * the writer chooses and the signature is over her own claim, so all three questions answer
 * yes for a record nobody with authority over the workspace wrote.
 *
 * ★ WHAT "AUTHORITY OVER A WORKSPACE IRI" ACTUALLY MEANS HERE, measured rather than argued.
 * A workspace IS a dereferenceable URL. `<https://relay…/ns/<owner>/<slug>>` resolves through
 * the relay's `/ns/:owner/:slug` route, and `owner` is a POD SEGMENT — `resolveNsGraph` builds
 * `podUrl = CSS_URL + owner + '/'` (`deploy/mcp-relay/server.ts:11657`) and reads that pod and
 * no other. So the IRI names the one pod whose holder can decide what it dereferences to.
 * Measured on the same run: an anonymous `GET <WS>` returned 200 with ALICE named and bee
 * absent while both records existed; `get_current_head{urn: <WS>, pod_name: <owner>}` returned
 * alice's descriptor with `forked: false`; and bee writing to alice's pod was refused
 * `403 scope_violation`. Bee can publish a rival record all day and it is never what `<WS>`
 * returns.
 *
 * So the closure is: THE EVIDENCE MUST BE THE RECORD `<WS>` ACTUALLY DEREFERENCES TO. This
 * pair is the caller's statement that it is — which IRI was dereferenced, and which descriptor
 * that dereference resolved to. `dereferenceWorkspaceRecord` in `membership.ts` is what makes
 * the statement honestly, by doing the dereference through the owner segment's own pod.
 *
 * ★ AND IT IS STILL A CLAIM THIS PURE MODULE CANNOT CHECK, exactly like {@link Attestation}
 * and {@link FieldProvenance}, and saying otherwise would be the third over-read this file has
 * had to correct. The fold cannot fetch. What it CAN check — and does, in
 * {@link refuseEvidenceProvenance} — are the two relations that are not self-certifying: the
 * IRI dereferenced must be the workspace being folded, and the descriptor that dereference
 * resolved to must be the record's own `head`. Those catch the realistic failure, which is not
 * a liar but a federated composer holding one workspace record per pod it read and attaching
 * the wrong one to this roster.
 *
 * ★★ AND THE HAND-WRITTEN PAIR IS NOW UNWRITABLE, WHICH IS WHAT THE PARAGRAPH ABOVE THIS ONE
 * USED TO CONCEDE.
 *
 * What stood here said a caller hand-writing both fields beside a forged record "is not caught
 * here and cannot be", and filed it as the residue of residual gap 9. The first half stays true
 * — this function still cannot fetch — and the second half was false, because the check was
 * never the only place to intervene. A claim nobody can WRITE never reaches a check.
 *
 * So this type is BRANDED: it intersects {@link ObtainedByDereferencingTheWorkspace}, an
 * ambient class with a PRIVATE member, and the class is not exported. TypeScript's rule for a
 * private member is nominal — only declarations originating in that one class body are ever
 * compatible — so no module outside this one can produce a value of this type structurally.
 * `{dereferenced: <WS>, resolvedTo: <forged descriptor>}` is a compile error at the point of
 * writing, and so is the same literal nested inside a {@link ConvenerEvidence}. Both forms are
 * pinned as `@ts-expect-error` cases in `tests/workspace-adversarial.test.ts`, so the day the
 * brand stops refusing them the TYPECHECK GATE fails on an unused directive rather than the
 * suite going quietly green over a reopened gap.
 *
 * ★ PRIVATE-MEMBER NOMINALITY RATHER THAN A `unique symbol` KEY, AND THE DIFFERENCE WAS
 * MEASURED. Both refuse the bare literal. A symbol brand does NOT refuse
 * `{...honest, resolvedTo: <forged>}` — an object spread carries the phantom key along, so a
 * caller holding ONE honestly dereferenced provenance could rewrite either field and keep the
 * brand, which is the whole forgery with an extra keystroke. The private member refuses that
 * spread, because the result is an object literal and object literals have no declaration
 * inside the class body.
 *
 * ★ WHAT IT DOES NOT DO, SAID HERE SO IT IS NOT DISCOVERED LATER. A brand is a compile-time
 * property and nothing more:
 *
 *   — `as EvidenceProvenance` still converts, because a type assertion succeeds whenever
 *     EITHER type is assignable to the other and the branded type is assignable to the bare
 *     pair. There is no spelling of a brand in TypeScript that refuses an assertion. What the
 *     brand buys is that the forgery can no longer be written by ACCIDENT or in passing: it
 *     costs a cast, a cast is greppable, and `tests/workspace-adversarial.test.ts` pins the
 *     set of files allowed to contain one.
 *   — `Object.assign({}, honest, {resolvedTo: x})` also converts, because the standard
 *     library types its return as an intersection that inherits the brand. Same class of
 *     escape hatch, same answer.
 *   — a value that arrived as JSON is unaffected, because `JSON.parse` returns `any` and `any`
 *     satisfies everything. That path is exactly why {@link refuseEvidenceProvenance} keeps
 *     every runtime string check it had; the brand is a second line, never a replacement for
 *     the first. A RUNTIME registry (mint into a `WeakSet`, check membership here) would close
 *     the JSON path too and was deliberately not built: it makes this module's verdict depend
 *     on hidden process-global state, which is the one property the header promises it does
 *     not have, and it would refuse honestly-obtained evidence the moment a composer sent it
 *     across a process.
 *
 * So the honest statement of the guarantee is: the pair cannot be PAIRED WITH A RECORD IT DID
 * NOT COME FROM in any TypeScript that does not contain a deliberate assertion, and the one
 * assertion that mints it lives in `dereferenceWorkspaceRecord`'s file and nowhere else.
 */
export type EvidenceProvenance = ObtainedByDereferencingTheWorkspace & {
  /**
   * The IRI that was DEREFERENCED to obtain this record. MUST be the workspace being folded:
   * a caller that dereferenced somewhere else established nothing about this workspace.
   */
  readonly dereferenced: string;
  /**
   * The descriptor URL that dereference resolved to. MUST equal the record's own `head`; see
   * {@link refuseEvidenceProvenance}.
   */
  readonly resolvedTo: string;
};

/**
 * The nominal half of {@link EvidenceProvenance}. Not exported, and that is the whole mechanism.
 *
 * `declare` so it is AMBIENT: no constructor exists at runtime, nothing is emitted, and this
 * module stays the pure one its header describes. The private member is never read and never
 * written — its only job is to be a declaration that lives in this class body, which is the
 * one thing TypeScript will not let another file reproduce.
 *
 * ★ THE MEMBER'S NAME IS THE ERROR MESSAGE. tsc reports the refusal as `Property
 * 'mintedOnlyByDereferenceWorkspaceRecord' is missing`, so whoever hits it is told what to call
 * instead of being told a brand exists. Renaming it degrades the diagnostic and nothing else.
 */
declare class ObtainedByDereferencingTheWorkspace {
  private readonly mintedOnlyByDereferenceWorkspaceRecord: void;
}

/**
 * How the bytes a role table was parsed from were obtained, and therefore what they are worth.
 *
 * ★★ THIS ENUM EXISTS BECAUSE THE PROFILE EVERY WORKSPACE HERE DECLARES CANNOT CARRY A PROOF,
 * and writing the check as though it could would be the overclaim this file has undone three
 * times already. `<…/applications/shared-workspace/wsp-roles-default>` is a static file on
 * GitHub Pages. No `publish_context` wrote it, so there is no `iep:authorshipProof`, no
 * `iep:describes`, no digested region and no signer — the substrate has never seen it. A policy
 * that demanded a signature on a role table would refuse the only role table in existence,
 * which is the failure direction {@link Attestation.descriptorBindingBasis} records the
 * decision NOT to take.
 *
 *   signed-record   the profile lives at a `<relay>/ns/<owner>/<slug>` IRI, so it is a pod
 *                   record: read through `get_descriptor`, roles parsed out of the region the
 *                   substrate digested, an authorship proof beside them. Held to whatever
 *                   strength the rest of the policy demands, and checkable afterwards by anyone.
 *   transport-only  the profile is an ordinary HTTPS document. The whole of the evidence is
 *                   that THIS ORIGIN SERVED THESE BYTES AT THIS URL, over TLS, at the moment of
 *                   the read. Nobody signed them. Nothing about them is checkable afterwards,
 *                   offline, or by anyone who was not present at the fetch, and a host that
 *                   changes the file changes the governance with no signature to notice it by.
 *
 * ★ AND NO POLICY FLAG REFUSES `'transport-only'` — DECIDED, NOT OVERLOOKED. The tempting rule
 * is "`requireFieldBinding` implies a signed role table". It fails closed on the deployed
 * artifact and on every profile anybody publishes to a plain web server, which is most of the
 * point of roles being DATA. What is done instead is that the value travels: it is rendered
 * into {@link Roster.attributionNote}, so `roleTableBinding: 'bound'` can never be read as "the
 * table was signed" by a caller who has been handed the note beside it.
 */
export type RoleTableAuthority = 'signed-record' | 'transport-only';

/**
 * The role table itself, as READ from the document the profile IRI names.
 *
 * ★ THE FOURTH RECORD, AND THE FIRST THAT IS NOT ABOUT MEMBERSHIP. `Grant` says who was offered
 * what, `Acceptance` says who agreed, `WorkspaceRecord` says who was entitled to offer and
 * which document governs — and this is that document. It decides what every role in the roster
 * PERMITS, which is more than any of the other three decide, and it was the last of the four
 * still supplied entirely by the caller.
 *
 * Produced by `readRoleProfileRecord` and `dereferenceRoleProfile` in `membership.ts`.
 */
export interface RoleProfileDocument {
  /**
   * The URL the bytes were actually read from: a descriptor URL for a pod record, the FINAL URL
   * of the fetch (after any same-origin redirect) for a web document. Diagnostic — it is what
   * an operator opens to see what this fold compared against.
   */
  readonly head: string;
  /**
   * The IRI that was DEREFERENCED to obtain them, and the field the fold actually checks.
   *
   * ★ GAP 9'S LESSON, APPLIED WITHOUT RE-DERIVING IT. A role profile document declares its own
   * subject, and that subject is a triple its writer chose — exactly as a `wsp:Workspace`'s is,
   * and exactly as unusable for the same reason. What makes a governance document THIS
   * workspace's governance is that the IRI the workspace declares dereferences to it, so this
   * is the value {@link refuseRoleTableAuthority} compares and the subject is not compared at
   * all. A document served at the declared IRI that calls itself something else is still what
   * that IRI returns; a document that calls itself the declared profile and was fetched from
   * somewhere else is not.
   */
  readonly dereferenced: string;
  /**
   * Every `wsp:Role` the document declares, with its `wsp:permits`, in document order.
   *
   * Not normalised here: {@link normaliseRoleTable} is what normalises, and it is the same
   * function `foldRoster` builds `permitsOf` with. A reader that pre-normalised would be a
   * second implementation of the duplicate-role rule, and the two drifting is how a table could
   * compare equal to one the fold reads differently.
   */
  readonly roles: readonly RoleDefinition[];
  /** See {@link RoleTableAuthority}. Never inferred from the absence of an attestation. */
  readonly authority: RoleTableAuthority;
  /**
   * What the substrate's verifier said about the profile document, where there is one to say
   * anything about. Present only on `'signed-record'`; a `'transport-only'` document carrying
   * one is a contradiction and {@link refuseRoleTableAuthority} refuses it as such.
   */
  readonly attestation?: Attestation;
}

/**
 * What a caller found when it went and read the document its role table claims to come from.
 *
 * Two members for the reason {@link ConvenerEvidence} has two, and it is the same failure: a
 * bare optional document would collapse "I did not ask" and "I asked and could not read it"
 * into one absent field, and the second silently reopens the gap the first honestly reports as
 * open. A profile IRI that 404s must not read as a fold that never asked — and that was the
 * state of the DEPLOYED one when this type was written, so the distinction was load-bearing on
 * the ordinary case rather than on an edge. `docs/` now serves a page at the extensionless IRI
 * and `dereferenceRoleProfile` follows its `rel=alternate`, so the live artifact lands on
 * `'declared'`; the sentence stays because the two states must remain distinguishable, not
 * because one of them is currently occupied.
 */
export type RoleTableEvidence =
  | { readonly kind: 'declared'; readonly document: RoleProfileDocument }
  | {
      readonly kind: 'unreadable';
      /** Why the profile document could not be read. Rendered into every refusal it causes. */
      readonly why: string;
    };

/** What {@link foldRoster} was able to establish about the policy's convener. */
export type ConvenerBinding = 'bound' | 'refused' | 'unchecked';

/**
 * What {@link foldRoster} was able to establish about where its workspace evidence came from.
 *
 * Its own name rather than a reuse of {@link ConvenerBinding}, for the reason
 * {@link RoleProfileBinding} has one: they answer different questions and a reader following
 * the type should arrive at the right one. It buys nothing at the compiler — the unions are
 * identical and TypeScript is structural — so the pairing is asserted in the tests instead.
 */
export type EvidenceProvenanceBinding = 'bound' | 'refused' | 'unchecked';

/**
 * What {@link foldRoster} was able to establish about the role profile it folded against.
 *
 * Its own NAME rather than a reuse of {@link ConvenerBinding}, because the two answer
 * different questions and a reader following the type should arrive at the right one. It buys
 * nothing at the compiler: TypeScript is structural, the unions are identical, and a
 * transposition of the two fields still compiles. Said out loud so the separate name is not
 * read as a guarantee it does not carry — the pairing is asserted in the tests instead.
 */
export type RoleProfileBinding = 'bound' | 'refused' | 'unchecked';

/**
 * What {@link foldRoster} was able to establish about the role TABLE it computed capabilities
 * from — as distinct from the IRI that table claims, which is {@link RoleProfileBinding}.
 *
 * A fifth identical union and a fifth separate name, for the reason the fourth has one and with
 * the same admission attached: TypeScript is structural, so this buys nothing at the compiler
 * and a transposition of the two fields still compiles. The pair `('bound','refused')` — the
 * declared IRI, the wrong table behind it — is what the tests assert to hold them apart.
 */
export type RoleTableBinding = 'bound' | 'refused' | 'unchecked';

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
 * ★ AND IT IS STILL A CLAIM THIS PURE MODULE CANNOT CHECK AT RUNTIME, exactly like
 * `Attestation`. What the fold CAN do — and does, in {@link refuseFieldBinding} — is the one
 * check that is not self-certifying: `descriptor` must be the record's own `head`. That catches
 * the realistic failure, which is not a liar but a composer reading many pods and attaching one
 * record's parsed fields to another record's head.
 *
 * ★★ AND HAND-BUILDING `{source: 'payload', descriptor: head}` BESIDE INVENTED FIELDS IS NOW A
 * COMPILE ERROR, which is what this paragraph used to concede was undetectable.
 *
 * The same closure {@link EvidenceProvenance} carries, applied to the same shape of claim one
 * layer down, and applied in the same round DELIBERATELY: these two are the family, they were
 * conceded in identical words, and closing one and filing the other would leave the weaker of
 * the two holding the whole gate. `requireFieldBinding` is the flag `requireEvidenceProvenance`
 * does NOT imply and is not implied by, so a policy can rest on either alone.
 *
 * The type intersects {@link ParsedFromTheRecordsOwnPayload}, a non-exported ambient class with
 * a private member, so a literal written anywhere but `membership.ts` does not typecheck — and
 * neither does `{...honest, descriptor: <another record>}`, which is the version a symbol brand
 * would have let through. Read {@link EvidenceProvenance} for the measured comparison and for
 * the three escape hatches a compile-time brand does not close; every word of it applies here
 * unchanged, which is why it is not restated.
 *
 * ★ AND `refuseFieldBinding` KEEPS ITS `source !== 'payload'` GUARD, which the brand now makes
 * look like dead code. It is not. That branch exists for a value that arrived as JSON, and JSON
 * arrives as `any` — the one thing no brand narrows. Deleting it because the type "cannot" hold
 * another source is how the guard would come off.
 */
export type FieldProvenance = ParsedFromTheRecordsOwnPayload & {
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
};

/**
 * The nominal half of {@link FieldProvenance}. Not exported; see
 * {@link ObtainedByDereferencingTheWorkspace} for why the mechanism is a private member on an
 * ambient class rather than a `unique symbol` key, and for what it does not buy.
 *
 * ★ A SECOND CLASS RATHER THAN A SHARED ONE, and the honest reason is the DIAGNOSTIC, not
 * assignability. The two types' public fields (`source`/`descriptor` versus
 * `dereferenced`/`resolvedTo`) already share no name, so one brand over both would not make
 * them interchangeable today and the separation buys nothing at the compiler — the same
 * admission {@link EvidenceProvenanceBinding} makes about its own separate name. What it buys
 * is the error text: a reader who writes the wrong literal is told
 * `mintedOnlyByTheReadersInMembership` rather than a name covering two unrelated claims, and
 * the two are carried side by side on one {@link ConvenerEvidence} (`evidence.provenance` and
 * `evidence.record.fieldProvenance`) where a message naming the wrong one would send them to
 * the wrong producer.
 */
declare class ParsedFromTheRecordsOwnPayload {
  private readonly mintedOnlyByTheReadersInMembership: void;
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

/**
 * Why the convener this policy names cannot be treated as entitled to grant here, or null when
 * it can.
 *
 * Composed from the two refusals above rather than reimplementing either: a workspace record
 * is a record, and holding it to a weaker standard than the grants it authorises would put the
 * softest check at the top of the chain.
 *
 * ★ AN ARGUMENT OBJECT, NOT SIX POSITIONALS, and that is defect avoidance rather than style.
 * The last two parameters are booleans meaning different things (`requireContentBinding`,
 * `requireFieldBinding`); transposed at a call site they compile, they run, and they silently
 * check the weaker of the two conditions. The refusals above carry at most one boolean each
 * and can afford the positional form.
 *
 * Every branch refuses, including the one where the caller asked and got nothing back. The
 * only path to null is a workspace record that IS this workspace, names THIS convener, and
 * holds up as a record at whatever strength the rest of the policy demands.
 *
 * ★ AND THE DISPATCH IS POSITIVE ON EVERY TAG, WHICH IT WAS NOT. It read `kind === 'unreadable'`
 * → refuse, EVERYTHING ELSE → treat as `'declared'`, and {@link ConvenerEvidence} is exported
 * through `can.ts` for federated composers that hand it across a JSON boundary where the type
 * guarantees nothing. Two shapes came out of that, both reproduced before this was written:
 *
 *   `{ kind: 'i-did-not-ask', record: <an agreeing record> }` reported
 *   `convenerBinding: 'bound'`. The union has exactly two members so that "asked and got
 *   silence" could not masquerade as an answer; a third tag masqueraded instead, and
 *   {@link Roster.convenerBinding}'s own contract is that `'bound'` is never reachable off
 *   the back of nothing.
 *
 *   `{ kind: 'declared' }` with no record threw `TypeError: Cannot read properties of
 *   undefined (reading 'workspace')` out of the authorization path. Not a refusal — no
 *   roster, no members, no diagnosis, the whole fold dead.
 *
 * {@link refuseFieldBinding} above already tests its own tag with `!== 'payload'` for exactly
 * this reason. This was the one refusal in the file without that guard.
 */
export function refuseConvenerAuthority(args: {
  readonly evidence: ConvenerEvidence;
  /** The workspace being folded. The record's own subject must be this. */
  readonly workspace: string;
  /** The principal the policy treats as entitled to grant. Never replaced by the record's. */
  readonly convener: Principal;
  readonly signerOf?: SignerResolver;
  readonly requireContentBinding?: boolean;
  readonly requireFieldBinding?: boolean;
}): string | null {
  const { evidence, workspace, convener } = args;
  // Read the tag out before the narrowing below erases it. After the `'unreadable'` branch the
  // compiler believes `kind` can only be `'declared'`, and the check that follows exists
  // precisely because the compiler is wrong about a value that arrived as JSON.
  const tag: string = evidence.kind;
  if (evidence.kind === 'unreadable') {
    return 'the workspace record that would say who convenes here could not be read '
      + `(${evidence.why}). This policy ASKED, and an unanswered question about who may grant `
      + 'is not the same as never having asked — so nothing CONFERS. Every revocation and '
      + 'withdrawal still applies, because refusing to confer is not deleting a record';
  }
  if (tag !== 'declared') {
    return `the workspace evidence is tagged '${tag}', which is neither 'declared' nor `
      + "'unreadable'. This dispatch used to send everything that was not 'unreadable' into "
      + 'the declared branch, so an unrecognised tag carrying an agreeing record reported the '
      + 'convener as BOUND — a value that must never be reachable off the back of nothing. An '
      + 'unknown tag establishes nothing about who convenes here';
  }
  // Typed `| undefined` deliberately. The union says this is always present and JSON says
  // otherwise; reading it unguarded was a `TypeError` in the authorization path rather than a
  // refusal, which is the one outcome worse than refusing.
  const ws: WorkspaceRecord | undefined = evidence.record;
  if (ws === undefined) {
    return "the workspace evidence is tagged 'declared' and carries no record. A declaration "
      + 'with nothing in it declares nothing — and reading it anyway used to kill the fold '
      + 'outright (`Cannot read properties of undefined`), returning no roster and no '
      + 'diagnosis instead of naming the fault';
  }
  if (ws.workspace !== workspace) {
    // First, because a record about somewhere else cannot agree with this policy, cannot
    // disagree with it, and cannot be repaired by re-signing it. Reporting a signature problem
    // on it would send an operator to fix the wrong document.
    return `the workspace record at <${ws.head}> declares the convener of <${ws.workspace}> `
      + `and this roster is <${workspace}> — a record of another workspace says nothing about `
      + 'who may grant in this one, however well signed it is';
  }
  if (ws.convener !== convener) {
    // ★ THE HEADLINE REFUSAL, AND IT REFUSES RATHER THAN CORRECTING. Adopting `ws.convener`
    // here would admit every grant signed for the workspace's real convener under a policy
    // that named somebody else — so passing evidence would GRANT MORE than withholding it.
    return `this policy treats ${convener} as entitled to grant and <${workspace}> names `
      + `${ws.convener}. The two disagree, so no grant here CONFERS. The policy's convener is `
      + 'not replaced by the workspace\'s: a fold that adopted it would start admitting grants '
      + 'this same policy refuses on its own, so a disagreement is refused rather than resolved';
  }
  // The branch above establishes that `ws.convener` and `convener` are the same principal. The
  // record's own value is the one passed, because the party this record must have come from is
  // the party it names.
  const badSignature = refuseAttestation(
    ws.attestation, ws.convener, args.signerOf, args.requireContentBinding === true,
  );
  if (badSignature !== null) {
    return `the workspace record at <${ws.head}> names ${ws.convener} as convener and that `
      + `record itself does not hold up: ${badSignature}. A declaration of who may grant is `
      + 'worth exactly what its own authorship is worth, and anybody can write one about '
      + 'anybody';
  }
  const badFields = refuseFieldBinding(
    ws.fieldProvenance, ws.head, args.requireFieldBinding === true,
  );
  if (badFields !== null) {
    return `the workspace record at <${ws.head}> names ${ws.convener} as convener and that `
      + `value was not read from the record: ${badFields}`;
  }
  return null;
}

/**
 * Why the workspace evidence cannot be treated as what dereferencing the workspace returns,
 * or null when it can.
 *
 * The fourth question about the same record, and a THIRD function rather than more branches
 * inside either of the two above, for the reason that split already exists: who may grant,
 * what a granted role permits, and where this record came from are different faults with
 * different repairs, and one verdict over all three cannot say which failed. This one's repair
 * is not to republish anything — it is to obtain the record by dereferencing the workspace
 * instead of being handed a URL.
 *
 * ★ AND IT REFUSES ON THE CONFERRING TRACK ONLY — enforced by the caller, not here, exactly as
 * {@link refuseRoleProfileAuthority} is. This returns a string; {@link foldRoster} puts it at
 * the end of the grant filter's `??` chain and nowhere else, so a provenance the fold will not
 * accept removes the power to make members and leaves every revocation, withdrawal and
 * divergence where a fold with no evidence at all leaves them.
 *
 * ★ OFF UNLESS ASKED FOR, and the first line is the whole of that. Every caller written before
 * this field hands the fold a descriptor URL it chose, so defaulting the check ON would refuse
 * every existing evidence-bearing fold at once — the same reason
 * {@link AttestationPolicy.requireContentBinding} and `requireFieldBinding` default off.
 * Turning it on only ever refuses MORE, and {@link Roster.evidenceProvenanceBinding} reports
 * whether it was on.
 *
 * ★ AND ASKING WITH NO EVIDENCE AT ALL IS A REFUSAL, NOT A PASS. A policy that demands the
 * record `<workspace>` dereferences to and passes none has not been given it. Returning null
 * there would make the strictest flag in the policy silently inert whenever the field beside
 * it was forgotten — which is precisely how a transient read failure once turned a checked
 * roster back into an unchecked one.
 *
 * Every branch refuses, including the two where the caller asked and got nothing back.
 */
export function refuseEvidenceProvenance(args: {
  readonly evidence: ConvenerEvidence | undefined;
  /** The workspace being folded. The IRI the caller dereferenced must be this. */
  readonly workspace: string;
  readonly requireEvidenceProvenance?: boolean;
}): string | null {
  const { evidence, workspace } = args;
  if (args.requireEvidenceProvenance !== true) return null;
  if (evidence === undefined) {
    return `this policy requires the workspace record that <${workspace}> dereferences to and `
      + 'was passed no `workspaceEvidence` at all, so there is nothing whose provenance could '
      + 'be checked. A demand nobody supplied evidence for is not a demand that was met';
  }
  // Read the tag out before the narrowing erases it, for the reason both siblings do: this
  // arrives as JSON through `can.ts` in a federated composer and the compiler is guaranteeing
  // nothing about a value it did not see written.
  const tag: string = evidence.kind;
  if (evidence.kind === 'unreadable') {
    return 'the workspace record that would say who convenes here could not be read '
      + `(${evidence.why}), so nothing was obtained by dereferencing <${workspace}> and there `
      + 'is no provenance to check. This policy ASKED, and an unanswered question is not an '
      + 'answer — so nothing CONFERS, and every revocation and withdrawal still applies';
  }
  if (tag !== 'declared') {
    return `the workspace evidence is tagged '${tag}', which is neither 'declared' nor `
      + "'unreadable'. An unknown tag establishes nothing about where this record was obtained";
  }
  const ws: WorkspaceRecord | undefined = evidence.record;
  if (ws === undefined) {
    return "the workspace evidence is tagged 'declared' and carries no record, so there is no "
      + 'record whose provenance could be checked';
  }
  const provenance: EvidenceProvenance | undefined = evidence.provenance;
  if (provenance === undefined) {
    // ★ RESIDUAL GAP 9, REFUSED. This is the shape that was measured live: bee's own
    // `wsp:Workspace` for alice's workspace IRI, on bee's pod, handed straight to the fold. It
    // answers every other question yes, because the subject is a triple its writer chose. The
    // only thing that distinguishes it from alice's is that <workspace> does not dereference
    // to it — so a record with no statement of having been dereferenced at all is refused
    // rather than read.
    return `it carries no statement of where it came from, so nothing relates it to `
      + `<${workspace}> beyond a subject triple its own writer chose. Anyone may publish a `
      + 'wsp:Workspace for anybody\'s workspace IRI on their own pod — measured live: it '
      + 'publishes, it parses, it content-binds, and the fold admitted its author as convener. '
      + 'Obtain the record with dereferenceWorkspaceRecord in membership.ts, which resolves '
      + '<workspace> through the pod its own owner segment names';
  }
  if (provenance.dereferenced !== workspace) {
    // A composer reading many pods holds one workspace record per workspace it has met.
    // Attaching the one it fetched for <a> to the roster for <b> produces evidence that is
    // genuine, well signed, and about somewhere else — visible here without trusting anybody.
    return `it was obtained by dereferencing <${provenance.dereferenced}> and this roster is `
      + `<${workspace}> — resolving one workspace establishes nothing about another, however `
      + 'well the record that came back is signed';
  }
  if (provenance.resolvedTo !== ws.head) {
    // ★ THE ONE CHECK HERE THAT IS NOT SELF-CERTIFYING, the same shape `refuseFieldBinding`
    // makes one layer down: the dereference resolved to one document and the record handed in
    // is another. Two genuine reads, one of them not the one this workspace answers with.
    return `dereferencing <${workspace}> resolved to <${provenance.resolvedTo}> and the record `
      + `offered as evidence is <${ws.head}> — the workspace answered with one document and `
      + 'this fold was handed a different one, so neither states what the other says';
  }
  return null;
}

/**
 * Why the role profile this fold was handed cannot be treated as this workspace's governance,
 * or null when it can.
 *
 * The sibling of {@link refuseConvenerAuthority}, one field over on the same record, and
 * deliberately a SECOND function rather than two more branches inside that one. They answer
 * different questions — who may grant, versus what a granted role permits — and a single
 * verdict over both would produce one string that cannot say which half failed, the same
 * reason {@link refuseFieldBinding} is not folded into {@link refuseAttestation}. It also
 * keeps a profile disagreement from being reported as a convener fault, which is this file's
 * standing complaint about its own diagnostics.
 *
 * ★ THE DUPLICATION BELOW IS DELIBERATE AND IS THE CHEAPER SIDE OF THE TRADE. The tag, record
 * and subject guards here are the same three the convener refusal makes. Sharing them would
 * mean editing that function, whose branch ORDER is load-bearing — its convener comparison
 * sits ABOVE the authorship check so that a disagreement reports the disagreement rather than
 * a signature problem, and `verify-can-live.ts` and two suites pin that string. Refactoring a
 * guard that survived review, in the diff that adds its sibling, is the move this area has
 * shipped a defect on in each of the last six rounds. The two are pinned by the same
 * direct-call cases so a divergence surfaces as a test failure rather than as a silence.
 *
 * ★ AND IT REFUSES ON THE CONFERRING TRACK ONLY — enforced by the caller, not here. This
 * function returns a string; {@link foldRoster} puts it in the grant filter's `??` chain and
 * nowhere else, so a disagreement removes the power to make members and leaves every
 * revocation, withdrawal and divergence exactly where a fold with no evidence at all leaves
 * them. Round 3 shipped the inversion of that at a narrower gate and had to undo it.
 *
 * Every branch refuses, including the one where the caller asked and got nothing back. The
 * only path to null is a workspace record that IS this workspace, NAMES THIS POLICY'S CONVENER,
 * declares a non-empty `wsp:roleProfile` equal to the IRI the caller's profile claims, and
 * holds up as a record at whatever strength the rest of the policy demands.
 *
 * ★ THE CONVENER BRANCH IS A PRECONDITION HERE, NOT THE OTHER FUNCTION'S QUESTION BORROWED.
 * What it establishes is that this record's `wsp:roleProfile` is worth reading at all, which
 * the profile comparison below silently assumed. It refuses; it never answers the convener's
 * question in `roleProfileBinding` — the two verdicts stay separate and the pair matrix in
 * `tests/workspace-adversarial.test.ts` is what holds them apart.
 */
export function refuseRoleProfileAuthority(args: {
  readonly evidence: ConvenerEvidence;
  /** The workspace being folded. The record's own subject must be this. */
  readonly workspace: string;
  /**
   * `RoleProfile.profile` — the IRI the caller's role table claims to have come from. Never
   * replaced by the record's: see this module's header for why substitution is the escalating
   * version of this check, and for what comparing IRIs does and does not establish.
   */
  readonly profile: string;
  /**
   * The principal the policy treats as entitled to grant. Not compared against the caller's
   * profile — it is here so that a record naming SOMEBODY ELSE as convener is refused before
   * its `wsp:roleProfile` is believed. See the branch that reads it.
   */
  readonly convener: Principal;
  readonly signerOf?: SignerResolver;
  readonly requireContentBinding?: boolean;
  readonly requireFieldBinding?: boolean;
}): string | null {
  const { evidence, workspace, profile } = args;
  // Read before the narrowing erases it, for the reason `refuseConvenerAuthority` does: the
  // compiler believes the tag can only be `'declared'` after the branch below, and this value
  // arrives as JSON through `can.ts` in a federated composer where the type guarantees nothing.
  const tag: string = evidence.kind;
  if (evidence.kind === 'unreadable') {
    return 'the workspace record that would say which role profile governs here could not be '
      + `read (${evidence.why}). This policy ASKED, and an unanswered question about what a `
      + 'role permits is not the same as never having asked — so nothing CONFERS. Every '
      + 'revocation and withdrawal still applies, because refusing to confer is not deleting a '
      + 'record';
  }
  if (tag !== 'declared') {
    return `the workspace evidence is tagged '${tag}', which is neither 'declared' nor `
      + "'unreadable'. An unknown tag establishes nothing about which role profile governs "
      + 'here, and a tag that fell through to the declared branch is how a third value once '
      + 'reported a binding off the back of nothing';
  }
  const ws: WorkspaceRecord | undefined = evidence.record;
  if (ws === undefined) {
    return "the workspace evidence is tagged 'declared' and carries no record. A declaration "
      + 'with nothing in it declares no role profile';
  }
  if (ws.workspace !== workspace) {
    // First, for the same reason as on the convener side: a record about somewhere else can
    // neither agree nor disagree with this fold, and reporting a profile mismatch on it would
    // send an operator to reconcile two governance documents that were never in conflict.
    return `the workspace record at <${ws.head}> declares the role profile of <${ws.workspace}> `
      + `and this roster is <${workspace}> — a record of another workspace says nothing about `
      + 'what a role permits in this one, however well signed it is';
  }
  if (ws.convener !== args.convener) {
    // ★ REFUSED BEFORE THE PROFILE IS COMPARED, AND IT IS A DIAGNOSTIC FIX RATHER THAN AN
    // ESCALATION FIX. Reproduced live on 2026-08-02 and independently through the real reader:
    // a record whose subject is this workspace, naming a STRANGER as convener and the true
    // `wsp:roleProfile`, signed by that stranger's own agent, produced
    // `convenerBinding: 'refused'` beside `roleProfileBinding: 'bound'` — and `'bound'`'s own
    // contract says "the governance these capabilities were computed under is the governance
    // the workspace publishes". Nothing held up. The only thing checked was that a stranger's
    // self-consistent record agreed with the caller, and this field is a non-omittable SECURITY
    // output. No capability moves — both refusals sit in the same `??` chain, so conferral
    // needs both null and `convenerBinding` is `'refused'` on every input that reaches here —
    // which is exactly why it had to be fixed as a claim rather than as a hole.
    //
    // The message names the CONVENER question rather than the profile one, so an operator is
    // not sent to reconcile two governance documents that never disagreed. The pair stays
    // separable: a record with the right convener and the wrong profile still reports
    // `('bound','refused')`, which is the row a fold that answered one question with the
    // other's verdict cannot satisfy alongside this one.
    return `the workspace record at <${ws.head}> names ${ws.convener} as convener and this `
      + `policy treats ${args.convener} as entitled to grant. What a role permits here is `
      + 'whatever the party who convenes this workspace published, so a record written by '
      + 'somebody else declares no governance for this roster — the profile IRI on it is not '
      + 'compared at all, because agreeing with a stranger establishes nothing. Settle the '
      + 'convener first: see `convenerBinding`';
  }
  // ★ BOTH EMPTIES REFUSED BEFORE THE COMPARISON, AND THAT ORDER IS THE GUARD. `''` is what
  // `readWorkspaceRecord` carries when the record stated no readable `wsp:roleProfile`, and a
  // caller that passed a profile with no `profile` IRI arrives as `''` too. Left to the
  // equality test below, those two blanks would MATCH and this fold would report the
  // governance as bound because neither side named any.
  if (typeof ws.roleProfile !== 'string' || ws.roleProfile === '') {
    return `the workspace record at <${ws.head}> states no readable wsp:roleProfile, so it `
      + 'declares no governance for this roster to be checked against. The published '
      + 'WorkspaceShape requires exactly one; a record without one answers the question by not '
      + 'asking it';
  }
  if (typeof profile !== 'string' || profile === '') {
    return `<${workspace}> declares the role profile <${ws.roleProfile}> and this fold was `
      + 'handed a RoleProfile that names no profile IRI at all, so there is nothing to compare '
      + 'it with. An unnamed role table cannot be shown to be the one this workspace publishes';
  }
  if (ws.roleProfile !== profile) {
    // ★ THE HEADLINE REFUSAL, AND IT REFUSES RATHER THAN CORRECTING. Adopting `ws.roleProfile`
    // would be the convener inversion in the field that decides capabilities: the fold holds
    // the caller's ROLE TABLE and only the declared IRI, so "adopting" could relabel the
    // caller's own permits with the workspace's name and confer them — evidence that widens.
    return `this fold was handed the role profile <${profile}> and <${workspace}> declares `
      + `<${ws.roleProfile}>. The two disagree, so no grant here CONFERS: the profile decides `
      + 'what every role in this roster permits, and a roster folded against governance the '
      + 'workspace never declared reports capabilities nobody published. The declared profile '
      + 'is not substituted for the caller\'s — the fold holds an IRI, not the document — so a '
      + 'disagreement is refused rather than resolved';
  }
  // Held to the same standard as the grants it governs, and against the party the record
  // itself names as convener — the party a record of this workspace must have come from. That
  // this is also the policy's convener is the OTHER refusal's question, deliberately not
  // re-asked here: answering it twice would make a convener disagreement print as a profile
  // fault in `roleProfileBinding`.
  const badSignature = refuseAttestation(
    ws.attestation, ws.convener, args.signerOf, args.requireContentBinding === true,
  );
  if (badSignature !== null) {
    return `the workspace record at <${ws.head}> declares the role profile <${ws.roleProfile}> `
      + `and that record itself does not hold up: ${badSignature}. A declaration of what a role `
      + 'permits is worth exactly what its own authorship is worth, and anybody can write one '
      + 'about anybody';
  }
  const badFields = refuseFieldBinding(
    ws.fieldProvenance, ws.head, args.requireFieldBinding === true,
  );
  if (badFields !== null) {
    return `the workspace record at <${ws.head}> declares the role profile <${ws.roleProfile}> `
      + `and that value was not read from the record: ${badFields}`;
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
   * entitled to grant — that is a separate question, answered separately, and the answer is
   * {@link convenerBinding}. `'bound'` here beside `'unchecked'` there is a roster of
   * perfectly parsed records that may be about entirely the wrong memberships.
   */
  readonly recordFieldBinding: 'bound' | 'unbound';
  /**
   * Whether the convener this fold attested grants against is the convener the WORKSPACE
   * declares.
   *
   *   bound       `attestation.workspaceEvidence` carried a workspace record, its subject is
   *               this workspace, its `wsp:convener` is the principal the policy named, and
   *               the record held up as a record at whatever strength the rest of the policy
   *               demanded. The party that granted here is the party the workspace says may.
   *   refused     evidence was supplied and did NOT establish that. Either the two disagree,
   *               or the record is of another workspace, or its own authorship or fields did
   *               not hold up, or the caller asked and the substrate could not answer. NO
   *               GRANT CONFERRED — every one is in `unattested` with the reason — and every
   *               revocation and withdrawal still applied.
   *   unchecked   no policy, or a policy that passed no evidence. `AttestationPolicy.convener`
   *               is a value the caller typed and nothing compared it to anything. This is
   *               what every caller written before the field does, and the roster it produces
   *               is indistinguishable from a checked one except through this field.
   *
   * Non-omittable, for the reason {@link recordFieldBinding} and `crossStreamOrderIsAdvisory`
   * are: the three rosters look identical, and a caller must not be able to read `members`
   * without having been handed the difference.
   *
   * ★ WHAT `'bound'` DOES NOT MEAN HERE EITHER. The descriptor URL the workspace record was
   * read from is chosen by whoever assembled the fold. This says a record whose subject is
   * this workspace names that convener, signed for them, over bytes the substrate re-digested
   * — not that the record is what dereferencing the workspace returns. See this module's
   * header.
   */
  readonly convenerBinding: ConvenerBinding;
  /**
   * Whether the role profile this fold computed capabilities from is the profile the WORKSPACE
   * declares.
   *
   *   bound       `attestation.workspaceEvidence` carried a workspace record, its subject is
   *               this workspace, its `wsp:roleProfile` is the IRI `profile.profile` names, and
   *               the record held up as a record at whatever strength the rest of the policy
   *               demanded. The governance these capabilities were computed under is the
   *               governance the workspace publishes.
   *   refused     evidence was supplied and did NOT establish that. Either the two name
   *               different profiles, or one of them named none, or the record is of another
   *               workspace, or its own authorship or fields did not hold up, or the caller
   *               asked and the substrate could not answer. NO GRANT CONFERRED — every one is
   *               in `unattested` with the reason — and every revocation and withdrawal still
   *               applied.
   *   unchecked   no policy, or a policy that passed no evidence. `profile` is a document the
   *               caller chose and nothing compared it to anything, while `permitsOf` was built
   *               from it and it decided every `effective` capability below.
   *
   * Non-omittable, for the reason {@link convenerBinding} and `crossStreamOrderIsAdvisory`
   * are: the three rosters look identical, and a caller must not be able to read `members`
   * without having been handed the difference.
   *
   * ★ WHAT `'bound'` DOES NOT MEAN, AND IT IS A SHORTER CLAIM THAN THE OTHER TWO BINDINGS.
   * `RoleProfile.profile` is the caller's own statement of where its `roles` came from. This
   * module is pure, so the profile document is never fetched and the role table behind that
   * IRI is never checked against it. `'bound'` says the caller's table CLAIMS to be the
   * declared profile; it does not say it IS. A caller that writes the declared IRI over an
   * invented set of permits passes this check — that is residual gap 10, and it is the same
   * kind of self-certification {@link FieldProvenance} carried until `membership.ts` existed
   * to produce it.
   *
   * ★ AND IT IS A SEPARATE QUESTION FROM {@link convenerBinding}, WHICH IS NOT THE SAME AS
   * BEING INDEPENDENT OF IT. What stood here said `'refused'` there beside `'bound'` here was
   * "a coherent and expected pair: the workspace's own record declares the governance you
   * folded against and does NOT name the convener you did". That pair is now unreachable, and
   * the sentence was the thing a review falsified: a record naming a STRANGER as convener and
   * the true `wsp:roleProfile`, signed by that stranger, produced exactly it — so `'bound'`,
   * whose contract two paragraphs up is "the governance these capabilities were computed under
   * is the governance the workspace publishes", was asserting something an unauthorised party
   * controlled. {@link refuseRoleProfileAuthority} now refuses before comparing when the record
   * names somebody other than the policy's convener.
   *
   * What remains separate is the direction that matters: `('bound','refused')` — the right
   * convener, the wrong profile — is still reachable and is still the row a fold that answered
   * one question with the other's verdict cannot satisfy alongside `('refused','refused')`.
   * Conferral requires both, and each refusal still names its own fault so neither is repaired
   * by fixing the other.
   */
  readonly roleProfileBinding: RoleProfileBinding;
  /**
   * Whether the workspace evidence this fold read is the record `<workspace>` DEREFERENCES TO.
   *
   *   bound       the policy asked, and `attestation.workspaceEvidence` carried an
   *               {@link EvidenceProvenance} saying it was obtained by dereferencing THIS
   *               workspace and resolving to THIS record. The two other bindings above are
   *               statements about a document; this is the statement that it is the right one.
   *   refused     the policy asked and did NOT get that. Either the evidence carries no
   *               provenance at all — the residual-gap-9 shape, a record somebody chose — or
   *               a different IRI was dereferenced, or the dereference resolved to a different
   *               document, or the policy demanded provenance and was passed no evidence. NO
   *               GRANT CONFERRED, and every revocation and withdrawal still applied.
   *   unchecked   `requireEvidenceProvenance` was not set. The descriptor URL the workspace
   *               record was read from is whatever whoever assembled this fold chose, and
   *               anybody may publish a `wsp:Workspace` for anybody's workspace IRI on their
   *               own pod. This is what every caller written before the flag does.
   *
   * Non-omittable, for the reason the four fields above are: the rosters look identical, and
   * `'unchecked'` and `'refused'` must never be the same absent field — "nobody asked where
   * this came from" and "somebody asked and it came from the wrong place" are the two states
   * this whole gap is made of.
   *
   * ★ WHAT `'bound'` DOES NOT MEAN. This module is pure and does not dereference anything, so
   * the pair it checked is the CALLER'S statement, in exactly the sense `FieldProvenance` is a
   * record's own statement about its fields. What makes the statement worth something is that
   * there is a producer that makes it honestly — `dereferenceWorkspaceRecord` in
   * `membership.ts`, which resolves the workspace through the pod its own `/ns` owner segment
   * names — and that the substrate refuses anyone else a write there (`403 scope_violation`,
   * measured both ways). A caller that hand-writes the pair beside a record it forged passes
   * this check, and cannot be caught by a function that cannot fetch.
   */
  readonly evidenceProvenanceBinding: EvidenceProvenanceBinding;
  /**
   * Whether the role TABLE this fold computed every capability from is the table the document
   * at `profile.profile` actually contains.
   *
   *   bound       `attestation.roleTableEvidence` carried a role profile document, it was
   *               obtained by dereferencing the IRI this fold's `RoleProfile` claims, and the
   *               roles it declares are — role for role, capability for capability, under the
   *               same duplicate-intersection rule `permitsOf` applies — the roles this fold
   *               used. The capabilities below are the capabilities that document publishes.
   *   refused     the policy asked and did NOT get that. Either the two tables differ, or the
   *               document was fetched from a different IRI, or one of the two named no IRI, or
   *               the document contradicts itself about how it was obtained, or a signed
   *               profile's own authorship did not hold up, or the caller asked and the read
   *               failed. NO GRANT CONFERRED — every one is in `unattested` with the reason —
   *               and every revocation and withdrawal still applied.
   *   unchecked   no policy, or a policy that passed no role-table evidence. `profile.roles` is
   *               a table the caller typed and nothing compared it with the document it claims
   *               to have come from. This is what every caller written before this field does,
   *               and the roster it produces is indistinguishable from a checked one except
   *               through this field.
   *
   * Non-omittable, for the reason the five fields above are.
   *
   * ★ WHAT `'bound'` DOES NOT MEAN, AND THE FIRST CLAUSE IS THE ONE MOST AT RISK OF BEING
   * OVER-READ. It does NOT mean the table was signed. The profile every workspace in this repo
   * declares is a static file on GitHub Pages and CANNOT be signed — see
   * {@link RoleTableAuthority} — so for that document `'bound'` means *these are the bytes that
   * origin served at that URL at the moment of the read*, and no more. Which of the two grades
   * was reached is stated in words in {@link attributionNote}, because a caller reading a
   * three-valued enum has not been told the difference between a TLS fetch and a proof.
   *
   * ★ AND IT DOES NOT MEAN THE WORKSPACE DECLARES THIS PROFILE. That is
   * {@link roleProfileBinding}, off a different record, and the two are independent inputs: a
   * fold given role-table evidence and no workspace evidence reports `('unchecked','bound')` —
   * a table faithfully read from a document nobody has shown governs this workspace.
   *
   * ★ AND THE RESIDUE IS THE ONE THE OTHER FOUR CARRY. This module is pure and fetches nothing,
   * so `RoleTableEvidence` is the CALLER'S statement that it performed that dereference, in
   * exactly the sense {@link Attestation} is its statement about a verifier's answer. What the
   * statement is worth is what its producer is worth — `dereferenceRoleProfile` in
   * `membership.ts` — and unlike a workspace IRI, whose owner segment names a pod the substrate
   * defends, a web IRI is defended only by TLS and by whoever holds the host.
   */
  readonly roleTableBinding: RoleTableBinding;
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
 * A role table, reduced to what it actually PERMITS: one entry per role, capabilities unique
 * and sorted, a role declared more than once INTERSECTED rather than overwritten.
 *
 * ★ EXTRACTED FROM `foldRoster`, AND SHARING IT IS THE POINT RATHER THAN THE TIDINESS. This was
 * the nine lines that built `permitsOf`, and {@link refuseRoleTableAuthority} has to compare two
 * tables under exactly the rule the fold reads them under. A second implementation — even a
 * correct one — would mean `roleTableBinding: 'bound'` asserts "these two tables agree under MY
 * normalisation" while every capability below is computed under ANOTHER, and the pair drifting
 * is a disagreement the fold reports as agreement. That is the defect class this whole file is a
 * record of, so the two are one function.
 *
 * The intersection rule itself is not new and its reason is unchanged: a profile declaring
 * `#Observer` narrow then wide gave the Observer append, grant and revoke; reversed, none of the
 * three; `divergences` was empty both ways. Order-dependent privilege in a published governance
 * document, decided by which triple the parser emitted last.
 *
 * `duplicated` comes back beside the table because the fold REPORTS duplicates as a divergence
 * and a caller that only got the reduced map could not. Returning both is what let the
 * extraction be a move rather than a rewrite.
 */
export function normaliseRoleTable(roles: readonly RoleDefinition[]): {
  readonly permits: ReadonlyMap<string, readonly Capability[]>;
  readonly duplicated: ReadonlySet<string>;
} {
  const permits = new Map<string, string[]>();
  const duplicated = new Set<string>();
  for (const r of roles) {
    const caps = uniqueSorted([...r.permits]);
    const prior = permits.get(r.role);
    if (prior === undefined) { permits.set(r.role, caps); continue; }
    duplicated.add(r.role);
    permits.set(r.role, intersect(prior, caps));
  }
  return { permits, duplicated };
}

/**
 * How the caller's role table differs from the document's, or null when it does not.
 *
 * ★ ANY DIFFERENCE IS A DIFFERENCE, INCLUDING THE ONES THAT NARROW, and that is a decision
 * rather than laziness. The escalating direction — the caller permitting something the document
 * does not — is the attack, and reporting only it would be enough to stop the attack. Two things
 * argue for the stricter rule. `knownRole` picks the NARROWEST-permits role among a principal's
 * grant heads, so a caller that merely OMITS a role changes the label printed beside a member's
 * capabilities: an omission moves a security output, in a direction a subset check cannot see.
 * And `'bound'`'s contract is "the capabilities below are the capabilities that document
 * publishes" — a claim that is only literally true when the tables are equal, and this file's
 * standing complaint is about claims that are nearly true.
 *
 * ★ THE MESSAGE LEADS WITH THE WIDENING. An operator holding both a widening and a narrowing
 * needs the widening first: it is the one that conferred authority nobody published, and the
 * other is a roster that under-privileges somebody who will say so within the hour.
 */
function compareRoleTables(
  callers: readonly RoleDefinition[], documents: readonly RoleDefinition[],
): string | null {
  const mine = normaliseRoleTable(callers).permits;
  const theirs = normaliseRoleTable(documents).permits;
  const widened: string[] = [];
  const narrowed: string[] = [];
  for (const role of uniqueSorted([...mine.keys()])) {
    const a = mine.get(role) ?? [];
    const b = theirs.get(role);
    if (b === undefined) {
      // A role the caller declares and the document does not. Counted as a widening, because
      // that is what it is: the fold will confer this role's capabilities on any grant naming
      // it, and the published governance says the role does not exist.
      widened.push(`<${role}> is not declared by the document at all, and this fold gives it `
        + `[${a.join(', ')}]`);
      continue;
    }
    const extra = a.filter(c => !b.includes(c));
    const absent = b.filter(c => !a.includes(c));
    if (extra.length > 0) widened.push(`<${role}> is given [${extra.join(', ')}] here and is not given it there`);
    if (absent.length > 0) narrowed.push(`<${role}> is given [${absent.join(', ')}] there and not here`);
  }
  for (const role of uniqueSorted([...theirs.keys()]).filter(r => !mine.has(r))) {
    narrowed.push(`<${role}> is declared by the document and not by this fold`);
  }
  if (widened.length === 0 && narrowed.length === 0) return null;
  return [
    ...(widened.length > 0 ? [`it PERMITS MORE than the document does — ${widened.join('; ')}`] : []),
    ...(narrowed.length > 0 ? [`it permits less than the document does — ${narrowed.join('; ')}`] : []),
  ].join(', and ');
}

/**
 * Why the role table this fold computed capabilities from cannot be treated as the table the
 * document at its own profile IRI contains, or null when it can.
 *
 * ── WHAT THIS IS FOR: RESIDUAL GAP 10 ────────────────────────────────────────
 *
 * {@link refuseRoleProfileAuthority} one function up compares an IRI with an IRI. It establishes
 * that the caller's table CLAIMS to be the profile the workspace declares, and `roster.ts` is
 * pure, so nothing had ever read the document behind that claim. Measured: a fold reporting
 * `convenerBinding: 'bound'`, `roleProfileBinding: 'bound'`, `recordFieldBinding: 'bound'` and
 * an empty `unattested` handed an `#Observer` the `grant` and `revoke` capabilities, because
 * `{profile: <the declared IRI>, roles: [anything]}` agrees on every IRI anybody compares.
 *
 * ── THE THREE DIRECTIONS, COPIED DELIBERATELY ────────────────────────────────
 *
 * This is the fourth guard in this family and the shape is the one that survived four reviews.
 * It is copied rather than improvised, and copied WITH its reasons so a later edit cannot
 * mistake any of the three for an accident:
 *
 *   EVIDENCE, NEVER A SOURCE. There is no `profile.roles = document.roles`, for the reason there
 *   is no `convener = ws.convener`. The substitution is more tempting here — the fold holds the
 *   whole document, so it is one line — and it is the same escalation: a caller folding against
 *   a narrower table than the published one would start conferring everything the published one
 *   permits, so supplying evidence would WIDEN authority. See
 *   {@link AttestationPolicy.roleTableEvidence}.
 *
 *   THE CONFERRING TRACK ALONE, enforced by the caller and not here. This returns a string;
 *   {@link foldRoster} puts it at the end of the grant filter's `??` chain and nowhere else, so
 *   a table this fold will not accept removes the power to make members and leaves every
 *   revocation, withdrawal and divergence exactly where a fold with no evidence at all leaves
 *   them. Round 3 shipped the inversion of that at a narrower gate and had to undo it.
 *
 *   ASKING AND GETTING NOTHING IS A REFUSAL. `'unreadable'` refuses. When this was written the
 *   deployed profile IRI 404'd, so the honest state of the live artifact landed on this branch
 *   and the branch was the ordinary case. `docs/` now serves a page there and the reader follows
 *   its `rel=alternate`, so the live artifact reaches `'declared'` — which changes how often this
 *   branch is taken and nothing about why it must refuse. A profile a reader could not fetch, a
 *   page advertising no Turtle, and a host that has gone down all still arrive here, and a branch
 *   that passed would report the strictest check in the policy as satisfied by a document nobody
 *   could read.
 *
 * ★ AND THE SUBJECT IS NOT COMPARED — see {@link RoleProfileDocument.dereferenced} for why, and
 * do not add it back as a "free" extra check. A document's own subject is a triple its writer
 * chose, which gap 9 established the hard way; requiring it buys nothing against any attack and
 * refuses the ordinary case where a governance document is served at a URL that is not the name
 * it goes by.
 *
 * Every branch refuses. The only path to null is a document obtained by dereferencing the IRI
 * this fold's table claims, declaring exactly the roles and exactly the capabilities this fold
 * used, coherent about how it was obtained, and — where it is a pod record — holding up as one
 * at whatever strength the rest of the policy demands.
 */
export function refuseRoleTableAuthority(args: {
  readonly evidence: RoleTableEvidence;
  /**
   * The caller's own table AND its claimed IRI, passed whole rather than as two arguments: the
   * comparison is between a (IRI, table) pair and a document, and splitting it would let a
   * caller's IRI be checked against one thing and its roles against another.
   */
  readonly profile: RoleProfile;
  readonly signerOf?: SignerResolver;
  readonly requireContentBinding?: boolean;
}): string | null {
  const { evidence, profile } = args;
  // Read before the narrowing erases it, for the reason all three siblings do: this arrives as
  // JSON through `can.ts` in a federated composer, where the type guarantees nothing about a
  // value the compiler did not see written.
  const tag: string = evidence.kind;
  if (evidence.kind === 'unreadable') {
    return 'the role profile document that would say what these roles permit could not be read '
      + `(${evidence.why}). This policy ASKED, and an unanswered question about what a role `
      + 'permits is not the same as never having asked — so nothing CONFERS. Every revocation '
      + 'and withdrawal still applies, because refusing to confer is not deleting a record';
  }
  if (tag !== 'declared') {
    return `the role table evidence is tagged '${tag}', which is neither 'declared' nor `
      + "'unreadable'. An unknown tag establishes nothing about what any role permits, and a tag "
      + 'that fell through to the declared branch is how a third value once reported a binding '
      + 'off the back of nothing';
  }
  const doc: RoleProfileDocument | undefined = evidence.document;
  if (doc === undefined) {
    return "the role table evidence is tagged 'declared' and carries no document. A declaration "
      + 'with nothing in it declares no role table';
  }
  // ★ BOTH EMPTIES REFUSED BEFORE THE COMPARISON, AND THAT ORDER IS THE GUARD — the same lesson
  // `refuseRoleProfileAuthority` learned one function up, where two blank profile IRIs compared
  // equal and the fold reported the governance as bound because neither side named any. A
  // caller with no `profile` IRI and a producer that recorded no dereference both arrive as
  // `''`, and left to the `!==` below they would MATCH.
  if (typeof profile.profile !== 'string' || profile.profile === '') {
    return 'this fold was handed a RoleProfile that names no profile IRI at all, so there is no '
      + 'document its role table could be shown to have come from. An unnamed table cannot be '
      + 'checked against anything, however faithfully something else was read';
  }
  if (typeof doc.dereferenced !== 'string' || doc.dereferenced === '') {
    return `this fold folded against the role profile <${profile.profile}> and the document `
      + 'offered as evidence states no IRI it was obtained by dereferencing, so nothing relates '
      + 'it to that profile. Obtain it with dereferenceRoleProfile in membership.ts, which '
      + 'records the IRI it asked for';
  }
  if (doc.dereferenced !== profile.profile) {
    // The realistic failure, and it is not a liar: a composer that has read several governance
    // documents holds one per IRI, and attaching the one it fetched for <a> to a fold against
    // <b> produces a table that is genuine, correctly parsed, and about somewhere else.
    return `this fold folded against the role profile <${profile.profile}> and the document `
      + `offered as evidence was obtained by dereferencing <${doc.dereferenced}>. Reading one `
      + 'governance document establishes nothing about another, however faithfully it was read '
      + '— and a document\'s own subject is not consulted, because that is a triple its writer '
      + 'chose';
  }
  // ★ THE HEADLINE REFUSAL, AND IT REFUSES RATHER THAN CORRECTING. Adopting `doc.roles` would be
  // the convener inversion in the field that decides every capability in the roster: a caller
  // whose table is NARROWER than the published one would be handed the published one and start
  // conferring more than it asked for, so supplying evidence would grant.
  const disagreement = compareRoleTables(profile.roles, doc.roles);
  if (disagreement !== null) {
    return `the role table this fold computed capabilities from is not the table `
      + `<${doc.dereferenced}> contains: ${disagreement}. The document decides what every role `
      + 'here permits, so no grant CONFERS — a roster folded against a table nobody published '
      + 'reports capabilities nobody published. The document\'s table is NOT substituted for the '
      + 'caller\'s, because a caller folding against a narrower table would then be handed the '
      + 'wider one, and supplying evidence would grant';
  }
  // ── how the bytes were obtained, checked for self-consistency ──
  //
  // ★ THIS IS NOT A SIGNER CHECK AND THERE IS NO PRINCIPAL TO COMPARE AGAINST. A grant is
  // attested against the convener and an acceptance against its member, because each names the
  // party it must come from. A role profile names none: governance is published at an IRI, and
  // what makes it this workspace's governance is that the workspace's own record points there —
  // which `refuseRoleProfileAuthority` already checked, against the record's own convener.
  // Inventing an expected signer here would mean deciding who is entitled to publish a role
  // profile, which is a question the model does not ask and this function must not answer.
  const authority: string = doc.authority;
  if (authority !== 'signed-record' && authority !== 'transport-only') {
    return `the role profile document at <${doc.head}> states how it was obtained as `
      + `'${authority}', which is neither 'signed-record' nor 'transport-only'. An unrecognised `
      + 'provenance is not a weak one — it is an unread one, and reading it as the weaker value '
      + 'would let a future producer widen what `bound` means by writing a word this fold does '
      + 'not know';
  }
  if (authority === 'transport-only' && doc.attestation !== undefined) {
    // ★ THE ONE PLACE THE AUTHORITY LABEL IS CHECKED RATHER THAN BELIEVED, and it exists because
    // the label selects which checks run. Without it, a caller holding a POD record whose
    // authorship does not hold up could relabel it `'transport-only'` and skip the branch below.
    // The producer that makes transport-only documents attaches no attestation and cannot — a
    // plain HTTPS GET returns no proof — so a document carrying both contradicts itself about
    // where it came from, and a contradiction is refused rather than resolved in either
    // direction.
    return `the role profile document at <${doc.head}> says it was obtained by an ordinary `
      + 'HTTPS fetch and carries an authorship attestation, which a fetch cannot produce. The '
      + 'document contradicts itself about where it came from, and the reading that would '
      + 'resolve the contradiction is the one that skips the signature check';
  }
  if (authority === 'signed-record') {
    if (doc.attestation === undefined) {
      return `the role profile document at <${doc.head}> says it is a signed pod record and `
        + 'carries no attestation at all, so nobody read its authorship proof. An unchecked '
        + 'record is not a verified one, and the label is the only thing claiming it is either';
    }
    if (!doc.attestation.authorshipVerified) {
      return `the role profile document at <${doc.head}> is a pod record whose `
        + `iep:authorshipProof did not verify (${doc.attestation.reason ?? 'no reason given'}). `
        + 'A declaration of what a role permits is worth exactly what its own authorship is '
        + 'worth';
    }
    if (!doc.attestation.boundToDescriptor) {
      // Refused without accusing, for the reason `refuseAttestation` gives: four situations set
      // this flag false and only one of them is a forgery.
      return `the role profile document at <${doc.head}> is a pod record whose authorship proof `
        + 'does not name this descriptor'
        + (doc.attestation.reason !== undefined ? ` (${doc.attestation.reason})` : '')
        + ' — either the proof was minted for another record and copied in, or this record does '
        + 'not follow the naming convention the binding is compared on. Both are refused; only '
        + 'one of them is a forgery, and this layer cannot tell which';
    }
    if (args.requireContentBinding === true && doc.attestation.contentBinding !== 'bound') {
      const observed = doc.attestation.contentBinding ?? 'unbound';
      return `the role profile document at <${doc.head}> is a pod record and this policy `
        + `requires its proof to have been checked against the bytes served for it, which came `
        + `back '${observed}'. The roles above were parsed out of a payload nobody re-digested, `
        + 'so they are whatever the document says now rather than what its signer signed';
    }
  }
  return null;
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
  //
  // ★★ AND IT IS NOW `normaliseRoleTable`, WHICH IS THE SAME NINE LINES MOVED AND NOT A REWRITE.
  // `refuseRoleTableAuthority` compares the caller's table with the published one and has to do
  // it under exactly this rule; a second copy of it there would mean `roleTableBinding: 'bound'`
  // asserts an agreement under one normalisation while every capability below is computed under
  // another. Sharing is the guarantee, not the tidiness.
  const { permits: permitsOf, duplicated: duplicatedRoles } = normaliseRoleTable(profile.roles);
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
  // ★ COMPUTED ONCE, OUTSIDE THE FILTER, BECAUSE IT IS A FACT ABOUT THE POLICY AND NOT ABOUT
  // ANY RECORD. Every grant gets the same answer, so evaluating it per grant would be the same
  // string N times at N times the cost — and, more to the point, computing it inside the
  // filter invites a future edit to make it depend on the row, which is how a policy-level
  // gate becomes a per-row one that some rows pass.
  const evidence = args.attestation?.workspaceEvidence;
  const convenerRefusal = args.attestation === undefined || evidence === undefined
    ? null
    : refuseConvenerAuthority({
        evidence, workspace, convener: args.attestation.convener, signerOf,
        // The workspace record is held to the SAME strength as the records it authorises.
        // Anything weaker would put the softest check at the top of the chain.
        requireContentBinding: requireBinding, requireFieldBinding: requireFields,
      });
  const convenerBinding: ConvenerBinding =
    args.attestation === undefined || evidence === undefined
      ? 'unchecked'
      : convenerRefusal === null ? 'bound' : 'refused';
  // ★ THE SAME RECORD, THE OTHER FIELD, AND A SEPARATE VERDICT. Computed here beside the
  // convener's and for the same reasons — it is a fact about the POLICY, identical for every
  // grant, so evaluating it per row would cost N times as much and invite a later edit to make
  // a policy-level gate depend on the row. Kept a distinct call and a distinct field because a
  // profile disagreement and a convener disagreement are different faults with different
  // repairs: one republishes a workspace record, the other re-folds against the declared
  // governance.
  const profileRefusal = args.attestation === undefined || evidence === undefined
    ? null
    : refuseRoleProfileAuthority({
        evidence, workspace, profile: profile.profile, convener: args.attestation.convener,
        signerOf, requireContentBinding: requireBinding, requireFieldBinding: requireFields,
      });
  const roleProfileBinding: RoleProfileBinding =
    args.attestation === undefined || evidence === undefined
      ? 'unchecked'
      : profileRefusal === null ? 'bound' : 'refused';
  // ★ THE THIRD QUESTION OFF THE SAME EVIDENCE, AND THE ONLY ONE GATED ON A FLAG RATHER THAN ON
  // THE EVIDENCE BEING PRESENT. The two above turn on the moment a caller passes evidence,
  // because comparing what it says costs nothing and refusing more is always safe. This one
  // demands the caller have obtained the record a particular way, which no existing caller
  // does — so it is opted into, like `requireContentBinding` and `requireFieldBinding`, and
  // `evidenceProvenanceBinding` reports whether it was.
  //
  // ★ AND ITS `undefined` EVIDENCE CASE IS A REFUSAL, WHICH IS WHY `evidence` GOES IN RATHER
  // THAN BEING GUARDED OUT HERE. A policy that demands the dereferenced record and passes none
  // has not met the demand; letting the missing field make the flag inert is how a strict
  // policy quietly becomes a weak one.
  const askedForEvidenceProvenance = args.attestation?.requireEvidenceProvenance === true;
  const evidenceRefusal = !askedForEvidenceProvenance
    ? null
    : refuseEvidenceProvenance({ evidence, workspace, requireEvidenceProvenance: true });
  const evidenceProvenanceBinding: EvidenceProvenanceBinding = !askedForEvidenceProvenance
    ? 'unchecked'
    : evidenceRefusal === null ? 'bound' : 'refused';
  // ★ THE FOURTH CONSTANT REFUSAL, AND THE ONLY ONE THAT IS NOT ABOUT THE WORKSPACE RECORD. The
  // three above all read one `wsp:Workspace`; this reads the document that record's
  // `wsp:roleProfile` NAMES, which is what decides every capability below. Computed here beside
  // them and for the same two reasons: it is a fact about the POLICY and identical for every
  // grant, so evaluating it per row would cost N times as much and would invite a later edit to
  // make a policy-level gate depend on the row.
  //
  // ★ GATED ON THE EVIDENCE BEING PRESENT RATHER THAN ON A FLAG, like the convener's and the
  // profile's and unlike `requireEvidenceProvenance`. A caller that went and read the document
  // has already paid the cost the flag would be protecting; comparing what came back is free,
  // and refusing more is always safe. `roleTableBinding` reports whether anybody asked.
  const roleTableEvidence = args.attestation?.roleTableEvidence;
  const tableRefusal = args.attestation === undefined || roleTableEvidence === undefined
    ? null
    : refuseRoleTableAuthority({
        evidence: roleTableEvidence, profile, signerOf,
        // The governance document is held to the SAME strength as the records it governs, for
        // the reason the workspace record is. `requireFieldBinding` is deliberately NOT passed
        // through: a role profile carries no `FieldProvenance` — see `RoleProfileDocument` —
        // because the only producer that could mint one is the pod-record path, and demanding
        // it would refuse every profile served from an ordinary web host, which is the deployed
        // one and most of the point of roles being data.
        requireContentBinding: requireBinding,
      });
  const roleTableBinding: RoleTableBinding =
    args.attestation === undefined || roleTableEvidence === undefined
      ? 'unchecked'
      : tableRefusal === null ? 'bound' : 'refused';
  // ★ THE GRADE IN WORDS, AND IT IS A NAMED CONST BECAUSE THE NOTE IS ALREADY FOUR TERNARIES
  // DEEP. A fifth, nested inside a template literal inside the fourth, is how a sentence ends up
  // rendered on the wrong branch — and this is the sentence that keeps `roleTableBinding:
  // 'bound'` from being read as "somebody signed this". Rendered only in the `'bound'` branch,
  // where the evidence is present by construction; the `else` is the value that claims least, so
  // an evidence shape this expression does not recognise cannot upgrade the claim.
  const roleTableGrade = roleTableEvidence !== undefined
    && roleTableEvidence.kind === 'declared'
    && roleTableEvidence.document.authority === 'signed-record'
    ? 'as a SIGNED POD RECORD, so its authorship was checked and anyone can check it again'
    : 'by an ORDINARY HTTPS FETCH, so the whole of the evidence is that this origin served '
      + 'these bytes at that URL at the moment of the read — nobody signed them, and nobody '
      + 'who was not present at the fetch can check them';
  if (args.attestation) {
    const convener = args.attestation.convener;
    conferringGrants = inWorkspaceGrants.filter(g => {
      // Attestation first: "who signed this" is the more fundamental question and its
      // refusals name a party, which is what an operator acts on.
      //
      // ★ AND THE CONVENER CHECK IS LAST, WHICH IS THE OPPOSITE OF WHAT ITS IMPORTANCE
      // SUGGESTS. It is the most consequential refusal here — it invalidates the whole roster
      // rather than one row — but it is also CONSTANT, so putting it first would overwrite
      // every per-record diagnosis with one repeated sentence. An operator would fix the
      // policy, re-fold, and only then discover the forged grant that was there all along:
      // two round trips to see two independent faults. Last in the chain, every genuine grant
      // reports the policy fault and every bad one still reports its own, in a single fold —
      // and the policy fault is stated once at roster scope, where it belongs, in
      // `convenerBinding` and `attributionNote` rather than N times at record scope.
      //
      // ★ AND THE PROFILE REFUSAL IS LAST OF ALL, BEHIND THE CONVENER'S. Both are constant, so
      // both belong after the per-record diagnoses for the reason above; between the two, who
      // may grant here is the more fundamental question and the one whose repair comes first.
      // A workspace whose record disagrees on BOTH reports the convener, because re-folding
      // against the declared profile would still confer nothing until the convener is settled.
      //
      // ★ AND THE EVIDENCE'S OWN PROVENANCE IS LAST OF ALL, BEHIND BOTH. Same reasoning one
      // step further: all three are constant across rows, so all three sit after the per-record
      // diagnoses. Between them, who may grant and what a role permits are faults in the
      // WORKSPACE'S published record, and this one is a fault in how THIS FOLD was assembled —
      // the operator with more than one wants the republishable fault named first, and a fold
      // whose evidence came from the wrong place confers nothing even once the other two are
      // settled.
      //
      // ★ AND THE ROLE TABLE IS LAST OF ALL, BEHIND ALL THREE. Same reasoning one step further,
      // and the order between it and the profile IRI is load-bearing rather than arbitrary:
      // WHICH document governs must be settled before WHAT is inside it is worth comparing. A
      // fold whose workspace declares one profile while the caller folded against another would
      // otherwise report a table disagreement, and send an operator to reconcile two governance
      // documents when the repair is to fold against the declared one and re-read.
      const why = refuseAttestation(g.attestation, convener, signerOf, requireBinding)
        ?? refuseFieldBinding(g.fieldProvenance, g.head, requireFields)
        ?? convenerRefusal
        ?? profileRefusal
        ?? evidenceRefusal
        ?? tableRefusal;
      if (why === null) return true;
      unattested.push({
        kind: 'grant', head: g.head, principal: g.grantedTo, because: why,
        restrictionStillApplied: g.revoked === true,
      });
      return false;
    });
    // ★ AND NONE OF `convenerRefusal`, `profileRefusal`, `evidenceRefusal` OR `tableRefusal` IS
    // IN THIS CHAIN. A convener disagreement is about who may GRANT, a profile disagreement is
    // about which document governs, a table disagreement is about what is inside that document,
    // and an evidence-provenance refusal is about how this fold was
    // assembled; an acceptance is a member's own statement about their own pod and is no
    // less theirs because the policy got any of the four wrong. Adding them here would
    // refuse strictly more — monotone, so not unsafe — and would print a line accusing every
    // member of something the CONVENER's side got wrong, in the one channel operators are told
    // to watch. It also buys nothing: a member needs a conferring grant AND a conferring
    // acceptance, and the grant filter above has already refused all of them.
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
        // ★ AND `accepted.length === 0` HAS TWO CAUSES, WHICH IT USED TO REPORT AS ONE. It is
        // read off the CONFERRING track, so it is empty both when every acceptance head was
        // refused AND when no grant confers at all — and in the second case every clause of
        // the refused-answers note is false. Measured on a workspace where every record is
        // honest and only the policy and the workspace disagree about who convenes: the note
        // said "listed as invited instead" with `pendingInvitations` EMPTY (nothing to invite
        // under, because `conferring` is what the pending branch below iterates), and
        // "`unattested` says why each answer was refused" with `unattested` holding one GRANT
        // row and no acceptance rows at all. The members were blamed for the convener's fault,
        // in the one channel this file insists must never assert an outcome that did not
        // happen. `conferring.length === 0` is the exact discriminator, because it is also the
        // condition under which the pending branch pushes nothing.
        note: withdrawn
          ? `${acceptanceHeads.length} concurrent acceptance heads for ${principal}, and one of `
            + 'them WITHDRAWS. The member is NOT included: a withdrawal on any head is '
            + 'decisive, so the ambiguity about which stream is theirs does not arise.'
          : conferring.length === 0
            ? `${acceptanceHeads.length} concurrent acceptance heads for ${principal}, and no grant `
              + 'to them CONFERS under this policy — so there is nothing for either head to '
              + 'accept. The fork is real and still unresolved, but it is not why the member is '
              + 'absent, their answers were not refused, and no invitation is raised because '
              + 'there is no conferring grant to invite them under. `unattested` names the grant.'
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
          : 'Residual, and it is not small, and content binding does not reduce it: every '
            + 'field here — the role, the grantee, the stream — is as the CALLER TYPED IT '
            + 'rather than read from the record, so one of a member\'s ordinary signed '
            + 'records passes this gate as their acceptance. That record is genuinely theirs '
            + 'and genuinely unmodified, which is why binding its content changes nothing '
            + 'about the attack. Pass `requireFieldBinding` and read the records with '
            + 'membership.ts to close it. See `recordFieldBinding`. A proof lifted out of a '
            + 'principal\'s real record and pasted into a fabricated one is narrowed '
            + 'separately — see `readAttestation`.')
        // ★ OUTSIDE THE FIELD-BINDING TERNARY, because it is a different question and used to
        // be answered inside it. The convener sentence lived in the `requireFieldBinding`
        // branch, so the only configuration that ever mentioned the convener at all was the
        // strictest one — a caller at a lower rung was told nothing about the principal every
        // grant here was attested against.
        + (convenerBinding === 'bound'
          ? `The CONVENER was checked against the workspace: a record whose subject is `
            + `<${workspace}> declares wsp:convener ${args.attestation.convener}, in the region `
            + 'of its own document the substrate digested, signed by an agent that principal\'s '
            + 'registry vouches for. Residual: the descriptor URL that record was read from was '
            + 'supplied by whoever assembled this fold, so what is established is that such a '
            + 'record exists and says so — not that it is what dereferencing the workspace '
            + 'returns. See `convenerBinding`.'
          : convenerBinding === 'refused'
            ? 'The CONVENER was checked against the workspace and did NOT agree, so nothing '
              + 'here confers: every grant is listed in `unattested` with the disagreement as '
              + 'its reason, and `members` is empty of anyone who needed one. Revocations and '
              + 'withdrawals still applied — refusing to confer is not deleting a record. See '
              + '`convenerBinding`.'
            : 'RESIDUAL, and it is the one left at every rung: nothing checked that the '
              + `convener named in this policy (${args.attestation.convener}) is the workspace's `
              + `convener. That is a value the caller typed, and no record was read from `
              + `<${workspace}> to confirm it, so these are the right memberships only if the `
              + 'right principal was named. Pass `workspaceEvidence`, read with '
              + 'readWorkspaceRecord in membership.ts, to close it. See `convenerBinding`.')
        // ★ ITS OWN SENTENCE, OUTSIDE THE CONVENER'S TERNARY, for the reason that one is
        // outside the field-binding ternary: they are different questions off the same record,
        // and a reader told only about the convener has been told nothing about the document
        // that decided every capability printed below.
        + (roleProfileBinding === 'bound'
          ? ` The ROLE PROFILE was checked against the workspace: <${workspace}> declares `
            + `<${profile.profile}>, which is the profile these capabilities were computed `
            + 'from. Residual: what was compared is an IRI. The profile DOCUMENT is not fetched '
            + 'here — this fold is pure — so the role table itself is still the caller\'s, and '
            + '`bound` means it claims to be the declared profile rather than that it is. See '
            + '`roleProfileBinding`.'
          : roleProfileBinding === 'refused'
            ? ' The ROLE PROFILE was checked against the workspace and did NOT agree, so '
              + 'nothing here confers: every grant is listed in `unattested`, and `members` is '
              + 'empty of anyone who needed one. The profile decides what every role permits, '
              + 'so a roster folded against governance the workspace never declared would '
              + 'report capabilities nobody published. Revocations and withdrawals still '
              + 'applied — refusing to confer is not deleting a record. See '
              + '`roleProfileBinding`.'
            : ' RESIDUAL, alongside the convener and for the same reason: nothing checked that '
              + `the role profile this fold used (${profile.profile}) is the one <${workspace}> `
              + 'declares. It is a document the caller chose, and every capability above was '
              + 'computed from it. Pass `workspaceEvidence` to close it — the same record '
              + 'carries both. See `roleProfileBinding`.')
        // ★ AND A THIRD SENTENCE, BECAUSE THE TWO ABOVE BOTH READ OFF ONE RECORD AND NEITHER
        // SAYS WHERE THAT RECORD CAME FROM. A reader told the convener and the profile were
        // checked has been told nothing about whether the document both answers came out of is
        // the one the workspace answers with — which is the whole of residual gap 9.
        + (evidenceProvenanceBinding === 'bound'
          ? ' The EVIDENCE ITSELF was checked: the record above was obtained by dereferencing '
            + `<${workspace}> and is the document that dereference resolved to, so the two `
            + 'answers came off the workspace\'s own record rather than off a record somebody '
            + 'chose. Residual: this fold is pure and fetches nothing, so that pair is the '
            + 'CALLER\'S statement — worth what its producer is worth. See '
            + '`evidenceProvenanceBinding`.'
          : evidenceProvenanceBinding === 'refused'
            ? ' The EVIDENCE ITSELF was checked and is NOT what this workspace dereferences to, '
              + 'so nothing here confers: every grant is listed in `unattested`. Revocations '
              + 'and withdrawals still applied. See `evidenceProvenanceBinding`.'
            : ' RESIDUAL, and it is the one the two sentences above rest on: the workspace '
              + 'record they read was found at a descriptor URL whoever assembled this fold '
              + 'chose. Anybody may publish a wsp:Workspace for anybody\'s workspace IRI on '
              + 'their own pod — measured live, and the fold admitted its author as convener — '
              + `so a record that agrees about <${workspace}> is not yet the record `
              + `<${workspace}> returns. Read it with dereferenceWorkspaceRecord in `
              + 'membership.ts and pass `requireEvidenceProvenance` to close it. See '
              + '`evidenceProvenanceBinding`.')
        // ★ AND A FOURTH SENTENCE, BECAUSE THE THREE ABOVE ARE ALL ABOUT ONE RECORD AND NONE OF
        // THEM IS ABOUT THE DOCUMENT THAT DECIDES WHAT A ROLE PERMITS. The profile sentence
        // says an IRI matched; this says whether anybody read what is behind it. It also
        // carries the GRADE in words, because `roleTableBinding` is a three-valued enum and the
        // difference between a signed pod record and a TLS fetch of a static file is not
        // expressible in it — and the profile this repo publishes can only ever be the second.
        + (roleTableBinding === 'bound'
          ? ' The ROLE TABLE was read from the document it claims: '
            + `<${profile.profile}> was dereferenced, and the roles it declares are role for `
            + 'role and capability for capability the roles these capabilities were computed '
            + `from. That document was obtained ${roleTableGrade}. Residual: this fold is pure `
            + 'and fetched nothing, so that is the caller\'s statement about a read it '
            + 'performed. See `roleTableBinding`.'
          : roleTableBinding === 'refused'
            ? ' The ROLE TABLE was read from the document it claims and did NOT match, so '
              + 'nothing here confers: every grant is listed in `unattested`, and `members` is '
              + 'empty of anyone who needed one. The document decides what every role permits, '
              + 'so a roster folded against a table nobody published would report capabilities '
              + 'nobody published. Revocations and withdrawals still applied — refusing to '
              + 'confer is not deleting a record. See `roleTableBinding`.'
            : ' RESIDUAL, and it is the one under the profile sentence above: nothing read the '
              + `document <${profile.profile}> names. What was compared there is an IRI; the `
              + 'role TABLE behind it is this fold\'s own, and every capability above was '
              + 'computed from it, so a table claiming the declared IRI over an invented set of '
              + 'permits reports exactly this roster. Read it with dereferenceRoleProfile in '
              + 'membership.ts and pass `roleTableEvidence` to close it. See '
              + '`roleTableBinding`.')
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
    // Same rule again, and the reason it is a THIRD field rather than a value folded into
    // either of the two above: those report what was established about the RECORDS, and this
    // reports what was established about the POLICY. A roster can be `bound`/`bound`/
    // `unchecked` — every record perfectly parsed, and no evidence at all that the party they
    // came from was entitled to grant here.
    convenerBinding,
    // A FOURTH, off the same record as the third and reporting the other half of it. Folded
    // into `convenerBinding` it would make "the workspace disagrees about who convenes" and
    // "the workspace disagrees about what a role permits" the same value, and they are
    // repaired differently.
    roleProfileBinding,
    // A FIFTH, and it is not a third reading of the same record — it is the question of whether
    // that record is the right one at all. The two above can both be `'bound'` over a document
    // a stranger published for this workspace IRI on their own pod, which is what residual gap
    // 9 was; this reports whether anybody asked.
    evidenceProvenanceBinding,
    // A SIXTH, and the first that is not about the workspace record at all. The four above can
    // every one of them be `'bound'` over a fold whose `#Observer` permits `grant` and `revoke`,
    // because they compare a convener, an IRI and a descriptor URL and never the role table
    // those IRIs name. That was residual gap 10; this reports whether anybody read it.
    roleTableBinding,
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
