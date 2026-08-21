/**
 * @module model/delegation
 * @description Owner/agent delegation model for Interego 1.0
 *
 * Implements the identity layer where:
 *   - Humans (or orgs) own pods and have a WebID
 *   - AI agents are delegates — authorized to act on the owner's behalf
 *   - Delegation is expressed as an agent registry (RDF) on the pod
 *   - Verifiable Credentials provide cryptographic proof of delegation
 *   - Consumers verify the delegation chain before trusting context
 */

import type {
  IRI,
  OwnerProfileData,
  AuthorizedAgentData,
  AgentDelegationCredential,
  SignedDelegationCredential,
  DelegationProof,
  DelegationVerification,
  DelegationScope,
} from './types.js';
// Digest labels are compared, never assumed equal — see the algorithm check in
// verifySignedAuthorship for the false-forgery this import prevents.
import { digestAlgorithmOf } from '../rdf/graph-digest.js';
// The one Turtle-literal escaper.
import { escapeTurtleLiteral } from '../rdf/escape.js';

// ── Signer / Verifier injection types ───────────────────────
//
// Cryptographic primitives are injected so this module stays in the
// pure model layer (no dependency on packages/core/src/crypto, which
// itself imports from model/types). Callers wire ethers/nacl/etc.
// implementations through these tiny function shapes.

/**
 * Synchronous signing function. Given the canonical JSON payload of the
 * credential (the credential with `proof` removed, stringified with
 * stable key order), returns the signer's hex signature plus the address
 * the verifier should match. `verificationMethod` is the IRI that names
 * the key — typically `did:ethr:<addr>` or `<webId>#key-1`.
 */
export type DelegationSigner = (canonicalPayload: string) => Promise<{
  signature: string;
  signerAddress: string;
  verificationMethod: IRI;
}>;

/**
 * Synchronous verification function. Given the canonical payload that
 * was signed plus the proof block, returns true iff the signature
 * recovers an address matching `proof.signerAddress`.
 */
export type DelegationVerifier = (canonicalPayload: string, proof: DelegationProof) => Promise<boolean>;

// ── Owner Profile ────────────────────────────────────────────

/**
 * Create a new owner profile.
 */
export function createOwnerProfile(
  webId: IRI,
  name?: string,
  agents?: AuthorizedAgentData[],
): OwnerProfileData {
  return {
    webId,
    name,
    authorizedAgents: Object.freeze(agents ?? []),
  };
}

/**
 * Add an authorized agent to an owner profile (returns new profile).
 */
export function addAuthorizedAgent(
  profile: OwnerProfileData,
  agent: AuthorizedAgentData,
): OwnerProfileData {
  if (profile.authorizedAgents.some(a => a.agentId === agent.agentId && !a.revoked)) {
    throw new Error(`Agent ${agent.agentId} is already authorized`);
  }
  return {
    ...profile,
    authorizedAgents: Object.freeze([...profile.authorizedAgents, agent]),
  };
}

/**
 * Revoke an authorized agent (returns new profile with agent marked revoked).
 */
export function removeAuthorizedAgent(
  profile: OwnerProfileData,
  agentId: IRI,
): OwnerProfileData {
  return {
    ...profile,
    authorizedAgents: Object.freeze(
      profile.authorizedAgents.map(a =>
        a.agentId === agentId ? { ...a, revoked: true } : a,
      ),
    ),
  };
}

// ── Delegation Credential ────────────────────────────────────

/**
 * Governance capability token carried INSIDE the signed delegation VC's
 * credentialSubject.scope array. canonicalCredentialPayload covers `scope`,
 * so the wallet signature makes this forge-proof against edits to the
 * unsigned Turtle registry. Deliberately DISTINCT from the coarse ACL verbs
 * (publish/discover/subscribe) — a pod-write grant never confers it. Single
 * source of truth: imported by the relay (issuer) and the Foxxi bridge
 * (verifier) so the token can never drift between the two.
 */
export const TENANT_ADMIN_CAPABILITY = 'cap:tenant-admin';

/**
 * Create an AgentDelegationCredential (VC structure, unsigned).
 *
 * In production, this would be signed by the owner's key.
 * For now, we generate the canonical JSON-LD structure.
 */
export function createDelegationCredential(
  owner: OwnerProfileData,
  agent: AuthorizedAgentData,
  podUrl: IRI,
): AgentDelegationCredential {
  const now = new Date().toISOString();
  const credentialId = `${podUrl}credentials/${encodeURIComponent(agent.agentId)}.jsonld` as IRI;

  const scopes: string[] = [];
  switch (agent.scope) {
    case 'ReadWrite': scopes.push('publish', 'discover', 'subscribe'); break;
    case 'ReadOnly': scopes.push('discover', 'subscribe'); break;
    case 'PublishOnly': scopes.push('publish'); break;
    case 'DiscoverOnly': scopes.push('discover'); break;
  }

  // Governance capability tokens (e.g. TENANT_ADMIN_CAPABILITY) ride in the
  // SIGNED scope array — canonicalCredentialPayload covers credentialSubject.
  // scope, so they cannot be forged by editing the plaintext registry, and
  // they stay distinct from the ACL verbs above. Round-trips already:
  // canonical / jsonld / parse all treat scope as string[].
  if (agent.capabilities) {
    for (const cap of agent.capabilities) if (!scopes.includes(cap)) scopes.push(cap);
  }

  // Honour the agent's own `delegatedBy` so sub-delegation chains are
  // expressed correctly: when an agent's parent is NOT the pod owner,
  // the credentialSubject.delegatedBy points to that parent agent and
  // the issuer becomes that parent (the principal that signed it). The
  // chain walker then follows `delegatedBy` link-by-link up to the pod
  // owner. For the common case of a directly-owner-delegated agent the
  // issuer + delegatedBy both collapse back to `owner.webId`, so the
  // existing single-hop tests are unaffected.
  const principal = agent.delegatedBy || owner.webId;
  return {
    id: credentialId,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: principal,
    issuanceDate: now,
    expirationDate: agent.validUntil,
    credentialSubject: {
      id: agent.agentId,
      delegatedBy: principal,
      scope: scopes,
      pod: podUrl,
    },
  };
}

// ── Serialization ────────────────────────────────────────────

/**
 * Serialize an owner profile to Turtle for storage on a pod.
 */
