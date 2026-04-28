# Learner / Performer Companion — human-protagonist vertical

> **Vertical application of Interego — NOT part of the protocol, NOT a reference implementation of the protocol.** One specific use case among many possible. The Interego protocol does not depend on any of this; multiple alternative verticals could exist over the same substrate. Vocabulary in this document (`lpc:` namespace) is vertical-scoped, non-normative, and lives in [`ontology/lpc.ttl`](ontology/lpc.ttl).
>
> Status: Working Draft. Layer: application-over-L3. No L1/L2/L3 ontologies are extended.

## What this is

A vertical for **humans** — learners and workers — to keep a **portable, queryable wallet** of their training history, credentials, and performance records, and to **chat with their learning and performance systems** through an Interego-grounded AI assistant.

The human is the protagonist. The Interego agent is the assistant. This is meaningfully different from [`../agent-development-practice/`](../agent-development-practice/), where the AI agent is the *subject* being managed.

The vertical composes existing open standards instead of inventing new ones:

- **W3C Verifiable Credentials** + **Open Badges 3.0** — for credentials and badges (issued by employers, training vendors, certification bodies)
- **IMS Comprehensive Learner Record (CLR) 2.0** — for the assertions the user accumulates over a career
- **IEEE LERS family** (Learner Empowerment and Recognition Systems, IEEE P3527 working group) — for portable, learner-controlled recognition records and skill verification
- **xAPI 2.0** + **ADL Total Learning Architecture (TLA)** — for the user's learning experience stream (statements about what they completed, scored, watched, demonstrated). Brought in via [`../lrs-adapter/`](../lrs-adapter/) at the boundary.
- **SCORM** + **xAPI cmi5** + **PDF / video transcripts** — for the actual training content the user engaged with, extracted into a knowledge graph the assistant can ground its responses in

Everything lives in **the user's own pod**, not in the LMS / HRIS / LRS. The user takes their wallet across employers; the assistant works against their data; the existing systems can keep doing what they do.

## Why Interego makes this tractable

Each of the standards above solves part of the puzzle but they don't compose with each other. A typical learner today has:

- An LMS account at their current employer (course completions live there)
- An LRS recording xAPI Statements about courses they took at this employer
- Open Badges issued by various vendors, scattered across different badge backpacks
- Performance reviews in an HRIS the user can read but cannot easily query
- Training PDFs / videos / cmi5 packages they engaged with — searchable only inside the LMS

When they leave the employer, most of this evaporates from their reach. The credentials they earned are theirs; the rest is gone. Even when they're still employed, an AI assistant cannot natively answer "what did the customer-service training say about second-contact escalation?" or "do I have a credential covering this skill?" or "what was last quarter's performance feedback about?" because those facts are scattered across systems that don't share a substrate.

Interego provides the substrate. Composing on top:

| Concern | Standards-side | Interego primitives used |
|---|---|---|
| Credential wallet | W3C VC + Open Badges 3.0 + IMS CLR + IEEE LERS | `cg:ContextDescriptor` + [`passport:`](../../docs/ns/passport.ttl) + `cg:TrustFacet` (issuer = institution) + [`src/compliance/`](../../src/compliance/) for VC verification |
| Learning history | xAPI 2.0 Statements (TLA-flavored) | `cg:ProvenanceFacet` + [`pgsl:Fragment`](../../docs/ns/pgsl.ttl) for atom storage; [`../lrs-adapter/`](../lrs-adapter/) for translation at the boundary |
| Authoritative training content | SCORM packages, cmi5 courses, PDFs, video transcripts, TLA Learning Activity Provider catalogs | [`src/connectors/`](../../src/connectors/) + [`src/extractors/`](../../src/extractors/) + `cg:Affordance` (assistant calls "look up authoritative training content"); `cg:supersedes` for course revision evolution |
| Performance records | Manager / 360 / self-assessment exports (CSV, JSON) | `cg:ContextDescriptor` + `cg:ProvenanceFacet` (issuer = manager / org) + `cg:TrustFacet` |
| Goal / development plans | IDP exports, OKRs, IEP-style learner-set goals | `cg:ContextDescriptor` + `olke:` knowledge maturity progression |

