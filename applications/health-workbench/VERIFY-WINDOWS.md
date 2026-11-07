# Verify selected context on Windows

This kit prepares a fixed fictional note and compares a supplied native response. It has no host discovery, pairing, network, storage-write or private-note-read operation. Its comparison result cannot authenticate a copied response or prove a Windows installation works.

## 1. Check the available execution path

Record the installed Interego version and the source revision being evaluated. Use the actual local Windows app and a separately authorized client on that computer. Inspect its live `interego_status` and tool list. A save-only grant should list `interego_status` and `interego_save_note`; its status must show a running pod, the intended connection, `notes:create` and an unexpired grant. Setup text or a waiting connection alone is insufficient evidence.

If that route is unavailable, stop the native check and keep it pending. This kit does not install or pair an app, enable a web bridge, create a tunnel or change the current hosted MCP connection. No read grant is needed to examine a successful save response. The app's read grant covers every current and future note, so do not add it for this check.

## 2. Prepare and save fiction once

In a checkout of this change with Node 22 or later, run:

```powershell
node applications/health-workbench/tools/fictional-local-check.mjs prepare
```

The output is exactly the `{title,body}` arguments for `interego_save_note`. It contains two invented records with intentionally different statuses and a declared evidence gap. Through the authorized local client, submit those arguments once. Record the returned native note ID. If the append outcome is ambiguous, inspect the app before any retry; another save creates another note.

Save only the successful tool's `structuredContent` object, shaped `{ "note": { ... } }`, as a local `response.json` using your editor. This is a local test artifact, not a request to upload notes or configuration into a chat. It contains the fictional note plus the connection label and native metadata. Do not include credentials, tool setup, unrelated notes or an MCP envelope.

## 3. Check the exact save response

Replace the connection placeholder with the ID independently observed in the live status:

```powershell
node applications/health-workbench/tools/fictional-local-check.mjs check response.json --connection-id CONNECTION_ID
```

The comparison requires exact title/body, a valid native note ID and timestamps, and the expected author connection. It accepts a regular response file of at most 128 KiB, reading at most one extra byte to detect overflow, and writes a report to stdout. Symlinks and special files are rejected. It never invokes a save or reads the pod. A `fictional-content-match` result proves only the supplied data matches the fixture; authenticate the actual tool route separately. Failure emits no supplied note content or parser excerpt.

For a later independently obtained response, also supply the original ID:

```powershell
node applications/health-workbench/tools/fictional-local-check.mjs check response.json --connection-id CONNECTION_ID --note-id ORIGINAL_NOTE_ID
```

Do not treat the original save response as a later readback. A read through an already authorized isolated test client can supply another `{note}` response; do not expand read access to an existing personal pod merely to obtain one.

## 4. Observe persistence separately

In the owner app, open only the fictional note. Compare its complete body with the prepared body, including order `completed`, administration `not-done`, source references and the declared omission. Quit and reopen the app, then repeat the comparison. Record this as an owner-observed result with app version and time. Without the actual observation, persistence remains pending. A screenshot, visible title, successful append response or the offline comparator alone is insufficient.

## 5. Keep separate checks explicit

| Check | Evidence required | What this kit establishes |
|---|---|---|
| Fixture content | Exact supplied response comparison | Content and metadata shape only |
| Native route and grant | Actual installed app, live status/tool list and authenticated operation | Pending until observed |
| Persistence | Same fictional note after an actual app restart | Pending until observed |
| Encryption at rest | Isolated native storage test with protected-key and encrypted-distribution checks | Not established by a save response or plaintext absence alone |
| Expiry/revocation | Dedicated disposable connection, denied later operation and no extra append | Separate test; never alter the real Windows clock |
| Private chart access | Resource-scoped authorization and an independently approved workflow | Not exercised |

Existing desktop tests cover permission-filtered discovery, denied reads on create-only grants, revocation, mocked-time expiry, queued authorization and encrypted controller storage. See `../pod-desktop/tests/agent-stdio.test.ts`, `agent-service.test.ts` and `pod-desktop-controller.test.ts`. Their results are software evidence, not proof about the installed Windows app. The broader packaged smoke also simulates bridge and pairing flows; it is not this minimal check.
