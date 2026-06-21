# @interego/core

Interego substrate kernel. Holds the irreducible categorical substrate
of the system:

- **`model/`** — Typed Context Descriptor + 7 facets + composition
  algebra (HELA's typed-hyperedge category + the 4 limit/colimit
  operators: union, intersection, restriction, override).
- **`kernel/`** — The 8 categorical verbs (`mint`, `dereference`,
  `compose`, `act`, `restrict`, `extend`, `promote`, `decompose`).
- **`affordance/`** — The `iep:Affordance` shape (Peircean Thirdness
  made operational). The runtime that *computes* per-agent affordance
  sets (OODA + BDI + Active Inference) currently lives here too; it
  is slated for extraction into `@interego/affordance-engine` once the
  remaining cross-cuts with `pgsl` are decoupled.
- **`rdf/`** — Turtle / TriG / JSON-LD serialization, RDF 1.2 helpers,
  TriG parser, system ontology + virtualized RDF layer.
- **`validation/`** — Shape conformance / SHACL primitives.
- **`sparql/`** — Standards-compliant SPARQL pattern builders.
- **`crypto/`** — Abstract signing + verification + ZK primitives;
  ethers/nacl-backed wallet impls live here for now and will move
  to `@interego/crypto-impls` when the abstract surface is finalized.
- **`naming/`** — Naming conventions (L2 attestation-based naming).
- **`solid/`** + **`pgsl/`** — Both currently ship from core because
  the kernel composes against them and `rdf/system-ontology` +
  `rdf/virtualized-layer` reverse-import PGSL. Splitting them into
  `@interego/solid` and `@interego/pgsl` requires lifting those
  back-references into injection points — a follow-up restructure
  documented in `docs/ARCHITECTURAL-FOUNDATIONS.md §12`.

Per-vertical *compositions* of these primitives live in sibling
`@interego/*` packages.
