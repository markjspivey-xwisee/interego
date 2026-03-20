/**
 * @module model/delegation
 * @description Owner/agent delegation model for Context Graphs 1.0
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
  DelegationVerification,
  DelegationScope,
} from './types.js';

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

  return {
    id: credentialId,
    type: ['VerifiableCredential', 'AgentDelegation'],
    issuer: owner.webId,
    issuanceDate: now,
    expirationDate: agent.validUntil,
    credentialSubject: {
      id: agent.agentId,
      delegatedBy: owner.webId,
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

  lines.push('@prefix cg: <https://markjspivey-xwisee.github.io/context-graphs/ns/context-graphs#> .');
  lines.push('@prefix foaf: <http://xmlns.com/foaf/0.1/> .');
  lines.push('@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .');
  lines.push('@prefix prov: <http://www.w3.org/ns/prov#> .');
  lines.push('');

  lines.push(`<${profile.webId}> a foaf:Person ;`);
  if (profile.name) {
    lines.push(`    foaf:name "${profile.name}" ;`);
  }

  const activeAgents = profile.authorizedAgents.filter(a => !a.revoked);
  for (let i = 0; i < activeAgents.length; i++) {
    const a = activeAgents[i]!;
    const sep = i < activeAgents.length - 1 ? ',' : '';
    lines.push(`    cg:authorizedAgent <#agent-${encodeURIComponent(a.agentId)}>${sep}`);
  }

  // Replace trailing comma/nothing with period
  if (activeAgents.length > 0) {
    lines.push('    .');
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
    const isSoftware = block.includes('prov:SoftwareAgent');

    if (idMatch && delegatedByMatch && scopeMatch && fromMatch) {
      agents.push({
        agentId: idMatch[1]! as IRI,
        delegatedBy: delegatedByMatch[1]! as IRI,
        scope: scopeMatch[1]! as DelegationScope,
        validFrom: fromMatch[1]!,
        validUntil: untilMatch?.[1],
        label: labelMatch?.[1],
        isSoftwareAgent: isSoftware || undefined,
      });
    }
  }

  if (!webId) {
    throw new Error('Could not parse owner WebID from agent registry');
  }

  return { webId, name, authorizedAgents: Object.freeze(agents) };
}

/**
 * Serialize a delegation credential to JSON-LD.
 */
export function delegationCredentialToJsonLd(
  credential: AgentDelegationCredential,
): string {
  const doc: Record<string, unknown> = {
    '@context': [
      'https://www.w3.org/2018/credentials/v1',
      'https://markjspivey-xwisee.github.io/context-graphs/ns/context-graphs/delegation/v1',
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
  return JSON.stringify(doc, null, 2);
}

// ── Verification ─────────────────────────────────────────────

/**
 * Verify that an agent is authorized to act on behalf of a pod owner.
 *
 * Checks the delegation chain:
 *   1. Fetch the agent registry from the pod
 *   2. Find the agent in the registry
 *   3. Check scope, temporal validity, revocation status
 *
 * @param agentId - The agent claiming delegation
 * @param podUrl - The pod URL being acted on
 * @param fetchProfile - Function to fetch and parse the owner profile from the pod
 * @returns Verification result
 */
export async function verifyDelegation(
  agentId: IRI,
  podUrl: string,
  fetchProfile: (podUrl: string) => Promise<OwnerProfileData | null>,
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

  return {
    valid: true,
    owner: profile.webId,
    agent: agentId,
    scope: agent.scope,
  };
}
