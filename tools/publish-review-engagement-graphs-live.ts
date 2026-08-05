#!/usr/bin/env tsx
/**
 * The convener's four published documents — the whole of the "integration" in this demo.
 *
 * ★ WHAT THIS PROGRAM IS, AND WHAT IT DELIBERATELY IS NOT.
 *
 * It publishes four graphs to one pod and reads them back. It contains no branch on a
 * vertical, no mapping function, no call into either vertical's code. Every joint that makes
 * a shared-workspace work item countable as L&D evidence is a TRIPLE in one of these four
 * documents — which is the falsifiable part: remove a node from `wsp-skills-alignment` and
 * the requirement stops being satisfied, with no code change anywhere. A join carried by a
 * function would survive that deletion.
 *
 * It does name both namespaces, because the party publishing here is the CONVENER — who is
 * also the requirer. Declaring "my incident-triage requirement is met by the skill term my
 * workspace publishes" is exactly the statement a requirer has to make, and there is nowhere
 * honest to put it except in the requirer's own data. What must NOT name both is either
 * vertical's shipped source and either of the two demo programs; those are grep-gated
 * (`tools/emergence-boundary-lint.mjs`).
 *
 * The five documents:
 *
 *   1. wsp-skills            a SKOS scheme. The ONLY place the skill is named. The performer
 *                            never defines the skill they will be credited with.
 *   2. wsp-work-shapes       a SHACL shape run by the RELAY's publish gate over every work
 *                            item, so an item naming no skill or asserting no outcome is
 *                            refused 422 and never lands — and, since the observation map
 *                            names it, re-run by the AFFORDANCE against the fetched record,
 *                            which is what makes the contract a read-side precondition
 *                            instead of a write-side opt-in.
 *   3. observer-map          the observer's entire configuration, as RDF. Predicate → argument.
 *                            This is what keeps the observer free of both vocabularies.
 *   4. observer-map-agp      the same configuration over a DIFFERENT practice's own
 *                            predicates. It shares one protocol term with (3) and nothing
 *                            else; the reader is unchanged between the two runs.
 *   5. wsp-skills-alignment  two 1EdTech CASE 1.0 associations routing an L&D requirement
 *                            THROUGH the workspace's own term.
 *
 * Usage:
 *   IEP_BEARER_CONVENER=<token> npx tsx tools/publish-review-engagement-graphs-live.ts
 */

/* eslint-disable no-console */

import { parseTrig, type ParsedTerm } from '@interego/core';

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';
const BEARER = process.env.IEP_BEARER_CONVENER;
if (!BEARER) { console.error('IEP_BEARER_CONVENER is required.'); process.exit(2); }

/** The convener's own namespace on the relay — every document below dereferences here. */
const NS = `${RELAY}/ns/u-eth-9bf50894ff23/`;
const CONVENER_DID = 'did:web:identity.interego.xwisee.com:agents:wsp-convener-u-eth-9bf50894ff23';

const SKILLS = `${NS}wsp-skills`;
const WORK_SHAPES = `${NS}wsp-work-shapes`;
const ROLE_PROFILE = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp-roles-default';
const OBSERVER_MAP = `${NS}observer-map`;
/** The SAME reader, over a different practice's own predicates — see `observerMapAgpTtl`. */
const OBSERVER_MAP_AGP = `${NS}observer-map-agp`;
const ALIGNMENT = `${NS}wsp-skills-alignment`;

const WSP = 'https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

/** The agentic-performance practice's OWN namespace and its OWN published SHACL shapes —
 *  cited, never redefined. The second observation map names them so the same reader can be
 *  pointed at that practice's records, and so the affordance re-checks each record against
 *  the shape THAT practice publishes rather than one this engagement wrote for it. */
const AGP = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#';
const AGP_SHAPES = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp/shapes';

/** Where the requirer's own competency terms live. The requirer is an L&D party; this is its
 *  vocabulary, cited as data. `foxxi:CASEAlignment` is the tag the framework registry filters
 *  on, so it has to be the published one and not a synonym. */
const FOXXI_NS = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi#';
const FOXXI_COMPETENCY = 'https://foxxi-bridge.interego.xwisee.com/ns/foxxi/competency/';

// ── The documents ────────────────────────────────────────────────────────────

