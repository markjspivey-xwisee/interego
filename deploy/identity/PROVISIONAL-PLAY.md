# Provisional browser owners (deployment composition)

This implementation lets an explicitly trusted application provision a browser-controlled native owner and pod on a Play action, then attach a normal credential or copy a confirmed checkpoint into an existing owner's pod. It is an implementation composition, not a change to the Interego protocol. A browser-key proof establishes possession of that key; it does not identify a human or authorize autonomous agents.

The feature is disabled unless `PROVISIONAL_PLAY_CLIENTS` explicitly maps each allowed HTTPS application origin to its existing native service agent DID and public owner-pod URL:

```json
{"https://play.example":{"agentDid":"did:web:identity.example:agents:game-service","podUrl":"https://pods.example/game/"}}
```

Identity also needs its existing stable `TOKEN_SIGNING_KEY`, `CSS_URL`, `RELAY_URL`, and canonical HTTPS `CSS_PUBLIC_URL`. The allowlisted application origins are added to identity's existing explicit CORS allowlist. No wildcard or shared Play secret is introduced.

`GET /.well-known/play-provisional` advertises the enabled state, endpoints, proof encoding, lifetime admission limit, guest deadline and storage limits. `PROVISIONAL_PLAY_TTL_SECONDS` defaults to 86400 and is bounded to 3600–604800. `PROVISIONAL_PLAY_MAX_PODS` defaults to 100 and is bounded to 1–1000. This limit is both a live-pod limit and a **cumulative lifetime admission limit**. Raising it is an explicit operator storage-budget decision.

The application first obtains a native `sign_request` envelope using its existing service credential. Its payload is:

```json
{"purpose":"interego-play-provisional-v1","audience":"https://play.example","publicKeyThumbprint":"<RFC7638 P-256 thumbprint>","challenge":"<20–128 base64url characters>","expiresAt":1800000060}
```

The relay adds the authenticated `agent_id`, public `subject_pod_url`, and ISO timestamp. The grant expires within 120 seconds of that timestamp. Identity verifies the exact configured principal and pod through the fixed configured relay's `verify_agent`, including its live signing anchor and delegation, then recovers the signature over the relay's `sha256:<hex>` message. Caller-supplied URLs never select a verification server.

The browser stores a nonextractable P-256 private `CryptoKey` in IndexedDB and posts `{playGrant, publicKeyJwk, proof}` to `/play/provisional`. `playGrant` is `{_signed_payload,_signature}`. The signature uses WebCrypto ECDSA P-256/SHA-256 over these UTF-8 bytes, with actual newline separators:

```text
interego-play-provisional-v1
{playGrant._signed_payload}
{playGrant._signature}
```

The base64url proof encodes the raw 64-byte `r || s` signature. The public JWK has only public P-256 material; a JWK containing `d` is refused. The RFC7638 thumbprint hashes `JSON.stringify({crv:'P-256',kty:'EC',x,y})` with SHA-256.

Success returns the existing identity credential fields (`token`, ISO `expiresAt`, `userId`, `did`, `webId`, `agentId`, `agentDid`, public `podUrl`) plus `attestation`, `provisional:true`, fixed ISO `guestExpiresAt` and `proofKeyThumbprint`. The native identity token stays between browser and identity/relay. The relay's separate provisional exchange creates the normal durable OAuth credential required by `/mcp`; a `cg2_` identity token alone is not an MCP OAuth credential.

The native guest owner ID is derived from application audience and public-key thumbprint. A fresh grant for that same key resumes the same owner, pod and original deadline. A grant hash is consumed in the canonical pod anchor before issuing any credential; replay returns `play_grant_already_used`. A lost response can be recovered with a fresh application grant and new key proof. At most 16 live 120-second receipts are retained.

The root control resource `<CSS_URL>provisional-play-admission.json` reserves each owner before creating its pod. Its conditional writes persist up to the configured lifetime limit of immutable original attestations. Expiring or deleting a pod never refunds an admission, and a restart cannot reset the budget. This lifetime count also bounds active Play pods, so admission does not enumerate the CSS root. An interrupted creation can reuse its reservation without extending its original deadline. Failure to read or conditionally persist either admission or the own-pod `auth-methods.jsonld` anchor prevents credential issuance. This control ledger contains no character checkpoint or private key.

For game admission or a later claim, the browser signs a fresh application challenge over:

```text
interego-play-proof-v1
{attestation}
{audience}
{challenge}
```

