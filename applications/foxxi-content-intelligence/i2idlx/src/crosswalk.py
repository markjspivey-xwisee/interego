"""Curated I2IDL-X crosswalk data.

Every row is AI-drafted (method i2x:method-ai-drafted unless stated) and is published
with modal status Hypothetical. build.py refuses to emit a row whose concept is not in
the pinned I2IDL release, whose action is not in the live Foxxi manifest / relay
operations catalog, or whose external target is not in a fetched, dereferenceable
vocabulary or the verified allow-list.

Action keys are "<vertical>/<verb>": they become
https://relay.interego.xwisee.com/ns/iep/action/<vertical>/<verb>, which the relay
302-redirects to the manifest that defines the affordance.
"""
import re

# (concept, role, action, confidence, rationale)
ENACTMENTS = [
    # Learning-engineering methods and practices
    ("a-b-testing", "operationalizes", "foxxi/le-design-ab-experiment", 0.90,
     "Pre-registers an A/B comparison between content variants with a power analysis and analysis plan."),
    ("testing-for-learning-impact", "operationalizes", "foxxi/le-design-ab-experiment", 0.70,
     "Impact testing realized as a pre-registered controlled comparison of variants."),
    ("knowledge-retention", "measures", "foxxi/le-analyze-learning-curve", 0.80,
     "Tracks per-concept performance over attempts and flags plateaus, a retention signal."),
    ("spaced-repetition", "operationalizes", "foxxi/schedule-spaced-repetition", 0.95,
     "Schedules spaced review reminders for a learner."),
    ("retrieval-practice", "operationalizes", "foxxi/schedule-spaced-repetition", 0.55,
     "Scheduled reminders prompt spaced retrieval; the affordance schedules, it does not itself test recall."),
    ("mastery-learning", "operationalizes", "foxxi/launch-au-with-prereq", 0.75,
     "Gates the next cmi5 AU on a verified credential for its prerequisite: progression on demonstrated mastery."),
    ("mastery-learning", "measures", "foxxi/le-calibrate-mastery-threshold", 0.75,
     "Calibrates the cmi5 mastery score against downstream performance."),
    ("competency-based-learning", "operationalizes", "foxxi/le-framework-gap-analysis", 0.70,
     "Cross-references framework competencies with taught concepts to find untaught competencies and unaligned concepts."),
    ("learning-engineering", "operationalizes", "foxxi/le-framework-gap-analysis", 0.60,
     "One of the learning-engineering analyses the bridge exposes over a tenant's courses and framework."),
    ("learning-engineering-process", "measures", "foxxi/le-analyze-learning-curve", 0.50,
     "Supplies investigation-phase evidence (learning curves) that the process iterates on."),
    ("prior-knowledge", "measures", "foxxi/le-estimate-concept-difficulty", 0.50,
     "Estimates concept difficulty from prerequisite depth and cohort signal, i.e. how much prior knowledge a concept presumes."),
    ("continuous-improvement", "operationalizes", "foxxi/course-propose-successor", 0.55,
     "A course proposes its own successor from evidence, making iteration a governed, recorded act."),
    ("evidence-based-practice", "operationalizes", "foxxi/review-method-evidence", 0.65,
     "Checks the evidence coverage behind an intervention method before it is used."),
    ("decision-tracking", "records", "relay/publish_context", 0.55,
     "A design decision recorded as a signed context descriptor; later revisions chain to it by iep:supersedes."),
    ("design-revision", "records", "relay/publish_context", 0.50,
     "A revision published with iep:supersedes pointing at the decision it revises."),

    # Concept maps, analytics, adaptivity, tutoring
    ("concept-map", "explains", "foxxi/explore-concept-map", 0.90,
     "Returns a course's published concept graph (concepts, prerequisite edges) as a navigable map."),
    ("concept-map", "operationalizes", "foxxi/publish-concept-map", 0.85,
     "Publishes a course's concept map as a federated, citable pod artifact."),
    ("learning-analytics", "operationalizes", "foxxi/cohort-concept-intelligence", 0.75,
     "Cross-pod cohort concept-overlap analytics."),
    ("data-informed-decision-making", "operationalizes", "foxxi/derive-adaptive-policy", 0.60,
     "Derives an adaptive sequencing policy from cohort evidence."),
    ("personalization", "operationalizes", "foxxi/derive-adaptive-policy", 0.65,
     "Adapts sequencing policy to cohort evidence."),
    ("personalized-learning", "operationalizes", "foxxi/content-resolve-signed", 0.75,
     "Resolves a composition for the learner from their own record."),
    ("adaptive-instructional-system", "realizes", "foxxi/content-resolve-signed", 0.60,
     "Per-learner path resolution over compositions is the adaptive core of Foxxi delivery."),
    ("adaptive-hypermedia", "realizes", "foxxi/content-next-signed", 0.55,
     "Each answered step returns the next step chosen from the learner's record: adaptive navigation."),
    ("intelligent-tutoring-system", "realizes", "foxxi/find-tutor-for-competency", 0.65,
     "Searches the tutor-agent marketplace for a specific competency."),
    ("pedagogical-agent", "realizes", "foxxi/register-tutor-agent", 0.70,
     "Registers an AI tutor agent in the marketplace."),
    ("pedagogical-agent", "explains", "foxxi/course-ask", 0.60,
     "Role-framed, grounded Q&A over an analyzed course."),
    ("ai-assisted-teaching", "operationalizes", "foxxi/ask-course-question-agentic", 0.60,
     "Agentic retrieval-augmented answers over a course federation."),
    ("microlearning", "operationalizes", "foxxi/content-fragment-signed", 0.60,
     "Authors a single fragment of teaching or support, the microlearning unit."),
    ("digital-learning-materials", "operationalizes", "foxxi/content-compose-signed", 0.60,
     "Composes fragments into a lesson, module, course or curriculum."),

    # Assessment
    ("competency", "measures", "foxxi/ai-assess-competency", 0.70,
     "An AI mentor signs a Hypothetical competency assertion that a human must countersign."),
    ("competency", "measures", "foxxi/resolve-aligned-competency", 0.60,
     "Decides whether a held competency satisfies a required one across aligned frameworks."),
    ("competency", "credentials", "foxxi/issue-credential", 0.80,
     "Issues a competency credential as the vertical's authority."),
    ("competency", "credentials", "foxxi/prove-competency", 0.75,
     "Proves a held competency with BBS+ selective disclosure."),
    ("learning-assessment", "measures", "foxxi/ai-assess-competency", 0.55,
     "AI-mentored competency assessment, held Hypothetical until countersigned."),
    ("formative-assessment", "measures", "foxxi/content-next-signed", 0.50,
     "Each step's answer is checked in the flow before the learner moves on."),
    ("summative-assessment", "records", "foxxi/record-course-completion-signed", 0.55,
     "Records a cmi5 completion, the summative outcome of an AU."),

    # AI governance, privacy, compliance, agency
    ("ai-tool-validation-for-education", "operationalizes", "foxxi/open-agent-evaluation", 0.70,
     "Opens an evaluation cohort to validate an AI agent or harness before use."),
    ("ai-tool-validation-for-education", "measures", "foxxi/compare-agent-evaluation", 0.65,
     "Compares the evaluation cohort's portfolio."),
    ("human-controlled-ai-in-education", "enforces", "foxxi/set-autonomy-policy", 0.80,
     "Amends when an AI judge may act without a person: human control over AI autonomy."),
    ("human-agency-in-ai", "explains", "foxxi/autonomy-status", 0.60,
     "Shows who may assert what without a person, so agency boundaries are inspectable."),
    ("human-accountability-in-ai", "enforces", "foxxi/countersign-assessment", 0.80,
     "A human countersigns an AI mentor's competency assertion before it becomes a full credential."),
    ("privacy-by-design", "operationalizes", "foxxi/generate-dpia", 0.80,
     "Generates a data protection impact assessment for a learning deployment."),
    ("data-privacy", "operationalizes", "foxxi/generate-dpia", 0.65,
     "A DPIA is the documented control through which privacy obligations are assessed."),
    ("learner-privacy", "enforces", "foxxi/prove-competency", 0.65,
     "Selective disclosure proves one competency without revealing the rest of the record."),
    ("standards-compliance", "operationalizes", "foxxi/audit-compliance-trail", 0.60,
     "Composes a single-query audit chain over compliance evidence."),
    ("standards-compliance", "records", "foxxi/publish-compliance-evidence", 0.60,
     "Publishes compliance evidence as a governed, signed record."),
    ("data-ownership", "realizes", "foxxi/register-self-sovereign-learner", 0.70,
     "Registers a learner (human or agent) with their own pod: the learner holds the record."),
    ("learner-agency", "operationalizes", "foxxi/content-admit-signed", 0.60,
     "The learner chooses which forms of content suit them at a competency."),
    ("user-directed-customization", "operationalizes", "foxxi/content-admit-signed", 0.60,
     "Learner-directed selection of content forms."),
    ("self-regulated-learning", "operationalizes", "foxxi/review-record", 0.55,
     "The learner reviews their own performance record (ELR + CLR) to plan next steps."),
    ("self-monitoring", "operationalizes", "foxxi/review-record", 0.55,
     "Reviewing one's own record is the monitoring step of self-regulation."),

    # xAPI and data instrumentation
    ("xapi-statement", "records", "foxxi/write-xapi-statements-signed", 0.90,
     "Writes the actor's own xAPI statements to the Statements Resource."),
    ("statement-resource", "realizes", "foxxi/read-xapi-statements-signed", 0.80,
     "Reads statements back from the Statements Resource."),
    ("learning-record", "records", "foxxi/write-xapi-statements-signed", 0.75,
     "Each written statement is a learning record in the LRS."),
    ("learning-record-store-lrs", "realizes", "foxxi/discover-lrs", 0.90,
     "Dereferences the LRS's own xAPI about discovery document."),
    ("learning-record-provider-lrp", "realizes", "foxxi/emit-cmi5-session", 0.60,
     "Emits a conformant cmi5 session trace, the bridge acting as a record provider."),
    ("learning-record-consumer-lrc", "realizes", "foxxi/query-experience-index", 0.70,
     "Federates a statement query across several LRSs (TLA experience index)."),
    ("total-learning-architecture-tla", "realizes", "foxxi/query-experience-index", 0.60,
     "Implements the TLA experience-index pattern over multiple LRSs."),
    ("registration", "records", "foxxi/emit-cmi5-session", 0.60,
     "cmi5 sessions carry the registration that groups an attempt's statements."),
    ("experience-api-xapi", "implements", "foxxi/write-xapi-statements-signed", 0.75,
     "Signed transport over the standard xAPI Statements Resource."),
    ("ieee-9274-1-1-2023-xapi", "implements", "foxxi/discover-lrs", 0.70,
     "Serves the standard xAPI about resource."),
    ("x-experience-api-version", "implements", "foxxi/discover-lrs", 0.60,
     "The about resource reports the xAPI versions the LRS supports."),
    ("xapi-profile", "implements", "foxxi/extend-standards", 0.75,
     "Authors an xAPI Profile fragment or context extension that composes with the host profile."),
    ("xapi-extension", "implements", "foxxi/extend-standards", 0.80,
     "Mints a new xAPI context extension as a dereferenceable profile fragment."),
    ("streaming-learning-data", "realizes", "relay/subscribe_to_pod", 0.55,
     "Subscribes to live change notifications from a pod."),

    # SCORM / IEEE 1484.11 / content packaging
    ("ieee-1484-11-2-2020-ecmascript-runtime-api", "implements", "foxxi/scorm-launch-signed", 0.75,
     "Starts an attempt on the SCORM sequencing engine that exposes the ECMAScript runtime API."),
    ("ieee-1484-11-1-2022-content-object-communication", "implements", "foxxi/scorm-submit-signed", 0.70,
     "Commits the current SCO's run-time data-model values and advances."),
    ("ieee-1484-13-4-2016-ims-content-packaging-mapping", "implements", "foxxi/upload-scorm-package", 0.70,
     "Accepts IMS content packages (SCORM zips) for ingestion."),
    ("ieee-1484-13-4-2016-ims-content-packaging-mapping", "implements", "foxxi/ingest-content-package", 0.70,
     "Ingests SCORM, cmi5 and xAPI content packages."),

    # Credentials and learner records
    ("ieee-1484-2-2024-learning-employment-record-ecosystems", "implements", "foxxi/assemble-learner-record", 0.75,
     "Assembles an enterprise learner record in the LER ecosystem model."),
    ("enterprise-learner-record", "realizes", "foxxi/assemble-learner-record", 0.85,
     "Assembles an Enterprise Learner Record (IEEE P2997) for a human or agent."),
    ("verifiable-learning-and-employment-record", "realizes", "foxxi/export-clr", 0.80,
     "Exports a verifiable 1EdTech CLR 2.0 learner record."),
    ("digital-credential", "credentials", "foxxi/issue-completion-credential", 0.80,
     "Issues a W3C VC / Open Badges 3.0 completion credential."),
    ("digital-credential", "credentials", "foxxi/verify-credential", 0.80,
     "Verifies a credential."),
    ("micro-credential", "credentials", "foxxi/issue-credential", 0.70,
     "Issues a competency credential, a micro-credential when scoped to one competency."),

    # Competency frameworks
    ("ieee-1484-20-3-2022-shareable-competency-definitions", "implements", "foxxi/export-case-framework", 0.70,
     "Exports the tenant's competency framework as 1EdTech CASE 1.0 for exchange."),
    ("shareable-competency-definition-scd", "implements", "foxxi/push-to-cass", 0.65,
     "Pushes the competency framework to an ADL CaSS server."),
    ("ieee-1484-20-2-2022-defining-competencies", "implements", "foxxi/declare-framework-alignment", 0.60,
     "Declares alignment associations between competency definitions across frameworks."),

    # Metadata and catalogs
    ("learning-metadata", "realizes", "foxxi/publish-course-catalog-product", 0.60,
     "Publishes course metadata as a federated (HyprCat) data product."),
    ("metadata-tagging", "operationalizes", "foxxi/course-analyze", 0.50,
     "Analyzes a package and fingerprints its tooling and structure into metadata."),

    # Linked data and interoperability (relay)
    ("linked-data", "implements", "foxxi/publish-ontology", 0.75,
     "Hosts an ontology as dereferenceable, content-negotiated linked data on Interego."),
    ("controlled-vocabulary", "operationalizes", "foxxi/publish-ontology", 0.60,
     "Publishes a vocabulary at a resolvable hash namespace."),
    ("named-graph", "realizes", "relay/publish_context", 0.80,
     "Publishes a named graph together with a signed context descriptor."),
    ("named-graph", "realizes", "relay/get_descriptor", 0.60,
     "Reads a named graph back with its descriptor."),
    ("internationalized-resource-identifier-iri", "realizes", "relay/dereference", 0.55,
     "Dereferences an IRI to what it denotes."),
    ("semantic-interoperability", "realizes", "relay/resolve_linked_data", 0.55,
     "Resolves a published vocabulary as linked data so independent agents share term meaning."),
    ("resource-description-framework-rdf", "implements", "relay/resolve_linked_data", 0.60,
     "Serves published graphs as RDF (Turtle or JSON-LD)."),
    ("json-ld", "implements", "relay/resolve_linked_data", 0.55,
     "Returns JSON-LD projections of published graphs."),
    ("interoperability", "implements", "relay/invoke_affordance", 0.50,
     "Invokes another vertical's affordance from its published manifest, with no per-vertical client."),
]