const wspSkillsTtl = `@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix dct:  <http://purl.org/dc/terms/> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix wspk: <${SKILLS}#> .

# The convener's skill vocabulary. This document is the ONLY place in the whole demo where
# the skill has a name. The performer produces work; they never define the term they are
# later credited with, and no L&D system defines it either.
<${SKILLS}>
    a skos:ConceptScheme ;
    dct:title "Evidence-integrity review — workspace skill terms" ;
    dct:publisher <${CONVENER_DID}> ;
    rdfs:comment "Skill terms for the evidence-integrity review engagement. A work item cites one of these with dct:conformsTo; the workspace's published work shape refuses an item that cites anything else." ;
    skos:hasTopConcept wspk:EvidenceIntegrityReview .

wspk:EvidenceIntegrityReview
    a skos:Concept ;
    skos:inScheme <${SKILLS}> ;
    skos:prefLabel "Evidence Integrity Review" ;
    skos:definition "Reviewing a submitted evidence record end to end: that the artifact it points at resolves, that its authorship proof verifies against its own content, that its supersession chain is linear, and that the claim it carries is the claim its evidence supports." .
`;

const wspWorkShapesTtl = `@prefix sh:   <http://www.w3.org/ns/shacl#> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix dct:  <http://purl.org/dc/terms/> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix wsp:  <${WSP}> .
@prefix iep:  <${IEP}> .
@prefix wspk: <${SKILLS}#> .
@prefix wspr: <${ROLE_PROFILE}#> .
@prefix wwsh: <${WORK_SHAPES}#> .

# ══════════════════════════════════════════════════════════════
#  The work contract for this engagement
# ══════════════════════════════════════════════════════════════
#
#  This runs at the RELAY's publish gate, before any pod write. A work item that names no
#  skill, or that asserts no outcome, is refused with a 422 and never lands — which matters
#  because descriptors are immutable and there is no retraction verb, so validating after
#  the fact would leave the malformed record in existence forever.
#
#  It is deliberately NOT sh:closed, for the same reason the workspace's own shapes are not:
#  an entry is expected to carry a vertical's terms alongside these, and closing the shape
#  would make citing anything a violation.
#
#  Both predicates are PROTOCOL terms, already published: dct:conformsTo is Dublin Core, and
#  iep:success is declared in the Interego Protocol ontology (iep.ttl) as an
#  owl:DatatypeProperty with rdfs:range xsd:boolean. Neither belongs to this engagement, and
#  neither belongs to any vertical. That is what makes them usable as a joint.
<${WORK_SHAPES}>
    dct:title "Evidence-integrity review — work-item shape 1.0" ;
    rdfs:seeAlso <${SKILLS}> .

# ★ TARGETED ON A PREDICATE THE RECORD CANNOT DROP AND STAY READABLE.
#
#  This was sh:targetClass wsp:Entry, and a reviewer emptied it in one move: delete the
#  rdf:type triple and the shape has no focus node, so the relay published a work item that
#  cited a skill outside the scheme while BOTH shapes were declared in conforms_to_shapes.
#  Measured — <.../skeptic-b2> was refused 422 and <.../skeptic-b3>, the same graph without
#  the type, published and still resolves. Worse, the observer selects records by PREDICATE,
#  so the record that dodged the contract was still fully countable as evidence.
#
#  sh:targetSubjectsOf dct:conformsTo closes it, and closes it BY CONSTRUCTION rather than by
#  adding a second check: dct:conformsTo is exactly what the observation map requires in
#  order to read a record at all. A record that drops it to escape this shape becomes
#  invisible to the reader — there is no longer a shape a record can dodge and still be
#  counted. The type is then required as an ordinary constraint, so dropping it is a
#  violation instead of an escape.
wwsh:WorkItemShape
    a sh:NodeShape ;
    sh:targetSubjectsOf dct:conformsTo ;
    rdfs:comment "One reviewed work item. It must say WHICH skill it exercised and WHETHER it succeeded — anything less is not evidence of anything, and a stream of such items is not a record." ;
    sh:property [
        sh:path rdf:type ;
        sh:hasValue wsp:Entry ;
        sh:message "A work item must declare itself a wsp:Entry. This is a CONSTRAINT and not this shape's target, because a target class is something a record can simply not declare — which is how a work item citing a skill outside the published scheme was accepted with both shapes on the request." ;
    ] ;
    sh:property [
        sh:path dct:conformsTo ;
        sh:minCount 1 ; sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
        sh:pattern "^https?://" ;
        sh:in ( wspk:EvidenceIntegrityReview ) ;
        sh:message "A work item must cite exactly one skill term from this workspace's published scheme, by its dereferenceable URL. An item citing a term nobody can look up is a claim about a skill that does not exist; an item citing a term from outside the scheme is a claim this workspace never agreed to." ;
    ] ;
    sh:property [
        sh:path iep:success ;
        sh:minCount 1 ; sh:maxCount 1 ;
        sh:datatype xsd:boolean ;
        sh:message "A work item must assert exactly one boolean outcome. An outcome that is absent is not the same as an outcome that is false, and a reader who cannot tell them apart cannot count either." ;
    ] .

# ── The gap the workspace's own shapes document and do not close ──
#
#  wsp-shapes.ttl says of wsp:role, in its own sh:message: "Whether that role is one the
#  workspace's role profile actually declares is NOT checked here — this shape never opens
#  that document — so an undeclared role publishes and is worth no capabilities at the fold
#  instead." That is true and correctly stated, and it means a grant naming a role nobody
#  declared LANDS, permanently, and only stops mattering later.
#
#  This engagement closes it the way this substrate closes things: the requirer enumerates
#  the roles of the profile it named, in a shape it publishes, and the relay's general gate
#  refuses the rest at 422. Enumerated rather than fetched because SHACL validates the
#  submitted graph and does not follow an IRI to a second document — so the enumeration is a
#  claim this engagement makes about that profile, and it goes stale if the profile changes.
#  Stated here rather than left for a reader to discover.
wwsh:GrantRoleShape
    a sh:NodeShape ;
    sh:targetClass wsp:MembershipGrant ;
    rdfs:comment "A grant in this engagement must name one of the five roles the declared profile publishes." ;
    sh:property [
        sh:path wsp:role ;
        sh:minCount 1 ; sh:maxCount 1 ;
        sh:nodeKind sh:IRI ;
        sh:in ( wspr:Convener wspr:Steward wspr:Contributor wspr:Observer wspr:Delegate ) ;
        sh:message "wsp:role must be one of the five roles published by <${ROLE_PROFILE}>. An invented role is not a narrower role — it is a grant whose meaning nobody can look up, and the fold silently gives it nothing." ;
    ] .
`;

