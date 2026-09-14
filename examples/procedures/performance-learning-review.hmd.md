---
"@context":
  - iep: "https://markjspivey-xwisee.github.io/interego/ns/iep#"
    ieh: "https://markjspivey-xwisee.github.io/interego/ns/harness#"
    hydra: "http://www.w3.org/ns/hydra/core#"
    sh: "http://www.w3.org/ns/shacl#"
    prov: "http://www.w3.org/ns/prov#"
    dcat: "http://www.w3.org/ns/dcat#"
    dct: "http://purl.org/dc/terms/"
    xsd: "http://www.w3.org/2001/XMLSchema#"
    rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#"
    rdfs: "http://www.w3.org/2000/01/rdf-schema#"
    affordances:
      "@id": "https://markjspivey-xwisee.github.io/interego/ns/iep#affordance"
      "@container": "@set"
    conformsToShape:
      "@id": "http://www.w3.org/ns/shacl#shapesGraph"
      "@type": "@id"
    operandIris:
      "@id": "https://markjspivey-xwisee.github.io/interego/ns/iep#operand"
      "@container": "@set"
      "@type": "@id"
    action:
      "@id": "https://markjspivey-xwisee.github.io/interego/ns/iep#action"
      "@type": "@id"
    method:
      "@id": "http://www.w3.org/ns/hydra/core#method"
    mediaType:
      "@id": "http://www.w3.org/ns/hydra/core#returnsContentType"
    expects:
      "@id": "http://www.w3.org/ns/hydra/core#expects"
      "@type": "@id"
    returns:
      "@id": "http://www.w3.org/ns/hydra/core#returns"
      "@type": "@id"
    apex:
      "@id": "https://markjspivey-xwisee.github.io/interego/ns/iep#apex"
      "@type": "@id"
    left:
      "@id": "https://markjspivey-xwisee.github.io/interego/ns/iep#left"
      "@type": "@id"
    right:
      "@id": "https://markjspivey-xwisee.github.io/interego/ns/iep#right"
      "@type": "@id"
    overlap:
      "@id": "https://markjspivey-xwisee.github.io/interego/ns/iep#overlap"
      "@type": "@id"
  - hmd: "https://relay.interego.xwisee.com/ns/maintainer/hmd#"
    owl: "http://www.w3.org/2002/07/owl#"
    skos: "http://www.w3.org/2004/02/skos/core#"
    schema: "https://schema.org/"
    wdrs: "http://www.w3.org/2007/05/powder-s#"
    type: "@type"
    profile:
      "@id": "dct:conformsTo"
      "@type": "@id"
    title:
      "@id": "dct:title"
    document:
      "@id": "schema:subjectOf"
    about:
      "@id": "schema:about"
      "@type": "@id"
    descriptorUrl:
      "@id": "wdrs:describedby"
      "@type": "@id"
    state:
      "@id": "schema:creativeWorkStatus"
    rel:
      "@id": "hmd:rel"
      "@type": "@id"
    control:
      "@id": "hmd:control"
      "@type": "@id"
      "@container": "@set"
    condition:
      "@id": "hmd:condition"
    whenToUse:
      "@id": "skos:scopeNote"
    requires:
      "@id": "dct:requires"
      "@container": "@set"
    target:
      "@id": "hmd:target"
      "@type": "@id"
    source:
      "@id": "prov:wasDerivedFrom"
      "@type": "@id"
    expects:
      "@id": "hydra:expects"
      "@type": "@id"
    returns:
      "@id": "hydra:returns"
      "@type": "@id"
  - pr: "https://markjspivey-xwisee.github.io/interego/ns/procedure#"
    entry:
      "@id": "https://markjspivey-xwisee.github.io/interego/ns/procedure#entry"
      "@type": "@id"
    steps:
      "@id": "https://markjspivey-xwisee.github.io/interego/ns/procedure#step"
      "@type": "@id"
    input:
      "@id": "https://markjspivey-xwisee.github.io/interego/ns/procedure#input"
      "@type": "@id"
    procedureProfile:
      "@id": "http://purl.org/dc/terms/conformsTo"
      "@type": "@id"