export function ownerProfileToTurtle(profile: OwnerProfileData): string {
  const lines: string[] = [];
  // Escape caller-controlled IRIs (webId/agentId) + literals (name/label/pubkey) so a
  // self-registering agent cannot break out of `<...>`/`"..."` and inject triples into the
  // published agent-registry graph.
  const escI = (s: string): string => String(s).replace(/[\x00-\x20<>"{}|^`\\]/g, encodeURIComponent);
  // A correct but SEPARATE copy of escapeTurtleLiteral's five replacements, in the same package
  // that defines it. Delegates: correct-and-duplicated is how the divergence starts, and six of
  // the thirteen copies of this idea produced Turtle that would not parse.
  const escL = (s: string): string => escapeTurtleLiteral(String(s));
  // A prefixed name (`iep:<local>`) cannot be escaped into safety — any character
  // outside PN_LOCAL ends the name and starts new RDF. DelegationScope is a closed
  // enum, so allow-list it and fail to the LEAST privilege on anything unrecognised.
  const SCOPES = ['ReadWrite', 'ReadOnly', 'PublishOnly', 'DiscoverOnly'];
  const safeScope = (s: string): string => (SCOPES.includes(String(s)) ? String(s) : 'DiscoverOnly');

  lines.push('@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .');
  lines.push('@prefix foaf: <http://xmlns.com/foaf/0.1/> .');
  lines.push('@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .');
  lines.push('@prefix prov: <http://www.w3.org/ns/prov#> .');
  lines.push('');

  lines.push(`<${escI(profile.webId)}> a foaf:Person ;`);
  if (profile.name) {
    lines.push(`    foaf:name "${escL(profile.name)}" ;`);
  }

  const activeAgents = profile.authorizedAgents.filter(a => !a.revoked);
  if (activeAgents.length > 0) {
    // Canonical Turtle predicate-object list: a single
    // `iep:authorizedAgent` predicate followed by comma-separated objects,
    // closed with `.` since this is the last predicate on the subject.
    // Repeating the predicate per object (which would still parse but
    // is non-canonical) trips strict round-trip validators.
    lines.push('    iep:authorizedAgent');
    for (let i = 0; i < activeAgents.length; i++) {
      const a = activeAgents[i]!;
      const sep = i < activeAgents.length - 1 ? ',' : ' .';
      lines.push(`        <#agent-${encodeURIComponent(a.agentId)}>${sep}`);
    }
  } else {
    // No agents — close the subject
    const last = lines.length - 1;
    lines[last] = lines[last]!.replace(/ ;$/, ' .');
  }

  lines.push('');

  for (const agent of activeAgents) {
    const frag = `#agent-${encodeURIComponent(agent.agentId)}`;
    lines.push(`<${frag}> a iep:AuthorizedAgent ;`);
    lines.push(`    iep:agentIdentity <${escI(agent.agentId)}> ;`);
    lines.push(`    iep:delegatedBy <${escI(profile.webId)}> ;`);
    // PREFIXED-NAME position: `iep:${scope}` is not a literal, so escaping cannot
    // save it — an arbitrary value ends the triple and appends attacker RDF, and a
    // whole injected `<#agent-…>` stanza is accepted by parseOwnerProfile as
    // genuine (runScopeGate then falls back to a registry-only, signature-free
    // verification, making it write-eligible). DelegationScope is a closed enum, so
    // ALLOW-LIST it; the `as 'ReadWrite'` cast at the call site is a runtime no-op.
    lines.push(`    iep:scope iep:${safeScope(agent.scope)} ;`);
    lines.push(`    iep:validFrom "${escL(agent.validFrom)}"^^xsd:dateTime ;`);
    if (agent.validUntil) {
      lines.push(`    iep:validUntil "${escL(agent.validUntil)}"^^xsd:dateTime ;`);
    }
    if (agent.label) {
      lines.push(`    foaf:name "${escL(agent.label)}" ;`);
    }
    if (agent.isSoftwareAgent) {
      lines.push('    a prov:SoftwareAgent ;');
    }
    if (agent.encryptionPublicKey) {
      // Public key is base64 — publish as a literal so downstream tools
      // (including non-RDF clients) can read it without parsing additional
      // vocabularies. iep:encryptionPublicKey is the relationship; the
      // algorithm is implicit X25519-XSalsa20-Poly1305 per the crypto layer.
      lines.push(`    iep:encryptionPublicKey "${escL(agent.encryptionPublicKey)}" ;`);
    }
    if (agent.encryptionKeyHistory && agent.encryptionKeyHistory.length > 0) {
      // Pubkey rollover (Sec #12): each retired key is a pipe-delimited
      // literal "<pubkey>|<createdAt>|<retiredAt>|<label?>". Base64
      // pubkeys + ISO timestamps never contain '|', and labels with a
      // '|' are escaped below. Private keys are NEVER serialized — only
      // the public side + lifecycle timestamps so publishers can wrap
      // to in-window retired keys.
      for (const h of agent.encryptionKeyHistory) {
        const safeLabel = (h.label ?? '').replace(/\|/g, '%7C').replace(/"/g, '\\"');
        lines.push(`    iep:retiredEncryptionKey "${escL(h.publicKey)}|${escL(h.createdAt)}|${escL(h.retiredAt)}|${safeLabel}" ;`);
      }
    }
    // Close
    const lastIdx = lines.length - 1;
    lines[lastIdx] = lines[lastIdx]!.replace(/ ;$/, ' .');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Parse a Turtle agent registry back into an OwnerProfileData.
 */
export function parseOwnerProfile(turtle: string): OwnerProfileData {
  let webId: IRI | undefined;
  let name: string | undefined;
  const agents: AuthorizedAgentData[] = [];

  // Extract owner WebID and name
  const ownerMatch = turtle.match(/<([^>]+)>\s+a\s+foaf:Person/);
  if (ownerMatch) {
    webId = ownerMatch[1]! as IRI;
  }
  const nameMatch = turtle.match(/foaf:name\s+"([^"]+)"/);
  if (nameMatch) {
    name = nameMatch[1]!;
  }

  // Extract agents
  const agentBlocks = turtle.split(/(?=<#agent-)/);
  for (const block of agentBlocks) {
    if (!block.includes('a iep:AuthorizedAgent')) continue;

    const idMatch = block.match(/iep:agentIdentity\s+<([^>]+)>/);
    const delegatedByMatch = block.match(/iep:delegatedBy\s+<([^>]+)>/);
    const scopeMatch = block.match(/iep:scope\s+iep:(\w+)/);
    const fromMatch = block.match(/iep:validFrom\s+"([^"]+)"/);
    const untilMatch = block.match(/iep:validUntil\s+"([^"]+)"/);
    const labelMatch = block.match(/foaf:name\s+"([^"]+)"/);
    const encKeyMatch = block.match(/iep:encryptionPublicKey\s+"([^"]+)"/);
    const isSoftware = block.includes('prov:SoftwareAgent');

    // Pubkey rollover history (Sec #12): one or more
    // iep:retiredEncryptionKey literals, each pipe-delimited
    // "<pubkey>|<createdAt>|<retiredAt>|<label?>". Parsed via matchAll;
    // malformed entries (fewer than 3 segments) are skipped defensively.
    const historyMatches = [...block.matchAll(/iep:retiredEncryptionKey\s+"([^"]+)"/g)];
    const encryptionKeyHistory = historyMatches
      .map(m => {
        const parts = m[1]!.split('|');
        if (parts.length < 3) return null;
        const [publicKey, createdAt, retiredAt, rawLabel] = parts;
        const label = rawLabel ? rawLabel.replace(/%7C/g, '|') : undefined;
        return {
          publicKey: publicKey!,
          createdAt: createdAt!,
          retiredAt: retiredAt!,
          ...(label ? { label } : {}),
        };
      })
      .filter((e): e is NonNullable<typeof e> => e !== null);

    if (idMatch && delegatedByMatch && scopeMatch && fromMatch) {
      agents.push({
        agentId: idMatch[1]! as IRI,
        delegatedBy: delegatedByMatch[1]! as IRI,
        scope: scopeMatch[1]! as DelegationScope,
        validFrom: fromMatch[1]!,
        validUntil: untilMatch?.[1],
        label: labelMatch?.[1],
        isSoftwareAgent: isSoftware || undefined,
        encryptionPublicKey: encKeyMatch?.[1],
        ...(encryptionKeyHistory.length > 0 ? { encryptionKeyHistory } : {}),
      });
    }
  }

  if (!webId) {
    throw new Error('Could not parse owner WebID from agent registry');
  }

  return { webId, name, authorizedAgents: Object.freeze(agents) };
}

/**
 * Build the canonical JSON of a credential for signing or verification.
 *
 * The proof block is excluded — signing the payload-with-proof would
 * make verification chicken-and-egg. Keys are emitted in a fixed order
 * so two parties computing the canonical payload from the same logical
 * credential always agree byte-for-byte.
 */
export function canonicalCredentialPayload(
  credential: AgentDelegationCredential,
): string {
  const ordered: Record<string, unknown> = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://markjspivey-xwisee.github.io/interego/ns/iep/delegation/v1',
    ],
    id: credential.id,
    type: [...credential.type].sort(),
    issuer: credential.issuer,
    issuanceDate: credential.issuanceDate,
    credentialSubject: {
      id: credential.credentialSubject.id,
      delegatedBy: credential.credentialSubject.delegatedBy,
      pod: credential.credentialSubject.pod,
      scope: [...credential.credentialSubject.scope].sort(),
    },
  };
  if (credential.expirationDate) {
    ordered['expirationDate'] = credential.expirationDate;
  }
  // Stable stringify: JS object literal key order is insertion order,
  // so the constant block above produces a deterministic serialization.
  return JSON.stringify(ordered);
}

