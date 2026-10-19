# I2IDL v0.0.93 adoption review

Reviewed 2026-10-19 against the previously pinned v0.0.86, under the user's explicit instruction to review v93 and pin to it. This record describes source review and implementation intent; generated reports and CI identify the checks actually executed.

## Immutable source

- Repository: `blakeplock/i2idl-linked-data`
- Release: `v0.0.93`
- Commit: `0754254be64f0562bab7e68d69583f2cc90aa945`
- Path: `public/glossary.jsonld`
- Git blob: `56e84b0a3c8084162b4505d0064547fae2235303`
- Last glossary-changing commit: `b75261de5ad7851c1f61607091cc00e486bbbb5f` (the checkout pin above includes the identical blob)
- Raw UTF-8 bytes: 1,416,388
- SHA-256: `db172a650fc34766b81a1d75ae0f351131fcd6a0623ddc4b7f2bdd3643a40e6a`

The comparison used exact Git blobs, not only the v93 release notes. The baseline was v86 commit `9f865995d879165d8fa49422915a5e53d2ecebf9` and glossary SHA-256 `e075d1210c952f06609337c48a58079495ae324f3de05566971ebd6ee3f48751`.

## Source differences

There are 420 concepts and active definitions, up from 397. All 397 existing definition objects are unchanged and no concept IRI was removed. The source adds 23 concepts, ERIC as a fifteenth source and 92 directed `skos:related` links. Existing broader/narrower and external mapping counts are unchanged. Digital Literacy keeps its IRI and former plural label as an alias. The context namespaces and semantic profile version remain unchanged.

The new concepts omit the duplicate `skos:definition`, `schema:inDefinedTermSet` and editorial status fields. Their definitions remain available through `gs:activeDefinition` and `rdf:value`. Those definition nodes omit explicit `prov:Entity`, language and definition sequence. ERIC is a `schema:CreativeWork`, rather than a `dcterms:BibliographicResource`.

Readers and the release contract accommodate that actual profile while retaining required concept identity, membership, active-definition, value, evidence and source-resolution checks. Missing language and sequence remain unknown; missing editorial status derives a conservative Hypothetical decoration. No missing canonical field is filled in or rewritten.

The workbench uses published rather than blanket-approved counts. An entry with absent editorial metadata shows Not supplied and a Hypothetical chip; absent language and sequence do not leave empty metadata. The desktop/mobile hosted visitor check opens the new LMS term, reads its active-only definition and checks the release-derived search count.

All 23 new definitions have supporting evidence. They remain synthesized under the existing provenance rule. ERIC's rights text is preserved as an upstream statement, not an independent legal determination. The mixed source-specific reuse policy remains in force. The separate French catalog retains its own publicationVersion v0.0.90.

All 46 glossary-affecting commits reachable through the checkout pin were inspected as exact Git blobs and grouped by their actual scheme publicationVersion. They contain 30 release groups, including the 23 retained through v86 and seven subsequent releases. This is derived from source history, not release-number arithmetic.

## Decoration review

All 23 new concepts receive explicit definition-based referent assignments in the existing proposed semantic layer. The canonical concepts are not retyped and no new equivalence or ratification is introduced. The native regression test checks the distinctions between software applications, ecosystems, activities, methods, assessments, competence, information, models, processes, technology, situations, quality and measures.

The new `learning-management-systems` concept resolves LMS-X's v86 gap. LMS-X 0.1.1 proposes a relatedMatch for its LMS description and removes the obsolete NoTermFound row. The proposal does not equate a deployed LMS instance with a vocabulary concept. The other four decoration specifications retain their existing content and release-scoped gap statements.

The retained UNESCO snapshot was checked against v93 using the existing citation/mapping extraction algorithm: all 21 target terms, 13 citation bindings and 12 mapping bindings are unchanged. Its original v86 capture annotation is preserved.

The separate REST service tooling stays pinned to v89 / API 1.0.0. Its OpenAPI, v1 handler, context handler, graph handler, MCP adapter and version-history blobs are identical in the v89 and v93 commits. Existing evidence is not relabelled as a new capture.

## Release gates

Use a clean full-history v93 checkout and verify the raw source digest. Rebuild both implementations with the original creation date and the frozen adoption modification timestamp. Run native and independent Python validation, HermiT, worked examples, the client oracles and hosted user journeys. Preserve all strict guards and the complete golden comparison.

Generate exact candidate publication bytes before publishing. Existing receipts cannot establish equality with newly generated graphs. Publish genuine signed successors in the original project pod with fresh head checks and the existing graph modalities, retain prior descriptors, then require all ten live Turtle and JSON-LD graphs to match the build. The two changed LMS-X graphs have a separate receipt history; the other eight shared-kit graph outputs must remain unchanged.

Keep the maintenance PR draft and unmerged. No reviewer vote, mapping ratification, fictional academy publication, identity change, new key or permission expansion is part of this adoption.
