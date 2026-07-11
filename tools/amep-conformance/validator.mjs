import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import jsonld from 'jsonld';
import rdfCanonize from 'rdf-canonize';

export const PROFILE_IRI = 'https://markjspivey-xwisee.github.io/interego/profiles/affordant-memory/0.1';
export const PROFILE_NS = `${PROFILE_IRI}#`;
export const CONTEXT_IRI = `${PROFILE_IRI}/context.jsonld`;

const IEP_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const SH_NS = 'http://www.w3.org/ns/shacl#';
const PROV_NS = 'http://www.w3.org/ns/prov#';
const HYDRA_NS = 'http://www.w3.org/ns/hydra/core#';

const ACT_TYPES = new Set(['Ask', 'Assert', 'Challenge', 'Accept', 'Fork', 'Compose']);
const WRITE_ACTS = new Set(['Assert', 'Challenge', 'Accept', 'Fork', 'Compose']);
const CANDIDATE_ACTS = new Set(['Assert', 'Challenge', 'Fork', 'Compose']);
const MEMORY_KINDS = new Set(['Observation', 'Claim', 'Commitment', 'Procedure', 'ContextualUse']);
const GOVERNANCE_STATUSES = new Set(['Candidate', 'Committed', 'Superseded', 'Retracted', 'Expired', 'Redacted']);
const INTEGRITY_STATUSES = new Set(['Unverified', 'Verified']);
const CONFORMANCE_STATUSES = new Set(['Unchecked', 'Conformant', 'Nonconformant']);
const EPISTEMIC_STATUSES = new Set(['Asserted', 'Hypothetical', 'Counterfactual', 'Quoted', 'Retracted']);
const RECEIPT_OUTCOMES = new Set(['Applied', 'Rejected', 'Duplicate']);

const SEMANTIC_CID_RE = /^urn:cid:rdfc-1\.0:sha256:[0-9a-f]{64}$/;
const ENVELOPE_CID_RE = /^urn:cid:(?:raw|jose):sha256:[0-9a-f]{64}$/;
const ETAG_RE = /^"sha256-[0-9a-f]{64}"$/;
const IRI_RE = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s]+$/;

const ACTION_INPUT_SHAPES = {
  Ask: 'AskInputShape',
  Assert: 'AssertInputShape',
  Challenge: 'ChallengeInputShape',
  Accept: 'AcceptInputShape',
  Fork: 'ForkInputShape',
  Compose: 'ComposeInputShape',
};

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function localName(value, namespace = PROFILE_NS) {
  if (typeof value !== 'string') return null;
  if (value.startsWith('amep:')) return value.slice('amep:'.length);
  if (value.startsWith(namespace)) return value.slice(namespace.length);
  if (namespace === IEP_NS && value.startsWith('iep:')) return value.slice('iep:'.length);
  return null;
}

function typeIncludes(node, type) {
  return asArray(node?.['@type']).includes(type)
    || asArray(node?.['@type']).includes(`${PROFILE_NS}${type}`)
    || asArray(node?.['@type']).some(value => localName(value) === type);
}

function isIri(value) {
  return typeof value === 'string' && IRI_RE.test(value);
}

function isDateTime(value) {
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)
    && !Number.isNaN(Date.parse(value));
}

function sortedCanonical(value) {
  if (Array.isArray(value)) return value.map(sortedCanonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, sortedCanonical(value[key])]),
  );
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function parseAym(source, filename = '<input>') {
  let document;
  try {
    document = yaml.load(source, {
      filename,
      schema: yaml.JSON_SCHEMA,
    });
  } catch (error) {
    const wrapped = new Error(`YAML parse failed for ${filename}: ${error.message}`);
    wrapped.cause = error;
    throw wrapped;
  }
  if (!isObject(document)) {
    throw new Error(`YAML root in ${filename} MUST be a mapping`);
  }
  return document;
}

export function computeRepresentationTag(document) {
  const projection = clone(document);
  delete projection.representationTag;
  return `"sha256-${sha256(JSON.stringify(sortedCanonical(projection)))}"`;
}

function withLocalContext(document, contextDocument) {
  const copy = clone(document);
  copy['@context'] = clone(contextDocument['@context']);
  return copy;
}