/**
 * Sign a delegation credential with the owner's wallet key, producing a
 * SignedDelegationCredential that downstream verifiers can cryptographically
 * check.
 *
 * The signer is injected so callers can wire in any key-management story
 * (ethers wallet held by the relay, hardware wallet, OIDC token exchanged
 * for a JWS, etc.). Whatever the signer returns is captured verbatim in
 * the proof block — no key material flows through this module.
 */
export async function createSignedDelegationCredential(
  owner: OwnerProfileData,
  agent: AuthorizedAgentData,
  podUrl: IRI,
  signer: DelegationSigner,
): Promise<SignedDelegationCredential> {
  const unsigned = createDelegationCredential(owner, agent, podUrl);
  const payload = canonicalCredentialPayload(unsigned);
  const { signature, signerAddress, verificationMethod } = await signer(payload);
  const proof: DelegationProof = {
    type: 'EcdsaSecp256k1Signature2019',
    created: new Date().toISOString(),
    proofPurpose: 'assertionMethod',
    verificationMethod,
    proofValue: signature,
    signerAddress,
  };
  return { ...unsigned, proof };
}

/**
 * Serialize a delegation credential to JSON-LD.
 *
 * When a `proof` block is present (i.e. the credential was signed via
 * createSignedDelegationCredential) it round-trips verbatim, so consumers
 * fetching the JSON-LD off a pod can reconstruct the canonical payload
 * and re-run signature verification end-to-end.
 */
export function delegationCredentialToJsonLd(
  credential: AgentDelegationCredential,
): string {
  const doc: Record<string, unknown> = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://markjspivey-xwisee.github.io/interego/ns/iep/delegation/v1',
    ],
    id: credential.id,
    type: [...credential.type],
    issuer: credential.issuer,
    issuanceDate: credential.issuanceDate,
    credentialSubject: {
      id: credential.credentialSubject.id,
      delegatedBy: credential.credentialSubject.delegatedBy,
      scope: [...credential.credentialSubject.scope],
      pod: credential.credentialSubject.pod,
    },
  };
  if (credential.expirationDate) {
    doc['expirationDate'] = credential.expirationDate;
  }
  if (credential.proof) {
    doc['proof'] = { ...credential.proof };
  }
  return JSON.stringify(doc, null, 2);
}

/**
 * Parse a delegation credential JSON-LD document back into an
 * AgentDelegationCredential. Used by verifyDelegationChain to re-hydrate
 * credentials pulled from `<pod>/credentials/<agent>.jsonld` for signature
 * verification.
 *
 * Throws if the document is missing required VC fields. The proof block is
 * optional — unsigned credentials are accepted but `verifyDelegationChain`
 * will refuse to elevate trust above SelfAsserted.
 */
export function parseDelegationCredential(
  jsonLd: string,
): AgentDelegationCredential {
  const doc = JSON.parse(jsonLd) as Record<string, unknown>;
  const subject = doc['credentialSubject'] as Record<string, unknown> | undefined;
  if (!doc['id'] || !doc['issuer'] || !doc['issuanceDate'] || !subject) {
    throw new Error('Delegation credential JSON-LD is missing required fields');
  }
  const result: AgentDelegationCredential = {
    id: doc['id'] as IRI,
    type: Array.isArray(doc['type']) ? (doc['type'] as string[]) : ['VerifiableCredential', 'AgentDelegation'],
    issuer: doc['issuer'] as IRI,
    issuanceDate: doc['issuanceDate'] as string,
    expirationDate: doc['expirationDate'] as string | undefined,
    credentialSubject: {
      id: subject['id'] as IRI,
      delegatedBy: subject['delegatedBy'] as IRI,
      scope: Array.isArray(subject['scope']) ? (subject['scope'] as string[]) : [],
      pod: subject['pod'] as IRI,
    },
    proof: doc['proof'] as DelegationProof | undefined,
  };
  return result;
}

// ── Verification ─────────────────────────────────────────────

/**
 * Options for `verifyDelegation` that activate cryptographic chain walking.
 *
 * When `fetchCredential` AND `verifier` are both supplied, verifyDelegation
 * delegates to `verifyDelegationChain`, which fetches the signed VC for the
 * agent, verifies the signature against the owner's wallet key, and walks
 * up the chain if the agent was itself delegated by another agent (sub-
 * delegation). When either is omitted, verifyDelegation runs the registry-
 * only check and reports `trustLevel: 'SelfAsserted'`.
 */
export interface DelegationVerificationOptions {
  /**
   * Fetch the signed delegation VC for the given agent against the given
   * pod. Return `null` if no credential is present (in which case the
   * trust label is downgraded to SelfAsserted even if the registry
   * accepts the agent).
   */
  readonly fetchCredential?: (
    podUrl: string,
    agentId: IRI,
  ) => Promise<AgentDelegationCredential | null>;
  /**
   * Verify a credential's proof block against its canonical payload.
   * Injected so this module stays free of crypto-library imports.
   */
  readonly verifier?: DelegationVerifier;
  /**
   * Walk sub-delegation chains where one agent has re-delegated to
   * another. Defaults to true. Set false to verify only the immediate
   * delegation, even if the owner field points at another agent.
   */
  readonly walkSubDelegations?: boolean;
  /** Maximum chain length before we abort with a `chain too deep` error. */
  readonly maxChainLength?: number;
}

/**
 * Verify that an agent is authorized to act on behalf of a pod owner.
 *
 * Two modes, selected by `options`:
 *
 *   Registry-only (default): fetch the agent registry, confirm the agent
 *     is present, in-window, and not revoked. Result carries
 *     `trustLevel: 'SelfAsserted'` — no cryptographic claim is made.
 *
 *   Chain-walking: same registry checks PLUS fetch the signed VC for the
 *     agent, verify the proof against the owner's wallet key, then if
 *     `walkSubDelegations` is set and the credential's `delegatedBy`
 *     points at another agent rather than the pod owner, recurse up
 *     until we hit the pod owner's WebID. Each link must produce a
 *     valid signature. Result carries `trustLevel: 'CryptographicallyVerified'`
 *     and `chainLength: N` (number of signed links).
 *
 * @param agentId - The agent claiming delegation
 * @param podUrl - The pod URL being acted on
 * @param fetchProfile - Function to fetch and parse the owner profile from the pod
 * @param options - Optional credential fetcher + signature verifier
 * @returns Verification result
 */
