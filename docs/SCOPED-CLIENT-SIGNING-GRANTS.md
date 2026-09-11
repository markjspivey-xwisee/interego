# Scoped client signing grants

The optional signed-domain application runtime supports owner-authorized,
short-lived Ed25519 signing grants. An application must explicitly opt in through
its signed contract. Existing direct-signature contracts keep their current
behavior; deploying this interpreter does not activate grants on an existing
application or supply any actual reviewer credential.

## Reviewer flow

1. The agent invokes the application's advertised Submit control without a proof.
2. The holder opens the private signing link and authenticates with the existing
   account. On an eligible action, **Enable scoped signing** creates a
   nonexportable Ed25519 key in that browser tab.
3. The holder reviews the enrollment receipt and authorizes the exact grant with
   the account's registered wallet or passkey. The browser separately proves
   possession of the subordinate key. One holder signature enrolls the grant;
   enrollment does not itself approve the pending application action.
4. The tab watches the originating agent/client's private request queue. It
   re-resolves each matching request, signs its complete current receipt and
   submits the delegated proof. This also completes the original pending action.
5. Keep the tab open for background signing. **Stop background signing** discards
   the key and stops the tab's signer. Closing or reloading the tab loses the key.
   The application's **Revoke signing grant** control invalidates the grant on
   the server immediately when its state transition commits. Expiry also ends
   admission. Stopping locally is not a server revocation.

The default browser grant lasts 55 minutes; the verifier permits at most one
hour. Its scope names exactly one authenticated agent, relay HTTPS origin,
resource pod, application, action and contract digest. It has no wildcards or
redelegation rights. A grant covers future inputs for that one action, so its
holder should authorize only an action they intend the agent to request during
that interval. Every action still has to pass the signed contract's guards.

The browser retains the private key in memory. It sends only the public key,
proof of possession and signatures. No private key enters a URL, relay, identity
service, model prompt or persistence record. The request queue and originating
OAuth credentials are encrypted at rest and partitioned by account, agent and
OAuth client. Every review and submission revalidates the originating session.
An expired session must be renewed by that same client through the existing
explicit renewal control; the companion does not acquire broader authority.

This owner-side browser companion works with a hosted agent that can follow
ordinary MCP controls and display a clickable signing link. It does not require
an MCP App renderer or a private signer inside the hosted model. It also does not
claim that a browser signature proves a separate human or independent reasoning.

## Contract opt-in and lifecycle

A new signed contract epoch declares `clientSigningGrants` with these fields:

| Field | Meaning |
| --- | --- |
| `schema` | `interego.application.client-grants/v1` |
| `audience` | Exact serving relay HTTPS origin |
| `registrationVerifier` | Exact lowercase `did:ethr:` public verifier for the trusted relay credential-membership attestation |

Pin the verifier from independently verified relay authorship evidence before
publishing the contract. A fetched grant cannot choose its own trusted verifier.
The relay attestation proves current credential membership; it cannot replace
the holder signature or subordinate proof of possession.

The contract declares exactly one enrollment action and one revocation action.
Both use `clientSignature: true`, POST to `urn:interego:runtime:signed-domain:v1`,
and contain no ordinary application-data effects. Enrollment sets
`clientGrantOperation: "enroll"` with required string inputs `grant` and
`possession` containing canonical JSON. Revocation sets
`clientGrantOperation: "revoke"` with the required string input `grantId`.
Only the authenticated grant owner may revoke it. Neither lifecycle operation
can use a delegated proof. Individual normal actions opt in separately with
`allowClientDelegation: true` and `clientSignature: true`.

A key-owning runtime can use these same advertised lifecycle controls. It
constructs an `interego.client-signing-grant/v1`, signs the canonical grant with
its own subordinate key, and requests holder authorization of the exact
enrollment receipt. After enrollment it supplies an
`interego.delegated-client-signature/v1` as `client_proof`. Its action signature
binds `delegatedClientSigningMessage(grant, canonicalReceipt)`, which includes the
grant ID, digest, audience and full action receipt. The browser uses this same
format, not a special exemption.

## Authority, ordering and replay

The application's state carries an append-only grant ledger. Enrollment,
revocation and every ordinary action share its existing CAS predecessor. An
ordinary effect cannot insert, erase or restore a grant. Genesis cannot contain
pre-enrolled grants. Duplicate grant IDs are refused; the current bounded ledger
allows 256 entries, including revoked entries.

An enrollment retains the holder's exact signed receipt, subordinate possession
proof, normalized registered public-key restrictions and a domain-separated
credential-membership attestation. The latter binds the authenticated actor,
registered key fingerprint, receipt digest and enrollment time. The contract
pins its verifier. Replaying a raw descriptor with a self-generated holder key
cannot manufacture this membership evidence.

Live action admission requires the exact active envelope in the verified
predecessor, current root-key registration, matching actor and scope, a fresh
receipt, unexpired grant and valid subordinate signature. An opaque admission
result is tied to that ledger and exact receipt; copying a proof or verifier
result does not confer admission. Publication rechecks current resource
authority and CAS. If another relay commits revocation first, the action's old
predecessor cannot commit. Ambiguous submissions are not retried automatically.

Full application replay reproduces every ledger transition and verifies both
enrollment and delegated-action signatures. It establishes grant status from
the historical predecessor and authority from the contract-pinned membership
attestation. Later revocation does not invalidate already committed history.
The standalone `replayDelegatedClientSignature` helper still reports
`authorityVerified: false` and `revocationVerified: false`: signatures alone do
not establish either fact and never mint live admission.

Approval guards see the registered holder fingerprint as
`$authorization.keyId`. Rotating or adding subordinate keys therefore cannot
create additional votes from one holder key. Replay records the holder as
`clientKeyId`, the subordinate as `delegatedKeyId`, and an explicit
`delegated-client-signature` authorization basis. Existing direct client
signatures continue to use their original proof format and replay semantics.

## Validation and original release

The automated tests exercise holder enrollment, browser key custody, queued
submission, broker restart, replay, private queue encryption and concurrent
updates, revocation races, expiry, cross-actor/audience/key/scope attacks,
duplicate grants, forged historical enrollment and legacy-policy isolation.
The deployment canary enrolls synthetic process-owned subordinate keys through
live MCP and verifies revocation and complete retained-proof replay. The live
Chromium test authorizes a grant with its synthetic passkey and signs two
separate queued MCP actions without a second holder signature. Synthetic keys
and approvals never count toward a real application's quorum.

The original release remains on its explicitly authorized contract until its
owner approves a concrete new contract epoch. Preserve its existing client
approval and quorum rules during that change. Actual reviewer enrollment and
approval must happen in that reviewer's authenticated session and owner browser;
the submitter must not manufacture the reviewer's key or proof.
