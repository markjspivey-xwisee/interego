# Auth architecture — Interego identity

This note captures the first-principles shape of identity in Interego so future changes don't accidentally drift toward centralized conventions.

## Principles

1. **User sovereignty.** Every private key stays with the user. The server only holds public keys and verifies signatures. There are no passwords anywhere in the system.
2. **Pod as source of truth.** Each user's credential data (wallet addresses, WebAuthn credentials, DID keys) lives in their own Solid pod at `<pod>/auth-methods.jsonld`, serialized as JSON-LD against the `cg:` + `sec:` vocabularies. The identity server is **stateless** for user data; a container restart loses no durable state. Token state is likewise not in-memory: identity-server bearer tokens are HMAC-signed self-contained strings (no server-side token table), and relay-issued OAuth tokens are mirrored to a service-account pod (see OAuth 2.1 layer below). Sessions survive every redeploy.
3. **DID is canonical; userId is derived.** `did:web:<identity-host>:users:<id>` is the portable identity, and `<id>` itself is a deterministic function of the first credential enrolled (`u-pk-<hash>`, `u-eth-<addr-prefix>`, `u-did-<hash>`). **The server never trusts a user-supplied userId claim** — the only strings an unauthenticated caller can influence are their own credential material. WebAuthn, SIWE, and DID-key signatures are *verification methods* registered to that DID — interchangeable, addable, removable without identity-level disruption.
4. **W3C standards, not bespoke.** DID Core, WebID, Solid, SIWE (ERC-4361), WebAuthn, VC / Verifiable Credentials — every piece of the auth stack maps to a published standard.

## Layout

```
┌───────────────────────┐         ┌──────────────────────────┐
│ identity server       │         │ Solid pod (per user)     │
│ (stateless verifier)  │         │                          │
│                       │  read   │  /auth-methods.jsonld    │
│  - resolves DIDs      │ ◄────── │    walletAddresses[]     │
│  - verifies sigs      │         │    webAuthnCredentials[] │
│  - issues challenges  │  write  │    didKeys[]             │
│  - issues tokens      │ ──────► │                          │
│  - in-memory cache    │ (async, │  (in-memory cache is     │
│    authoritative      │ deferred│   authoritative until    │
│    pre-write)         │  after  │   deferred write lands)  │
│                       │  resp.) │                          │
└───────────────────────┘         └──────────────────────────┘
         ▲                                 ▲
         │ OAuth 2.1 + PKCE + DCR          │ stored as JSON-LD
         │                                 │ readable by any RDF tool
┌───────────────────────┐                  │
│ mcp-relay             │                  │
│ (OAuth resource srv)  │──────────────────┘
│                       │        same user, agent writes
│  - verifies tokens    │        context descriptors here
│  - mounts MCP         │
└───────────────────────┘
```

## Verification methods

