# Auth architecture — Interego identity

This note captures the first-principles shape of identity in Interego so future changes don't accidentally drift toward centralized conventions.

## Principles

1. **User sovereignty.** Every private key stays with the user. The server only holds public keys and verifies signatures. There are no passwords anywhere in the system.
2. **Pod as source of truth.** Each user's credential data (wallet addresses, WebAuthn credentials, DID keys) lives in their own Solid pod at `<pod>/auth-methods.jsonld`, serialized as JSON-LD against the `iep:` + `sec:` vocabularies. The identity server is **stateless** for user data; a container restart loses no durable state. Token state is likewise not in-memory: identity-server bearer tokens are HMAC-signed self-contained strings (no server-side token table), and relay-issued OAuth tokens are mirrored to a service-account pod (see OAuth 2.1 layer below). Sessions survive every redeploy.
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
| **SIWE** (ERC-4361) | User's Ethereum wallet (MetaMask, Coinbase, hardware, etc.) | Connect wallet → sign SIWE message with fresh nonce → server recovers address via `ethers.verifyMessage` → mints `u-eth-<addr[0:12]>` userId → applies `walletAddresses[]` to the in-memory cache and returns the token; the pod write is mirrored asynchronously after the response (see [Deferred pod writes](#deferred-pod-writes)) | Same signature path; `walletIndex[address]` lookup resolves user. The nonce comes from `POST /challenges` with `purpose: "siwe"`; `/auth/siwe` consumes it (single-use, 5 minutes) and requires an exact ERC-4361 message (see `siwe-message.ts`) whose domain line and URI name this deployment (this server, its relay, a `WEBAUTHN_RP_ORIGINS` origin or a `SIWE_DOMAINS` host), whose address line is the signing wallet in EIP-55 form, whose `Nonce` field is that nonce and whose `Issued At` fits the challenge. That is the only wallet sign-in: `POST /siwe/verify` and `POST /siwe/nonce` answer 410 Gone (see [Wallet proofs need a server nonce and this server's domain](#threat-model-wallet-proofs-need-a-server-nonce-and-this-servers-domain)) |
| **WebAuthn / passkey** | OS secure enclave (iCloud Keychain / Google Password Manager / hardware key) | `navigator.credentials.create` (userHandle is a transient `u-pend-<rand>` at options time) → `verifyRegistrationResponse` → server derives `u-pk-<sha256(credId)[0:12]>` → credential applied to the in-memory cache; the pod write to `webAuthnCredentials[]` is mirrored asynchronously after the response (see [Deferred pod writes](#deferred-pod-writes)) | Discoverable credentials: `navigator.credentials.get` with empty `allowCredentials` → `credentialIndex[response.id]` resolves user → `verifyAuthenticationResponse`, counter bumped in pod |
| **DID Ed25519** | User-managed `did:key` or `did:web` with off-server private key | `did:key` only: client signs server nonce with private key → server verifies with the key the DID encodes → mints `u-did-<sha256(did)[0:12]>` → writes `didKeys[]` to the pod (see `first-sign-in.ts`) and returns the token. Any other DID (`did:web`, …) is verified against a key the caller sends in `publicKeyMultibase`, and no DID document is fetched, so it cannot open an account: it is added from a signed-in account (bearer token) or with a bootstrap invite, and a bearer cannot add one that another account lists: `401` when a loaded account lists it with another key (the sign-in check refuses it before the bearer is looked at), `409` when the account derived from the DID lists it and is loaded only then, and `503` for any such add while accounts are loading (see *While accounts are loading*) | Same signature path; `didIndex[did]` lookup resolves user. A DID that is not a `did:key` signs in only if that account lists the same Ed25519 key for it (compared as raw bytes); when it does not, the account derived from the DID is tried before refusing |

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

- `walletIndex: address → userIds` (built from all pods' `walletAddresses[]`)
- `credentialIndex: credentialId → userIds` (built from all pods' `webAuthnCredentials[]`)
- `didIndex: did → userIds` (built from all pods' `didKeys[]`)

These indexes are rebuilt on container startup from pod scans. The authenticate endpoints *only* consult these indexes — they do not accept a userId claim in the body. If the signed credential material doesn't match an indexed entry, authentication fails.

Each index maps a credential to **every** account that lists it (`credential-index.ts`), never to one. A passkey credential id is not secret (`/challenges` with a `userId` lists that account's ids), and a software authenticator registers any id with its own key, so while a victim's account was not loaded anyone could register the victim's id: the account derived from it is empty, so a fresh registration created it. With one account per credential, whichever account loaded last owned the id, and the victim's sign-ins then failed on and off with every restart and refresh. Now a sign-in tries the holders in a stable order, at most 8 of them. The order ranks only the accounts this server has loaded; *While accounts are loading* below says what that leaves open, and what closes part of it.

- **Order.** Passkey holders, and holders of a DID that is not a `did:key`, are ordered by when the server enrolled the credential there (its `createdAt`; a record without one, written before the field existed, ranks first). A passkey is registered with `none` attestation, so its public key is whatever the registrant sends, and a public key is not secret: someone can register a copy of the owner's key under the owner's id, and the owner's signature then verifies on both accounts. The owner enrolled first, so the owner's account is tried first. A DID that is not a `did:key` is different: `/auth/did` checks a signature by the supplied key over this server's nonce before it writes `didKeys`, so only the key's holder can bind the DID with that key. Anyone else can bind it only with a key of their own, which never verifies the owner's signature; the order keeps the owner among the first 8 tried however many such bindings pile up, and among accounts listing the DID with the same key (all bound by that key's holder) it picks the same one every time. Ties, and wallets and `did:key`s, go to the account derived from the credential, then by id.
- **Passkey:** the challenge is spent first; a challenge scoped to a `userId` tries that account only; then the first 8 holders whose record still lists the credential. More holders than that are not refused (that would let anyone who adds an id to enough accounts lock its owner out); the rest are not tried, and the log says `tried=8`. The first whose stored key verifies the assertion wins and is the only one whose counter is written. Each stored public key is tried once, at its earliest holder: the verifier refuses a sign counter at or below the stored one before it checks the signature, so a later holder storing the same key with a lower counter would otherwise accept an assertion the earlier holder refused. Keys are compared as keys (the SPKI of the decoded COSE key, `publicKeyIdentity` in `passkey-authentication.ts`), not as the stored bytes: the verifier reads the COSE map in any order and ignores labels it does not know, and a copy's registrant picks the encoding. A counter that cannot be written is a `503`, and so is a holder whose record cannot be read (a Play owner's is read again from its pod); either way nothing else is tried. A holder deleted during the sign-in that did not verify is skipped, not reported as the deleted account. When no holder verifies a usernameless sign-in while accounts are loading, the answer is the `503` below, not `401`. Before any holder is tried, the account derived from the id is loaded unless it is a holder already (unreadable: `503`, nothing changed): it is the account a fresh registration of the id opened, and it may list the id without being loaded, while a copy of its key on another account would be the only holder tried.
- **DID that is not a `did:key`:** the first of 8 holders that lists the DID with the key that signed, then the account derived from the DID (while accounts are loading, none of them is a `503`, not `401`). A `did:key` goes to the first loaded holder, the derived account when it is one. When another holder would be chosen, the derived account is loaded first (unreadable: `503`, nothing changed), so the choice does not change once it loads. Every account listing a `did:key` was bound by a signature from its key, so this is a deterministic choice for an ambiguity the key's holder made.
- **Wallet:** the one account listing it, or, when several do, the account derived from the wallet if it is one of them. When another holder would be chosen, or several refused, the derived account is loaded first (unreadable: `503`, nothing changed). With several holders and none derived, the sign-in is refused with `409` and the log says `kind=wallet holders=<n> refused=ambiguous`; that needs every holder loaded, since the choice is among the loaded ones (below). This server adds a wallet to an account only with a signature over its nonce, never while an account it has loaded holds the wallet (`/wallet/link` and the bearer branch of `/auth/siwe` both check), and opens or extends no account for a wallet while some account is not loaded (below). So a wallet on several accounts was bound before `/wallet/link` required this server's nonce (it took any signature the wallet had ever made, so a holder may not be the wallet's own); or by a first sign-in before this server waited for every account to load, which opened the derived account while the account listing the wallet was not loaded (below); or by the other instance during a deploy's overlap (below); or by a write to a pod from outside this server. The derived account is the one the wallet's first sign-in opens; without it, nothing says which holder is the wallet's.

**While accounts are loading.** The order protects an owner only among the accounts this server has loaded. While the owner's account is not loaded, its credential looks new: a wallet's first sign-in would open the account derived from the wallet, which then takes the wallet's sign-ins for good once the owner's account loads (the derived account is preferred); a `did:key` would do the same; and anyone could register an unloaded owner's passkey id with a copy of the owner's public key, after which the owner's usernameless sign-ins find only the copy and sign in to it. So while the index is incomplete (`/health` reports `accountIndex.complete: false`), a credential no loaded account holds opens no account, and a passkey, a wallet or a DID that is not a `did:key` joins none: a first-time `/auth/siwe` or `/auth/did` (derived or bootstrap) and every `/auth/webauthn/register-options` and `/auth/webauthn/register` (fresh, bootstrap or add-device) answer `503 Interego is still loading accounts`, write nothing, and leave a bootstrap invite unspent; adding a wallet with a bearer was already a `503` then. A passkey is refused at `/register-options`, after the bearer and invite checks and before the seeded account's pod is read, so no ceremony starts: refused only at `/register`, the browser would already have stored a discoverable passkey that no account lists, one more with every retry. `/register` refuses too, for a challenge taken from `/challenges` without the options. An account that already lists the credential is still signed in to: the first-time path reads the derived account's pod and creates nothing. That includes a wallet sign-in with `existingOnly` (the relay's `/sign-action` page), which opens nothing and adds the wallet to nothing at any time: it reads the derived account's pod like any first sign-in, and while accounts are loading a wallet it does not find there gets the `503` too, not "not registered". A DID that is not a `did:key` is not added with a bearer either (`503`): it is bound with any key the caller holds (no DID document is fetched), so a binding made while its owner's account is not loaded would not take the owner's sign-ins, since that key never verifies the owner's signature, but once the owner removed the DID (to change its key, say) the owner could not bind it again, as a DID a loaded account lists with another key is refused (`401`). A `did:key` added with a bearer is still bound, since only its key's holder can bind it. The cost: while a pod stays unreadable, new accounts and new credentials wait; the log line `identity_account_index_incomplete` names the pod, and the scan retries it each minute. A passkey added from a signed-in account or with an invite also loads the account derived from its id first (unreadable: `503`), and is refused with `409` if that account holds it.

Two things remain open:

- *Second holders that already exist.* The refusals above stop new ones. A credential two accounts already list was put there before them: a passkey copy registered before registrations waited for every account; a `did:web` another account bound with a key of its own while the owner's account was not loaded (the owner still signs in, having bound it first, but once it removes the DID it cannot bind it again until that binding is removed); a wallet linked before `/wallet/link` needed this server's nonce; or the account derived from a wallet or `did:key` that its first sign-in opened while the account listing it was not loaded (the first-time path waited 50 ms for the startup scan and then opened the account, so this could happen at any restart and while any pod was unreadable). A passkey, wallet or `did:key` sign-in loads the account derived from the credential before it picks another holder (unreadable: `503`), so an owner that is that account is never left out while it loads. The other holders are decided among the loaded ones during every startup scan, and for as long as the owner's pod stays unreadable: a passkey copy takes the usernameless sign-ins of an owner that is not the account derived from the id (one that added the passkey from a signed-in account or with an invite), a wallet that would get `409` signs in to its one loaded holder, and a `did:key` with no derived holder goes to the lowest loaded id. Once every holder is loaded, the order and the `409` hold, except for the pairs the old first-time path made: there the derived account is a holder and is preferred, so it keeps the wallet's or `did:key`'s sign-ins for good. Such an account usually lists that credential and nothing else, so removing the credential from it is refused (`409`, its last authentication method); signing in to it with that credential and deleting it (`POST /users/me/delete`, which tombstones it) hands the credential to the other holder. The startup scan logs `identity_credential_multi_holder` as it loads each such credential's second holder, a count only; finding the accounts takes a scan of the pods' `auth-methods.jsonld` (for these pairs, `u-eth-` and `u-did-` accounts whose only credential another account also lists), and removing the holders that are not the owner's closes this for them.
- *A deploy's overlap.* Old and new instances run side by side for 30 s, and what the old one writes after the new one has read the pods is not seen by the new one: an account opened after the new instance listed the pods, or a credential added to an account it had already loaded (its in-memory record is re-read only when something asks for it after the 10 s cache: a targeted sign-in, its token). The new instance's index is complete without them, so until such a re-read or the next restart those credentials look new there: a wallet's first sign-in can open the account derived from the wallet, which then keeps the wallet's sign-ins even after the owner's record is re-read (the derived account is preferred), a passkey id can be registered with a copy of its key unless the account derived from the id holds it, and a `did:web` can be bound by another account with a key of its own.

A deleted (tombstoned) account holds nothing in the indexes, so it is never a candidate. When an account newly shares a credential with another, the log says `WARN identity_credential_multi_holder kind=<webauthn|wallet|did> holders=<n>`, a count only, at startup as much as at enrolment; for a passkey the other holder may hold a copy of the owner's key, for a `did:web` a key of its own.

A pod that cannot be read is not a pod without credentials (`account-index.ts`). The startup scan retries the listing and every unreadable pod (three more passes, at 2 s, 5 s and 15 s), then retries what is still unreadable once a minute until none is left; each read times out after 30 s. Until the scan is complete, a passkey that matches no loaded account gets `503 Interego is still loading accounts` rather than `401`, so nobody is told to register again. A targeted sign-in (`/challenges` with a `userId`) and a token whose account is not in memory both load that account from its pod on demand: an unreadable pod there is a `503`, never "No passkey found" or "User for token not found". `GET /health` reports `accountIndex: { complete, listed, unreadable, lastPassAt }`, and the log line `identity_account_index_incomplete` says which pods are still unread. Before this, every failed read counted as "no credentials": a restart while CSS was slow left 437 of 445 accounts unknown, which disconnected their connectors and refused their passkeys.

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
- `/auth/webauthn/register` derives the final userId from the credential itself and binds it to a seeded userId *only* if a matching single-use bootstrap invite was already validated at options time. A registration without a bearer or invite may only *create* the derived account: the server reads that pod first and answers `409` if it already holds any credential (credential ids are not secret, and the derived id is 48 bits), `503` if the pod cannot be read, and writes a missing account with `If-None-Match: *`. After a refusal, or a write the pod did not confirm, it loads whatever account the pod holds (no token), so a passkey whose write did land can still sign in.
- `/auth/siwe` and `/auth/did` follow the same three-mode pattern — userId is derived from address / DID unless a bearer token or bootstrap invite authorises binding to a different user.
- `/auth/webauthn/authenticate` resolves the user via `credentialIndex[response.id]` (the first holder whose key verifies, above), ignoring any body-supplied userId hint.
- `/register` now returns **410 Gone** — there is no reason to reserve a userId without proving key-ownership.
- `/wallet/link` now requires `Authorization: Bearer <token>` and binds to the token's user (the previous unauthenticated variant let any caller attach a foreign wallet to any user's account).

## Threat model: wallet proofs need a server nonce and this server's domain

A wallet signature proves only that the wallet signed *that text*. Unless the text carries a single-use nonce this server issued, it may have been signed for anything: a SIWE sign-in to another site, a message posted publicly, a signature on-chain. Anyone holding such a message can present it again.

A server nonce is necessary but not enough. Anyone can fetch one from `POST /challenges` and put it in their own site's "Sign in with Ethereum" prompt: `evil.example wants you to sign in with your Ethereum account: … Nonce: <our nonce>`. The wallet compares that domain line with the page asking and sees no mismatch, so the user signs, and the message comes back to this server carrying a nonce it issued. What ties a signature to an Interego sign-in is the domain line, so both wallet routes require it to name this deployment:

- The accepted hosts are this server (`BASE_URL`), the relay (`RELAY_URL`, `RELAY_PUBLIC_URL`), the `WEBAUTHN_RP_ORIGINS` origins, and any host in `SIWE_DOMAINS` (comma-separated, for another front-end of the same deployment): only hosts the operator set. The relay host that `relayPublicBase()` guesses from `BASE_URL` when `RELAY_PUBLIC_URL` is unset (`identity.` → `relay.`, `-identity.` → `-relay.`) is not accepted: on a shared hosting suffix that name may be anyone's, and a page an attacker serves on an accepted host passes the wallet's own domain check too. The server logs each accepted host at startup with the setting it came from.
- The domain line only protects anyone if the wallet reads the message as Sign-In with Ethereum, because that is when it compares the domain with the page. MetaMask does this only for text `@spruceid/siwe-parser` parses; anything else is a plain signature request with no warning. So the server accepts exactly ERC-4361 and nothing looser (`parseSiweMessage` in `siwe-message.ts`, checked against siwe-parser in `tests/siwe-message.test.ts`): LF line ends, no leading or trailing whitespace, the address in EIP-55 form, the fields in order (URI, `Version: 1`, Chain ID, Nonce, Issued At, then the optional ones), the nonce read from the `Nonce` field, each URI and resource RFC 3986 part by part as siwe-parser reads it (no `[` `]`, one `#` at most, a host on the `URI` line) and a `Request ID` of pchar only. The URI's host must be an accepted host too, and `Issued At` must fall between the challenge's issue and now, give or take five minutes of clock skew. Before, the server trimmed the first line (which also strips a byte-order mark), took a `Nonce:` line anywhere and required no other field, so an attacker could pick a form the server took and the wallet did not treat as a sign-in.
- `POST /challenges` with `purpose: "siwe"` issues a hex nonce (ERC-4361 allows letters and digits only; a base64url nonce's `-` or `_` made the message unreadable to the wallet). Sent `address`, it returns that address in EIP-55 form: a browser gets lowercase addresses from `eth_requestAccounts` and has no keccak-256 to checksum them, so `/connect`, the relay's `/authorize` page and `client-sign.html` sign the form it returns. Because the relay serves the `/authorize` page and a copy of `client-sign.html`, roll the relay out before the identity server that enforces EIP-55: the new pages work against an older identity server (they fall back to the wallet's own address), but the older pages sign a lowercase address the new server refuses.
- A message whose first line names any other host is refused with 400 and its nonce is spent. The host appearing only in the statement does not count: the domain line is what the wallet showed the user.
- The second line must be the address the signature recovers to (401 otherwise).

Before 2026-10-26 `/auth/siwe` checked only that the message contained the nonce somewhere, so the relayed prompt above signed in. The routes, as they are now:

- `POST /siwe/verify` checked only that a signature over any message containing the address recovered to that address, with no nonce, nothing consumed and no domain, and then issued a `ReadWrite` token for the wallet's account. Replaying one message the victim's wallet had ever signed took over the account. It now answers **410 Gone** with a pointer to `POST /challenges` (`purpose: "siwe"`) and `POST /auth/siwe`, verifies nothing and issues nothing (still rate-limited). `POST /siwe/nonce`, which returned random bytes nothing stored, answers 410 the same way. Nothing in this repository called either.
- `POST /wallet/link` (bearer-authenticated as the linking account) accepted a signature over any message and linked a wallet another account already held, so an attacker with an account of their own and one signature by a victim's wallet could attach that wallet to the attacker's account. It now takes `{ walletAddress, siweMessage, signature, nonce }`:
  - `nonce` comes from `POST /challenges` with `purpose: "siwe"` and is consumed as `/auth/siwe` consumes it: single-use, 5 minutes. It is spent as soon as the body is read, before the bearer is checked, so a request refused for any reason (a stale bearer, say) leaves no message and signature that `/auth/siwe` would still accept. Missing → 400; unknown, expired, used or of another purpose → 401.
  - The message follows the same rule as `/auth/siwe` (exact ERC-4361 naming this deployment, with that nonce in its `Nonce` field), and its address line is `walletAddress`. Otherwise → 400. The signature must recover to `walletAddress` → otherwise 401.
  - A wallet another account holds is refused with **409**, as for passkeys and DIDs. The account the wallet would have opened by itself (`u-eth-<addr[0:12]>`) is loaded from its pod first in case the index missed it, and while any pod is unreadable (the account index is incomplete) the route answers 503 and changes nothing, since it cannot tell who holds the wallet.
  - The stdio MCP server's `link_wallet` tool follows the `/wallet/link` rule: its first call fetches the nonce (and the address in EIP-55 form) from `/challenges` and shows the message with a `cast` command quoted so the shell passes its newlines, its second call submits that same message with the nonce and the bearer in `CG_IDENTITY_TOKEN`. Without a bearer configured it says so and sends nothing.
- `POST /auth/siwe` with a bearer adds the wallet to the bearer's account only when no account holds it, checked the same way (`walletHolder` in `server.ts`). A wallet held by an account found only on its pod signs in to that account, exactly as an indexed one does, and while the holder cannot be ruled out (its derived account's pod is unreadable, or the account index is incomplete) it answers 503 and binds nothing. Before, a wallet missing from the index was bound to the bearer's account outright.
- Still open: `POST /auth/did` verifies an Ed25519 signature over the bare nonce, so the signed bytes name neither this server nor the purpose. A page that shows a user one of this server's `did-sig` nonces and asks them to sign it can redeem the signature here. Fixing it means a versioned, domain-separated payload that every DID client signs; it is tracked separately.

### Bootstrap invite configuration

```bash
BOOTSTRAP_INVITES="markj:<long-random-token>,alice:<another-token>"
```

- Tokens are generated out-of-band (e.g. `openssl rand -hex 32`) and handed to the user via a side channel.
- An invite is consumed exactly once: on the first successful enrollment for that userId. After consumption — or once the seeded pod has any credential on file — the invite flow refuses, so even a restarted container cannot replay the bootstrap.
- The seeded pod is read only once the invite matches the one configured for that userId, and only for a userId shaped like an account id (lowercase letters, digits and hyphens); that read writes nothing, and a pod that cannot be read is a `503`. A wrong invite gets `401` and touches no pod: the same `401` as a seeded account that already has a credential, and, on `/auth/siwe` and `/auth/did`, as an invite already spent. `/auth/webauthn/register-options` answers an invite spent in this process with `409` ("already been consumed"), which only the right invite reaches. `/auth/siwe` and `/auth/did` used to read the named pod first, which writes an empty `auth-methods.jsonld` when there is none, so anyone could plant a document in the pod of an account not opened yet (`x/../<id>` reaches any pod). `/auth/webauthn/register-options` read it only with the right invite, but wrote that empty document too, before any ceremony ran, and left it when the ceremony was abandoned. An account is also always the pod its document was read from, whatever the document's own `userId` says, so such a document no longer loads that account under another id.
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

**Surface agents are restored on demand.** The identity server keeps surface agents only in memory, and its boot-time rebuild brings back one placeholder agent per user. When `GET /agents/<id>/did.json` or `/agents/<id>/profile` finds no agent and the id is exactly `<surface>-<userId>`, with a relay-shaped slug and the canonical id (`u-pk-`, `u-eth-` or `u-did-` and 12 hex) of a user the server knows, it restores that user's agent with the name `ensureSurfaceAgent` would give it (`surface-agent-restore.ts`), but only if the user's pod agent registry (`<pod>/agents`, which the relay writes on OAuth) lists it, and with the scope that entry lists; a verified token for that agent, issued to that user, restores it too, with the scope the token was signed with. A restored agent is never broader than it was: an unknown or missing scope, or two entries that disagree, restore as `DiscoverOnly`. So a lookup cannot invent an agent the person never had, and made-up slugs cannot use up the person's restores (capped at 32 per user; past that a token brings an agent back). Unknown, deleted or non-canonical users, ambiguous ids and ids matching the janitor's `TEST_AGENT_PATTERN` are never restored. Because the id is what names the owner, `POST /register-agent` accepts only a plain lowercase slug (400 otherwise) and refuses with 403 an id ending in another user's canonical id, so nobody can register `claude-<victim>` and appear as its controller; the caller's own `<surface>-<their userId>` still registers, and a token naming another user's id does not verify.

**Deleting an account leaves a tombstone.** `POST /users/me/delete` cannot empty the pod: the container and its other files stay, and the relay maps a userId straight to that container. A derived id comes back from the credential it was derived from, and passkey ids are not secret, so the account's `auth-methods.jsonld` is overwritten with a tombstone rather than removed: the userId, the day (`deletedAt`) and a session epoch above every token issued, and no name, agent or credential. Every first sign-in reads that file before creating an account, so an old passkey id, wallet, DID or bootstrap invite gets 409 "This account was deleted", nothing is written, and the account's tokens are refused, after a restart too; a pod that cannot be read gives 503. The deletion itself is a 503 that changes nothing when the pod does not take the tombstone. `u-try-*` ids are random and keep the old removal. The tombstone is permanent; an operator re-opens an id by deleting the file by hand (and restarting the process, below). Writers of an existing account's record (a passkey sign-in advancing its counter, credential enrollment and removal, sign-out-everywhere, the deferred `/auth/did` write) build on a record they read earlier, so they write under the same per-userId mutex as the deletion, and once the tombstone is on the pod `putPodAuthMethods` refuses every write of that id but the tombstone (a process-local set of deleted ids): a snapshot read before the deletion can never be put back over it and re-open the account and its old tokens. The same set keeps the account out of memory: `verifyToken` refuses a deleted id's tokens before reading anything, loading an account from its pod (at startup, on retry, on demand) skips a tombstone or a deleted id, so a read that began before the deletion cannot put the old record back, and an add-device ceremony begun before the deletion gets 409 without seeding the account's shell. That guarantee is per process; a second replica writing the same pod is not covered.

## Threat model: who reads and writes `auth-methods.jsonld`

The pod's CSS is allow-all behind the css-gate, and the record is plaintext, so the gate is what decides who touches it (`deploy/css-gate/server.mjs`).

- **Reads.** Every other pod document reads anonymously. This one is read like a write: the pod's owner (their bearer) or the operator. Before 2026-10-13 it was public too, and since the root container lists every pod, anyone could collect every account's display name with its wallet addresses, passkey ids, labels, public keys and counters, and DID keys. The identity server is unaffected: it reads the record from CSS over the private network, not through the gate. A user audits their own through `GET /auth-methods/me` (above).
- **Writes.** A user's bearer writes only into its own pod. The gate decides that on the path it forwards, after `.` and `..` segments are resolved. Before 2026-10-13 it decided on the raw request-target, so `PUT /alice/../bob/auth-methods.jsonld` with alice's bearer passed as a write to alice and reached CSS as a write to bob's sign-in record. A user bearer is also refused on a path with an encoded `/` or `\` in a segment, since whether CSS decodes it would decide the pod.
- **Writes to the sign-in record itself.** Only the operator bearer writes `auth-methods.jsonld` through the gate, along with its `.acl` and `.meta` resources and a POST whose `Slug` names it. The identity server is its only writer, and it writes over the private network, not through the gate: enrolment, passkey removal and account deletion all happen there. Until 2026-10-13 a user's bearer could write its own record. A stolen bearer, or an OAuth token a client holds, could then add the thief's own passkey, wallet or DID, and keep signing in after the bearer expired. A user changes credentials through the identity server's endpoints, which require a sign-in.

## Known-good tradeoffs, documented

**WebAuthn credentials are RP-bound** to the origin they were registered at (spec-mandated; passkeys are cryptographically scoped to an RP ID). If Interego ever moves to a new public URL, users re-enroll their passkey for the new origin. This is *not* a sovereignty loss — the user's DID, wallet, and did-key methods all remain portable across origins, and WebAuthn is explicitly positioned as one of several methods, not the canonical one. Users concerned about origin lock-in should enroll a DID or wallet method in addition to their passkey.

**Tokens are bearer tokens** by default (stolen token = usable token). DPoP (RFC 9449) is the standard mitigation — cryptographic proof-of-possession on every request. MCP spec lists DPoP as optional and most clients don't implement it yet, so we haven't forced it. When MCP client support matures, DPoP slots into this architecture with no other changes (add a per-request JWT signed by a client-held key, server verifies on `/mcp`).

**Pod durability** depends on CSS persistence. The identity server is provably stateless, but CSS itself runs in-memory by default on Azure Container Apps. Long-term durability requires configuring CSS with a persistent backend (file store on Azure Files volume, quadstore in Postgres, etc.). This is a deploy-level concern separate from the identity-layer architecture.

**Deferred pod writes trade a small durability window for response latency.** `/auth/*` enrollment responses race ahead of the pod write (see [Deferred pod writes](#deferred-pod-writes)). The window between response and pod-write completion is small (single-digit seconds in the happy path) but non-zero: a process crash inside that window loses the persisted record, though the user can recover by signing in again with the same credential. The mitigation is the `identity_deferred_authmethods_failed` ERROR-level log line plus the 3-attempt 1s/2s/4s backoff — operators alert on the metric and the in-memory cache stays authoritative until the write lands.

## Extending

- **New verification method.** Implement a `/auth/<method>` endpoint that validates a signature over a `/challenges`-issued nonce, resolves the user via the appropriate index (or first-time flow), and returns the standard token response. Add a corresponding card to the relay's authorize page with client-side ceremony JS.
- **External identity server.** Point the relay at a different `IDENTITY_URL`; the identity server is federation-friendly (DIDs + WebFinger are resolvable by any conforming client).
- **Decentralized identity proof (VC-style).** The DID method already hands you a signed nonce; layer a W3C Verifiable Credential on top for claims ("is over 18", "is a member of X") without centralized attestation.
