/**
 * ns/mapping-sets.ts — which Foxxi documents publish an SSSOM mapping set, and what is on record
 * about the terms their mappings point at.
 *
 * Each document whose terms map to another vocabulary's publishes its mappings at
 * `<document>/mappings` (see sssom.ts for the format and why). This module knows the documents —
 * the single-source standards models, the IEEE LER and ADL TLA layer, and the Foxxi vocabulary —
 * and assembles the record of the mapping targets a set reports a label and an entity type for:
 *
 *  - Foxxi's own terms, from the Foxxi document that mints them;
 *  - ADL's xAPI ontology, from the transcription in spec/adl-xapi-ontology.ts;
 *  - the Interego substrate's L3 compliance vocabularies (docs/ns/soc2.ttl, eu-ai-act.ttl,
 *    nist-rmf.ttl), transcribed below — a test reads those files and fails if this drifts.
 *
 * Any other target (an ADL verb, a cmi5 extension, a CaSS class) is reported by identifier only.
 */
import { STD_PREFIXES, type Graph, type Prefixes } from './rdf.js';
import { EXTERNAL_PREFIXES, FOXXI_PREFIXES, NS_BASE, type DocMeta } from './catalog.js';
import { entityTypeIn, hasMappings, labelIn, mappingSetIri, renderSssomTsv, SSSOM_MEDIA_TYPE, type MappingTargetInfo, type SssomEntityType } from './sssom.js';
import { sendNegotiated, type NegotiableRequest, type NegotiableResponse } from './conneg.js';
import { docMeta, ontologyGraph, type OntologyModel } from '../spec-ontology.js';
import { SPEC_MODELS } from '../spec/index.js';
import { COMPLIANCE_MODELS } from '../spec/compliance.model.js';
import { OB3_MODEL, CLR_MODEL } from '../spec/ler.model.js';
import { adlXapiTerm, type AdlXapiKind } from '../spec/adl-xapi-ontology.js';
import { semDocMeta, semOntologyGraph } from '../ler-tla-vocab.js';
import { foxxiDocMeta, vocabGraph } from '../foxxi-vocab.js';

/**
 * Prefixes for every namespace a Foxxi mapping set refers to, one prefix per namespace. They are the
 * prefixes the documents print, with `_` for `-` (foxxi_xapi, not foxxi-xapi): the SSSOM toolkit
 * (sssom-py) reads a CURIE's prefix as [A-Za-z0-9_.]+, so a hyphenated prefix reads as no prefix
 * at all and its CURIEs as unexpandable — though SSSOM's own schema allows any NCName.
 */
export const MAPPING_SET_PREFIXES: Prefixes = Object.freeze(Object.fromEntries(Object.entries({
  ...STD_PREFIXES,
  ...EXTERNAL_PREFIXES,
  ...FOXXI_PREFIXES,
  // The Foxxi documents themselves (a mapping set's subject_source).
  'foxxi-ns': NS_BASE,
  // ADL's xAPI ontology document (the counterpart's object_source) is https://w3id.org/xapi/ontology.
  w3id: 'https://w3id.org/',
  // The xAPI verbs, cmi5 identifiers and competency vocabularies that mappings point at — the same
  // prefixes the cmi5 ontology prints for the verbs.
  adl: 'http://adlnet.gov/expapi/verbs/',
  'adl-w3id': 'https://w3id.org/xapi/adl/verbs/',
  'cmi5-activitytype': 'https://w3id.org/xapi/cmi5/activitytype/',
  'cmi5-category': 'https://w3id.org/xapi/cmi5/context/categories/',
  'cmi5-context-extension': 'https://w3id.org/xapi/cmi5/context/extensions/',
  'cmi5-result-extension': 'https://w3id.org/xapi/cmi5/result/extensions/',
  cass: 'https://schema.cassproject.org/0.4/',
  ceasn: 'https://purl.org/ctdlasn/terms/',
}).map(([prefix, ns]) => [prefix.replace(/-/g, '_'), ns])));

/** The root of the Interego substrate's namespaces (not `IE`, which ontology-lint reads as the ie: namespace). */
const SUBSTRATE_NS = 'https://markjspivey-xwisee.github.io/interego/ns/';
/**
 * The Interego substrate's compliance terms Foxxi maps to, with the labels and kinds the substrate's
 * own ontologies give them (docs/ns/soc2.ttl, eu-ai-act.ttl, nist-rmf.ttl). Transcribed rather than
 * read at run time so a mapping set changes only when Foxxi's source does.
 */