export async function verifyDelegation(
  agentId: IRI,
  podUrl: string,
  fetchProfile: (podUrl: string) => Promise<OwnerProfileData | null>,
  options: DelegationVerificationOptions = {},
): Promise<DelegationVerification> {
  const profile = await fetchProfile(podUrl);

  if (!profile) {
    return {
      valid: false,
      agent: agentId,
      reason: `No agent registry found on ${podUrl}`,
    };
  }

  const agent = profile.authorizedAgents.find(a => a.agentId === agentId);

  if (!agent) {
    return {
      valid: false,
      owner: profile.webId,
      agent: agentId,
      reason: `Agent ${agentId} is not listed in ${profile.webId}'s agent registry`,
    };
  }

  if (agent.revoked) {
    return {
      valid: false,
      owner: profile.webId,
      agent: agentId,
      reason: `Agent ${agentId}'s delegation has been revoked`,
    };
  }

  const now = new Date().toISOString();
  if (agent.validFrom > now) {
    return {
      valid: false,
      owner: profile.webId,
      agent: agentId,
      reason: `Agent ${agentId}'s delegation is not yet valid (starts ${agent.validFrom})`,
    };
  }

  if (agent.validUntil && agent.validUntil < now) {
    return {
      valid: false,
      owner: profile.webId,
      agent: agentId,
      reason: `Agent ${agentId}'s delegation has expired (ended ${agent.validUntil})`,
    };
  }

  // Registry checks passed. If the caller didn't supply a credential
  // fetcher + verifier we stop here and label the result SelfAsserted.
  if (!options.fetchCredential || !options.verifier) {
    return {
      valid: true,
      owner: profile.webId,
      agent: agentId,
      scope: agent.scope,
      trustLevel: 'SelfAsserted',
      chainLength: 1,
    };
  }

  // Chain-walk: fetch the signed VC, verify each link up to the pod owner.
  return verifyDelegationChain(agentId, podUrl, profile, fetchProfile, options);
}

// ── Authorship Proof ─────────────────────────────────────────
//
// Independent of the descriptor-level compliance signature (iep:proof on
// the TrustFacet, which covers the whole descriptor Turtle and is the
// pod-operator anchor), the authorship proof is an agent-level claim
// that THIS agent IRI is the one that minted the descriptor's
// AgentFacet. It signs a small, stable payload — agent IRI + delegating
// owner WebID + descriptor IRI + timestamp — using the same key that
// backs the agent's signed delegation VC.
//
// Why split it from iep:proof:
//   - iep:proof is opt-in (compliance===true) and operator-grade
//   - authorship proof can ship on every publish (cheap, single ECDSA
//     signature) so a reader of any descriptor can independently
//     confirm "did this agent really sign this AgentFacet?" without
//     trusting the pod's storage layer
//
// The canonical payload is a stable-key-order JSON string mirroring
// canonicalCredentialPayload's discipline so any two parties holding
// the same logical inputs produce byte-identical signing input.

/**
 * Inputs to an authorship proof — the minimal stable triple that pins
 * the AgentFacet's identity claim to the descriptor it's embedded in.
 */
export interface AuthorshipProofInputs {
  /** Agent IRI claiming authorship (must match AgentFacet.assertingAgent). */
  readonly agentId: IRI;
  /** Owner WebID the agent acts on behalf of (matches AgentFacet.onBehalfOf). */
  readonly ownerWebId: IRI;
  /** Descriptor IRI this authorship claim is bound to. */
  readonly descriptorId: IRI;
  /** ISO 8601 timestamp at which the authorship was asserted. */
  readonly created: string;
  /** Optional agent DID, surfaced for verifiers that need the resolution hint. */
  readonly agentDid?: string;
  /**
   * ★ Digest of the content this authorship claim is ABOUT. `sha256:<hex>`.
   *
   * Without this the signed payload was `{agentId, ownerWebId, descriptorId, created,
   * agentDid}` — every field naming WHO and WHICH RESOURCE, and none naming WHAT IT SAYS.
   * The proof therefore attested "agent A claims authorship of descriptor D" while
   * remaining valid no matter how D's content changed afterwards. A signature over a
   * filename reads exactly like a signature over a document, which is what makes the gap
   * dangerous rather than merely incomplete.
   *
   * Optional because it must be: proofs written before this field existed cannot acquire
   * one retroactively, and re-signing them is not possible. It is absent on legacy proofs
   * and present on everything written since — and {@link verifySignedAuthorship} reports
   * which, so a consumer can refuse to treat a legacy proof as content-covering rather
   * than being silently told it is.
   */
  readonly contentHash?: string;
}

/**
 * Embedded authorship-proof block. Matches the Turtle shape
 *   <descriptor> iep:authorshipProof [
 *     a iep:SignedAuthorship ;
 *     iep:issuer <agentId> ;
 *     iep:verificationMethod <did:ethr:0x...> ;
 *     iep:created "2026-06-06T..." ;
 *     iep:proofValue "0x..."
 *   ] .
 */
export interface AuthorshipProof {
  readonly issuer: IRI;
  readonly verificationMethod: IRI;
  readonly created: string;
  readonly proofValue: string;
  readonly signerAddress: string;
  readonly ownerWebId: IRI;
  readonly descriptorId: IRI;
  readonly agentDid?: string;
  /**
   * Digest of the signed content, `sha256:<hex>`. Absent on proofs written before the
   * payload covered content — see AuthorshipProofInputs.contentHash. A verifier that
   * needs a content-covering proof must check this is present, not merely that the
   * signature verifies.
   */
  readonly contentHash?: string;
  /** Signature scheme — defaults to ECDSA-secp256k1 / EcdsaSecp256k1Signature2019. */
  readonly scheme: string;
}

/**
 * Build the canonical JSON payload of an authorship claim for signing
 * or verification. Stable key order (alphabetical-by-construction below)
 * so two parties holding the same logical inputs agree byte-for-byte.
 *
 * Mirrors `canonicalCredentialPayload`'s discipline: no proof block, no
 * variant fields, no whitespace-sensitive layout — `JSON.stringify`
 * over a literal-object with deterministic insertion order.
 */
export function canonicalAuthorshipPayload(
  inputs: AuthorshipProofInputs,
): string {
  const ordered: Record<string, unknown> = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://markjspivey-xwisee.github.io/interego/ns/iep/authorship/v1',
    ],
    agentId: inputs.agentId,
    created: inputs.created,
    descriptorId: inputs.descriptorId,
    ownerWebId: inputs.ownerWebId,
    type: 'SignedAuthorship',
  };
  if (inputs.agentDid) {
    ordered['agentDid'] = inputs.agentDid;
  }
  // ★ Included ONLY when present, so a legacy proof still canonicalises to exactly the
  // bytes it was signed over. Adding an always-present field — even an empty string —
  // would invalidate every authorship proof ever written. Absence is the migration.
  if (inputs.contentHash) {
    ordered['contentHash'] = inputs.contentHash;
  }
  return JSON.stringify(ordered);
}

/**
 * Sign an authorship claim with the calling agent's delegation key.
 *
 * Reuses the same `DelegationSigner` shape used by signed VCs — typically
 * the relay's secp256k1 wallet (`makeWalletDelegationSigner`). The
 * returned `AuthorshipProof` is shaped to embed directly in the
 * descriptor Turtle alongside the AgentFacet (`iep:authorshipProof [...]`).
 */