`POST /play/provisional/verify` accepts `{attestation,audience,challenge,proof}`. It verifies the provider signature, browser proof, original expiry, and exact live pod anchor. Success includes `valid:true`, `provisional:true`, issuer/audience, canonical owner DID/WebID/public pod, actual default authenticated agent ID/DID, public key/thumbprint, ISO expiry, and `['human-play','own-pod-checkpoint']`. The application owns one-time challenge consumption and binds claim challenges to the independently verified canonical target. The attestation is public proof material, not a bearer credential.

Guest identity tokens carry signed `provisionalPlay:{audience,proofKeyThumbprint,expiresAt}` (Unix seconds). Introspection and `/me` expose it with authoritative canonical owner/pod/agent fields. Renewal preserves the marker and deadline, and the token cannot register an additional identity agent. Relay and CSS gate enforce the marker's restricted checkpoint surface: two deterministic resources, conditional native writes, 4 MiB per write, 32 MiB lifetime decoded writes and 1024 lifetime attempts. These limits require the matching relay and gate rollout before enabling an application audience.

An explicit new passkey/wallet/DID enrollment can use the existing add-device flow to claim the same owner/pod. When the owner's anchor cannot be read at that moment, an enrollment with the guest bearer (a wallet or DID through `/auth/siwe`, `/auth/did` or `/wallet/link`, or a passkey's registration options), and any other request that acts on the owner's account with it, answers 503 (try again) and changes nothing; an anchor that does not open to the owner is a 401. A guest's `POST /users/me/delete` overwrites the owner's anchor with a deletion tombstone, conditionally on the record it read, and never removes it: a write still pending from before (an add the pod never answered) is conditional on that record's ETag, and Community Solid Server 7.2 applies such a write to a missing document, so a removed anchor let it re-create the owner with its credential, the guest token verifying again at once. A deletion whose tombstone the pod refuses answers 503 and keeps the owner, its guest token still working. A fresh grant for the same key provisions the owner again over its tombstone (written on the tombstone's ETag, keeping its session epoch, so the tokens issued before the deletion stay refused), with its original deadline. A guest token's session epoch is checked on the owner's record as read from the pod, on every instance, so a token issued before the deletion is refused there and the new session's tokens verify, even on an instance whose copy of the record is still the tombstone; and a retry of a deletion answered 503 writes nothing over an owner provisioned again (401). A successful normal credential proof produces a canonical unmarked credential; merely renewing a guest bearer does not. The original guest attestation remains a valid source proof until its original expiry so same-owner claim confirmation can finish. Claiming into an existing owner remains an explicit browser copy-and-confirm operation with a conflict when a target character already exists; this provider does not alias owners or overwrite characters.

The existing janitor recognizes the signed fixed guest deadline after restart, rereads credentials before removal, and exempts a claimed pod. Play cleanup validates the complete own-pod tree first, then closes the owner (its tombstone written on the ETag of the record it checked: an enrolment that landed first keeps the whole pod), and only then deletes at most 128 descendants across eight levels; the auth record, now the tombstone, and the pod's container stay, for the reason above. A dependency failure or foreign/out-of-bounds traversal before the close retains the pod for a later retry. One after it (a deletion that fails) leaves the owner closed with its tombstone marked as a purge not yet finished (`provisionalPlayPurgePending`, cleared once every descendant is deleted but those below): the janitor's next pass sends the remaining deletions again, and so does its first pass after a restart, whose scan finds the mark. The guest's game saves and its write budget are not deleted: the gate writes them only as native commits, and the production store refuses every plain `DELETE` of a native-committed resource with `409`, so the cleanup keeps them and the containers that hold them, finishes without them, and logs them once. Such a `409` used to count as a failed deletion, so the purge of a guest who had saved never finished, and was sent again at every pass and after every restart. A tombstone the cleanup did not mark (a guest's deletion, possibly made through another instance) is never purged: that owner may be provisioned again over it until its original deadline, so nothing of its pod is written or deleted (the cleanup lists the pod and reads the record before it finds the tombstone). A guest's deletion this instance answered `503` (the pod may have taken it without confirming it) is left as it is for the guest's retry until that deadline; after it, the janitor finishes the deletion as the retry would have, deleting the owner's agent registry and nothing else. Deleting live resources does not assert that historical immutable PGSL atoms were physically reclaimed, and the native-committed saves and budget stay on the pod as they are; the cumulative admission and lifetime write budgets remain charged.

Validation: `npm run build --workspace @interego/identity` and `npm run test --workspace @interego/identity` from the monorepo after installing its dev dependencies. The tests use generated local keys and fake conditional storage only (the route tests' stand-in pod answers a plain `PUT` or `DELETE` of a native-committed resource with `409`, as the production store was measured to); they create no live identities or pods.
