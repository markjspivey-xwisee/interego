# Auth architecture — Interego identity

This note captures the first-principles shape of identity in Interego so future changes don't accidentally drift toward centralized conventions.

## Principles

1. **User sovereignty.** Every private key stays with the user. The server only holds public keys and verifies signatures. There are no passwords anywhere in the system.
2. **Pod as source of truth.** Each user's credential data (wallet addresses, WebAuthn credentials, DID keys) lives in their own Solid pod at `<pod>/auth-methods.jsonld`, serialized as JSON-LD against the `cg:` + `sec:` vocabularies. The identity server is **stateless** for user data; a container restart loses no durable state.
3. **DID is canonical.** `did:web:<identity-host>:users:<id>` is the portable identity. WebAuthn, SIWE, and DID-key signatures are *verification methods* registered to that DID — interchangeable, addable, removable without identity-level disruption.
4. **W3C standards, not bespoke.** DID Core, WebID, Solid, SIWE (ERC-4361), WebAuthn, VC / Verifiable Credentials — every piece of the auth stack maps to a published standard.

## Layout

```
┌───────────────────────┐         ┌──────────────────────────┐
│ identity server       │         │ Solid pod (per user)     │
│ (stateless verifier)  │         │                          │
│                       │  read   │  /auth-methods.jsonld    │
│  - resolves DIDs      │ ◄─────► │    walletAddresses[]     │
│  - verifies sigs      │         │    webAuthnCredentials[] │
│  - issues challenges  │  write  │    didKeys[]             │
│  - issues tokens      │         │                          │
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
| **SIWE** (ERC-4361) | User's Ethereum wallet (MetaMask, Coinbase, hardware, etc.) | Connect wallet → sign SIWE message with fresh nonce → server recovers address via `ethers.verifyMessage` → writes `walletAddresses[]` to pod | Same signature path; pod lookup matches wallet → user |
| **WebAuthn / passkey** | OS secure enclave (iCloud Keychain / Google Password Manager / hardware key) | `navigator.credentials.create` → `@simplewebauthn/server.verifyRegistrationResponse` → credential stored in pod's `webAuthnCredentials[]` | `navigator.credentials.get` → `verifyAuthenticationResponse`, counter bumped in pod |
| **DID Ed25519** | User-managed `did:key` or `did:web` with off-server private key | Client signs server nonce with private key → server verifies with public key (decoded from did:key or `publicKeyMultibase`) → writes `didKeys[]` to pod | Same signature path; pod lookup matches DID → user |

## OAuth 2.1 layer

- DCR (RFC 7591) on `/register` — no client pre-registration required.
- Authorization code + PKCE mandatory — public clients only, no client secrets.
- Identity-backed `/authorize` page renders method-picker HTML; browser JS runs the signature ceremony against the identity server's `/auth/*` endpoints.
- On successful verification, the relay issues:
  - **Access token** (1h TTL) carrying the user's { userId, agentId, ownerWebId, podUrl } in the token's `extra` field — MCP handlers attribute writes to the real user.
  - **Refresh token** (14d TTL, rotating on every use) for long-running sessions.
- `/.well-known/oauth-authorization-server` and `/.well-known/oauth-protected-resource` let any MCP client auto-discover the auth flow.

## Known-good tradeoffs, documented

**WebAuthn credentials are RP-bound** to the origin they were registered at (spec-mandated; passkeys are cryptographically scoped to an RP ID). If Interego ever moves to a new public URL, users re-enroll their passkey for the new origin. This is *not* a sovereignty loss — the user's DID, wallet, and did-key methods all remain portable across origins, and WebAuthn is explicitly positioned as one of several methods, not the canonical one. Users concerned about origin lock-in should enroll a DID or wallet method in addition to their passkey.

**Tokens are bearer tokens** by default (stolen token = usable token). DPoP (RFC 9449) is the standard mitigation — cryptographic proof-of-possession on every request. MCP spec lists DPoP as optional and most clients don't implement it yet, so we haven't forced it. When MCP client support matures, DPoP slots into this architecture with no other changes (add a per-request JWT signed by a client-held key, server verifies on `/mcp`).

**Pod durability** depends on CSS persistence. The identity server is provably stateless, but CSS itself runs in-memory by default on Azure Container Apps. Long-term durability requires configuring CSS with a persistent backend (file store on Azure Files volume, quadstore in Postgres, etc.). This is a deploy-level concern separate from the identity-layer architecture.

## Extending

- **New verification method.** Implement a `/auth/<method>` endpoint that validates a signature over a `/challenges`-issued nonce, resolves the user via the appropriate index (or first-time flow), and returns the standard token response. Add a corresponding card to the relay's authorize page with client-side ceremony JS.
- **External identity server.** Point the relay at a different `IDENTITY_URL`; the identity server is federation-friendly (DIDs + WebFinger are resolvable by any conforming client).
- **Decentralized identity proof (VC-style).** The DID method already hands you a signed nonce; layer a W3C Verifiable Credential on top for claims ("is over 18", "is a member of X") without centralized attestation.