export async function createSignedAuthorship(
  inputs: AuthorshipProofInputs,
  signer: DelegationSigner,
): Promise<AuthorshipProof> {
  const payload = canonicalAuthorshipPayload(inputs);
  const { signature, signerAddress, verificationMethod } = await signer(payload);
  return {
    issuer: inputs.agentId,
    verificationMethod,
    created: inputs.created,
    proofValue: signature,
    signerAddress,
    ownerWebId: inputs.ownerWebId,
    descriptorId: inputs.descriptorId,
    ...(inputs.agentDid ? { agentDid: inputs.agentDid } : {}),
    ...(inputs.contentHash ? { contentHash: inputs.contentHash } : {}),
    scheme: 'EcdsaSecp256k1Signature2019',
  };
}

/**
 * How much a verified authorship proof says about the CONTENT served beside it.
 *
 * Four values because there are four genuinely different situations, and the three that
 * are not `'bound'` are not the same as each other:
 *
 *   bound       the proof carries a digest THIS verifier knows how to recompute, it
 *               recomputed it over the payload actually served, and the two matched. Only
 *               this value licenses "the content is attested".
 *   mismatched  the digest WAS recomputed over the payload served and did NOT match. The
 *               signature is authentic and it is a signature over different content. This
 *               is the sharpest evidence of tampering the substrate can produce.
 *   declared    the proof commits to a digest, but nothing was checked against it — the
 *               caller supplied no payload (encrypted and the reader is not a recipient,
 *               the fetch failed), the payload did not parse, or the digest carries an
 *               algorithm label this verifier does not implement. An honest "I did not
 *               check", which must never be read as either an attestation or an accusation.
 *   unbound     the proof carries no digest at all. Every proof written before the payload
 *               covered content is this, and on its own it is no evidence of forgery — the
 *               signature means exactly what it always meant, which is that a named signer
 *               signed a descriptor URL.
 *
 * ★ WHY `'mismatched'` IS ITS OWN VALUE AND NOT FOLDED INTO `'declared'`. It used to be
 * folded in, on the reasoning that a mismatch already fails verification (`valid: false`)
 * so the binding field need not carry it. It does need to carry it: readers render the
 * binding on its own, and `'declared'` is documented and narrated as "nothing was checked
 * … neither an attestation of the content nor evidence against it". Emitting that sentence
 * about a check that ran, failed, and caught a content swap is the substrate's strongest
 * signal delivered with a note telling the reader to disregard it.
 */
export type ContentBinding = 'bound' | 'mismatched' | 'declared' | 'unbound';

/**
 * What to report when the content digest was NOT examined — because the signature failed
 * first, or the verifier threw before reaching it.
 *
 * Keyed on whether the proof carries a digest at all, which is knowable from the proof
 * alone and is the only thing the two values distinguish. Reporting `'unbound'` for a proof
 * that does carry one asserts "this proof commits to no content", which is false and is the
 * more dangerous direction: `'unbound'` reads as ordinary legacy data.
 */
export function contentBindingWhenUnchecked(contentHash: string | undefined): ContentBinding {
  return typeof contentHash === 'string' && contentHash.length > 0 ? 'declared' : 'unbound';
}

/**
 * Verify a parsed authorship proof against the canonical payload it
 * claims to sign. Recovers the signer from `(payload, signature)` and
 * checks it matches `proof.signerAddress` — symmetric with
 * `verifyDelegationChain`'s proof check, using the same
 * `DelegationVerifier` shape.
 *
 * Returns `{ valid: false, reason }` on any mismatch (bad signature,
 * tampered payload, mismatched signer) so the caller can surface the
 * reason without rejecting the whole descriptor read.
 */
export async function verifySignedAuthorship(
  proof: AuthorshipProof,
  verifier: DelegationVerifier,
  /**
   * The content the proof claims to be about, if the caller has it. Supply this whenever
   * possible: without it the function can only tell you the signature is intact, not that
   * it covers what you are looking at.
   */
  observed?: { readonly contentHash?: string },
): Promise<{
  valid: boolean;
  signer: IRI;
  reason?: string;
  /**
   * ★ THREE OUTCOMES, NEVER TWO. This replaced a `coversContent: boolean` that was true
   * whenever the proof merely CARRIED a digest — which is a claim about the proof, not
   * about the document in front of the reader. Collapsing "the signer committed to a
   * digest" together with "I recomputed that digest over the bytes I am serving" into one
   * flag is precisely how a proof that covers nothing gets reported as one that does.
   * See {@link ContentBinding} for what each value licenses.
   */
  contentBinding: ContentBinding;
}> {
  const inputs: AuthorshipProofInputs = {
    agentId: proof.issuer,
    ownerWebId: proof.ownerWebId,
    descriptorId: proof.descriptorId,
    created: proof.created,
    ...(proof.agentDid ? { agentDid: proof.agentDid } : {}),
    ...(proof.contentHash ? { contentHash: proof.contentHash } : {}),
  };
  const payload = canonicalAuthorshipPayload(inputs);
  // DelegationProof.type is a string-literal union — coerce the
  // free-string scheme into it. The verifier (makeWalletDelegationVerifier)
  // ignores the `type` field at verify time (recovery is a pure
  // function of payload + signature), so the literal cast is safe.
  const proofBlock: DelegationProof = {
    type: 'EcdsaSecp256k1Signature2019',
    created: proof.created,
    proofPurpose: 'assertionMethod',
    verificationMethod: proof.verificationMethod,
    proofValue: proof.proofValue,
    signerAddress: proof.signerAddress,
  };
  try {
    const ok = await verifier(payload, proofBlock);
    if (!ok) {
      return {
        valid: false,
        signer: proof.issuer,
        reason: 'Authorship proof signature did not verify against canonical payload',
        // Nothing about the content was examined — the signature failed before that. This
        // used to report 'unbound' unconditionally, which readers narrate as "the proof
        // carries no content digest … it is not a forgery", said about a proof that does
        // carry one and whose signature did not verify.
        contentBinding: contentBindingWhenUnchecked(proof.contentHash),
      };
    }
    // The signature is intact. Now the separate question: does it say anything about the
    // content, and did anyone check?
    const claimed = typeof proof.contentHash === 'string' && proof.contentHash.length > 0
      ? proof.contentHash
      : null;
    if (claimed === null) return { valid: true, signer: proof.issuer, contentBinding: 'unbound' };

    const seen = typeof observed?.contentHash === 'string' && observed.contentHash.length > 0
      ? observed.contentHash
      : null;
    if (seen === null) return { valid: true, signer: proof.issuer, contentBinding: 'declared' };

    // ★ COMPARE LIKE WITH LIKE, OR DO NOT COMPARE. Two digests produced by different
    // algorithms differ for a reason that has nothing to do with tampering, and reporting
    // that difference as a content swap would brand every proof written before
    // `graph-nquads-sha256` — each carrying a bare `sha256:` over inbound bytes no reader
    // is ever served — as a forgery the moment a reader started checking. That is the
    // failure this branch exists to prevent: a new check whose first act is to accuse
    // honest historical data.
    if (digestAlgorithmOf(claimed) !== digestAlgorithmOf(seen)) {
      return { valid: true, signer: proof.issuer, contentBinding: 'declared' };
    }
    if (claimed !== seen) {
      // Same algorithm, different answer: the proof is authentic and the content is not
      // the content it was signed over.
      return {
        valid: false,
        signer: proof.issuer,
        reason: `Authorship proof covers content ${claimed} but the observed content is ${seen}`,
        contentBinding: 'mismatched',
      };
    }
    return { valid: true, signer: proof.issuer, contentBinding: 'bound' };
  } catch (err) {
    return {
      valid: false,
      signer: proof.issuer,
      reason: `Authorship verifier threw: ${(err as Error).message}`,
      // A verifier that threw compared nothing, so this is the same "not checked" as a
      // failed signature — not a claim that the proof carries no digest.
      contentBinding: contentBindingWhenUnchecked(proof.contentHash),
    };
  }
}

