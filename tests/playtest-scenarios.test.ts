/**
 * Multiplayer playtest — end-to-end user/agent journeys.
 *
 * Unlike the per-module unit tests, these scenarios compose the public
 * API the way a real session would: individual humans and their
 * delegated agents, across devices and circumstances, at varying
 * degrees of collaboration and activity complexity. Each scenario is
 * judged against a production / consumer-grade quality property —
 * useful, usable, effective, efficient, or safe — stated in its name.
 *
 * If a journey can't be expressed cleanly through the public API, or a
 * failure mode is silent / cryptic / unsafe-by-default, that is itself
 * a finding worth fixing — not just a failing assertion.
 */

import { describe, it, expect } from 'vitest';
import {
  // identity + delegation
  createOwnerProfile,
  addAuthorizedAgent,
  removeAuthorizedAgent,
  createDelegationCredential,
  verifyDelegation,
  ownerProfileToTurtle,
  parseOwnerProfile,
  resolveRecipient,
  // passport (biography that survives migration)
  createPassport,
  recordLifeEvent,
  stateValue,
  migrateInfrastructure,
  demonstratedCapabilities,
  passportSummary,
  // E2EE
  generateKeyPair,
  createEncryptedEnvelope,
  openEncryptedEnvelope,
  openEncryptedEnvelopeWithHistory,
  // structural memory
  createPGSL,
  ingest,
  latticeStats,
  // safety
  screenForSensitiveContent,
  shouldBlockOnSensitivity,
  formatSensitivityWarning,
  // public-Nostr interop signing
  getNostrPubkey,
  schnorrSign,
  schnorrVerify,
  sha256Hex,
  createWallet,
  exportPrivateKey,
} from '../src/index.js';
import type {
  IRI,
  AuthorizedAgentData,
  OwnerProfileData,
  FetchFn,
} from '../src/index.js';

// ── shared helpers ───────────────────────────────────────────

const iso = (d: string) => new Date(d).toISOString();
const daysFromNow = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();

function mkAgent(o: Partial<AuthorizedAgentData> & { agentId: string; delegatedBy: string }): AuthorizedAgentData {
  return {
    scope: 'ReadWrite',
    validFrom: '2020-01-01T00:00:00Z',
    ...o,
    agentId: o.agentId as IRI,
    delegatedBy: o.delegatedBy as IRI,
  };
}

/** Serves `${podUrl}agents` Turtle for known pods, 404 otherwise — a pod the world can read. */
function podNetwork(registries: Record<string, OwnerProfileData>): FetchFn {
  return async (url) => {
    for (const [podUrl, profile] of Object.entries(registries)) {
      if (url === `${podUrl}agents`) {
        return { ok: true, status: 200, statusText: 'OK', text: async () => ownerProfileToTurtle(profile), json: async () => ({}) };
      }
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '', json: async () => ({}) };
  };
}

// ═══════════════════════════════════════════════════════════════
//  Scenario A — Solo human, one device, simple activity  (USEFUL + USABLE)
//  "Alice signs up, delegates her assistant, it remembers something,
//   she can prove the delegation and recall it."
// ═══════════════════════════════════════════════════════════════