const observerMapTtl = `@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix dct:  <http://purl.org/dc/terms/> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix wsp:  <${WSP}> .
@prefix iep:  <${IEP}> .
@prefix obs:  <${OBSERVER_MAP}#> .

# ══════════════════════════════════════════════════════════════
#  An observation map: which predicate becomes which argument
# ══════════════════════════════════════════════════════════════
#
#  A generic observer is handed a pod, an affordance, and one of these. It reads the records
#  on the pod, pulls the objects of the predicates named here, and submits them under the
#  argument names given here. The predicate names live in THIS document; nothing in the
#  observer's source names dct:conformsTo, iep:success, or any term of any vertical.
#
#  Self-describing on purpose: the terms are defined in the same document that uses them, at
#  the URL they resolve from, so a reader who has only the map IRI can find out what every
#  triple in it means.
obs:ObservationMap a owl:Class ;
    rdfs:label "Observation map" ;
    rdfs:comment "A complete configuration for reading records off a pod and submitting them to an affordance." .

obs:FieldMapping a owl:Class ;
    rdfs:label "Field mapping" ;
    rdfs:comment "One argument of the target affordance, and where its value is read from." .

obs:field a owl:ObjectProperty ;
    rdfs:domain obs:ObservationMap ; rdfs:range obs:FieldMapping ;
    rdfs:label "field" .

obs:fromPredicate a owl:ObjectProperty ;
    rdfs:domain obs:FieldMapping ;
    rdfs:label "from predicate" ;
    rdfs:comment "Read the object of this predicate on the observed record." .

obs:fromRecordAddress a owl:DatatypeProperty ;
    rdfs:domain obs:FieldMapping ; rdfs:range xsd:boolean ;
    rdfs:label "from record address" ;
    rdfs:comment "Instead of a predicate, use the observed record's own dereferenceable address — so what the affordance stores points back at the record it came from, and a reader can check it." .

obs:toArgument a owl:DatatypeProperty ;
    rdfs:domain obs:FieldMapping ; rdfs:range xsd:string ;
    rdfs:label "to argument" .

obs:required a owl:DatatypeProperty ;
    rdfs:domain obs:FieldMapping ; rdfs:range xsd:boolean ;
    rdfs:label "required" ;
    rdfs:comment "When true and the source is absent from a record, SKIP that record. Never substitute a default — an outcome nobody asserted must not become an outcome the observer invented." .

obs:constant a owl:DatatypeProperty ;
    rdfs:domain obs:FieldMapping ;
    rdfs:label "constant" ;
    rdfs:comment "Instead of a predicate, a value fixed by THIS document. What it is for: the reader must tell the affordance which published shape to check the record against, and that shape IRI is a decision of whoever configured the reading — so it belongs in the configuration a stranger can dereference, not in the reader's source." .

obs:requiresType a owl:ObjectProperty ;
    rdfs:domain obs:ObservationMap ;
    rdfs:label "requires type" ;
    rdfs:comment "A record must declare this rdf:type to be one of the records this map is about. Selecting on predicates alone was a hole: a work shape targets a CLASS, so deleting the type triple makes the shape vacuous and the record publishes — and a reader looking only at predicates then counted the record that dodged the contract. Measured live before this was added." .

obs:recordSelection a owl:ObjectProperty ;
    rdfs:domain obs:ObservationMap ;
    rdfs:label "record selection" ;
    rdfs:comment "Which records on the pod to read. MANDATORY: whether iep:supersedes means 'this replaces that' or 'this comes after that in my log' is a fact about the log, not something an observer can see, and each wrong guess produces a plausible count. Reading heads only over an append-only chain loses every record but the last; reading every record over a corrected log counts a retracted value twice." .

obs:everyRecord a obs:RecordSelection ;
    rdfs:label "every record" ;
    rdfs:comment "Each record is a distinct event. iep:supersedes links a log in order; it does not retract." .

obs:currentHeadsOnly a obs:RecordSelection ;
    rdfs:label "current heads only" ;
    rdfs:comment "iep:supersedes retracts. Read only records nothing supersedes." .

<${OBSERVER_MAP}>
    a obs:ObservationMap ;
    dct:title "Work item to production performance" ;
    dct:publisher <${CONVENER_DID}> ;
    rdfs:comment "Reads a record that declares itself a wsp:Entry, cites a skill and asserts an outcome, and submits it as one production performance, naming the work shape the affordance must re-check the record against. The predicates are protocol terms (Dublin Core + iep:success), which is what lets a map name them without either vertical's vocabulary — but no producer outside this engagement currently emits BOTH of them together, so 'works over any pod that carries them' is a property of the mechanism and not yet an observation about the world. The companion map <${OBSERVER_MAP_AGP}> is the same reader over a different practice's own predicates; that pair is the measurement." ;
    obs:recordSelection obs:everyRecord ;
    obs:requiresType wsp:Entry ;
    obs:field [
        a obs:FieldMapping ;
        obs:constant <${WORK_SHAPES}> ;
        obs:toArgument "evidence_shape" ;
        obs:required true ;
    ] ;
    obs:field [
        a obs:FieldMapping ;
        obs:fromPredicate dct:conformsTo ;
        obs:toArgument "activity_type" ;
        obs:required true ;
    ] ;
    obs:field [
        a obs:FieldMapping ;
        obs:fromPredicate iep:success ;
        obs:toArgument "success" ;
        obs:required true ;
    ] ;
    obs:field [
        a obs:FieldMapping ;
        obs:fromPredicate dct:description ;
        obs:toArgument "task_name" ;
        obs:required true ;
    ] ;
    obs:field [
        a obs:FieldMapping ;
        obs:fromRecordAddress true ;
        obs:toArgument "task_id" ;
        obs:required true ;
    ] .
`;

