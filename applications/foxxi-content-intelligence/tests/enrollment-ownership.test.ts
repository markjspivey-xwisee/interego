/**
 * Self-sovereign enrolment asks whose pod it is. Only the wallet a pod is named for, signing for
 * itself, may enroll it; everything else is refused with the rule that refused it, instead of the
 * pod going to whoever asked first. A row squatted before the rule gives way when the owner
 * enrolls, and authorizes nothing on the read path. The live content-judgment runner's own pod
 * (`u-eth-42c2ffd7e4c0`, signed by its wallet as `did:ethr:<lower-case address>`) still enrolls.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { enrollmentDecision, isPodRoot, isWalletPod, membershipHolds, ownersOf, podContaining, type OwnershipRules } from '../src/enrollment-ownership.js';
import { deriveUserWallet, mintSessionToken, trustedAddressMap, verifySessionToken } from '../src/auth.js';

const STORE = 'https://gate.interego.xwisee.com';
/** The live runner's wallet (a public address) and its two pod spellings. */
const AGENT = '0x42C2FFd7e4c048F2Ee757B26eE16A2c2339882ab';
const AGENT_ID = `did:ethr:${AGENT.toLowerCase()}`;
const AGENT_POD = `${STORE}/u-eth-42c2ffd7e4c0/`;
const AGENT_TWIN = `${STORE}/eth-42c2ffd7e4c0/`;
const VICTIM = '0x1111111111aa00000000000000000000000beef1';
const VICTIM_POD = `${STORE}/eth-1111111111aa/`;
const RELAY = '0x9999999999990000000000000000000000000abc';

/** Stand-ins for the bridge's samePodPrincipal (last segment, `u-` folded), sameStore and pod derivation. */
const principal = (url: string): string | null => {
  const seg = (url.replace(/\/+$/, '').split('/').pop() ?? '').toLowerCase();
  return seg ? seg.replace(/^u-/, '') : null;
};
const rules: OwnershipRules = {
  samePrincipal: (a, b) => principal(a) !== null && principal(a) === principal(b),
  sameStore: (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } },
  podOfWallet: (address) => `${STORE}/eth-${address.slice(2, 14).toLowerCase()}/`,
};
const decide = (podUrl: string, signer = AGENT, agentId = AGENT_ID) => enrollmentDecision({ podUrl, signer, agentId }, rules);

describe('the pod your wallet is named for', () => {
  it('enrolls, in either spelling, as the live content-judgment runner does', () => {
    expect(decide(AGENT_POD)).toEqual({ ok: true, podRoot: AGENT_POD });
    expect(decide(AGENT_TWIN)).toEqual({ ok: true, podRoot: AGENT_TWIN });
    expect(decide(AGENT_POD.replace(/\/$/, ''))).toEqual({ ok: true, podRoot: AGENT_POD });
    // A checksummed agent_id is the same wallet.
    expect(decide(AGENT_POD, AGENT, `did:ethr:${AGENT}`).ok).toBe(true);
  });
});

