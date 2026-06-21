// AUTO-GENERATED — do not edit by hand.
// Source: docs/ns/interego.ttl (skos labels) + docs/ns/alignment.ttl (align:answersInterrogative).
// Regenerate: npx tsx packages/pgsl/scripts/gen-interrogative-table.ts
// Drift-guarded by tests/interrogative-router.test.ts.
import type { InterrogativeEntry } from './interrogative-router.js';

export const INTERROGATIVE_TABLE: readonly InterrogativeEntry[] = [
  {"type":"Who","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Who","prefLabel":"Who","altLabels":["Subject","Agent","Actor"],"answeredBy":["ieh:AbstractAgentType","ieh:Conversation","iep:AgentFacet"]},
  {"type":"What","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#What","prefLabel":"What","altLabels":["Entity","Object","Thing"],"answeredBy":["ieh:ObservationSection","pgsl:Atom","pgsl:Fragment"]},
  {"type":"Where","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Where","prefLabel":"Where","altLabels":["Location","Place","Container"],"answeredBy":["iep:FederationFacet"]},
  {"type":"When","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#When","prefLabel":"When","altLabels":["Time","Moment","Duration"],"answeredBy":["iep:TemporalFacet"]},
  {"type":"Why","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Why","prefLabel":"Why","altLabels":["Reason","Cause","Motive","Purpose"],"answeredBy":["ieh:Decision","ieh:ProvTrace","iep:ProvenanceFacet"]},
  {"type":"How","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#How","prefLabel":"How","altLabels":["Method","Means","Manner","Procedure"],"answeredBy":["ieh:ProvTrace","iep:ProvenanceFacet","pgsl:ConstituentMorphism","pgsl:PullbackSquare"]},
  {"type":"Which","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Which","prefLabel":"Which","altLabels":["Selection","Choice","Alternative"],"answeredBy":["ieh:Decision","ieh:DecisionResult"]},
  {"type":"WhatKind","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#WhatKind","prefLabel":"What kind","altLabels":["Type","Category","Class","Sort"],"answeredBy":["iep:SemioticFacet"]},
  {"type":"HowMuch","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#HowMuch","prefLabel":"How much","altLabels":["How many","Quantity","Extent","Magnitude"],"answeredBy":["ieh:RuntimeEval","pgsl:Fragment","pgsl:Lattice"]},
  {"type":"Whose","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Whose","prefLabel":"Whose","altLabels":["Ownership","Control","Stewardship"],"answeredBy":["iep:AccessControlFacet","iep:AgentFacet"]},
  {"type":"Whether","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Whether","prefLabel":"Whether","altLabels":["Yes/No","Truth","Modality","Possibility","Permission"],"answeredBy":["ieh:PolicyDecision","ieh:RuntimeEval","iep:AccessControlFacet","iep:SemioticFacet","iep:TrustFacet"]},
];
