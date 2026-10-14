# Applicability Note: Decorating an External System

**Layer:** L2 — Architecture (informative pattern).
**Status:** Informative. Nothing here is required for protocol conformance. An implementation MAY
adopt the pattern; to follow it, the MUSTs below apply.
**Adds no terms.** The pattern composes L1 primitives (`iep:modalStatus`, `iep:supersedes`, the
Provenance and Trust facets, `iep:Affordance`) and the L2 catalog shape (`hyprcat:`). A decoration
names its own terms in its own namespace.

## Problem

Agents need to act on systems their principals do not control: a glossary a standards body
publishes, a learning platform another organization runs, a record store, a reference
architecture. Those systems will not change for the agent. They do not carry typed context,
provenance, modal status or hypermedia controls, and they do not say which of their statements are
settled and which are someone's proposal.

The tempting fixes each fail in a recognizable way.

- **Copy it in and enrich the copy.** The copy goes stale on the system's next release, and readers
  can no longer tell the system's own statements from the copier's additions.
- **Ask the system to adopt the additions.** Sometimes right, always slow, and it makes every
  improvement wait on a party with other priorities.
- **Annotate loosely.** Comments and tags beside the system's identifiers carry no provenance and no
  status, so a guess and a fact look the same.

## Pattern

A **decoration** is a set of signed context graphs, published by the decorator under its own
identity, about the external system's identifiers. It leaves the external record as the system
publishes it, and puts everything it adds beside that record, labelled by origin.

### 1. Refer by the system's identifiers, pinned to a release

To follow this pattern, a decoration MUST name the external system's things by the system's own
identifiers, and MUST record which release of the external record it was computed from, by
version and by a content hash where the system offers no version. Each graph's Provenance facet
names that release (`prov:wasDerivedFrom`).

A decoration SHOULD NOT restate the external record as its own. Where it must carry external text
(for a reader that cannot dereference the system), it carries it verbatim, attributed, and only
where the record's rights allow (§5).

### 2. Keep origins apart

Every statement a decoration shows beside the external record has exactly one origin:

| Origin | What it covers | Modal status |
|---|---|---|
| **The system** | What the external record says. Never edited. | (the system's own) |
| **Derived** | Computed deterministically from the external record, with no claim about meaning: counts, provenance classes, change history, health checks. Recomputed per release. | Asserted |
| **Added** | Links the decorator asserts about the system's things: a specification document, a live exemplar. | Asserted, by the decorator |
| **Proposed** | Claims about meaning: crosswalks, classifications, alignments to other ontologies, which capability enacts a concept. | Hypothetical until ratified |
| **The decorator's own** | Capabilities and services the decorator offers over the system. | Asserted, by the decorator |

To follow this pattern, a decoration MUST publish proposed statements as Hypothetical, and MUST
hold each origin in graphs of its own, so that a reader can trust, ignore or ratify one origin
without the others. The origin labels themselves SHOULD be data the decoration publishes, so every
surface that renders the decoration renders the same labels.

### 3. Controls, not instructions

A decoration's agent entry point is a catalog (a `hyprcat:` catalog fits) whose entries carry
affordances: how to resolve a thing from the external system in each representation it serves, how
to query it, and how to act on the decoration itself (propose, vote, ratify). Where the external
system is the authority for an action, the affordance's target is the external system. Where an
affordance is computed per thing (a control for each of four hundred concepts), the decoration
publishes the recipe and MAY materialize the results; a check that the two agree keeps them honest.

This is distinct from the affordance-decorator chain of the architecture (`spec/architecture.md`
§3.13), which enriches the substrate's own HATEOAS responses. A deployment MAY use that chain to
serve a decoration's per-thing controls.

### 4. Track the system, do not fork it

When the system publishes a new release, the decorator re-derives the derived graphs, re-checks
the contract it relies on, and re-examines its proposals:

- A **contract check** (shapes over the external record) states what the decoration assumes about
  the record's structure, and fails loudly when an upstream release breaks it.
- A proposal the system has since asserted itself is **adopted**: it leaves the review queue and
  keeps its identifier, which votes and citations reference.
- A proposal that the system now contradicts stays open, and carries the system's statement beside
  it, so reviewers see both.
- Every change is a new version linked by `iep:supersedes`; nothing is edited in place.

### 5. Carry the system's rights

Rights travel with the record. A decoration MUST carry the external record's rights statements at
the level the system states them (per source, per record), and SHOULD derive from them what may be
quoted where: a consumer serving a commercial purpose does not quote what rests on a
non-commercial source, and links to the system instead. The decoration's own material states its
own licence.

### 6. Say who decorated it, and that the system did not

A decoration MUST be signed by its decorator, and SHOULD state plainly, in its catalog and on every
surface that renders it, that it is independent work and not affiliated with or endorsed by the
system's publisher, unless that is untrue.

### 7. Ratify by the protocol, never by editing

A proposal becomes settled through the protocol's own algebra: reviewers' decisions are descriptors;
a ratified proposal is re-published Asserted, superseding the Hypothetical one; a rejected one is
Counterfactual. The external record is never the place a decision is written. When the system wants
a ratified proposal, the decoration is the evidence it can cite.

## Trade-offs

- **Pinning vs. freshness.** A pinned decoration is reproducible and checkable, and lags the system
  by one re-derivation. The contract check is what makes the lag safe: it fails rather than silently
  mis-decorating a changed record.
- **Referencing vs. carrying.** Dereferencing the system keeps one source of truth but depends on
  the system's availability. Carrying verbatim text works offline and multiplies the rights
  obligations of §5.
- **Many decorators.** Nothing stops two decorators from decorating one system differently. That is
  federation working: their graphs are distinct, signed and labelled, and a consumer chooses by
  trust, as with any descriptors.
- **Proposals the system never takes.** A decoration can be useful indefinitely as a proposal set.
  It should not drift into presenting its proposals as the system's settled view; the modal status
  is what prevents that.

## Transplant test

The pattern names no technology, deployment or domain: it applies equally to a terminology service,
a learning platform, a record store, a product catalog or a regulatory text. It is L2.

## Instances

Reference instances are Layer 3 and live with their verticals. I2IDL-X
(`applications/foxxi-content-intelligence/i2idlx/`) decorates the I2IDL Digital Learning Glossary:
ten signed graphs pinned to an I2IDL release, the origin labels published as data, a HyprCat catalog
of per-concept controls, upstream-contract shapes, proposals that I2IDL later asserted marked
adopted, and each definition's reuse class derived from its sources' rights.