export async function expandAym(document, contextDocument) {
  return jsonld.expand(withLocalContext(document, contextDocument));
}

export async function toCanonicalNQuads(document, contextDocument) {
  const nquads = await jsonld.toRDF(withLocalContext(document, contextDocument), {
    format: 'application/n-quads',
  });
  return rdfCanonize.canonize(nquads, {
    algorithm: 'RDFC-1.0',
    inputFormat: 'application/n-quads',
    format: 'application/n-quads',
    maxWorkFactor: 1,
  });
}

export async function computeSemanticCid(document, contextDocument) {
  if (!isObject(document?.memory?.semantic)) {
    throw new Error('memory.semantic is required to compute semanticCid');
  }
  const semanticDocument = {
    '@context': clone(contextDocument['@context']),
    ...clone(document.memory.semantic),
  };
  const nquads = await jsonld.toRDF(semanticDocument, {
    format: 'application/n-quads',
  });
  const canonical = await rdfCanonize.canonize(nquads, {
    algorithm: 'RDFC-1.0',
    inputFormat: 'application/n-quads',
    format: 'application/n-quads',
    maxWorkFactor: 1,
  });
  return `urn:cid:rdfc-1.0:sha256:${sha256(canonical)}`;
}

function result(shape, focusNode, path, message, value) {
  const out = {
    '@type': 'sh:ValidationResult',
    'sh:focusNode': focusNode ?? 'urn:amep:unknown',
    'sh:resultPath': path,
    'sh:sourceShape': `amep:${shape}`,
    'sh:resultSeverity': 'sh:Violation',
    'sh:resultMessage': message,
  };
  if (value !== undefined) out['sh:value'] = value;
  return out;
}

function report(violations) {
  return {
    '@context': {
      sh: SH_NS,
      amep: PROFILE_NS,
    },
    '@type': 'sh:ValidationReport',
    'sh:conforms': violations.length === 0,
    'sh:result': violations,
  };
}

function validateProof(proof, focus, violations) {
  if (!isObject(proof)) {
    violations.push(result('ProofShape', focus, 'iep:proof', 'Every submitted act MUST carry one proof object.'));
    return;
  }
  if (!isIri(proof.verificationMethod)) {
    violations.push(result('ProofShape', focus, 'iep:verificationMethod', 'proof.verificationMethod MUST be an IRI.', proof.verificationMethod));
  }
  if (typeof proof.proofValue !== 'string' || proof.proofValue.trim().length === 0) {
    violations.push(result('ProofShape', focus, 'iep:proofValue', 'proof.proofValue MUST be a non-empty string.', proof.proofValue));
  }
  if (!isDateTime(proof.created)) {
    violations.push(result('ProofShape', focus, 'iep:created', 'proof.created MUST be an ISO 8601 UTC date-time.', proof.created));
  }
}

function validateAffordances(document, violations) {
  const affordances = asArray(document.affordances);
  for (const [index, affordance] of affordances.entries()) {
    const focus = affordance?.['@id'] ?? `${document['@id'] ?? 'urn:amep:exchange'}#affordance-${index}`;
    if (!isObject(affordance)) {
      violations.push(result('AffordanceContractShape', focus, 'iep:affordance', 'Every affordance MUST be a mapping.'));
      continue;
    }
    const affordanceTypes = asArray(affordance['@type']);
    const isIepAffordance = affordanceTypes.includes('iep:Affordance')
      || affordanceTypes.includes(`${IEP_NS}Affordance`);
    const isHydraOperation = affordanceTypes.includes('hydra:Operation')
      || affordanceTypes.includes(`${HYDRA_NS}Operation`);
    if (!isIepAffordance || !isHydraOperation) {
      violations.push(result('AffordanceContractShape', focus, 'rdf:type', 'Every control MUST be typed iep:Affordance and hydra:Operation.', affordance['@type']));
    }
    const action = localName(affordance.action);
    if (!ACT_TYPES.has(action)) {
      violations.push(result('AffordanceContractShape', focus, 'iep:action', 'Affordance action MUST be an AMEP act IRI.', affordance.action));
    }
    if (!isIri(affordance.target)) {
      violations.push(result('AffordanceContractShape', focus, 'hydra:target', 'Affordance target MUST be an IRI.', affordance.target));
    }
    if (typeof affordance.method !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(affordance.method)) {
      violations.push(result('AffordanceContractShape', focus, 'hydra:method', 'Affordance method MUST be a supported uppercase HTTP method.', affordance.method));
    }
    const expectedInput = ACTION_INPUT_SHAPES[action];
    if (expectedInput && localName(affordance.inputShape) !== expectedInput) {
      violations.push(result('AffordanceContractShape', focus, 'amep:inputShape', `The ${action} action MUST reference amep:${expectedInput}.`, affordance.inputShape));
    }
    if (typeof affordance.effect !== 'string' || affordance.effect.trim().length === 0) {
      violations.push(result('AffordanceContractShape', focus, 'amep:effect', 'Affordance effect MUST be a non-empty string.', affordance.effect));
    }
  }
}

