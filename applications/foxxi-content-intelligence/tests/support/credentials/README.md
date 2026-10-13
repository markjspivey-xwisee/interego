# Credential fixtures

Open Badges 3.0 and CLR 2.0 credentials, each with its RDF reading, for
`tests/credentials-the-specs-allow-conform-in-both-readings.test.ts`.

| File | What it is |
|---|---|
| `<name>.json` | A credential. `ob3-*` and `clr-*` are written by hand; `foxxi-*` are what Foxxi's own code issues, built from fixed inputs by `foxxi-fixtures.ts`. |
| `<name>.nq` | Its RDF reading: N-Quads from jsonld.js `toRDF` in safe mode, through the W3C VC 2.0 contexts and 1EdTech's Open Badges 3.0.3 and CLR 2.0.1 contexts. An embedded proof is in a named graph of its own. |
| `<name>.refused.json` | In place of a reading, when JSON-LD safe mode refuses the document: the code and message it gave. |

The valid fixtures are credentials 1EdTech's data model tables allow (Open Badges 3.0 and CLR 2.0,
Appendix B); each invalid one breaks exactly one requirement and is named for it. The proof value in
`ob3-embedded-proof.json` is not a signature: these fixtures test the shapes, not proofs.

## Regenerating

1EdTech's contexts are 1EdTech's to distribute, so they are not copied here; the readings are made
by whoever changes a fixture, and checked in:

```sh
npx tsx applications/foxxi-content-intelligence/tools/read-credential-fixtures.ts
```

This rewrites the two `foxxi-*` fixtures from the code, then reads every fixture, fetching each
context from its URL and refusing one whose SHA-256 differs from the digest recorded in the tool
(`--contexts <dir>` reads them from a directory instead). The digests, as read on 2026-10-12:

| Context | SHA-256 |
|---|---|
| `https://www.w3.org/ns/credentials/v2` | `59955ced6697d61e03f2b2556febe5308ab16842846f5b586d7f1f7adec92734` |
| `https://www.w3.org/ns/credentials/undefined-terms/v2` | `82dab514ba44eb18f5d1b0f638c5e140c6a556fbfb5089601bdc0fa5eb8b2581` |
| `https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.3.json` | `3d34f4d4ef1bce691106e63798beb5e7b862ba841423f5ee1e53ab7ddf3bca84` |
| `https://purl.imsglobal.org/spec/clr/v2p0/context-2.0.1.json` | `880f1902d4158f2f33ce06af41b90719977cd1ea337a9de2e41edb3ff5e543d6` |

The test fails if the `foxxi-*` fixtures are no longer what the code builds, which is the signal to
run the tool.
