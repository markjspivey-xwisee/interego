/**
 * @module affordance/compute
 * @description Affordance computation engine.
 *
 * Computes effective affordances as the intersection of:
 *   - Environment capabilities (what the resource provides)
 *   - Agent effectivities (what the agent can do)
 *   - Context constraints (what the facets permit)
 *   - Trust evaluation (what the trust chain warrants)
 *
 * Each affordance is a relational property (Gibson) expressed
 * as an interventional query P(Y|do(X)) (Pearl rung 2).
 */

import type { ContextDescriptorData, ContextFacetData, IRI, TrustLevel } from '../model/types.js';
import { DEFAULT_EPISTEMIC_CONFIDENCE } from '../model/types.js';
import type {
  AffordanceAction,
  AgentCapability,
  AffordanceReason,
  Affordance,
  AntiAffordance,
  AffordanceSet,
  Signifier,
  AgentProfile,
  TrustPolicy,
  TrustEvaluation,
  TrustEvidence,
  SituationalAwarenessLevel,
} from './types.js';

// ── All possible actions ─────────────────────────────────────

const ALL_ACTIONS: readonly AffordanceAction[] = [
  'read', 'apply', 'compose', 'cite', 'forward',
  'challenge', 'retract', 'annotate', 'ingest',
  'derive', 'intervene', 'project', 'subscribe', 'ignore',
] as const;

// ── Scope → permitted actions mapping ────────────────────────

const SCOPE_PERMISSIONS: Record<string, readonly AffordanceAction[]> = {
  ReadWrite: ['read', 'apply', 'compose', 'cite', 'forward', 'challenge', 'retract', 'annotate', 'ingest', 'derive', 'intervene', 'project', 'subscribe', 'ignore'],
  ReadOnly: ['read', 'cite', 'ingest', 'subscribe', 'ignore'],
  PublishOnly: ['read', 'apply', 'compose', 'derive', 'ingest', 'ignore'],
  DiscoverOnly: ['read', 'cite', 'subscribe', 'ignore'],
};

// ── Capability → required actions mapping ────────────────────

// Typed as AgentCapability rather than `string[]`: the loose type forced an `as any` at
// every `capabilities.includes(c)` below, and it also let a typo in this table through —
// a misspelt requirement would simply never be satisfiable by any agent, blocking the
// action with the message "Agent lacks capability: <typo>" and no other symptom.
const CAPABILITY_REQUIREMENTS: Partial<Record<AffordanceAction, readonly AgentCapability[]>> = {
  compose: ['compose'],
  intervene: ['causal'],
  ingest: ['pgsl'],
  project: ['project'],
  subscribe: ['subscribe'],
  challenge: ['challenge', 'publish'],
  retract: ['retract'],
  // verify is an internal operation, not in AffordanceAction
};

// ── Main computation ─────────────────────────────────────────

/**
 * Compute the full affordance set for an agent-descriptor pair.
 * This is the core Gibson relation: Affordance(agent, environment).
 */
export function computeAffordances(
  agent: AgentProfile,
  descriptor: ContextDescriptorData,
  /**
   * What the CALLER checked for itself about this descriptor — see {@link TrustEvidence}.
   *
   * ★ OPTIONAL, AND ABSENCE IS THE SAFE SIDE, exactly as `Seat.basis` is optional for
   * hand-built rosters and reads as `'unestablished'` when missing. Omitting it does not
   * mean "trust the body"; it means the trust verdict is capped at `SelfAsserted`, so a
   * caller that cannot check anything still gets every affordance an honestly self-asserted
   * descriptor affords and none that require a rung it did not establish.
   */
  evidence?: TrustEvidence,
): AffordanceSet {
  const affordances: Affordance[] = [];
  const antiAffordances: AntiAffordance[] = [];
  const signifiers: Signifier[] = [];

  // Extract facet data for evaluation
  const facetMap = buildFacetMap(descriptor);

  // ★ COMPUTED ONCE, HERE, AND HANDED DOWN. `evaluateTrustPolicy` is not given the Trust
  // facet at all — see its signature for why that omission is the fix rather than a tidy-up.
  const trustVerdict = evaluateTrust(descriptor, evidence);

  // Build signifiers from facets (Norman)
  for (const facet of descriptor.facets) {
    signifiers.push(...extractSignifiers(facet));
  }

  // Evaluate each action
  for (const action of ALL_ACTIONS) {
    const reasons: AffordanceReason[] = [];
    let blocked = false;
    let blockReason = '';
    let blockSource = '';
    let overridable = false;

    // 1. Delegation scope check
    const permitted = SCOPE_PERMISSIONS[agent.delegationScope] ?? [];
    if (!permitted.includes(action)) {
      blocked = true;
      blockReason = `Action '${action}' not permitted for scope '${agent.delegationScope}'`;
      blockSource = 'delegation';
      reasons.push({
        facet: 'delegation',
        constraint: `scope includes '${action}'`,
        satisfied: false,
        detail: blockReason,
      });
    } else {
      reasons.push({
        facet: 'delegation',
        constraint: `scope includes '${action}'`,
        satisfied: true,
      });
    }

    // 2. Capability check
    const required = CAPABILITY_REQUIREMENTS[action];
    if (required && !blocked) {
      const hasAll = required.every(c => agent.capabilities.includes(c));
      if (!hasAll) {
        blocked = true;
        blockReason = `Agent lacks capability: ${required.filter(c => !agent.capabilities.includes(c)).join(', ')}`;
        blockSource = 'capability';
        overridable = true; // capabilities could be acquired
      }
      reasons.push({
        facet: 'capability',
        constraint: `agent has ${required.join(', ')}`,
        satisfied: hasAll,
        detail: hasAll ? undefined : blockReason,
      });
    }

    // 3. Trust policy check
    if (!blocked) {
      const trustResult = evaluateTrustPolicy(agent.trustPolicies, action, trustVerdict, facetMap);
      if (!trustResult.satisfied) {
        blocked = true;
        blockReason = trustResult.reason;
        blockSource = 'trust';
        overridable = true;
      }
      reasons.push({
        facet: 'trust',
        constraint: trustResult.constraint,
        satisfied: trustResult.satisfied,
        detail: trustResult.reason,
      });
    }

    // 4. Semiotic check (modal status constraints)
    if (!blocked) {
      const semioticResult = evaluateSemioticConstraint(action, facetMap);
      if (!semioticResult.satisfied) {
        blocked = true;
        blockReason = semioticResult.reason;
        blockSource = 'semiotic';
        overridable = true;
      }
      reasons.push({
        facet: 'semiotic',
        constraint: semioticResult.constraint,
        satisfied: semioticResult.satisfied,
        detail: semioticResult.reason,
      });
    }

    // 5. Vocabulary check (for 'apply' and 'compose')
    if (!blocked && (action === 'apply' || action === 'compose' || action === 'project')) {
      const vocabResult = evaluateVocabularyAccess(agent, facetMap);
      reasons.push({
        facet: 'vocabulary',
        constraint: 'agent understands descriptor vocabulary',
        satisfied: vocabResult.accessible,
        detail: vocabResult.detail,
      });
      if (!vocabResult.accessible && action !== 'project') {
        blocked = true;
        blockReason = vocabResult.detail;
        blockSource = 'vocabulary';
        overridable = true; // could add projection capability
      }
    }

    // Compute confidence
    const confidence = blocked ? 0 : computeActionConfidence(action, facetMap, reasons);

    if (blocked) {
      antiAffordances.push({
        action,
        blockedBy: blockSource,
        reason: blockReason,
        overridable,
      });
    }

    affordances.push({
      action,
      available: !blocked,
      confidence,
      reasons,
    });
  }

  // Build SA level
  const saLevel = buildSALevel(descriptor, affordances, facetMap);

  return {
    agent: agent.agentId,
    descriptor: descriptor.id,
    timestamp: new Date().toISOString(),
    affordances,
    antiAffordances,
    signifiers,
    saLevel,
  };
}

