# I2IDL-X workbench hosting and optional connections

The existing Foxxi bridge serves the generated workbench at `/i2idlx/` and the generated reference at `/i2idlx/reference`. Public build outputs are available under `/i2idlx/dist/`. The legacy Claude artifact is an independent deployed artifact and is not overwritten by these routes.

The bridge Dockerfile now builds the TypeScript outputs in a separate build stage into production paths: `i2idlx/dist-ts`, `i2idlx/app/build-ts` and `i2idlx/site-ts`. The build stage fetches full canonical git history at commit `9f865995d879165d8fa49422915a5e53d2ecebf9`, verifies the glossary SHA-256 in `typescript/upstream-pin.json`, restores hash-pinned upper-ontology evidence and checked Foxxi evidence snapshots, and checks the downloaded ROBOT reasoner against its existing SHA-256. Git history, build-only Java and the reasoner cache do not enter the Node runtime image. No Python runtime is installed for this pipeline. Publication baseline timestamps are explicitly pinned to the handoff dates; regeneration does not silently restamp existing public graphs. The router returns HTTP 503 if the generated page is missing. It does not render a placeholder and claim successful hosting.

## Pod documents

Shared ballots, notes and usage have one document per derived Interego account. Policy has one editor-controlled document. The configured shared pod holds these public signed records; the bridge holds no database or persistent mirror. Configure:

- `FOXXI_I2IDLX_SHARED_POD_URL`: an existing shared HTTPS Interego pod.
- `FOXXI_I2IDLX_PARTICIPANTS`: comma-separated canonical own-pod account identifiers, for example `u-pk-...`.
- `FOXXI_I2IDLX_EDITORS`: comma-separated exact verified actor DIDs. An ordinary ReadWrite delegation does not itself grant policy-editor standing.
- `FOXXI_I2IDLX_OWNER_ANCHORS`: JSON object mapping each delegated account's canonical pod identifier to its independently authenticated owner Ethereum signing address. Obtain this binding from the owner's authenticated connection or a separately verified key, never unsigned pod profile/credential claims. Unconfigured delegated identities fail closed.
- `FOXXI_BRIDGE_PRIVATE_KEY`: a stable secret signing key from which the workspace encryption key is derived. Without it, private pod persistence refuses to write.
- The bridge's existing `FOXXI_POD_WRITE_SECRET` and tenant/store-origin configuration continue to govern authenticated pod transport.

Private packs, stars and recents live on the verified caller's own existing pod. They are encrypted to the owner-held X25519 key covered by that exact author's signature and the stable bridge encryption key. Unsigned pod key documents are never trusted as owner-key bindings. Missing signed owner keys, missing bridge encryption, absent own pods and plaintext private payloads are errors. The workbench creates neither identities nor pod registrations and changes no delegation or consent.

Each stored document retains the exact author-signed rev-196 request. Readers reverify the signature, author/pod/account binding, independently pinned owner signing key, configured participant/editor standing and current delegation. Credential verification and signer/scope checks consume the same immutable response snapshot. A cryptographic signature by an arbitrary wallet claiming an owner WebID does not establish ownership. Historical signatures are checked as records rather than replayed as fresh operations. Changes use the strong ETag from the preceding read, signed into the write. The empty expected ETag means creation only. A stale device gets a conflict and must read and merge. Durable success requires unchanged verified readback from the pod.

Pod state is stored as signed JSON snapshots under `i2idlx/workbench/`; these are application documents, not a claim that an RDF ContextDescriptor was published. The generic Interego affordance manifest provides their session, read and conditional-write controls. No domain operation was added to the generic Interego relay.

The shared record visibility is public to readers of the shared pod. Do not put secrets in ballots, notes or usage. Private workspaces are ciphertext at rest; the signed-in page still maintains its existing account-scoped browser copies and held edits. Connection failures never become empty verified data or successful saves.

## Identity and models

A host can connect its existing Interego MCP session through this browser capability contract:

```js
window.interegoWorkbench = {
  // Call the user's existing Interego sign_request tool.
  // Return the actual { _signed_payload, _signature } envelope unchanged.
  signRequest: async (payload) => /* actual connected MCP tool result */,
  // Owner-held key from the same authenticated signing context, never unsigned pod bytes.
  getOwnerEncryptionKey: async () => /* owned X25519 public key as canonical base64 */,
  // Optional real client sampling. Runs through that client's existing subscription.
  sample: async (messages, { signal, tools, onText, modelTier }) => /* actual {text,truncated} */,
};
// Optional: sample.limits() returns {tools:false} or {tools:{maxCount:...}}.
```

This is an explicit host integration seam. An ordinary browser cannot discover or spend a ChatGPT/Claude subscription merely because the user has one; no such automatic bridge is claimed here. If the host supplies no sampling function, Ask and live Orchestrate remain unavailable until the user connects a model. The original recorded orchestration remains explicitly a fictional sandbox example.

The Connect dialog can also use a browser wallet that owns an existing Interego account. Requests are signed by the wallet extension; the private key never leaves it. Session connection consumes a server-issued one-use nonce. Wallet extensions without an owned X25519 encryption-key capability keep private changes in the browser rather than claiming a pod save. Durable records require the owner/anchor signing key; ephemeral delegated session-key envelopes are refused consistently. The server derives the account from the verified identity's own pod and ignores claimed userIds and editor flags. Unsupported/unregistered identities fail closed.

As an optional fallback, a user can enter their own OpenAI API key and model name. The key stays in the current tab's closure and is sent directly to `api.openai.com`, never to the Railway/Foxxi server, pod or browser storage. API use is billed to that user. The connected client's subscription sampler takes precedence over this fallback. Disconnect removes the fallback from the active connection. No project-paid inference endpoint is provided.

## Validation

`applications/foxxi-content-intelligence/tests/i2idlx-workbench.test.ts` covers real fixture signatures, own-account authorization, editor enforcement, nonce consumption, audience binding, conditional-write races, missing ETags, author-proof tampering, historical records, revoked delegation, substituted unsigned owner keys, ciphertext-only private storage, owner decryption, absent encryption and unconfirmed acknowledgements.

These tests use generated test wallets and an in-memory HTTP pod double. They are software verification fixtures, not evidence of a live Interego write or deployed Railway behavior. Use `railway.toml` from the repository root and configure `railway.env.example` on the existing bridge service; these files create no service, database or new paid model connection by themselves.

Run the repository build/typecheck and targeted test module in CI, then verify production build identity and actual route responses after a separately authorized deployment.
