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
import {
  ContextDescriptor,
  publish,
  discover,
  type IRI,
} from '../../src/index.js';
import {
  mintAtom,
  resolveAtomValue,
  createPGSL,
} from '../../src/pgsl/lattice.js';
import type { PGSLInstance } from '../../src/pgsl/types.js';
import {
  commit, verifyCommitment,
  proveConfidenceAboveThreshold, verifyConfidenceProof,
  buildMerkleTree, generateMerkleProof, verifyMerkleProof,
} from '../../src/crypto/zk/proofs.js';
import {
  proposeAmendment, vote, tryRatify, communityModal,
  type Amendment, type Tier, type RatificationRule, DEFAULT_RULES,
} from '../../src/constitutional/index.js';
import type { ModalValue } from '../../src/model/derivation.js';
import { Wallet, verifyMessage } from 'ethers';

const POD_URL = process.env.INTEREGO_DEFAULT_POD_URL;
const AGENT_DID = (process.env.INTEREGO_DEFAULT_AGENT_DID ?? 'did:web:demo-agent.example') as IRI;
if (!POD_URL) {
  console.error('ERROR: set INTEREGO_DEFAULT_POD_URL before starting interego-bridge');
  process.exit(1);
}
const POD_URL_NN: string = POD_URL;

const PORT = parseInt(process.env.PORT ?? '6050', 10);
const DEPLOYMENT_URL = process.env.BRIDGE_DEPLOYMENT_URL ?? `http://localhost:${PORT}`;

// Demo-scoped state (per-process; in-memory).
const pgslLattice: PGSLInstance = createPGSL();
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
  const descId = (args.descriptor_id ?? `urn:cg:demo:desc:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) as IRI;
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
  const result = await publish(descriptor, args.graph_content, POD_URL_NN);

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
  const entries = await discover(POD_URL_NN, undefined);
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
    confidence: e.confidence ?? null,
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
  const { commitment, blinding } = commit(args.value);
  return { ok: true, commitment, blinding };
}

function handleZkVerifyCommitment(args: { commitment: { commitment: string; algorithm?: string }; value: string; blinding: string }): unknown {
  // Accept either the raw commitment string or the wrapper object the
  // commit() function returned. Coerce to the Commitment shape.
  const c = typeof args.commitment === 'string'
    ? { commitment: args.commitment, algorithm: 'sha256-blake2b' as const }
    : { commitment: args.commitment.commitment, algorithm: (args.commitment.algorithm ?? 'sha256-blake2b') as 'sha256-blake2b' };
  return { ok: verifyCommitment(c, args.value, args.blinding) };
}

function handleZkProveConfidence(args: { confidence: number; threshold: number; descriptor_iri?: string }): unknown {
  const proof = proveConfidenceAboveThreshold(
    args.confidence,
    args.threshold,
    (args.descriptor_iri ?? `urn:cg:demo:zk-confidence:${Date.now()}`) as IRI,
  );
  return { ok: true, proof };
}

function handleZkVerifyConfidence(args: { proof: unknown }): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ok: verifyConfidenceProof(args.proof as any) };
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
  const id = (args.amendment_id ?? `urn:cg:amendment:demo:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`) as IRI;
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
  const tree = buildMerkleTree(args.values);
  const proof = generateMerkleProof(tree, args.index);
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
        descriptor_id: { type: 'string', description: 'Optional descriptor IRI (default auto-generated urn:cg:demo:desc:...).' },
        supersedes: { type: 'array', items: { type: 'string' }, description: 'IRIs of prior descriptors this one supersedes (cg:supersedes).' },
        ground_truth: { type: 'boolean', description: 'Optional ground-truth marker (must agree with modal_status: Asserted⇒true, Counterfactual⇒false, Hypothetical⇒unset).' },
        conforms_to: { type: 'array', items: { type: 'string' }, description: 'IRIs of regulatory or normative frameworks this descriptor evidences (dct:conformsTo). Used by compliance demos to filter by regulatory lens.' },
      },
      required: ['graph_iri', 'graph_content'],
    },
    handler: (a) => handlePublish(a as unknown as PublishArgs),
  },
  'protocol.discover_descriptors': {
    description: 'List descriptor manifest entries on the pod. Filter by cg:describes IRI and/or by dct:conformsTo IRI prefix (the latter is how regulators query their own framework lens).',
    inputSchema: {
      type: 'object',
      properties: {
        describes_iri: { type: 'string', description: 'Filter to descriptors whose cg:describes contains this IRI.' },
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
    description: 'Range proof: prove confidence ≥ threshold without revealing the exact value.',
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
    description: 'Verify a confidence-above-threshold range proof.',
    inputSchema: { type: 'object', properties: { proof: { type: 'object' } }, required: ['proof'] },
    handler: (a) => handleZkVerifyConfidence(a as { proof: unknown }),
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
};

// ── Express server ─────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '50mb' }));

app.post('/mcp', async (req: Request, res: Response) => {
  const body = req.body as { jsonrpc?: string; id?: number | string | null; method?: string; params?: Record<string, unknown> };
  const { id = null, method, params } = body;

  if (method === 'initialize') {
    res.json({
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'interego-bridge-demo', version: '0.1.0' },
        instructions: `Generic protocol-level Interego bridge. Pod: ${POD_URL_NN}. Agent: ${AGENT_DID}. Exposes ${Object.keys(tools).length} tools across publish/discover, PGSL, ZK, and constitutional layers.`,
      },
    });
    return;
  }
  if (method === 'tools/list') {
    res.json({
      jsonrpc: '2.0', id,
      result: {
        tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
      },
    });
    return;
  }
  if (method === 'tools/call') {
    const toolName = params?.['name'] as string | undefined;
    const args = (params?.['arguments'] as Record<string, unknown> | undefined) ?? {};
    const tool = toolName ? tools[toolName] : undefined;
    if (!tool) {
      res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName ?? '<undefined>'}` } });
      return;
    }
    try {
      const result = await tool.handler(args);
      res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] } });
    } catch (err) {
      res.json({ jsonrpc: '2.0', id, error: { code: -32000, message: (err as Error).message } });
    }
    return;
  }
  if (method === 'notifications/initialized') {
    res.status(204).end();
    return;
  }
  res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown method: ${method ?? '<undefined>'}` } });
});

app.get('/affordances', (_req, res) => {
  // Minimal Turtle stub so the readiness probe in agent-lib's spawnBridge
  // shape works. Demos that need actual affordance discovery against this
  // bridge can rely on tools/list via MCP.
  res.type('text/turtle').send(`@prefix cg: <https://markjspivey-xwisee.github.io/context-graphs/ns#> .
<${DEPLOYMENT_URL}/affordances> a cg:AffordanceManifest ;
  cg:provides "${Object.keys(tools).length} tools — see /mcp tools/list" .
`);
});

app.get('/', (_req, res) => {
  res.json({
    bridge: 'interego-bridge-demo',
    pod: POD_URL_NN,
    agent: AGENT_DID,
    walletAddress: wallet?.address ?? null,
    toolCount: Object.keys(tools).length,
    tools: Object.keys(tools),
    mcpEndpoint: `${DEPLOYMENT_URL}/mcp`,
  });
});

app.listen(PORT, () => {
  console.log(`interego-bridge on http://localhost:${PORT}`);
  console.log(`  pod:  ${POD_URL_NN}`);
  console.log(`  did:  ${AGENT_DID}`);
  console.log(`  tools: ${Object.keys(tools).length}`);
});