function validateReceipts(document, actName, violations) {
  const act = document.act;
  const actId = act?.['@id'];
  for (const [index, receipt] of asArray(document.receipts).entries()) {
    const focus = receipt?.['@id'] ?? `${document['@id'] ?? 'urn:amep:exchange'}#receipt-${index}`;
    if (!isObject(receipt)) {
      violations.push(result('ReceiptShape', focus, 'amep:receipt', 'Every receipt MUST be a mapping.'));
      continue;
    }
    if (!typeIncludes(receipt, 'Receipt')) {
      violations.push(result('ReceiptShape', focus, 'rdf:type', 'Receipt MUST be typed amep:Receipt.', receipt['@type']));
    }
    if (!isIri(receipt.receiptFor) || receipt.receiptFor !== actId) {
      violations.push(result('ReceiptShape', focus, 'amep:receiptFor', 'receiptFor MUST equal the enclosed act @id.', receipt.receiptFor));
    }
    const outcome = localName(receipt.outcome);
    if (!RECEIPT_OUTCOMES.has(outcome)) {
      violations.push(result('ReceiptShape', focus, 'amep:outcome', 'Receipt outcome MUST be Applied, Rejected, or Duplicate.', receipt.outcome));
    }
    if (!isDateTime(receipt.generatedAt)) {
      violations.push(result('ReceiptShape', focus, 'prov:generatedAtTime', 'Receipt generatedAt MUST be an ISO 8601 UTC date-time.', receipt.generatedAt));
    }
    if (!isObject(receipt.validationReport) || receipt.validationReport.conforms !== (outcome !== 'Rejected')) {
      violations.push(result('ReceiptShape', focus, 'amep:validationReport', 'Receipt MUST carry a validation report whose conforms value matches the outcome.', receipt.validationReport));
    }
    if (outcome === 'Applied') {
      if (!isIri(receipt.resultHead)) {
        violations.push(result('ReceiptShape', focus, 'amep:resultHead', 'An Applied receipt MUST identify resultHead.', receipt.resultHead));
      }
      if (WRITE_ACTS.has(actName) && receipt.previousHead !== act.expectedHead) {
        violations.push(result('ReceiptShape', focus, 'amep:previousHead', 'Applied receipt previousHead MUST equal act.expectedHead.', receipt.previousHead));
      }
      if (document.head !== receipt.resultHead) {
        violations.push(result('ReceiptShape', focus, 'amep:resultHead', 'Exchange head MUST equal the Applied receipt resultHead.', receipt.resultHead));
      }
    }
  }
}