/**
 * The SAME reader, the SAME affordance, a DIFFERENT practice's own predicates.
 *
 * ★ WHAT THE PREVIOUS VERSION OF THIS TEST ACTUALLY MEASURED, AND WHY IT HAD TO GO.
 *
 * The transplant used to publish three graphs typed `a agp:Diagnosis` that a demo tool
 * composed itself, carrying exactly the three predicates the map above marks `required` and
 * NEITHER of the two `agpsh:DiagnosisShape` demands. They were invalid agp:Diagnosis nodes:
 * agp's own published shape rejects them (`conforms: false`, on agp:diagnoses and agp:method),
 * while the record the real `agp.evaluate_intervention` writer emits carries none of the
 * three and would have been skipped. So the "an unanticipated third vertical joins" claim
 * was measuring records authored to match the map — a costume, not a vertical.
 *
 * This map reads what that vertical's OWN writer emits, and shares exactly ONE predicate
 * with the map above (`iep:success`, which is a protocol term belonging to neither). The
 * activity type is the record's `rdf:type` and the name is its `rdfs:label` — both RDF's
 * own terms, both on every artifact agp writes. Nothing in the reader changed to read them:
 * the two maps differ only as documents.
 *
 * The record it reads is produced by calling agp's engine and agp's own serializer
 * (`agpArtifactGraph`, the single place that vertical turns an artifact into Turtle), and is
 * published with agp's own SHACL shapes on the request, so the relay's gate refuses it if it
 * is not something that vertical would recognise.
 */
