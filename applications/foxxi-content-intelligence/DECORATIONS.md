# Decorations: LRS-X, LMS-X, LTI-X, LER-X, TLA-X — analysis, design, development, verification

This document records, as part of the Foxxi vertical, how a decorator kit and five decorations
built with it were added. It is Layer 3, vertical. The pattern they instantiate is the Layer 2 note
`docs/patterns/decorating-an-external-system.md`; I2IDL-X (`i2idlx/`) is its first instance.

---

## 1. Analysis

Organizations meet Foxxi with systems already in place: a learning record store, an LMS, the 1EdTech
and IEEE standards their procurement names, ADL's reference architecture. An agent that should work
across them needs, for each one: what its parts are, how to act on each through its own interface,
what each asks of a caller, and how each relates to a shared vocabulary and to Foxxi's own
capabilities. It also needs to tell which of those statements are the system's, which are Foxxi's
additions, and which are Foxxi's proposals.

I2IDL-X showed the shape for a glossary: signed graphs, origins kept apart, a catalog of controls,
proposals Hypothetical until ratified, and a not-affiliated statement. Its build is a Python
pipeline specific to I2IDL. The other systems are smaller and similar to each other, so a
declarative kit fits them better than five pipelines.

## 2. Design

**One spec per decoration** (`src/decorations/<id>.ts`) holds:
- the decorated system: name, kind (instance, specification or architecture), publisher, and the
  specification it is defined by;
- its parts, each with the system's own identifier where it has one (an xAPI resource path, an LTI
  claim URI), the section that defines it, a description in Foxxi's words, and the term in Foxxi's
  ontologies that models it;
- controls: how to act on each part, as RFC 6570 templates;
- alignments, enactments and gaps, all proposals.

**The kit** (`src/decorations/kit.ts`) checks a spec and produces three documents:

| Document | Origin | Status |
|---|---|---|
| Catalog: a HyprCat catalog of SKOS concepts (the parts), each with affordance-bearing controls (`iep:Affordance`, `hydra:Operation`, `dcat:Distribution`) whose targets are Hydra IRI templates | *X* · added | Asserted, by Foxxi |
| Proposals: SKOS mappings, each annotated with its reason; enactments as the Foxxi action a part is enacted through; gaps | *X* · proposed | Hypothetical |
| SSSOM 1.0 mapping set of the same alignments, a gap as `sssom:NoTermFound` | *X* · proposed | Hypothetical |

No term is minted. Every document carries the decorator, the licence and the not-affiliated
statement. The specification's text is referred to, never reproduced.

**Binding.** An instance decoration's controls are templates over the instance's URLs: LRS-X's
`{endpoint}`; LMS-X's `{configuration}`, `{jwks}`, `{lineitems}`, `{lineitem}`, `{memberships}` and
`{oneroster}`. `foxxi.bind_decoration` fills them and returns the controls whose variables were given.
The bridge fetches nothing it is given; a binding must be `https` (or loopback `http`) and carry no
credentials. `{+bridge}` is filled by the serving bridge, for the controls that act through Foxxi.

**The five:**

| Decoration | Decorates | Parts | Controls act on |
|---|---|---|---|
| LRS-X | any xAPI 2.0 LRS (IEEE 9274.1.1-2023) | its resources, the version header, concurrency | the bound LRS |
| LMS-X | any LMS speaking LTI 1.3 Advantage and OneRoster 1.2 | configuration, keys, line items, scores, results, memberships, roster | the bound LMS, with each service's scope |
| LTI-X | the LTI 1.3 specification | the launch's claims (by their URIs) and services | Foxxi as an LTI Tool and Platform |
| LER-X | the IEEE LER standards (1484.2-2024, 1484.20.2-2022, 1484.20.3-2022, P2997) | records, definitions and roles | Foxxi's record, credential and validation services |
| TLA-X | ADL's Total Learning Architecture | its components | the Foxxi capability that plays each |

LTI-X's alignments are the reading Foxxi uses for a launch from another LMS: the `sub` with the
platform's issuer as an xAPI account, the context as the statement's grouping activity.

**What I2IDL lacks is said.** I2IDL v0.0.86 has no term for an LMS, LTI, an experience index, a
course catalog, the service that launches activities, evidence or a transcript. Each is a gap row,
so a missing mapping reads as a term I2IDL lacks, not one nobody looked for.

## 3. Development

| Piece | Where |
|---|---|
| Kit: spec types, checks, templates, binding, documents, SSSOM | `src/decorations/kit.ts` |
| The five specs and their index | `src/decorations/{lrs-x,lms-x,lti-x,ler-x,tla-x,index}.ts` |
| Routes: `/decorations`, `/decorations/:id` (Turtle, JSON-LD, JSON, HTML), `/decorations/:id/proposals` (Turtle, JSON-LD, SSSOM), `POST /agent/decorations/bind` | `src/decorations/routes.ts`, mounted in `bridge/server.ts` |
| Affordance `foxxi.bind_decoration` | `affordances.ts` |

## 4. Verification

- `tests/decorations.test.ts` checks:
  - each spec holds together;
  - every enactment is a declared Foxxi affordance;
  - every Foxxi ontology term named is declared in that ontology's release;
  - every control that acts through the bridge reaches an address the bridge serves;
  - the documents' shape, origins and not-affiliated statement;
  - SSSOM rows and gaps;
  - binding and RFC 6570 expansion;
  - the routes over HTTP on the shared vertical bridge's express.
- Every I2IDL concept named (25) was checked against the live release v0.0.86 when the specs were
  written. The OneRoster 1.2 paths and scopes were checked against 1EdTech's REST binding, and the
  specification URLs were checked to resolve.
- On a local bridge, every document was served in each media type, and LRS-X was bound to the
  bridge's own LRS. The bound `about` control answered with the LRS's versions and extensions.

## 5. Canonical identity and publication

The kit accepts an optional canonical base independently of the serving bridge's base. With
`https://relay.interego.xwisee.com/ns/u-pk-33d42e6b33dc` it mints catalogs as `<base>/<id>`
and proposals as `<base>/<id>-proposals`. The catalog, proposal graph, SSSOM and JSON view use
those same identities. Controls over `{+bridge}` still use the serving bridge; instance bindings
still belong to the caller. Omitting the canonical base preserves all existing document output.

Set `FOXXI_DECORATION_CANONICAL_BASE` on the Foxxi bridge after the signed publications are
verified. The bridge then serves the same canonical RDF and links every representation to its
canonical identity with an HTTP `Link: <IRI>; rel="canonical"` header. The catalog and proposals
must be published separately: catalog Asserted, proposals Hypothetical, both public and signed.
Publication requires verified write delegation on the target pod. Public publication cannot be undone.
The code adds this prerequisite; it does not claim that publication has happened.

## 6. Remaining work
- Proposals have no review workflow here yet; I2IDL-X's votes and ratification are the model for one.
- I2IDL-X's own build stays in Python. Porting it onto the kit is separate work.
