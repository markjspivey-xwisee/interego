/**
 * demos/interego-bridge — generic protocol-level bridge for the demo suite.
 *
 * Exposes the Interego protocol's universal primitives as MCP tools over
 * HTTP, mirroring the per-vertical bridge shape used by Demos 01-04 so
 * the demo harness can drive them uniformly.
 *
 *   protocol.publish_descriptor   — write a typed descriptor to a pod
 *   protocol.discover_descriptors — list manifest entries (filter by graph_iri)
 *   protocol.get_descriptor       — fetch a descriptor's Turtle + parsed facets
 *   protocol.list_manifest        — full manifest contents
 *   protocol.pgsl_mint_atom       — content-address a value into a sequence
 *   protocol.pgsl_meet            — categorical pullback of two PGSL sequences
 *   protocol.zk_commit            — Pedersen-style commitment
 *   protocol.zk_verify_commitment — verify a commitment opens to a value
 *   protocol.zk_prove_confidence  — range proof: confidence ≥ threshold
 *   protocol.zk_verify_confidence — verify a confidence range proof
 *   protocol.constitutional_propose
 *   protocol.constitutional_vote
 *   protocol.constitutional_ratify
 *
 * NOT a production deployment — the production generic surface is the
 * stdio mcp-server/ at the repo root. This bridge exists solely so demos
 * 5-14 can drive headless `claude -p` instances against a uniform HTTP
 * MCP surface (claude CLI's `--mcp-config type:"http"` makes parallel
 * agent processes much easier than wrangling stdio).
 */

import express, { type Request, type Response } from 'express';
// NOTE: this bridge was written against the pre-`packages/` root `src/` layout,
// which no longer exists. Migrated to the @interego/* workspace packages — the
// SAME canonical substrate logic the production surfaces (mcp-server, mcp-relay)
// consume. No new substrate; pure re-pointing.
import {
  ContextDescriptor,
  type IRI,
  commit, verifyCommitment, zkCommit,
  randomBlinding, proveRange, verifyRange,
  type PedersenCommitment, type PedersenRangeProof,
  proveConfidenceAboveThreshold, verifyConfidenceProof, verifyConfidenceProofByReveal,
  buildMerkleTree, generateMerkleProof, verifyMerkleProof,
  protocolMembersOnly, acceptForSdkTransport,
} from '@interego/core';
import {
  createMcpHandler,
  isLegacyRequest,
  ProtocolError as McpProtocolError,
  Server as McpSdkServer,
  WebStandardStreamableHTTPServerTransport,
} from '@modelcontextprotocol/server';
import type { Tool as McpTool } from '@modelcontextprotocol/server';
import { publish, discover } from '@interego/solid';
import { mintAtom, resolveAtomValue, createPGSL } from '@interego/pgsl';
import type { PGSLInstance } from '@interego/pgsl';
import {
  proposeAmendment, vote, tryRatify, communityModal, forkConstitution,
  type Amendment, type Tier, type RatificationRule, DEFAULT_RULES,
} from '@interego/constitutional';
import type { ModalValue } from '@interego/core';
import { Wallet, verifyMessage, sha256 as ethersSha256 } from 'ethers';

const POD_URL = process.env.INTEREGO_DEFAULT_POD_URL;
const AGENT_DID = (process.env.INTEREGO_DEFAULT_AGENT_DID ?? 'did:web:demo-agent.example') as IRI;
// POD_URL is only needed by the descriptor publish/discover tools. The marquee
// substrate demos (governance, PGSL atom fusion, ZK, sign-bound attestation) are
// pod-free, so the bridge boots without a pod and only those tools degrade.
if (!POD_URL) console.warn('INTEREGO_DEFAULT_POD_URL unset — descriptor publish/discover disabled; governance / pgsl / zk / attest still work.');
const POD_URL_NN: string = POD_URL ?? '(pod not configured)';

/**
 * Refuse a pod-backed tool when no pod is configured — the way the WALLET path
 * already does it.
 *
 * Without this, `POD_URL_NN` ("(pod not configured)") was handed to the publish /
 * discover machinery as if it were a URL, and the caller got back a Node internal:
 *   The "string" argument must be of type string or an instance of Buffer…
 * A caller cannot act on that. They cannot even tell it is a CONFIGURATION problem
 * rather than a bug in their request.
 *
 * The wallet guard one screen down already says exactly the right thing —
 * "Bridge has no wallet — set BRIDGE_WALLET_KEY to enable signing" — so the fix is
 * simply to be as honest about the pod as this file already is about the wallet.
 */
function requirePod(): string {
  if (!POD_URL) {
    throw new Error(
      'Bridge has no pod — set INTEREGO_DEFAULT_POD_URL to enable descriptor publish/discover. '
      + 'The governance, PGSL, ZK and attestation tools do not need one and work as-is.');
  }
  return POD_URL;
}