const observerMapAgpTtl = `@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdf:  <http://www.w3.org/1999/02/22-rdf-syntax-ns#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix dct:  <http://purl.org/dc/terms/> .
@prefix iep:  <${IEP}> .
@prefix agp:  <${AGP}> .
@prefix obs:  <${OBSERVER_MAP}#> .

<${OBSERVER_MAP_AGP}>
    a obs:ObservationMap ;
    dct:title "Intervention evaluation to production performance" ;
    dct:publisher <${CONVENER_DID}> ;
    rdfs:seeAlso <${OBSERVER_MAP}> ;
    rdfs:comment "The same reader, the same affordance, and a different practice's own predicates. It shares exactly one predicate with <${OBSERVER_MAP}> — iep:success, a protocol term belonging to neither practice — and takes the activity type from rdf:type and the name from rdfs:label, which is what the agentic-performance writer actually emits. The reader's source names none of these; the only thing that changes between the two runs is which of these two documents it is handed." ;
    obs:recordSelection obs:everyRecord ;
    obs:requiresType agp:InterventionEvaluation ;
    obs:field [
        a obs:FieldMapping ;
        obs:fromPredicate rdf:type ;
        obs:toArgument "activity_type" ;
        obs:required true ;
    ] ;
    obs:field [
        a obs:FieldMapping ;
        obs:fromPredicate rdfs:label ;
        obs:toArgument "task_name" ;
        obs:required true ;
    ] ;
    obs:field [
        a obs:FieldMapping ;
        obs:fromPredicate iep:success ;
        obs:toArgument "success" ;
        obs:required true ;
    ] ;
    obs:field [
        a obs:FieldMapping ;
        obs:constant <${AGP_SHAPES}> ;
        obs:toArgument "evidence_shape" ;
        obs:required true ;
    ] ;
    obs:field [
        a obs:FieldMapping ;
        obs:fromRecordAddress true ;
        obs:toArgument "task_id" ;
        obs:required true ;
    ] .
`;

