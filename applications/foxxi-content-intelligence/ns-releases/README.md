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
  `owl:incompatibleWith` that version; the release tool refuses a new version that does not. An
  ontology and its shapes graph can differ here. 2026.10.1's ontologies keep every term 2026.10.0
  defined with the kind, domain, range, characteristics and superclasses it had, and HermiT finds
  the same subsumptions, equivalences and disjointness among 2026.10.0's classes; most of its shapes
  graphs check more, so data that met 2026.10.0's shapes may not meet them.
- **A version is released once: when it reaches `master`.** The commit that brings it there is
  tagged `foxxi-ns-<version>`. `.github/workflows/foxxi-ns-release-tags.yml` tags the first commit on
  `master` whose `SHA256SUMS` lists the version's files with the checksums they have, so it finds that
  commit even when it runs later, as it did for 2026.10.0, which reached `master` before the workflow
  did. From 2026.10.1 on, a version's documents cite the source files they were generated from at
  that tag (`prov:wasDerivedFrom`), which never moves. The release tool refuses to archive anything
  more under a version whose tag exists.
- **Imports are by version IRI.** A Foxxi document imports another at a version, so the import
  closure of a released version never changes either.
- **A released term keeps its meaning.** From one release to the next, a term whose kind would
  change (a datatype property that becomes an object property), or that would come to relate
  different things, takes a new IRI instead; the old one stays as it was released, with
  `owl:deprecated`, `dct:isReplacedBy` and a `skos:changeNote`, so data written with it still reads
  as it did. A wrong domain or range is removed rather than replaced; the version then no longer
  entails what it did, so it is `owl:incompatibleWith` the one before. A change that only narrows
  what a term admits to what its standard allows stays on its IRI, says so in a `skos:changeNote`
  where it replaces a datatype, and makes the version `owl:incompatibleWith` the one before.
- **The rule starts at 2026.10.0, the first release.** The publication before it had no versions,
  and 2026.10.0 changed many of its terms in place. 2026.10.0 is released, so later versions keep
  those terms as it has them rather than change them again. A `skos:changeNote` says what the
  unversioned publication had on the ten properties whose kind 2026.10.0 changed, and on some whose
  domain, range or datatype it replaced, among them cmi5's `objective` and `objectives`, SCORM SN's
  `objectivesGlobalToSystem`, `presentation` and `adlObjectives`, and xAPI's `mbox` and `duration`.
  Its other changes to that publication are not noted term by term: domains widened to what the
  standards allow, such as an xAPI actor of a SubStatement as well as a Statement; datatypes
  narrowed to the standards' value spaces, such as a registration's UUID; some superclasses; and the
  Foxxi vocabulary's types, which became OWL classes.

## Releasing

```sh
npx tsx applications/foxxi-content-intelligence/tools/release-ns.ts           # archive what is new
npx tsx applications/foxxi-content-intelligence/tools/release-ns.ts --check   # write nothing; fail if out of date
```

The tool archives each artifact's current version that is not archived yet, refuses an artifact that
changed without a new version, and rewrites `SHA256SUMS`.