// ── Facet extraction ─────────────────────────────────────────

interface FacetMap {
  temporal?: ContextFacetData & { type: 'Temporal' };
  provenance?: ContextFacetData & { type: 'Provenance' };
  agent?: ContextFacetData & { type: 'Agent' };
  semiotic?: ContextFacetData & { type: 'Semiotic' };
  trust?: ContextFacetData & { type: 'Trust' };
  federation?: ContextFacetData & { type: 'Federation' };
  causal?: ContextFacetData & { type: 'Causal' };
  projection?: ContextFacetData & { type: 'Projection' };
  accessControl?: ContextFacetData & { type: 'AccessControl' };
}

/**
 * Dispatched on the discriminant rather than by lower-casing `facet.type` and writing
 * through `(map as any)[key]`, which is what this replaces. That string was never checked
 * against `keyof FacetMap`: a new facet type, or a rename of an existing one, computed a
 * key belonging to no slot, assigned it, and left every reader of the intended slot seeing
 * `undefined` — an affordance silently losing a constraint, with nothing red anywhere. The
 * `satisfies never` on the default branch is the part that earns this: it turns "a
 * ContextTypeName exists with no slot here" into a compile error at the point of addition.
 */
function buildFacetMap(descriptor: ContextDescriptorData): FacetMap {
  const map: { -readonly [K in keyof FacetMap]: FacetMap[K] } = {};
  for (const facet of descriptor.facets) {
    switch (facet.type) {
      case 'Temporal': map.temporal = facet; break;
      case 'Provenance': map.provenance = facet; break;
      case 'Agent': map.agent = facet; break;
      case 'AccessControl': map.accessControl = facet; break;
      case 'Semiotic': map.semiotic = facet; break;
      case 'Trust': map.trust = facet; break;
      case 'Federation': map.federation = facet; break;
      case 'Causal': map.causal = facet; break;
      case 'Projection': map.projection = facet; break;
      default: void (facet satisfies never);
    }
  }
  return map;
}

// ── Trust verdict: what the READER established ───────────────

/**
 * The rungs, weakest first. `rankOf` is the only thing that reads it.
 */
const TRUST_LADDER: readonly TrustLevel[] = ['SelfAsserted', 'ThirdPartyAttested', 'CryptographicallyVerified'];

/**
 * Position on the ladder, or -1 for "no rung at all" — which is what BOTH a missing level
 * and a string that is not a rung answer.
 *
 * ★ -1 IS BELOW EVERY RUNG, WHICH IS FAIL-CLOSED FOR A `>= required` COMPARISON and
 * fail-OPEN for a `<= ceiling` one. `evaluateTrustPolicy` asks the first question, so an
 * unrecognised level refuses there. `place` asks the second — "is the claim at or under
 * what the evidence supports" — and -1 passes it, which is exactly how an off-ladder claim
 * came to outrank a checked one: `rankOf('Wizard') <= rankOf('SelfAsserted')` is `-1 <= 0`,
 * so the claim survived as the warranted level and every `=== 'SelfAsserted'` reader
 * downstream (the surprise heuristic) then failed open. That is why `place` asks
 * {@link onLadder} FIRST and never lets -1 stand in for "at most".
 */
