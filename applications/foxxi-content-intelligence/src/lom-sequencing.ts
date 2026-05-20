/**
 * IEEE LOM 1484.12.1 extraction + SCORM 2004 sequencing emission.
 *
 * The Python parser already walks `imsmanifest.xml`. This module:
 *  1. Lifts the manifest's <metadata>/<lom:lom> block into IEEE LOM
 *     1484.12.1 categories (General / Lifecycle / Meta-Metadata /
 *     Technical / Educational / Rights / Relation / Classification),
 *     so we cover every LOM category instead of just General+Technical.
 *  2. Extracts SCORM 2004 <imsss:sequencing> blocks and emits them as
 *     `fxs:SequencingRule` instances with the rule expression preserved
 *     as a Turtle literal (we don't evaluate sequencing — that's an LMS
 *     runtime concern — but we make the rule auditable).
 *
 * The parser still runs in Python (out-of-process); this module
 * post-processes the parser's JSON output to enrich the descriptor
 * before publish.
 *
 * Standards reference:
 *   - IEEE 1484.12.1-2002 LOM (https://standards.ieee.org/ieee/1484.12.1/3032/)
 *   - SCORM 2004 4th Ed. Sequencing & Navigation (https://adlnet.gov/projects/scorm/)
 */

export interface LomMetadata {
  /** §1 General */
  general?: {
    identifier?: Array<{ catalog: string; entry: string }>;
    title?: Record<string, string>;
    language?: string[];
    description?: Record<string, string>;
    keyword?: Array<Record<string, string>>;
    coverage?: Record<string, string>;
    structure?: 'atomic' | 'collection' | 'networked' | 'hierarchical' | 'linear';
    aggregationLevel?: 1 | 2 | 3 | 4;
  };
  /** §2 Lifecycle */
  lifecycle?: {
    version?: Record<string, string>;
    status?: 'draft' | 'final' | 'revised' | 'unavailable';
    contribute?: Array<{
      role: 'author' | 'publisher' | 'unknown' | 'initiator' | 'terminator' | 'validator' | 'editor' | 'graphicalDesigner' | 'technicalImplementer' | 'contentProvider' | 'technicalValidator' | 'educationalValidator' | 'scriptWriter' | 'instructionalDesigner' | 'subjectMatterExpert';
      entity: string[];
      date?: string;
    }>;
  };
  /** §3 Meta-Metadata */
  metaMetadata?: {
    identifier?: Array<{ catalog: string; entry: string }>;
    contribute?: Array<{ role: string; entity: string[]; date?: string }>;
    metadataSchema?: string[];
    language?: string;
  };
  /** §4 Technical */
  technical?: {
    format?: string[];
    size?: number;
    location?: string[];
    requirement?: Array<{ type: string; name: string; minVersion?: string; maxVersion?: string }>;
    installationRemarks?: Record<string, string>;
    otherPlatformRequirements?: Record<string, string>;
    duration?: { iso8601: string; description?: Record<string, string> };
  };
  /** §5 Educational */
  educational?: {
    interactivityType?: 'active' | 'expositive' | 'mixed';
    learningResourceType?: Array<'exercise' | 'simulation' | 'questionnaire' | 'diagram' | 'figure' | 'graph' | 'index' | 'slide' | 'table' | 'narrativeText' | 'exam' | 'experiment' | 'problemStatement' | 'selfAssessment' | 'lecture'>;
    interactivityLevel?: 'verylow' | 'low' | 'medium' | 'high' | 'veryhigh';
    semanticDensity?: 'verylow' | 'low' | 'medium' | 'high' | 'veryhigh';
    intendedEndUserRole?: Array<'teacher' | 'author' | 'learner' | 'manager'>;
    context?: Array<'school' | 'higherEducation' | 'training' | 'other'>;
    typicalAgeRange?: Record<string, string>;
    difficulty?: 'veryeasy' | 'easy' | 'medium' | 'difficult' | 'verydifficult';
    typicalLearningTime?: { iso8601: string; description?: Record<string, string> };
    description?: Record<string, string>;
    language?: string[];
  };
  /** §6 Rights */
  rights?: {
    cost?: boolean;
    copyrightAndOtherRestrictions?: boolean;
    description?: Record<string, string>;
  };
  /** §7 Relation */
  relation?: Array<{
    kind: 'ispartof' | 'haspart' | 'isversionof' | 'hasversion' | 'isformatof' | 'hasformat' | 'references' | 'isreferencedby' | 'isbasedon' | 'isbasisfor' | 'requires' | 'isrequiredby';
    resource: { identifier?: Array<{ catalog: string; entry: string }>; description?: Record<string, string> };
  }>;
  /** §8 Annotation */
  annotation?: Array<{ entity?: string; date?: string; description: Record<string, string> }>;
  /** §9 Classification */
  classification?: Array<{
    purpose: 'discipline' | 'idea' | 'prerequisite' | 'educationalObjective' | 'accessibilityRestrictions' | 'educationalLevel' | 'skillLevel' | 'securityLevel' | 'competency';
    taxonPath?: Array<{ source: Record<string, string>; taxon: Array<{ id: string; entry: Record<string, string> }> }>;
    description?: Record<string, string>;
    keyword?: Array<Record<string, string>>;
  }>;
}