# (role-bearing concept, action, confidence, rationale)
ROLE_CAPABILITIES = [
    ("profile-author", "foxxi/extend-standards", 0.75,
     "Authoring an xAPI Profile fragment or extension is the profile author's core act."),
    ("profile-author", "foxxi/xapi-author-signed", 0.55,
     "Authors native xAPI content against a profile."),
    ("profile-validator", "foxxi/verify-extension", 0.55,
     "Independently verifies that a subject extended a standard."),
    ("instructional-designer", "foxxi/content-compose-signed", 0.65,
     "Composes fragments into lessons, modules and courses."),
    ("instructional-designer", "foxxi/scorm-author-signed", 0.60,
     "Authors a conformant SCORM 2004 course."),
    ("learning-design-practitioner", "foxxi/content-compose-signed", 0.60,
     "Composes learning designs from fragments."),
    ("learning-experience-design-lxd", "foxxi/content-compose-signed", 0.55,
     "Experience design realized as composition of delivered content."),
    ("subject-matter-expert-sme", "foxxi/content-fragment-signed", 0.60,
     "Contributes a fragment of teaching or support from domain expertise."),
]

# Derived, not curated: every Foxxi affordance whose manifest title starts with this tag
# becomes a role capability of the mapped I2IDL concept.
ROLE_TAGS = {
    "[learning-engineer]": ("learning-engineer", 0.85,
        "Foxxi gates this affordance to the learning-engineer role (tag in its manifest title)."),
}

