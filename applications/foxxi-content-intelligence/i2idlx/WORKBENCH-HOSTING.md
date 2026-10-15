# I2IDL-X workbench hosting and optional connections

The existing Foxxi bridge serves the generated workbench at `/i2idlx/` and the generated reference at `/i2idlx/reference`. Public build outputs are available under `/i2idlx/dist/`. The legacy Claude artifact is an independent deployed artifact and is not overwritten by these routes.

The bridge Dockerfile now builds the TypeScript outputs in a separate build stage into production paths: `i2idlx/dist-ts`, `i2idlx/app/build-ts` and `i2idlx/site-ts`. The build stage fetches full canonical git history at commit `9f865995d879165d8fa49422915a5e53d2ecebf9`, verifies the glossary SHA-256 in `typescript/upstream-pin.json`, restores hash-pinned upper-ontology evidence and checked Foxxi evidence snapshots, and checks the downloaded ROBOT reasoner against its existing SHA-256. Git history, build-only Java and the reasoner cache do not enter the Node runtime image. No Python runtime is installed for this pipeline. Publication baseline timestamps are explicitly pinned to the handoff dates; regeneration does not silently restamp existing public graphs. The router returns HTTP 503 if the generated page is missing. It does not render a placeholder and claim successful hosting.

## Pod documents

Shared ballots, notes and usage have one document per derived Interego account. Policy has one editor-controlled document. The configured shared pod holds these encrypted signed records for admitted participants; the bridge holds no database or persistent mirror. Configure:

- `FOXXI_I2IDLX_SHARED_POD_URL`: an existing shared HTTPS Interego pod.
- `FOXXI_I2IDLX_PARTICIPANTS`: comma-separated canonical own-pod account identifiers, for example `u-pk-...`.
- `FOXXI_I2IDLX_EDITORS`: comma-separated exact verified actor DIDs. An ordinary ReadWrite delegation does not itself grant policy-editor standing.
- `FOXXI_I2IDLX_OWNER_ANCHORS`: JSON object mapping each delegated account's canonical pod identifier to its independently authenticated owner Ethereum signing address. Obtain this binding from the owner's authenticated connection or a separately verified key, never unsigned pod profile/credential claims. Unconfigured delegated identities fail closed.
- `FOXXI_BRIDGE_PRIVATE_KEY`: a stable secret signing key from which the workspace encryption key is derived. Without it, shared and private pod reads/writes refuse to proceed.
- The bridge's existing `FOXXI_POD_WRITE_SECRET` and tenant/store-origin configuration continue to govern authenticated pod transport.

Shared ballots, notes, usage and policy are encrypted to each author's signature-bound owner X25519 key plus the stable bridge key. Shared reads require a verified signed request from an admitted account; anonymous and nonparticipant reads are refused. Empty/missing participant, key or shared-pod configuration fails closed. Existing shared and own pods are checked before state is read or created; this workbench provisions no pods.

Private packs, stars and recents live on the verified caller's own existing pod. They are encrypted to the owner-held X25519 key covered by that exact author's signature and the stable bridge encryption key. Unsigned pod key documents are never trusted as owner-key bindings. Missing signed owner keys, missing bridge encryption, absent own pods and plaintext private payloads are errors. The workbench creates neither identities nor pod registrations and changes no delegation or consent.

Each stored document retains the exact author-signed rev-196 request. Readers reverify the signature, author/pod/account binding, independently pinned owner signing key, configured participant/editor standing and current delegation. Credential verification and signer/scope checks consume the same immutable response snapshot. A cryptographic signature by an arbitrary wallet claiming an owner WebID does not establish ownership. Historical signatures are checked as records rather than replayed as fresh operations. Direct wallet signatures additionally require their canonical derived Ethereum account pod and match any configured owner pin. Changes use the strong ETag from the preceding read, signed into the write. The empty expected ETag means creation only. A stale device gets a conflict and must read and merge. Durable success requires unchanged verified readback from the pod. Document JSON is limited to 1,000,000 UTF-8 bytes and the exact signed payload to 1,100,000 UTF-8 bytes; the retained encrypted envelope permits 6,000,000 bytes to cover proof duplication, JSON escaping and base64 expansion.

