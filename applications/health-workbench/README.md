# Local health context adapter

**Layer 3 health application component — not Interego Protocol or a desktop-app extension API. Preparation only; no live local installation or connection is claimed.**

This dependency-free adapter prepares an explicitly selected, source-cited context packet for the existing Windows Interego encrypted-note host. It crosses a health-context-to-note-format boundary. It does not turn the generic desktop runtime into a medical application.

The input is a health workbench packet with a case identifier, source/review checkpoint, evidence entries, exact citation references and explicit truncation. The caller chooses the entries. `prepareLocalHealthNote` returns the native note operation's `{title, body}` arguments; it performs no network, storage, account, provider or publication operation.

```js
import { prepareLocalHealthNote } from './local-context.mjs';

// packet is supplied by an authorized source adapter, not discovered by this function.
const note = prepareLocalHealthNote(packet, {
  selectedEntryIds: [packet.entries[0].id],
});
// Inspect note locally. Only an independently authorized host may save it.
```

Run the standalone contract suite:

```sh
node --test applications/health-workbench/test/local-context.test.mjs applications/health-workbench/test/fictional-local-check.test.mjs
```

## The local app's existing contract

The current [Windows preview](../pod-desktop/README.md) encrypts note titles and bodies before writing them to its local pod and protects its notes key using Windows storage. Its agent operation `interego_save_note` appends a new note with a title of at most 160 characters and a body of at most 50,000 characters. This adapter rejects an oversized projection rather than silently trimming evidence or references. A complete clinical chart is not a note-sized context packet.

Preparation is not encryption. The returned object is ordinary plaintext in the calling process; only the authorized host's save path supplies its storage protection. A source digest or a declared `private` scope does not prove source authenticity, consent or encryption. This adapter grants no rights to its input.

If an agent is separately connected for saving output, `notes:create` is sufficient. The adapter needs no `notes:read` grant. Saving is append-only and creates a new host note identity. Keep the source case/checkpoint inside the note; do not replace source identities with the note identity.

The current desktop app's `notes:read` permission covers all notes available to that connection, including future notes. Searching for a health label or selecting one case in this adapter does not narrow that permission. Genuine per-case/per-resource read authorization is a separate host capability to implement and validate before broad chart-assistant access. Read the live connection's permissions and expiry; never infer a grant from this file or an earlier pairing.

## Evidence and privacy boundaries

- Choose entries explicitly. The output retains only the selected entries and the references they cite, with exact case binding.
- Preserve each entry's record type, original status, specimen identity and qualified dates. Selection, proximity and a common concept do not establish clinical relationships.
- Preserve the source packet's omission/truncation information. A selected context is not an exhaustive chart review.
- Working questions and retrieval queries are excluded by default. Optional inclusion of a reader question is separately labelled as a reader draft, not a clinical fact.
- Unknown input fields are not reflected into the prepared note. No credentials, accounts, provider APIs, source URLs or private records are discovered by the adapter.
- The note is a private-workspace output. Preparation does not approve any public publication or invoke the Health Connections publisher.
- A local pod stores data locally; an AI client that reads a note may send it to its model provider. Native storage and model inference are different boundaries.

## Composition and next gates

The useful composition is: an authorized source adapter supplies evidence; the health workbench selects context; this adapter prepares a bounded note; an explicitly authorized local host appends it. The public Atlas continues to receive only its separately approved publisher snapshot. Copying a local note to that snapshot is not part of this operation.

The accompanying fixture is fictional and contains no real patient. The workflow tests the adapter on Linux and Windows without installing dependencies, starting a pod, enabling a bridge, pairing a client or contacting a provider. This is not a packaged native-app or end-to-end clinical workflow test.

Its synthetic source checkpoint is SHA-256 of the UTF-8 string `Fictional local health context fixture version 1`; it is not a claim about a clinical publisher. The fixture's `responseBytes` describes its compact UTF-8 JSON representation, including that field.

Before claiming a live local integration: verify the installed app/version on the actual Windows computer; inspect the current native permission contract; use selected fictional context for an authorized append; verify encrypted persistence and readback through the intended route; test expiry/revocation; and independently decide any broader data access. Do not create a hosted identity, change the existing MCP connection, expose a tunnel or turn on sharing as an implicit setup step.

[Windows verification instructions](VERIFY-WINDOWS.md) include an executable fictional-note generator and exact response comparator. A create-only save returns the complete created note, so that first comparison needs no read grant. The comparator explicitly leaves response authenticity, installed-app behavior, encryption, restart persistence, expiry and revocation unverified; those require separate native observations.

The [selected import contract](IMPORT-CONTRACT.md) adds offline integrity checks for caller-supplied attachment bytes and a detached manifest bound to the exact selected context. It does not save attachments or grant access. Further health-file ingestion, native attachment storage, resource-scoped read grants, assertion review and public-release staging belong to separate domain/host contracts. Automatic provider synchronization and private-data publication are not implemented here.