/**
 * How strongly a proof's `iep:descriptorId` was tied to the URL the record was served from.
 *
 * Three values because the middle one is real and used to be invisible. A boolean reported
 * `exact-url` and `slug-only` identically, and `slug-only` is a materially weaker claim — see
 * {@link proofBindsToDescriptorUrl} for exactly how much weaker, measured.
 */
export type DescriptorBindingBasis =
  /** The proof names this URL, compared in full after normalisation. Nothing is unexamined. */
  | 'exact-url'
  /**
   * The proof names a URN, its terminal segment matched, AND the pod that served the bytes
   * publishes the SAME owner the proof signs. The name and the location were both compared;
   * see {@link ProofOwnerScope} for exactly what "the pod publishes" is worth.
   */
  | 'slug-and-owner'
  /**
   * The proof names a URN, and a URN is related to its URL only by `slugFromIri`, which
   * keeps the last `/ : #` segment and discards the rest. Only that segment was compared:
   * the pod, the host and the container were NOT — and no {@link ProofOwnerScope} was
   * available to compare the location by another route.
   */
  | 'slug-only'
  /** The two disagree, or there was nothing comparable. Not bound. */
  | 'none';

export interface DescriptorBinding {
  readonly bound: boolean;
  readonly basis: DescriptorBindingBasis;
  /** Present iff `bound` is false, or iff `bound` is true on a basis weaker than the URL. */
  readonly caveat?: string;
}

/**
 * The second half of a URN-form binding: WHERE the bytes are allowed to be served from.
 *
 * ★ WHY A URN NEEDS THIS AND A URL DOES NOT. `slugFromIri` maps a URN to a filename and
 * discards everything else, so from the served URL no verifier can recover which pod the URN
 * named — the pod is simply not in the comparison, and a proof lifted onto a record with the
 * same terminal segment on ANY pod on ANY host reached `bound: true`. The missing information
 * is not in the URN and never will be; it is in the OTHER field the same signature covers.
 * `iep:ownerWebId` is part of the canonical authorship payload, so a forger who edits it
 * breaks the signature and one who does not carries the victim's WebID into their own pod.
 *
 * ★ WHAT `servingPodOwner` MUST BE, AND WHAT IT IS WORTH. It is the WebID the pod that
 * SERVED these bytes publishes as its owner — its agent registry's `webId`, the same document
 * the relay's write-scope gate reads to decide who may publish into that pod at all. So this
 * comparison is exactly as strong as the substrate's own notion of pod ownership: no stronger,
 * and that limit is stated rather than implied. A pod whose holder writes somebody else's
 * WebID into their own registry still receives a lifted proof — but they must SAY SO, in a
 * public document, in their own pod, and thereby hand every other consumer of that pod the
 * same lie. Closing that last step needs the owner to sign the pod↔owner binding, which
 * nothing in the substrate does today.
 *
 * ★ ABSENCE IS `unchecked`, NEVER `refused`. Either field missing leaves the verdict exactly
 * where it was before this existed — `slug-only`, bound, with a caveat naming what went
 * uncompared. A registry that 404s, a pod off our own infrastructure, or a caller that simply
 * does not have the evidence must not turn an honest record into an accusation.
 */
export interface ProofOwnerScope {
  /** The proof's SIGNED `iep:ownerWebId`. Absent/empty when the caller did not supply it. */
  readonly claimedOwner?: string | null;
  /**
   * The WebID the SERVING pod publishes as its owner, or null when it could not be
   * established. Null is "not compared", not "no owner".
   */
  readonly servingPodOwner?: string | null;
}

