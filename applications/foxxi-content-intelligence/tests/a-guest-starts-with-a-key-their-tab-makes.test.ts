/**
 * A person with no account starts as a guest, on a key their own tab makes.
 *
 * ★ WHY. The bridge takes any key's signature for that key's own identity, so a wallet with no
 * account could already play a hosted package and read its own record. But the sign-in page
 * offered only a demo roster, a wallet extension or a pasted key, so someone arriving with none of
 * those had no way in. A guest session is a pasted-key session whose key the tab made, and whose
 * recovery phrase is offered to be written down, since it is the only way back.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { ethers } from 'ethers';
import { connectAsGuest, connectFromPrivateKey, saveSession, signsOnly } from '../dashboard-app/src/auth/session.js';

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8');
const POD = 'https://pod.example/tenant/';
const PHRASE = 'test test test test test test test test test test test junk';

describe('a guest session', () => {
  it('is the key the tab made: its own did:ethr, a signing session, with its recovery phrase', async () => {
    const wallet = ethers.Wallet.fromPhrase(PHRASE);
    const guest = await connectAsGuest(POD, () => wallet);
    expect(guest.webId).toBe(`did:ethr:${wallet.address}`);
    expect(guest.connectedPrivateKey).toBe(wallet.privateKey);
    expect(guest.guestRecoveryPhrase).toBe(PHRASE);
    expect(guest.role).toBe('learner');
    expect(guest.audienceTags).toEqual(['connected-wallet', 'guest']);
    expect(guest.name.startsWith('Guest 0x')).toBe(true);
    expect(signsOnly(guest)).toBe(true);
  });

  it('makes a different key each time when left to itself', async () => {
    const [a, b] = await Promise.all([connectAsGuest(POD), connectAsGuest(POD)]);
    expect(a.webId).not.toBe(b.webId);
    expect(a.guestRecoveryPhrase!.split(' ')).toHaveLength(12);
  });

  it('comes back as the same identity from its recovery phrase, through the pasted-key sign-in', async () => {
    const guest = await connectAsGuest(POD);
    const back = await connectFromPrivateKey(guest.guestRecoveryPhrase!, POD);
    expect(back.webId).toBe(guest.webId);
    // Coming back is an ordinary connected session: the phrase is not carried around again.
    expect(back.guestRecoveryPhrase).toBeUndefined();
  });

  it('refuses a key that has no recovery phrase, since the guest could never come back', async () => {
    const noPhrase = { ...ethers.Wallet.createRandom(), mnemonic: null } as unknown as ethers.HDNodeWallet;
    await expect(connectAsGuest(POD, () => noPhrase)).rejects.toThrow(/recovery phrase/);
  });

  it('is never written to storage with its key or its phrase', async () => {
    const written: Record<string, string> = {};
    const had = (globalThis as { localStorage?: unknown }).localStorage;
    (globalThis as { localStorage?: unknown }).localStorage = { setItem: (k: string, v: string) => { written[k] = v; } };
    try {
      const guest = await connectAsGuest(POD);
      saveSession(guest);
      const stored = Object.values(written).join('\n');
      expect(stored).toContain(guest.webId);
      expect(stored).not.toContain(guest.guestRecoveryPhrase!);
      expect(stored).not.toContain(guest.connectedPrivateKey!);
      expect(JSON.parse(written['foxxi:session']!)).not.toHaveProperty('guestRecoveryPhrase');
    } finally { (globalThis as { localStorage?: unknown }).localStorage = had; }
  });
});

describe('the pages', () => {
  const login = read('../dashboard-app/src/components/Login.tsx');
  const notice = read('../dashboard-app/src/components/GuestKeyNotice.tsx');
  const learn = read('../dashboard-app/src/components/LearnPanel.tsx');

  it('offer the guest start first, before any roster or wallet', () => {
    expect(login).toContain('onSignIn(await connectAsGuest(SAMPLE_TENANT_POD_URL))');
    expect(login.indexOf('Start now, with no account')).toBeGreaterThan(0);
    expect(login.indexOf('Start now, with no account')).toBeLessThan(login.indexOf('Choose an audience'));
  });

  it('tell a guest on the Learn page what the key is, and show the phrase only when asked', () => {
    expect(learn).toContain('<GuestKeyNotice session={session} />');
    expect(notice).toContain('if (!phrase) return null;');
    expect(notice).toContain('const [shown, setShown] = useState(false);');
    // The phrase is rendered in one place, inside the block that is there only once shown.
    expect(notice.match(/\{phrase\}/g)).toHaveLength(1);
    expect(notice.indexOf('{shown && (\n        <div data-testid="guest-recovery-phrase"')).toBeGreaterThan(0);
    expect(notice).toContain('Close or reload it and the key is gone.');
  });
});
