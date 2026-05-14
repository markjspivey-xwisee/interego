# Recovery flows — losing a credential, migrating a pod, rotating a wallet

This document describes what to do when the worst happens: you've lost
your only passkey, your wallet seed phrase is gone, your pod host shut
down, your compliance signing key was compromised. The substrate's
recovery surface composes existing primitives — nothing is hand-coded
for these scenarios.

Read this **before** you need it. Several flows require having at
least one alternate credential registered, which is much easier to
set up while you still have your primary.

## Decision tree

```
What did you lose?
├─ Single device with your only passkey → §1
├─ Hardware wallet / seed phrase → §2
├─ All credentials (worst case) → §3
├─ Pod host (CSS server is down / migrating) → §4
├─ Compliance signing wallet (or it was compromised) → §5
└─ Bearer token / OAuth session only → §6 (easy — re-enroll)
```

## §1 — Lost a passkey (still have another credential)

**Scenario:** Your laptop's Touch ID died. You still have your
MetaMask wallet registered to the same account.

1. From any device with another working credential, sign in to the
   identity server's `/dashboard`. The OAuth flow runs the SIWE / DID
   ceremony for whichever credential you still have.

2. The dashboard's **Credentials** panel lists every passkey / wallet
   / DID registered to your account. Find the lost passkey by its
   `createdAt` date or transports list.

3. Revoke it:

   ```bash
   curl -X DELETE \
     -H "Authorization: Bearer $TOKEN" \
     https://your-identity-host/auth-methods/me/webauthn/<credentialId>
   ```

   The endpoint refuses to remove your LAST auth method (preventing
   accidental lockout — see §3 if you need to). It will succeed when
   you have other credentials.

4. Optionally enroll a replacement passkey on a new device by
   visiting the landing page `/` and re-running the passkey flow with
   your bearer token attached (`Authorization: Bearer …`). The
   identity server appends the new passkey to your existing auth-
   methods rather than creating a new account.

## §2 — Lost wallet seed (still have a passkey)

Same shape as §1. From the dashboard, revoke the lost wallet via:

```bash
curl -X DELETE \
  -H "Authorization: Bearer $TOKEN" \
  https://your-identity-host/auth-methods/me/wallet/<address>
```

Then enroll a new wallet via `/connect` (with your bearer token
attached).

**Important:** Solely Ethereum-wallet-based accounts that lose the
private key are in the §3 case — there is no recovery without a
second credential.

## §3 — Lost ALL credentials (worst case)

**There is no protocol-level recovery for this case.** Interego is
designed so the operator never holds your keys; no key, no access.
The substrate has no email-reset, no password-recovery, no SMS-OTP
fallback by design.

What you can do:

1. **Your pod data is still there.** Anyone with read access to your
   pod (which is public for unencrypted content; deliberately
   restricted for encrypted) can still see what's there. You just
   can't WRITE through your identity anymore.

2. **Recover via bootstrap invite if you're a seeded user.** If the
   operator has a `BOOTSTRAP_INVITES` entry for you that hasn't been
   consumed yet, you can claim the userId with a fresh credential.
   This is the `markj` / `alice` seeded-userId path. Operator runs:

   ```bash
   # On the identity server's host:
   export BOOTSTRAP_INVITES="${BOOTSTRAP_INVITES},your-userid:$(openssl rand -hex 32)"
   # Restart the identity container
   ```

   Then you enroll via the landing page with the invite token
   (`bootstrapUserId` + `bootstrapInvite` in the request body). This
   appends a fresh credential to your seeded userId. **One-time
   only** — consumed on first use.

3. **Cut your losses + start over.** Enroll a new account from
   scratch. Your old pod data remains on disk and is auditable;
   your new account will have a fresh DID. Inviters who shared
   things with the old DID need to re-share to the new one.

**Prevention:** Register at least two credentials of different
families (passkey + wallet, or passkey + did:key) before you ever
need recovery. The dashboard's Credentials panel encourages this.

## §4 — Pod host is down / migrating

Your pod URL points at a CSS instance that's gone offline (host
shutdown, region failover, migration in progress).