function rankOf(level: TrustLevel | undefined): number {
  return level === undefined ? -1 : TRUST_LADDER.indexOf(level);
}

/**
 * Is this a rung this engine actually knows?
 *
 * ★ THE TYPE DOES NOT ANSWER THIS, WHICH IS THE WHOLE REASON THE FUNCTION EXISTS.
 * `TrustLevel` is a closed union, but nothing converts at the boundary: `rdf/jsonld.ts`
 * casts `iep:trustLevel` straight out of a fetched body, and `as IRI` on a literal only
 * widens a branded string back to `string` rather than checking it — `tests/abac.test.ts`
 * really did put `HighAssurance` and `PeerAttested` into a Trust facet that way. So a
 * publisher can serve `iep:trustLevel "Wizard"` and it arrives here typed as a rung.
 */
function onLadder(level: TrustLevel | undefined): level is TrustLevel {
  return level !== undefined && TRUST_LADDER.includes(level);
}

/**
 * A verdict under construction. It has the two facts read off the descriptor and NONE of the
 * four fields that constitute the verdict — `trustLevel`, `basis`, `verified`, `confidence`.
 */
interface TrustDraft {
  readonly source: IRI;
  readonly claimedTrustLevel: TrustLevel | undefined;
}

/**
 * A verdict that has been through {@link place}, which is the only way one is built.
 *
 * ★ THE CLASSIFICATION IS NON-OMITTABLE BY TYPE, borrowed wholesale from `Seat.basis` in
 * `@interego/workspace-client`, where a draft row reaches the roster only through
 * `place(row, basis)` so a bare `push` will not compile. Same enforcement, same reason: the
 * old `evaluateTrust` had four return paths and each computed `verified` and `confidence`
 * for itself off the publisher's string. One constructor means there is exactly one place
 * where a verdict can be wrong, and a new return path cannot quietly invent a fifth rule.
 *
 * ★ AND THE EVIDENCE TRAVELS WITH THE CLASSIFICATION rather than being a second field
 * somebody remembers: a verdict that says checks were run carries what they found, so a
 * consumer asking "on what?" never has to trust the basis word alone.
 */
type WarrantedTrust = TrustEvaluation & (
  // ★ `'unwarranted'` IS THE ONE BASIS THAT MAY NOT CARRY EVIDENCE, because the word means
  // "nothing reached this reader". `'no-claim'` may: a descriptor can omit the Trust facet
  // and still have had its proof checked, and throwing that finding away is how an omitted
  // facet came to silence a refutation.
  | { readonly basis: 'unwarranted'; readonly evidence?: undefined }
  | { readonly basis: 'no-claim'; readonly evidence?: TrustEvidence }
  | { readonly basis: 'evidence-checked' | 'evidence-refuted'; readonly evidence: TrustEvidence }
);

/**
 * The one constructor of a {@link TrustEvaluation}. Takes the basis as an argument, and
 * takes the reader's findings in the same tuple as the word `'evidence'`, so a caller
 * cannot claim to have checked something without producing it.
 */