const PORT = parseInt(process.env.PORT ?? '6050', 10);
const DEPLOYMENT_URL = process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`;

// Demo-scoped state (per-process; in-memory).
const pgslLattice: PGSLInstance = createPGSL({ wasAttributedTo: 'did:web:interego-bridge' as IRI, generatedAtTime: new Date().toISOString() });
// Amendments-in-flight keyed by amendment IRI.
const amendments: Map<string, Amendment> = new Map();

// Optional wallet — when BRIDGE_WALLET_KEY is set, the bridge can sign
// messages on behalf of its operator. The address is exposed via /status
// so other agents can verify signatures originating from this bridge.
const wallet: Wallet | null = process.env['BRIDGE_WALLET_KEY']
  ? new Wallet(process.env['BRIDGE_WALLET_KEY'])
  : null;

// ── Tool handlers ─────────────────────────────────────────────

interface PublishArgs {
  graph_iri: string;
  graph_content: string;
  modal_status?: 'Asserted' | 'Hypothetical' | 'Counterfactual';
  confidence?: number;
  descriptor_id?: string;
  supersedes?: string[];
  ground_truth?: boolean;
  conforms_to?: string[];
}

async function handlePublish(args: PublishArgs): Promise<Record<string, unknown>> {
  const now = new Date().toISOString();
  const descId = (args.descriptor_id ?? `urn:iep:demo:desc:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) as IRI;
  const modal = args.modal_status ?? 'Asserted';

  const builder = ContextDescriptor.create(descId)
    .describes(args.graph_iri as IRI)
    .temporal({ validFrom: now })
    .validFrom(now)
    .delegatedBy(AGENT_DID, AGENT_DID, { endedAt: now })
    .trust({ trustLevel: 'SelfAsserted', issuer: AGENT_DID })
    .federation({ origin: POD_URL_NN as IRI, storageEndpoint: POD_URL_NN as IRI, syncProtocol: 'SolidNotifications' })
    .version(1);

  const semioticOpts: { modalStatus: 'Asserted' | 'Hypothetical' | 'Counterfactual'; epistemicConfidence?: number; groundTruth?: boolean } = { modalStatus: modal };
  if (args.confidence !== undefined) semioticOpts.epistemicConfidence = args.confidence;
  if (modal === 'Asserted') semioticOpts.groundTruth = true;
  else if (modal === 'Counterfactual') semioticOpts.groundTruth = false;
  // Hypothetical leaves groundTruth undefined per the modal-truth consistency rule
  if (args.ground_truth !== undefined && modal !== 'Hypothetical') semioticOpts.groundTruth = args.ground_truth;
  builder.semiotic(semioticOpts);

  if (args.supersedes && args.supersedes.length > 0) {
    builder.supersedes(...(args.supersedes as IRI[]));
  }
  if (args.conforms_to && args.conforms_to.length > 0) {
    builder.conformsTo(...(args.conforms_to as IRI[]));
  }

  const descriptor = builder.build();
  const result = await publish(descriptor, args.graph_content, requirePod());

  return {
    ok: true,
    descriptor_url: result.descriptorUrl,
    descriptor_id: descId,
    graph_url: result.graphUrl,
    manifest_url: result.manifestUrl,
    modal_status: modal,
    supersedes: args.supersedes ?? [],
  };
}

async function handleDiscover(args: { describes_iri?: string; conforms_to_prefix?: string }): Promise<unknown> {
  const entries = await discover(requirePod(), undefined);
  let filtered = args.describes_iri
    ? entries.filter(e => e.describes.some(d => d === args.describes_iri))
    : entries;
  if (args.conforms_to_prefix) {
    const prefix = args.conforms_to_prefix;
    filtered = filtered.filter(e => (e.conformsTo ?? []).some(c => c.startsWith(prefix)));
  }
  return filtered.map(e => ({
    descriptor_url: e.descriptorUrl,
    describes: e.describes,
    modal_status: e.modalStatus ?? null,
    confidence: (e as { confidence?: number }).confidence ?? null,
    valid_from: e.validFrom ?? null,
    supersedes: e.supersedes ?? [],
    conforms_to: e.conformsTo ?? [],
    facet_types: e.facetTypes ?? [],
  }));
}

async function handleGetDescriptor(args: { descriptor_url: string }): Promise<unknown> {
  const r = await fetch(args.descriptor_url, { headers: { Accept: 'text/turtle' } });
  if (!r.ok) return { ok: false, status: r.status, statusText: r.statusText };
  const turtle = await r.text();
  return { ok: true, turtle };
}

async function handlePgslMint(args: { value: string }): Promise<unknown> {
  // Atoms are content-addressed: identical input → identical IRI. Two
  // independent agents who observed the same event produce the same
  // atom IRI, which is exactly what makes the meet operator structural
  // rather than negotiated.
  const iri = mintAtom(pgslLattice, args.value);
  return { ok: true, atom_iri: iri, value: args.value };
}

async function handlePgslMeet(args: { atom_iris_a: string[]; atom_iris_b: string[] }): Promise<unknown> {
  // Categorical pullback at the atom level: the structurally-shared
  // subsequence of two ordered atom lists. Because atoms are content-
  // addressed, "shared" reduces to "same IRI appears in both," and we
  // preserve A's order. This is the level-0 (atom) projection of the
  // hierarchical PGSL pullback in src/pgsl/category.ts.
  const setB = new Set(args.atom_iris_b);
  const sharedIris = args.atom_iris_a.filter(iri => setB.has(iri));
  const shared = sharedIris.map((iri) => ({
    iri,
    value: resolveAtomValue(pgslLattice, iri as IRI),
  }));
  return {
    ok: true,
    shared_atom_count: shared.length,
    shared_atoms: shared,
    a_only_count: args.atom_iris_a.filter(iri => !setB.has(iri)).length,
    b_only_count: args.atom_iris_b.filter(iri => !args.atom_iris_a.includes(iri)).length,
  };
}

function handleZkCommit(args: { value: string }): unknown {
  // zkCommit = the hash-chain commitment ({commitment, blinding}); the bare
  // `commit` import is the Pedersen point commitment used by the range proof above.
  const { commitment, blinding } = zkCommit(args.value);
  return { ok: true, commitment, blinding };
}

function handleZkVerifyCommitment(args: { commitment: string | { commitment: string }; value: string; blinding: string }): unknown {
  // Accept either the raw commitment string or the wrapper object zkCommit()
  // returned. Coerce to the hash-chain Commitment shape ({commitment, type}).
  const raw = typeof args.commitment === 'string' ? args.commitment : args.commitment.commitment;
  const c = { commitment: raw, type: 'hash-commitment' as const };
  return { ok: verifyCommitment(c, args.value, args.blinding) };
}

function handleZkProveConfidence(args: { confidence: number; threshold: number }): unknown {
  // proveConfidenceAboveThreshold returns { proof, blinding }. The
  // blinding is the prover's witness — keep it (don't surface to the
  // verifier) unless the prover is willing to disclose for stronger
  // verification via verifyConfidenceProofByReveal.
  const out = proveConfidenceAboveThreshold(args.confidence, args.threshold);
  return { ok: true, proof: out.proof, blinding: out.blinding };
}

function handleZkVerifyConfidence(args: { proof: unknown }): unknown {
  // Chain-walk verification — verifies the prover did the work of
  // building a hash chain from threshold to leaf. Reveals the gap
  // (chain length) but not the value. See RangeProof JSDoc for the
  // honest scoping.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ok: verifyConfidenceProof(args.proof as any) };
}

