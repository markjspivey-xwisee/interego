#!/usr/bin/env tsx
/**
 * Build xAPI Ontology in PGSL — Using System Affordances
 *
 * Instead of dumping pre-formatted strings, this script:
 *   1. Ingests individual atoms (terms)
 *   2. Composes them into chains via ingest-uris (the API equivalent of clicking +)
 *   3. Structure emerges from composition — shared atoms are content-addressed
 *
 * This is what a human or agent would do through the browser UI,
 * just automated. Every step uses the same endpoints the UI uses.
 */

const BASE = process.env['BASE'] ?? 'http://localhost:5000';

// ── Atom cache: term → URI ──────────────────────────────
const atomCache = new Map<string, string>();

/** Ensure an atom exists, return its URI */
async function atom(value: string): Promise<string> {
  const cached = atomCache.get(value);
  if (cached) return cached;

  const r = await fetch(`${BASE}/api/ingest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: value, granularity: 'word' }),
  });
  const data = await r.json();
  // For single-word ingestion, the atom URI is in the nodes
  // But we need the atom URI, not the L1 wrapper
  const allResp = await fetch(`${BASE}/api/all`);
  const allData = await allResp.json();
  const atomNode = allData.nodes.find((n: any) => n.resolved === value && n.level === 0);
  if (atomNode) {
    atomCache.set(value, atomNode.uri);
    return atomNode.uri;
  }
  // Fallback: return the ingested URI
  atomCache.set(value, data.uri);
  return data.uri;
}

/** Compose a chain from atom values — the + button equivalent */
async function chain(...values: string[]): Promise<string> {
  const uris: string[] = [];
  for (const v of values) {
    uris.push(await atom(v));
  }

  if (uris.length < 2) return uris[0]!;

  const r = await fetch(`${BASE}/api/ingest-uris`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris }),
  });
  const data = await r.json();
  return data.uri;
}

/** Compose a chain from already-resolved URIs (for nesting) */
async function chainUris(...uris: string[]): Promise<string> {
  if (uris.length < 2) return uris[0]!;

  const r = await fetch(`${BASE}/api/ingest-uris`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uris }),
  });
  const data = await r.json();
  return data.uri;
}

// ═══════════════════════════════════════════════════════════
// Build the ontology by composing atoms into chains
// ═══════════════════════════════════════════════════════════

async function main() {
  // Wipe
  await fetch(`${BASE}/api/rebuild`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  console.log('Building xAPI ontology using system affordances...\n');

  // ── Step 1: Seed all atoms ────────────────────────────
  // These are the vocabulary terms. Each one is an atom.
  console.log('  Seeding atoms...');

  const terms = [
    // Namespace prefixes (used as chain heads)
    'xapi', 'rdf', 'rdfs', 'owl', 'xsd', 'sh', 'adl', 'cmi5',
    // Predicates
    'type', 'subClassOf', 'domain', 'range', 'subPropertyOf',
    'minCardinality', 'maxCardinality', 'restriction',
    'exactlyOneOf', 'complementOf',
    'targetClass', 'property', 'datatype', 'class',
    'minCount', 'maxCount', 'pattern', 'minInclusive', 'maxInclusive',
    'comment',
    // xAPI classes
    'Statement', 'Actor', 'Agent', 'Group',
    'IdentifiedGroup', 'AnonymousGroup',
    'Verb', 'Object', 'Activity', 'StatementRef', 'SubStatement',
    'Result', 'Score', 'Context', 'ContextActivities',
    'ActivityDefinition', 'InteractionComponent',
    'Attachment', 'Extensions', 'Account', 'LanguageMap',
    'Class', 'ObjectProperty', 'DatatypeProperty',
    'InverseFunctionalProperty',
    // xAPI properties
    'actor', 'verb', 'object', 'result', 'context',
    'timestamp', 'stored', 'authority', 'version', 'attachments',
    'id', 'display', 'name', 'description', 'definition',
    'mbox', 'mbox_sha1sum', 'openid', 'account', 'member',
    'homePage', 'objectType',
    'score', 'success', 'completion', 'response', 'duration', 'extensions',
    'scaled', 'raw', 'min', 'max',
    'registration', 'instructor', 'team', 'contextActivities',
    'revision', 'platform', 'language', 'statement',
    'parent', 'grouping', 'category', 'other',
    'usageType', 'contentType', 'length', 'sha2', 'fileUrl',
    'interactionType', 'correctResponsesPattern',
    'choices', 'source', 'target', 'steps', 'moreInfo',
    // XSD types
    'string', 'boolean', 'integer', 'decimal', 'dateTime',
    'anyURI',
    // Interaction types
    'true-false', 'choice', 'fill-in', 'long-fill-in',
    'matching', 'performance', 'sequencing', 'likert', 'numeric',
    // ADL verbs
    'completed', 'attempted', 'passed', 'failed', 'experienced',
    'answered', 'interacted', 'launched', 'shared', 'voided',
    'registered', 'progressed', 'initialized', 'terminated',
    'suspended', 'resumed', 'mastered', 'scored',
    // cmi5
    'abandoned', 'waived', 'satisfied',
    'AssignableUnit', 'Block', 'Course',
    'moveOn', 'launchMode', 'masteryScore',
    'Normal', 'Browse', 'Review',
    'Completed', 'Passed', 'CompletedAndPassed',
    'CompletedOrPassed', 'NotApplicable',
  ];

  for (const t of terms) {
    await atom(t);
  }
  console.log(`    ${terms.length} atoms seeded\n`);

  // ── Step 2: Class hierarchy ───────────────────────────
  // Build chains: (subject, predicate, object)
  // e.g., (Statement, type, Class) means "Statement is a Class"
  console.log('  Building class hierarchy...');

  const classDeclarations = [
    ['Statement', 'type', 'Class'],
    ['Actor', 'type', 'Class'],
    ['Verb', 'type', 'Class'],
    ['Object', 'type', 'Class'],
    ['Result', 'type', 'Class'],
    ['Score', 'type', 'Class'],
    ['Context', 'type', 'Class'],
    ['ContextActivities', 'type', 'Class'],
    ['ActivityDefinition', 'type', 'Class'],
    ['InteractionComponent', 'type', 'Class'],
    ['Attachment', 'type', 'Class'],
    ['Extensions', 'type', 'Class'],
    ['Account', 'type', 'Class'],
    ['LanguageMap', 'type', 'Class'],
  ];

  const subclasses = [
    ['Agent', 'subClassOf', 'Actor'],
    ['Group', 'subClassOf', 'Actor'],
    ['IdentifiedGroup', 'subClassOf', 'Group'],
    ['AnonymousGroup', 'subClassOf', 'Group'],
    ['Activity', 'subClassOf', 'Object'],
    ['StatementRef', 'subClassOf', 'Object'],
    ['SubStatement', 'subClassOf', 'Object'],
  ];

  for (const [s, p, o] of classDeclarations) {
    await chain(s!, p!, o!);
  }
  for (const [s, p, o] of subclasses) {
    await chain(s!, p!, o!);
  }
  console.log(`    ${classDeclarations.length} class declarations`);
  console.log(`    ${subclasses.length} subclass relationships\n`);

  // ── Step 3: Properties with domain/range ──────────────
  // Build as: (propertyName, domain, ClassName, range, TypeName)
  // This creates chains where "domain" and "range" are shared atoms
  console.log('  Building property definitions...');

  const objectProperties: [string, string, string][] = [
    // Statement properties
    ['actor', 'Statement', 'Actor'],
    ['verb', 'Statement', 'Verb'],
    ['object', 'Statement', 'Object'],
    ['result', 'Statement', 'Result'],
    ['context', 'Statement', 'Context'],
    ['authority', 'Statement', 'Agent'],
    ['attachments', 'Statement', 'Attachment'],
    // Actor properties
    ['account', 'Agent', 'Account'],
    ['member', 'Group', 'Agent'],
    // Object properties
    ['definition', 'Activity', 'ActivityDefinition'],
    ['choices', 'ActivityDefinition', 'InteractionComponent'],
    ['source', 'ActivityDefinition', 'InteractionComponent'],
    ['target', 'ActivityDefinition', 'InteractionComponent'],
    ['steps', 'ActivityDefinition', 'InteractionComponent'],
    // Result properties
    ['score', 'Result', 'Score'],
    // Context properties
    ['instructor', 'Context', 'Agent'],
    ['team', 'Context', 'Group'],
    ['contextActivities', 'Context', 'ContextActivities'],
    ['statement', 'Context', 'StatementRef'],
    ['parent', 'ContextActivities', 'Activity'],
    ['grouping', 'ContextActivities', 'Activity'],
    ['category', 'ContextActivities', 'Activity'],
    ['other', 'ContextActivities', 'Activity'],
  ];

  const datatypeProperties: [string, string, string][] = [
    ['timestamp', 'Statement', 'dateTime'],
    ['stored', 'Statement', 'dateTime'],
    ['version', 'Statement', 'string'],
    ['id', 'Statement', 'string'],
    ['name', 'Agent', 'string'],
    ['objectType', 'Actor', 'string'],
    ['homePage', 'Account', 'anyURI'],
    ['display', 'Verb', 'LanguageMap'],
    ['interactionType', 'ActivityDefinition', 'string'],
    ['moreInfo', 'ActivityDefinition', 'anyURI'],
    ['success', 'Result', 'boolean'],
    ['completion', 'Result', 'boolean'],
    ['response', 'Result', 'string'],
    ['duration', 'Result', 'string'],
    ['scaled', 'Score', 'decimal'],
    ['raw', 'Score', 'decimal'],
    ['min', 'Score', 'decimal'],
    ['max', 'Score', 'decimal'],
    ['registration', 'Context', 'string'],
    ['platform', 'Context', 'string'],
    ['language', 'Context', 'string'],
    ['usageType', 'Attachment', 'anyURI'],
    ['contentType', 'Attachment', 'string'],
    ['length', 'Attachment', 'integer'],
    ['sha2', 'Attachment', 'string'],
    ['fileUrl', 'Attachment', 'anyURI'],
  ];

  const ifiProperties = ['mbox', 'mbox_sha1sum', 'openid', 'account'];

  for (const [prop, dom, rng] of objectProperties) {
    await chain(prop!, 'domain', dom!, 'range', rng!);
    await chain(prop!, 'type', 'ObjectProperty');
  }
  for (const [prop, dom, rng] of datatypeProperties) {
    await chain(prop!, 'domain', dom!, 'range', rng!);
    await chain(prop!, 'type', 'DatatypeProperty');
  }
  for (const ifi of ifiProperties) {
    await chain(ifi, 'domain', 'Agent', 'range', 'anyURI');
    await chain(ifi, 'type', 'InverseFunctionalProperty');
  }
  console.log(`    ${objectProperties.length} object properties`);
  console.log(`    ${datatypeProperties.length} datatype properties`);
  console.log(`    ${ifiProperties.length} inverse functional properties\n`);

  // ── Step 4: Cardinality constraints ───────────────────
  // Build as: (ClassName, minCardinality, propertyName, count)
  console.log('  Building OWL constraints...');

  const requiredProps: [string, string][] = [
    ['Statement', 'actor'],
    ['Statement', 'verb'],
    ['Statement', 'object'],
    ['Verb', 'id'],
    ['Activity', 'id'],
    ['Account', 'homePage'],
    ['Account', 'name'],
  ];

  const optionalProps: [string, string][] = [
    ['Statement', 'result'],
    ['Statement', 'context'],
    ['Statement', 'authority'],
  ];

  for (const [cls, prop] of requiredProps) {
    await chain(cls!, 'minCardinality', prop!, '1');
    await chain(cls!, 'maxCardinality', prop!, '1');
  }
  for (const [cls, prop] of optionalProps) {
    await chain(cls!, 'maxCardinality', prop!, '1');
  }

  // Agent IFI constraint
  await chain('Agent', 'exactlyOneOf', 'mbox', 'mbox_sha1sum', 'openid', 'account');
  await chain('IdentifiedGroup', 'exactlyOneOf', 'mbox', 'mbox_sha1sum', 'openid', 'account');
  await chain('AnonymousGroup', 'minCardinality', 'member', '1');

  // Score range
  await chain('scaled', 'minInclusive', '-1');
  await chain('scaled', 'maxInclusive', '1');
  await chain('raw', 'restriction', 'min', 'max');

  // SubStatement nesting restriction
  await chain('SubStatement', 'restriction', 'object', 'complementOf', 'SubStatement');

  console.log(`    ${requiredProps.length} required property constraints`);
  console.log(`    ${optionalProps.length} optional property constraints`);
  console.log('    IFI, Score, SubStatement constraints\n');

  // ── Step 5: SHACL shapes ──────────────────────────────
  // Build as: (ShapeName, targetClass, ClassName)
  // and: (ShapeName, property, propName, constraint, value)
  console.log('  Building SHACL shapes...');

  const shapes: [string, string, [string, string, string][]][] = [
    ['StatementShape', 'Statement', [
      ['actor', 'minCount', '1'],
      ['actor', 'maxCount', '1'],
      ['verb', 'minCount', '1'],
      ['verb', 'maxCount', '1'],
      ['object', 'minCount', '1'],
      ['object', 'maxCount', '1'],
      ['result', 'maxCount', '1'],
      ['context', 'maxCount', '1'],
      ['timestamp', 'datatype', 'dateTime'],
    ]],
    ['AgentShape', 'Agent', [
      ['mbox', 'maxCount', '1'],
      ['mbox_sha1sum', 'maxCount', '1'],
      ['openid', 'maxCount', '1'],
      ['account', 'maxCount', '1'],
      ['account', 'class', 'Account'],
    ]],
    ['ScoreShape', 'Score', [
      ['scaled', 'datatype', 'decimal'],
      ['scaled', 'minInclusive', '-1'],
      ['scaled', 'maxInclusive', '1'],
      ['raw', 'datatype', 'decimal'],
      ['min', 'datatype', 'decimal'],
      ['max', 'datatype', 'decimal'],
    ]],
    ['ActivityShape', 'Activity', [
      ['id', 'minCount', '1'],
      ['id', 'datatype', 'anyURI'],
    ]],
    ['VerbShape', 'Verb', [
      ['id', 'minCount', '1'],
      ['id', 'datatype', 'anyURI'],
    ]],
    ['ContextShape', 'Context', [
      ['instructor', 'class', 'Agent'],
      ['team', 'class', 'Group'],
    ]],
    ['AttachmentShape', 'Attachment', [
      ['usageType', 'minCount', '1'],
      ['contentType', 'minCount', '1'],
      ['length', 'minCount', '1'],
      ['sha2', 'minCount', '1'],
    ]],
    ['AccountShape', 'Account', [
      ['homePage', 'minCount', '1'],
      ['name', 'minCount', '1'],
    ]],
  ];

  let shapeCount = 0;
  for (const [shapeName, targetCls, props] of shapes) {
    await chain(shapeName!, 'targetClass', targetCls!);
    for (const [prop, constraint, value] of props) {
      await chain(shapeName!, 'property', prop!, constraint!, value!);
      shapeCount++;
    }
  }
  console.log(`    ${shapes.length} shapes, ${shapeCount} property constraints\n`);

  // ── Step 6: ADL verb instances ────────────────────────
  console.log('  Building ADL verb registry...');

  const adlVerbs = [
    'completed', 'attempted', 'passed', 'failed', 'experienced',
    'answered', 'interacted', 'launched', 'shared', 'voided',
    'registered', 'progressed', 'initialized', 'terminated',
    'suspended', 'resumed', 'mastered', 'scored',
  ];

  for (const v of adlVerbs) {
    await chain(v, 'type', 'Verb');
    await chain('adl', v);
  }
  console.log(`    ${adlVerbs.length} ADL verbs\n`);

  // ── Step 7: Interaction types ─────────────────────────
  console.log('  Building interaction types...');

  const interactions = [
    'true-false', 'choice', 'fill-in', 'long-fill-in',
    'matching', 'performance', 'sequencing', 'likert', 'numeric',
  ];

  for (const it of interactions) {
    await chain(it, 'type', 'interactionType');
  }
  console.log(`    ${interactions.length} interaction types\n`);

  // ── Step 8: cmi5 profile ──────────────────────────────
  console.log('  Building cmi5 profile...');

  const cmi5Verbs = [
    'launched', 'initialized', 'completed', 'passed', 'failed',
    'abandoned', 'waived', 'terminated', 'satisfied',
  ];

  for (const v of cmi5Verbs) {
    await chain('cmi5', v);
    await chain('cmi5', v, 'type', 'Verb');
  }

  await chain('AssignableUnit', 'type', 'Class');
  await chain('Block', 'type', 'Class');
  await chain('Course', 'type', 'Class');
  await chain('moveOn', 'type', 'DatatypeProperty');
  await chain('launchMode', 'type', 'DatatypeProperty');
  await chain('masteryScore', 'type', 'DatatypeProperty');

  console.log(`    ${cmi5Verbs.length} cmi5 verbs, 3 classes, 3 properties\n`);

  // ── Done ──────────────────────────────────────────────
  const stats = await (await fetch(`${BASE}/api/stats`)).json();
  console.log('═══════════════════════════════════════════════');
  console.log(`Lattice: ${stats.atoms} atoms, ${stats.fragments} fragments, max level L${stats.maxLevel}`);
  console.log('');
  console.log('Structure emerges from composition:');
  console.log('  - "type" atom shared across all class/property declarations');
  console.log('  - "domain"/"range" shared across all property definitions');
  console.log('  - "subClassOf" shared across all subclass chains');
  console.log('  - "minCount"/"maxCount" shared across all SHACL shapes');
  console.log('  - Paradigm sets form naturally: P(?, type, Class) = all classes');
  console.log('  - P(?, subClassOf, Actor) = {Agent, Group}');
  console.log('  - P(?, subClassOf, Object) = {Activity, StatementRef, SubStatement}');
  console.log('');
  console.log('Open http://localhost:5000/ to browse');
}

main().catch(err => { console.error(err); process.exit(1); });