async function validateMemory(document, actName, contextDocument, violations) {
  const memory = document.memory;
  if (memory === undefined) {
    if (actName !== 'Ask') {
      violations.push(result('MemoryRecordShape', document['@id'], 'amep:memory', `${actName} MUST project one memory record.`));
    }
    return;
  }
  const focus = memory?.['@id'] ?? `${document['@id'] ?? 'urn:amep:exchange'}#memory`;
  if (!isObject(memory)) {
    violations.push(result('MemoryRecordShape', focus, 'amep:memory', 'memory MUST be a mapping.'));
    return;
  }
  if (!typeIncludes(memory, 'MemoryRecord')) {
    violations.push(result('MemoryRecordShape', focus, 'rdf:type', 'memory MUST be typed amep:MemoryRecord.', memory['@type']));
  }
  if (!isIri(memory['@id'])) {
    violations.push(result('MemoryRecordShape', focus, '@id', 'Memory logical @id MUST be an IRI.', memory['@id']));
  }
  const kind = localName(memory.memoryKind);
  if (!MEMORY_KINDS.has(kind)) {
    violations.push(result('MemoryRecordShape', focus, 'amep:memoryKind', 'memoryKind is outside the AMEP closed set.', memory.memoryKind));
  }
  const governance = localName(memory.governanceStatus);
  if (!GOVERNANCE_STATUSES.has(governance)) {
    violations.push(result('MemoryRecordShape', focus, 'amep:governanceStatus', 'governanceStatus is outside the AMEP lifecycle.', memory.governanceStatus));
  }
  if (!INTEGRITY_STATUSES.has(localName(memory.integrityStatus))) {
    violations.push(result('MemoryRecordShape', focus, 'amep:integrityStatus', 'integrityStatus MUST be Unverified or Verified.', memory.integrityStatus));
  }
  if (!CONFORMANCE_STATUSES.has(localName(memory.conformanceStatus))) {
    violations.push(result('MemoryRecordShape', focus, 'amep:conformanceStatus', 'conformanceStatus MUST be Unchecked, Conformant, or Nonconformant.', memory.conformanceStatus));
  }
  if (!SEMANTIC_CID_RE.test(memory.semanticCid ?? '')) {
    violations.push(result('MemoryRecordShape', focus, 'amep:semanticCid', 'semanticCid has the wrong identifier form.', memory.semanticCid));
  }
  if (memory.semanticCid === memory['@id'] || memory.semanticCid === document.representationTag || memory.semanticCid === document.envelopeCid) {
    violations.push(result('IdentifierSeparationShape', focus, 'amep:semanticCid', 'Logical IRI, semantic CID, representation tag, and envelope CID MUST remain distinct.', memory.semanticCid));
  }
  if (!isObject(memory.semantic) || !typeIncludes(memory.semantic, 'SemanticMaterial')) {
    violations.push(result('MemoryRecordShape', focus, 'amep:semantic', 'memory.semantic MUST be typed amep:SemanticMaterial.', memory.semantic));
  } else {
    if (typeof memory.semantic.body !== 'string' || memory.semantic.body.trim().length === 0) {
      violations.push(result('MemoryRecordShape', focus, 'rdf:value', 'Semantic material MUST carry non-empty Markdown body text.', memory.semantic.body));
    }
    if (!EPISTEMIC_STATUSES.has(localName(memory.semantic.epistemicStatus, IEP_NS))) {
      violations.push(result('MemoryRecordShape', focus, 'amep:epistemicStatus', 'epistemicStatus MUST use an Interego modal-status IRI.', memory.semantic.epistemicStatus));
    }
    if (!isIri(memory.semantic.attributedTo)) {
      violations.push(result('MemoryRecordShape', focus, 'prov:wasAttributedTo', 'Semantic material MUST identify its attributed agent.', memory.semantic.attributedTo));
    }
  }

  if (CANDIDATE_ACTS.has(actName) && governance !== 'Candidate') {
    violations.push(result('LifecycleTransitionShape', focus, 'amep:governanceStatus', `${actName} produces Candidate memory; a receipt cannot auto-commit it.`, memory.governanceStatus));
  }
  const applied = asArray(document.receipts).some(receipt => localName(receipt?.outcome) === 'Applied');
  if (actName === 'Accept' && applied && governance !== 'Committed') {
    violations.push(result('LifecycleTransitionShape', focus, 'amep:governanceStatus', 'An Applied Accept MUST project Committed memory.', memory.governanceStatus));
  }

  if (kind === 'ContextualUse') {
    const reused = memory.semantic?.reuses;
    if (!SEMANTIC_CID_RE.test(memory.reusedSemanticCid ?? '')
        || !isObject(reused)
        || !isIri(reused['@id'])
        || reused.semanticCid !== memory.reusedSemanticCid) {
      violations.push(result('ContextualUseShape', focus, 'amep:reusedSemanticCid', 'ContextualUse MUST preserve and repeat the reused record semanticCid.', memory.reusedSemanticCid));
    }
    if (typeof memory.semantic?.interpretation !== 'string' || memory.semantic.interpretation.trim().length === 0) {
      violations.push(result('ContextualUseShape', focus, 'amep:interpretation', 'ContextualUse MUST state the new interpretation.', memory.semantic?.interpretation));
    }
  }

  if (isObject(memory.semantic)) {
    try {
      const expectedCid = await computeSemanticCid(document, contextDocument);
      if (memory.semanticCid !== expectedCid) {
        violations.push(result('SemanticCidShape', focus, 'amep:semanticCid', `semanticCid does not match the RDFC-1.0 projection; expected ${expectedCid}.`, memory.semanticCid));
      }
    } catch (error) {
      violations.push(result('SemanticCidShape', focus, 'amep:semanticCid', `Unable to canonicalize semantic material: ${error.message}`));
    }
  }
}