describe('Scenario A — solo human, one device, simple memory (useful + usable)', () => {
  const ALICE = 'https://pod.example/alice/profile#me' as IRI;
  const POD = 'https://pod.example/alice/' as IRI;
  const ASSISTANT = 'urn:agent:alice-assistant' as IRI;

  it('completes the whole happy path in a handful of obvious steps', async () => {
    // 1. Alice creates her profile and delegates one assistant.
    let alice = createOwnerProfile(ALICE, 'Alice');
    alice = addAuthorizedAgent(alice, mkAgent({
      agentId: ASSISTANT, delegatedBy: ALICE, label: 'Daily assistant', isSoftwareAgent: true,
    }));

    // 2. The assistant gets a verifiable delegation credential.
    const cred = createDelegationCredential(alice, alice.authorizedAgents[0]!, POD);
    expect(cred.credentialSubject.scope).toContain('publish');

    // 3. Before acting, anyone can verify the delegation against the pod.
    const check = await verifyDelegation(ASSISTANT, POD, async () => alice);
    expect(check.valid).toBe(true);
    expect(check.scope).toBe('ReadWrite');

    // 4. The assistant records a memory in the agent's structural store.
    const pgsl = createPGSL({ wasAttributedTo: ASSISTANT, generatedAtTime: iso('2026-05-14') });
    ingest(pgsl, ['Alice', 'prefers', 'morning', 'meetings']);
    expect(latticeStats(pgsl).atoms).toBe(4);

    // USABLE: the steps are linear and each one's output feeds the next —
    // no hidden setup, no out-of-band configuration.
  });

  it('an unauthorized assistant is denied with an actionable reason', async () => {
    const alice = createOwnerProfile(ALICE, 'Alice');
    const r = await verifyDelegation('urn:agent:not-mine' as IRI, POD, async () => alice);
    expect(r.valid).toBe(false);
    // USABLE: the failure tells the user *why* and *where* — not just "false".
    expect(r.reason).toMatch(/not listed/);
    expect(r.reason).toContain(ALICE);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Scenario B — One human, device / infrastructure migration  (EFFECTIVE across circumstances)
//  "Alice's assistant has built up a biography on one runtime; she
//   switches laptops / runtimes and nothing is lost."
// ═══════════════════════════════════════════════════════════════

describe('Scenario B — agent biography survives device migration (effective)', () => {
  const AGENT = 'urn:agent:alice-assistant' as IRI;

  it('carries capabilities, values, and history across an infrastructure change', () => {
    // On device 1 / runtime A, the agent lives a little.
    let passport = createPassport({ agentIdentity: AGENT, currentPod: 'https://pod-a.example/alice/' });
    passport = recordLifeEvent(passport, {
      id: 'urn:e:1' as IRI, kind: 'capability-acquisition', at: iso('2026-01-10'),
      description: 'first successful research synthesis', evidence: ['urn:d:1' as IRI],
      details: { capability: 'research:Synthesis' },
    });
    passport = stateValue(passport, { statement: 'always cite sources', assertedAt: iso('2026-01-11') });
    const beforePod = passport.currentPod;
    const beforeVersion = passport.version;

    // She migrates to a new pod on a different runtime.
    passport = migrateInfrastructure(passport, {
      newPod: 'https://pod-b.example/alice/',
      newInfrastructure: 'openclaw-v0.6.0',
      evidence: ['urn:d:migration-receipt' as IRI],
    });

    // EFFECTIVE: nothing about who the agent *is* was lost in the move.
    expect(passport.currentPod).not.toBe(beforePod);
    expect(passport.version).toBe(beforeVersion + 1);
    expect(demonstratedCapabilities(passport)['research:Synthesis']).toBeDefined();
    const summary = passportSummary(passport);
    expect(summary.totalLifeEvents).toBeGreaterThanOrEqual(2); // capability + migration
    expect(summary.eventBreakdown['infrastructure-migration']).toBe(1);
    expect(summary.demonstratedCapabilitiesCount).toBeGreaterThanOrEqual(1);
    // The value commitment is still in force after the move.
    expect(summary.activeValues).toBeGreaterThanOrEqual(1);
    expect(passport.statedValues.some((v) => v.statement === 'always cite sources')).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Scenario C — Two humans, pairwise E2EE collaboration  (SAFE + collaborative)
//  "Alice shares a private note with Bob. Bob reads it. Carol can't,
//   and the storage host only ever sees ciphertext."
// ═══════════════════════════════════════════════════════════════

describe('Scenario C — pairwise E2EE share (safe collaboration)', () => {
  it('the intended recipient reads it; an outsider and the host cannot', () => {
    const alice = generateKeyPair();
    const bob = generateKeyPair();
    const carol = generateKeyPair();

    const note = 'Q3 board notes: acquisition target is Acme Corp';
    const envelope = createEncryptedEnvelope(note, [bob.publicKey], alice);

    // SAFE: the storage provider holds only ciphertext — the plaintext
    // never appears in what gets persisted.
    expect(envelope.content.ciphertext).not.toContain('Acme');
    expect(JSON.stringify(envelope)).not.toContain('Acme');

    // Bob (intended recipient) decrypts cleanly.
    expect(openEncryptedEnvelope(envelope, bob)).toBe(note);

    // Carol (not a recipient) gets null — a clean refusal, not a throw,
    // not a partial leak.
    expect(openEncryptedEnvelope(envelope, carol)).toBeNull();
  });

  it('group share: each of several recipients can read, non-members cannot', () => {
    const sender = generateKeyPair();
    const team = [generateKeyPair(), generateKeyPair(), generateKeyPair()];
    const outsider = generateKeyPair();
    const msg = 'shared design doc v3';

    const envelope = createEncryptedEnvelope(msg, team.map((k) => k.publicKey), sender);
    for (const member of team) expect(openEncryptedEnvelope(envelope, member)).toBe(msg);
    expect(openEncryptedEnvelope(envelope, outsider)).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════
//  Scenario D — Group collaboration with mid-flow revocation  (SAFE under change)
//  "Three agents work a shared pod. One is compromised and revoked.
//   It instantly loses authority and stops being a share recipient;
//   the others are unaffected."
// ═══════════════════════════════════════════════════════════════

describe('Scenario D — revocation mid-collaboration (safe)', () => {
  const OWNER = 'https://pod.example/team/profile#me' as IRI;
  const POD = 'https://pod.example/team/' as IRI;

  it('revoking one agent denies it and removes its key — others keep working', async () => {
    let team = createOwnerProfile(OWNER, 'Team Pod', [
      mkAgent({ agentId: 'urn:agent:planner', delegatedBy: OWNER, encryptionPublicKey: 'KEY_PLANNER' }),
      mkAgent({ agentId: 'urn:agent:builder', delegatedBy: OWNER, encryptionPublicKey: 'KEY_BUILDER' }),
      mkAgent({ agentId: 'urn:agent:rogue', delegatedBy: OWNER, encryptionPublicKey: 'KEY_ROGUE' }),
    ]);

    // All three start out authorized.
    for (const id of ['urn:agent:planner', 'urn:agent:builder', 'urn:agent:rogue']) {
      expect((await verifyDelegation(id as IRI, POD, async () => team)).valid).toBe(true);
    }

    // The rogue agent is revoked.
    team = removeAuthorizedAgent(team, 'urn:agent:rogue' as IRI);

    // SAFE: revocation is immediate and total for that agent...
    const rogue = await verifyDelegation('urn:agent:rogue' as IRI, POD, async () => team);
    expect(rogue.valid).toBe(false);
    expect(rogue.reason).toMatch(/revoked/);

    // ...while the others are entirely unaffected.
    expect((await verifyDelegation('urn:agent:planner' as IRI, POD, async () => team)).valid).toBe(true);
    expect((await verifyDelegation('urn:agent:builder' as IRI, POD, async () => team)).valid).toBe(true);

    // And the rogue key is no longer handed out to publishers as a share recipient.
    const recipients = await resolveRecipient(POD, { fetch: podNetwork({ [POD]: team }) });
    expect(recipients?.agentEncryptionKeys).toContain('KEY_PLANNER');
    expect(recipients?.agentEncryptionKeys).toContain('KEY_BUILDER');
    expect(recipients?.agentEncryptionKeys).not.toContain('KEY_ROGUE');
  });

  it('an expired delegation is denied even without explicit revocation', async () => {
    const team = createOwnerProfile(OWNER, 'Team Pod', [
      mkAgent({ agentId: 'urn:agent:temp', delegatedBy: OWNER, validUntil: iso('2000-01-01') }),
    ]);
    const r = await verifyDelegation('urn:agent:temp' as IRI, POD, async () => team);
    expect(r.valid).toBe(false);
    expect(r.reason).toMatch(/expired/);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Scenario E — Key rollover during ongoing collaboration  (SAFE + effective under change)
//  "An agent rotates its encryption key. Messages already in flight,
//   wrapped for the old key, must still be readable for a grace period."
// ═══════════════════════════════════════════════════════════════

describe('Scenario E — encryption key rollover keeps in-flight messages readable (safe)', () => {
  it('a message wrapped for the retired key still opens via key history', () => {
    const sender = generateKeyPair();
    const oldKey = generateKeyPair();
    const newKey = generateKeyPair();

    // A publisher wraps a message for the agent's *old* key (it hadn't
    // refetched the registry yet).
    const inFlight = createEncryptedEnvelope('please review the merge', [oldKey.publicKey], sender);

    // The agent has since rotated to newKey but kept oldKey locally for
    // the rollover window.
    expect(openEncryptedEnvelope(inFlight, newKey)).toBeNull(); // new key alone can't
    const recovered = openEncryptedEnvelopeWithHistory(inFlight, newKey, [oldKey]);

    // EFFECTIVE: rotation does not orphan messages already in flight.
    expect(recovered).toBe('please review the merge');
  });
});

// ═══════════════════════════════════════════════════════════════
//  Scenario F — Adversarial probing  (SAFE by default)
//  "The substrate's job is to make the unsafe thing hard. Probe the
//   guard rails: secret leakage, signature forgery."
// ═══════════════════════════════════════════════════════════════

describe('Scenario F — safety guard rails hold under adversarial input (safe)', () => {
  it('a user about to publish a real secret is stopped before it leaves the device', () => {
    // Built at runtime so the literal never trips secret scanners.
    const leakedKey = 'sk' + '-ant-' + 'api03-PLAYTESTFIXTURE0000000000000000';
    const draft = `Here's the deploy config:\nANTHROPIC_API_KEY=${leakedKey}\nregion=us-east-1`;

    const flags = screenForSensitiveContent(draft);
    expect(flags.length).toBeGreaterThan(0);
    // SAFE: high-severity content blocks by default — the user has to
    // consciously override, not consciously opt in.
    expect(shouldBlockOnSensitivity(flags)).toBe(true);
    // USABLE: the warning names what was found so the user can fix it.
    const warning = formatSensitivityWarning(flags);
    expect(warning.length).toBeGreaterThan(0);
  });

  it('ordinary content is not false-flagged — the gate is not noise', () => {
    const ordinary = 'Met with the design team about the new onboarding flow. Next step: prototype by Friday.';
    expect(shouldBlockOnSensitivity(screenForSensitiveContent(ordinary))).toBe(false);
  });

  it('a forged or tampered signature is rejected', async () => {
    const wallet = await createWallet('agent', 'Signer');
    const sk = exportPrivateKey(wallet.address);
    const pubkey = getNostrPubkey(sk);
    const digest = sha256Hex('agreement: ship v1 on the 14th');
    const sig = schnorrSign(digest, sk);

    // Genuine signature verifies.
    expect(schnorrVerify(sig, digest, pubkey)).toBe(true);
    // SAFE: a one-character tamper, a swapped message, or a different
    // signer all fail closed.
    const forged = (sig[0] === '0' ? '1' : '0') + sig.slice(1);
    expect(schnorrVerify(forged, digest, pubkey)).toBe(false);
    expect(schnorrVerify(sig, sha256Hex('agreement: ship v1 on the 21st'), pubkey)).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Scenario G — Activity at scale  (EFFICIENT)
//  "Doing more of the same thing should not cost more storage. Content
//   addressing means repeated structure is shared, not duplicated."
// ═══════════════════════════════════════════════════════════════

describe('Scenario G — repeated structure is shared, not duplicated (efficient)', () => {
  it('ingesting the same content twice does not grow the lattice', () => {
    const pgsl = createPGSL({ wasAttributedTo: 'urn:agent:archivist' as IRI, generatedAtTime: iso('2026-05-14') });

    const first = ingest(pgsl, ['quarterly', 'revenue', 'report']);
    const atomsAfterFirst = latticeStats(pgsl).atoms;

    const second = ingest(pgsl, ['quarterly', 'revenue', 'report']);
    // EFFICIENT: identical content content-addresses to the same node;
    // the atom count is unchanged.
    expect(second).toBe(first);
    expect(latticeStats(pgsl).atoms).toBe(atomsAfterFirst);
  });

  it('overlapping activity shares its common substructure', () => {
    const pgsl = createPGSL({ wasAttributedTo: 'urn:agent:archivist' as IRI, generatedAtTime: iso('2026-05-14') });
    ingest(pgsl, ['team', 'standup', 'notes']);
    const atomsBefore = latticeStats(pgsl).atoms;
    // A second activity that overlaps ('notes') reuses the shared atom.
    ingest(pgsl, ['design', 'review', 'notes']);
    // 5 new-vs-old: only 'design' and 'review' are new atoms; 'notes' is shared.
    expect(latticeStats(pgsl).atoms).toBe(atomsBefore + 2);
  });
});

// ═══════════════════════════════════════════════════════════════
//  Scenario H — Cross-device data parity  (USABLE across devices)
//  "What one device writes, another device reads back identically.
//   No device-specific state, no lossy serialization."
// ═══════════════════════════════════════════════════════════════

describe('Scenario H — what one device writes, another reads identically (usable across devices)', () => {
  it('a profile with agents, keys, and rotation history round-trips through Turtle', () => {
    const OWNER = 'https://pod.example/dana/profile#me' as IRI;

    // Device 1 builds the profile and serializes it for the pod.
    const device1 = createOwnerProfile(OWNER, 'Dana', [
      mkAgent({
        agentId: 'urn:agent:dana-phone', delegatedBy: OWNER, label: 'Phone', isSoftwareAgent: true,
        scope: 'ReadWrite', encryptionPublicKey: 'KEY_PHONE_CURRENT',
        validUntil: daysFromNow(365),
        encryptionKeyHistory: [
          { publicKey: 'KEY_PHONE_OLD', createdAt: iso('2026-01-01'), retiredAt: iso('2026-04-01'), label: 'pre-reinstall' },
        ],
      }),
      mkAgent({ agentId: 'urn:agent:dana-laptop', delegatedBy: OWNER, scope: 'ReadOnly' }),
    ]);
    const onThePod = ownerProfileToTurtle(device1);

    // Device 2 fetches the same Turtle and parses it.
    const device2 = parseOwnerProfile(onThePod);

    // USABLE: the two devices agree on every load-bearing field.
    expect(device2.webId).toBe(device1.webId);
    expect(device2.authorizedAgents).toHaveLength(2);
    const phone = device2.authorizedAgents.find((a) => a.agentId === 'urn:agent:dana-phone');
    expect(phone?.scope).toBe('ReadWrite');
    expect(phone?.encryptionPublicKey).toBe('KEY_PHONE_CURRENT');
    expect(phone?.encryptionKeyHistory?.[0]?.publicKey).toBe('KEY_PHONE_OLD');
    expect(phone?.encryptionKeyHistory?.[0]?.label).toBe('pre-reinstall');
    const laptop = device2.authorizedAgents.find((a) => a.agentId === 'urn:agent:dana-laptop');
    expect(laptop?.scope).toBe('ReadOnly');
  });
});
