# Client authorization of declared actions

The hosted relay's descriptor authorship proof is a relay attestation. Different
authenticated actor DIDs do not make those signatures independently keyed.

An action with `clientSignature: true` requires a separate signature made by a
currently registered credential of its authenticated actor. Supported credentials
are Ethereum wallets (EIP-191), agent-held Ed25519 keys, and WebAuthn passkeys.
There is no relay fallback for this requirement.

## Review and sign

1. Read the current signed catalog, contract, state and evidence. Follow the
   descriptor-bound **Preview** control with the action inputs.
2. The result includes a `signingRequest` containing the complete receipt and
   public verification material. Its `signingUrls` open `/sign-action` on the
   registration origins. The request travels in a URL fragment, which is not sent
   to the web server; the page removes the fragment from browser history after
   reading it. It also accepts the request as pasted JSON.
3. On the page, review the actor, action, contract digest, state head, inputs and
   evidence. Select the registered credential and sign. Wallet signatures and
   passkey assertions are created in the browser. The page sends neither a private
   key nor the approval to a server.
4. Follow the original **Submit** control with the same action inputs and the
   returned JSON in `client_proof`. Interego re-reads the current authority and
   registered credentials, verifies the signature, evaluates the guard, and uses
   the existing synchronous CAS publication path. Signatures expire for admission
   after ten minutes. Any intervening state, contract, catalog or definition
   change requires a fresh preview and signature.

The key used for signing must belong to that session. Opening another chat with
the same connector does not create another identity. Reviewers need their own
authenticated connections and credentials; this flow never invents reviewers.

## An agent signs in its own runtime

An agent runtime that already holds its registered wallet or Ed25519 key can use
the process signer. Save the preview's `signingRequest` as `request.json`, review
the full receipt, and compute its SHA-256 over the exact UTF-8 `message` string.

```sh
INTEREGO_CLIENT_KEY_FILE=/secure/agent-key \
  node tools/sign-application-action.mjs request.json REVIEWED_RECEIPT_SHA256 proof.json
```

The existing key file contains a hexadecimal wallet private key or an Ed25519 PEM.
It stays in that agent's environment. The signer refuses a key not listed for the
authenticated actor and refuses to overwrite an existing output. Submit the
public proof through the original Interego MCP control. The signer neither
authenticates a new identity nor reviews or submits an action itself.

## Autonomous tests with two confirmations

Run the hosted test from a built checkout with Node 20 or later:

```sh
INTEREGO_LIVE_CANARY=1 node --import tsx tools/client-signature-canary.mjs
```

The runner starts three processes: a submitter and two reviewers. Each creates
its own ephemeral wallet, authenticates through ordinary SIWE/PKCE, and retains
its private key and session credential inside that worker. The coordinator
receives public identities, receipts and signatures. No human passkey prompt,
connector reconnection, existing account key or reviewer message is needed.

Each worker reads the published fixture through its own MCP session, verifies
the contract and candidate result, obtains its own current preview, checks the
receipt's actor and artifact bindings, and invokes the process signer. The
declarative fixture excludes the submitter, rejects repeated actors and keys,
and requires two verified confirmations of the same candidate before the
submitter can finish. The live test exercises the refusals and successful
completion, then cryptographically verifies retained proofs and the full replay.

This is a repeatable integration test of separately authenticated, separately
keyed confirmations. The workers run a deterministic test check on the same
host; this does not establish independent human judgments or isolation from
the host operator. These fresh identities and the explicitly synthetic fixture
do not supply approvals for an existing release or impersonate its reviewers.

The `Client signature live check` GitHub workflow runs the same command and
retains its public JSON report. Locally, the report is written to
`$RUNNER_TEMP/client-signature-live.json`, or the system temporary directory
when `RUNNER_TEMP` is unset. It contains no private keys or bearer tokens.
Worker key files are removed on exit; the synthetic public pod artifacts remain
available for replay. `EXPECTED_RELAY_BUILD` optionally pins an exact deployed
relay commit. Extend `tools/client-signature-fixture.mjs` and the worker's
candidate checks together when testing another synthetic approval scenario.

## Contract policy and replay

`clientSignature` is an application-runtime declaration, not an L1 ontology term.
The runtime knows no approval or release vocabulary. It provides verified
`$authorization.verified`, `$authorization.keyId` and `$authorization.scheme` to
ordinary declarative guards and effects. The application decides which actions
require signatures, which actors may participate, and how many distinct keys
are required.

For an independent-key approval policy, require a client signature on the
approval action, exclude the submitter, reject an existing actor or key, and
retain the verified actor and key ID in the approval record. Activation must
count distinct verified keys as well as actors and check the approved artifact
digests. Existing relay-only records cannot be upgraded by changing their label;
they remain historical and must not count toward that requirement.

Replay re-verifies the retained client signature against the complete receipt,
then re-evaluates the guard and effects using the recovered key ID. Modifying a
receipt and recomputing its outer digest cannot repair an invalid client
signature. Freshness applies when admitting a signature; historical replay does
not expire a previously accepted action.

The identity service binds the public credential to the account at admission.
Replay retains that admitted public-key snapshot, so later credential removal
does not erase an earlier signature. This is still an identity-service binding,
not a claim that identity enrollment is decentralized. Distinct keys also do
not prove distinct humans, organizations, or independent reasoning. Those are
separate reviewer-selection requirements.

Ordinary descriptor publication remains relay-attested for compatibility. Its
`signatureAuthority` and `signingNote` describe that explicitly. An application
must opt into and enforce the client-signature requirement; the presence of a
valid descriptor proof alone never establishes it.