Pod state is stored as signed JSON snapshots under `i2idlx/workbench/`; these are application documents, not a claim that an RDF ContextDescriptor was published. The generic Interego affordance manifest provides their session, read and conditional-write controls. No domain operation was added to the generic Interego relay.

Shared team records and private workspaces are ciphertext at rest. Shared plaintext is returned only to admitted participants through the signed read operation; the signed-in page still maintains its existing account-scoped browser copies and held edits. Connection failures never become empty verified data or successful saves. Shared review status stays unavailable until every shared collection and policy is verified; disconnect/account changes remove loaded shared plaintext from the view.

## Ask and Orchestrate through your connected MCP client

These two real read-only HTTP affordances are advertised by the Foxxi manifest and `GET /i2idlx/capabilities`:

| Action | Route | Arguments |
| --- | --- | --- |
| `urn:iep:action:foxxi:i2idlx-ask` (`foxxi.i2idlx_ask`) | `POST /i2idlx/api/ask` | `question` (at most 4,000 UTF-8 bytes), optional `concept_ids` (at most 14 existing ids) |
| `urn:iep:action:foxxi:i2idlx-orchestrate` (`foxxi.i2idlx_orchestrate`) | `POST /i2idlx/api/orchestrate` | `example:true` for the labelled fictional walkthrough, OR `brief` and 1–20 `records`; optional `concept_ids` |

Connect the Interego MCP app in your own ChatGPT/Claude/other supported AI client. Ask that client to discover the Foxxi bridge's advertised I2IDL-X actions; follow the actual action IRI using Interego's generic `act` operation and the declared arguments. For example:

1. Discover `urn:iep:action:foxxi:i2idlx-ask`, act on it with `{"question":"How is a learning record store connected to competency-based learning?"}`, then answer in this conversation using the returned exact definitions and `[[concept-id]]` citations.
2. Discover `urn:iep:action:foxxi:i2idlx-orchestrate`, act on it with `{"example":true}`, then follow the returned eight-role recipe in this conversation with your own model. Invoke only currently discovered real controls. State which checks ran and which remain pending.
3. For your inventory instead of the example, supply `{"brief":"Classify our learning inventory","records":[{"id":"our-lrs","title":"Learning record store","description":"Our xAPI statement store."}]}`. Do not combine custom records with `example:true`.

Both operations return `execution:"client-required"`, `status:"instructions-only"`, `sampling_performed:false` and `writes_performed:false`. They deliver a task for the client's own model, not a server answer or a completed run. The server neither spends a model subscription nor takes an API key. An Interego connection makes these operations discoverable/callable; the AI client executes the reasoning under its own available subscription/model. The client must report unavailable tools rather than invent results. No task/session/run is persisted by these endpoints.

Public context comes only from the same generated `app/build-ts/data.json` used by the workbench: release/commit and rights, at most 14 selected entries with source evidence, relevant semantic categories/disjointness/crosswalk bridges, and published catalog control inputs/queries. Ask shares its actual instruction source with the browser. Orchestrate reads the existing `orc/scenario.js` role charters and twelve dependency steps. Browser sandbox tool names are labelled source descriptors; they are not new MCP tools. No team notes, ballots, usage, private workspace, secrets or recorded transcript is returned.

The task response is capped at 256,000 UTF-8 bytes and marked no-store. Input is capped at 128,000 bytes, generated public data at 16,000,000 bytes, briefs at 6,000 bytes, inventories at 20 unique entries and each workflow step at six instructed tool rounds with at most two parallel roles. Unknown concept ids, unsupported model/key/path/URL parameters, invalid/missing public artifacts and oversized context are refused. Bounded lexical retrieval does not prove a glossary gap; use explicit ids or follow another read control when more evidence is needed. No arbitrary input can choose a file or network target. `FOXXI_I2IDLX_APP_DATA_FILE` is an optional deployment-only override for the generated public data file.

The final stage produces proposed exact governed calls for human review. The operation does not stage, ratify or publish them, create an approval gate, or grant publication authority. Any subsequent external write uses a separately discovered governed control and actual authorization.

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

