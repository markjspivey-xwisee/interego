/**
 * Demo identity for the Foxxi dashboard.
 *
 * In production this is replaced with the substrate's real auth flow
 * (DID-resolution, SIWE / WebAuthn, did:web / did:ethr). For the
 * dashboard demo we let the user pick a role + a sample identity from
 * the Acme Training Co tenant roster so they can click around as
 * different audience members.
 *
 * The session shape mirrors what the substrate's downstream APIs
 * expect: a stable `webId` (used as the learner_did argument on the
 * bridge), an audience-tags array (so the dashboard can show a hint
 * about which policies will match), and the active role (which
 * top-level shell to render).
 */

import { SAMPLE_ADMIN_PAYLOAD } from '../sample/data.js';
import { ethers } from 'ethers';
import { mintSessionToken, mintSessionTokenWithWallet } from './session-token.js';

export type SessionRole = 'learner' | 'admin';

export interface FoxxiSession {
  role: SessionRole;
  webId: string;
  /** Stable userId (e.g. u-joshua) — used to derive the per-user demo wallet. */
  userId: string;
  name: string;
  audienceTags: string[];
  tenantPodUrl: string;
  /** Signed bearer token presented to the bridge on every authenticated call. */
  bearerToken: string;
  /** ISO timestamp the bearer token expires — UI refresh trigger. */
  bearerExpiresAt: string;
  /**
   * For a "connect wallet" session: the connected REAL private key. When set,
   * /agent/* signed-affordance calls are signed with THIS key (the real
   * self-sovereign identity / lens), not the demo-seed derivation. Held in this
   * browser only.
   */
  connectedPrivateKey?: string;
}

export interface SessionOption {
  webId: string;
  userId: string;
  name: string;
  jobTitle: string;
  department: string;
  audienceTags: string[];
}

const STORAGE_KEY = 'foxxi:session';

export function loadSession(): FoxxiSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Partial<FoxxiSession>;
    // Treat sessions missing bearerToken (older shape) or past their
    // bearerExpiresAt as expired — drop them so the user is sent to Login
    // instead of rendering a shell that immediately makes unauthenticated
    // bridge calls.
    if (!s.bearerToken || !s.bearerExpiresAt) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    if (Date.parse(s.bearerExpiresAt) <= Date.now()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    // A connect-wallet session is NEVER persisted with its private key
    // (saveSession strips it — keys must not live at rest). So a reloaded
    // connected session can't sign; drop it and require a fresh connect
    // rather than render a session that fails every signed call.
    if (isConnectedSession(s) && !s.connectedPrivateKey) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return s as FoxxiSession;
  } catch {
    return null;
  }
}

/** A "connect wallet" session is keyed by a did:ethr identity / connected-wallet tag. */
function isConnectedSession(s: Partial<FoxxiSession>): boolean {
  return !!s.webId?.startsWith('did:ethr:') || !!s.audienceTags?.includes('connected-wallet');
}

export function saveSession(s: FoxxiSession): void {
  // SECURITY: never persist a connected private key at rest (localStorage is
  // XSS-readable). The key lives in memory (App state) for the tab's lifetime
  // only; on reload the user re-connects.
  const safe = { ...s };
  delete safe.connectedPrivateKey;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(safe));
}

export function clearSession(): void {
  localStorage.removeItem(STORAGE_KEY);
}

// The admin's userId is u-admin (Jordan Doe in the demo sample —
// admin_payload.users entry matching meta.admin_user_web_id). The token
// derivation MUST use a userId that's present in the published directory
// so the bridge's address-map lookup resolves.
const ADMIN_USER_ID = 'u-admin';

export function adminSessionOption(): SessionOption {
  const m = SAMPLE_ADMIN_PAYLOAD.meta;
  return {
    webId: m.admin_user_web_id,
    userId: ADMIN_USER_ID,
    name: m.admin_user_name,
    jobTitle: m.admin_user_role,
    department: 'L&D / Administration',
    audienceTags: ['admin'],
  };
}

/**
 * Learner-side options: pick from the Acme Training Co roster, prioritised
 * to show interesting audience-tag membership for demoing the
 * enrollment-discovery flow. Returns ~12 representative users.
 */
