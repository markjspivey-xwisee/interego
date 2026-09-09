# Client signing through MCP

Use the signed resource's advertised Preview and Submit controls through `act` or `invoke_affordance`.
Preview stays read-only. For a client-signed action, Submit without `client_proof`
starts an authenticated signing handoff. The optional application interpreter
defines the action and receipt; the relay supplies a generic interaction lifecycle.

The requesting client receives URL elicitation when it advertises support. On
the 2026-07-28 protocol this is an `input_required` result with a server-bound
continuation. Initialized 2025-11-25 clients receive `elicitation/create` and a
completion notification. Clients without URL support receive an ordinary short
link and descriptor-bound status and cancellation controls. They can poll that
status through MCP. The server cannot force an unsupported host to open a window
or resume a conversation.

The `invoke_affordance` compatibility shim keeps a numeric HTTP-style `status`:
202 while awaiting signing, with the interaction state and all recovery controls
inside the JSON string `body`. Completed results use 200; inspect the interaction
state and retained result to establish whether an action committed. The kernel
`act` handoff continues to return its interaction object directly.

If a connector lost the response, repeat the exact original descriptor, action
and unsigned payload in the same authenticated session to recover the existing
request. Switching between `act` and `invoke_affordance` does not change its ID.
Changing the access token or action arguments is not this recovery operation.
Expired or cancelled requests may be renewed; completed, submitting and failed
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
submit the resulting proof through MCP.

The pending handoff lasts up to thirty minutes, bounded by the originating OAuth
grant's expiry. Request data and the delegated session credential are encrypted
at rest. Every signing operation revalidates that grant; reconnecting does not
silently extend it. Completed results can be retrieved by the same authenticated
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

The standalone fragment-based page remains available for existing process
integrations. New interactive clients should use Submit's pending request flow.