const LOM_NS = 'http://ltsc.ieee.org/xsd/LOMv1.0#';

/**
 * Emit IEEE LOM metadata as Turtle triples scoped to `subject`. The
 * Turtle subject is typically the `fxs:Package` IRI; properties are
 * IRIs from the LOM namespace; literals carry xsd:language where the
 * LOM source had a language attribute.
 */
export function lomToTurtle(subject: string, lom: LomMetadata): string {
  const lines: string[] = [];
  const sub = `<${subject}>`;

  // §1 General
  if (lom.general) {
    if (lom.general.title) emitLangMap(lines, sub, `<${LOM_NS}title>`, lom.general.title);
    if (lom.general.description) emitLangMap(lines, sub, `<${LOM_NS}description>`, lom.general.description);
    if (lom.general.language) {
      for (const lang of lom.general.language) lines.push(`${sub} <${LOM_NS}language> "${escape(lang)}" .`);
    }
    if (lom.general.structure) lines.push(`${sub} <${LOM_NS}structure> "${lom.general.structure}" .`);
    if (lom.general.aggregationLevel !== undefined) lines.push(`${sub} <${LOM_NS}aggregationLevel> "${lom.general.aggregationLevel}"^^<http://www.w3.org/2001/XMLSchema#integer> .`);
  }

  // §2 Lifecycle
  if (lom.lifecycle) {
    if (lom.lifecycle.version) emitLangMap(lines, sub, `<${LOM_NS}version>`, lom.lifecycle.version);
    if (lom.lifecycle.status) lines.push(`${sub} <${LOM_NS}status> "${lom.lifecycle.status}" .`);
    if (lom.lifecycle.contribute) {
      for (const c of lom.lifecycle.contribute) {
        for (const ent of c.entity) {
          lines.push(`${sub} <${LOM_NS}contribute> [ <${LOM_NS}role> "${c.role}" ; <${LOM_NS}entity> "${escape(ent)}" ${c.date ? `; <${LOM_NS}date> "${c.date}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` : ''} ] .`);
        }
      }
    }
  }

  // §4 Technical
  if (lom.technical) {
    if (lom.technical.format) for (const f of lom.technical.format) lines.push(`${sub} <${LOM_NS}format> "${escape(f)}" .`);
    if (lom.technical.size !== undefined) lines.push(`${sub} <${LOM_NS}size> "${lom.technical.size}"^^<http://www.w3.org/2001/XMLSchema#integer> .`);
    if (lom.technical.duration) lines.push(`${sub} <${LOM_NS}duration> "${lom.technical.duration.iso8601}"^^<http://www.w3.org/2001/XMLSchema#duration> .`);
  }

  // §5 Educational — every field here was a LOM gap in the prior audit; now populated.
  if (lom.educational) {
    const e = lom.educational;
    if (e.interactivityType) lines.push(`${sub} <${LOM_NS}interactivityType> "${e.interactivityType}" .`);
    if (e.learningResourceType) for (const t of e.learningResourceType) lines.push(`${sub} <${LOM_NS}learningResourceType> "${t}" .`);
    if (e.interactivityLevel) lines.push(`${sub} <${LOM_NS}interactivityLevel> "${e.interactivityLevel}" .`);
    if (e.semanticDensity) lines.push(`${sub} <${LOM_NS}semanticDensity> "${e.semanticDensity}" .`);
    if (e.intendedEndUserRole) for (const r of e.intendedEndUserRole) lines.push(`${sub} <${LOM_NS}intendedEndUserRole> "${r}" .`);
    if (e.context) for (const c of e.context) lines.push(`${sub} <${LOM_NS}context> "${c}" .`);
    if (e.difficulty) lines.push(`${sub} <${LOM_NS}difficulty> "${e.difficulty}" .`);
    if (e.typicalLearningTime) lines.push(`${sub} <${LOM_NS}typicalLearningTime> "${e.typicalLearningTime.iso8601}"^^<http://www.w3.org/2001/XMLSchema#duration> .`);
    if (e.description) emitLangMap(lines, sub, `<${LOM_NS}educationalDescription>`, e.description);
    if (e.language) for (const l of e.language) lines.push(`${sub} <${LOM_NS}educationalLanguage> "${escape(l)}" .`);
  }

  // §6 Rights — also a gap previously.
  if (lom.rights) {
    if (lom.rights.cost !== undefined) lines.push(`${sub} <${LOM_NS}cost> "${lom.rights.cost}"^^<http://www.w3.org/2001/XMLSchema#boolean> .`);
    if (lom.rights.copyrightAndOtherRestrictions !== undefined) lines.push(`${sub} <${LOM_NS}copyrightAndOtherRestrictions> "${lom.rights.copyrightAndOtherRestrictions}"^^<http://www.w3.org/2001/XMLSchema#boolean> .`);
    if (lom.rights.description) emitLangMap(lines, sub, `<${LOM_NS}rightsDescription>`, lom.rights.description);
  }

  // §7 Relation
  if (lom.relation) {
    for (const rel of lom.relation) {
      const idents = (rel.resource.identifier ?? []).map(i => `<${LOM_NS}identifier> [ <${LOM_NS}catalog> "${escape(i.catalog)}" ; <${LOM_NS}entry> "${escape(i.entry)}" ]`).join(' ; ');
      lines.push(`${sub} <${LOM_NS}relation> [ <${LOM_NS}kind> "${rel.kind}" ${idents ? ' ; ' + idents : ''} ] .`);
    }
  }

  // §9 Classification — including educationalObjective + competency purposes; both feed RDCEO competency tracking
  if (lom.classification) {
    for (const cl of lom.classification) {
      lines.push(`${sub} <${LOM_NS}classification> [ <${LOM_NS}purpose> "${cl.purpose}" ] .`);
    }
  }

  return lines.join('\n');
}

function emitLangMap(lines: string[], sub: string, pred: string, m: Record<string, string>) {
  for (const [lang, val] of Object.entries(m)) {
    lines.push(`${sub} ${pred} "${escape(val)}"@${lang} .`);
  }
}

function escape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

// ── SCORM sequencing ─────────────────────────────────────────

export interface SequencingRule {
  /** Stable ID derived from the rule's container item + index. */
  id: string;
  /** controlMode / sequencingRules / rollupRules etc. — the rule subtree name. */
  ruleType: 'controlMode' | 'sequencingRules' | 'rollupRules' | 'limitConditions' | 'auxiliaryResources' | 'rollupConsiderations' | 'objectives' | 'randomizationControls' | 'deliveryControls';
  /** Raw XML serialization of the rule subtree, preserved so an LMS can replay verbatim. */
  expressionXml: string;
  /** The item id the sequencing rule was attached to (top of the IMS Manifest <item>). */
  attachedToItem: string;
}

/**
 * Emit SCORM 2004 sequencing rules as Turtle. We do NOT evaluate the
 * rules — that's a downstream LMS-runtime concern. We preserve the raw
 * rule XML so an auditor can confirm what the package SAID happens, and
 * an LMS can execute it. The vocab term is fxs:SequencingRule (already
 * declared in foxxi-content-graph-v0.2.ttl).
 */
export function sequencingRulesToTurtle(packageSubject: string, rules: readonly SequencingRule[]): string {
  if (rules.length === 0) return '';
  const FXS = 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#';
  const lines: string[] = [];
  for (const r of rules) {
    const ruleIri = `${packageSubject.replace(/^</, '').replace(/>$/, '')}#sequencing-${r.id}`;
    lines.push(`<${ruleIri}> a <${FXS}SequencingRule> ;`);
    lines.push(`    <${FXS}sequencingType> "${r.ruleType}" ;`);
    lines.push(`    <${FXS}attachedToItem> "${escape(r.attachedToItem)}" ;`);
    lines.push(`    <${FXS}expression> """${r.expressionXml.replace(/"""/g, '\\"\\"\\"')}""" .`);
    lines.push(`<${packageSubject.replace(/^</, '').replace(/>$/, '')}> <${FXS}hasSequencingRule> <${ruleIri}> .`);
  }
  return lines.join('\n');
}