This is an explicit host integration seam. An ordinary browser cannot discover or spend a ChatGPT/Claude subscription merely because the user has one; no such automatic bridge is claimed here. If the host supplies no sampling function, Ask and live Orchestrate inside the browser remain unavailable until the user connects a model. The connected MCP-client task workflow above remains available without a browser sampling adapter. The original recorded orchestration remains explicitly a fictional sandbox example.

The Connect dialog can also use a browser wallet that owns an existing Interego account. Requests are signed by the wallet extension; the private key never leaves it. Session connection consumes a server-issued one-use nonce. Wallet extensions without an owned X25519 encryption-key capability cannot save shared records and keep private changes in the browser rather than claiming a pod save. Durable records require the owner/anchor signing key; ephemeral delegated session-key envelopes are refused consistently. The server derives the account from the verified identity's own pod and ignores claimed userIds and editor flags. Unsupported/unregistered identities fail closed.

As an optional fallback, a user can enter their own OpenAI API key and model name. The key stays in the current tab's closure and is sent directly to `api.openai.com`, never to the Railway/Foxxi server, pod or browser storage. API use is billed to that user. The connected client's subscription sampler takes precedence over this fallback. Disconnect removes the fallback from the active connection. No project-paid inference endpoint is provided.

## Validation

`applications/foxxi-content-intelligence/tests/i2idlx-workbench.test.ts` covers real fixture signatures, own-account authorization, editor enforcement, nonce consumption, audience binding, conditional-write races, missing ETags, author-proof tampering, historical records, revoked delegation, substituted unsigned owner keys, ciphertext-only shared/private storage and admitted-reader enforcement, owner decryption, absent encryption, bounded large encrypted round-trips and unconfirmed acknowledgements.

`applications/foxxi-content-intelligence/tests/i2idlx-client-tasks.test.ts` verifies canonical read-only discovery, actual public context/instructions, relay-envelope argument compatibility without identity claims, eight-role dependencies, no private-state projection, input/output bounds and unavailable-artifact refusal. These are task-packet tests, not evidence that a model executed the returned recipe.

These tests use generated test wallets and an in-memory HTTP pod double. They are software verification fixtures, not evidence of a live Interego write or deployed Railway behavior. Use `railway.toml` from the repository root and configure `railway.env.example` on the existing bridge service; these files create no service, database or new paid model connection by themselves.

Run the repository build/typecheck and targeted test module in CI, then verify production build identity and actual route responses after a separately authorized deployment.


## Trying capabilities in the hosted workbench

Open [Capability directory](https://foxxi-bridge.interego.xwisee.com/i2idlx/#agents-directory) and refresh the live inventory. The hosted directory reads the deployment's Foxxi contracts and Relay's advertised operations and input schemas; an unavailable source is shown as partial, and the embedded build snapshot remains explicitly unverified.

Expand an operation, choose **Load example**, edit its typed fields or JSON, and use **Run live example** where offered. The result shows the actual target response, HTTP status, timestamp and duration. Good starting points are LRS discovery, intervention methods, decoration binding and Relay descriptor composition. LRS discovery reports the current deployment's storage mode; the present in-memory LRS is transient and loses records on restart.

**Validate inputs** checks supported declared input constraints without invoking the operation. Protected operations provide a prepared call for an authenticated Interego client and display the required identity, permissions, data and configuration. **Prepare client task** returns real grounded instructions for the connected AI client; it does not execute a model or complete the workflow. A listed operation or a schema-valid request is not execution evidence.

Do not paste API keys, passwords, private keys, seeds, bearer headers or signed envelopes into this public runner. Its fixed client placeholders support contract checks; the connected client supplies real credentials through its existing identity or key provider. Explicit public examples perform no primary pod/lattice writes or project-paid model calls; ordinary access logs and operational service telemetry may still be recorded.

The four formerly unimplemented actions use authenticated own-pod access. Lesson loading does not certify consumption or completion. Progress claims and reported compliance events remain Hypothetical and are encrypted with a signature-bound owner key. Concept-map publication reads the real on-pod course package and verifies encrypted publication readback. LMS verification requires an operator-configured HTTPS account probe; it does not schedule synchronization. These operations cannot write without the required owner-held encryption key and deployment configuration.