function handleZkVerifyConfidenceByReveal(args: { proof: unknown; value: number; blinding: string }): unknown {
  // Stronger verification: the prover reveals (value, blinding) so the
  // verifier can confirm the leaf opens to those — equivalent in
  // strength to commit-and-reveal plus the range invariant.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ok: verifyConfidenceProofByReveal(args.proof as any, args.value, args.blinding) };
}

// GENUINE gap-hiding range proof (Pedersen + per-bit OR-proofs, ristretto255).
// Discretizes confidence to integer percent, commits with a fresh blinding, and
// proves value ∈ [threshold%, 100] WITHOUT revealing the value OR the gap above the
// threshold — strictly stronger than the hash-chain threshold proof above (which
// leaks value−threshold). The blinding (witness) is never returned. The commitment +
// proof are plain JSON and round-trip over the wire for independent verification.
function handleRangeProveConfidence(args: { confidence: number; threshold: number }): unknown {
  const value = BigInt(Math.max(0, Math.min(100, Math.round(args.confidence * 100))));
  const min = BigInt(Math.max(0, Math.min(100, Math.round(args.threshold * 100))));
  const max = 100n;
  if (value < min) return { ok: false, error: `confidence ${args.confidence} is below threshold ${args.threshold}` };
  const blinding = randomBlinding();
  const commitment = commit(value, blinding);
  const proof = proveRange({ commitment, value, blinding, min, max });
  return { ok: true, commitment, proof, scheme: 'ristretto255-pedersen-bit-decomposition', min: Number(min) / 100, max: Number(max) / 100 };
}

function handleRangeVerifyConfidence(args: { commitment: PedersenCommitment; proof: PedersenRangeProof }): unknown {
  if (!args?.commitment || !args?.proof) return { ok: false, error: 'commitment + proof required' };
  return { ok: verifyRange({ commitment: args.commitment, proof: args.proof }) };
}

// ── Constitutional ─────────────────────────────────────────────
//
// The src/constitutional API treats amendments as independent objects:
// proposeAmendment → Amendment, vote(amendment, ...) mutates votes,
// tryRatify(amendment, rules?, now?) decides the outcome. There's no
// global "Constitution" object — the constitution is implicit in the
// chain of ratified amendments. We maintain an in-memory map keyed by
// amendment IRI so multiple agents can find each other's proposals.