/**
 * Is this proof about the record it was served with?
 *
 * ★ THE SUBSTRATE'S SIGNATURE CHECK DOES NOT ASK THIS. `verifySignedAuthorship` re-derives
 * the canonical payload from the proof block's OWN fields, so a proof block lifted verbatim
 * out of one of a principal's real, public descriptors and pasted into a record somebody
 * else fabricated verifies clean, with that principal named as signer. Signature validity
 * says the bytes of the proof were not altered. It says nothing about what the proof is
 * attached to. This is the only function that asks the second question, and it lives here —
 * not in the relay and not in the workspace — because BOTH need it and a second, cleverer
 * copy would eventually disagree with the one that decided whether the record was admitted.
 *
 * ── WHAT A URL-FORM `descriptorId` BUYS, AND WHAT IT COST TO GET IT ──────────────────────
 *
 * When the proof names an http(s) URL there is a full comparison available and it is now the
 * ONLY one performed. It used to be `claimedId === descriptorUrl` with a fall-through to the
 * terminal-segment compare, so a URL-form id that failed the exact test got graded on its
 * last segment like a URN. Measured before the change, and note WHICH form is the live one:
 *
 *     'https://evil.example/anything/9.ttl' vs '…/alice-pod/context-graphs/9.ttl'  → false
 *     'https://evil.example/anything/9'     vs '…/alice-pod/context-graphs/9.ttl'  → TRUE
 *
 * The first is refused only by accident — the served name carries `.ttl`, the claimed one
 * carries it too, and `9.ttl` ≠ `9` after the suffix is stripped from one side only. Drop
 * the suffix and a proof naming a document on an ATTACKER-CONTROLLED HOST bound to a record
 * on the victim's pod. Same result across pods on our own host. That asymmetry was the only
 * thing standing in the way, and it is not a check.
 *
 * The fall-through is gone: a URL-form id is directly comparable, so there is no case in
 * which grading it on a suffix is right.
 *
 * ★ THE ONE HONEST CASE THIS REFUSES, NAMED RATHER THAN GUESSED AT. A caller who supplies a
 * URL `descriptor_id` WITHOUT the `.ttl` — `…/context-graphs/9` for a record that lands at
 * `…/context-graphs/9.ttl` — used to bind through that same segment compare and now does
 * not. It is the identical comparison as the attack above; there is no predicate that keeps
 * one and drops the other, so both go. Nothing in this tree is in that state: every
 * `descriptor_id` minted anywhere in the repo is a `urn:` (relay, mcp-server, validator,
 * demos — checked), and the recovery is in the publisher's hands and is the point of the
 * migration anyway — sign the descriptor's actual URL, `.ttl` included, and it binds
 * `exact-url` with nothing left uncompared.
 *
 * ★ AND THE FULL COMPARISON IS NORMALISED. `normalizeCssUrl` is injected rather than imported
 * because it lives at the relay boundary; omitting it leaves the comparison raw, which is the
 * previous behaviour, not a new one.
 *
 * ★★ WHAT THAT NORMALISATION IS AND IS NOT EVIDENCE OF — RE-REGISTERED, because the previous
 * version of this paragraph put it in the register this file reserves for live observations
 * and it does not belong there. It said the raw comparison was *"measured `false` on a record
 * that is exactly what it claims to be"*. The mechanism is real and the figure reproduces:
 * feed the pre-migration and post-migration hosts to this function and it answers
 * `{bound: false}` raw and `{bound: true, basis: 'exact-url'}` normalised. But it was measured
 * on a CONSTRUCTED STRING, not read off a record, and two things stop it being a live fact:
 *
 *   — `normalizeCssUrl` matches only `https://interego-css.<hex>.eastus.azurecontainerapps.io`
 *     (`deploy/mcp-relay/url-rewrite.ts`), an Azure host that is not the live infrastructure.
 *     The live relay reports `"css": "http://css.railway.internal:3456/"`, and url-rewrite.ts
 *     says so itself: *"Latent today — current infra is Railway."*
 *   — a URN never reaches the `exact-url` branch and `normalizeCssUrl` is a no-op on one, so
 *     for every `descriptor_id` this repo mints (all of them URNs — see above) the normaliser
 *     cannot change any verdict at all.
 *
 * So this is a guard against a shape that WOULD fail closed on honest data if a URL-form
 * `descriptor_id` ever met a migrated host. That is worth having and worth stating precisely.
 * It is not a record that was rescued, and calling it one borrows credibility the measurement
 * does not have.
 *
 * ── ★ WHAT A URN-FORM `descriptorId` CANNOT BUY BY ITSELF, AND WHERE THE REST COMES FROM ──
 *
 * The relay mints `descriptor_id` as `urn:iep:<pod>:<epoch-ms>` and derives the URL from it
 * through `slugFromIri` — LAST `/ : #` SEGMENT ONLY, URL-encoded, plus `.ttl`. That function
 * is lossy, so from the URL alone NO verifier — this one, the relay, or a future one — can
 * recover which pod the URN named. On the terminal segment alone, a proof lifted across pods
 * at the same epoch bound:
 *
 *     'urn:iep:alice-pod:1712345678901'
 *       vs 'https://css/mallory-pod/context-graphs/1712345678901.ttl'   → bound, slug-only
 *
 * ★ WHY THE POD IS STILL NOT READ OUT OF THE URN. The obvious tightening — treat the third
 * URN component as the pod and require it to appear in the URL path — breaks live shapes the
 * relay itself mints, where that component is a ROLE and not a pod at all:
 *
 *     urn:iep:pod-bootstrap:<userId>:v1         → published to pod <userId>
 *     urn:iep:trajectory-step:<agentSlug>:<ms>  → published to the CALLER's pod
 *     urn:iep:<pod>:pgsl:<ms>                   → pod is third, but a fourth follows
 *
 * All three are honest and all three would be refused. Guessing which URN dialect is in hand
 * is how a check starts accusing real authors, so it is not attempted — and it is not needed,
 * because the URN was never the only signed field naming a party.
 *
 * ★ THE LOCATION IS COMPARED THROUGH `iep:ownerWebId`, WHICH THE SAME SIGNATURE COVERS. See
 * {@link ProofOwnerScope}. When the caller can say who the SERVING pod belongs to, this
 * function compares that against the owner the proof signs: agreement is `slug-and-owner`
 * (name and location both checked), DISAGREEMENT IS A REFUSAL — that is the lift — and
 * absence on either side leaves `slug-only` exactly as it was.
 *
 * ★ MEASURED BEFORE THE REFUSAL SHIPPED, because it is a behaviour change on a path every
 * descriptor read crosses. A sweep of the deployed tree on 2026-08-04 read all 2,314
 * descriptors on 278 known pods; 633 carry an authorship proof, across 13 pods; every one of
 * the 633 binds `slug-only` today and every one of the 13 pods publishes a registry owner
 * that is EXACTLY the `iep:ownerWebId` its proofs sign — in both live WebID shapes
 * (`https://identity…/users/<pod>/profile#me`, 605 proofs, and `did:ethr:0x…`, 28). Zero
 * disagreements, zero pods with no readable registry. So the refusal costs no honest read
 * in the tree it was measured on, and the obvious over-tightening — demanding `exact-url`,
 * or demanding the delegation chain, which only 28 of the 633 reach — would refuse hundreds.
 *
 * ★★ AND THE PREDICTION WAS RUN, which is a different claim and is recorded as one. The same
 * 633 descriptors, re-read on 2026-08-05 against the deployed build carrying this refusal,
 * answer 633 `slug-and-owner`, 633 `authorshipVerified: true`, 0 refused. The line above is
 * what a comparison of two published values predicted; this line is what the running system
 * returned.
 *
 * The durable fix upstream is still to sign a URL as the `descriptorId`, at which point the
 * `exact-url` branch handles it in full with nothing left to infer.
 */