export function learnerSessionOptions(): SessionOption[] {
  const interesting = new Set([
    'u-joshua', // Joshua Liu — engineering (golf-explained required)
    'u-le', // Ngozi Kowalski — Learning Engineer (IEEE ICICLE canonical: learning sciences × HCD × engineering methods × data)
    'u0062', // Heather Zhang — engineer + manager
    'u0001', // Jessica Torres — CEO (mostly only required-of-all)
    'u0021', // Annie Johnson — actor in audit log entries
    'u0107', // Compliance & Standards member
    'u0145', // Commercial dept
  ]);
  const picks: SessionOption[] = [];
  for (const id of interesting) {
    const u = SAMPLE_ADMIN_PAYLOAD.users.find(x => x.user_id === id);
    if (u) picks.push({
      webId: u.web_id,
      userId: u.user_id,
      name: u.name,
      jobTitle: u.job_title,
      department: u.department,
      audienceTags: u.audience_tags,
    });
  }
  // Round out the list with a few additional users.
  for (const u of SAMPLE_ADMIN_PAYLOAD.users) {
    if (interesting.has(u.user_id)) continue;
    if (picks.length >= 12) break;
    picks.push({
      webId: u.web_id,
      userId: u.user_id,
      name: u.name,
      jobTitle: u.job_title,
      department: u.department,
      audienceTags: u.audience_tags,
    });
  }
  return picks;
}

/**
 * "Connect wallet" login: sign in as a REAL self-sovereign identity by
 * providing its private key (or mnemonic). The dashboard derives the wallet
 * and signs /agent/* affordance calls with it (the bridge's DIRECT branch),
 * so e.g. "My forwarding" keys to that identity's REAL lens. This is how the
 * maintainer (did:ethr:0x8f3b…, self-held key) signs in as itself — not a
 * demo stand-in. (johnny/boozer are relay+OAuth-mediated and have no
 * exportable signing key, so they act only from their own session.)
 */
export async function connectFromPrivateKey(input: string, tenantPodUrl: string): Promise<FoxxiSession> {
  const raw = input.trim();
  let wallet: ethers.Wallet | ethers.HDNodeWallet;
  if (/^(0x)?[0-9a-fA-F]{64}$/.test(raw)) {
    wallet = new ethers.Wallet(raw.startsWith('0x') ? raw : `0x${raw}`);
  } else if (raw.split(/\s+/).length >= 12) {
    wallet = ethers.Wallet.fromPhrase(raw);
  } else {
    throw new Error('Paste a private key (0x + 64 hex) or a 12/24-word recovery phrase.');
  }
  const did = `did:ethr:${wallet.address}`;
  const ttlMs = 8 * 60 * 60 * 1000;
  const bearerToken = await mintSessionTokenWithWallet(wallet, did, ttlMs);
  return {
    role: 'learner',
    webId: did,
    userId: wallet.address,
    name: `Connected ${wallet.address.slice(0, 6)}…${wallet.address.slice(-4)}`,
    audienceTags: ['connected-wallet'],
    tenantPodUrl,
    bearerToken,
    bearerExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
    connectedPrivateKey: wallet.privateKey,
  };
}

export async function sessionFromOption(opt: SessionOption, role: SessionRole, tenantPodUrl: string): Promise<FoxxiSession> {
  // Mint a real ECDSA-signed bearer token for the picked identity. The
  // bridge verifies the signature recovers an address present in the
  // published tenant-directory and uses the directory's wallet_address →
  // web_id mapping to set caller_did.
  const ttlMs = 8 * 60 * 60 * 1000; // 8h
  const bearerToken = await mintSessionToken({
    userId: opt.userId,
    webId: opt.webId,
    ttlMs,
  });
  return {
    role,
    webId: opt.webId,
    userId: opt.userId,
    name: opt.name,
    audienceTags: opt.audienceTags,
    tenantPodUrl,
    bearerToken,
    bearerExpiresAt: new Date(Date.now() + ttlMs).toISOString(),
  };
}
