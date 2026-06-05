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

  lines.push('@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .');
  lines.push('@prefix foaf: <http://xmlns.com/foaf/0.1/> .');
  lines.push('@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .');
  lines.push('@prefix prov: <http://www.w3.org/ns/prov#> .');
  lines.push('');

  lines.push(`<${profile.webId}> a foaf:Person ;`);
  if (profile.name) {
    lines.push(`    foaf:name "${profile.name}" ;`);
  }

  const activeAgents = profile.authorizedAgents.filter(a => !a.revoked);
  if (activeAgents.length > 0) {
    // Canonical Turtle predicate-object list: a single
    // `cg:authorizedAgent` predicate followed by comma-separated objects,
    // closed with `.` since this is the last predicate on the subject.
    // Repeating the predicate per object (which would still parse but
    // is non-canonical) trips strict round-trip validators.
    lines.push('    cg:authorizedAgent');
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
    lines.push(`<${frag}> a cg:AuthorizedAgent ;`);
    lines.push(`    cg:agentIdentity <${agent.agentId}> ;`);
    lines.push(`    cg:delegatedBy <${profile.webId}> ;`);
    lines.push(`    cg:scope cg:${agent.scope} ;`);
    lines.push(`    cg:validFrom "${agent.validFrom}"^^xsd:dateTime ;`);
    if (agent.validUntil) {
      lines.push(`    cg:validUntil "${agent.validUntil}"^^xsd:dateTime ;`);
    }
    if (agent.label) {
      lines.push(`    foaf:name "${agent.label}" ;`);
    }
    if (agent.isSoftwareAgent) {
      lines.push('    a prov:SoftwareAgent ;');
    }
    if (agent.encryptionPublicKey) {
      // Public key is base64 — publish as a literal so downstream tools
      // (including non-RDF clients) can read it without parsing additional
      // vocabularies. cg:encryptionPublicKey is the relationship; the
      // algorithm is implicit X25519-XSalsa20-Poly1305 per the crypto layer.
      lines.push(`    cg:encryptionPublicKey "${agent.encryptionPublicKey}" ;`);
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
        lines.push(`    cg:retiredEncryptionKey "${h.publicKey}|${h.createdAt}|${h.retiredAt}|${safeLabel}" ;`);
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
    if (!block.includes('a cg:AuthorizedAgent')) continue;

    const idMatch = block.match(/cg:agentIdentity\s+<([^>]+)>/);
    const delegatedByMatch = block.match(/cg:delegatedBy\s+<([^>]+)>/);
    const scopeMatch = block.match(/cg:scope\s+cg:(\w+)/);
    const fromMatch = block.match(/cg:validFrom\s+"([^"]+)"/);
    const untilMatch = block.match(/cg:validUntil\s+"([^"]+)"/);
    const labelMatch = block.match(/foaf:name\s+"([^"]+)"/);
    const encKeyMatch = block.match(/cg:encryptionPublicKey\s+"([^"]+)"/);
    const isSoftware = block.includes('prov:SoftwareAgent');

    // Pubkey rollover history (Sec #12): one or more
    // cg:retiredEncryptionKey literals, each pipe-delimited
    // "<pubkey>|<createdAt>|<retiredAt>|<label?>". Parsed via matchAll;
    // malformed entries (fewer than 3 segments) are skipped defensively.
    const historyMatches = [...block.matchAll(/cg:retiredEncryptionKey\s+"([^"]+)"/g)];
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
      'https://markjspivey-xwisee.github.io/interego/ns/cg/delegation/v1',
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
      'https://markjspivey-xwisee.github.io/interego/ns/cg/delegation/v1',
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