function place(
  draft: TrustDraft,
  ...basis: ['no-claim', TrustEvidence?] | ['unwarranted'] | ['evidence', TrustEvidence]
): WarrantedTrust {
  const lastVerified = new Date().toISOString();
  const claimed = draft.claimedTrustLevel;
  const claimText = claimed ?? 'unset';
  const evidence = basis[1];
  const checkedBy = evidence?.checkedBy ? ` (checked by ${evidence.checkedBy})` : '';

  // ★★ THE REFUTATION IS TESTED BEFORE THE NO-CLAIM SHORTCUT, AND THE ORDER IS THE FIX.
  // This branch used to sit AFTER an early `if (basis[0] === 'no-claim') return …`, so a
  // reader's own negative finding was discarded for any descriptor that simply left the
  // Trust facet out: `verdict.evidence` came back undefined, the note said nothing about
  // the refutation, and a policy with `allowMissingTrustFacet` then granted `cite` and
  // `apply` on a record whose proof this reader had refuted — while the same evidence
  // against a descriptor that DID carry a Trust facet refused. Whether the reader's finding
  // counted was decided by a facet the publisher chooses to include. Tested first, the
  // omission cannot silence it, whichever word the caller passed.
  if (evidence?.ceiling === 'refuted') {
    // ★ AFFIRMATIVE EVIDENCE AGAINST IS NOT THE SAME AS NO EVIDENCE, and it must not land on
    // the same rung. `'refuted'` means a check COMPARED TWO THINGS AND THEY DISAGREED: a
    // signature that did not verify against the payload it is signed over, or a content
    // digest recomputed over the served bytes that differs from the digest the signer
    // committed to. Demoting that to `SelfAsserted` would say "nobody but the subject stands
    // behind this", which is a description of ordinary honest content, said about a record
    // the reader has positive reason to distrust. No rung is warranted, so it refuses every
    // policy including the weakest.
    //
    // ★ WHICH IS WHY REACHING THIS BRANCH IS NARROW ON PURPOSE — it refuses even `read`, so
    // anything that lands here by accident is a denial of service on honest content. Two
    // kinds of `authorshipVerified: false` deliberately do NOT reach it and are `unwarranted`
    // instead: a verifier that threw and compared nothing, and a proof whose signature is
    // intact but which does not name this record (the relay's own `authorshipVerdict` calls
    // that withholding the attestation, "rather than naming a forger"). A descriptor with no
    // proof at all never reaches it either, because a reader with nothing to check supplies
    // no evidence. See {@link trustEvidenceFromAuthorship} for how the three are told apart.
    return {
      source: draft.source,
      trustLevel: undefined,
      claimedTrustLevel: claimed,
      basis: 'evidence-refuted',
      evidence,
      verified: false,
      lastVerified,
      confidence: 0,
      warrantNote: `A check this reader ran refuted the descriptor's proof, so no trust level is warranted `
        + `(the descriptor claims '${claimText}')${checkedBy}.`,
    };
  }

  if (basis[0] === 'no-claim') {
    // No Trust facet is not a positive assertion of the weakest rung, so it warrants no rung
    // and no confidence — unchanged from before this type existed.
    //
    // ★ THE READER'S FINDINGS ARE CARRIED HERE EVEN THOUGH THEY WARRANT NOTHING. Evidence is
    // a CEILING: it can hold a claim down and it cannot stand in for one, so a verified
    // signature over a descriptor that makes no trust claim still warrants no rung — a reader
    // does not get to assert a level on the publisher's behalf. But dropping the evidence
    // from the verdict left a consumer unable to see that anything had been checked at all,
    // and that silence is what made an omitted facet look like a way to discard a finding.
    return {
      source: draft.source,
      trustLevel: undefined,
      claimedTrustLevel: undefined,
      basis: 'no-claim',
      ...(evidence ? { evidence } : {}),
      verified: false,
      lastVerified,
      confidence: 0,
      warrantNote: evidence
        ? `The descriptor carries no Trust facet, so it makes no trust claim to warrant; this `
          + `reader's checks support '${evidence.ceiling}'${checkedBy}, which caps a claim rather `
          + `than making one.`
        : 'The descriptor carries no Trust facet, so it makes no trust claim to warrant.',
    };
  }

  // ★ SelfAsserted IS THE CEILING WHEN NOTHING WAS CHECKED, AND THE REASON IS NOT CAUTION.
  // It is the only rung on this ladder that is a claim about the PUBLISHER ITSELF — "nobody
  // but the subject stands behind this" is a thing a subject is entitled to say about its own
  // bytes, and it is exactly what an unchecked reading establishes. The two rungs above it are
  // claims about somebody ELSE's act: that a third party attested, or that a signature
  // verifies. A reader who has not checked that act has been TOLD about it, not shown it.
  //
  // ★ WHICH IS WHY THIS DOES NOT BREAK THE HONEST PATH. Content that says `SelfAsserted` —
  // the great majority of what is published, and a supported state rather than an error —
  // scores exactly what it scored before this existed: rung `SelfAsserted`, `verified: false`,
  // confidence 0.7, and every policy that accepted it still accepts it. Only descriptors that
  // claimed MORE than the reader can see move, and they move to where their own evidence puts
  // them.
  const ceiling: TrustLevel = evidence ? evidence.ceiling : 'SelfAsserted';
  // ★★ AN OFF-LADDER CLAIM WARRANTS NO RUNG — IT MUST NOT OUTRANK, AND IT DOES NOT SILENTLY
  // BECOME `SelfAsserted` EITHER. This line used to be `rankOf(claimed) <= rankOf(ceiling) ?
  // claimed : ceiling`, and `rankOf` answers -1 for a word that is not a rung, so `-1 <= 0`
  // KEPT the claim: a descriptor serving `iep:trustLevel "Wizard"` came out of here with
  // `trustLevel: 'Wizard'`, above a checked `SelfAsserted`, and every downstream reader
  // written as `=== 'SelfAsserted'` — `evaluateSurprise`'s factor 3 — then failed open, so
  // the adversary's record was assimilated where the honest one was not. The publisher's
  // string was still the switch, one word away from the spelling this whole change closed.
  // `undefined` is the honest answer: the facet asserts something, and it is not a rung this
  // engine can warrant, so there is nothing to warrant. It refuses every policy (`rankOf`
  // answers -1 against a `>= required` test) and it is not `'no-claim'`, so
  // `allowMissingTrustFacet` does not excuse it either.
  const warranted: TrustLevel | undefined = onLadder(claimed)
    ? (rankOf(claimed) <= rankOf(ceiling) ? claimed : ceiling)
    : undefined;
  // True exactly for the off-ladder case: something was claimed and no rung came back. A
  // Trust facet carrying an issuer but no level answers `false` here — nothing was claimed.
  const unrecognisedClaim = claimed !== undefined && warranted === undefined;
  const demoted = rankOf(warranted) < rankOf(claimed);

  const note = unrecognisedClaim
    ? `The descriptor's Trust facet claims '${claimText}', which is not a rung on this ladder `
      + `(${TRUST_LADDER.join(', ')}), so no trust level is warranted.`
    : basis[0] === 'unwarranted'
      ? (demoted
        ? `The descriptor claims '${claimText}' and this reader checked nothing, so the claim is `
          + `capped at 'SelfAsserted' — the only rung a publisher can establish about its own bytes.`
        : `The descriptor claims '${claimText}' and nothing above self-assertion was checked.`)
      : (demoted
        ? `The descriptor claims '${claimText}'; this reader's checks support at most '${ceiling}'${checkedBy}.`
        : `This reader's checks support '${ceiling}'${checkedBy}; the descriptor claims '${claimText}'.`);

  return {
    source: draft.source,
    trustLevel: warranted,
    claimedTrustLevel: claimed,
    // Two shapes land here with `warranted === undefined` — a Trust facet carrying an issuer
    // but no level, and one whose level is off the ladder. In both the facet EXISTS, so this
    // is not `'no-claim'` and a policy's `allowMissingTrustFacet` must not excuse it, and
    // there is no rung to warrant. `rankOf` answers -1 against `>= required` and it refuses.
    ...(evidence ? { basis: 'evidence-checked' as const, evidence } : { basis: 'unwarranted' as const }),
    // ★ THE LINE THAT CLOSES THE FORGERY. It reads the WARRANTED rung, never the claim, so
    // `iep:trustLevel "CryptographicallyVerified"` typed into a descriptor on a pod the
    // adversary controls answers `false` — the value it always should have answered.
    verified: warranted === 'CryptographicallyVerified',
    lastVerified,
    // Same ladder as before, keyed on the warranted rung instead of the claimed one. A
    // levelless facet now scores 0 rather than 0.7, which also settles a disagreement that
    // was already here: `evaluateTrustPolicy` has always ranked that case -1 and refused it
    // while `evaluateTrust` handed back 0.7, and the two were describing the same descriptor.
    confidence: warranted === 'CryptographicallyVerified' ? 1.0
      : warranted === 'ThirdPartyAttested' ? 0.85
      : warranted === 'SelfAsserted' ? 0.7
      : 0,
    warrantNote: note,
  };
}