function handleConstPropose(args: {
  amendment_id?: string;
  amends: string;       // policy IRI being amended
  tier: Tier;           // 0..4
  proposer_did: string;
  diff_summary: string;
  added_rules?: string[];
  removed_rules?: string[];
}): unknown {
  const id = (args.amendment_id ?? `urn:iep:amendment:demo:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) as IRI;
  const amendment = proposeAmendment({
    id,
    proposedBy: args.proposer_did as IRI,
    amends: args.amends as IRI,
    tier: args.tier,
    diff: {
      summary: args.diff_summary,
      addedRules: args.added_rules,
      removedRules: args.removed_rules,
    },
  });
  amendments.set(id, amendment);
  return { ok: true, amendment };
}

function handleConstVote(args: {
  amendment_id: string;
  voter_did: string;
  modal_status: ModalValue; // 'Asserted' = for, 'Counterfactual' = against, 'Hypothetical' = abstain
  weight?: number;
}): unknown {
  const a = amendments.get(args.amendment_id);
  if (!a) return { ok: false, error: `unknown amendment: ${args.amendment_id}` };
  const updated = vote(a, args.voter_did as IRI, args.modal_status, args.weight);
  return { ok: true, amendment: updated, vote_count: updated.votes.length, community_modal: communityModal(updated) };
}

function handleConstRatify(args: {
  amendment_id: string;
  override_rules?: { minQuorum?: number; threshold?: number; coolingPeriodDays?: number };
  now_iso?: string;
}): unknown {
  const a = amendments.get(args.amendment_id);
  if (!a) return { ok: false, error: `unknown amendment: ${args.amendment_id}` };
  let rules: RatificationRule | undefined;
  if (args.override_rules) {
    const base = DEFAULT_RULES[a.tier];
    rules = {
      minQuorum: args.override_rules.minQuorum ?? base.minQuorum,
      threshold: args.override_rules.threshold ?? base.threshold,
      coolingPeriodDays: args.override_rules.coolingPeriodDays ?? base.coolingPeriodDays,
    };
  }
  const updated = tryRatify(a, rules, args.now_iso);
  return { ok: true, status: updated.status, ratified: updated.status === 'Ratified', amendment: updated };
}

function handleConstStatus(args: { amendment_id: string }): unknown {
  const a = amendments.get(args.amendment_id);
  if (!a) return { ok: false, error: `unknown amendment: ${args.amendment_id}` };
  return { ok: true, amendment: a, vote_count: a.votes.length, community_modal: communityModal(a) };
}

// ── Signature-bound substrate primitives ───────────────────────
// Recover a rev-196 signed envelope ({ _signature, _signed_payload }) where the
// signed message is `sha256:<hex(payload)>`. This is the SAME envelope the
// microsite mints from a fresh wallet. The anti-Sybil rule everywhere below:
// the recovered signer must equal the payload's claimed agent_id.
const _enc = new TextEncoder();
const _sha = (s: string) => ethersSha256(_enc.encode(s)).slice(2);
function recoverEnvelope(env: unknown): { ok: boolean; signer?: string; payload?: any } {
  try {
    const e = env as { _signature?: string; _signed_payload?: string };
    const sp = String(e?._signed_payload ?? ''); const sig = String(e?._signature ?? '');
    if (!sp || !sig) return { ok: false };
    const addr = verifyMessage(`sha256:${_sha(sp)}`, sig).toLowerCase();
    return { ok: true, signer: `did:ethr:${addr}`, payload: JSON.parse(sp) };
  } catch { return { ok: false }; }
}
const _bound = (r: { ok: boolean; signer?: string; payload?: any }) =>
  r.ok && r.signer === String(r.payload?.agent_id ?? '').toLowerCase();

// EMERGENT governance round — composes proposeAmendment ∘ vote ∘ tryRatify ∘
// communityModal ∘ forkConstitution (@interego/constitutional) + content-address
// the outcome (mintAtom) into a dereferenceable holon. A vote counts only if its
// recovered signer === claimed agent_id, so the quorum cannot be stuffed or forged.
// This is a generic substrate tool (discoverable via tools/list), NOT a per-vertical route.
function handleGovernanceRound(args: any): unknown {
  const policyId = String(args.policyId ?? 'urn:iep:policy:demo');
  const tier = ([0, 1, 2, 3, 4].includes(Number(args.tier)) ? Number(args.tier) : 3) as Tier;
  const diff = {
    summary: String(args.diff?.summary ?? 'amendment').slice(0, 400),
    ...(Array.isArray(args.diff?.addedRules) ? { addedRules: args.diff.addedRules.filter((x: unknown) => typeof x === 'string').slice(0, 16) } : {}),
  };
  const rules: RatificationRule = {
    minQuorum: Math.max(1, Math.min(99999, Number(args.rules?.minQuorum) || 3)),
    threshold: Math.max(0, Math.min(1, typeof args.rules?.threshold === 'number' ? args.rules.threshold : 0.51)),
    coolingPeriodDays: Math.max(0, Math.min(365, Number(args.rules?.coolingPeriodDays) || 0)),
  };
  const pr = recoverEnvelope(args.proposer);
  if (!pr.ok) return { ok: false, error: 'proposer signature did not verify' };
  if (!_bound(pr)) return { ok: false, error: 'proposer signer does not match claimed agent_id' };
  const amendmentId = `urn:iep:amendment:${_sha(policyId + diff.summary).slice(0, 12)}-${Date.now().toString(36)}`;
  let amendment: Amendment = proposeAmendment({ id: amendmentId as IRI, proposedBy: pr.signer as IRI, amends: policyId as IRI, tier, diff });
  const votesIn = Array.isArray(args.votes) ? args.votes.slice(0, 64) : [];
  let droppedVotes = 0; const seen = new Set<string>();
  for (const v of votesIn) {
    const vr = recoverEnvelope(v);
    if (!_bound(vr)) { droppedVotes++; continue; }
    const m = vr.payload.modalStatus;
    const ms = (m === 'Asserted' || m === 'Counterfactual' || m === 'Hypothetical') ? m : 'Hypothetical';
    amendment = vote(amendment, vr.signer as IRI, ms as ModalValue, typeof vr.payload.weight === 'number' ? vr.payload.weight : undefined);
    seen.add(vr.signer!);
  }
  amendment = tryRatify(amendment, rules);
  const cmodal = communityModal(amendment);
  const forV = amendment.votes.filter(v => v.modalStatus === 'Asserted');
  const againstV = amendment.votes.filter(v => v.modalStatus === 'Counterfactual');
  const abstainV = amendment.votes.filter(v => v.modalStatus === 'Hypothetical');
  const totalW = [...forV, ...againstV].reduce((s, v) => s + (v.weight ?? 1), 0);
  const forW = forV.reduce((s, v) => s + (v.weight ?? 1), 0);
  const tally = { for: forV.length, against: againstV.length, abstain: abstainV.length, distinctVoters: seen.size, quorum: rules.minQuorum, threshold: rules.threshold, proportion: totalW > 0 ? forW / totalW : 0 };
  let fork: unknown = null;
  if (amendment.status === 'Rejected' && args.forkOnReject) {
    fork = forkConstitution({ id: `urn:iep:fork:${Date.now().toString(36)}` as IRI, parentConstitution: policyId as IRI, dissenters: againstV.map(v => v.voter), newConstitution: { id: `${policyId}:fork` as IRI, tier, description: `Fork over: ${diff.summary}`, ratifyRule: rules }, reason: `amendment rejected (${tally.for}/${forV.length + againstV.length} for); dissenters fork` });
  }
  const outcome = { kind: 'iep:ConstitutionalAmendment', amendment, tally, communityModal: cmodal, rules, fork };
  const holonUri = mintAtom(pgslLattice, JSON.stringify(outcome));   // content-addressed, dereferenceable
  amendments.set(amendmentId, amendment);
  return { ok: true, amendment: { id: amendment.id, amends: amendment.amends, tier: amendment.tier, status: amendment.status, proposedBy: pr.signer, diff: amendment.diff, ratifiedAt: amendment.ratifiedAt, votes: amendment.votes.map(v => ({ voter: v.voter, modalStatus: v.modalStatus, weight: v.weight })) }, tally, communityModal: cmodal, droppedVotes, rules, fork, holon: { holonUri } };
}

// Generic sign-bound attestation — the L1 integrity primitive the red-team throws
// forged/tampered/replayed envelopes at. Recover → require signer===agent_id
// (defeats impersonation + tampering) → ±60s window (defeats stale replay) → mint
// the attested holon. A verbatim replay inside the window is accepted but stays
// attributed to the ORIGINAL signer (the attacker gains no identity).
function handleAttest(args: any): unknown {
  const r = recoverEnvelope(args.envelope ?? args);
  if (!r.ok) return { ok: false, status: 401, error: 'signature does not verify (recovery failed)' };
  if (!_bound(r)) return { ok: false, status: 401, error: `recovered signer ${r.signer} does not match claimed agent_id ${r.payload?.agent_id ?? '(none)'}` };
  const ts = Date.parse(String(r.payload.timestamp ?? ''));
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 60_000) return { ok: false, status: 401, error: 'timestamp drift exceeds ±60s — replay protection' };
  const holonUri = mintAtom(pgslLattice, JSON.stringify({ kind: 'iep:Attestation', by: r.signer, payload: r.payload }));
  return { ok: true, status: 200, attestedBy: r.signer, holon: { holonUri } };
}

// ── secp256k1 signing (Demo 09) ──────────────────────────────

async function handleSign(args: { message: string }): Promise<unknown> {
  if (!wallet) throw new Error('Bridge has no wallet — set BRIDGE_WALLET_KEY to enable signing');
  const signature = await wallet.signMessage(args.message);
  return { ok: true, signature, signer: wallet.address };
}

function handleVerifySignature(args: { message: string; signature: string; expected_signer?: string }): unknown {
  try {
    const recovered = verifyMessage(args.message, args.signature);
    if (args.expected_signer && recovered.toLowerCase() !== args.expected_signer.toLowerCase()) {
      return { ok: false, recovered_signer: recovered, reason: `signer mismatch: expected ${args.expected_signer}, recovered ${recovered}` };
    }
    return { ok: true, recovered_signer: recovered };
  } catch (e) {
    return { ok: false, reason: `signature invalid: ${(e as Error).message}` };
  }
}

// ── Merkle (used by some demos for delegation/membership) ────

function handleMerkleBuild(args: { values: string[] }): unknown {
  const tree = buildMerkleTree(args.values);
  return { ok: true, root: tree.root, leaves: tree.leaves.length };
}

function handleMerkleProve(args: { values: string[]; index: number }): unknown {
  // generateMerkleProof(value, values) — prove membership of the value at `index`.
  const proof = generateMerkleProof(args.values[args.index], args.values);
  return { ok: true, proof };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleMerkleVerify(args: { proof: any }): unknown {
  return { ok: verifyMerkleProof(args.proof) };
}

// ── MCP wiring ─────────────────────────────────────────────────

interface ToolDef {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => unknown | Promise<unknown>;
}

const tools: Record<string, ToolDef> = {
  'protocol.publish_descriptor': {
    description: 'Publish a typed Context Descriptor with optional semiotic facet (modal_status, confidence, ground_truth) and supersedes links. Writes both the graph and the descriptor to the configured pod and updates the manifest.',
    inputSchema: {
      type: 'object',
      properties: {
        graph_iri: { type: 'string', description: 'IRI of the named graph this descriptor describes.' },
        graph_content: { type: 'string', description: 'Turtle content of the graph.' },
        modal_status: { type: 'string', enum: ['Asserted', 'Hypothetical', 'Counterfactual'], description: 'Default Asserted.' },
        confidence: { type: 'number', minimum: 0, maximum: 1, description: 'Epistemic confidence 0..1.' },
        descriptor_id: { type: 'string', description: 'Optional descriptor IRI (default auto-generated urn:iep:demo:desc:...).' },
        supersedes: { type: 'array', items: { type: 'string' }, description: 'IRIs of prior descriptors this one supersedes (iep:supersedes).' },
        ground_truth: { type: 'boolean', description: 'Optional ground-truth marker (must agree with modal_status: Asserted⇒true, Counterfactual⇒false, Hypothetical⇒unset).' },
        conforms_to: { type: 'array', items: { type: 'string' }, description: 'IRIs of regulatory or normative frameworks this descriptor evidences (dct:conformsTo). Used by compliance demos to filter by regulatory lens.' },
      },
      required: ['graph_iri', 'graph_content'],
    },
    handler: (a) => handlePublish(a as unknown as PublishArgs),
  },
  'protocol.discover_descriptors': {
    description: 'List descriptor manifest entries on the pod. Filter by iep:describes IRI and/or by dct:conformsTo IRI prefix (the latter is how regulators query their own framework lens).',
    inputSchema: {
      type: 'object',
      properties: {
        describes_iri: { type: 'string', description: 'Filter to descriptors whose iep:describes contains this IRI.' },
        conforms_to_prefix: { type: 'string', description: 'Filter to descriptors with at least one dct:conformsTo IRI starting with this prefix (e.g., "https://markjspivey-xwisee.github.io/interego/ns/soc2#").' },
      },
    },
    handler: (a) => handleDiscover(a as { describes_iri?: string; conforms_to_prefix?: string }),
  },
  'protocol.get_descriptor': {
    description: 'Fetch a descriptor by URL and return its Turtle.',
    inputSchema: {
      type: 'object',
      properties: { descriptor_url: { type: 'string' } },
      required: ['descriptor_url'],
    },
    handler: (a) => handleGetDescriptor(a as { descriptor_url: string }),
  },
  'protocol.pgsl_mint_atom': {
    description: 'Content-address a value into the local PGSL lattice. Identical inputs produce identical IRIs — two agents who observed the same event independently mint the same atom.',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string', description: 'The atom value (any string).' },
      },
      required: ['value'],
    },
    handler: (a) => handlePgslMint(a as { value: string }),
  },
  'protocol.pgsl_meet': {
    description: 'Categorical pullback of two PGSL fragments — returns the structurally-shared subsequence (atoms common to both, in original order). The mathematical "what we both remember" operator.',
    inputSchema: {
      type: 'object',
      properties: {
        atom_iris_a: { type: 'array', items: { type: 'string' } },
        atom_iris_b: { type: 'array', items: { type: 'string' } },
      },
      required: ['atom_iris_a', 'atom_iris_b'],
    },
    handler: (a) => handlePgslMeet(a as { atom_iris_a: string[]; atom_iris_b: string[] }),
  },
  'protocol.zk_commit': {
    description: 'Pedersen-style commitment: hide a value, return commitment + blinding factor.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    handler: (a) => handleZkCommit(a as { value: string }),
  },
  'protocol.zk_verify_commitment': {
    description: 'Verify a commitment opens to a claimed (value, blinding) pair.',
    inputSchema: {
      type: 'object',
      properties: {
        commitment: { type: 'object' },
        value: { type: 'string' },
        blinding: { type: 'string' },
      },
      required: ['commitment', 'value', 'blinding'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleZkVerifyCommitment(a as any),
  },
  'protocol.zk_prove_confidence_above_threshold': {
    description: 'Threshold proof (hash-chain): proves confidence ≥ threshold. Reveals (value − threshold) — the chain length leaks how far ABOVE the threshold the value sits — but not the exact value. NOT a zero-knowledge / Pedersen-committed range proof (for gap-hiding, compose the exported Pedersen proveRange/verifyRange instead).',
    inputSchema: {
      type: 'object',
      properties: {
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        threshold: { type: 'number', minimum: 0, maximum: 1 },
        descriptor_iri: { type: 'string' },
      },
      required: ['confidence', 'threshold'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleZkProveConfidence(a as any),
  },
  'protocol.zk_verify_confidence_proof': {
    description: 'Verify a confidence-above-threshold range proof by walking its hash chain. Reveals (value − threshold) — the chain length leaks the gap above threshold — but does not reveal the value itself. For full ZK that hides the gap, use a Bulletproofs-style scheme (not implemented in @interego/core).',
    inputSchema: { type: 'object', properties: { proof: { type: 'object' } }, required: ['proof'] },
    handler: (a) => handleZkVerifyConfidence(a as { proof: unknown }),
  },
  'protocol.zk_verify_confidence_proof_by_reveal': {
    description: 'Stronger verification path: the prover reveals (value, blinding) to the verifier, who confirms the leaf opens to those AND the chain verifies. Equivalent in strength to commit-and-reveal plus the range invariant. Use when full cryptographic verification matters more than zero-knowledge and the prover is willing to disclose to a specific verifier.',
    inputSchema: {
      type: 'object',
      properties: {
        proof: { type: 'object' },
        value: { type: 'number' },
        blinding: { type: 'string' },
      },
      required: ['proof', 'value', 'blinding'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleZkVerifyConfidenceByReveal(a as any),
  },
  'protocol.zk_prove_confidence_range': {
    description: 'GENUINE gap-hiding range proof (Pedersen commitment + per-bit OR-proofs, ristretto255): proves confidence ≥ threshold without revealing the value OR the gap above the threshold. Strictly stronger than zk_prove_confidence_above_threshold (which leaks value−threshold). Returns { commitment, proof } — both plain JSON; the blinding witness is never disclosed.',
    inputSchema: {
      type: 'object',
      properties: {
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        threshold: { type: 'number', minimum: 0, maximum: 1 },
      },
      required: ['confidence', 'threshold'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleRangeProveConfidence(a as any),
  },
  'protocol.zk_verify_confidence_range': {
    description: 'Verify a gap-hiding Pedersen range proof from zk_prove_confidence_range. Confirms value ∈ [threshold, max] without learning the value or the gap. Anyone holding { commitment, proof } can verify.',
    inputSchema: {
      type: 'object',
      properties: { commitment: { type: 'object' }, proof: { type: 'object' } },
      required: ['commitment', 'proof'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleRangeVerifyConfidence(a as any),
  },
  'protocol.sign_message': {
    description: 'Sign a message with this bridge\'s wallet (secp256k1, EIP-191 personal_sign). Requires BRIDGE_WALLET_KEY env var. Returns the signature and signer address.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
    handler: (a) => handleSign(a as { message: string }),
  },
  'protocol.verify_signature': {
    description: 'Verify a secp256k1 signature over a message. If expected_signer is provided, also confirms the recovered address matches it (case-insensitive). Returns ok=false with a reason if the signature is malformed or the signer doesn\'t match.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
        signature: { type: 'string' },
        expected_signer: { type: 'string', description: 'Optional: refuse if recovered address differs from this.' },
      },
      required: ['message', 'signature'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleVerifySignature(a as any),
  },
  'protocol.merkle_build': {
    description: 'Build a Merkle tree over an ordered list of values; returns the root + leaf count.',
    inputSchema: { type: 'object', properties: { values: { type: 'array', items: { type: 'string' } } }, required: ['values'] },
    handler: (a) => handleMerkleBuild(a as { values: string[] }),
  },
  'protocol.merkle_prove': {
    description: 'Generate a Merkle inclusion proof for the value at `index`.',
    inputSchema: {
      type: 'object',
      properties: { values: { type: 'array', items: { type: 'string' } }, index: { type: 'integer' } },
      required: ['values', 'index'],
    },
    handler: (a) => handleMerkleProve(a as { values: string[]; index: number }),
  },
  'protocol.merkle_verify': {
    description: 'Verify a Merkle inclusion proof.',
    inputSchema: { type: 'object', properties: { proof: { type: 'object' } }, required: ['proof'] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleMerkleVerify(a as { proof: any }),
  },
  'protocol.constitutional_propose': {
    description: 'Propose an amendment to a constitutional policy. Tier 0-4 determines the ratification threshold (0 = bedrock/practically immutable; 4 = individual). The returned amendment IRI is what voters reference.',
    inputSchema: {
      type: 'object',
      properties: {
        amendment_id: { type: 'string', description: 'Optional IRI for the amendment (auto-generated if omitted).' },
        amends: { type: 'string', description: 'IRI of the policy being amended.' },
        tier: { type: 'integer', minimum: 0, maximum: 4, description: 'Constitutional tier (governs threshold).' },
        proposer_did: { type: 'string' },
        diff_summary: { type: 'string', description: 'Human-readable summary of the change.' },
        added_rules: { type: 'array', items: { type: 'string' } },
        removed_rules: { type: 'array', items: { type: 'string' } },
      },
      required: ['amends', 'tier', 'proposer_did', 'diff_summary'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleConstPropose(a as any),
  },
  'protocol.constitutional_vote': {
    description: 'Cast a vote on a pending amendment. modal_status: Asserted = for, Counterfactual = against, Hypothetical = abstain.',
    inputSchema: {
      type: 'object',
      properties: {
        amendment_id: { type: 'string' },
        voter_did: { type: 'string' },
        modal_status: { type: 'string', enum: ['Asserted', 'Counterfactual', 'Hypothetical'] },
        weight: { type: 'number', description: 'Optional trust-weight (default 1.0).' },
      },
      required: ['amendment_id', 'voter_did', 'modal_status'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleConstVote(a as any),
  },
  'protocol.constitutional_ratify': {
    description: 'Attempt to ratify a pending amendment. Pass override_rules to override the tier-default ratification thresholds (useful for sub-minute demos that need quorum=N and coolingPeriodDays=0).',
    inputSchema: {
      type: 'object',
      properties: {
        amendment_id: { type: 'string' },
        override_rules: {
          type: 'object',
          properties: {
            minQuorum: { type: 'integer' },
            threshold: { type: 'number' },
            coolingPeriodDays: { type: 'integer' },
          },
        },
        now_iso: { type: 'string', description: 'Optional ISO datetime to use as the ratification clock.' },
      },
      required: ['amendment_id'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleConstRatify(a as any),
  },
  'protocol.constitutional_status': {
    description: 'Report the current state of an amendment: votes, status, community-modal aggregation.',
    inputSchema: {
      type: 'object',
      properties: { amendment_id: { type: 'string' } },
      required: ['amendment_id'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleConstStatus(a as any),
  },
  'protocol.governance_round': {
    description: 'Run a complete SIGNED governance round in one call: propose an amendment, tally signed votes (each voter recovered from its rev-196 envelope; a vote counts only if the recovered signer === its claimed agent_id — anti-Sybil), ratify per the rule, fork on dissensus, and content-address the outcome as a dereferenceable holon. Composes @interego/constitutional. Each vote envelope: { _signature, _signed_payload: JSON({ amendmentId, modalStatus: Asserted|Counterfactual|Hypothetical, agent_id, timestamp }) }.',
    inputSchema: {
      type: 'object',
      properties: {
        policyId: { type: 'string' }, tier: { type: 'integer', minimum: 0, maximum: 4 },
        diff: { type: 'object', properties: { summary: { type: 'string' }, addedRules: { type: 'array', items: { type: 'string' } } } },
        proposer: { type: 'object', description: 'signed envelope of the proposing agent' },
        votes: { type: 'array', items: { type: 'object' }, description: 'array of signed vote envelopes' },
        rules: { type: 'object', properties: { minQuorum: { type: 'integer' }, threshold: { type: 'number' }, coolingPeriodDays: { type: 'integer' } } },
        forkOnReject: { type: 'boolean' },
      },
      required: ['proposer', 'votes'],
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleGovernanceRound(a as any),
  },
  'protocol.attest': {
    description: 'Generic sign-bound attestation write — the L1 integrity primitive. Recovers the signer from a rev-196 envelope, REQUIRES recovered signer === claimed agent_id (defeats impersonation + one-byte tampering), enforces a ±60s timestamp window (defeats stale replay), then content-addresses the attested payload as a holon. Returns 401 on any forged/tampered/stale envelope. A verbatim replay within the window is accepted but stays attributed to the ORIGINAL signer.',
    inputSchema: { type: 'object', properties: { envelope: { type: 'object', description: 'rev-196 signed envelope { _signature, _signed_payload }' } }, required: ['envelope'] },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handler: (a) => handleAttest(a as any),
  },
};

// ── Express server ─────────────────────────────────────────────

const app = express();

// ★ HSTS FIRST — BEFORE express.json(), and that ORDER is load-bearing.
//
// With the parser registered first, a malformed body makes body-parser throw and express
// jumps to the error handler, skipping every middleware after it: the 400 goes out with no
// header. Measured against real express (json-then-hsts -> 400 HSTS ABSENT; hsts-then-json
// -> 400 HSTS present). A smoke test always sends valid JSON, so it never walks that path.
//
// This surface exposes sign_message and the zk_* tools, and measured live 2026-08-03 it
// served no Strict-Transport-Security at all.
//
// max-age only: includeSubDomains would bind every *.interego.xwisee.com including any not
// fully on HTTPS, and preload is close to irreversible. Separate decisions.
app.use((_req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

app.use(express.json({ limit: '50mb' }));

// Build identity for tools/railway-redeploy.mjs, whose verify poll reads exactly `j.build`.
// GET /health here used to answer "Cannot GET /health", so no rollout of this service could
// be confirmed — Railway reports SUCCESS once the container binds a port, and on a tag that
// is not in the registry the OLD container keeps serving and keeps answering 200.
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', build: process.env['INTEREGO_BUILD_SHA'] ?? 'unset' });
});
// Browser-reachable substrate surface: permissive CORS. Reads + writes are
// signature-gated (rev-196 envelopes), not origin-gated — Interego's zero-trust
// stance (trust lives at the verifier, not the transport).
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  // Mcp-Method / Mcp-Name are required on protocol revision 2026-07-28; mcp-protocol-version
  // is sent by 2025-era clients. A browser cannot send a header the preflight did not allow.
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, mcp-protocol-version, Mcp-Method, Mcp-Name');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  next();
});

// ── MCP endpoint ────────────────────────────────────────────────────
//
// ★ WAS HAND-ROLLED JSON-RPC ADVERTISING A HARD-CODED `2024-11-05`. It ignored what
// the client asked for, implemented four methods, and had no version negotiation.
// Now on MCP SDK v2: one tool definition serves BOTH protocol eras — the 2025
// `initialize` handshake, and the 2026-07-28 revision, which has no handshake and
// answers `server/discover`.
//
// Same shape as the shared vertical-bridge mount, and deliberately so:
//   - the LOW-LEVEL Server, not McpServer.registerTool, so the JSON-RPC error
//     semantics this bridge's callers already parse are preserved exactly
//   - Accept is normalised, because the SDK transport 406s a client that does not
//     accept SSE and every browser client here sends no Accept header at all
//   - the body is filtered to protocol members before the SDK parses it
// The two load-bearing helpers come from @interego/core rather than being copied a
// third time — see the note on protocolMembersOnly for what a copy cost last time.
const buildMcpServer = (): McpSdkServer => {
  const server = new McpSdkServer(
    { name: 'interego-bridge-demo', version: '0.1.0' },
    {
      capabilities: { tools: {} },
      instructions: `Generic protocol-level Interego bridge. Pod: ${POD_URL_NN}. Agent: ${AGENT_DID}. Exposes ${Object.keys(tools).length} tools across publish/discover, PGSL, ZK, and constitutional layers.`,
    },
  );

  server.setRequestHandler('tools/list', async () => {
    // ★ LIST EVERY TOOL THAT EXISTS — all of them — AND SAY WHICH CANNOT RUN.
    //
    // These are two different facts and both belong here. A tool that is registered
    // but unconfigured still EXISTS: hiding it would misreport the surface, and a
    // client that later saw it appear would have no way to explain the change. But
    // listing it with no warning is how an agent picks it, calls it, and gets a
    // refusal it could have known about before spending the round trip.
    //
    // The reason rides in the description because MCP has no standard field for
    // "registered but unavailable", and a description is what a client actually
    // shows a model when it is choosing.
    const unavailable = new Map(
      toolAvailability().unavailable.map(u => [u.tool, u.reason] as const));
    return {
      tools: Object.entries(tools).map(([name, t]) => {
        const reason = unavailable.get(name);
        return {
          name,
          description: reason
            ? `[UNAVAILABLE: ${reason}] ${t.description}`
            : t.description,
          inputSchema: t.inputSchema,
          ...(reason ? { annotations: { readOnlyHint: true, unavailable: true, unavailableReason: reason } } : {}),
        };
      }),
    } as unknown as { tools: McpTool[] };
  });

  server.setRequestHandler('tools/call', async (req) => {
    const toolName = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const tool = toolName ? tools[toolName] : undefined;
    if (!tool) {
      // -32601 preserved over the SDK's own "tool not found": this bridge's callers
      // (interego-microsite, foxxi-microsite's ai-tutor) read the code.
      throw new McpProtocolError(-32601, `Unknown tool: ${toolName ?? '<undefined>'}`);
    }
    const result = await tool.handler(args);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  });

  return server;
};

const mcpModernHandler = createMcpHandler(buildMcpServer, {
  legacy: 'reject',
  responseMode: 'json',
  onerror: () => { /* per-request failures surface in the JSON-RPC response */ },
});

/** The 2025-era leg, answering plain JSON rather than SSE frames. */
const serveMcpLegacy = async (request: globalThis.Request): Promise<globalThis.Response> => {
  const server = buildMcpServer();
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    // Honoured by the v2 runtime but absent from the published types: without it the
    // transport SSE-frames every reply and every browser client here calls res.json().
    enableJsonResponse: true,
  } as unknown as ConstructorParameters<typeof WebStandardStreamableHTTPServerTransport>[0]);
  await server.connect(transport);
  return transport.handleRequest(request);
};

const handleMcp = async (req: Request, res: Response): Promise<void> => {
  try {
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') headers.set(k, v);
      else if (Array.isArray(v)) headers.set(k, v.join(', '));
    }
    headers.set('accept', acceptForSdkTransport(headers.get('accept') ?? undefined));
    const hasBody = req.method === 'POST' && req.body !== undefined;
    const request = new globalThis.Request(`http://localhost${req.originalUrl}`, {
      method: req.method,
      headers,
      ...(hasBody ? { body: JSON.stringify(protocolMembersOnly(req.body)) } : {}),
    });
    // isLegacyRequest is the SDK's OWN classifier, so this routing can never disagree
    // with what createMcpHandler would have decided.
    const out = await isLegacyRequest(request.clone())
      ? await serveMcpLegacy(request)
      : await mcpModernHandler.fetch(request);
    res.status(out.status);
    out.headers.forEach((value, key) => res.setHeader(key, value));
    res.send(await out.text());
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0', id: null,
        error: { code: -32603, message: `MCP transport error: ${(err as Error).message}` },
      });
    }
  }
};