export const SUBSTRATE_TARGETS: Readonly<Record<string, MappingTargetInfo>> = Object.freeze({
  [`${SUBSTRATE_NS}soc2#AccessChangeEvent`]: { label: 'Access change event', type: 'owl class' },
  [`${SUBSTRATE_NS}soc2#DeployEvent`]: { label: 'Production deploy event', type: 'owl class' },
  [`${SUBSTRATE_NS}soc2#IncidentEvent`]: { label: 'Security or operational incident event', type: 'owl class' },
  [`${SUBSTRATE_NS}soc2#KeyRotationEvent`]: { label: 'Cryptographic key rotation event', type: 'owl class' },
  [`${SUBSTRATE_NS}soc2#QuarterlyReviewEvent`]: { label: 'Quarterly review event', type: 'owl class' },
  [`${SUBSTRATE_NS}soc2#ControlEvidence`]: { label: 'Control evidence record', type: 'owl class' },
  [`${SUBSTRATE_NS}soc2#satisfiesControl`]: { label: 'satisfies control', type: 'owl object property' },
  [`${SUBSTRATE_NS}soc2#CC6.1`]: { label: 'CC6.1 — logical + physical access controls (security software, infrastructure, architectures)', type: 'owl named individual' },
  [`${SUBSTRATE_NS}soc2#CC6.2`]: { label: 'CC6.2 — registers + authorizes new internal/external users', type: 'owl named individual' },
  [`${SUBSTRATE_NS}soc2#CC6.3`]: { label: 'CC6.3 — modifies + revokes user access in alignment with role/responsibilities', type: 'owl named individual' },
  [`${SUBSTRATE_NS}soc2#CC6.7`]: { label: 'CC6.7 — restricts transmission, movement, removal of information', type: 'owl named individual' },
  [`${SUBSTRATE_NS}soc2#CC6.8`]: { label: 'CC6.8 — implements controls to prevent + detect unauthorized + malicious software', type: 'owl named individual' },
  [`${SUBSTRATE_NS}soc2#CC7.3`]: { label: 'CC7.3 — evaluates security events to determine response', type: 'owl named individual' },
  [`${SUBSTRATE_NS}soc2#CC7.4`]: { label: 'CC7.4 — responds to identified security incidents', type: 'owl named individual' },
  [`${SUBSTRATE_NS}soc2#CC7.5`]: { label: 'CC7.5 — recovers from identified security incidents', type: 'owl named individual' },
  [`${SUBSTRATE_NS}soc2#CC8.1`]: { label: 'CC8.1 — authorizes, designs, develops, configures, documents, tests, approves changes', type: 'owl named individual' },
  [`${SUBSTRATE_NS}eu-ai-act#Article9`]: { label: 'Article 9 — Risk management system', type: 'owl named individual' },
  [`${SUBSTRATE_NS}eu-ai-act#Article10`]: { label: 'Article 10 — Data governance', type: 'owl named individual' },
  [`${SUBSTRATE_NS}eu-ai-act#Article12`]: { label: 'Article 12 — Record-keeping', type: 'owl named individual' },
  [`${SUBSTRATE_NS}eu-ai-act#Article14`]: { label: 'Article 14 — Human oversight', type: 'owl named individual' },
  [`${SUBSTRATE_NS}eu-ai-act#Article15`]: { label: 'Article 15 — Accuracy, robustness and cybersecurity', type: 'owl named individual' },
  [`${SUBSTRATE_NS}eu-ai-act#AccuracyAttestation`]: { label: 'Accuracy + robustness attestation (Article 15)', type: 'owl class' },
  [`${SUBSTRATE_NS}eu-ai-act#Article50Disclosure`]: { label: 'Article 50 disclosure', type: 'owl class' },
  [`${SUBSTRATE_NS}eu-ai-act#DataGovernanceAttestation`]: { label: 'Data governance attestation (Article 10)', type: 'owl class' },
  [`${SUBSTRATE_NS}eu-ai-act#HumanOversightCheckpoint`]: { label: 'Human oversight checkpoint (Article 14)', type: 'owl class' },
  [`${SUBSTRATE_NS}eu-ai-act#LoggedAction`]: { label: 'Logged action (Article 12)', type: 'owl class' },
  [`${SUBSTRATE_NS}eu-ai-act#RiskManagementRecord`]: { label: 'Risk management record (Article 9)', type: 'owl class' },
  [`${SUBSTRATE_NS}eu-ai-act#TransparencyDisclosure`]: { label: 'Transparency disclosure (Article 13)', type: 'owl class' },
  [`${SUBSTRATE_NS}nist-rmf#Govern`]: { label: 'GOVERN function', type: 'owl class' },
  [`${SUBSTRATE_NS}nist-rmf#Map`]: { label: 'MAP function', type: 'owl class' },
  [`${SUBSTRATE_NS}nist-rmf#Measure`]: { label: 'MEASURE function', type: 'owl class' },
  [`${SUBSTRATE_NS}nist-rmf#Manage`]: { label: 'MANAGE function', type: 'owl class' },
  [`${SUBSTRATE_NS}nist-rmf#contributesTo`]: { label: 'contributes evidence to', type: 'owl object property' },
});

