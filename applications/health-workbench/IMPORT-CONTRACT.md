# Selected context and attachment preparation

Layer 3 health application contract. `prepareSelectedHealthImport(packet, attachments, options)` prepares native note arguments and a detached attachment manifest from caller-supplied memory. It neither reads files nor saves attachments. No native attachment operation is advertised or implemented by this module.

The context packet and `selectedEntryIds` follow [the existing adapter](README.md). `selectedAttachmentIds` is also mandatory; use `[]` to select no attachments. The bounded catalog accepts up to eight distinct case-bound IDs. Only selected attachment bodies are examined. Each selected row supplies:

| Field | Contract |
|---|---|
| `id` | Unique case URI plus a fragment containing letters, digits, dot, underscore, tilde or hyphen; separate from selected context entity IDs |
| `caseId` | Exact context case URI |
| `snapshotKey` | Exact key emitted by the context adapter: JSON string of `[caseId, sourceRevision, sourceDigest, reviewRevision]` |
| `entryIds` | One or more explicitly selected evidence IDs |
| `sourceIds` | One or more selected citation IDs, each cited by at least one mapped entry; each mapped entry must cite at least one listed source |
| `mediaType` | Declared `application/pdf`, `application/json` or `text/plain` |
| `bytes` | Caller-supplied `Uint8Array` view, including Node Buffers; shared memory is refused |
| `byteLength` | Exact view length, from 1 byte through 4 MiB per attachment; 8 MiB total selected bytes |
| `digest` | Lowercase `sha256:` digest of precisely that byte view |

The returned `{note, manifest}` retains selected IDs, declared media types, byte lengths and verified digest comparisons. `preparedNoteDigest` hashes UTF-8 `JSON.stringify(note)`, binding the detached manifest to both the exact title and body. Unknown attachment fields, local paths, URLs and raw bytes are not copied to the manifest. The returned arrays are independent of the caller's arrays. Invalid selections produce no partial result.

The native save operation accepts **only `note`**, which remains plaintext. It does not accept this manifest or attachment bytes. A later attachment host must independently implement storage, encryption, lifecycle and resource-scoped authorization, and return authenticated receipts before any persistence claim. A manifest must not be presented as an uploaded attachment.

Hash agreement establishes correspondence with the supplied declaration. It does not authenticate a source, prove a citation's clinical content, identify a file's true media type, establish file safety or grant access. The manifest lists these unresolved checks. The existing native `notes:read` grant still includes all current and future notes; case IDs and selections do not narrow it. Nothing here changes that grant or connects private records or a provider.

Development uses the fictional context packet and invented byte arrays in `test/import-manifest.test.mjs`. Run all standalone health contracts with:

```sh
node --test applications/health-workbench/test/*.test.mjs
```

No PDF parsing, OCR, archive extraction, executable content handling, automatic attachment discovery or publication is included. Health and learning semantics remain separate from the generic Interego substrate.