# (concept, predicate, external IRI, confidence, method, rationale)
#
# A proposal's id is its concept and its place among that concept's rows (mp:m-<concept>-<n>, ids()), and votes are
# cast on ids, so rows are only ever appended: a proposal that a better one replaces stays where it is, listed in
# SUPERSEDED, and is published with i2x:status-superseded and dct:isReplacedBy the new one. build.py --live checks
# that every published proposal keeps its id, concept, predicate and target.
XAPI = "https://w3id.org/xapi/ontology#"
XPROF = "https://w3id.org/xapi/profiles/ontology#"
FOXXI_NS = "https://foxxi-bridge.interego.xwisee.com/ns/"
LER = FOXXI_NS + "ieee-ler#"
TLA = FOXXI_NS + "adl-tla#"
FX_XAPI = FOXXI_NS + "xapi#"
FX_SCORM_CAM = FOXXI_NS + "scorm-cam#"
FX_SCORM_RTE = FOXXI_NS + "scorm-rte#"
FX_CMI5 = FOXXI_NS + "cmi5#"
SDO = "https://schema.org/"
VC = "https://www.w3.org/2018/credentials#"
IEP = "https://markjspivey-xwisee.github.io/interego/ns/iep#"
UNESCO = "http://vocabularies.unesco.org/thesaurus/"