/**
 * What a reader is warranted in believing about a descriptor's trust claim.
 *
 * ★★ NO RUNG ABOVE `SelfAsserted` IS REACHABLE EXCEPT THROUGH `evidence`. That is the
 * invariant, and it is narrower than the sentence that used to stand here — "the verdict is
 * a function of `evidence`, not of the descriptor" — which was not true of this function on
 * any path. The verdict is `min(claim, ceiling)`: the DESCRIPTOR supplies the claim and can
 * only ever LOWER the result, `evidence` supplies the ceiling, and with no evidence the
 * ceiling is `SelfAsserted`. So an unchecked `CryptographicallyVerified` is reported as the
 * self-assertion it is, and a publisher can still choose to claim LESS than a reader
 * established. See {@link TrustEvaluation} for the forgery this closes.
 *
 * ★ EVIDENCE IS CONSULTED WHETHER OR NOT THERE IS A TRUST FACET. The no-facet case used to
 * return before evidence was looked at, which let a publisher discard a reader's refutation
 * by omitting the facet; `place` now decides, and it tests the refutation first.
 */
export function evaluateTrust(
  descriptor: ContextDescriptorData,
  evidence?: TrustEvidence,
): TrustEvaluation {
  const facets = buildFacetMap(descriptor);
  const source = facets.provenance?.wasAttributedTo ?? ('unknown' as IRI);
  const draft: TrustDraft = { source, claimedTrustLevel: facets.trust?.trustLevel };
  if (!facets.trust) return evidence ? place(draft, 'no-claim', evidence) : place(draft, 'no-claim');
  return evidence ? place(draft, 'evidence', evidence) : place(draft, 'unwarranted');
}

/**
 * Reasons on an `authorshipVerified: false` block that are a VERIFICATION VERDICT — a check
 * that ran, compared two things, and found them different — rather than a report that the
 * check could not be made.
 *
 * ★ THE LIST IS AN ALLOW-LIST AND EVERYTHING ELSE FAILS SAFE, which is the direction that
 * matters: an unrecognised reason lands as "nothing established" (capped at `SelfAsserted`),
 * never as evidence against a publisher. Both strings are the relay's own, produced by
 * `verifySignedAuthorship` in `packages/core/src/model/delegation.ts` and passed through
 * `authorshipVerdict`; if either is ever reworded, this degrades to "not refuted" rather
 * than to a false accusation. Prose is a weak hinge and it is deliberately hung the safe way
 * round — the alternative, treating every `false` as a verdict, is the defect being fixed.
 */
const REFUTING_REASON_PREFIXES: readonly string[] = [
  // The recovered signer did not match the proof's own signer address: the payload and the
  // signature disagree.
  'Authorship proof signature did not verify',
  // The digest recomputed over the served bytes differs from the digest the signer committed
  // to. Also reported structurally as `contentBinding: 'mismatched'`; listed here so the
  // refutation survives a caller that maps the reason and drops the binding.
  'Authorship proof covers content',
];

/**
 * ★ `startsWith`, NEVER `includes`, AND THE DIFFERENCE IS EXPLOITABLE. The relay's
 * could-not-run reasons embed a thrown Error's message verbatim — `verifier threw: <message>`
 * — and an error message can carry text that came from a remote pod. A prefix test can only
 * be satisfied by the relay's own opening words; a substring test could be satisfied by
 * anything a publisher got into an exception, which would let a publisher forge a refutation
 * of somebody else's record.
 */
function reasonIsVerificationVerdict(reason: string | undefined): boolean {
  if (typeof reason !== 'string') return false;
  return REFUTING_REASON_PREFIXES.some(prefix => reason.startsWith(prefix));
}