export async function validateDocument(document, contextDocument, { validateHashes = true } = {}) {
  const violations = [];
  const focus = document?.['@id'] ?? 'urn:amep:unknown';

  const contexts = asArray(document?.['@context']);
  if (!contexts.includes(CONTEXT_IRI)) {
    violations.push(result('ExchangeShape', focus, '@context', `@context MUST include ${CONTEXT_IRI}.`, document?.['@context']));
  }
  if (!typeIncludes(document, 'Exchange')) {
    violations.push(result('ExchangeShape', focus, 'rdf:type', 'Root MUST be typed amep:Exchange.', document?.['@type']));
  }
  if (!isIri(document?.['@id'])) {
    violations.push(result('ExchangeShape', focus, '@id', 'Exchange @id MUST be an IRI.', document?.['@id']));
  }
  if (document?.profile !== PROFILE_IRI) {
    violations.push(result('ExchangeShape', focus, 'dct:conformsTo', `profile MUST equal ${PROFILE_IRI}.`, document?.profile));
  }
  const actor = document?.actor;
  if (!isObject(actor) || !isIri(actor['@id'])) {
    violations.push(result('ExchangeShape', focus, 'amep:actor', 'actor MUST be a node object with an IRI @id.', actor));
  } else {
    const actorTypes = asArray(actor['@type']);
    if (!actorTypes.includes('prov:Person') && !actorTypes.includes(`${PROV_NS}Person`)
        && !actorTypes.includes('prov:SoftwareAgent') && !actorTypes.includes(`${PROV_NS}SoftwareAgent`)) {
      violations.push(result('ExchangeShape', actor['@id'], 'rdf:type', 'actor MUST be prov:Person or prov:SoftwareAgent.', actor['@type']));
    }
  }

  const act = document?.act;
  let actName = null;
  if (!isObject(act)) {
    violations.push(result('ProtocolActShape', focus, 'amep:act', 'act MUST be a mapping.'));
  } else {
    const actFocus = act['@id'] ?? `${focus}#act`;
    if (!typeIncludes(act, 'ProtocolAct')) {
      violations.push(result('ProtocolActShape', actFocus, 'rdf:type', 'act MUST be typed amep:ProtocolAct.', act['@type']));
    }
    if (!isIri(act['@id'])) {
      violations.push(result('ProtocolActShape', actFocus, '@id', 'act @id MUST be an IRI.', act['@id']));
    }
    actName = localName(act.actType);
    if (!ACT_TYPES.has(actName)) {
      violations.push(result('ProtocolActShape', actFocus, 'amep:actType', 'actType is outside the AMEP closed set.', act.actType));
    }
    if (act.actor !== actor?.['@id']) {
      violations.push(result('ActorIdentityShape', actFocus, 'amep:actor', 'Exchange actor and act actor MUST be the same IRI.', act.actor));
    }
    if (!isDateTime(act.createdAt)) {
      violations.push(result('ProtocolActShape', actFocus, 'prov:startedAtTime', 'act.createdAt MUST be an ISO 8601 UTC date-time.', act.createdAt));
    }
    validateProof(act.proof, actFocus, violations);
    if (WRITE_ACTS.has(actName) && !isIri(act.expectedHead)) {
      violations.push(result('ExpectedHeadShape', actFocus, 'amep:expectedHead', `${actName} MUST declare an expectedHead IRI.`, act.expectedHead));
    }
    if (actName === 'Challenge' && !isIri(act.challengedAct)) {
      violations.push(result('ChallengeInputShape', actFocus, 'amep:challengedAct', 'Challenge MUST identify challengedAct.', act.challengedAct));
    }
    if (actName === 'Accept' && !isIri(act.acceptedAct)) {
      violations.push(result('AcceptInputShape', actFocus, 'amep:acceptedAct', 'Accept MUST identify acceptedAct.', act.acceptedAct));
    }
    if (actName === 'Fork') {
      if (!isIri(act.parentHead)) violations.push(result('ForkInputShape', actFocus, 'amep:parentHead', 'Fork MUST identify parentHead.', act.parentHead));
      if (typeof act.branch !== 'string' || act.branch.trim().length === 0) violations.push(result('ForkInputShape', actFocus, 'amep:branch', 'Fork MUST carry a non-empty branch label.', act.branch));
    }
    if (actName === 'Compose') {
      const operands = asArray(act.operands);
      const unique = [...new Set(operands)];
      const sorted = [...unique].sort();
      if (operands.length < 2 || unique.length !== operands.length || operands.some(value => !isIri(value))) {
        violations.push(result('ComposeInputShape', actFocus, 'amep:operand', 'Compose MUST carry at least two unique operand IRIs.', act.operands));
      } else if (JSON.stringify(operands) !== JSON.stringify(sorted)) {
        violations.push(result('DeterministicComposeShape', actFocus, 'amep:operand', 'Compose operands MUST be lexicographically sorted for deterministic replay.', act.operands));
      }
    }
  }

  if (!isIri(document?.head)) {
    violations.push(result('ExchangeShape', focus, 'amep:head', 'Exchange head MUST be an IRI.', document?.head));
  }
  if (!ETAG_RE.test(document?.representationTag ?? '')) {
    violations.push(result('ExchangeShape', focus, 'amep:representationTag', 'representationTag has the wrong strong-ETag form.', document?.representationTag));
  } else if (validateHashes) {
    const expectedTag = computeRepresentationTag(document);
    if (document.representationTag !== expectedTag) {
      violations.push(result('RepresentationTagShape', focus, 'amep:representationTag', `representationTag does not match the canonical projection; expected ${expectedTag}.`, document.representationTag));
    }
  }
  if (document?.envelopeCid !== undefined && !ENVELOPE_CID_RE.test(document.envelopeCid)) {
    violations.push(result('IdentifierSeparationShape', focus, 'amep:envelopeCid', 'envelopeCid has the wrong identifier form.', document.envelopeCid));
  }

  await validateMemory(document, actName, contextDocument, violations);
  validateReceipts(document, actName, violations);
  validateAffordances(document, violations);

  try {
    await expandAym(document, contextDocument);
    await toCanonicalNQuads(document, contextDocument);
  } catch (error) {
    violations.push(result('YamlLdExpansionShape', focus, '@context', `YAML-LD did not expand and canonicalize: ${error.message}`));
  }

  return report(violations);
}

export async function validateSource(source, contextDocument, options = {}) {
  let document;
  try {
    document = parseAym(source, options.filename);
  } catch (error) {
    return report([
      result('YamlSyntaxShape', options.filename ?? 'urn:amep:input', '@context', error.message),
    ]);
  }
  return validateDocument(document, contextDocument, options);
}

export function actionContract(document) {
  return asArray(document?.affordances)
    .map(affordance => ({
      action: affordance?.action,
      method: affordance?.method,
      target: affordance?.target,
      inputShape: affordance?.inputShape,
      effect: affordance?.effect,
    }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function validateProblem(problem, contract) {
  const failures = [];
  if (!isObject(problem)) return ['Problem fixture MUST be a JSON object.'];
  if (problem.status !== contract.status) failures.push(`expected status ${contract.status}, got ${problem.status}`);
  for (const key of contract.required ?? []) {
    if (!(key in problem)) failures.push(`missing required field: ${key}`);
  }
  for (const key of contract.forbidden ?? []) {
    if (key in problem) failures.push(`forbidden leakage field present: ${key}`);
  }
  return failures;
}