ST = "standards-text"
AI = "ai-drafted"
EC = "evidence-cited"  # I2IDL's own evidence cites the target; build.py checks the citation

MAPPINGS = [
    # xAPI ontology — same normative text (I2IDL cites the IEEE xAPI base standard)
    ("xapi-statement", "exactMatch", XAPI + "Statement", 0.85, ST, "Both denote the xAPI Statement data structure defined by the xAPI base standard."),
    ("verb", "exactMatch", XAPI + "Verb", 0.85, ST, "Both denote the xAPI Verb element identified by an IRI with a display language map."),
    ("activity", "exactMatch", XAPI + "Activity", 0.80, ST, "Both denote the xAPI Activity an Actor interacts with."),
    ("activity-definition", "exactMatch", XAPI + "ActivityDefinition", 0.85, ST, "Both denote the optional Activity Definition metadata object."),
    ("actor", "exactMatch", XAPI + "Actor", 0.85, ST, "Both denote the Statement's Actor (Agent or Group)."),
    ("xapi-agent", "exactMatch", XAPI + "Agent", 0.85, ST, "Both denote the xAPI Agent identified by an inverse functional identifier."),
    ("xapi-group", "exactMatch", XAPI + "Group", 0.85, ST, "Both denote the xAPI Group of Agents, identified or anonymous."),
    ("account-object", "exactMatch", XAPI + "Account", 0.80, ST, "Both denote the xAPI Account (homePage + name) identity structure."),
    ("context-activities", "exactMatch", XAPI + "ContextActivities", 0.80, ST, "Both denote the contextActivities structure of a Statement's Context."),
    ("result-object", "exactMatch", XAPI + "Result", 0.85, ST, "Both denote the Statement Result (score, success, completion, response, duration)."),
    ("attachment", "closeMatch", XAPI + "Attachments", 0.70, ST, "I2IDL names one attachment; the ontology class names the Statement's attachments structure."),
    ("statement-reference", "exactMatch", XAPI + "StatementRef", 0.85, ST, "Both denote the StatementRef object that points to another Statement by id."),
    ("substatement", "exactMatch", XAPI + "SubStatement", 0.85, ST, "Both denote the embedded SubStatement object."),
    ("xapi-extension", "closeMatch", XAPI + "Extension", 0.75, ST, "Both denote an IRI-keyed extension; the ontology also types its three placements."),
    ("xapi-extension", "narrowMatch", XAPI + "ContextExtension", 0.70, ST, "A context extension is the placement of an extension in Statement Context."),
    ("xapi-extension", "narrowMatch", XAPI + "ResultExtension", 0.70, ST, "A result extension is the placement of an extension in Statement Result."),
    ("xapi-extension", "narrowMatch", XAPI + "ActivityExtension", 0.70, ST, "An activity extension is the placement of an extension in an Activity Definition."),
    ("state-resource", "exactMatch", XAPI + "StateResource", 0.80, ST, "Both denote the /activities/state document resource."),
    ("agent-profile-resource", "exactMatch", XAPI + "AgentProfileResource", 0.80, ST, "Both denote the /agents/profile document resource."),
    ("activity-profile-resource", "exactMatch", XAPI + "ActivityProfileResource", 0.80, ST, "Both denote the /activities/profile document resource."),
    ("document-profile-resource", "closeMatch", XAPI + "DocumentResource", 0.70, ST, "Both denote xAPI's name/document storage; the ontology class generalizes the three document resources."),
    ("interaction-activity", "relatedMatch", XAPI + "InteractionComponent", 0.50, AI, "Interaction activities are described with interaction components (choices, source/target, scale)."),
    ("learning-record", "narrowMatch", XAPI + "Statement", 0.65, AI, "An xAPI Statement is one machine-readable form of a learning record."),
    # xAPI Profiles ontology
    ("xapi-profile", "exactMatch", XPROF + "Profile", 0.85, ST, "Both denote the xAPI Profile defined by the xAPI Profiles specification."),
    ("statement-template", "exactMatch", XPROF + "StatementTemplate", 0.85, ST, "Both denote a Profile's Statement Template."),
    ("xapi-pattern", "exactMatch", XPROF + "Pattern", 0.85, ST, "Both denote a Profile Pattern over Statement Templates."),
    ("statement-template-rule", "exactMatch", XPROF + "StatementTemplateRule", 0.85, ST, "Both denote a JSONPath-located rule inside a Statement Template."),
    # Foxxi-served IEEE LER and ADL TLA semantic layers
    ("enterprise-learner-record", "closeMatch", LER + "EnterpriseLearnerRecord", 0.75, AI, "Both name the organizational record integrating a learner's data across experiences."),
    ("verifiable-learning-and-employment-record", "relatedMatch", LER + "EnterpriseLearnerRecord", 0.60, AI, "A verifiable LER is a checkable form of the record the ELR integrates."),
    ("competency", "closeMatch", TLA + "Competency", 0.70, AI, "Both name a defined capability that can be assessed and referenced across systems."),
    ("competency", "relatedMatch", LER + "CompetencyDefinition", 0.60, AI, "The LER class is the definition record of a competency, not the capability itself."),
    ("shareable-competency-definition-scd", "closeMatch", LER + "CompetencyDefinition", 0.65, AI, "An SCD is a machine-readable competency definition (IEEE 1484.20.3)."),
    ("digital-credential", "closeMatch", LER + "Credential", 0.70, AI, "Both name an issued, verifiable claim about achievement or qualification."),
    ("micro-credential", "broadMatch", LER + "Credential", 0.75, AI, "A micro-credential is a credential scoped to a smaller unit of learning."),
    ("minimum-proficiency-level", "broadMatch", LER + "ProficiencyLevel", 0.55, AI, "An MPL is a specific benchmark level on a proficiency scale."),
    ("ai-competency-framework-for-teachers-ai-cft", "broadMatch", LER + "CompetencyFramework", 0.60, AI, "AI CFT is one competency framework."),
    ("learner-model", "relatedMatch", TLA + "LearnerProfile", 0.60, AI, "The TLA learner profile holds the learner characteristics a learner model represents."),
    ("learning-record-store-lrs", "narrowMatch", TLA + "TransactionalLRS", 0.70, AI, "A transactional LRS is a TLA-specific kind of LRS."),
    ("learning-record-store-lrs", "narrowMatch", TLA + "AuthoritativeLRS", 0.70, AI, "An authoritative LRS is a TLA-specific kind of LRS."),
    ("learning-record-store-lrs", "narrowMatch", TLA + "NoisyLRS", 0.65, AI, "A noisy LRS is a TLA-specific kind of LRS."),
    ("learning-metadata", "narrowMatch", TLA + "LearningActivityMetadata", 0.65, AI, "TLA activity metadata is learning metadata about activities specifically."),
    # schema.org
    ("digital-credential", "closeMatch", SDO + "EducationalOccupationalCredential", 0.70, AI, "Both name an educational or occupational credential that can be issued and recognized."),
    ("educational-institution", "closeMatch", SDO + "EducationalOrganization", 0.75, AI, "Both name an organization whose principal purpose is instruction."),
    ("massive-open-online-course-mooc", "broadMatch", SDO + "Course", 0.75, AI, "A MOOC is a course designed for open access at scale."),
    ("open-educational-resources-oer", "broadMatch", SDO + "LearningResource", 0.70, AI, "OER are learning resources under open licences."),
    ("digital-learning-materials", "closeMatch", SDO + "LearningResource", 0.60, AI, "Both name resources used to support teaching and learning."),
    # W3C Verifiable Credentials
    ("digital-credential", "relatedMatch", VC + "VerifiableCredential", 0.60, AI, "A VC is one technical form a digital credential can take."),
    ("verifiable-learning-and-employment-record", "relatedMatch", VC + "VerifiableCredential", 0.55, AI, "Verifiable LERs are typically expressed as or wrapped in VCs."),
    # Interego
    ("technology-affordance", "relatedMatch", IEP + "Affordance", 0.55, AI, "A design-time technology affordance is what a runtime hypermedia affordance enacts."),
    # UNESCO Thesaurus (I2IDL roadmap priority 1). Each target is the preferred term I2IDL's own
    # definition cites as direct evidence; the predicate follows a reading of both texts.
    ("unesco-education-domain", "exactMatch", UNESCO + "concept2", 0.90, EC, "I2IDL's definition paraphrases UNESCO's scope note for the preferred term it cites."),
    ("unesco-curriculum", "exactMatch", UNESCO + "concept49", 0.90, EC, "Same scope as UNESCO's note for the cited term: the subjects taught, time allotted to each, and their sequence."),
    ("unesco-educational-management", "exactMatch", UNESCO + "concept31", 0.85, EC, "Both mean the management of educational establishments; I2IDL lists the activities involved."),
    ("unesco-educational-administration", "exactMatch", UNESCO + "concept21", 0.85, EC, "Both concern administering part or the whole of an education system."),
    ("unesco-educational-institutions", "exactMatch", UNESCO + "concept44", 0.85, EC, "Same label and cited as the direct source; I2IDL enumerates the kinds of institution."),
    ("unesco-educational-facilities", "exactMatch", UNESCO + "concept95", 0.85, EC, "Same label and cited as the direct source; I2IDL's definition reuses UNESCO's alternative labels (academic, school facilities)."),
    ("unesco-educational-evaluation", "exactMatch", UNESCO + "concept88", 0.85, EC, "Same label and cited as the direct source; I2IDL lists what is evaluated."),
    ("unesco-educational-policy", "closeMatch", UNESCO + "concept9", 0.80, EC, "UNESCO scopes the term to official statements of goals; I2IDL adds principles and directions that shape decisions."),
    ("unesco-educational-sciences-and-environment", "narrowMatch", UNESCO + "concept4", 0.75, EC, "I2IDL's concept also covers learning environments, so UNESCO's Educational sciences is narrower."),
    ("unesco-educational-systems-and-levels", "narrowMatch", UNESCO + "concept37", 0.75, EC, "I2IDL's concept adds levels and stages, so UNESCO's Educational systems is narrower."),
    ("unesco-teaching-and-training", "narrowMatch", UNESCO + "concept83", 0.70, EC, "Teaching methods are one part of what I2IDL's Teaching and training covers."),
    ("unesco-teaching-and-training", "narrowMatch", UNESCO + "concept84", 0.70, EC, "Training is one part of what I2IDL's Teaching and training covers."),
    ("unesco-technical-and-vocational-study-subjects", "relatedMatch", UNESCO + "concept71", 0.65, EC, "Fields of study versus a kind of formal education: associated, but neither contains the other."),

    # Foxxi's xAPI ontology (I2IDL-X 0.4.0). It models what the IEEE xAPI base standard defines: the statements and
    # the structures that describe them, and the actors, agents, groups and activities they are about, each class
    # citing the section I2IDL's own definition cites. ADL's ontology makes all of them parts of a Statement
    # (Account ⊑ Actor ⊑ Statement), which these classes do not. The first fifteen replace the proposals above to
    # ADL's ontology for the same concepts (SUPERSEDED). ADL stays the target where Foxxi has no class: the extension
    # placements and the document resources. Where I2IDL defines the xAPI representation of an agent or a group and
    # Foxxi's class is the agent or group represented, the match is close or related, not exact or hierarchical, so
    # no OWL bridge would make a person a data record.
    ("xapi-statement", "exactMatch", FX_XAPI + "Statement", 0.85, ST, "Both denote the xAPI Statement (IEEE 9274.1.1-2023 §5.2.2): Actor, Verb and Object, with an optional Result, Context, timestamp and Attachments."),
    ("verb", "exactMatch", FX_XAPI + "Verb", 0.85, ST, "Both denote the xAPI Verb (§5.2.2.2): an IRI naming the action, with a language map for its display."),
    ("activity", "exactMatch", FX_XAPI + "Activity", 0.80, ST, "Both denote the xAPI Activity (§5.2.2.3): what an Actor interacts with, identified by an IRI."),
    ("activity-definition", "exactMatch", FX_XAPI + "ActivityDefinition", 0.85, ST, "Both denote the optional Activity Definition metadata object (§5.2.2.3)."),
    ("actor", "exactMatch", FX_XAPI + "Actor", 0.85, ST, "Both denote whom a Statement is about (§5.2.2.1): the individual or group performing its action, an Agent or a Group."),
    ("xapi-agent", "closeMatch", FX_XAPI + "Agent", 0.80, ST, "I2IDL's concept is the xAPI representation of an individual Actor; the class is the person or system it represents, by the same Inverse Functional Identifier (§5.2.2.1)."),
    ("xapi-group", "closeMatch", FX_XAPI + "Group", 0.80, ST, "I2IDL's concept is the xAPI representation of a collection of Agents; the class is the group it represents, identified or anonymous (§5.2.2.1)."),
    ("account-object", "exactMatch", FX_XAPI + "Account", 0.80, ST, "Both denote the xAPI Account (§5.2.2.1): a system's home page and the name of the account on it."),
    ("context-activities", "exactMatch", FX_XAPI + "ContextActivities", 0.80, ST, "Both denote the contextActivities of a Statement's Context (§5.2.2.5): parent, grouping, category and other."),
    ("result-object", "exactMatch", FX_XAPI + "Result", 0.85, ST, "Both denote the Statement Result (§5.2.2.4): score, success, completion, response, duration and extensions."),
    ("attachment", "exactMatch", FX_XAPI + "Attachment", 0.85, ST, "Both denote one attachment (§5.2.2.6): an artifact logically part of a Statement, described by usage type, display, content type, length and SHA-2 hash."),
    ("statement-reference", "exactMatch", FX_XAPI + "StatementRef", 0.85, ST, "Both denote the StatementRef object (§5.2.2.3) that points to another Statement by its id."),
    ("substatement", "exactMatch", FX_XAPI + "SubStatement", 0.85, ST, "Both denote the SubStatement (§5.2.2.3): a Statement nested as the Object of another."),
    ("interaction-activity", "relatedMatch", FX_XAPI + "InteractionComponent", 0.50, AI, "Interaction activities are described with interaction components (choices, scale points, sources and targets, steps)."),
    ("learning-record", "narrowMatch", FX_XAPI + "Statement", 0.65, AI, "An xAPI Statement is one machine-readable form of a learning record."),
    # Classes ADL's ontology does not have (xAPI 2.0's context agents and groups), or that had no proposal.
    ("context-object", "exactMatch", FX_XAPI + "Context", 0.85, ST, "Both denote a Statement's optional Context (§5.2.2.5): registration, context activities, context agents and groups, platform, language, a related Statement, extensions."),
    ("context-agent", "exactMatch", FX_XAPI + "ContextAgent", 0.85, ST, "Both denote xAPI 2.0's Context Agent (§5.2.2.5): a relationship of one Statement to one Agent, with optional relevant types."),
    ("context-group", "exactMatch", FX_XAPI + "ContextGroup", 0.85, ST, "Both denote xAPI 2.0's Context Group (§5.2.2.5): a relationship of one Statement to one Group, with optional relevant types."),
    ("identified-group", "relatedMatch", FX_XAPI + "Group", 0.70, ST, "I2IDL's concept is the representation of a Group that carries its own Inverse Functional Identifier; the class is the group itself, of either kind (§5.2.2.1)."),
    ("anonymous-group", "relatedMatch", FX_XAPI + "Group", 0.70, ST, "I2IDL's concept is the representation of a Group known only by its members; the class is the group itself, of either kind (§5.2.2.1)."),
    ("interaction-activity", "relatedMatch", FX_XAPI + "ActivityDefinition", 0.65, ST, "I2IDL defines it as an Activity Definition with an interaction type (§5.2.2.3) but files it under Activity; related until that is settled."),
    ("xapi-extension", "relatedMatch", FX_XAPI + "Extensions", 0.55, AI, "An extension is one IRI-keyed entry of an extensions map; the class is the map, a node whose properties are the extension IRIs."),
    # Foxxi's SCORM 2004 and cmi5 ontologies. I2IDL v0.0.80 has no SCORM or cmi5 concept of its own (its SCORM-related
    # concepts are the IEEE 1484.11 and 1484.13 standards), so these are the concepts whose referents the classes model.
    ("interaction-activity", "relatedMatch", FX_SCORM_RTE + "Interaction", 0.55, AI, "xAPI defines its interaction types after SCORM 2004's run-time interactions (cmi.interactions), whose recorded responses the class models."),
    ("learning-record", "narrowMatch", FX_SCORM_RTE + "DataModel", 0.60, AI, "SCORM's run-time data for one learner's attempt on a SCO is one machine-readable form of a learning record."),
    ("learning-metadata", "narrowMatch", FX_SCORM_CAM + "Metadata", 0.55, AI, "A content package's metadata element describes the package or one of its parts: learning metadata in one placement."),
    ("digital-learning-materials", "narrowMatch", FX_CMI5 + "AssignableUnit", 0.55, AI, "An assignable unit is the launchable unit of content a cmi5 course tracks: one kind of digital learning material."),
]

