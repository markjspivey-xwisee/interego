# Released versions of the Foxxi `/ns` artifacts

Every released version of a Foxxi ontology, SHACL shapes graph, SSSOM mapping set and JSON-LD
context, kept as it was released. The bridge answers each version IRI from here
(`src/ns/releases.ts`), so `https://foxxi-bridge.interego.xwisee.com/ns/xapi/2026.10.0` keeps
resolving, unchanged, after `/ns/xapi` takes a new version.

| Version IRI under `https://foxxi-bridge.interego.xwisee.com/ns/` | File here |
|---|---|
| `<module>/<version>` — an ontology | `<module>/<version>.ttl` |
| `<module>/shapes/<version>` — its SHACL shapes | `<module>/shapes/<version>.ttl` |
| `<module>/mappings/<version>` — its SSSOM mapping set | `<module>/mappings/<version>.sssom.tsv` |
| `<module>/context/<version>` — the JSON-LD context data is read through | `<module>/context/<version>.jsonld` |

A mapping set, a context and a document's Turtle are served byte for byte. A document's RDF/XML,
N-Triples, JSON-LD and HTML documentation are generated from the graph its Turtle is: a version IRI
names that graph. Every answer at a version IRI links the current version and the versions either
side of it (`latest-version`, `predecessor-version`, `successor-version`; RFC 5829).

## The rules

- **A released file never changes.** `SHA256SUMS` records each file's SHA-256 (`sha256sum -c
  SHA256SUMS` checks them), and `tests/every-released-version-stays-resolvable.test.ts` fails when a
  file differs from it or is missing.
- **A changed artifact takes a new version.** Versions are `YYYY.MM.PATCH`, each above every version
  released before it. The test fails while an artifact differs from its archived current version.
- **Each version names the one before it, and says whether it keeps its meaning.** A document's
  header says `owl:priorVersion` once it has had a release, and `owl:backwardCompatibleWith` or
  `owl:incompatibleWith` that version; the release tool refuses a new version that does not.
- **A version is released once.** The commit that brings a version to `master` is tagged
  `foxxi-ns-<version>` (`.github/workflows/foxxi-ns-release-tags.yml`), and the version's documents
  cite the source files they were generated from at that tag (`prov:wasDerivedFrom`), which never
  moves. The release tool refuses to archive anything more under a version whose tag exists.
- **Imports are by version IRI.** A Foxxi document imports another at a version, so the import
  closure of a released version never changes either.
- **A term's IRI keeps its meaning.** A term whose kind changes (a datatype property that becomes an
  object property), or that comes to relate different things, takes a new IRI; the old one stays, as
  it was published, with `owl:deprecated`, `dct:isReplacedBy` and a `skos:changeNote`, so data
  written with it still reads as it did. A wrong domain or range is removed rather than replaced. A
  change that only narrows what a term admits to what its standard allows stays on its IRI, and one
  that replaces a term's datatype says so in its `skos:changeNote`. 2026.10.0 held what was published
  before versioning to this rule.

## Releasing

```sh
npx tsx applications/foxxi-content-intelligence/tools/release-ns.ts           # archive what is new
npx tsx applications/foxxi-content-intelligence/tools/release-ns.ts --check   # write nothing; fail if out of date
```

The tool archives each artifact's current version that is not archived yet, refuses an artifact that
changed without a new version, and rewrites `SHA256SUMS`.
