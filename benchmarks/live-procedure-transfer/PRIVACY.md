# Public evidence boundary

This directory publishes a minimal, unsigned derivative of a private experiment capture. The original archive, source documents, and raw traces are excluded from this publication and its new Git history. They are not downloadable dependencies of the public audit. This statement does not promise durable private storage of the originals.

## Included

- Per-case scores, question counts, call counts, recorded batch counts, and source-observed replay counts.
- Sequential per-call indices, remapped batch numbers, six generic tool names, generic procedure step identifiers, captured output byte counts, and failure flags/categories.
- The two procedures' structural projections: a count of eight resource roles, ten named steps, and eleven dependency edges.
- Code that checks the public accounting and structure, plus an exporter for holders of the original capture.

These are measurements and structural metadata. Recorded success and verification counts describe what the source capture reported; they are not independently authenticated by their presence in this directory.

The whole original archive's SHA-256 and file count are included as an integrity commitment. They disclose neither the archive contents nor a retrieval address. This hash is not proof of execution or of correspondence to the public projection; checking it requires possession of the original archive. Per-document digests and content addresses are excluded.

## Excluded

The export omits raw request and response payloads, assessment questions and answers, free-text errors, source text, private endpoints and URLs, user names, actor identities, DIDs, CIDs, session IDs, graph/resource addresses, descriptor proofs, signatures, authorization material, and original per-document hashes. Original filenames and raw batch identifiers are not needed to audit the public arithmetic and are not published as a provenance index.

The exporter uses a field allowlist to construct the derivative rather than copying source objects and masking selected strings. Call order and generic labels remain useful for accounting without publishing the resource addresses or payloads associated with those calls. The retained byte counts reveal output sizes, not output content.

## What the public audit establishes

The audit recomputes the published counts and checks the two procedure projections for structural equivalence. It does not contact live services, replay application actions, resolve keys, validate removed signatures, regrade removed answers, or prove live freshness. It cannot independently establish the completeness or authenticity of its private source material. It also cannot validate semantic equivalence of removed prose merely from matching step and dependency structure.

The original private audit examined richer saved evidence. Publishing selected results of that audit is not equivalent to publishing independently verifiable cryptographic evidence. An archived source response itself records an observation at capture time; it does not establish that a live session remains available later.

## Reproduction and later publication

A holder of the original capture can run its private audit and then use `export-public.mjs` to regenerate the public derivative. Public readers can run `audit.mjs` against the supplied derivative. The exporter does not grant permission to publish its inputs or any additional fields.

Any later expansion of this evidence release needs a new review of the actual proposed content. Do not add the original archive, an original-file index, raw trace excerpts, or removed identifiers to this directory to make the public audit appear more complete.