1. **For brief outages:** retry. The substrate's read paths tolerate
   transient pod-unavailable conditions; descriptor writes will fail
   loudly but most operations don't break catastrophically.

2. **For permanent migration:** publish a new pod URL to your
   identity record AND retain the old DID by issuing a
   `cg:supersedes` chain from the old pod's auth-methods to the new
   pod's. The old pod's descriptors are preserved on the URL; new
   activity goes to the new pod.

   The protocol-pure way:

   ```
   1. Spin up CSS pod at new URL.
   2. Copy /<userId>/auth-methods.jsonld from old pod to new pod.
   3. Publish a `cg:supersedes` descriptor on the OLD pod pointing
      at the new pod URL — readers walking your old DID find it.
   4. (Optionally) configure DNS so your DID's well-known WebID
      resolves to the new host.
   ```

   This is essentially `passport:Migration` from the passport vertical
   (`src/passport/`). The L3 passport ontology models exactly this:
   the agent's biographical identity survives infrastructure changes
   because the DID is portable.

## §5 — Compliance wallet rotation

Your compliance signing key was leaked. Old descriptors signed by it
need to remain verifiable (they were legitimate at the time); new
descriptors must be signed by a fresh key.

```typescript
import { rotateComplianceWallet, listValidSignerAddressesAt } from '@interego/core';

// Generate fresh active key; move old one to history with retiredAt timestamp
const result = await rotateComplianceWallet('/path/to/wallet.json');
console.log(`Retired ${result.retiredAddress}; new active ${result.newActiveAddress}`);
```

**Time-bounded verification** (Sec audit #6) — a verifier inspecting
an old descriptor should NOT just trust `listValidSignerAddresses`
(which returns every wallet ever seen). Instead, check the wallet's
validity window against the descriptor's `prov:wasGeneratedBy`
timestamp:

```typescript
const validAtSigning = listValidSignerAddressesAt(walletPath, new Date(descriptorSignedAt));
// validAtSigning contains only the wallet(s) that were active at the
// signing moment — refuses signatures from wallets that were not yet
// active (or had already been retired).
```

If your wallet was compromised AT TIME X, manually patch
`wallet.json`'s history to set the compromised wallet's
`retiredAt` to X. Any verifier using `listValidSignerAddressesAt`
will refuse descriptors signed after X by the compromised key —
even if the attacker still holds the private key.

## §6 — Bearer token / OAuth session

These are short-lived (1h access tokens, 14d refresh tokens). If
you've lost one, just restart the OAuth flow in your client —
typically by hitting any tool that requires authentication, which
triggers a new browser flow.

If you suspect a token leaked and want to revoke ALL active tokens
for your account (sign out everywhere):

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  https://your-identity-host/tokens/me/sign-out-everywhere
```

Or click "Sign out everywhere" in the dashboard.

## Operator recovery (for the maintainer of the hosted reference)

If the maintainer needs to recover the deployment itself (not an
individual user):

- **Identity-server keypair** lost: the server's DID document points
  at a specific Ed25519 key. Regenerating means every existing token
  becomes invalid (forced re-auth across all users) AND the DID
  document changes (federation breaks until upstreams refetch).
  Strongly avoid; back this up.

- **CSS / pod data** lost: pods are stateful. Azure Files backups
  cover this. Restoring data is a routine operator action;
  see `spec/OPS-RUNBOOK.md` §11.

- **Compliance wallet** at the deployment level: rotate via
  `rotateComplianceWallet`. New descriptors sign with the fresh key;
  old descriptors remain verifiable via the wallet's history.

## See also

- [`deploy/identity/AUTH-ARCHITECTURE.md`](../deploy/identity/AUTH-ARCHITECTURE.md) — first-principles auth model + threat model
- [`spec/OPS-RUNBOOK.md`](../spec/OPS-RUNBOOK.md) — operator-side procedures
- [`src/passport/`](../src/passport/) — `passport:Migration` reference runtime for infrastructure migration
- [`src/compliance/`](../src/compliance/) — wallet rotation API