| Method | Key custody | First-time flow | Repeat sign-in |
|---|---|---|---|
| **SIWE** (ERC-4361) | User's Ethereum wallet (MetaMask, Coinbase, hardware, etc.) | Connect wallet → sign SIWE message with fresh nonce → server recovers address via `ethers.verifyMessage` → mints `u-eth-<addr[0:12]>` userId → applies `walletAddresses[]` to the in-memory cache and returns the token; the pod write is mirrored asynchronously after the response (see [Deferred pod writes](#deferred-pod-writes)) | Same signature path; `walletIndex[address]` lookup resolves user |
| **WebAuthn / passkey** | OS secure enclave (iCloud Keychain / Google Password Manager / hardware key) | `navigator.credentials.create` (userHandle is a transient `u-pend-<rand>` at options time) → `verifyRegistrationResponse` → server derives `u-pk-<sha256(credId)[0:12]>` → credential applied to the in-memory cache; the pod write to `webAuthnCredentials[]` is mirrored asynchronously after the response (see [Deferred pod writes](#deferred-pod-writes)) | Discoverable credentials: `navigator.credentials.get` with empty `allowCredentials` → `credentialIndex[response.id]` resolves user → `verifyAuthenticationResponse`, counter bumped in pod |
| **DID Ed25519** | User-managed `did:key` or `did:web` with off-server private key | Client signs server nonce with private key → server verifies with public key → mints `u-did-<sha256(did)[0:12]>` → applies `didKeys[]` to the in-memory cache and returns the token; the pod write is mirrored asynchronously after the response (see [Deferred pod writes](#deferred-pod-writes)) | Same signature path; `didIndex[did]` lookup resolves user |

### Deferred pod writes

`/auth/*` enrollment endpoints do **not** block the response on the pod write. The server first calls `inlineApplyAuthMethods` (in-memory cache + index rebuild), returns the token, and then schedules the pod write via `scheduleDeferredAuthMethodsWrite` (`deploy/identity/server.ts`):

- The write runs on the next event-loop tick (`setImmediate`, after the response socket flush), under a **per-userId mutex** so a fast subsequent read still sees the freshest data via the cache and writes serialize cleanly.
- Failures retry with backoff: **3 retries at 1s / 2s / 4s** (4 attempts total). On final failure the in-memory record stays authoritative for the process lifetime — the next successful login with the same credential re-derives the same content-addressed userId and re-attempts the write, so the system is self-healing on next sign-in.
- Final failure logs at ERROR with the metric name `identity_deferred_authmethods_failed` (userId + context tagged). **Operators should alert on this log line** — sustained occurrences mean enrollments are surviving in memory but not persisting to the pod, and a container restart before a successful re-login would lose them.

### `did:key` encoding (Ed25519)

The server emits and accepts the W3C did:key Method Spec canonical form:

```
did:key:z<base58btc(0xed 0x01 || rawPubKey32)>
```

where `z` is the multibase base58btc prefix and `0xed 0x01` is the varint-encoded multicodec for `ed25519-pub`. A real example looks like `did:key:z6MkpTHR8VNsBx…`. The same encoding is used for the `publicKeyMultibase` field of every `Ed25519VerificationKey2020` we emit.

For back-compat with clients that registered against earlier server builds (which emitted `'z' + base64url(rawKey32)`), the decode path falls back to base64url and emits a `Deprecation: true` response header so the client can migrate. A future server version will turn this into a hard `400`.

### Three modes of first-enrollment

Every `/auth/*` endpoint picks one of three modes based on the request, and **the mode is fixed at options-time so /register cannot be coerced**:

1. **Fresh user (default).** No `Authorization` header, no `bootstrapUserId`. Server derives the userId from the credential being enrolled. Attacker cannot steal someone else's userId because the userId is a function of a keypair they don't control.
2. **Add another device to the caller's existing account.** Request carries `Authorization: Bearer <token>` for user *X*. Server binds the new credential to *X*. Used when adding a second passkey / another wallet / another DID to an existing account.
3. **Bootstrap-claim a seeded legacy userId.** Request carries `{ bootstrapUserId, bootstrapInvite }`. The invite is configured server-side in `BOOTSTRAP_INVITES=userA:tokenA,userB:tokenB` and is single-use — once consumed, or once the seeded user has any credential on file, the invite flow refuses. Used exactly once per legacy user (e.g. `markj`) to bind their very first credential to the seeded pod path. All subsequent devices for that user enroll via mode (2).

### Canonical identity lookup

- `walletIndex: address → userId` (built from all pods' `walletAddresses[]`)
- `credentialIndex: credentialId → userId` (built from all pods' `webAuthnCredentials[]`)
- `didIndex: did → userId` (built from all pods' `didKeys[]`)

These indexes are rebuilt on container startup from pod scans. The authenticate endpoints *only* consult these indexes — they do not accept a userId claim in the body. If the signed credential material doesn't match an indexed entry, authentication fails.

## OAuth 2.1 layer

- DCR (RFC 7591) on `/register` — no client pre-registration required.
- Authorization code + PKCE mandatory — public clients only, no client secrets.
- Identity-backed `/authorize` page renders method-picker HTML; browser JS runs the signature ceremony against the identity server's `/auth/*` endpoints.
- On successful verification, the relay issues:
  - **Access token** (1h TTL) carrying the user's { userId, agentId, ownerWebId, podUrl } in the token's `extra` field — MCP handlers attribute writes to the real user.
  - **Refresh token** (14d TTL, rotating on every use) for long-running sessions.
- **Relay token persistence.** Access + refresh tokens are mirrored to the `svc-relay-dcr` service-account pod under sibling `tokens/` and `tokens-refresh/` subcontainers. Filenames are `sha256(token).hex` so the raw bearer never lands on disk; the OAuth provider exposes swappable `persistAccessToken` / `removeAccessToken` / `lookupAccessTokenByRaw` (and refresh-token equivalents) hooks. Existing claude.ai / ChatGPT sessions survive relay redeploys instead of 401-ing until reauthorized.
- **Identity-server tokens are stateless HMAC-signed strings.** Format: `cg2_<base64url(payload)>.<base64url(hmac-sha256)>`, signed with `TOKEN_SIGNING_KEY` (stable across deploys). Payload carries `{ userId, agentId, scope, issuedAt, expiresAt, epoch }`. There is no in-memory token Map — verification is signature check (`timingSafeEqual`) + expiry + identity-presence + `sessionEpoch` check against the user's `auth-methods.jsonld`. Revocation is per-user: `POST /tokens/me/sign-out-everywhere` increments the pod's `sessionEpoch`, instantly invalidating every prior token for that user without a global flush.
- `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` let any MCP client auto-discover the auth flow.

### Discovery endpoints — WebFinger (RFC 7033)

The identity server mounts RFC 7033 WebFinger at `/.well-known/webfinger` (see `deploy/identity/webfinger.ts` and `server.ts:3182`). It is the discovery surface that lets an `acct:user@host` handle resolve to the user's WebID, did:web, and pod URL — and is used by `share_with`, the name service, and federation discovery.

- **Resource form.** `?resource=acct:<userId>@<host>` (RFC 7033 §4.5). HTTP(S) courtesy forms `https://<host>/users/<id>` and `https://<host>/agents/<id>` are also accepted.
- **Optional rel filter.** Repeated `?rel=<rel>` filters `links[]` only (RFC 7033 §4.3); `aliases` are unchanged.
- **Content type.** `application/jrd+json` (RFC 7033 §4.4). 404 responses carry an empty body.
- **Canonical `subject`.** The `subject` in every successful response is the canonical `acct:<userId>@<host>` — never the displayName the requester sent — so federation crawlers converge on one form per identity. If the caller used a displayName alias (e.g. `acct:markj@host` resolving to `u-pk-…`), the displayName form is added to `aliases[]` instead of replacing `subject`.
- **User JRD shape.**
  - `aliases`: `[ <webId>, did:web:<host>:users:<id>, <podUrl> ]` (plus the displayName `acct:` form if used).
  - `links`:
    - `http://webfinger.net/rel/profile-page` (`text/turtle`) → WebID profile
    - `http://www.w3.org/ns/pim/space#storage` → pod root URL
    - `http://www.w3.org/ns/solid/terms#oidcIssuer` → identity server base URL
    - `self` (`application/did+ld+json`) → DID document
- **Agent JRD shape.** Similar, plus `prov:actedOnBehalfOf` linking to the owner's WebID.

## Threat model: userId-claim hijack (closed)

A naïve implementation would let a caller type *any* userId on the enrollment page and bind their own credential to it. That pattern let an attacker who learned a display-alias like `markj` attach their passkey to the real user's account, issue bearer tokens for them, and — because the passkey went into the pod's `auth-methods.jsonld` — survive container restarts indistinguishably from legitimate credentials.

The current code closes this by removing user-supplied userId claims everywhere:

- `/auth/webauthn/register-options` no longer accepts `userId`. It accepts a display `name` and optional bootstrap/bearer proof. The WebAuthn `userHandle` is a transient `u-pend-<rand>` unless mode (2) or (3) applies.
- `/auth/webauthn/register` derives the final userId from the credential itself and binds it to a seeded userId *only* if a matching single-use bootstrap invite was already validated at options time.
- `/auth/siwe` and `/auth/did` follow the same three-mode pattern — userId is derived from address / DID unless a bearer token or bootstrap invite authorises binding to a different user.
- `/auth/webauthn/authenticate` resolves the user via `credentialIndex[response.id]`, ignoring any body-supplied userId hint.
- `/register` now returns **410 Gone** — there is no reason to reserve a userId without proving key-ownership.
- `/wallet/link` now requires `Authorization: Bearer <token>` and binds to the token's user (the previous unauthenticated variant let any caller attach a foreign wallet to any user's account).

### Bootstrap invite configuration

```bash
BOOTSTRAP_INVITES="markj:<long-random-token>,alice:<another-token>"
```

- Tokens are generated out-of-band (e.g. `openssl rand -hex 32`) and handed to the user via a side channel.
- An invite is consumed exactly once: on the first successful enrollment for that userId. After consumption — or once the seeded pod has any credential on file — the invite flow refuses, so even a restarted container cannot replay the bootstrap.
- Not setting `BOOTSTRAP_INVITES` simply means no seeded legacy users can be first-enrolled. New users go straight to `u-pk-…` / `u-eth-…` / `u-did-…` derived identities.

### Self-audit endpoint

```
GET /auth-methods/me
Authorization: Bearer <identity-token>
```

Returns the full `auth-methods.jsonld` doc for the token's user — wallet addresses, WebAuthn credential IDs + `createdAt` + transports, DID keys + `createdAt`. Public-key bytes and WebAuthn counters are intentionally omitted (they're in the pod already and not useful for audit). Use this to verify no foreign credentials have accreted to your account (historical risk under the pre-fix userId-claim hijack).

### Per-surface agent detection (relay side)

The MCP relay mints per-user agents of the form `<surface>-<userId>` on the user's pod. The `<surface>` slug is derived automatically at OAuth completion time from the DCR-registered `client_name`:

| OAuth `client_name` pattern | Surface slug |
|---|---|
| `Claude Code (VS Code)` / `VSCode` | `claude-code-vscode` |
| `Claude Code` | `claude-code` |
| `Claude Desktop` / Mac / Windows | `claude-desktop` |
| `Claude Mobile` / iOS / Android | `claude-mobile` |
| `Claude` (anything else) | `claude` |
| `ChatGPT` | `chatgpt` |
| `OpenAI Codex` | `openai-codex` |
| bare `Codex` | `codex` |
| `Cursor`, `Windsurf`, `Cline`, `Zed`, `Continue` | their own slug |
| otherwise slugifiable (matches `^[a-z][a-z0-9-]{1,31}$`) | that slug |
| missing / unslugifiable | `RELAY_DEFAULT_SURFACE_AGENT` (default `mcp-client`) |

Two relay env vars control the fallback:

- `RELAY_DEFAULT_SURFACE_AGENT` (default `mcp-client`) — used when the OAuth `client_name` is missing or unrecognised. **Deliberately NOT `claude-*`** so an unknown client doesn't silently masquerade as Claude.
- `RELAY_SURFACE_AGENT` — legacy alias, kept so old deployments keep working.

A deployment that always serves a single surface (e.g. a dedicated mobile-only relay) can set `RELAY_DEFAULT_SURFACE_AGENT=claude-mobile` to pin the label.

## Known-good tradeoffs, documented

**WebAuthn credentials are RP-bound** to the origin they were registered at (spec-mandated; passkeys are cryptographically scoped to an RP ID). If Interego ever moves to a new public URL, users re-enroll their passkey for the new origin. This is *not* a sovereignty loss — the user's DID, wallet, and did-key methods all remain portable across origins, and WebAuthn is explicitly positioned as one of several methods, not the canonical one. Users concerned about origin lock-in should enroll a DID or wallet method in addition to their passkey.

**Tokens are bearer tokens** by default (stolen token = usable token). DPoP (RFC 9449) is the standard mitigation — cryptographic proof-of-possession on every request. MCP spec lists DPoP as optional and most clients don't implement it yet, so we haven't forced it. When MCP client support matures, DPoP slots into this architecture with no other changes (add a per-request JWT signed by a client-held key, server verifies on `/mcp`).

**Pod durability** depends on CSS persistence. The identity server is provably stateless, but CSS itself runs in-memory by default on Azure Container Apps. Long-term durability requires configuring CSS with a persistent backend (file store on Azure Files volume, quadstore in Postgres, etc.). This is a deploy-level concern separate from the identity-layer architecture.

**Deferred pod writes trade a small durability window for response latency.** `/auth/*` enrollment responses race ahead of the pod write (see [Deferred pod writes](#deferred-pod-writes)). The window between response and pod-write completion is small (single-digit seconds in the happy path) but non-zero: a process crash inside that window loses the persisted record, though the user can recover by signing in again with the same credential. The mitigation is the `identity_deferred_authmethods_failed` ERROR-level log line plus the 3-attempt 1s/2s/4s backoff — operators alert on the metric and the in-memory cache stays authoritative until the write lands.

## Extending

- **New verification method.** Implement a `/auth/<method>` endpoint that validates a signature over a `/challenges`-issued nonce, resolves the user via the appropriate index (or first-time flow), and returns the standard token response. Add a corresponding card to the relay's authorize page with client-side ceremony JS.
- **External identity server.** Point the relay at a different `IDENTITY_URL`; the identity server is federation-friendly (DIDs + WebFinger are resolvable by any conforming client).
- **Decentralized identity proof (VC-style).** The DID method already hands you a signed nonce; layer a W3C Verifiable Credential on top for claims ("is over 18", "is a member of X") without centralized attestation.