"@id": "urn:interego:procedure:performance-learning-evidence-review:v1"
"@type": "pr:Procedure"
title: "Follow performance, SCORM and xAPI evidence to the current release state"
descriptorUrl: "https://raw.githubusercontent.com/markjspivey-xwisee/interego/master/examples/procedures/performance-learning-review.ttl"
entry: "urn:interego:procedure:performance-learning-evidence-review:v1#catalog-head"
steps: ["urn:interego:procedure:performance-learning-evidence-review:v1#catalog-head", "urn:interego:procedure:performance-learning-evidence-review:v1#one-catalog-head", "urn:interego:procedure:performance-learning-evidence-review:v1#catalog", "urn:interego:procedure:performance-learning-evidence-review:v1#catalog-authority", "urn:interego:procedure:performance-learning-evidence-review:v1#refresh-control", "urn:interego:procedure:performance-learning-evidence-review:v1#refresh", "urn:interego:procedure:performance-learning-evidence-review:v1#refreshed-authority", "urn:interego:procedure:performance-learning-evidence-review:v1#expected-state", "urn:interego:procedure:performance-learning-evidence-review:v1#readiness-link", "urn:interego:procedure:performance-learning-evidence-review:v1#readiness-read", "urn:interego:procedure:performance-learning-evidence-review:v1#readiness", "urn:interego:procedure:performance-learning-evidence-review:v1#readiness-binding", "urn:interego:procedure:performance-learning-evidence-review:v1#results-link", "urn:interego:procedure:performance-learning-evidence-review:v1#results-read", "urn:interego:procedure:performance-learning-evidence-review:v1#results", "urn:interego:procedure:performance-learning-evidence-review:v1#results-binding", "urn:interego:procedure:performance-learning-evidence-review:v1#portable-read", "urn:interego:procedure:performance-learning-evidence-review:v1#portable", "urn:interego:procedure:performance-learning-evidence-review:v1#course-read", "urn:interego:procedure:performance-learning-evidence-review:v1#course-hmd", "urn:interego:procedure:performance-learning-evidence-review:v1#course-link", "urn:interego:procedure:performance-learning-evidence-review:v1#course-metadata-read", "urn:interego:procedure:performance-learning-evidence-review:v1#course-metadata", "urn:interego:procedure:performance-learning-evidence-review:v1#course-binding", "urn:interego:procedure:performance-learning-evidence-review:v1#state-fence", "urn:interego:procedure:performance-learning-evidence-review:v1#catalog-fence", "urn:interego:procedure:performance-learning-evidence-review:v1#consistent-observation", "urn:interego:procedure:performance-learning-evidence-review:v1#status"]
input: "urn:interego:procedure:performance-learning-evidence-review:v1#input"
procedureProfile: "https://markjspivey-xwisee.github.io/interego/ns/procedure#ReadProcedureProfile"
document:
  "@id": "urn:interego:procedure:performance-learning-evidence-review:v1?format=markdown"
  "@type": "hmd:Document"
  profile: "https://relay.interego.xwisee.com/ns/maintainer/hmd"
  about: "urn:interego:procedure:performance-learning-evidence-review:v1"
---

# Follow performance, SCORM and xAPI evidence to the current release state

This view exposes the entry and step IRIs as linked data. The authoritative RDF carries each directed next edge, condition, input binding, Hydra operation, and decision boundary. The table follows those edges; file order is immaterial.

The installed client interpreter loads the signed graph through its run request. This view advertises only controls supplied by the authority; it does not invent a server-side execution action.

