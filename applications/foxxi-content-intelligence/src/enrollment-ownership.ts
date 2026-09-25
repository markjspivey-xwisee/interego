/**
 * Whose pod is it? The rule self-sovereign enrolment applies, and the membership read after it.
 *
 * ── ★★ ENROLMENT USED TO ANSWER "WHOEVER ASKS FIRST" ──────────────────────────────────────────
 *
 * `foxxi.register_self_sovereign_learner` wrote the recovered signer into the named pod's public
 * membership, and the only protection was a 409 for a pod that ALREADY had a member. It never asked
 * whether the pod was the signer's. So the first signer to name any unclaimed pod owned it, and
 * because every later call keys membership on the recovered address, a squatter on
 * `…/eth-<victim>/` could lock the real owner out with that 409, read the victim's engine-graded
 * evidence through the standings and the claim's evidence list (evidence is read by POD), and have
 * credentials issued into the victim's wallet. Found by a code survey, 2026-09-24.
 *
 * ── WHAT A SIGNATURE CAN PROVE ─────────────────────────────────────────────────────────────────
 *
 * A wallet signature proves one thing: control of that wallet. So enrolment can establish exactly
 * one kind of ownership, of a pod whose NAME says which wallet it belongs to (`eth-<12 hex>`,
 * which a bare did:ethr derives, and its `u-eth-` twin, which the identity service creates), and
 * only when that wallet is the signer. The comparison is the bridge's own, the one `selfBoundPod`
 * makes for every write: one principal with the twins folded (`samePodPrincipal`), on one store
 * (`sameStore`). They are passed in rather than copied, because a rule written twice disagrees
 * with itself eventually.
 *
 * Everything else is refused, and the refusal says which case it is:
 *   · a request signed FOR someone else (a relay session, a delegate): the membership would be
 *     keyed on a key that signs for many identities, and would admit all of them;
 *   · a path inside a pod rather than a pod root: the membership belongs at the root;
 *   · a pod whose name says no wallet (a passkey `u-pk-` pod, a `u-did-` pod, a named tenant):
 *     nothing a signature carries can say whose it is, and the alternative is first-come;
 *   · another wallet's pod, or a pod on another store.
 *
 * ★ ONE CAUTION ABOUT THE COMPARISON. `samePodPrincipal` reads a URL's LAST path segment, so on a
 * path inside a pod (`…/eth-victim/eth-signer/`) it would compare the signer's segment while the
 * pod is the victim's. Every comparison here is therefore made on the pod a URL is IN, its origin
 * and first segment, never on the URL as given.
 */

/** The bridge's own comparisons, passed in so this rule and `selfBoundPod` cannot drift apart. */
export interface OwnershipRules {
  /** Do two pod URLs name one principal? The bridge passes `samePodPrincipal` (twins folded). */
  readonly samePrincipal: (a: string, b: string) => boolean;
  /** Are two URLs one store? The bridge passes `sameStore`. */
  readonly sameStore: (a: string, b: string) => boolean;
  /** The pod a wallet's own did:ethr derives. The bridge passes `resolveSubjectPodUrl`. */
  readonly podOfWallet: (address: string) => string;
}

export type EnrollmentRefusal = 'signed-for-another' | 'not-a-pod-root' | 'owner-not-in-name' | 'another-wallets-pod' | 'another-store';

export type EnrollmentDecision =
  | { readonly ok: true; readonly podRoot: string }
  | {
    readonly ok: false;
    /** Which rule refused, for the refusal's wording and for tests. */
    readonly refused: EnrollmentRefusal;
    readonly status: 400 | 403;
    readonly reason: string;
    readonly error: string;
    /** The pod the signer CAN enroll. */
    readonly yourPod: string;
  };

const ADDRESS = /0x[0-9a-f]{40}/i;
/** A pod named for a wallet: what own-pod derivation and the identity service both produce. */
const WALLET_POD_NAME = /^(?:u-)?eth-[0-9a-f]{12}$/i;

/** The pod a URL is in: its origin and first path segment. A path inside a pod belongs to that pod. */
export function podContaining(url: string): string | null {
  try {
    const u = new URL(url);
    const segment = u.pathname.split('/').filter(Boolean)[0];
    return segment ? `${u.origin}/${segment}/` : null;
  } catch { return null; }
}

/** Is a URL exactly a pod root: one path segment, and nothing after it? */
export function isPodRoot(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.split('/').filter(Boolean).length === 1 && !u.search && !u.hash;
  } catch { return false; }
}