app.post('/mcp', handleMcp);
app.get('/mcp', handleMcp);
app.delete('/mcp', handleMcp);

app.get('/affordances', (_req, res) => {
  // Minimal Turtle stub so the readiness probe in agent-lib's spawnBridge
  // shape works. Demos that need actual affordance discovery against this
  // bridge can rely on tools/list via MCP.
  res.type('text/turtle').send(`@prefix iep: <https://markjspivey-xwisee.github.io/context-graphs/ns#> .
<${DEPLOYMENT_URL}/affordances> a iep:AffordanceManifest ;
  iep:provides "${Object.keys(tools).length} tools — see /mcp tools/list" .
`);
});

/**
 * Which advertised tools this process can ACTUALLY run right now.
 *
 * The root document used to list all of them flat, with `pod: "(pod not
 * configured)"` and `walletAddress: null` sitting alongside as facts a reader was
 * left to correlate for themselves. So it advertised descriptor publishing with no
 * pod to publish to, and signing with no key to sign with — a list of things this
 * bridge would not do, which is the failure this substrate exists to avoid.
 *
 * Booting without a pod or wallet is DELIBERATE: the governance, PGSL, ZK and
 * attestation demos are genuinely pod-free and work. The defect was never the
 * degradation — it was not saying so.
 */
