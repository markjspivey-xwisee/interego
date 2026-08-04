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
  TriG parser, system ontology. (The virtualized RDF layer is NOT
  here — it moved out with `@interego/pgsl`.)
- **`validation/`** — Shape conformance / SHACL primitives.
- **`sparql/`** — Standards-compliant SPARQL pattern builders.
- **`crypto/`** — Abstract signing + verification + ZK primitives;
  ethers/nacl-backed wallet impls live here for now and will move
  to `@interego/crypto-impls` when the abstract surface is finalized.
- **`lattice/`** — The pluggable lattice-adapter seam. `@interego/pgsl`
  registers itself here at module load; core ships a pure-hash
  fallback and mints without it.
- **`http/`** — Substrate fetch + retry transport.
- **`manifest/`** — Manifest types + assembly.
- **`mcp/`** — MCP HTTP mount + output-schema helpers.

`solid/`, `pgsl/` and `naming/` are NOT in core. They were extracted
into `@interego/solid` and `@interego/pgsl` (`naming.ts` went with
Solid), and this list said the opposite for every commit afterwards —
that they "currently ship from core" and that splitting them "requires
lifting back-references into injection points", work the extraction had
already done. The back-references it named are gone:
`rdf/virtualized-layer` now lives inside `@interego/pgsl`, and
`rdf/system-ontology` imports only `./namespaces.js`. Core reaches both
packages through injection points and never by static import —
`kernel/index.ts` resolves `@interego/solid` via a dynamic import, and
`lattice/adapter.ts` is the PGSL registration seam.

Per-vertical *compositions* of these primitives live in sibling
`@interego/*` packages.