export function proofBindsToDescriptorUrl(
  claimedDescriptorId: string | null | undefined,
  descriptorUrl: string,
  normalize?: (url: string) => string,
  ownerScope?: ProofOwnerScope,
): DescriptorBinding {
  const norm = normalize ?? ((u: string) => u);
  if (typeof claimedDescriptorId !== 'string' || claimedDescriptorId.length === 0) {
    return {
      bound: false,
      basis: 'none',
      caveat:
        'the proof block carries no iep:descriptorId, so there is nothing to compare against '
        + 'the URL it was served from — this says nothing about the proof itself',
    };
  }

  let served: URL;
  try { served = new URL(norm(descriptorUrl)); } catch {
    return {
      bound: false,
      basis: 'none',
      caveat: `the record's own URL <${descriptorUrl}> could not be parsed, so no comparison `
        + 'was possible; refusing is the safe direction',
    };
  }

  // An http(s) claimed id is directly comparable to the URL, so compare it and stop. Falling
  // through to the slug compare when this fails is what let a foreign host bind.
  let claimedUrl: URL | null = null;
  try {
    const u = new URL(norm(claimedDescriptorId));
    if (u.protocol === 'http:' || u.protocol === 'https:') claimedUrl = u;
  } catch { /* not a URL — the URN path below is the only one left */ }
  if (claimedUrl !== null) {
    if (claimedUrl.href === served.href) return { bound: true, basis: 'exact-url' };
    return {
      bound: false,
      basis: 'none',
      caveat:
        `the proof names the URL <${claimedDescriptorId}> and the record is served at `
        + `<${descriptorUrl}>. A URL-form descriptorId is compared in full — host, pod, `
        + 'container and name — so a difference in any of them is a difference.',
    };
  }

  // URN (or any non-URL IRI). `slugFromIri` is the only relation the substrate defines
  // between it and a URL, and it keeps just the terminal segment.
  const tail = (s: string): string | null => s.split(/[/:#]/).filter(Boolean).pop() ?? null;
  const claimedTail = tail(claimedDescriptorId);
  const servedTail = tail(served.pathname)?.replace(/\.ttl$/, '');
  if (claimedTail === null || servedTail === null || servedTail === undefined) {
    return {
      bound: false,
      basis: 'none',
      caveat: `the proof names <${claimedDescriptorId}> and the record is served at `
        + `<${descriptorUrl}>; neither yields a segment to compare`,
    };
  }
  if (encodeURIComponent(claimedTail) !== servedTail) {
    return {
      bound: false,
      basis: 'none',
      caveat: `the proof names <${claimedDescriptorId}> and the record is served at `
        + `<${descriptorUrl}>`,
    };
  }
  // ── The terminal segment matched. Now WHERE was it served from? ──────────────────────
  //
  // The URN cannot answer that (see the header), so the answer comes from the other signed
  // field that names a party. Three outcomes, and the middle one is the whole point of the
  // round: absence must not become an accusation, and disagreement must not stay a footnote.
  const claimedOwner = nonEmpty(ownerScope?.claimedOwner);
  const servingOwner = nonEmpty(ownerScope?.servingPodOwner);
  if (claimedOwner !== null && servingOwner !== null) {
    // ★ CASE-INSENSITIVE, AND THAT IS THE SAFE DIRECTION IN BOTH LIVE SHAPES RATHER THAN
    // laxness. A `did:ethr:0x…` is EIP-55 checksum-cased, so two spellings of one address
    // are the same account and refusing on the case would accuse an author of forging their
    // own record. For an https WebID the origin is case-insensitive by RFC 3986 anyway, and
    // an attacker cannot reach anything with the difference: to exploit it they would need
    // the serving pod to publish a case-variant of the victim's WebID, which is the same
    // public false claim as publishing it exactly.
    if (claimedOwner.toLowerCase() !== servingOwner.toLowerCase()) {
      return {
        bound: false,
        basis: 'none',
        caveat:
          `the proof is signed for owner <${claimedOwner}> and the pod serving `
          + `<${descriptorUrl}> publishes <${servingOwner}> as its owner. The terminal `
          + 'segment matched, which is all a URN can match, so this is exactly the shape a '
          + 'proof lifted onto another party\'s pod takes: the same name, a different owner. '
          + 'iep:ownerWebId is inside the signed payload, so it cannot be edited to fit.',
      };
    }
    return {
      bound: true,
      basis: 'slug-and-owner',
      caveat:
        `the proof names the URN <${claimedDescriptorId}>, so only its terminal segment was `
        + `matched against the URL — but the pod serving it publishes the same owner the `
        + `proof signs (<${claimedOwner}>), so the record is not on some other party's pod. `
        + 'What is still uncompared: the container within that pod, and the pod\'s ownership '
        + 'claim is the pod\'s own — nobody signs the pod-to-owner binding.',
    };
  }
  return {
    bound: true,
    basis: 'slug-only',
    caveat:
      `the proof names the URN <${claimedDescriptorId}>, whose only defined relation to a URL `
      + 'is its terminal segment, so ONLY that segment matched. The host, the pod and the '
      + 'container were not compared and cannot be: the URN-to-URL mapping discards them. A '
      + 'proof lifted onto a record with the same final segment on a different pod would '
      + 'reach this same verdict. '
      + (claimedOwner === null
        // Two different absences, named apart: one is the proof's, one is the reader's.
        ? 'The proof carries no iep:ownerWebId to compare the location by, either.'
        : 'The owner of the pod that served it could not be established, so the location '
          + 'went unchecked — which is not the same as checked and disagreeing, and is '
          + 'reported as this weaker basis rather than as a refusal.'),
  };
}

/** A string that is actually there. `''` is absence, and so is a non-string off a JSON wire. */
function nonEmpty(v: string | null | undefined): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Walk a signed delegation chain from `agentId` up to the pod owner's
 * WebID, verifying each VC's signature in turn.
 *
 * The walk:
 *   1. Fetch the signed VC for the current agent from `<pod>/credentials/<agent>.jsonld`.
 *   2. Re-derive the canonical payload, run the verifier — fail if the
 *      proof is absent, the signature is bad, or the recovered address
 *      doesn't match `proof.signerAddress`.
 *   3. Read `credentialSubject.delegatedBy`. If it equals the pod owner,
 *      the chain is anchored — return success. Otherwise treat the
 *      `delegatedBy` IRI as the next agent up and recurse.
 *   4. Abort with a `chain too deep` error if we exceed `maxChainLength`.
 *
 * Each link gets its own registry-membership + temporal + revocation
 * check; a revoked intermediate agent fails the whole chain.
 */
export async function verifyDelegationChain(
  agentId: IRI,
  podUrl: string,
  profile: OwnerProfileData,
  fetchProfile: (podUrl: string) => Promise<OwnerProfileData | null>,
  options: DelegationVerificationOptions,
): Promise<DelegationVerification> {
  const { fetchCredential, verifier, walkSubDelegations = true, maxChainLength = 8 } = options;
  if (!fetchCredential || !verifier) {
    return {
      valid: false,
      agent: agentId,
      reason: 'verifyDelegationChain requires both fetchCredential and verifier',
    };
  }

  let currentAgent: IRI = agentId;
  let currentProfile = profile;
  let chainLength = 0;
  const seen = new Set<IRI>();
  const now = new Date().toISOString();

  while (chainLength < maxChainLength) {
    if (seen.has(currentAgent)) {
      return {
        valid: false,
        owner: profile.webId,
        agent: agentId,
        reason: `Delegation chain cycle detected at ${currentAgent}`,
      };
    }
    seen.add(currentAgent);

    const credential = await fetchCredential(podUrl, currentAgent);
    if (!credential) {
      return {
        valid: false,
        owner: profile.webId,
        agent: agentId,
        reason: `No signed delegation credential found for ${currentAgent} on ${podUrl}`,
      };
    }
    if (!credential.proof) {
      return {
        valid: false,
        owner: profile.webId,
        agent: agentId,
        reason: `Delegation credential for ${currentAgent} is unsigned — cannot upgrade trust above SelfAsserted`,
      };
    }
    if (credential.expirationDate && credential.expirationDate < now) {
      return {
        valid: false,
        owner: profile.webId,
        agent: agentId,
        reason: `Delegation credential for ${currentAgent} expired ${credential.expirationDate}`,
      };
    }
    const payload = canonicalCredentialPayload(credential);
    const ok = await verifier(payload, credential.proof);
    if (!ok) {
      return {
        valid: false,
        owner: profile.webId,
        agent: agentId,
        reason: `Delegation credential for ${currentAgent} has an invalid signature`,
      };
    }

    chainLength += 1;
    const delegatedBy = credential.credentialSubject.delegatedBy;

    // Reached the pod owner's WebID — chain is anchored.
    if (delegatedBy === currentProfile.webId) {
      return {
        valid: true,
        owner: currentProfile.webId,
        agent: agentId,
        scope: profile.authorizedAgents.find(a => a.agentId === agentId)?.scope,
        trustLevel: 'CryptographicallyVerified',
        chainLength,
      };
    }

    if (!walkSubDelegations) {
      // Caller asked us to stop at the first hop even though the credential
      // points further up the chain. Treat that as a malformed delegation.
      return {
        valid: false,
        owner: currentProfile.webId,
        agent: agentId,
        reason: `Delegation for ${currentAgent} is sub-delegated but walkSubDelegations is disabled`,
      };
    }

    // Sub-delegation: the immediate parent is another agent on this pod.
    // Confirm that parent is itself registered and not revoked, then loop.
    const parent = currentProfile.authorizedAgents.find(a => a.agentId === delegatedBy);
    if (!parent) {
      return {
        valid: false,
        owner: currentProfile.webId,
        agent: agentId,
        reason: `Sub-delegating agent ${delegatedBy} is not registered on ${podUrl}`,
      };
    }
    if (parent.revoked) {
      return {
        valid: false,
        owner: currentProfile.webId,
        agent: agentId,
        reason: `Sub-delegating agent ${delegatedBy} has been revoked`,
      };
    }
    if (parent.validUntil && parent.validUntil < now) {
      return {
        valid: false,
        owner: currentProfile.webId,
        agent: agentId,
        reason: `Sub-delegating agent ${delegatedBy} expired ${parent.validUntil}`,
      };
    }
    currentAgent = delegatedBy;
    // Re-fetch the profile in case it has been updated between hops
    // (defensive; in practice the same profile applies for the same pod).
    currentProfile = (await fetchProfile(podUrl)) ?? currentProfile;
  }

  return {
    valid: false,
    owner: profile.webId,
    agent: agentId,
    reason: `Delegation chain exceeded maxChainLength=${maxChainLength}`,
  };
}