/**
 * Map the relay's `get_descriptor` authorship block onto {@link TrustEvidence}.
 *
 * ★ THE HONEST PATH IN ONE CALL, so no consumer computes a ceiling by hand and no two
 * consumers compute it differently. The relay derives that block by re-running
 * `verifySignedAuthorship` over the bytes it served and walking the delegation chain from
 * the serving pod's agent registry; `effectiveTrustLevel` is its answer, and it is
 * `CryptographicallyVerified` only when BOTH the proof and the chain verified.
 *
 * ★ A MISSING BLOCK RETURNS `undefined`, NOT A REFUTATION, and the distinction matters.
 * `get_descriptor` emits no authorship object at all for a descriptor that carries no proof —
 * fail-ABSENT, not fail-open — and "there was nothing to check" must land as `'unwarranted'`,
 * not as evidence against.
 *
 * ★★ `authorshipVerified: false` IS NOT ONE ANSWER, AND MAPPING ALL OF IT TO `'refuted'` WAS
 * THE SAME DEFECT CLASS AS THE ONE THIS FILE EXISTS TO CLOSE — an unestablished read treated
 * as an authoritative one, this time aimed at an honest publisher. The relay emits that
 * `false` from two code sites in `deploy/mcp-relay/server.ts` (get_descriptor's authorship
 * block, the `else` and the `catch`), for four distinct reasons:
 *
 *   1. the signature did not verify against its canonical payload      → a verdict: REFUTED
 *   2. the signed content digest differs from the bytes served         → a verdict: REFUTED
 *      (`contentBinding: 'mismatched'` — structural, no prose needed)
 *   3. the signature is intact but the proof does not name this record → NOT a verdict
 *   4. the verifier THREW and compared nothing at all                  → NOT a verdict
 *      (two spellings: `verifySignedAuthorship` catches its own throw and reports
 *      `Authorship verifier threw: …`, the relay catches everything outside it and reports
 *      `verifier threw: …`; neither is on the allow-list, which is the whole point)
 *
 * 3 is the relay's own `authorshipVerdict` withholding the attestation — its comment says in
 * so many words that two readings fit and it "withholds the attestation rather than naming a
 * forger", so reading it as an accusation here would contradict the layer that produced it.
 * 4 is a bad moment on the relay, which says nothing whatever about the publisher. Both were
 * landing as `'evidence-refuted'`, which warrants no rung and refuses even `read` — so an
 * honest descriptor became unreadable because a verifier crashed, while the SAME descriptor
 * with no authorship block at all stayed readable. That is a denial of service keyed on a
 * read failure.
 *
 * 3 and 4 now return `undefined`: nothing was established, so nothing is reported, and the
 * verdict lands at `'unwarranted'` — capped at `SelfAsserted`, exactly where an unchecked
 * record sits. The cost is honest and worth stating: a reader cannot tell from the verdict
 * that a check was ATTEMPTED, because this layer will not report an attempt as a finding.
 */
export function trustEvidenceFromAuthorship(
  authorship: {
    readonly authorshipVerified?: boolean;
    readonly effectiveTrustLevel?: string;
    readonly signedBy?: string;
    readonly contentBinding?: string;
    /**
     * The relay's diagnostic on a `false` block. Read ONLY to tell a verification verdict
     * from a check that could not run — see {@link REFUTING_REASON_PREFIXES} — and absence
     * is the safe side: a block with no reason is never a refutation.
     */
    readonly reason?: string;
  } | null | undefined,
  checkedBy = 'relay get_descriptor',
): TrustEvidence | undefined {
  if (!authorship) return undefined;
  if (authorship.authorshipVerified !== true) {
    // ★ A REFUTATION NEEDS A COMPARISON THAT ACTUALLY HAPPENED. `'mismatched'` is that
    // comparison stated structurally — `ContentBinding` documents it as "the digest WAS
    // recomputed over the payload served and did NOT match", the sharpest evidence of
    // tampering the substrate produces — and the reason allow-list is the same statement in
    // prose for a signature that failed before any content was reached. Anything else is a
    // relay that could not answer, and this returns nothing rather than answering for it.
    const refuted = authorship.contentBinding === 'mismatched'
      || reasonIsVerificationVerdict(authorship.reason);
    if (!refuted) return undefined;
    return {
      ceiling: 'refuted',
      authorshipVerified: false,
      ...(authorship.signedBy ? { signedBy: authorship.signedBy as IRI } : {}),
      ...(authorship.contentBinding ? { contentBinding: authorship.contentBinding as TrustEvidence['contentBinding'] } : {}),
      checkedBy,
    };
  }
  // A verified proof whose chain did NOT reach `CryptographicallyVerified` establishes that
  // some key signed this record and named it — real, and still not somebody else vouching for
  // the signer. `SelfAsserted` is where that lands.
  const effective = authorship.effectiveTrustLevel;
  const ceiling: TrustLevel = effective === 'CryptographicallyVerified' ? 'CryptographicallyVerified'
    : effective === 'ThirdPartyAttested' ? 'ThirdPartyAttested'
    : 'SelfAsserted';
  return {
    ceiling,
    authorshipVerified: true,
    ...(authorship.signedBy ? { signedBy: authorship.signedBy as IRI } : {}),
    ...(authorship.contentBinding ? { contentBinding: authorship.contentBinding as TrustEvidence['contentBinding'] } : {}),
    checkedBy,
  };
}

// ── Trust policy evaluation ──────────────────────────────────

/**
 * ★★ THIS FUNCTION IS NOT GIVEN THE TRUST FACET, AND THE OMISSION IS THE FIX. It used to
 * take `facets` and rank `facets.trust.trustLevel` — publisher-authored text — against
 * `policy.minTrustLevel`. It now receives a {@link TrustEvaluation} that has already been
 * through {@link place}, and `facets` is still passed only because the CONFIDENCE half of a
 * policy reads the Semiotic facet. Structuring it this way means a future edit cannot
 * reintroduce the claim-keyed comparison by accident: there is no Trust facet in scope to
 * reintroduce it from.
 */
