# Semantic integration coverage

Layer: **L3 maintenance evidence for the Foxxi/I2IDL-X implementation**. This is not a protocol requirement, a new mapping authority, or a claim of conformance across every connected system.

An ontology is integrated only to the extent demonstrated by its actual consumers. Review the exact namespace and release, the producer's emitted data, the mapping direction, the graphs the consumer loads, and a representative query or workflow across that boundary. Keep source pins, separately authored extensions, proposed mappings and observed learner evidence distinct.

## Reviewed source boundaries

The baseline audit examined Interego `8e15bcfa53534e422e06ce09a7720ad273c3e08e`, xapi-topos `a23139639c60a5e33b08013b29c82d51292c4284`, hd-xapi `b7a1e64f468109305fd0acce453d0c2480826811`, and xapi-ontology-semantic-layer `c654b5c336738cfec672f485c1b454787abcefa2`. A separate connected Learning Fabric read reported its glossary source version; that is a distinct observation from reviewing its implementation.

| Boundary | Demonstrated behavior and limit |
| --- | --- |
| I2IDL source → I2IDL-X | The deliberate source pin is v0.0.93 at `0754254be64f0562bab7e68d69583f2cc90aa945`, with 420 canonical concepts. JSON-LD SHA-256 is `db172a650fc34766b81a1d75ae0f351131fcd6a0623ddc4b7f2bdd3643a40e6a`. It is byte-identical at the earlier review commit and the inspected upstream main. A freshness check does not update the embedded snapshot. |
| Authored concepts → browser and public checks | A separate catalog supplies the owned Competency framework IRI, origin, evidence and Hypothetical status. It does not add a canonical I2IDL concept or fabricate a release. Browser and server use the same projection and exact membership resolver. The source-only lens excludes authored content. |
| Current Foxxi xAPI → I2IDL-X classifier | The active namespace is `https://foxxi-bridge.interego.xwisee.com/ns/xapi#`, with reviewed release `2026.10.1`. Live baseline checks classified its Statement, Verb and Activity. Agent and Group have annotation-only matches and intentionally do not produce class inference. |
| HELA statement producer → classifier | The inspected producer emitted only `https://w3id.org/xapi/ontology#Statement`, which produced no classifier output. The scoped producer correction adds the Foxxi whole-record type alongside the existing ADL type and retains the original statement and property vocabulary. This is not global vocabulary equivalence or complete Foxxi serialization/profile conformance. |
| IEEE LER / ADL TLA framework → authored framework | Directional restrictions classify specialized framework instances by the authored generic concept. The generic concept does not infer either specialized peer type. CTDL-ASN is a proposed class annotation, with no typing bridge. |
| Signed concept usage → private derived record | The signed path validates and writes the original xAPI statement, reads its real LRS-enriched envelope, then retains the original and a separately derived UsageRecord in the same authorized private audience. Usage uses `aboutConcept`, not `isClassifiedBy` or an achievement assertion. Source event time, LRS stored time and projection generation time remain distinct. |
| Derived record → authorized readback | The receipt identifies the derived holon and RDF hash. The existing signed own-lattice operation reads that actual artifact with the caller-derived own label. It does not accept a caller-supplied owner label or create a public domain-queryable RDF graph. Partial retention is reported explicitly. |
| Retired Azure namespace → current classifier | The inspected Foxxi validator has a narrowly defined retired-host migration; the classifier does not automatically apply it. Retired-host class input is an explicit migration boundary. Do not hide this with unrestricted aliases. |
| hd-xapi / legacy semantic layer → current app | These repositories use different namespace/model choices. The inspected hd-xapi model types Statement as a PROV Activity, whereas the app's record concept is informational. The legacy semantic layer uses `http://adlnet.gov/expapi/ontology/`. No general equivalence or active deployment compatibility is established. |
| Learning Fabric → glossary source | Its connected product/enrichment controls reported a separate v0.0.63 source, hash `c450d4914320b03f98994278253f1581e714a593d40bb662e84de514f3110995`. Its wrapper/enrichment versions are not source versions. A new I2IDL-X concept does not automatically update this consumer. Its full source-refresh/deployment path remains outside the verified boundary. |

## Mapping inventory and executable evidence

The reviewed `crosswalk-data.json` has 88 authored proposal rows: 15 superseded and 73 active. Of the active rows, 22 target the current Foxxi xAPI namespace, eight retain ADL xAPI targets, four target xAPI Profile and 39 target other peers. These are proposal rows, not 73 independent ratifications or 73 independently exercised runtime paths.

The generator gives exact, narrow, broad, close and related matches different effects. The fixed classifier loads its own generated ontology, alignments, referents and submitted input; it does not load every peer ontology. An upper-class alignment or a related-match annotation therefore does not establish peer-input classification. See [crosswalk data](../../applications/foxxi-content-intelligence/i2idlx/typescript/crosswalk-data.json), [classifier](../../applications/foxxi-content-intelligence/src/i2idlx-semantic-tasks.ts), and [authored catalog](../../applications/foxxi-content-intelligence/i2idlx/typescript/authored-concepts.ts).

The authored public JSON, RDF and effective shape profile are advertised by the workbench/Foxxi controls at `/i2idlx/authored-catalog`, `/i2idlx/authored.ttl` and `/i2idlx/authored-shapes.ttl`. The published RDF and classifier use the same serialization/hash; JSON has its own representation hash. Existing canonical source graphs remain separately identified.

Representative checks are the actual authored-concept search/Ask/classification/SHACL/Orchestrate tests and [signed usage tests](../../applications/foxxi-content-intelligence/tests/i2idlx-usage-record.test.ts), including the real server callback, unchanged source envelope, exact concept tags, three timestamp meanings, same-owner readback and refusal of foreign-owner access. The HELA repository's `statement-interpretant.test.ts` checks the real RDF producer and original xAPI readback. Deployment and live acceptance evidence belong to the particular reviewed commit; a local fixture pass alone is not a production claim.

## Review practice

For relevant changes, the PR template asks for authoritative identities and source versions, upstream producers and downstream consumers, justified mapping direction, an actual boundary-crossing check, and intentional exclusions or migration gaps. Add a regression where a real connection failed; verify that its workflow actually runs that regression. Do not silently promote proposed mappings, refresh independent source snapshots, broaden private-data access or infer competency from usage to make an integration claim pass.

Unreviewed consumers, third-party LRSs, credential registries, historical records, other producer classes and full standards conformance remain unverified until individually examined. A coverage map should make those limits visible rather than treating them as successes.