const declaredAt = new Date().toISOString();
const alignmentTtl = `@prefix owl:  <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix dct:  <http://purl.org/dc/terms/> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
@prefix wspk: <${SKILLS}#> .
@prefix algn: <${ALIGNMENT}#> .

# ══════════════════════════════════════════════════════════════
#  What the requirer says its requirement is worth
# ══════════════════════════════════════════════════════════════
#
#  Two 1EdTech CASE 1.0 CFAssociations. The chain runs
#
#      <competency the L&D side derives from the work>
#        --isAlignedTo-->  <the WORKSPACE's own published term>
#        --isEquivalentTo--> <the L&D requirement>
#
#  routed deliberately THROUGH the workspace's term rather than around it. Delete
#  wspk:EvidenceIntegrityReview from this document and the requirement goes unsatisfied,
#  because the resolver's walk is a plain breadth-first search over these edges and knows
#  nothing about any namespace. That is the check that tells data apart from code.
#
#  dct:conformsTo foxxi:CASEAlignment is the tag the federated framework registry filters on.
#  It is mirrored from the payload into the descriptor at publish, so the registry finds this
#  document by reading the pod's manifest — no central index.
<${ALIGNMENT}>
    a algn:AlignmentGraph ;
    dct:title "Evidence-integrity review — cross-framework alignment" ;
    dct:publisher <${CONVENER_DID}> ;
    dct:conformsTo <${FOXXI_NS}CASEAlignment> ;
    algn:association algn:eir-to-workspace-term , algn:workspace-term-to-incident-triage .

algn:AlignmentGraph a owl:Class ; rdfs:label "Alignment graph" .
algn:Association a owl:Class ; rdfs:label "CFAssociation" ;
    rdfs:comment "One 1EdTech CASE 1.0 cross-framework association." .
algn:association a owl:ObjectProperty ; rdfs:range algn:Association .
algn:identifier a owl:DatatypeProperty ; rdfs:range xsd:string .
algn:associationType a owl:DatatypeProperty ; rdfs:range xsd:string ;
    rdfs:comment "CASE 1.0 associationType: isAlignedTo, isEquivalentTo, precedes, isPrerequisiteOf, broadens, narrows." .
algn:originItem a owl:ObjectProperty .
algn:originLabel a owl:DatatypeProperty ; rdfs:range xsd:string .
algn:destinationItem a owl:ObjectProperty .
algn:destinationFramework a owl:ObjectProperty .
algn:rationale a owl:DatatypeProperty ; rdfs:range xsd:string .
algn:declaredAt a owl:DatatypeProperty ; rdfs:range xsd:dateTime .

algn:eir-to-workspace-term
    a algn:Association ;
    algn:identifier "eir-to-workspace-term" ;
    algn:associationType "isAlignedTo" ;
    algn:originItem <${FOXXI_COMPETENCY}evidenceintegrityreview> ;
    algn:originLabel "Evidence Integrity Review (performance-derived)" ;
    algn:destinationItem wspk:EvidenceIntegrityReview ;
    algn:destinationFramework <${SKILLS}> ;
    algn:rationale "The competency an L&D record derives from this work is named by the workspace's own term, so the two are the same skill under two naming authorities." ;
    algn:declaredAt "${declaredAt}"^^xsd:dateTime .

algn:workspace-term-to-incident-triage
    a algn:Association ;
    algn:identifier "workspace-term-to-incident-triage" ;
    algn:associationType "isEquivalentTo" ;
    algn:originItem wspk:EvidenceIntegrityReview ;
    algn:originLabel "Evidence Integrity Review" ;
    algn:destinationItem <${FOXXI_COMPETENCY}incident-triage> ;
    algn:destinationFramework <${FOXXI_NS}> ;
    algn:rationale "Reviewing an evidence record for integrity is the same discriminating judgement incident triage asks for: decide, from what the artifact itself says, whether the claim on it holds." ;
    algn:declaredAt "${declaredAt}"^^xsd:dateTime .
`;

// ── Publishing ───────────────────────────────────────────────────────────────

let id = 500;
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${RELAY}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(raw) as Record<string, unknown>; } catch {
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
    try { j = JSON.parse(data) as Record<string, unknown>; } catch { /* neither */ }
  }
  const text = (j as { result?: { content?: { text?: string }[] } } | null)?.result?.content?.[0]?.text;
  try { return JSON.parse(text ?? '{}') as Record<string, unknown>; } catch { return { raw: text ?? raw }; }
}

const sleep = (ms: number): Promise<void> => new Promise(res => setTimeout(res, ms));

/** How long to wait for a deferred publish to become dereferenceable at its own IRI. */
const VISIBILITY_BUDGET_MS = 40_000;

async function publishAndConfirm(graphIri: string, content: string, marker: string): Promise<void> {
  const res = await call('publish_context', {
    graph_iri: graphIri,
    graph_content: content,
    visibility: 'public',
    auto_supersede_prior: true,
    sign_authorship: true,
    agent_did: CONVENER_DID,
  });
  if (res['error'] !== undefined) {
    console.error(`  FAIL ${graphIri}\n       ${JSON.stringify(res).slice(0, 600)}`);
    process.exit(1);
  }
  const descriptorUrl = String(res['descriptorUrl'] ?? '');
  // ★ THE PUBLISH IS DEFERRED AND THE ASSERTION THAT MATTERS IS THE READ-BACK. `publish_context`
  // answers `status: "pending"`; the manifest write that makes /ns/<owner>/<slug> resolve lands
  // seconds later. Reporting success at acceptance would claim a dereferenceable IRI that is
  // still a 404 — and every step after this one depends on it resolving for a stranger.
  //
  // ★ AND THE STATUS ALONE IS NOT THE CHECK. On a REPUBLISH the IRI already answers 200 with
  // the PREVIOUS version, so waiting for "200" waits for nothing and reports the old document
  // as the new one. Measured on this very program: adding a term to the observation map and
  // re-running printed `visible after 562ms` while the head served was still the prior head.
  // So the loop waits for a term that only the version just published contains.
  const started = Date.now();
  for (;;) {
    const probe = await fetch(graphIri, { headers: { Accept: 'text/turtle' } });
    const body = probe.status === 200 ? await probe.text() : '';
    if (probe.status === 200 && body.includes(marker)) {
      console.log(`  ok   ${graphIri}`);
      console.log(`       ${probe.status} ${probe.headers.get('content-type')}, ${body.length} bytes, carries "${marker}", visible after ${Date.now() - started}ms`);
      console.log(`       descriptor ${descriptorUrl}`);
      return;
    }
    if (Date.now() - started >= VISIBILITY_BUDGET_MS) {
      console.error(
        `  FAIL ${graphIri} did not serve the version just published within ${VISIBILITY_BUDGET_MS}ms `
        + `(status ${probe.status}, marker "${marker}" ${body.includes(marker) ? 'present' : 'ABSENT'})`,
      );
      process.exit(1);
    }
    await sleep(2000);
  }
}

