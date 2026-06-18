// AUTO-GENERATED — do not edit by hand.
// Source: docs/ns/interego.ttl (skos labels) + docs/ns/alignment.ttl (align:answersInterrogative).
// Regenerate: npx tsx packages/pgsl/scripts/gen-interrogative-table.ts
// Drift-guarded by tests/interrogative-router.test.ts.
import type { InterrogativeEntry } from './interrogative-router.js';

export const INTERROGATIVE_TABLE: readonly InterrogativeEntry[] = [
  {"type":"Who","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Who","prefLabel":"Who","altLabels":["Subject","Agent","Actor"],"answeredBy":["cg:AgentFacet","cgh:AbstractAgentType","cgh:Conversation"]},
  {"type":"What","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#What","prefLabel":"What","altLabels":["Entity","Object","Thing"],"answeredBy":["cgh:ObservationSection","pgsl:Atom","pgsl:Fragment"]},
  {"type":"Where","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Where","prefLabel":"Where","altLabels":["Location","Place","Container"],"answeredBy":["cg:FederationFacet"]},
  {"type":"When","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#When","prefLabel":"When","altLabels":["Time","Moment","Duration"],"answeredBy":["cg:TemporalFacet"]},
  {"type":"Why","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Why","prefLabel":"Why","altLabels":["Reason","Cause","Motive","Purpose"],"answeredBy":["cg:ProvenanceFacet","cgh:Decision","cgh:ProvTrace"]},
  {"type":"How","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#How","prefLabel":"How","altLabels":["Method","Means","Manner","Procedure"],"answeredBy":["cg:ProvenanceFacet","cgh:ProvTrace","pgsl:ConstituentMorphism","pgsl:PullbackSquare"]},
  {"type":"Which","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Which","prefLabel":"Which","altLabels":["Selection","Choice","Alternative"],"answeredBy":["cgh:Decision","cgh:DecisionResult"]},
  {"type":"WhatKind","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#WhatKind","prefLabel":"What kind","altLabels":["Type","Category","Class","Sort"],"answeredBy":["cg:SemioticFacet"]},
  {"type":"HowMuch","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#HowMuch","prefLabel":"How much","altLabels":["How many","Quantity","Extent","Magnitude"],"answeredBy":["cgh:RuntimeEval","pgsl:Fragment","pgsl:Lattice"]},
  {"type":"Whose","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Whose","prefLabel":"Whose","altLabels":["Ownership","Control","Stewardship"],"answeredBy":["cg:AccessControlFacet","cg:AgentFacet"]},
  {"type":"Whether","iri":"https://markjspivey-xwisee.github.io/interego/ns/interego#Whether","prefLabel":"Whether","altLabels":["Yes/No","Truth","Modality","Possibility","Permission"],"answeredBy":["cg:AccessControlFacet","cg:SemioticFacet","cg:TrustFacet","cgh:PolicyDecision","cgh:RuntimeEval"]},
];