| Step | Operation | Next | Bound data |
| --- | --- | --- | --- |
| [catalog-head](urn:interego:procedure:performance-learning-evidence-review:v1#catalog-head) | read · Hydra GET | [one-catalog-head](urn:interego:procedure:performance-learning-evidence-review:v1#one-catalog-head) | /input/podUrl; /input/catalogGraphIri |
| [one-catalog-head](urn:interego:procedure:performance-learning-evidence-review:v1#one-catalog-head) | check | [catalog](urn:interego:procedure:performance-learning-evidence-review:v1#catalog) | /steps/catalog-head/forked; /steps/catalog-head/head/cid |
| [catalog](urn:interego:procedure:performance-learning-evidence-review:v1#catalog) | read · Hydra GET | [catalog-authority](urn:interego:procedure:performance-learning-evidence-review:v1#catalog-authority) | /steps/catalog-head/head/descriptorUrl |
| [catalog-authority](urn:interego:procedure:performance-learning-evidence-review:v1#catalog-authority) | check | [refresh-control](urn:interego:procedure:performance-learning-evidence-review:v1#refresh-control) | /steps/catalog/authorship/authorshipVerified; /steps/catalog/authorship/contentBinding; /steps/catalog/authorship/descriptorBinding/bound; /steps/catalog/view/snapshot/live; /steps/catalog/view/snapshot/catalog/current; /steps/catalog/view/snapshot/head/forked; /steps/catalog/view/snapshot/trust/verified; /steps/catalog/view/snapshot/trust/artifactsTotal; /steps/catalog/view/snapshot/trust/artifactsVerified; /steps/catalog/view/snapshot/replay/complete; /steps/catalog/view/snapshot/replay/errors; /steps/catalog/view/snapshot/replay/chainLength; /steps/catalog/view/snapshot/replay/verifiedLinks; /steps/catalog/view/snapshot/replay/links; /item/verified |
| [refresh-control](urn:interego:procedure:performance-learning-evidence-review:v1#refresh-control) | select | [refresh](urn:interego:procedure:performance-learning-evidence-review:v1#refresh) | /item/label; /item/method; /steps/catalog/view/controls |
| [refresh](urn:interego:procedure:performance-learning-evidence-review:v1#refresh) | follow · Hydra GET | [refreshed-authority](urn:interego:procedure:performance-learning-evidence-review:v1#refreshed-authority) | — |
| [refreshed-authority](urn:interego:procedure:performance-learning-evidence-review:v1#refreshed-authority) | check | [expected-state](urn:interego:procedure:performance-learning-evidence-review:v1#expected-state) | /steps/refresh/snapshot/live; /steps/refresh/snapshot/catalog/current; /steps/refresh/snapshot/head/forked; /steps/refresh/snapshot/trust/verified; /steps/refresh/snapshot/trust/artifactsTotal; /steps/refresh/snapshot/trust/artifactsVerified; /steps/refresh/snapshot/replay/complete; /steps/refresh/snapshot/replay/errors; /steps/refresh/snapshot/replay/chainLength; /steps/refresh/snapshot/replay/verifiedLinks; /steps/refresh/snapshot/replay/links; /item/verified |
| [expected-state](urn:interego:procedure:performance-learning-evidence-review:v1#expected-state) | expect | [readiness-link](urn:interego:procedure:performance-learning-evidence-review:v1#readiness-link) | /steps/refresh/snapshot/head/cid; /input/expectedStateCid; /steps/refresh/snapshot/head/version; /steps/refresh/snapshot/head/state/status; /steps/refresh/snapshot/trust/verified |
| [readiness-link](urn:interego:procedure:performance-learning-evidence-review:v1#readiness-link) | pick | [readiness-read](urn:interego:procedure:performance-learning-evidence-review:v1#readiness-read) | /item/role; /steps/refresh/snapshot/head/state/acceptedEvidence |
| [readiness-read](urn:interego:procedure:performance-learning-evidence-review:v1#readiness-read) | read · Hydra GET | [readiness](urn:interego:procedure:performance-learning-evidence-review:v1#readiness) | /steps/readiness-link/descriptorUrl |
| [readiness](urn:interego:procedure:performance-learning-evidence-review:v1#readiness) | project | [readiness-binding](urn:interego:procedure:performance-learning-evidence-review:v1#readiness-binding) | /steps/readiness-read |
| [readiness-binding](urn:interego:procedure:performance-learning-evidence-review:v1#readiness-binding) | check | [results-link](urn:interego:procedure:performance-learning-evidence-review:v1#results-link) | /steps/readiness/documentDigest; /steps/readiness-link/documentDigest; /steps/readiness/document/subjectDigest; /steps/refresh/snapshot/head/state/candidateDigest; /steps/readiness/document/heldOutEvaluation/suiteDigest; /steps/refresh/snapshot/head/state/evaluationSuiteDigest |
| [results-link](urn:interego:procedure:performance-learning-evidence-review:v1#results-link) | pick | [results-read](urn:interego:procedure:performance-learning-evidence-review:v1#results-read) | /item/role; /steps/refresh/snapshot/head/state/acceptedEvidence |
| [results-read](urn:interego:procedure:performance-learning-evidence-review:v1#results-read) | read · Hydra GET | [results](urn:interego:procedure:performance-learning-evidence-review:v1#results) | /steps/results-link/descriptorUrl |
| [results](urn:interego:procedure:performance-learning-evidence-review:v1#results) | project | [results-binding](urn:interego:procedure:performance-learning-evidence-review:v1#results-binding) | /steps/results-read |
| [results-binding](urn:interego:procedure:performance-learning-evidence-review:v1#results-binding) | check | [portable-read](urn:interego:procedure:performance-learning-evidence-review:v1#portable-read) | /steps/results/documentDigest; /steps/results-link/documentDigest; /steps/results/document/candidate/documentDigest; /steps/readiness/document/subjectDigest; /steps/results/document/liveFoxxiResults/revised/graded/correct; /steps/readiness/document/heldOutEvaluation/passedCases; /steps/results/document/liveFoxxiResults/revised/graded/total; /steps/readiness/document/heldOutEvaluation/totalCases |
| [portable-read](urn:interego:procedure:performance-learning-evidence-review:v1#portable-read) | read · Hydra GET | [portable](urn:interego:procedure:performance-learning-evidence-review:v1#portable) | /steps/readiness/document/standardsEvidence/lerDescriptorUrl |
| [portable](urn:interego:procedure:performance-learning-evidence-review:v1#portable) | project | [course-read](urn:interego:procedure:performance-learning-evidence-review:v1#course-read) | /steps/portable-read |
| [course-read](urn:interego:procedure:performance-learning-evidence-review:v1#course-read) | read · Hydra GET | [course-hmd](urn:interego:procedure:performance-learning-evidence-review:v1#course-hmd) | /input/courseHmd |
| [course-hmd](urn:interego:procedure:performance-learning-evidence-review:v1#course-hmd) | project | [course-link](urn:interego:procedure:performance-learning-evidence-review:v1#course-link) | /steps/course-read |
| [course-link](urn:interego:procedure:performance-learning-evidence-review:v1#course-link) | pick | [course-metadata-read](urn:interego:procedure:performance-learning-evidence-review:v1#course-metadata-read) | /item/label; /item/type; /steps/course-hmd/links |
| [course-metadata-read](urn:interego:procedure:performance-learning-evidence-review:v1#course-metadata-read) | read · Hydra GET | [course-metadata](urn:interego:procedure:performance-learning-evidence-review:v1#course-metadata) | /steps/course-link/href |
| [course-metadata](urn:interego:procedure:performance-learning-evidence-review:v1#course-metadata) | project | [course-binding](urn:interego:procedure:performance-learning-evidence-review:v1#course-binding) | /steps/course-metadata-read |
| [course-binding](urn:interego:procedure:performance-learning-evidence-review:v1#course-binding) | check | [state-fence](urn:interego:procedure:performance-learning-evidence-review:v1#state-fence) | /steps/course-metadata/ok; /steps/course-metadata/courseId; /steps/results/document/liveFoxxiResults/revised/course/id; /steps/course-hmd/fields/courseId; /steps/course-metadata/scos/0/assessmentCount; /steps/readiness/document/heldOutEvaluation/totalCases |
| [state-fence](urn:interego:procedure:performance-learning-evidence-review:v1#state-fence) | read · Hydra GET | [catalog-fence](urn:interego:procedure:performance-learning-evidence-review:v1#catalog-fence) | /input/podUrl; /steps/refresh/snapshot/application/stateGraphIri |
| [catalog-fence](urn:interego:procedure:performance-learning-evidence-review:v1#catalog-fence) | read · Hydra GET | [consistent-observation](urn:interego:procedure:performance-learning-evidence-review:v1#consistent-observation) | /input/podUrl; /input/catalogGraphIri |
| [consistent-observation](urn:interego:procedure:performance-learning-evidence-review:v1#consistent-observation) | check | [status](urn:interego:procedure:performance-learning-evidence-review:v1#status) | /steps/state-fence/forked; /steps/state-fence/head/cid; /steps/refresh/snapshot/head/cid; /steps/catalog-fence/forked; /steps/catalog-fence/head/cid; /steps/catalog-head/head/cid |
| [status](urn:interego:procedure:performance-learning-evidence-review:v1#status) | output | terminal | /steps/refresh/snapshot/application/title; /steps/refresh/snapshot/head/state/status; /steps/refresh/snapshot/head/version; /steps/refresh/snapshot/head/cid; /steps/refresh/snapshot/trust/artifactsVerified; /steps/refresh/snapshot/replay/verifiedLinks; /steps/refresh/snapshot/replay/complete; /steps/refresh/snapshot/generatedAt; /steps/readiness/document/ready; /steps/readiness/document/heldOutEvaluation/passedCases; /steps/readiness/document/heldOutEvaluation/totalCases; /steps/portable/document/nativeProduction/success; /steps/readiness/document/issuedAt; /steps/course-metadata/courseId; /steps/course-metadata/scoCount; /steps/course-metadata/manifest; /steps/course-metadata/scormZip; /steps/course-metadata/hmd; /steps/portable/document/nativeProduction/statementId; /steps/readiness/document/standardsEvidence/xapiStatementIds; /steps/portable/document/nativeProduction/sharedLattice/descriptorUrl |

- [Authoritative procedure graph](https://raw.githubusercontent.com/markjspivey-xwisee/interego/master/examples/procedures/performance-learning-review.ttl){rel="describedby" type="text/turtle"}
- [Entry step](urn:interego:procedure:performance-learning-evidence-review:v1#catalog-head){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#entry" type="text/turtle"}
- [catalog-head](urn:interego:procedure:performance-learning-evidence-review:v1#catalog-head){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [one-catalog-head](urn:interego:procedure:performance-learning-evidence-review:v1#one-catalog-head){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [catalog](urn:interego:procedure:performance-learning-evidence-review:v1#catalog){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [catalog-authority](urn:interego:procedure:performance-learning-evidence-review:v1#catalog-authority){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [refresh-control](urn:interego:procedure:performance-learning-evidence-review:v1#refresh-control){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [refresh](urn:interego:procedure:performance-learning-evidence-review:v1#refresh){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [refreshed-authority](urn:interego:procedure:performance-learning-evidence-review:v1#refreshed-authority){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [expected-state](urn:interego:procedure:performance-learning-evidence-review:v1#expected-state){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [readiness-link](urn:interego:procedure:performance-learning-evidence-review:v1#readiness-link){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [readiness-read](urn:interego:procedure:performance-learning-evidence-review:v1#readiness-read){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [readiness](urn:interego:procedure:performance-learning-evidence-review:v1#readiness){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [readiness-binding](urn:interego:procedure:performance-learning-evidence-review:v1#readiness-binding){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [results-link](urn:interego:procedure:performance-learning-evidence-review:v1#results-link){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [results-read](urn:interego:procedure:performance-learning-evidence-review:v1#results-read){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [results](urn:interego:procedure:performance-learning-evidence-review:v1#results){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [results-binding](urn:interego:procedure:performance-learning-evidence-review:v1#results-binding){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [portable-read](urn:interego:procedure:performance-learning-evidence-review:v1#portable-read){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [portable](urn:interego:procedure:performance-learning-evidence-review:v1#portable){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [course-read](urn:interego:procedure:performance-learning-evidence-review:v1#course-read){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [course-hmd](urn:interego:procedure:performance-learning-evidence-review:v1#course-hmd){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [course-link](urn:interego:procedure:performance-learning-evidence-review:v1#course-link){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [course-metadata-read](urn:interego:procedure:performance-learning-evidence-review:v1#course-metadata-read){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [course-metadata](urn:interego:procedure:performance-learning-evidence-review:v1#course-metadata){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [course-binding](urn:interego:procedure:performance-learning-evidence-review:v1#course-binding){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [state-fence](urn:interego:procedure:performance-learning-evidence-review:v1#state-fence){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [catalog-fence](urn:interego:procedure:performance-learning-evidence-review:v1#catalog-fence){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [consistent-observation](urn:interego:procedure:performance-learning-evidence-review:v1#consistent-observation){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
- [status](urn:interego:procedure:performance-learning-evidence-review:v1#status){rel="https://markjspivey-xwisee.github.io/interego/ns/procedure#step" type="text/turtle"}