// ── Does the published alignment actually satisfy the requirement? ───────────

/**
 * The requirer's own check on its own declaration, run end to end against the live fleet.
 *
 * ★ THE HONEST SHAPE OF THIS HOP. `discover_framework_registry` walks a list of pods and
 * returns POINTERS — it does not fetch the payload. So this dereferences the alignment graph
 * at its own IRI, lifts its associations, and hands them to the resolver. That is one
 * ordinary dereference by a caller, not an engine feature, and calling it "federated
 * resolution" would be overstating what the engine does.
 *
 * What the engine does do is the part that matters: `resolveAlignment` is a breadth-first
 * walk over whatever edges it is given and has no idea any namespace exists. Removing one
 * node from the published document therefore changes the answer — which is the test that
 * tells a data join from a code join, and it is run below rather than described.
 */
interface Association {
  '@type': 'CFAssociation';
  identifier: string;
  associationType: string;
  originNode: { uri: string; label: string };
  destinationNode: { uri: string; frameworkUri: string };
}

const iriOf = (t: ParsedTerm | undefined): string | undefined => t?.kind === 'iri' ? String(t.iri) : undefined;
const litOf = (t: ParsedTerm | undefined): string | undefined => t?.kind === 'literal' ? t.value : undefined;

async function liftAssociations(graphIri: string): Promise<readonly Association[]> {
  const r = await fetch(graphIri, { headers: { Accept: 'text/turtle' } });
  if (!r.ok) throw new Error(`alignment graph <${graphIri}> did not resolve: ${r.status}`);
  const doc = parseTrig(await r.text());
  const T = (local: string): string => `${graphIri}#${local}`;
  const out: Association[] = [];
  for (const s of doc.subjects) {
    const props = s.properties as ReadonlyMap<string, readonly ParsedTerm[]>;
    const origin = iriOf(props.get(T('originItem'))?.[0]);
    const destination = iriOf(props.get(T('destinationItem'))?.[0]);
    const type = litOf(props.get(T('associationType'))?.[0]);
    if (!origin || !destination || !type) continue;
    out.push({
      '@type': 'CFAssociation',
      identifier: litOf(props.get(T('identifier'))?.[0]) ?? '',
      associationType: type,
      originNode: { uri: origin, label: litOf(props.get(T('originLabel'))?.[0]) ?? '' },
      destinationNode: { uri: destination, frameworkUri: iriOf(props.get(T('destinationFramework'))?.[0]) ?? '' },
    });
  }
  return out;
}

async function resolveAligned(held: string, required: string, alignments: readonly Association[]): Promise<Record<string, unknown>> {
  const r = await fetch('https://foxxi-bridge.interego.xwisee.com/foxxi/resolve_aligned_competency', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ held_competency_iri: held, required_competency_iri: required, alignments }),
  });
  const j = await r.json() as Record<string, unknown>;
  return (j['result'] ?? j) as Record<string, unknown>;
}