function evaluateTrustPolicy(
  policies: readonly TrustPolicy[],
  action: AffordanceAction,
  verdict: TrustEvaluation,
  facets: FacetMap,
): { satisfied: boolean; constraint: string; reason: string } {
  const semioticFacet = facets.semiotic;

  for (const policy of policies) {
    if (!policy.requiredForAction.includes(action)) continue;

    // Check trust level. Absence of a Trust facet is semantically distinct
    // from a positive 'SelfAsserted' assertion; by default it fails any
    // minTrustLevel unless the policy opts in via allowMissingTrustFacet.
    if (verdict.basis === 'no-claim') {
      if (!policy.allowMissingTrustFacet) {
        return {
          satisfied: false,
          constraint: `trust >= ${policy.minTrustLevel} for '${action}'`,
          reason: `No Trust facet present; policy requires at least '${policy.minTrustLevel}'`,
        };
      }
    } else {
      const actualIdx = rankOf(verdict.trustLevel);
      const requiredIdx = rankOf(policy.minTrustLevel);

      if (actualIdx < requiredIdx) {
        // ★ THE REFUSAL NAMES THE GAP WHENEVER THERE IS ONE. A reader told only "trust
        // level 'SelfAsserted' below required 'CryptographicallyVerified'" about a
        // descriptor whose body says `CryptographicallyVerified` will go looking for a bug
        // in this function. The gap between the claim and the warrant is the ANSWER, not a
        // detail, so it is printed rather than left to be rediscovered.
        //
        // The condition is "the warrant is not the claim" rather than "the claim was
        // demoted", because rank arithmetic cannot see the two cases that need the note
        // most: an off-ladder claim and a refutation both rank -1, the same as no claim at
        // all, so a `rankOf(warranted) < rankOf(claimed)` test stayed silent about them.
        const unexplained = verdict.trustLevel === verdict.claimedTrustLevel
          && verdict.basis !== 'evidence-refuted';
        return {
          satisfied: false,
          constraint: `trust >= ${policy.minTrustLevel} for '${action}'`,
          reason: `Trust level '${verdict.trustLevel ?? 'unset'}' below required '${policy.minTrustLevel}'`
            + (unexplained ? '' : `. ${verdict.warrantNote}`),
        };
      }
    }

    // Check confidence
    const confidence = semioticFacet?.epistemicConfidence ?? DEFAULT_EPISTEMIC_CONFIDENCE;
    if (confidence < policy.minConfidence) {
      return {
        satisfied: false,
        constraint: `confidence >= ${policy.minConfidence} for '${action}'`,
        reason: `Confidence ${confidence} below required ${policy.minConfidence}`,
      };
    }
  }

  return {
    satisfied: true,
    constraint: 'trust policy met',
    reason: '',
  };
}

// ── Semiotic constraint evaluation ───────────────────────────

function evaluateSemioticConstraint(
  action: AffordanceAction,
  facets: FacetMap,
): { satisfied: boolean; constraint: string; reason: string } {
  const semiotic = facets.semiotic;
  if (!semiotic) {
    return { satisfied: true, constraint: 'no semiotic facet', reason: '' };
  }

  const modalStatus = semiotic.modalStatus ?? 'Asserted';

  // Retracted descriptors anti-afford everything except 'read' and 'ignore'
  if (modalStatus === 'Retracted' && !['read', 'ignore', 'cite'].includes(action)) {
    return {
      satisfied: false,
      constraint: `modal status permits '${action}'`,
      reason: `Descriptor is Retracted — cannot ${action}`,
    };
  }

  // Hypothetical descriptors require caution for 'apply' and 'forward'
  if (modalStatus === 'Hypothetical' && (action === 'apply' || action === 'forward')) {
    const confidence = semiotic.epistemicConfidence ?? DEFAULT_EPISTEMIC_CONFIDENCE;
    if (confidence < 0.8) {
      return {
        satisfied: false,
        constraint: `Hypothetical with confidence >= 0.8 for '${action}'`,
        reason: `Hypothetical descriptor at ${confidence} confidence — too uncertain to ${action}`,
      };
    }
  }

  // Counterfactual descriptors anti-afford 'apply' (they describe what didn't happen)
  if (modalStatus === 'Counterfactual' && action === 'apply') {
    return {
      satisfied: false,
      constraint: `Counterfactual cannot be applied directly`,
      reason: `Counterfactual descriptors describe unrealized states — use 'compose' or 'cite' instead`,
    };
  }

  return { satisfied: true, constraint: `modal status '${modalStatus}' permits '${action}'`, reason: '' };
}

// ── Vocabulary access evaluation ─────────────────────────────

function evaluateVocabularyAccess(
  agent: AgentProfile,
  facets: FacetMap,
): { accessible: boolean; detail: string } {
  const projection = facets.projection;

  // If there's a projection facet with vocabulary mappings, check if agent knows the target
  if (projection?.vocabularyMappings) {
    return { accessible: true, detail: 'Projection facet provides vocabulary mapping' };
  }

  // If agent has 'project' capability, it can attempt translation
  if (agent.capabilities.includes('project')) {
    return { accessible: true, detail: 'Agent has projection capability' };
  }

  // Default: assume accessible (vocabulary mismatch is detected at runtime)
  return { accessible: true, detail: 'Vocabulary compatibility assumed' };
}

// ── Confidence computation ───────────────────────────────────

