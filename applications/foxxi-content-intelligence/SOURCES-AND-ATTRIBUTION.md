# Sources, Standards & Originality

This document records, honestly and auditably, where the Foxxi vertical
stands with respect to other people's intellectual property — standards,
trademarks, copyrights and patents — so that an enterprise buyer or a
contributor can verify each claim.

The short version:

- **Open standards** are implemented and named, because you cannot
  implement a standard without naming it — this is the intended use, and
  conformance claims here are factual and re-verifiable.
- **Concepts, models, methodologies and vocabulary** are the project's
  own synthesis. The system is informed and inspired by established
  fields of practice, but it does not adopt, reproduce, or depend on any
  one external proprietary framework. Where a borrowed *idea* shaped the
  design, it has been re-thought from first principles and given the
  project's own vocabulary.
- **No proprietary diagrams, figures, or verbatim text** from any
  external framework are reproduced anywhere in this vertical.
- **No certification or endorsement** is claimed that the project does
  not actually hold.

This principle applies repo-wide across Interego and Foxxi; this file is
the vertical-level record for the Foxxi content-intelligence vertical.

---

## 1. Open standards — implemented, named, conformance-tested

Implementing an open standard and stating measured conformance is the
purpose those standards exist for. Their names are trademarks of their
respective standards bodies and are used **nominatively** — only to
identify the standard being implemented. The project claims no formal
certification from any of these bodies; where it says "conformant" or
"tested", that refers to a re-runnable test result, not an official
certification mark.

| Standard | Steward / body | How Foxxi uses it |
|---|---|---|
| xAPI 2.0 (IEEE 9274.1.1) | IEEE / ADL | Implemented as a conformant LRS; tested against the ADL conformance suite. |
| SCORM 1.2 / 2004 | ADL | Run-time environment + a Sequencing & Navigation runtime. |
| cmi5 (IEEE 9274.2.1) | IEEE / ADL | Implemented — the LMS launch contract, moveOn, course structure. |
| LTI 1.3 Advantage | 1EdTech | Implemented as a Tool — JWKS, OIDC, Deep Linking, NRPS, AGS. |
| OneRoster 1.2 | 1EdTech | Producer + an applying CSV consumer. |
| CASE 1.0 | 1EdTech | Competency-framework alignment. |
| Comprehensive Learner Record (CLR) | 1EdTech | Wallet-envelope export. |
| Open Badges 3.0 | 1EdTech | Credential issuance. |
| Caliper | 1EdTech | Referenced for analytics interop. |
| IEEE LOM (1484.12.1) | IEEE | Learning-object metadata extraction. |
| IEEE P2997 (Enterprise Learner Record, draft) | IEEE | The learner-record shape; cited as a draft. |
| ADL Total Learning Architecture | ADL | Composed as a dereferenceable semantic layer. |
| W3C Verifiable Credentials | W3C | Credential format. |
| RDCEO | legacy IMS | Competency-definition interchange. |

Conformance is re-verifiable — see `LMS-CONFORMANCE.md` and the
`tools/*-smoke` runners.

## 2. Concepts, models and methodology — the project's own synthesis

The performance, content and knowledge architecture
(`PERFORMANCE-ARCHITECTURE.md`) is an original synthesis. Its model, its
vocabulary, its composition over the Interego substrate, and its
software are the project's own.

It is **informed and inspired by** established fields of practice —
performance improvement and performance consulting, instructional
design and learning science, knowledge management, complexity-aware
management and sense-making, and causal reasoning. That is the normal
way any serious system is built: standing on a discipline. But:

- The system does **not** adopt any single external framework as its
  model. Concepts that a field would recognise have been re-thought from
  first principles and expressed in the project's own terms — for
  example, the **work-regime** model (Evident / Knowable / Emergent /
  Turbulent) of how knowable an act→outcome relationship is; the
  **cause-factor** diagnosis across environmental and individual
  factors; the **discriminating question** that separates a skill gap
  from a non-skill gap; the **competence decomposition** of a competency
  into recorded / trained / judged / lived / innate knowledge; the
  **four-level evaluation** (response → capability → transfer →
  outcome); and the **cognitive-level** ordering of content.
- No external framework's **name**, **acronym**, **diagram**, or
  **verbatim wording** is used in the code, the product surface, or the
  documentation. The ideas are carried; the proprietary expression is
  not.
- The genuinely novel contributions — performance as the unit rather
  than content; routing the consulting method by the work regime;
  content as an emergent syntagm/paradigm composition; authoring as a
  substrate affordance shared by humans and agents; knowledge mapped by
  codifiability; the modal-status evaluation loop — are the project's
  own and are composed entirely from Interego substrate primitives.

## 3. Trademarks

- The standards names in §1 are trademarks of their respective bodies
  (IEEE, ADL, 1EdTech, W3C). They are used nominatively to identify the
  standards implemented. No affiliation or endorsement is implied.
- "Foxxi" and "Interego" are the project's own names.
- The project displays no third-party certification mark and claims no
  certified status it does not hold.

## 4. Patents

- The open standards in §1 are published by standards bodies whose IPR
  policies are designed so that conforming implementations may be built
  — implementing them as intended is the basis on which they are
  offered.
- This vertical reproduces no proprietary software and embeds no
  third-party patented implementation. Its methodology layer is
  expressed as original software over the Interego substrate.
- The project makes no patent claims of its own over this work.

## 5. Keeping it clean — the contributor rule

When adding to this vertical:

1. To implement a standard, name it (§1) and state conformance
   factually and re-verifiably.
2. For any concept, model or method that originates in an external
   field, **synthesize it as our own** — re-think it from first
   principles, give it our vocabulary, and do not carry over the
   external name, acronym, diagram or wording.
3. Never reproduce a third-party diagram, figure or passage of text.
4. Never claim a certification or endorsement the project does not hold.
5. If in doubt, prefer our own framing and a generic description of the
   field of inspiration over naming a specific proprietary framework.