describe('everything else is refused, and says which rule refused it', () => {
  it('another wallet\'s pod, naming the signer\'s own', () => {
    const d = decide(VICTIM_POD);
    expect(d).toMatchObject({ ok: false, refused: 'another-wallets-pod', status: 403, yourPod: AGENT_TWIN });
    expect(decide(`${STORE}/u-eth-1111111111aa/`)).toMatchObject({ refused: 'another-wallets-pod' });
    // The control: the same pod is its own wallet's to enroll, so the refusal above is about WHO asked.
    expect(decide(VICTIM_POD, VICTIM, `did:ethr:${VICTIM}`)).toEqual({ ok: true, podRoot: VICTIM_POD });
    expect(membershipHolds(VICTIM, VICTIM_POD, rules)).toBe(true);
  });

  it('a pod whose name says no wallet, instead of making it whoever asked first', () => {
    for (const pod of [`${STORE}/u-pk-f2a9c751075a/`, `${STORE}/u-did-0123456789ab/`, `${STORE}/weft/`, `${STORE}/foxxi/`]) {
      expect(decide(pod), pod).toMatchObject({ ok: false, refused: 'owner-not-in-name', status: 403 });
    }
  });

  it('a request signed for someone else: a relay session or a delegate', () => {
    const relaySession = 'did:web:identity.interego.xwisee.com:agents:interego-live-demo-u-eth-42c2ffd7e4c0';
    expect(decide(AGENT_POD, RELAY, relaySession)).toMatchObject({ ok: false, refused: 'signed-for-another', status: 403 });
    expect(decide(AGENT_POD, AGENT, `did:ethr:${VICTIM}`)).toMatchObject({ refused: 'signed-for-another' });
    // Checked first: a relay key naming its own derived pod is still signing for someone else.
    expect(decide(`${STORE}/eth-999999999999/`, RELAY, relaySession)).toMatchObject({ refused: 'signed-for-another' });
  });

  it('a path inside a pod, which would compare one pod\'s name and write into another', () => {
    expect(decide(`${VICTIM_POD}eth-42c2ffd7e4c0/`)).toMatchObject({ ok: false, refused: 'not-a-pod-root', status: 400 });
    expect(decide(`${AGENT_POD}?x=1`)).toMatchObject({ refused: 'not-a-pod-root' });
    expect(decide(`${STORE}/`)).toMatchObject({ refused: 'not-a-pod-root' });
    expect(decide('not a url')).toMatchObject({ refused: 'not-a-pod-root' });
  });

  it('a pod named for your wallet on a store this bridge cannot prove anything about', () => {
    expect(decide('https://elsewhere.example/eth-42c2ffd7e4c0/')).toMatchObject({ ok: false, refused: 'another-store', status: 403 });
  });
});

describe('a row squatted before the rule', () => {
  const squatter = { user_id: 'u-eth-1111111111aa', web_id: `${AGENT_POD}profile/card#me`, wallet_address: VICTIM };
  const owner = { user_id: 'u-eth-42c2ffd7e4c0', web_id: `${AGENT_POD}profile/card#me`, wallet_address: AGENT.toLowerCase() };

  it('gives way when the pod\'s own wallet enrolls, so the owner is not locked out', () => {
    expect(ownersOf([squatter], AGENT_POD, rules)).toEqual({ kept: [], displaced: [squatter] });
    expect(ownersOf([squatter, owner], AGENT_POD, rules)).toEqual({ kept: [owner], displaced: [squatter] });
    expect(ownersOf([owner], AGENT_TWIN, rules)).toEqual({ kept: [owner], displaced: [] });
  });

  it('authorizes nothing on the read path, wherever inside the pod the caller points', () => {
    expect(membershipHolds(VICTIM, AGENT_POD, rules)).toBe(false);
    expect(membershipHolds(AGENT, AGENT_POD, rules)).toBe(true);
    expect(membershipHolds(AGENT, AGENT_TWIN, rules)).toBe(true);
    // The pod is the one the path is IN: the last segment naming the squatter changes nothing.
    expect(membershipHolds(VICTIM, `${AGENT_POD}eth-1111111111aa/`, rules)).toBe(false);
    // A pod whose name says no wallet has no owner to check against; its membership stands.
    expect(membershipHolds(VICTIM, `${STORE}/weft/`, rules)).toBe(true);
  });

  it('reads the pod a URL is in, not the URL as given', () => {
    expect(podContaining(`${VICTIM_POD}eth-42c2ffd7e4c0/`)).toBe(VICTIM_POD);
    expect(isPodRoot(AGENT_POD)).toBe(true);
    expect(isPodRoot(`${AGENT_POD}foxxi/`)).toBe(false);
    expect(isWalletPod(`${STORE}/u-pk-f2a9c751075a/`)).toBe(false);
    expect(isWalletPod(`${AGENT_POD}foxxi/`)).toBe(true);
  });
});