const ADL_KIND_TYPE: Readonly<Record<AdlXapiKind, SssomEntityType>> = {
  class: 'owl class', object: 'owl object property', datatype: 'owl data property', annotation: 'owl annotation property',
};

/** A Foxxi document: its self-description, its graph, and the ontology it is aligned to, if any. */
interface FoxxiDocument {
  readonly meta: () => DocMeta;
  readonly graph: () => Graph;
  readonly counterpart?: OntologyModel['counterpart'];
}

const modelDocument = (m: OntologyModel): FoxxiDocument => ({ meta: () => docMeta(m), graph: () => ontologyGraph(m), counterpart: m.counterpart });

/** Every Foxxi ontology document, by the path segment it is served at. */
const DOCUMENTS: Readonly<Record<string, FoxxiDocument>> = Object.freeze({
  ...Object.fromEntries([...Object.values(SPEC_MODELS), ...Object.values(COMPLIANCE_MODELS), OB3_MODEL, CLR_MODEL]
    .map(m => [m.module, modelDocument(m)])),
  'ieee-ler': { meta: () => semDocMeta('ler'), graph: () => semOntologyGraph('ler') },
  'adl-tla': { meta: () => semDocMeta('tla'), graph: () => semOntologyGraph('tla') },
  foxxi: { meta: foxxiDocMeta, graph: vocabGraph },
});

const graphs = new Map<string, Graph>();
const graphOf = (module: string): Graph => {
  let g = graphs.get(module);
  if (!g) { g = DOCUMENTS[module]!.graph(); graphs.set(module, g); }
  return g;
};

/** What is on record about a mapping target: see the header. */
export function mappingTargetInfo(target: string): MappingTargetInfo | undefined {
  const adl = adlXapiTerm(target);
  if (adl) return { label: adl.label, type: ADL_KIND_TYPE[adl.kind] };
  const substrate = SUBSTRATE_TARGETS[target];
  if (substrate) return substrate;
  for (const [module, doc] of Object.entries(DOCUMENTS)) {
    const ns = doc.meta().ns;
    if (!ns || !target.startsWith(ns)) continue;
    const g = graphOf(module);
    const label = labelIn(g, target);
    const type = entityTypeIn(g, target);
    return label || type ? { ...(label ? { label } : {}), ...(type ? { type } : {}) } : undefined;
  }
  return undefined;
}

/** The documents that publish a mapping set: those any of whose terms map to another vocabulary. */
export function mappingSetModules(): string[] {
  return Object.keys(DOCUMENTS).filter(module => {
    const ns = DOCUMENTS[module]!.meta().ns;
    return !!ns && hasMappings(graphOf(module), ns);
  });
}

/**
 * The SSSOM/TSV mapping set of a document, or null if it publishes none. `model` is the live model
 * for a standards module (the bridge serves the PGSL holon's read-back), defaulting to the source.
 */
export function renderMappingSet(module: string, model?: OntologyModel): string | null {
  const doc = model ? modelDocument(model) : DOCUMENTS[module];
  if (!doc) return null;
  const meta = doc.meta();
  const graph = model ? doc.graph() : graphOf(module);
  if (!meta.ns || !hasMappings(graph, meta.ns)) return null;
  return renderSssomTsv({
    meta, graph, prefixes: MAPPING_SET_PREFIXES, lookup: mappingTargetInfo,
    ...(doc.counterpart ? { counterpart: doc.counterpart } : {}),
  });
}

/**
 * Answer GET <document>/mappings: the mapping set as SSSOM/TSV (negotiated, so a client that accepts
 * nothing of the kind gets a 406), or a 404 for a document that maps no terms.
 */
export function sendMappingSet(req: NegotiableRequest, res: NegotiableResponse, module: string, model?: OntologyModel): void {
  const doc = model ? modelDocument(model) : DOCUMENTS[module];
  const tsv = renderMappingSet(module, model);
  if (!doc || tsv === null) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.status(404).type('application/json').send(JSON.stringify({ error: `the ${module} ontology maps none of its terms to another vocabulary, so it publishes no mapping set` }));
    return;
  }
  const docIri = doc.meta().iri;
  sendNegotiated(req, res, mappingSetIri(docIri), [{ type: SSSOM_MEDIA_TYPE, body: () => tsv }], [`<${docIri}>; rel="related"`]);
}
