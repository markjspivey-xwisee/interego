# Client signing through MCP

Use the signed resource's advertised Preview and Submit controls through `act` or `invoke_affordance`.
Preview stays read-only. For a client-signed action, Submit without `client_proof`
starts an authenticated signing handoff. The optional application interpreter
defines the action and receipt; the relay supplies a generic interaction lifecycle.

Both action tools advertise the existing HyperMarkdown MCP App. A pending signing
response opens its signing panel in hosts supporting MCP Apps. The panel reads the
request through the caller's authenticated status control before enabling a
**Review and sign** button. A click opens the holder's signing origin through the
host's link API; no URL or proof needs copying. The panel polls the verified result,
displays it, updates model context and requests conversation continuation. A host
may refuse that continuation; the visible result and read-only status control remain.
If cached tool metadata does not open the panel, call the existing `render_hmd`
tool with the returned interaction `descriptorUrl`. No new signing tool is needed.

The requesting client receives URL elicitation when it advertises support. On
the 2026-07-28 protocol this is an `input_required` result with a server-bound
continuation. Initialized 2025-11-25 clients receive `elicitation/create` and a
completion notification. Clients without URL support receive the panel's resource
reference and descriptor-bound status and cancellation controls. If a host supports
neither interface, report that measured limitation and provide a clickable link.
The server cannot force an unsupported host to open a window or resume a conversation.

The `invoke_affordance` compatibility shim keeps a numeric HTTP-style `status`:
202 while awaiting signing, with the interaction state and all recovery controls
inside the JSON string `body`. Completed results use 200; inspect the interaction
state and retained result to establish whether an action committed. The kernel
`act` handoff continues to return its interaction object directly.

If a connector lost the response, repeat the exact original descriptor, action
and unsigned payload in the same authenticated session to recover the existing
request. Switching between `act` and `invoke_affordance` does not change its ID.
Changing the access token or action arguments is not this recovery operation.
After OAuth refresh, invoke the request's `renewAction` with an empty payload
through `act` or `invoke_affordance`, or choose **Resume with current session**
in the panel. This explicit write accepts only the same account, actor and OAuth
client. It clears the old review, keeps the request ID and original thirty-minute
maximum deadline, and requires the holder to load a fresh review. Status polling
never performs this renewal. An elapsed maximum deadline requires a new handoff.
Repeating the original Submit can replace expired or cancelled requests; completed, submitting and failed
requests are returned without repeating their execution. Request status and IDs
remain restricted to the originating account, agent and OAuth client.

The link contains an opaque identifier, not a bearer token or a receipt. The
holder authenticates with an existing Interego account before receipt access.
The page checks current authority and creates a fresh ten-minute receipt when
the holder opens the review. The holder reviews it and chooses **Sign and submit**.
The wallet or passkey signs locally; the page sends the public proof directly
back for verification and conditional publication. There is no proof to copy
into chat. Approving the URL prompt alone never authorizes the resource action.
The relay chooses a configured signing origin compatible with the registered
wallet or passkey. Agent-only keys continue to use their own signing runtime and
submit the resulting proof through MCP. Passkey signing uses the credential's
single verified relying-party domain. Legacy credentials without that binding
must sign in with their existing passkey and load a fresh review; successful
cryptographic authentication persists the binding with the authenticator counter.
An origin allowlist is not proof of where a credential was registered.
Verified passkey origins take priority even when the account also has a wallet
or an older credential with several possible domains. A request created before
legacy metadata was repaired may still point at a different site. Before login,
the signing page offers **Continue on …** links to the configured signing sites.
The holder chooses the site where they created their passkey. These links preserve
only the same opaque request ID; each site authenticates separately, with no token,
receipt or signature copied or moved between sites. Query parameters and credential
origin lists cannot introduce a destination. Successful login pins the legacy RP,
so subsequent requests select the verified site directly.

The pending handoff lasts up to thirty minutes, bounded by the originating OAuth
grant's expiry. Request data and the delegated session credential are encrypted
at rest. Every signing operation revalidates that grant; reconnecting does not
silently extend it. Active OAuth refresh renews the underlying identity token
through the existing authenticated same-agent endpoint. If that identity grant
has already expired or been revoked, reauthentication is required; a refresh
token does not bypass that check. Transient renewal errors can be retried.
Completed results can be retrieved by the same authenticated
account, agent and OAuth client after transport reconnect or relay restart.

A state advance, such as the first reviewer's approval, invalidates an older
receipt. **Load a fresh review** obtains new bytes for the holder to inspect and
sign. The old signature is never rebound. Changes to contract, catalog,
definition, evidence or action inputs require a new request from the agent.
Cancellation and conditional writes prevent a late or repeated submission from
silently committing twice. If publication's outcome is uncertain, inspect the
current resource head before making another submission.

Agents with an existing registered wallet or Ed25519 key can sign in their own
runtime and supply `client_proof` directly. Client-held signing does not require
two humans or two devices; the application contract determines which distinct
actors and public-key fingerprints qualify. The relay never supplies a reviewer
private key or substitutes its attestation for a client signature.

`integrations/application-runtime/client-signing-session.ts` provides this runtime
path without a proof-file round trip. Configure `clientSigningSession` inside the
real key holder's process with its authenticated MCP `call`, public `key`, private
`sign` callback and a scope naming the actor, application, action, contract and
expiry. Its required `review(receipt, digest)` callback independently checks the
receipt and evidence. Then call `execute(previewControl, submitControl, payload)`
with the resource's advertised controls. It previews, checks scope and freshness,
reviews, signs, verifies the public proof locally and submits once through MCP.
It never retries an uncertain submission or falls back to the relay's key.

This local scope restricts the signer; it does not create a new cryptographic
delegation or replace server-side authorization. The server still checks current
registration, delegation, contract and predecessor. OAuth access by itself does
not supply a private key. A hosted connector without a signer uses the interactive
holder path; do not manufacture a key for another reviewer or call the bearer an
independent client proof. A newly provisioned subordinate signing key and its
delegation require explicit enrollment and a separate versioned policy. The
[proposed scoped-grant verifier](SCOPED-CLIENT-SIGNING-GRANTS.md) checks owner and
possession signatures, scope, time and trusted grant status. It is not wired into
the hosted connector or current policy; its document records the remaining
custody, enrollment, revocation and historical-authority integration requirements.

The standalone fragment-based page remains available for existing process
integrations. New interactive clients should use Submit's pending request flow.
