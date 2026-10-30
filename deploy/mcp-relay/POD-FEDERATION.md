# Hosted pod invitations and selected sharing

This optional Layer 3 adapter uses the same `@interego/pod-federation` service as the Windows application. It adds hosted-to-local and hosted-to-hosted invitation and encrypted snapshot sharing without changing existing hosted identity, notes, MCP tools or federation-directory behavior. It is code for the next deployment; adding this PR does not deploy the hosted service.

## Connect your hosted pod

1. Open **Connect your pod** on this relay's home page, or visit `/pod-federation` on the relay that hosts your account.
2. Sign in. The page requests a separate `federation:manage` grant through the existing passwordless OAuth flow. Existing `mcp`, `mcp:read` and `mcp:write` assistant grants cannot manage pod connections. The page uses PKCE, checks the one-use callback state in the same tab, and never asks you to copy an identity token or pod key.
3. Name this hosted pod, then explicitly enable pod sharing. A name alone enables nothing. Federation identity and saved peer state persist privately; active transport starts off when the relay process restarts.
4. Create an invitation and send it using a channel you already trust. Your brother pastes it into his Interego pod's connection setup. Compare the displayed short code, review the peer name and fingerprint, then approve the pending request. The recipient refreshes to finish connecting. A name is a label, not proof of someone's identity.
5. Choose the connected pod, load your content list and select the published versions to send. The page shows up to 25 recent versions with available readable titles. Every selected resource is rechecked against your own current manifest when the action executes. Keys, authentication files, arbitrary URLs and another owner's resources are not selectable.

The Windows installation can also create the invitation and have the hosted owner accept it. Both endpoints must be enabled and reachable. A user-owned gateway remains a transport choice for a local pod; it is separate from the hosted account's storage.

## What sharing means in this preview

Sharing sends explicit encrypted copies of selected resources. It does not grant general access to either pod, continuously synchronize collections, edit originals, or queue offline deliveries. Each resource is limited to 128 KiB. The original descriptor Turtle and graph representation are preserved inside a descriptor snapshot, alongside their original URLs and media type; signed content and canonical identities are not rewritten to a gateway hostname.

Only approved peer identities can submit snapshots, and each request and successful response is signed, audience-bound, fresh and replay-checked. The service encrypts each snapshot for its sender and intended recipient. Hosted keys are managed by the hosted service; this does not claim client-held encryption for hosted accounts. A gateway can observe transport metadata and encrypted federation traffic.

Pause keeps peer configuration and received copies. Disconnect blocks future sharing through this pod, including incoming requests from the revoked peer. The other pod can retain copies already received and may still display its old connection until it attempts to use it. Remove a received copy or clear sent history to free retention space without resetting peers; this does not clear replay protection or delete remote content. Forget removes the saved federation identity, peer setup and received snapshots, while preserving original pod notes. The recovery page can conditionally forget a damaged private setup after explicit owner confirmation.

## Authorization, storage and operations

Owner management is under `/pod-federation/owner/*`, authenticated on every call with the dedicated OAuth scope and session-derived user, identity and exact own-pod binding. Request JSON cannot select an account or endpoint. Public signed peer routes are under `/pod-federation/peers/<userId>/{profile,join,pairing,inbox,revoke}`. Public traffic cannot create or enable an owner service. The public `/pod-federation/profile` document and relay entry point advertise the owner management route and its scope.

The entire private state, including federation keys, invitation hashes, peers and snapshot envelopes, is encrypted at `<own-pod>/private-pod-federation/state.json`. Each load uses a fresh no-store read and ETag; writes require conditional creation or the last observed ETag. A stale write fails closed. Hosted services reload authority before operations and conditionally commit an outbound authorization intent before transmission. An externally reset identity or conditional-write conflict pauses the affected service rather than continuing with cached authority. This prevents a new send using authority already revoked in the shared store; a copy authorized before a later revocation cannot be retracted.

Private state reads enforce a 64 MiB ceiling while consuming the response stream and a 15-second deadline across headers and body. A transport without streaming support is refused instead of falling back to an unbounded `text()` call. Expiry rejects the owner request and cancels a current or late-arriving response body. The underlying shared HTTP wrapper retains its own configured header timeout if it does not forward the caller's abort signal.

The preview keeps enabled transport process-local and bounds resident owner contexts to 64. Use one relay process, or consistent owner/peer request affinity in a multi-replica setup, for availability; a replica with no enabled owner instance refuses peer traffic. Coordinated transport lifecycle and distributed leases are not included. Address validation, DNS result screening/pinning, response bounds, timeout, cancellation and refusal of redirects are enforced by the shared service transport.

## Verification

`tests/pod-federation.test.ts` is registered in the relay's normal `npm test` chain. It drives a real local service against the actual hosted Express adapter: invite, pending owner approval and code verification, approval refresh, encrypted sharing in both directions, restart into disabled state with retained received copies, revocation through a second store-backed instance, retention cleanup and Forget. It also tests owner/scope isolation, private conditional storage and recovery, resource-selection boundaries, byte preservation and the hosted page's same-tab PKCE callback handling. Outbound federation stays on loopback in this test. Live hosted login, deployment and two-user account validation are separate checks.