function toolAvailability(): {
  available: string[];
  unavailable: Array<{ tool: string; reason: string }>;
} {
  const needsPod = ['protocol.publish_descriptor', 'protocol.discover_descriptors', 'protocol.get_descriptor'];
  const needsWallet = ['protocol.sign_message', 'protocol.merkle_attest'];
  const available: string[] = [];
  const unavailable: Array<{ tool: string; reason: string }> = [];
  for (const name of Object.keys(tools)) {
    if (!POD_URL && needsPod.includes(name)) {
      unavailable.push({ tool: name, reason: 'no pod configured (INTEREGO_DEFAULT_POD_URL)' });
    } else if (!wallet && needsWallet.includes(name)) {
      unavailable.push({ tool: name, reason: 'no wallet configured (BRIDGE_WALLET_KEY)' });
    } else {
      available.push(name);
    }
  }
  return { available, unavailable };
}

app.get('/', (_req, res) => {
  const { available, unavailable } = toolAvailability();
  res.json({
    bridge: 'interego-bridge-demo',
    pod: POD_URL_NN,
    agent: AGENT_DID,
    walletAddress: wallet?.address ?? null,
    // ★ COUNT WHAT EXISTS; REPORT SEPARATELY WHAT CAN RUN.
    //
    // An earlier revision made toolCount the RUNNABLE count (19). That traded one
    // wrong number for another: 23 tools genuinely exist, and a surface reporting
    // 19 hides four of them from anyone reading the total. Worse, it disagreed with
    // the MCP tools/list on the same process — one capability described two ways
    // depending on which door you came through.
    //
    // So the total is the total, the runnable count is its own field, and the four
    // that cannot run are named with their reasons. Nothing is hidden and nothing
    // is overstated. tools/list now carries exactly the same three facts.
    toolCount: Object.keys(tools).length,
    tools: Object.keys(tools),
    runnableCount: available.length,
    // Named, with the reason, so a caller learns the boundary by reading rather
    // than by invoking and getting an error.
    unavailableTools: unavailable,
    mcpEndpoint: `${DEPLOYMENT_URL}/mcp`,
  });
});

app.listen(PORT, () => {
  console.log(`interego-bridge on http://localhost:${PORT}`);
  console.log(`  pod:  ${POD_URL_NN}`);
  console.log(`  did:  ${AGENT_DID}`);
  console.log(`  tools: ${Object.keys(tools).length}`);
});
