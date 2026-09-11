# Scoped client signing grants: proposed verifier

This is a reviewable protocol component for issue #390. It is **not enabled** in
the relay, identity service, application interpreter or original release. The
current `client-signature/v1` policy rejects this proof format. No credential or
grant has been enrolled by this work, and no actual review has been submitted.

The implementation is `integrations/application-runtime/client-signing-grant.ts`.
It belongs to the optional application runtime; the base Interego layer acquires
no game, review or release rules.

## Custody and the intended enrollment flow

The intended signer is an owner-controlled process alongside the agent runtime,
such as the reviewer's own Claude Code installation. It generates and retains
its subordinate Ed25519 private key locally. The MCP relay, identity service,
another reviewer and the model receive public keys and proofs only. This is an
integration design, not evidence that the current hosted Claude session exposes
such a process. Public-key signatures prove possession, not physical custody.

The process proposes a grant naming one issuer, authenticated agent, relay origin,
resource pod, application, action and exact contract digest. A copied application
on another pod does not match that scope. There are no wildcards or further
delegation rights. A random UUID distinguishes the grant; its content digest is
also part of the authority binding. The grant lasts at most one hour.

The owner reviews that scope and signs the canonical grant with an existing
registered wallet, passkey or Ed25519 credential. The subordinate key separately
signs the same grant to prove possession. Each signature uses the existing client
signature domain containing its own mathematical public-key fingerprint. The
issuer and subordinate keys must differ.

`verifyClientSigningGrant` checks both signatures, the caller-supplied trusted
issuer/agent/audience binding, the issuer's current registered key material and
the grant lifetime. Its result is an enrollment proposal, not a login credential,
registration write or action approval. The future enrollment adapter must verify
that this issuer is authorized to delegate to this particular agent; the issuer
field in the proposal is never sufficient authority.

## Action verification

The subordinate signs a distinct canonical document containing the complete action
receipt, grant ID, grant digest and audience. This prevents its proof from being
reinterpreted as a direct account-key signature or reused under another grant.
The expected receipt must be assembled independently from verified resource
authority. It binds the predecessor, action inputs and evidence as before.

`verifyDelegatedClientAuthorization` requires the following from a trusted adapter:

| Input | Required source |
| --- | --- |
| Issuer | The versioned policy and verified delegation authority |
| Actor | The authenticated agent session |
| Audience | The configured serving relay origin |
| Issuer keys | The issuer's current authenticated identity record |
| Clock | The verifier runtime |
| Grant status | A current authoritative read matching ID, digest, issuer, actor and key fingerprint |

Unknown, unavailable and revoked grants fail closed. Time is checked again after
the asynchronous status read. A caller's `active: true` flag is not a status
source. The callback must implement the exact binding comparison: the library
does not include a grant database, storage authentication or a revocation endpoint.

The verifier returns a frozen, process-bound result. Copying or deserializing it
does not create an admission capability. Consuming it rechecks its time limits.
Its capability is deliberately distinct
from `VerifiedClientAuthorization`, so this module cannot relax the existing
client-proof policy. An adapter must still recheck current resource authority,
grant revocation and the predecessor at the commit boundary. This verifier alone
does not prevent duplicate publication or provide an atomic cross-resource grant
revocation/commit transaction.

## Retained evidence and replay

The result retains the grant, owner proof, possession proof and action proof,
including the registered issuer public-key restrictions used during admission.
Both issuer and subordinate fingerprints remain visible. A distinct subordinate
key is not evidence of a different human or independent reasoning.

`replayDelegatedClientSignature` checks signatures and whether the signed action
time was inside the grant interval. It deliberately returns
`authorityVerified: false` and `revocationVerified: false`. Old signatures do not
prove that the issuer was authorized or the grant was unrevoked at action time.
A complete replay adapter needs pinned historical registration, issuer authority
and revocation evidence. Historical verification never creates live admission.

## Remaining integration and activation work

1. Confirm the actual reviewer's owner-controlled signer process and its custody
   boundary. Implement the local companion and public proposal transport there;
   do not generate its real key in the submitter's runtime.
2. Implement authenticated descriptor-bound enrollment, status and revocation
   resources. Preserve issuer authority and historical status evidence, and
   define how revocation is serialized with action publication.
3. Add owner consent through the existing holder interaction and verify the
   proposed grant's scope before signing. OAuth access does not sign the grant.
4. Integrate a separately versioned delegated-proof application policy and replay
   adapter. Present the concrete contract change for authorization before changing
   the original release. Preserve its current approval and quorum rules.
5. Exercise the real host, signer process, grant lifecycle and original review.
   Unit tests establish only this component's behavior, not that hosted flow.

The tests cover real cryptographic signatures, wrong issuer/actor/key/audience,
out-of-scope actions, possession failures, altered grants, invalid lifetimes,
expiry during verification, revoked/unknown/unavailable status, cross-head and
cross-grant proof reuse, immutable inputs and direct-policy isolation. They use
test-owned keys in one process and do not count toward the original quorum.