async function resolveMode(): Promise<void> {
  const CONVENER_POD = 'https://gate.interego.xwisee.com/u-eth-9bf50894ff23/';
  const HELD = `${FOXXI_COMPETENCY}evidenceintegrityreview`;
  const REQUIRED = `${FOXXI_COMPETENCY}incident-triage`;

  console.log('\n1. the federated registry finds the alignment by its published tag, with no index');
  const reg = await fetch('https://foxxi-bridge.interego.xwisee.com/foxxi/discover_framework_registry', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pod_urls: [CONVENER_POD] }),
  });
  const regJson = await reg.json() as Record<string, unknown>;
  const rows = ((regJson['result'] ?? []) as Record<string, unknown>[])
    .filter(e => (e['conformsTo'] as string[] | undefined)?.some(c => c.endsWith('#CASEAlignment')))
    .sort((a, b) => String(b['validFrom'] ?? '').localeCompare(String(a['validFrom'] ?? '')));
  if (rows.length === 0) { console.error('  FAIL registry returned no CASE alignment on the convener\'s pod'); process.exit(1); }
  const frameworkIri = String(rows[0]!['frameworkIri']);
  console.log(`  ok   ${rows.length} alignment descriptor(s); newest names <${frameworkIri}>`);
  console.log(`       ${JSON.stringify(rows[0])}`);

  console.log('\n2. dereference it and walk it');
  const alignments = await liftAssociations(frameworkIri);
  console.log(`  ok   ${alignments.length} association(s) lifted`);
  for (const a of alignments) console.log(`       ${a.originNode.uri}\n         --${a.associationType}--> ${a.destinationNode.uri}`);

  const say = (v: Record<string, unknown>): string => JSON.stringify({
    satisfied: v['satisfied'], via: v['via'],
    hops: Array.isArray(v['chain']) ? (v['chain'] as unknown[]).length : null,
    rationale: v['rationale'],
  });

  const satisfied = await resolveAligned(HELD, REQUIRED, alignments);
  console.log(`  ->   ${say(satisfied)}`);
  for (const hop of (satisfied['chain'] as Association[] | undefined) ?? []) {
    console.log(`       hop: ${hop.originNode.uri} --${hop.associationType}--> ${hop.destinationNode.uri}`);
  }

  console.log('\n3. the control: the same call with no alignment graph at all');
  const control = await resolveAligned(HELD, REQUIRED, []);
  console.log(`  ->   ${say(control)}`);

  // ★ THE TEST THAT SEPARATES DATA FROM CODE, and it keeps BOTH edges. Deleting the two
  // associations outright would only reproduce the control above. Instead the second hop is
  // re-pointed at a DIFFERENT term of the same scheme: the graph still holds two associations
  // between the same two frameworks, and the only thing that changed is that they no longer
  // meet at the workspace's own term. If satisfaction survives that, the pivot is not the
  // node — some function is doing the join and the published graph is decoration.
  console.log('\n4. keep both associations; move the second one off the workspace\'s own term');
  const rerouted = alignments.map(a =>
    a.originNode.uri.includes('#EvidenceIntegrityReview')
      ? { ...a, originNode: { ...a.originNode, uri: a.originNode.uri.replace('#EvidenceIntegrityReview', '#SomeOtherSkill') } }
      : a);
  console.log(`       ${rerouted.length} associations still declared; the join node is now #SomeOtherSkill on one side only`);
  const broken = await resolveAligned(HELD, REQUIRED, rerouted);
  console.log(`  ->   ${say(broken)}`);

  const ok = satisfied['satisfied'] === true && satisfied['via'] === 'aligned'
    && control['satisfied'] === false && control['via'] === 'unknown'
    && broken['satisfied'] === false;
  console.log(`\n${ok ? 'PASS' : 'FAIL'} — satisfied via the published chain, unsatisfied without it, unsatisfied with the workspace term removed.`);
  if (!ok) process.exit(1);
}

async function main(): Promise<void> {
  if (process.argv.includes('--resolve')) { await resolveMode(); return; }
  console.log(`\nconvener namespace: ${NS}\n`);
  // The third element is a term the version being published contains — see publishAndConfirm
  // for why a 200 on its own confirms nothing on a republish.
  for (const [iri, content, marker] of [
    [SKILLS, wspSkillsTtl, 'EvidenceIntegrityReview'],
    [WORK_SHAPES, wspWorkShapesTtl, 'targetSubjectsOf'],
    [OBSERVER_MAP, observerMapTtl, 'requiresType'],
    [OBSERVER_MAP_AGP, observerMapAgpTtl, 'InterventionEvaluation'],
    [ALIGNMENT, alignmentTtl, 'workspace-term-to-incident-triage'],
  ] as const) {
    await publishAndConfirm(iri, content, marker);
  }
  console.log('\nfive documents published and dereferenceable.');
}

main().catch(e => { console.error(e); process.exit(1); });