# Proposals replaced by a later one: the replaced proposal's id → (the id of the proposal that replaces it, which has the
# same concept; when it was replaced). The replaced proposal keeps its record and id; both are published, the old one
# with i2x:status-superseded, dct:isReplacedBy and prov:invalidatedAtTime. Keyed by id, so a proposal can be replaced by
# one that changes only its predicate.
REPLACED_2026_10_13 = "2026-10-13T11:20:00+00:00"  # I2IDL-X 0.4.0: ADL's xAPI ontology → Foxxi's
SUPERSEDED = {f"m-{cid}-1": (f"m-{cid}-2", REPLACED_2026_10_13) for cid in (
    "xapi-statement", "verb", "activity", "activity-definition", "actor", "xapi-agent", "xapi-group", "account-object",
    "context-activities", "result-object", "attachment", "statement-reference", "substatement", "interaction-activity",
    "learning-record")}


def ids(rows: list | None = None) -> list[str]:
    """Each row's id without the mp: prefix: m-<concept>-<n>, n counting that concept's rows in order."""
    seen: dict[str, int] = {}
    out = []
    for r in (MAPPINGS if rows is None else rows):
        seen[r[0]] = seen.get(r[0], 0) + 1
        out.append(f"m-{re.sub(r'[^A-Za-z0-9-]+', '-', r[0])}-{seen[r[0]]}")
    return out