Every term used in this vertical is either an existing protocol primitive or a vertical-scoped `lpc:` term that subclasses one. Nothing in this vertical proposes changes to L1/L2/L3.

## The assistant chat surface

The user opens a chat with an Interego-grounded assistant. The assistant has read access (with the user's consent) to:

- The credential wallet in the user's pod
- The xAPI learning history in the user's pod (translated in by [`../lrs-adapter/`](../lrs-adapter/))
- The training content knowledge graph in the user's pod
- The performance records in the user's pod
- (Optionally, with separate consent) the employer's authoritative training-content catalog

Sample interactions:

| User asks | Assistant grounds in |
|---|---|
| "What did the customer-service training say about second-contact escalation?" | training-content KG → cites Module 3 of CS-101 with paragraph anchor |
| "Do I have a credential covering this skill?" | credential wallet → finds Open Badge 3.0 issued 2025-Q3 by ACME |
| "What did my last review say about my tone?" | performance records → cites Q1-2026 review verbatim |
| "Have I completed any training related to what my manager flagged?" | crosses xAPI history × performance records × training-content KG |
| "Generate a development plan for the gaps my last review identified." | composes performance records + training-content KG + olke: stages, returns a draft plan as `cg:modalStatus Hypothetical` |

The assistant **cites** rather than **summarizes-without-citation**. Every response is grounded in a descriptor the user can click through to. When the user asks a question that the data cannot answer, the assistant says so explicitly rather than confabulating.

## What's NOT happening here

This is a **chat-with-your-records** experience. It is NOT:

- **Not a learner-progress-grading system.** The assistant does not issue xAPI Statements grading the user. That direction (Interego → xAPI) lives in [`../lrs-adapter/`](../lrs-adapter/) and is the employer / LRS's call to invoke, not the user-side assistant's.
- **Not a replacement for the LMS / LRS / HRIS.** Those keep running. This vertical reads from them (via connectors) into the user's pod.
- **Not employer-controlled.** The user owns their pod and their wallet. The employer can issue credentials *to* the user; cannot revoke what's in the user's pod (only the credential's issuer-side validity, which is a separate signal).
- **Not autonomous-agent management.** That's [`../agent-development-practice/`](../agent-development-practice/). Different framing — there, the agent is the subject. Here, the human is.

## Workflow patterns

### 1. Build the wallet — credentials in, with verification

The user (or an authorized agent acting on their behalf) imports verifiable credentials into their pod. Each becomes a `lpc:Credential` descriptor:

```turtle
<urn:cg:credential:open-badge-3:cs101-completion> a lpc:Credential , passport:Achievement ;
    lpc:credentialFormat lpc:OpenBadge3 ;
    lpc:credentialFramework "OB-3.0" ;
    cg:provenance [ a cg:ProvenanceFacet ;
                    prov:wasAttributedTo <https://acme.example/issuers/training> ] ;
    cg:trust [ a cg:TrustFacet ;
               cg:issuer <https://acme.example/issuers/training> ;
               cg:trustLevel cg:ThirdPartyAttested ] ;
    cg:semiotic [ a cg:SemioticFacet ;
                  cg:content "Completed Customer Service 101: Module 3" ;
                  cg:modalStatus cg:Asserted ] ;
    lpc:vcProof """{...verifiable presentation proof block...}""" ;
    lpc:verificationStatus lpc:Verified .
```

Verification is performed by [`src/compliance/`](../../src/compliance/) on import; results stored as `lpc:verificationStatus`. The assistant can re-verify on each query.

### 2. Bring in the learning history

The user (with consent) connects the [`../lrs-adapter/`](../lrs-adapter/) to their employer's LRS. xAPI Statements are translated into descriptors and written to the user's pod. The lrs-adapter handles the translation; this vertical handles the placement and search:

```turtle
<urn:cg:lpc:learning-experience:cs101-mod3> a lpc:LearningExperience ;
    lpc:basedOnStatement <urn:cg:lrs-statement:abc-123> ;
    lpc:relatesToContent <urn:cg:lpc:training-content:cs101:module-3> ;
    lpc:relatesToCredential <urn:cg:credential:open-badge-3:cs101-completion> ;
    cg:temporal  [ a cg:TemporalFacet ; cg:validFrom "2026-04-15T14:32:00Z"^^xsd:dateTime ] ;
    cg:semiotic  [ a cg:SemioticFacet ; cg:content "Completed module 3 with score 0.86" ] .
```

Notice the cross-links. The learning experience points to the credential it earned AND the training content it engaged with — composition is what makes the chat surface useful.

### 3. Ingest the training content as a knowledge graph

The user (or, with consent, the employer's training team) ingests the SCORM / cmi5 / PDF / video transcript content into the pod as a knowledge graph. Each module becomes a `lpc:TrainingContent` descriptor; lessons become `lpc:LearningObjective` sub-descriptors; passages become `pgsl:Fragment` atoms with content-addressed IRIs:

```turtle
<urn:cg:lpc:training-content:cs101:module-3> a lpc:TrainingContent ;
    lpc:contentFormat   lpc:ScormPackage ;
    lpc:contentStandard "TLA-LAP" ;
    lpc:authoritativeSource <https://acme.example/issuers/training> ;
    cg:provenance [ a cg:ProvenanceFacet ; prov:wasAttributedTo <https://acme.example/issuers/training> ] ;
    cg:trust      [ a cg:TrustFacet ; cg:issuer <https://acme.example/issuers/training> ; cg:trustLevel cg:Authoritative ] ;
    cg:supersedes <urn:cg:lpc:training-content:cs101:module-3:v0> ;
    lpc:learningObjective <urn:cg:lpc:objective:cs101:mod3:second-contact-escalation> .

<urn:cg:lpc:objective:cs101:mod3:second-contact-escalation> a lpc:LearningObjective ;
    cg:semiotic [ a cg:SemioticFacet ;
                  cg:content """When a customer makes second contact about an unresolved issue,
                                acknowledge their frustration AND the prior contact before
                                offering the same or similar solution.""" ] ;
    lpc:groundingFragment <urn:pgsl:atom:cs101-mod3-passage-7> .
```

The `lpc:groundingFragment` is the content-addressed atom (PGSL) the assistant can cite. Citation = quoting that atom with its IRI; the user can click through to see the passage in context.

### 4. Performance records — into the user's pod, with provenance

Performance records (review feedback, ratings, manager comments) get written to the user's pod with `cg:ProvenanceFacet` capturing who issued them. This is delicate ground (employers may resist users having portable records); the vertical assumes legal / contractual sign-off and provides the substrate, not the policy:

```turtle
<urn:cg:lpc:performance-record:q1-2026:review> a lpc:PerformanceRecord ;
    lpc:reviewType lpc:ManagerReview ;
    cg:temporal   [ a cg:TemporalFacet ; cg:validFrom "2026-04-20T16:00:00Z"^^xsd:dateTime ] ;
    cg:provenance [ a cg:ProvenanceFacet ; prov:wasAttributedTo <urn:agent:manager-jane> ] ;
    cg:trust      [ a cg:TrustFacet ; cg:issuer <https://hr.acme.example> ; cg:trustLevel cg:ThirdPartyAttested ] ;
    cg:semiotic   [ a cg:SemioticFacet ;
                    cg:content """Strong performance in customer-service-tone capability;
                                  cited 3 specific second-contact resolutions where Mark
                                  led with explicit acknowledgment.""" ;
                    cg:modalStatus cg:Asserted ] ;
    lpc:flagsCapability <urn:cg:lpc:capability:customer-service-tone> .
```

### 5. The chat — grounded RAG with citation

When the user asks "What did the customer-service training say about second-contact escalation?", the assistant:

1. Retrieves matching `lpc:TrainingContent` and `lpc:LearningObjective` descriptors via SPARQL over the user's pod
2. Walks `lpc:groundingFragment` links to the PGSL atoms
3. Returns the answer **quoting the atom verbatim** with its IRI as a citation
4. Adds context: "You completed this module on 2026-04-15 (xAPI ref) and earned Open Badge 3.0 issued by ACME on 2025-Q3"

When the user asks "What did my last review say about my tone?", the assistant:

1. Finds `lpc:PerformanceRecord` with most recent `cg:validFrom`
2. Quotes the `cg:semiotic.content` verbatim
3. Surfaces the cross-link to the capability flagged + any related training the user has completed

When the user asks "Generate a development plan for the gaps my last review identified", the assistant:

1. Composes performance records + training-content KG + credential wallet
2. Returns a draft plan with `cg:modalStatus Hypothetical` because the assistant is *suggesting*, not asserting
3. The plan cites which training is being recommended and which credentials it would lead to

### 6. Cross-employer portability

When the user changes employers, the wallet + learning history + (with appropriate legal handling) performance records travel with them. The new employer's content gets ingested into the same pod alongside the old. The assistant can answer "have I taken training on this topic at any prior employer?" because the substrate composes across deployments.

## Vertical-scoped vocabulary

All terms in [`ontology/lpc.ttl`](ontology/lpc.ttl). Summary:

| Class | Subclass of | Purpose |
|---|---|---|
| `lpc:LearnerWallet` | `cg:ContextDescriptor` | Top-level container linking the user's credentials, learning history, training content, performance records |
| `lpc:Credential` | `passport:Achievement` | A verifiable credential / Open Badge 3.0 / IMS CLR assertion; carries proof + verification status |
| `lpc:LearningExperience` | `cg:ContextDescriptor` | A user-side record of an xAPI Statement; cross-links to content + credential |
| `lpc:TrainingContent` | `cg:ContextDescriptor` | An ingested course / module; ground-truth source for citations |
| `lpc:LearningObjective` | `cg:ContextDescriptor` | A specific objective inside training content; carries the grounding fragment |
| `lpc:PerformanceRecord` | `cg:ContextDescriptor` | A review / rating / feedback record; provenance attributes it to the issuer |
| `lpc:DevelopmentPlan` | `cg:ContextDescriptor` | A user-side plan composing performance records + training KG; always Hypothetical |
| `lpc:CitedResponse` | `cg:ContextDescriptor` | An assistant chat response with explicit citations to grounding fragments |
| `lpc:CredentialFormat` | enum | OpenBadge3 / VC / IMSCLR / LERS |
| `lpc:ContentFormat` | enum | ScormPackage / cmi5 / PDF / VideoTranscript / HTML |
| `lpc:ReviewType` | enum | ManagerReview / SelfAssessment / 360Review / SkipLevelReview |
| `lpc:VerificationStatus` | enum | Verified / Unverified / Revoked / Expired |

Properties: `lpc:credentialFormat`, `lpc:credentialFramework`, `lpc:vcProof`, `lpc:verificationStatus`, `lpc:basedOnStatement`, `lpc:relatesToContent`, `lpc:relatesToCredential`, `lpc:contentFormat`, `lpc:contentStandard`, `lpc:authoritativeSource`, `lpc:learningObjective`, `lpc:groundingFragment`, `lpc:reviewType`, `lpc:flagsCapability`, `lpc:citesFragment`, `lpc:citesDescriptor`.

## Runnable proof-of-concept

[`examples/companion-chat.mjs`](examples/companion-chat.mjs) walks a complete interaction sequence end-to-end:

1. Build the wallet — import an Open Badge 3.0 credential, verify it
2. Bring in xAPI history — via [`../lrs-adapter/`](../lrs-adapter/) translated into `lpc:LearningExperience` descriptors
3. Ingest training content — a SCORM-style course into a `lpc:TrainingContent` KG
4. Receive a performance record — written to the pod with provenance
5. Three chat queries — content question / credential question / development-plan question, each with explicit citations

```bash
node applications/learner-performer-companion/examples/companion-chat.mjs
```

## Tested against

Integration tests in [`tests/integration.test.ts`](tests/integration.test.ts) verify against REAL code paths (run via `npx vitest run applications/learner-performer-companion`):

| What's verified (real code paths) | What's still deferred |
|---|---|
| Real `ContextDescriptor` builder + Turtle + `validate()` for every lpc: class | No actual VC proof verification against a real Open Badges 3.0 issuer (Tier 5) |
| Credential's `cg:TrustFacet` carries issuer + ThirdPartyAttested level | No actual xAPI Statement pulled from a real LRS (Tier 3) |
| Performance record's `cg:ProvenanceFacet` attributes to manager (NOT user) | No real SCORM / cmi5 ingestion via `src/connectors/` (Tier 6) |
| Development plan is `cg:Hypothetical` with `cg:Agent.onBehalfOf` set to user | |
| Cited responses asserted by assistant on behalf of user | |
| `mintAtom` produces deterministic content-addressed IRIs | |
| **Tier 2** — [`_shared/tests/tier2-azure-css.test.ts`](../_shared/tests/tier2-azure-css.test.ts) PUTs a real Open Badge 3.0 credential descriptor to the deployed Azure CSS and confirms `ThirdPartyAttested` Trust facet + issuer DID survive the HTTP roundtrip | |

**Scope finding from testing**: VC proof blocks (the JSON Object holding the cryptographic signature) live as vertical-scoped `lpc:vcProof` literals in the described graph, NOT inside `cg:TrustFacet`. The L1 trust facet is structural metadata only; actual signature verification belongs to a Tier 5 test that invokes `src/compliance/` against a real signature.

## What this is NOT

- **Not the protocol.** No L1/L2/L3 ontologies are extended.
- **Not a reference implementation of the protocol.** [`src/`](../../src/), [`mcp-server/`](../../mcp-server/), and [`examples/personal-bridge/`](../../examples/personal-bridge/) are the reference. This vertical *uses* those.
- **Not the only vertical.** Many alternatives could exist (agent-development-practice, healthcare-rcm, regulated-industry compliance automation, etc.).
- **Not a finished L&D platform.** A real product would add UI, dashboards, integration with HRIS, role-based access at the pod, identity-binding to corporate SSO, and many more affordances.
- **Not a learner-grading system.** The assistant grounds its responses in the user's data; it does not issue Statements about the user.
- **Not employer-controlled.** The pod is the user's; the wallet is portable. Employers can issue *to* the wallet; cannot dictate what's in it.
- **Not a claim that all of this should be in one product.** The substrate composes; commercial products can compose subsets.

## See also

- [`../lrs-adapter/`](../lrs-adapter/) — the boundary translator this vertical consumes
- [`../agent-development-practice/`](../agent-development-practice/) — the agent-as-subject vertical (contrast: human-as-protagonist here)
- [`spec/LAYERS.md`](../../spec/LAYERS.md) — layering discipline
- [`docs/ns/passport.ttl`](../../docs/ns/passport.ttl) — capability passport (substrate for `lpc:Credential`)
- [`docs/ns/olke.ttl`](../../docs/ns/olke.ttl) — knowledge evolution stages
- ADL TLA — https://adlnet.gov/projects/tla/
- IEEE P3527 LERS Working Group — https://sagroups.ieee.org/3527/
- W3C Verifiable Credentials — https://www.w3.org/TR/vc-data-model-2.0/
- Open Badges 3.0 — https://www.imsglobal.org/spec/ob/v3p0
- IMS CLR 2.0 — https://www.imsglobal.org/spec/clr/v2p0