/** Is the pod a URL is in named for a wallet, so that a wallet signature can say whose it is? */
export function isWalletPod(url: string): boolean {
  const pod = podContaining(url);
  return pod !== null && WALLET_POD_NAME.test(pod.replace(/\/$/, '').split('/').pop() ?? '');
}

/** Does this wallet own the pod a URL is in? Only a pod named for a wallet can say. */
export function walletOwnsPod(address: string, url: string, rules: OwnershipRules): boolean {
  const pod = podContaining(url);
  if (!/^0x[0-9a-f]{40}$/i.test(address) || pod === null || !isWalletPod(pod)) return false;
  const own = rules.podOfWallet(address);
  return rules.samePrincipal(pod, own) && rules.sameStore(pod, own);
}

/**
 * Does a membership row still authorize its wallet on this pod? On a pod named for a wallet, only
 * that wallet's row does. A pod whose name says no wallet has no owner to check against, so its
 * membership stands as written.
 */
export function membershipHolds(address: string, url: string, rules: OwnershipRules): boolean {
  return !isWalletPod(url) || walletOwnsPod(address, url, rules);
}

/**
 * May this signer enroll this pod? `agentId` is who the signed payload says is asking; the
 * membership records the signer, so the two have to be the same wallet.
 */
export function enrollmentDecision(input: { podUrl: string; signer: string; agentId: string }, rules: OwnershipRules): EnrollmentDecision {
  const { podUrl, signer, agentId } = input;
  const yourPod = rules.podOfWallet(signer);
  const refuse = (refused: EnrollmentRefusal, status: 400 | 403, reason: string, error: string): EnrollmentDecision => ({ ok: false, refused, status, reason, error, yourPod });
  const claimed = ADDRESS.exec(agentId)?.[0];
  if (!claimed || claimed.toLowerCase() !== signer.toLowerCase()) {
    return refuse('signed-for-another', 403,
      'enrolment records the signing wallet as the pod\'s owner, and this request was signed for another identity',
      `self-enrollment must be signed by the wallet it enrolls, for itself: the signature recovers ${signer} but agent_id is ${agentId}. A key that signs for other identities, such as a relay session or a delegate, would make its membership theirs as well. Sign with your own wallet and agent_id = did:ethr:<that address>. A relay connection reaches the SCORM engine and the signed credential routes without enrolling.`);
  }
  const pod = podContaining(podUrl);
  if (pod === null || !isPodRoot(podUrl)) {
    return refuse('not-a-pod-root', 400, 'the pod named is not a pod root',
      `tenant_pod_url must name a pod root (https://<store>/<pod>/), not a path inside one: ${podUrl}. Your wallet's pod is ${yourPod}.`);
  }
  if (!isWalletPod(pod)) {
    return refuse('owner-not-in-name', 403,
      'the pod\'s name does not say which wallet owns it, so a wallet signature cannot prove ownership of it',
      `${pod} is not named for a wallet (eth-<12 hex> or u-eth-<12 hex>), so nothing in a signature says whose it is, and enrolling it would make it whoever asked first. Enroll the pod your wallet is named for: ${yourPod}.`);
  }
  if (!rules.samePrincipal(pod, yourPod)) {
    return refuse('another-wallets-pod', 403, 'the pod is named for another wallet',
      `${pod} belongs to the wallet it is named for, not to ${signer}. Enroll your own pod: ${yourPod}, or its u-eth- spelling if the identity service made yours.`);
  }
  if (!rules.sameStore(pod, yourPod)) {
    return refuse('another-store', 403, 'the pod is on a store this bridge cannot prove your ownership on',
      `${pod} is named for your wallet but is not on this deployment's pod store, so a signature cannot show it is yours. Enroll ${yourPod}.`);
  }
  return { ok: true, podRoot: pod };
}

/**
 * The members a wallet pod keeps when its owner enrolls: the rows whose wallet owns the pod. Any
 * other row could only have been written first-come, before enrolment asked whose pod it was, and
 * keeping it would lock the owner out of their own pod with the single-owner 409.
 */
export function ownersOf<M extends { wallet_address?: string }>(members: readonly M[], podRoot: string, rules: OwnershipRules): { kept: M[]; displaced: M[] } {
  const kept: M[] = [];
  const displaced: M[] = [];
  for (const m of members) (walletOwnsPod(String(m.wallet_address ?? ''), podRoot, rules) ? kept : displaced).push(m);
  return { kept, displaced };
}