def is_superseded(row: tuple) -> bool:
    return dict(zip(MAPPINGS, ids())).get(row) in SUPERSEDED


def active(rows: list | None = None) -> list:
    """The proposals under review: every row a later one has not replaced."""
    return [r for r, i in zip(MAPPINGS, ids()) if i not in SUPERSEDED and (rows is None or r in rows)]


# Reflexive exemplars (asserted facts; published in the catalog graph). Value may use {CATALOG} / {ENACT}.
EXEMPLARS = [
    ("sparql", "https://id.i2idl.org/sparql"),
    ("endpoint", "https://id.i2idl.org/sparql"),
    ("json-ld", "https://id.i2idl.org/glossary.jsonld"),
    ("simple-knowledge-organization-system-skos", "https://id.i2idl.org/scheme"),
    ("controlled-vocabulary", "https://id.i2idl.org/scheme"),
    ("linked-data", "https://id.i2idl.org/concepts/linked-data"),
    ("named-graph", "{ENACT}"),
    ("technology-affordance", "{CATALOG}#port-sparql-get"),
    ("rest-api", "https://relay.interego.xwisee.com/.well-known/operations"),
    ("xapi-profile", "https://foxxi-bridge.interego.xwisee.com/xapi/profile"),
]

# Specification documents for standard concepts (asserted; catalog graph).
SPECS = [
    ("experience-api-xapi", "https://opensource.ieee.org/xapi/xapi-base-standard-documentation"),
    ("ieee-9274-1-1-2023-xapi", "https://opensource.ieee.org/xapi/xapi-base-standard-documentation"),
    ("xapi-profile", "https://github.com/adlnet/xapi-profiles"),
    ("resource-description-framework-rdf", "https://www.w3.org/TR/rdf11-concepts/"),
    ("simple-knowledge-organization-system-skos", "https://www.w3.org/TR/skos-reference/"),
    ("sparql", "https://www.w3.org/TR/sparql11-query/"),
    ("json-ld", "https://www.w3.org/TR/json-ld11/"),
    ("json", "https://www.rfc-editor.org/rfc/rfc8259"),
    ("internationalized-resource-identifier-iri", "https://www.rfc-editor.org/rfc/rfc3987"),
]

# Allow-list of external IRIs verified by HTTP (200) at build time on 2026-10-08,
# for vocabularies that are not fetched as RDF by build.py.
VERIFIED_EXTERNAL = {
    SDO + "EducationalOccupationalCredential", SDO + "EducationalOrganization",
    SDO + "Course", SDO + "LearningResource",
    VC + "VerifiableCredential",
}