function computeActionConfidence(
  action: AffordanceAction,
  facets: FacetMap,
  reasons: readonly AffordanceReason[],
): number {
  let confidence = 1.0;

  // Factor in epistemic confidence
  const semiotic = facets.semiotic;
  if (semiotic?.epistemicConfidence !== undefined) {
    confidence *= semiotic.epistemicConfidence;
  }

  // Factor in trust level
  const trust = facets.trust;
  if (trust?.trustLevel) {
    const trustMultipliers: Record<string, number> = {
      CryptographicallyVerified: 1.0,
      ThirdPartyAttested: 0.85,
      SelfAsserted: 0.7,
    };
    confidence *= trustMultipliers[trust.trustLevel] ?? 0.5;
  }

  // Actions that modify state have lower base confidence
  const modifyActions: AffordanceAction[] = ['apply', 'compose', 'forward', 'derive', 'intervene'];
  if (modifyActions.includes(action)) {
    confidence *= 0.95; // slight penalty for consequential actions
  }

  // Factor in reason satisfaction rate
  const satisfiedRatio = reasons.filter(r => r.satisfied).length / Math.max(reasons.length, 1);
  confidence *= satisfiedRatio;

  return Math.round(confidence * 1000) / 1000;
}

// ── Signifier extraction (Norman) ────────────────────────────

function extractSignifiers(facet: ContextFacetData): Signifier[] {
  const signifiers: Signifier[] = [];

  switch (facet.type) {
    case 'Semiotic': {
      // `switch (facet.type)` has already narrowed the union; the `as any` this replaces
      // threw that narrowing away and left `f.modalStatus` unchecked against ModalStatus.
      const f = facet;
      const modal = f.modalStatus ?? 'Asserted';
      const conf = f.epistemicConfidence ?? DEFAULT_EPISTEMIC_CONFIDENCE;
      signifiers.push({
        facetType: 'Semiotic',
        indicates: modal === 'Asserted' ? ['apply', 'compose', 'forward'] :
                   modal === 'Hypothetical' ? ['compose', 'cite', 'challenge'] :
                   modal === 'Counterfactual' ? ['cite', 'compose'] :
                   ['read', 'ignore'],
        strength: conf > 0.8 ? 'strong' : conf > 0.5 ? 'weak' : 'ambiguous',
        detail: `${modal} at ${conf} confidence`,
      });
      break;
    }
    case 'Trust': {
      const f = facet;
      signifiers.push({
        facetType: 'Trust',
        indicates: f.trustLevel === 'CryptographicallyVerified'
          ? ['apply', 'forward', 'compose']
          : f.trustLevel === 'ThirdPartyAttested'
          ? ['apply', 'compose', 'cite']
          : ['read', 'cite', 'ingest'],
        strength: f.trustLevel === 'CryptographicallyVerified' ? 'strong' :
                  f.trustLevel === 'ThirdPartyAttested' ? 'weak' : 'ambiguous',
        detail: `Trust: ${f.trustLevel}`,
      });
      break;
    }
    case 'Causal': {
      signifiers.push({
        facetType: 'Causal',
        indicates: ['intervene', 'compose', 'derive'],
        strength: 'strong',
        detail: 'Causal model available — interventional reasoning afforded',
      });
      break;
    }
    case 'Federation': {
      signifiers.push({
        facetType: 'Federation',
        indicates: ['subscribe', 'forward'],
        strength: 'strong',
        detail: 'Federation metadata — subscription and forwarding afforded',
      });
      break;
    }
    case 'Projection': {
      signifiers.push({
        facetType: 'Projection',
        indicates: ['project', 'compose', 'apply'],
        strength: 'strong',
        detail: 'Vocabulary projection available',
      });
      break;
    }
  }

  return signifiers;
}

// ── Situational Awareness level (Endsley) ────────────────────

function buildSALevel(
  descriptor: ContextDescriptorData,
  affordances: readonly Affordance[],
  facets: FacetMap,
): SituationalAwarenessLevel {
  const available = affordances.filter(a => a.available);

  return {
    level1_perception: {
      descriptorsDiscovered: 1,
      podsScanned: facets.federation ? 1 : 0,
      facetTypesObserved: descriptor.facets.map(f => f.type),
      coverageGaps: descriptor.facets.length < 3
        ? ['Limited facet coverage — may be missing context']
        : [],
    },
    level2_comprehension: {
      trustEvaluated: facets.trust ? 1 : 0,
      vocabularyMapped: facets.projection ? 1 : 0,
      causalModelsResolved: facets.causal ? 1 : 0,
      conflictsDetected: 0,
      coherenceScore: available.length / Math.max(affordances.length, 1),
    },
    level3_projection: {
      anticipatedChanges: [],
      projectedAffordances: available,
      // `||`, not `??`, on purpose: the two `as any` reads this replaces were joined by a
      // TRUTHINESS ternary, so an empty-string validUntil produced 'indefinite'. `??` would
      // have quietly started emitting `''` as a time horizon. Cast removed, semantics kept.
      timeHorizon: facets.temporal?.validUntil || 'indefinite',
      projectionConfidence: available.reduce((sum, a) => sum + a.confidence, 0) / Math.max(available.length, 1),
    },
  };
}

// ═════════════════════════════════════════════════════════════
//  Query Comprehension Strategy (bridges question → affordance)
// ═════════════════════════════════════════════════════════════
//
// `computeCognitiveStrategy` + the `CognitiveStrategy` type used to live
// in this file. They depend on PGSL retrieval primitives
// (`classifyQuestion`, `extractEntities`, `shouldAbstain`), so they were
// moved out with the rest of PGSL — see `@interego/pgsl`'s
// `cognitive-strategy` module. The substrate affordance engine remains
// here.