describe('a session token is held to the same rule as a signed envelope (the automated review of #475)', () => {
  // Two wallets from a private seed, both with a row in the membership of the pod OWNER's wallet is
  // named for: the squatter's row was written first-come, before the rule.
  const SEED = 'enrollment-ownership-bearer';
  const SQUATTER = { userId: 'squatter', webId: 'https://squatter.example/profile#me' };
  const OWNER = { userId: 'owner', webId: 'https://owner.example/profile#me' };
  const walletOf = (u: { userId: string }): string => deriveUserWallet(u.userId, SEED).address;
  const ownerPod = rules.podOfWallet(walletOf(OWNER));
  const membership = trustedAddressMap([SQUATTER, OWNER].map((u) => ({ user_id: u.userId, web_id: u.webId, wallet_address: walletOf(u) })));

  it('refuses the squatter: its token verifies against the membership, but its wallet does not hold the pod', async () => {
    const verified = verifySessionToken(await mintSessionToken({ ...SQUATTER, seed: SEED }), membership);
    // Verification alone is what the token path used to hand a caller context on.
    expect(verified.ok && verified.callerDid).toBe(SQUATTER.webId);
    expect(verified.ok && membershipHolds(verified.token.address, ownerPod, rules)).toBe(false);
  });

  it('still lets the pod\'s own wallet through with its token', async () => {
    const verified = verifySessionToken(await mintSessionToken({ ...OWNER, seed: SEED }), membership);
    expect(verified.ok && verified.callerDid).toBe(OWNER.webId);
    expect(verified.ok && membershipHolds(verified.token.address, ownerPod, rules)).toBe(true);
  });
});

describe('the bridge applies the rule with its own comparisons', () => {
  const src = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
  const handler = src.slice(src.indexOf("'foxxi.register_self_sovereign_learner': async"), src.indexOf("'foxxi.publish_ontology': async"));

  it('the comparisons are selfBoundPod\'s: samePodPrincipal and sameStore, and a wallet\'s derived pod', () => {
    expect(src).toMatch(/const POD_OWNERSHIP: OwnershipRules = \{\s*samePrincipal: samePodPrincipal,\s*sameStore,\s*podOfWallet: \(address\) => resolveSubjectPodUrl\(`did:ethr:\$\{address\}`\),/);
  });

  it('enrolment decides whose pod it is before it reads or writes anything, from the signed agent_id', () => {
    expect(handler.length).toBeGreaterThan(1000);
    const decided = handler.indexOf('enrollmentDecision({ podUrl, signer, agentId: rec.agentId }, POD_OWNERSHIP)');
    expect(decided).toBeGreaterThan(-1);
    expect(decided).toBeLessThan(handler.indexOf('fetchSection(TENANT_TYPES.TenantDirectory'));
    expect(decided).toBeLessThan(handler.indexOf('publishTenantMembership('));
    expect(handler).toMatch(/ownersOf\(members, ownership\.podRoot, POD_OWNERSHIP\)/);
  });

  it('the membership read refuses a row on a pod named for another wallet, whichever way the caller authenticated', () => {
    expect(src).toMatch(/membershipHolds\(wallet, membershipPod, POD_OWNERSHIP\)\) return null;\s*return wrongPod\(/);
    expect(src).toMatch(/const podUrl = membershipPodFor\(args\);/);
    const caller = src.slice(src.indexOf('async function resolveCaller('), src.indexOf('// ── Handlers'));
    expect(caller.length).toBeGreaterThan(1000);
    // The proof-of-possession signer, before its context is built...
    const signer = caller.indexOf('foreignPodRefusal(args, signedSigner)');
    expect(signer).toBeGreaterThan(-1);
    expect(signer).toBeLessThan(caller.indexOf('callerWebId: member.webId'));
    // ...and a session token's wallet, once the token verifies and before its context is built
    // (the automated review of #475: the token path returned a context without asking).
    const token = caller.indexOf('foreignPodRefusal(args, verified.token.address)');
    expect(token).toBeGreaterThan(caller.indexOf('verifySessionToken(token, addressMap)'));
    expect(token).toBeLessThan(caller.indexOf('callerWebId: verified.callerDid'));
  });

  it('and nothing published still promises the pod to whoever enrolls first', () => {
    expect(src).not.toMatch(/first enrollee (becomes the owner|owns it)/i);
  });
});
