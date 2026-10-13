/**
 * SCORM 2004 4th Edition — Sequencing and Navigation: the sequencing definition model — the single source.
 *
 * Transcribes the IMS Simple Sequencing 1.0 binding SCORM 2004 adopts (imsss_v1p0*.xsd) and ADL's
 * sequencing and navigation extensions (adlseq_v1p3.xsd, adlnav_v1p3.xsd). An <imsss:sequencing>
 * element on an item or organization drives how its activity tree is sequenced: control modes,
 * sequencing rules, limit conditions, rollup rules, objectives and their global-objective maps,
 * randomization and delivery controls. Composed into the PGSL lattice (composeSpecOntology) and
 * projected to OWL/SHACL/JSON-LD at <bridge>/ns/scorm-sn; a parsed manifest's sequencing is checked
 * against the shapes at POST /ns/scorm-sn/validate, and every result cites its shape.
 *
 * ★ THE 4TH EDITION. Its adlseq:objectives map an objective's raw, minimum and maximum score,
 * completion status and progress measure to global objectives; this model used to describe that
 * element as a second imsss:objectives container, which it is not (AdlObjective, AdlObjectiveMapping).
 *
 * ★ ATTACHED WHERE THE PACKAGE ATTACHES IT. This ontology imports the content-packaging one: an
 * item or organization has its sequencing, a manifest its sequencing collection, an organization
 * objectivesGlobalToSystem, and an item its adlnav:presentation (which this model used to hang on
 * the sequencing definition; it is a child of the item).
 *
 * ★ OWL 2 DL, AND THE SAME LITERALS AS THE SCHEMA. xs:duration is outside the OWL 2 datatype map,
 * so the duration limits are a named datatype restricting xsd:string by the xs:duration form.
 * Objective, auxiliary resource and global objective IDs are xs:anyURI values — often relative
 * references such as "obj_1" — so the shapes check them as xsd:anyURI literals; they used to demand
 * IRI nodes, which no manifest can produce for a datatype property.
 */
import type { OntologyModel } from '../spec-ontology.js';
import { XS_DURATION } from './patterns.js';
import { SCORM_CAM_MODEL } from './scorm-cam.model.js';

const SS = 'IMS Simple Sequencing 1.0 (imsss_v1p0.xsd)';
const ADLSEQ = 'ADL sequencing extensions, SCORM 2004 4th Edition (adlseq_v1p3.xsd)';
const ADLNAV = 'ADL navigation extensions (adlnav_v1p3.xsd)';
/** What a JSON number becomes in RDF (JSON-LD 1.1 §8.6): an integer or a double; or a decimal. */
const NUMBER = ['xsd:integer', 'xsd:decimal', 'xsd:double'];

const RULE_CONDITIONS = ['satisfied', 'objectiveStatusKnown', 'objectiveMeasureKnown', 'objectiveMeasureGreaterThan', 'objectiveMeasureLessThan', 'completed', 'activityProgressKnown', 'attempted', 'attemptLimitExceeded', 'timeLimitExceeded', 'outsideAvailableTimeRange', 'always'];
const ROLLUP_CONDITIONS = ['satisfied', 'objectiveStatusKnown', 'objectiveMeasureKnown', 'completed', 'activityProgressKnown', 'attempted', 'attemptLimitExceeded', 'timeLimitExceeded', 'outsideAvailableTimeRange'];
const PRE_ACTIONS = ['skip', 'disabled', 'hiddenFromChoice', 'stopForwardTraversal'];
const EXIT_ACTIONS = ['exit'];
const POST_ACTIONS = ['exitParent', 'exitAll', 'retry', 'retryAll', 'continue', 'previous'];
const ROLLUP_ACTIONS = ['satisfied', 'notSatisfied', 'completed', 'incomplete'];
const CHILD_ACTIVITY_SETS = ['all', 'any', 'none', 'atLeastCount', 'atLeastPercent'];
const RANDOM_TIMINGS = ['never', 'once', 'onEachNewAttempt'];
const ROLLUP_CONSIDERATIONS = ['always', 'ifAttempted', 'ifNotSkipped', 'ifNotSuspended'];
const HIDE_LMS_UI = ['previous', 'continue', 'exit', 'exitAll', 'abandon', 'abandonAll', 'suspendAll'];

export const SCORM_SN_MODEL: OntologyModel = {
  // Read through its generated JSON-LD context (ns/model-context.ts): a node a property reaches is
  // selected by that property as well as by its class.
  selectByDomainAndRange: true,
  generatedContext: true,
  module: 'scorm-sn',
  title: 'SCORM 2004 4th Edition — Sequencing and Navigation (IMS Simple Sequencing and ADL extensions)',
  description:
    'An OWL 2 DL ontology and SHACL shapes for the sequencing definitions of SCORM 2004 4th Edition: IMS Simple Sequencing 1.0 as SCORM applies it — sequencing definitions and collections, control modes, pre-, exit- and post-condition rules with their conditions and actions, limit conditions, rollup rules, objectives with their global-objective maps, randomization and delivery controls, auxiliary resources — and ADL\'s extensions: rollup and constrained-choice considerations, objectivesGlobalToSystem, the 4th Edition\'s extended objective maps (raw, minimum and maximum score, completion status, progress measure), and the navigation presentation that hides LMS controls. It imports the content-packaging ontology, whose items and organizations carry the sequencing.',
  version: '2026.10.0',
  spec: 'https://adlnet.gov/past-projects/scorm',
  standards: [
    { title: 'SCORM 2004 4th Edition (ADL, 2009): Sequencing and Navigation', url: 'https://adlnet.gov/past-projects/scorm' },
    { title: 'IMS Simple Sequencing 1.0 (1EdTech, formerly IMS Global Learning Consortium)', url: 'https://www.imsglobal.org/simplesequencing/index.html' },
  ],
  bodies: ['ADL', '1EdTech'],
  // By version IRI: a released version keeps the content-packaging ontology it was built on.
  imports: [`scorm-cam/${SCORM_CAM_MODEL.version}`],
  derivedFrom: 'imsss_v1p0.xsd and the schemas it includes (IMS Simple Sequencing 1.0), adlseq_v1p3.xsd and adlnav_v1p3.xsd, as distributed with SCORM 2004 4th Edition',
  notes: [
    'Since 2026.10.0: adlObjectives points at AdlObjective, the 4th Edition\'s adlseq:objective, instead of the imsss Objectives class; presentation belongs to the item rather than the sequencing definition; and objectivesGlobalToSystem belongs to the organization.',
    'The shapes select nodes by class (sh:targetClass): an RDF producer types the nodes it describes with this ontology\'s classes. A parsed instance as JSON is checked against the same shapes at POST /ns/scorm-sn/validate, which routes it by its declared type; every result cites its shape.',
  ],
  classes: [
    { name: 'Sequencing', label: 'Sequencing', notation: 'imsss:sequencing', comment: 'A sequencing definition: how the activity of an item or organization, and its children, are sequenced — control mode, sequencing rules, limit conditions, rollup rules, objectives, randomization and delivery controls, auxiliary resources, and ADL\'s extensions. A definition in the manifest\'s sequencing collection has an ID that others reuse by IDRef.', source: `${SS}: sequencingType` },
    { name: 'SequencingCollection', label: 'Sequencing collection', notation: 'imsss:sequencingCollection', comment: 'The sequencing definitions a manifest shares among its items and organizations, each with an ID.', source: `${SS}: sequencingCollection` },
    { name: 'ControlMode', label: 'Control mode', notation: 'imsss:controlMode', comment: 'The navigation an activity allows among its children: free choice, flow (continue and previous), whether flow is forward only, and whether only current-attempt information is used.', source: `${SS}: controlModeType` },
    { name: 'SequencingRules', label: 'Sequencing rules', notation: 'imsss:sequencingRules', comment: 'The pre-condition, exit-condition and post-condition rules of an activity.', source: `${SS}: sequencingRulesType` },
    { name: 'SequencingRule', label: 'Sequencing rule', comment: 'A rule that applies an action when its conditions hold: a pre-condition, exit-condition or post-condition rule, and only one of them.', source: `${SS}: sequencingRuleType`, disjointUnionOf: ['PreConditionRule', 'ExitConditionRule', 'PostConditionRule'] },
    { name: 'PreConditionRule', label: 'Pre-condition rule', notation: 'imsss:preConditionRule', comment: 'A sequencing rule evaluated before an activity is delivered or traversed: it may skip, disable or hide the activity, or stop forward traversal.', subClassOf: ['SequencingRule'], source: `${SS}: preConditionRuleType` },
    { name: 'ExitConditionRule', label: 'Exit-condition rule', notation: 'imsss:exitConditionRule', comment: 'A sequencing rule evaluated when an attempt on a descendant of the activity ends: it may exit the activity.', subClassOf: ['SequencingRule'], source: `${SS}: exitConditionRuleType` },
    { name: 'PostConditionRule', label: 'Post-condition rule', notation: 'imsss:postConditionRule', comment: 'A sequencing rule evaluated when an attempt on the activity ends: it may exit the parent or the whole tree, retry, or continue or go back.', subClassOf: ['SequencingRule'], source: `${SS}: postConditionRuleType` },
    { name: 'RuleConditions', label: 'Rule conditions', notation: 'imsss:ruleConditions', comment: 'The conditions of a sequencing rule, and whether all of them or any must hold.', source: `${SS}: sequencingRuleType (ruleConditions)` },
    { name: 'RuleCondition', label: 'Rule condition', notation: 'imsss:ruleCondition', comment: 'One condition of a sequencing rule: what is tested, whether it is negated, and for objective conditions the objective and measure threshold tested against.', source: `${SS}: sequencingRuleType (ruleCondition)` },
    { name: 'RuleAction', label: 'Rule action', notation: 'imsss:ruleAction', comment: 'The action a sequencing rule takes when its conditions hold; which actions are allowed depends on the kind of rule.', source: `${SS}: preConditionRuleType, exitConditionRuleType, postConditionRuleType (ruleAction)` },
    { name: 'LimitConditions', label: 'Limit conditions', notation: 'imsss:limitConditions', comment: 'Limits on an activity: how many attempts, how long an attempt or the activity may take, and when it may begin and end.', source: `${SS}: limitConditionsType` },
    { name: 'RollupRules', label: 'Rollup rules', notation: 'imsss:rollupRules', comment: 'How an activity\'s status is derived from its children: its rollup rules, whether it contributes to its parent\'s satisfaction and completion, and the weight of its measure.', source: `${SS}: rollupRulesType` },
    { name: 'RollupRule', label: 'Rollup rule', notation: 'imsss:rollupRule', comment: 'A rule that sets an activity\'s status when its conditions hold for a given set of its children.', source: `${SS}: rollupRuleType` },
    { name: 'RollupConditions', label: 'Rollup conditions', notation: 'imsss:rollupConditions', comment: 'The conditions of a rollup rule, and whether all of them or any must hold for a child.', source: `${SS}: rollupRuleType (rollupConditions)` },
    { name: 'RollupCondition', label: 'Rollup condition', notation: 'imsss:rollupCondition', comment: 'One condition of a rollup rule, tested on each child: what is tested, and whether it is negated.', source: `${SS}: rollupRuleType (rollupCondition)` },
    { name: 'RollupAction', label: 'Rollup action', notation: 'imsss:rollupAction', comment: 'The status a rollup rule sets on the activity when it applies.', source: `${SS}: rollupRuleType (rollupAction)` },
    { name: 'Objectives', label: 'Objectives', notation: 'imsss:objectives', comment: 'The objectives of an activity: exactly one primary objective, which contributes to rollup, and any number of others, which do not.', source: `${SS}: objectivesType` },
    { name: 'Objective', label: 'Objective', notation: 'imsss:objective', comment: 'A learning objective of an activity: its ID, whether it is satisfied by measure and with what minimum, and its maps to global objectives.', source: `${SS}: objectiveType` },
    { name: 'ObjectiveMapping', label: 'Objective mapping', notation: 'imsss:mapInfo', comment: 'A map from an objective to a global objective: whether the objective reads and writes the global objective\'s satisfaction status and normalized measure.', source: `${SS}: objectiveMappingType` },
    { name: 'RandomizationControls', label: 'Randomization controls', notation: 'imsss:randomizationControls', comment: 'Whether, and when, an activity\'s children are selected and reordered at random.', source: `${SS}: randomizationType` },
    { name: 'DeliveryControls', label: 'Delivery controls', notation: 'imsss:deliveryControls', comment: 'Whether an activity is tracked, and whether its content, rather than the LMS, sets its completion and objective status.', source: `${SS}: deliveryControlsType` },
    { name: 'AuxiliaryResources', label: 'Auxiliary resources', notation: 'imsss:auxiliaryResources', comment: 'The auxiliary resources available during an activity.', source: `${SS}: auxiliaryResourcesType` },
    { name: 'AuxiliaryResource', label: 'Auxiliary resource', notation: 'imsss:auxiliaryResource', comment: 'A resource offered alongside an activity, by its ID and purpose.', source: `${SS}: auxiliaryResourceType` },
    { name: 'RollupConsiderations', label: 'Rollup considerations', notation: 'adlseq:rollupConsiderations', comment: 'When an activity counts in its parent\'s rollup, for each of the four rollup statuses, and whether its measure counts while it is active.', source: `${ADLSEQ}: rollupConsiderationsType` },
    { name: 'ConstrainedChoiceConsiderations', label: 'Constrained choice considerations', notation: 'adlseq:constrainedChoiceConsiderations', comment: 'Limits on choice navigation relative to an activity: whether choosing into it out of order is prevented, and whether choice is constrained to the activities next to it in flow.', source: `${ADLSEQ}: constrainChoiceConsiderationsType` },
    { name: 'AdlObjective', label: 'ADL objective', notation: 'adlseq:objective', comment: 'The 4th Edition\'s further global-objective maps for one of an activity\'s objectives, named by its objective ID.', source: `${ADLSEQ}: objectiveType` },
    { name: 'AdlObjectiveMapping', label: 'ADL objective mapping', notation: 'adlseq:mapInfo', comment: 'A map from an objective to a global objective for the data imsss:mapInfo does not carry: whether the objective reads and writes the global objective\'s raw, minimum and maximum score, completion status and progress measure. Added in the 4th Edition.', source: `${ADLSEQ}: mapInfoType` },
    { name: 'Presentation', label: 'Presentation', notation: 'adlnav:presentation', comment: 'How an item is presented: the navigation controls the LMS hides while it is delivered.', source: `${ADLNAV}: presentationType` },
    { name: 'NavigationInterface', label: 'Navigation interface', notation: 'adlnav:navigationInterface', comment: 'The LMS navigation controls to hide while an item is delivered.', source: `${ADLNAV}: navigationInterfaceType` },
  ],
  datatypes: [
    { name: 'Duration', label: 'Duration', comment: 'A duration in the lexical form of XML Schema\'s xs:duration (an optional minus sign, then P, years, months, days, T, hours, minutes, seconds; at least one component), the type of the duration limits. Defined on xsd:string because xsd:duration is outside the OWL 2 datatype map.', base: 'xsd:string', pattern: XS_DURATION, source: `${SS}: limitConditionsType` },
    { name: 'Measure', label: 'Measure', comment: 'A normalized measure, a number from -1 to 1: a decimal as the schema writes it, or a double, which is what JSON-LD 1.1 (§8.6) makes of a JSON number with a fraction.', base: 'xsd:decimal', alsoBases: ['xsd:double'], minInclusive: -1, maxInclusive: 1, source: `${SS}: measureType` },
  ],
  properties: [
    // ── Where sequencing attaches (IMS SS on IMS CP) ──
    { name: 'sequencing', kind: 'object', label: 'sequencing', notation: 'imsss:sequencing', comment: 'The sequencing definition of an item or organization, or one of the definitions in a sequencing collection.', domain: ['foxxi-scorm-cam:Item', 'foxxi-scorm-cam:Organization', 'SequencingCollection'], range: 'Sequencing', source: `${SS}: sequencing` },
    { name: 'sequencingCollection', kind: 'object', label: 'sequencing collection', notation: 'imsss:sequencingCollection', comment: 'The sequencing definitions a manifest shares.', domain: 'foxxi-scorm-cam:Manifest', range: 'SequencingCollection', functional: true, source: `${SS}: sequencingCollection` },
    { name: 'objectivesGlobalToSystem', kind: 'datatype', label: 'objectives global to system', notation: 'adlseq:objectivesGlobalToSystem', comment: 'Whether the global objectives an organization\'s activities map to are global to the LMS, shared with other packages for the same learner (true, the default), or belong to this package (false).', domain: 'foxxi-scorm-cam:Organization', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: objectivesGlobalToSystem`, changeNote: '2026.10.0: given its domain, the organization, where the attribute is declared; it had none.' },
    { name: 'presentation', kind: 'object', label: 'presentation', notation: 'adlnav:presentation', comment: 'How an item is presented: which LMS navigation controls are hidden while it is delivered. A child of the item, not of its sequencing.', domain: 'foxxi-scorm-cam:Item', range: 'Presentation', functional: true, source: `${ADLNAV}: presentation`, changeNote: '2026.10.0: its domain is the item, of which adlnav:presentation is a child; it had been the sequencing definition, which an item\'s presentation was then wrongly inferred to be.' },
    // ── Sequencing ──
    { name: 'seqID', kind: 'datatype', label: 'sequencing ID', notation: 'ID', comment: 'The ID of a sequencing definition in the manifest\'s sequencing collection (an XML ID).', domain: 'Sequencing', range: 'xsd:string', functional: true, source: `${SS}: sequencingType/@ID` },
    { name: 'seqIDRef', kind: 'datatype', label: 'sequencing ID reference', notation: 'IDRef', comment: 'The ID of the definition in the sequencing collection that this definition reuses and extends (an XML IDREF).', domain: 'Sequencing', range: 'xsd:string', functional: true, source: `${SS}: sequencingType/@IDRef` },
    { name: 'controlMode', kind: 'object', label: 'control mode', notation: 'imsss:controlMode', comment: 'The control mode of a sequencing definition.', domain: 'Sequencing', range: 'ControlMode', functional: true, source: `${SS}: sequencingType` },
    { name: 'sequencingRules', kind: 'object', label: 'sequencing rules', notation: 'imsss:sequencingRules', comment: 'The sequencing rules of a sequencing definition.', domain: 'Sequencing', range: 'SequencingRules', functional: true, source: `${SS}: sequencingType` },
    { name: 'limitConditions', kind: 'object', label: 'limit conditions', notation: 'imsss:limitConditions', comment: 'The limit conditions of a sequencing definition.', domain: 'Sequencing', range: 'LimitConditions', functional: true, source: `${SS}: sequencingType` },
    { name: 'auxiliaryResources', kind: 'object', label: 'auxiliary resources', notation: 'imsss:auxiliaryResources', comment: 'The auxiliary resources of a sequencing definition.', domain: 'Sequencing', range: 'AuxiliaryResources', functional: true, source: `${SS}: sequencingType` },
    { name: 'rollupRules', kind: 'object', label: 'rollup rules', notation: 'imsss:rollupRules', comment: 'The rollup rules of a sequencing definition.', domain: 'Sequencing', range: 'RollupRules', functional: true, source: `${SS}: sequencingType` },
    { name: 'objectives', kind: 'object', label: 'objectives', notation: 'imsss:objectives', comment: 'The objectives of a sequencing definition.', domain: 'Sequencing', range: 'Objectives', functional: true, source: `${SS}: sequencingType` },
    { name: 'randomizationControls', kind: 'object', label: 'randomization controls', notation: 'imsss:randomizationControls', comment: 'The randomization controls of a sequencing definition.', domain: 'Sequencing', range: 'RandomizationControls', functional: true, source: `${SS}: sequencingType` },
    { name: 'deliveryControls', kind: 'object', label: 'delivery controls', notation: 'imsss:deliveryControls', comment: 'The delivery controls of a sequencing definition.', domain: 'Sequencing', range: 'DeliveryControls', functional: true, source: `${SS}: sequencingType` },
    { name: 'rollupConsiderations', kind: 'object', label: 'rollup considerations', notation: 'adlseq:rollupConsiderations', comment: 'The rollup considerations of a sequencing definition.', domain: 'Sequencing', range: 'RollupConsiderations', functional: true, source: `${ADLSEQ}: rollupConsiderations` },
    { name: 'constrainedChoiceConsiderations', kind: 'object', label: 'constrained choice considerations', notation: 'adlseq:constrainedChoiceConsiderations', comment: 'The constrained choice considerations of a sequencing definition.', domain: 'Sequencing', range: 'ConstrainedChoiceConsiderations', functional: true, source: `${ADLSEQ}: constrainedChoiceConsiderations` },
    { name: 'adlObjectives', kind: 'object', label: 'ADL objectives', notation: 'adlseq:objectives', comment: 'An adlseq:objective of a sequencing definition: further global-objective maps for one of its objectives (4th Edition).', domain: 'Sequencing', range: 'AdlObjective', source: `${ADLSEQ}: objectivesType`, changeNote: '2026.10.0: its range is AdlObjective, the 4th Edition\'s adlseq:objective; it had been the imsss Objectives class, a different element.' },
    // ── Control mode ──
    { name: 'choice', kind: 'datatype', label: 'choice', comment: 'Whether the learner may choose any of the activity\'s children. Default true.', domain: 'ControlMode', range: 'xsd:boolean', functional: true, source: `${SS}: controlModeType/@choice` },
    { name: 'choiceExit', kind: 'datatype', label: 'choice exit', notation: 'choiceExit', comment: 'Whether a choice of an activity outside the activity may end it while it is active. Default true.', domain: 'ControlMode', range: 'xsd:boolean', functional: true, source: `${SS}: controlModeType/@choiceExit` },
    { name: 'flow', kind: 'datatype', label: 'flow', comment: 'Whether the learner may move through the activity\'s children with continue and previous. Default false.', domain: 'ControlMode', range: 'xsd:boolean', functional: true, source: `${SS}: controlModeType/@flow` },
    { name: 'forwardOnly', kind: 'datatype', label: 'forward only', notation: 'forwardOnly', comment: 'Whether moving backwards through the activity\'s children is prohibited. Default false.', domain: 'ControlMode', range: 'xsd:boolean', functional: true, source: `${SS}: controlModeType/@forwardOnly` },
    { name: 'useCurrentAttemptObjectiveInfo', kind: 'datatype', label: 'use current attempt objective info', notation: 'useCurrentAttemptObjectiveInfo', comment: 'Whether sequencing uses the objective information of the children\'s current attempts only. Default true.', domain: 'ControlMode', range: 'xsd:boolean', functional: true, source: `${SS}: controlModeType/@useCurrentAttemptObjectiveInfo` },
    { name: 'useCurrentAttemptProgressInfo', kind: 'datatype', label: 'use current attempt progress info', notation: 'useCurrentAttemptProgressInfo', comment: 'Whether sequencing uses the progress information of the children\'s current attempts only. Default true.', domain: 'ControlMode', range: 'xsd:boolean', functional: true, source: `${SS}: controlModeType/@useCurrentAttemptProgressInfo` },
    // ── Sequencing rules ──
    { name: 'preConditionRule', kind: 'object', label: 'pre-condition rule', notation: 'imsss:preConditionRule', comment: 'A pre-condition rule of the activity.', domain: 'SequencingRules', range: 'PreConditionRule', source: `${SS}: sequencingRulesType` },
    { name: 'exitConditionRule', kind: 'object', label: 'exit-condition rule', notation: 'imsss:exitConditionRule', comment: 'An exit-condition rule of the activity.', domain: 'SequencingRules', range: 'ExitConditionRule', source: `${SS}: sequencingRulesType` },
    { name: 'postConditionRule', kind: 'object', label: 'post-condition rule', notation: 'imsss:postConditionRule', comment: 'A post-condition rule of the activity.', domain: 'SequencingRules', range: 'PostConditionRule', source: `${SS}: sequencingRulesType` },
    { name: 'ruleConditions', kind: 'object', label: 'rule conditions', notation: 'imsss:ruleConditions', comment: 'The conditions of a sequencing rule.', domain: 'SequencingRule', range: 'RuleConditions', functional: true, source: `${SS}: sequencingRuleType` },
    { name: 'ruleAction', kind: 'object', label: 'rule action', notation: 'imsss:ruleAction', comment: 'The action of a sequencing rule.', domain: 'SequencingRule', range: 'RuleAction', functional: true, source: `${SS}: preConditionRuleType, exitConditionRuleType, postConditionRuleType` },
    { name: 'ruleConditionCombination', kind: 'datatype', label: 'rule condition combination', notation: 'conditionCombination', comment: 'Whether all of a sequencing rule\'s conditions must hold, or any. Default all.', domain: 'RuleConditions', oneOf: ['all', 'any'], functional: true, source: `${SS}: conditionCombinationType` },
    { name: 'ruleCondition', kind: 'object', label: 'rule condition', notation: 'imsss:ruleCondition', comment: 'A condition of a sequencing rule.', domain: 'RuleConditions', range: 'RuleCondition', source: `${SS}: sequencingRuleType` },
    { name: 'referencedObjective', kind: 'datatype', label: 'referenced objective', notation: 'referencedObjective', comment: 'The ID of the activity\'s objective that the condition tests; the primary objective when absent.', domain: 'RuleCondition', range: 'xsd:anyURI', functional: true, source: `${SS}: ruleCondition/@referencedObjective` },
    { name: 'measureThreshold', kind: 'datatype', label: 'measure threshold', notation: 'measureThreshold', comment: 'The normalized measure, from -1 to 1, that the objectiveMeasureGreaterThan and objectiveMeasureLessThan conditions compare with.', domain: 'RuleCondition', range: 'Measure', functional: true, source: `${SS}: ruleCondition/@measureThreshold (measureType)` },
    { name: 'conditionOperator', kind: 'datatype', label: 'rule condition operator', notation: 'operator', comment: 'Whether a rule condition is negated (not) or taken as it is (noOp, the default).', domain: 'RuleCondition', oneOf: ['not', 'noOp'], functional: true, source: `${SS}: conditionOperatorType` },
    { name: 'ruleConditionName', kind: 'datatype', label: 'rule condition name', notation: 'condition', comment: 'What a rule condition tests. Required.', domain: 'RuleCondition', oneOf: RULE_CONDITIONS, functional: true, source: `${SS}: sequencingRuleConditionType` },
    { name: 'ruleActionValue', kind: 'datatype', label: 'rule action value', notation: 'action', comment: 'The action a sequencing rule takes; the kind of rule limits the choice. Required.', domain: 'RuleAction', oneOf: [...PRE_ACTIONS, ...EXIT_ACTIONS, ...POST_ACTIONS], functional: true, source: `${SS}: preConditionRuleActionType, exitConditionRuleActionType, postConditionRuleActionType` },
    // ── Limit conditions ──
    { name: 'attemptLimit', kind: 'datatype', label: 'attempt limit', notation: 'attemptLimit', comment: 'The most attempts the learner may make on the activity.', domain: 'LimitConditions', range: 'xsd:nonNegativeInteger', functional: true, source: `${SS}: limitConditionsType/@attemptLimit` },
    { name: 'attemptAbsoluteDurationLimit', kind: 'datatype', label: 'attempt absolute duration limit', notation: 'attemptAbsoluteDurationLimit', comment: 'The longest an attempt on the activity may last, counting all the time it is open, suspensions included. The content reads it as cmi.max_time_allowed.', domain: 'LimitConditions', range: 'Duration', functional: true, source: `${SS}: limitConditionsType/@attemptAbsoluteDurationLimit` },
    { name: 'attemptExperiencedDurationLimit', kind: 'datatype', label: 'attempt experienced duration limit', notation: 'attemptExperiencedDurationLimit', comment: 'The longest an attempt on the activity may last counting only the time the learner experiences it.', domain: 'LimitConditions', range: 'Duration', functional: true, source: `${SS}: limitConditionsType/@attemptExperiencedDurationLimit` },
    { name: 'activityAbsoluteDurationLimit', kind: 'datatype', label: 'activity absolute duration limit', notation: 'activityAbsoluteDurationLimit', comment: 'The longest all attempts on the activity together may last, counting all the time they are open.', domain: 'LimitConditions', range: 'Duration', functional: true, source: `${SS}: limitConditionsType/@activityAbsoluteDurationLimit` },
    { name: 'activityExperiencedDurationLimit', kind: 'datatype', label: 'activity experienced duration limit', notation: 'activityExperiencedDurationLimit', comment: 'The longest all attempts on the activity together may last, counting only the time the learner experiences them.', domain: 'LimitConditions', range: 'Duration', functional: true, source: `${SS}: limitConditionsType/@activityExperiencedDurationLimit` },
    { name: 'beginTimeLimit', kind: 'datatype', label: 'begin time limit', notation: 'beginTimeLimit', comment: 'The earliest time the activity may begin.', domain: 'LimitConditions', range: 'xsd:dateTime', functional: true, source: `${SS}: limitConditionsType/@beginTimeLimit` },
    { name: 'endTimeLimit', kind: 'datatype', label: 'end time limit', notation: 'endTimeLimit', comment: 'The latest time the activity may be delivered.', domain: 'LimitConditions', range: 'xsd:dateTime', functional: true, source: `${SS}: limitConditionsType/@endTimeLimit` },
    // ── Rollup rules ──
    { name: 'rollupRule', kind: 'object', label: 'rollup rule', notation: 'imsss:rollupRule', comment: 'A rollup rule of the activity.', domain: 'RollupRules', range: 'RollupRule', source: `${SS}: rollupRulesType` },
    { name: 'rollupObjectiveSatisfied', kind: 'datatype', label: 'rollup objective satisfied', notation: 'rollupObjectiveSatisfied', comment: 'Whether the activity counts when its parent\'s objective satisfaction is rolled up. Default true.', domain: 'RollupRules', range: 'xsd:boolean', functional: true, source: `${SS}: rollupRulesType/@rollupObjectiveSatisfied` },
    { name: 'rollupProgressCompletion', kind: 'datatype', label: 'rollup progress completion', notation: 'rollupProgressCompletion', comment: 'Whether the activity counts when its parent\'s completion is rolled up. Default true.', domain: 'RollupRules', range: 'xsd:boolean', functional: true, source: `${SS}: rollupRulesType/@rollupProgressCompletion` },
    { name: 'objectiveMeasureWeight', kind: 'datatype', label: 'objective measure weight', notation: 'objectiveMeasureWeight', comment: 'The weight, from 0 to 1, of the activity\'s measure in its parent\'s rolled-up measure. Default 1.', domain: 'RollupRules', range: 'foxxi-scorm-cam:UnitInterval', functional: true, source: `${SS}: rollupRulesType/@objectiveMeasureWeight (weightType)` },
    { name: 'childActivitySet', kind: 'datatype', label: 'child activity set', notation: 'childActivitySet', comment: 'For which of the children a rollup rule\'s conditions must hold. Default all.', domain: 'RollupRule', oneOf: CHILD_ACTIVITY_SETS, functional: true, source: `${SS}: childActivityType` },
    { name: 'minimumCount', kind: 'datatype', label: 'minimum count', notation: 'minimumCount', comment: 'For the atLeastCount set, how many children the conditions must hold for. Default 0.', domain: 'RollupRule', range: 'xsd:nonNegativeInteger', functional: true, source: `${SS}: rollupRuleType/@minimumCount` },
    { name: 'minimumPercent', kind: 'datatype', label: 'minimum percent', notation: 'minimumPercent', comment: 'For the atLeastPercent set, the fraction of children, from 0 to 1, the conditions must hold for. Default 0.', domain: 'RollupRule', range: 'foxxi-scorm-cam:UnitInterval', functional: true, source: `${SS}: rollupRuleType/@minimumPercent (percentType)` },
    { name: 'rollupConditions', kind: 'object', label: 'rollup conditions', notation: 'imsss:rollupConditions', comment: 'The conditions of a rollup rule.', domain: 'RollupRule', range: 'RollupConditions', functional: true, source: `${SS}: rollupRuleType` },
    { name: 'rollupActionEl', kind: 'object', label: 'rollup action', notation: 'imsss:rollupAction', comment: 'The action of a rollup rule.', domain: 'RollupRule', range: 'RollupAction', functional: true, source: `${SS}: rollupRuleType` },
    { name: 'rollupConditionCombination', kind: 'datatype', label: 'rollup condition combination', notation: 'conditionCombination', comment: 'Whether all of a rollup rule\'s conditions must hold for a child, or any. Default any.', domain: 'RollupConditions', oneOf: ['all', 'any'], functional: true, source: `${SS}: conditionCombinationType` },
    { name: 'rollupCondition', kind: 'object', label: 'rollup condition', notation: 'imsss:rollupCondition', comment: 'A condition of a rollup rule.', domain: 'RollupConditions', range: 'RollupCondition', source: `${SS}: rollupRuleType` },
    { name: 'rollupConditionOperator', kind: 'datatype', label: 'rollup condition operator', notation: 'operator', comment: 'Whether a rollup condition is negated (not) or taken as it is (noOp, the default).', domain: 'RollupCondition', oneOf: ['not', 'noOp'], functional: true, source: `${SS}: conditionOperatorType` },
    { name: 'rollupConditionName', kind: 'datatype', label: 'rollup condition name', notation: 'condition', comment: 'What a rollup condition tests on a child. Required.', domain: 'RollupCondition', oneOf: ROLLUP_CONDITIONS, functional: true, source: `${SS}: rollupRuleConditionType` },
    { name: 'rollupActionValue', kind: 'datatype', label: 'rollup action value', notation: 'action', comment: 'The status a rollup rule sets on the activity. Required.', domain: 'RollupAction', oneOf: ROLLUP_ACTIONS, functional: true, source: `${SS}: rollupActionType` },
    // ── Objectives ──
    { name: 'primaryObjective', kind: 'object', label: 'primary objective', notation: 'imsss:primaryObjective', comment: 'The objective that contributes to the activity\'s rollup. Its objective ID is optional.', domain: 'Objectives', range: 'Objective', functional: true, source: `${SS}: objectivesType` },
    { name: 'objective', kind: 'object', label: 'objective', notation: 'imsss:objective', comment: 'An objective that does not contribute to the activity\'s rollup. Its objective ID is required.', domain: 'Objectives', range: 'Objective', source: `${SS}: objectivesType` },
    { name: 'objectiveID', kind: 'datatype', label: 'objective ID', notation: 'objectiveID', comment: 'The identifier of an objective, unique within the activity: on an adlseq:objective, the objective it extends.', domain: ['Objective', 'AdlObjective'], range: 'xsd:anyURI', functional: true, source: `${SS}: objectivesType/@objectiveID; ${ADLSEQ}: objectiveType/@objectiveID` },
    { name: 'satisfiedByMeasure', kind: 'datatype', label: 'satisfied by measure', notation: 'satisfiedByMeasure', comment: 'Whether the objective is satisfied by comparing its normalized measure with its minimum normalized measure. Default false.', domain: 'Objective', range: 'xsd:boolean', functional: true, source: `${SS}: objectiveType/@satisfiedByMeasure` },
    { name: 'minNormalizedMeasure', kind: 'datatype', label: 'minimum normalized measure', notation: 'imsss:minNormalizedMeasure', comment: 'The normalized measure, from -1 to 1, at or above which an objective satisfied by measure is satisfied. Default 1.0.', domain: 'Objective', range: 'Measure', functional: true, source: `${SS}: objectiveType (minNormalizedMeasure, measureType)` },
    { name: 'mapInfo', kind: 'object', label: 'map info', notation: 'imsss:mapInfo', comment: 'A map from the objective to a global objective.', domain: 'Objective', range: 'ObjectiveMapping', source: `${SS}: objectiveType` },
    { name: 'targetObjectiveID', kind: 'datatype', label: 'target objective ID', notation: 'targetObjectiveID', comment: 'The identifier of the global objective a map points at. Required.', domain: ['ObjectiveMapping', 'AdlObjectiveMapping'], range: 'xsd:anyURI', functional: true, source: `${SS}: objectiveMappingType/@targetObjectiveID; ${ADLSEQ}: mapInfoType/@targetObjectiveID` },
    { name: 'readSatisfiedStatus', kind: 'datatype', label: 'read satisfied status', notation: 'readSatisfiedStatus', comment: 'Whether the objective takes its satisfaction status from the global objective. Default true.', domain: 'ObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${SS}: objectiveMappingType` },
    { name: 'readNormalizedMeasure', kind: 'datatype', label: 'read normalized measure', notation: 'readNormalizedMeasure', comment: 'Whether the objective takes its normalized measure from the global objective. Default true.', domain: 'ObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${SS}: objectiveMappingType` },
    { name: 'writeSatisfiedStatus', kind: 'datatype', label: 'write satisfied status', notation: 'writeSatisfiedStatus', comment: 'Whether the objective gives its satisfaction status to the global objective. Default false.', domain: 'ObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${SS}: objectiveMappingType` },
    { name: 'writeNormalizedMeasure', kind: 'datatype', label: 'write normalized measure', notation: 'writeNormalizedMeasure', comment: 'Whether the objective gives its normalized measure to the global objective. Default false.', domain: 'ObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${SS}: objectiveMappingType` },
    // ── 4th Edition objective maps (adlseq) ──
    { name: 'adlMapInfo', kind: 'object', label: 'ADL map info', notation: 'adlseq:mapInfo', comment: 'A further map from the objective to a global objective. Added in the 4th Edition.', domain: 'AdlObjective', range: 'AdlObjectiveMapping', source: `${ADLSEQ}: objectiveType` },
    { name: 'readRawScore', kind: 'datatype', label: 'read raw score', notation: 'readRawScore', comment: 'Whether the objective takes its raw score from the global objective. Default true.', domain: 'AdlObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: mapInfoType` },
    { name: 'readMinScore', kind: 'datatype', label: 'read minimum score', notation: 'readMinScore', comment: 'Whether the objective takes its minimum score from the global objective. Default true.', domain: 'AdlObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: mapInfoType` },
    { name: 'readMaxScore', kind: 'datatype', label: 'read maximum score', notation: 'readMaxScore', comment: 'Whether the objective takes its maximum score from the global objective. Default true.', domain: 'AdlObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: mapInfoType` },
    { name: 'readCompletionStatus', kind: 'datatype', label: 'read completion status', notation: 'readCompletionStatus', comment: 'Whether the objective takes its completion status from the global objective. Default true.', domain: 'AdlObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: mapInfoType` },
    { name: 'readProgressMeasure', kind: 'datatype', label: 'read progress measure', notation: 'readProgressMeasure', comment: 'Whether the objective takes its progress measure from the global objective. Default true.', domain: 'AdlObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: mapInfoType` },
    { name: 'writeRawScore', kind: 'datatype', label: 'write raw score', notation: 'writeRawScore', comment: 'Whether the objective gives its raw score to the global objective. Default false.', domain: 'AdlObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: mapInfoType` },
    { name: 'writeMinScore', kind: 'datatype', label: 'write minimum score', notation: 'writeMinScore', comment: 'Whether the objective gives its minimum score to the global objective. Default false.', domain: 'AdlObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: mapInfoType` },
    { name: 'writeMaxScore', kind: 'datatype', label: 'write maximum score', notation: 'writeMaxScore', comment: 'Whether the objective gives its maximum score to the global objective. Default false.', domain: 'AdlObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: mapInfoType` },
    { name: 'writeCompletionStatus', kind: 'datatype', label: 'write completion status', notation: 'writeCompletionStatus', comment: 'Whether the objective gives its completion status to the global objective. Default false.', domain: 'AdlObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: mapInfoType` },
    { name: 'writeProgressMeasure', kind: 'datatype', label: 'write progress measure', notation: 'writeProgressMeasure', comment: 'Whether the objective gives its progress measure to the global objective. Default false.', domain: 'AdlObjectiveMapping', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: mapInfoType` },
    // ── Randomization and delivery ──
    { name: 'randomizationTiming', kind: 'datatype', label: 'randomization timing', notation: 'randomizationTiming', comment: 'When the order of the activity\'s children is randomized. Default never.', domain: 'RandomizationControls', oneOf: RANDOM_TIMINGS, functional: true, source: `${SS}: randomizationType/@randomizationTiming (randomTimingType)` },
    { name: 'selectCount', kind: 'datatype', label: 'select count', notation: 'selectCount', comment: 'How many of the activity\'s children are selected.', domain: 'RandomizationControls', range: 'xsd:nonNegativeInteger', functional: true, source: `${SS}: randomizationType/@selectCount` },
    { name: 'reorderChildren', kind: 'datatype', label: 'reorder children', notation: 'reorderChildren', comment: 'Whether the activity\'s children are reordered when randomization takes place. Default false.', domain: 'RandomizationControls', range: 'xsd:boolean', functional: true, source: `${SS}: randomizationType/@reorderChildren` },
    { name: 'selectionTiming', kind: 'datatype', label: 'selection timing', notation: 'selectionTiming', comment: 'When the subset of children is selected. Default never.', domain: 'RandomizationControls', oneOf: RANDOM_TIMINGS, functional: true, source: `${SS}: randomizationType/@selectionTiming (randomTimingType)` },
    { name: 'tracked', kind: 'datatype', label: 'tracked', comment: 'Whether the activity\'s attempts are tracked for sequencing and rollup. Default true.', domain: 'DeliveryControls', range: 'xsd:boolean', functional: true, source: `${SS}: deliveryControlsType/@tracked` },
    { name: 'completionSetByContent', kind: 'datatype', label: 'completion set by content', notation: 'completionSetByContent', comment: 'Whether the content sets the attempt\'s completion status, rather than the LMS. Default false.', domain: 'DeliveryControls', range: 'xsd:boolean', functional: true, source: `${SS}: deliveryControlsType/@completionSetByContent` },
    { name: 'objectiveSetByContent', kind: 'datatype', label: 'objective set by content', notation: 'objectiveSetByContent', comment: 'Whether the content sets the primary objective\'s satisfaction status, rather than the LMS. Default false.', domain: 'DeliveryControls', range: 'xsd:boolean', functional: true, source: `${SS}: deliveryControlsType/@objectiveSetByContent` },
    // ── Auxiliary resources ──
    { name: 'auxiliaryResource', kind: 'object', label: 'auxiliary resource', notation: 'imsss:auxiliaryResource', comment: 'An auxiliary resource of the activity.', domain: 'AuxiliaryResources', range: 'AuxiliaryResource', source: `${SS}: auxiliaryResourcesType` },
    { name: 'auxiliaryResourceID', kind: 'datatype', label: 'auxiliary resource ID', notation: 'auxiliaryResourceID', comment: 'The identifier of an auxiliary resource. Required.', domain: 'AuxiliaryResource', range: 'xsd:anyURI', functional: true, source: `${SS}: auxiliaryResourceType/@auxiliaryResourceID` },
    { name: 'purpose', kind: 'datatype', label: 'purpose', comment: 'What an auxiliary resource is for. Required.', domain: 'AuxiliaryResource', range: 'xsd:string', functional: true, source: `${SS}: auxiliaryResourceType/@purpose` },
    // ── Rollup considerations (adlseq) ──
    { name: 'requiredForSatisfied', kind: 'datatype', label: 'required for satisfied', notation: 'requiredForSatisfied', comment: 'When the activity counts towards a satisfied rollup of its parent. Default always.', domain: 'RollupConsiderations', oneOf: ROLLUP_CONSIDERATIONS, functional: true, source: `${ADLSEQ}: rollupConsiderationsType` },
    { name: 'requiredForNotSatisfied', kind: 'datatype', label: 'required for not satisfied', notation: 'requiredForNotSatisfied', comment: 'When the activity counts towards a not-satisfied rollup of its parent. Default always.', domain: 'RollupConsiderations', oneOf: ROLLUP_CONSIDERATIONS, functional: true, source: `${ADLSEQ}: rollupConsiderationsType` },
    { name: 'requiredForCompleted', kind: 'datatype', label: 'required for completed', notation: 'requiredForCompleted', comment: 'When the activity counts towards a completed rollup of its parent. Default always.', domain: 'RollupConsiderations', oneOf: ROLLUP_CONSIDERATIONS, functional: true, source: `${ADLSEQ}: rollupConsiderationsType` },
    { name: 'requiredForIncomplete', kind: 'datatype', label: 'required for incomplete', notation: 'requiredForIncomplete', comment: 'When the activity counts towards an incomplete rollup of its parent. Default always.', domain: 'RollupConsiderations', oneOf: ROLLUP_CONSIDERATIONS, functional: true, source: `${ADLSEQ}: rollupConsiderationsType` },
    { name: 'measureSatisfactionIfActive', kind: 'datatype', label: 'measure satisfaction if active', notation: 'measureSatisfactionIfActive', comment: 'Whether the activity\'s measure counts towards satisfaction while the activity is active. Default true.', domain: 'RollupConsiderations', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: rollupConsiderationsType` },
    // ── Constrained choice considerations (adlseq) ──
    { name: 'preventActivation', kind: 'datatype', label: 'prevent activation', notation: 'preventActivation', comment: 'Whether a choice of a descendant may not start an attempt on the activity out of order. Default false.', domain: 'ConstrainedChoiceConsiderations', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: constrainChoiceConsiderationsType` },
    { name: 'constrainChoice', kind: 'datatype', label: 'constrain choice', notation: 'constrainChoice', comment: 'Whether choice is limited to the activities next to the activity in flow. Default false.', domain: 'ConstrainedChoiceConsiderations', range: 'xsd:boolean', functional: true, source: `${ADLSEQ}: constrainChoiceConsiderationsType` },
    // ── Presentation (adlnav) ──
    { name: 'navigationInterface', kind: 'object', label: 'navigation interface', notation: 'adlnav:navigationInterface', comment: 'The navigation controls hidden while the item is delivered.', domain: 'Presentation', range: 'NavigationInterface', functional: true, source: `${ADLNAV}: presentationType` },
    { name: 'hideLMSUI', kind: 'datatype', label: 'hide LMS UI', notation: 'adlnav:hideLMSUI', comment: 'An LMS navigation control to hide while the item is delivered. Repeatable.', domain: 'NavigationInterface', oneOf: HIDE_LMS_UI, source: `${ADLNAV}: hideLMSUIType` },
  ],
  vocabularies: [
    {
      name: 'SequencingRuleConditionName', label: 'Sequencing rule conditions', comment: 'What a sequencing rule condition tests (sequencingRuleConditionType). Objective conditions test the referenced objective, or the primary objective.',
      members: [
        { name: 'satisfied', label: 'satisfied', comment: 'The objective is satisfied.' },
        { name: 'objectiveStatusKnown', label: 'objective status known', notation: 'objectiveStatusKnown', comment: 'Whether the objective is satisfied is known.' },
        { name: 'objectiveMeasureKnown', label: 'objective measure known', notation: 'objectiveMeasureKnown', comment: 'The objective has a normalized measure.' },
        { name: 'objectiveMeasureGreaterThan', label: 'objective measure greater than', notation: 'objectiveMeasureGreaterThan', comment: 'The objective\'s normalized measure is greater than the measure threshold.' },
        { name: 'objectiveMeasureLessThan', label: 'objective measure less than', notation: 'objectiveMeasureLessThan', comment: 'The objective\'s normalized measure is less than the measure threshold.' },
        { name: 'completed', label: 'completed', comment: 'The activity\'s attempt is completed.' },
        { name: 'activityProgressKnown', label: 'activity progress known', notation: 'activityProgressKnown', comment: 'Whether the activity\'s attempt is completed is known.' },
        { name: 'attempted', label: 'attempted', comment: 'The activity has been attempted at least once.' },
        { name: 'attemptLimitExceeded', label: 'attempt limit exceeded', notation: 'attemptLimitExceeded', comment: 'The activity has used up its attempt limit.' },
        { name: 'timeLimitExceeded', label: 'time limit exceeded', notation: 'timeLimitExceeded', comment: 'A duration limit of the activity has been exceeded.' },
        { name: 'outsideAvailableTimeRange', label: 'outside available time range', notation: 'outsideAvailableTimeRange', comment: 'The current time is before the activity\'s begin time limit or after its end time limit.' },
        { name: 'always', label: 'always', comment: 'Always holds.' },
      ],
    },
    {
      name: 'RollupRuleConditionName', label: 'Rollup rule conditions', comment: 'What a rollup condition tests on a child (rollupRuleConditionType): the sequencing rule conditions without the measure comparisons and always.',
      members: [
        { name: 'satisfied', label: 'satisfied', comment: 'The child\'s objective is satisfied.' },
        { name: 'objectiveStatusKnown', label: 'objective status known', notation: 'objectiveStatusKnown', comment: 'Whether the child\'s objective is satisfied is known.' },
        { name: 'objectiveMeasureKnown', label: 'objective measure known', notation: 'objectiveMeasureKnown', comment: 'The child\'s objective has a normalized measure.' },
        { name: 'completed', label: 'completed', comment: 'The child\'s attempt is completed.' },
        { name: 'activityProgressKnown', label: 'activity progress known', notation: 'activityProgressKnown', comment: 'Whether the child\'s attempt is completed is known.' },
        { name: 'attempted', label: 'attempted', comment: 'The child has been attempted at least once.' },
        { name: 'attemptLimitExceeded', label: 'attempt limit exceeded', notation: 'attemptLimitExceeded', comment: 'The child has used up its attempt limit.' },
        { name: 'timeLimitExceeded', label: 'time limit exceeded', notation: 'timeLimitExceeded', comment: 'A duration limit of the child has been exceeded.' },
        { name: 'outsideAvailableTimeRange', label: 'outside available time range', notation: 'outsideAvailableTimeRange', comment: 'The current time is outside the child\'s begin and end time limits.' },
      ],
    },
    {
      name: 'ConditionOperator', label: 'Condition operators', comment: 'Whether a condition is negated (conditionOperatorType).',
      members: [
        { name: 'not', label: 'not', comment: 'The condition holds when what it tests does not.' },
        { name: 'noOp', label: 'no operation', notation: 'noOp', comment: 'The condition holds when what it tests does. The default.' },
      ],
    },
    {
      name: 'ConditionCombination', label: 'Condition combinations', comment: 'How a rule\'s conditions combine (conditionCombinationType).',
      members: [
        { name: 'all', label: 'all', comment: 'The rule applies when every condition holds.' },
        { name: 'any', label: 'any', comment: 'The rule applies when at least one condition holds.' },
      ],
    },
    {
      name: 'PreConditionRuleAction', label: 'Pre-condition rule actions', comment: 'What a pre-condition rule does when it applies (preConditionRuleActionType).',
      members: [
        { name: 'skip', label: 'skip', comment: 'Flow navigation passes over the activity.' },
        { name: 'disabled', label: 'disabled', comment: 'The activity cannot be delivered, chosen or entered.' },
        { name: 'hiddenFromChoice', label: 'hidden from choice', notation: 'hiddenFromChoice', comment: 'The activity cannot be chosen, and is not shown as a choice.' },
        { name: 'stopForwardTraversal', label: 'stop forward traversal', notation: 'stopForwardTraversal', comment: 'Flow navigation does not move forward past the activity.' },
      ],
    },
    {
      name: 'ExitConditionRuleAction', label: 'Exit-condition rule actions', comment: 'What an exit-condition rule does when it applies (exitConditionRuleActionType).',
      members: [
        { name: 'exit', label: 'exit', comment: 'The activity ends.' },
      ],
    },
    {
      name: 'PostConditionRuleAction', label: 'Post-condition rule actions', comment: 'What a post-condition rule does when it applies (postConditionRuleActionType).',
      members: [
        { name: 'exitParent', label: 'exit parent', notation: 'exitParent', comment: 'The activity\'s parent ends.' },
        { name: 'exitAll', label: 'exit all', notation: 'exitAll', comment: 'The whole activity tree ends.' },
        { name: 'retry', label: 'retry', comment: 'A new attempt on the activity begins.' },
        { name: 'retryAll', label: 'retry all', notation: 'retryAll', comment: 'A new attempt on the whole activity tree begins.' },
        { name: 'continue', label: 'continue', comment: 'The next activity in flow is delivered.' },
        { name: 'previous', label: 'previous', comment: 'The previous activity in flow is delivered.' },
      ],
    },
    {
      // Named RollupActionValues (not RollupAction) so the scheme's IRI does not collide with the
      // owl:Class RollupAction: one IRI cannot be both.
      name: 'RollupActionValues', label: 'Rollup actions', comment: 'The status a rollup rule sets on an activity (rollupActionType).',
      members: [
        { name: 'satisfied', label: 'satisfied', comment: 'The activity\'s objective is satisfied.' },
        { name: 'notSatisfied', label: 'not satisfied', notation: 'notSatisfied', comment: 'The activity\'s objective is not satisfied.' },
        { name: 'completed', label: 'completed', comment: 'The activity\'s attempt is completed.' },
        { name: 'incomplete', label: 'incomplete', comment: 'The activity\'s attempt is incomplete.' },
      ],
    },
    {
      name: 'ChildActivitySet', label: 'Child activity sets', comment: 'For which of an activity\'s children a rollup rule\'s conditions must hold (childActivityType). Only children that count in the rollup are considered.',
      members: [
        { name: 'all', label: 'all', comment: 'Every child.' },
        { name: 'any', label: 'any', comment: 'At least one child.' },
        { name: 'none', label: 'none', comment: 'No child.' },
        { name: 'atLeastCount', label: 'at least count', notation: 'atLeastCount', comment: 'At least the minimum count of children.' },
        { name: 'atLeastPercent', label: 'at least percent', notation: 'atLeastPercent', comment: 'At least the minimum percent of the children.' },
      ],
    },
    {
      name: 'RandomTiming', label: 'Randomization and selection timings', comment: 'When children are selected or reordered (randomTimingType).',
      members: [
        { name: 'never', label: 'never', comment: 'Never. The default.' },
        { name: 'once', label: 'once', comment: 'Once, before the first attempt on the activity.' },
        { name: 'onEachNewAttempt', label: 'on each new attempt', notation: 'onEachNewAttempt', comment: 'Before each new attempt on the activity.' },
      ],
    },
    {
      name: 'RollupConsideration', label: 'Rollup consideration values', comment: 'When a child counts in a rollup of its parent (adlseq rollupConsiderationType).',
      members: [
        { name: 'always', label: 'always', comment: 'Always. The default.' },
        { name: 'ifAttempted', label: 'if attempted', notation: 'ifAttempted', comment: 'Only if it has been attempted.' },
        { name: 'ifNotSkipped', label: 'if not skipped', notation: 'ifNotSkipped', comment: 'Unless it was skipped.' },
        { name: 'ifNotSuspended', label: 'if not suspended', notation: 'ifNotSuspended', comment: 'Unless its attempt is suspended.' },
      ],
    },
    {
      name: 'HideLMSUI', label: 'Hideable LMS controls', comment: 'The LMS navigation controls an item may hide (adlnav hideLMSUIType).',
      members: [
        { name: 'previous', label: 'previous', comment: 'The control that goes to the previous activity.' },
        { name: 'continue', label: 'continue', comment: 'The control that goes to the next activity.' },
        { name: 'exit', label: 'exit', comment: 'The control that ends the current activity.' },
        { name: 'exitAll', label: 'exit all', notation: 'exitAll', comment: 'The control that ends the whole activity tree.' },
        { name: 'abandon', label: 'abandon', comment: 'The control that abandons the current activity.' },
        { name: 'abandonAll', label: 'abandon all', notation: 'abandonAll', comment: 'The control that abandons the whole activity tree.' },
        { name: 'suspendAll', label: 'suspend all', notation: 'suspendAll', comment: 'The control that suspends the whole activity tree, to resume later.' },
      ],
    },
  ],
  disjoint: [
    // Each is a different element of the binding.
    ['Sequencing', 'SequencingCollection', 'ControlMode', 'SequencingRules', 'SequencingRule', 'RuleConditions', 'RuleCondition', 'RuleAction', 'LimitConditions', 'RollupRules', 'RollupRule', 'RollupConditions', 'RollupCondition', 'RollupAction', 'Objectives', 'Objective', 'ObjectiveMapping', 'RandomizationControls', 'DeliveryControls', 'AuxiliaryResources', 'AuxiliaryResource', 'RollupConsiderations', 'ConstrainedChoiceConsiderations', 'AdlObjective', 'AdlObjectiveMapping', 'Presentation', 'NavigationInterface'],
  ],
  shapes: [
    {
      name: 'SequencingShape', targetClass: 'Sequencing', label: 'Sequencing definition conformance',
      comment: `A sequencing definition has at most one of each of its parts, and at most one ID and one IDRef (${SS}: sequencingType).`,
      constraints: [
        { path: 'seqID', maxCount: 1, datatype: 'xsd:string', comment: '@ID' },
        { path: 'seqIDRef', maxCount: 1, datatype: 'xsd:string', comment: '@IDRef' },
        { path: 'controlMode', maxCount: 1 },
        { path: 'sequencingRules', maxCount: 1 },
        { path: 'limitConditions', maxCount: 1 },
        { path: 'auxiliaryResources', maxCount: 1 },
        { path: 'rollupRules', maxCount: 1 },
        { path: 'objectives', maxCount: 1 },
        { path: 'randomizationControls', maxCount: 1 },
        { path: 'deliveryControls', maxCount: 1 },
        { path: 'rollupConsiderations', maxCount: 1 },
        { path: 'constrainedChoiceConsiderations', maxCount: 1 },
      ],
    },
    {
      name: 'SequencingCollectionShape', targetClass: 'SequencingCollection', label: 'Sequencing collection conformance',
      comment: `A sequencing collection holds at least one sequencing definition (${SS}: sequencingCollection).`,
      constraints: [
        { path: 'sequencing', minCount: 1, comment: 'one or more <imsss:sequencing>' },
      ],
    },
    {
      name: 'ControlModeShape', targetClass: 'ControlMode', label: 'Control mode conformance',
      comment: `Each control flag is at most one boolean (${SS}: controlModeType).`,
      constraints: [
        { path: 'choice', maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' },
        { path: 'choiceExit', maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' },
        { path: 'flow', maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' },
        { path: 'forwardOnly', maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' },
        { path: 'useCurrentAttemptObjectiveInfo', maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' },
        { path: 'useCurrentAttemptProgressInfo', maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' },
      ],
    },
    {
      name: 'RuleConditionShape', targetClass: 'RuleCondition', label: 'Sequencing rule condition conformance',
      comment: `A rule condition names what it tests, from the twelve sequencing rule conditions; its operator is not or noOp; its measure threshold is from -1 to 1; its referenced objective is an objective ID (${SS}: sequencingRuleType).`,
      constraints: [
        { path: 'ruleConditionName', minCount: 1, maxCount: 1, datatype: 'xsd:string', in: RULE_CONDITIONS, comment: 'sequencingRuleConditionType (required)' },
        { path: 'conditionOperator', maxCount: 1, datatype: 'xsd:string', in: ['not', 'noOp'], comment: 'conditionOperatorType (default noOp)' },
        { path: 'measureThreshold', maxCount: 1, datatype: NUMBER, minInclusive: -1, maxInclusive: 1, comment: 'measureType, from -1 to 1' },
        { path: 'referencedObjective', maxCount: 1, datatype: 'xsd:anyURI', comment: 'an objective ID (xs:anyURI)' },
      ],
    },
    {
      name: 'RuleConditionsShape', targetClass: 'RuleConditions', label: 'Sequencing rule conditions conformance',
      comment: `A rule's conditions combine by all or any (default all), and there is at least one (${SS}: sequencingRuleType).`,
      constraints: [
        { path: 'ruleConditionCombination', maxCount: 1, datatype: 'xsd:string', in: ['all', 'any'], comment: 'conditionCombinationType (default all)' },
        { path: 'ruleCondition', minCount: 1, comment: 'one or more <imsss:ruleCondition>' },
      ],
    },
    {
      name: 'PreConditionRuleActionShape', targetClass: 'PreConditionRule', label: 'Pre-condition rule conformance',
      comment: `A pre-condition rule has exactly one action, one of skip, disabled, hiddenFromChoice, stopForwardTraversal (${SS}: preConditionRuleActionType).`,
      constraints: [
        { path: 'ruleAction', minCount: 1, maxCount: 1, comment: 'exactly one <imsss:ruleAction>' },
        { path: 'ruleAction.ruleActionValue', rdfPath: ['ruleAction', 'ruleActionValue'], maxCount: 1, datatype: 'xsd:string', in: PRE_ACTIONS, comment: 'a pre-condition action' },
      ],
    },
    {
      name: 'ExitConditionRuleActionShape', targetClass: 'ExitConditionRule', label: 'Exit-condition rule conformance',
      comment: `An exit-condition rule has exactly one action, exit (${SS}: exitConditionRuleActionType).`,
      constraints: [
        { path: 'ruleAction', minCount: 1, maxCount: 1, comment: 'exactly one <imsss:ruleAction>' },
        { path: 'ruleAction.ruleActionValue', rdfPath: ['ruleAction', 'ruleActionValue'], maxCount: 1, datatype: 'xsd:string', in: EXIT_ACTIONS, comment: 'exit' },
      ],
    },
    {
      name: 'PostConditionRuleActionShape', targetClass: 'PostConditionRule', label: 'Post-condition rule conformance',
      comment: `A post-condition rule has exactly one action, one of exitParent, exitAll, retry, retryAll, continue, previous (${SS}: postConditionRuleActionType).`,
      constraints: [
        { path: 'ruleAction', minCount: 1, maxCount: 1, comment: 'exactly one <imsss:ruleAction>' },
        { path: 'ruleAction.ruleActionValue', rdfPath: ['ruleAction', 'ruleActionValue'], maxCount: 1, datatype: 'xsd:string', in: POST_ACTIONS, comment: 'a post-condition action' },
      ],
    },
    {
      name: 'RuleActionShape', targetClass: 'RuleAction', label: 'Rule action conformance',
      comment: `A rule action has exactly one action from the sequencing rule actions; the rule's own shape narrows it to its kind (${SS}).`,
      constraints: [
        { path: 'ruleActionValue', minCount: 1, maxCount: 1, datatype: 'xsd:string', in: [...PRE_ACTIONS, ...EXIT_ACTIONS, ...POST_ACTIONS], comment: 'required' },
      ],
    },
    {
      name: 'LimitConditionsShape', targetClass: 'LimitConditions', label: 'Limit conditions conformance',
      comment: `The attempt limit is a non-negative integer, the four duration limits are xs:duration values, and the begin and end time limits are date-times (${SS}: limitConditionsType).`,
      constraints: [
        { path: 'attemptLimit', maxCount: 1, datatype: ['xsd:nonNegativeInteger', 'xsd:integer'], minInclusive: 0, comment: 'xs:nonNegativeInteger' },
        { path: 'attemptAbsoluteDurationLimit', maxCount: 1, datatype: 'xsd:string', pattern: XS_DURATION, comment: 'xs:duration' },
        { path: 'attemptExperiencedDurationLimit', maxCount: 1, datatype: 'xsd:string', pattern: XS_DURATION, comment: 'xs:duration' },
        { path: 'activityAbsoluteDurationLimit', maxCount: 1, datatype: 'xsd:string', pattern: XS_DURATION, comment: 'xs:duration' },
        { path: 'activityExperiencedDurationLimit', maxCount: 1, datatype: 'xsd:string', pattern: XS_DURATION, comment: 'xs:duration' },
        { path: 'beginTimeLimit', maxCount: 1, datatype: 'xsd:dateTime', comment: 'xs:dateTime' },
        { path: 'endTimeLimit', maxCount: 1, datatype: 'xsd:dateTime', comment: 'xs:dateTime' },
      ],
    },
    {
      name: 'RollupRulesShape', targetClass: 'RollupRules', label: 'Rollup rules conformance',
      comment: `The rollup flags are booleans (default true) and the objective measure weight is from 0 to 1 (default 1) (${SS}: rollupRulesType).`,
      constraints: [
        { path: 'rollupObjectiveSatisfied', maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' },
        { path: 'rollupProgressCompletion', maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' },
        { path: 'objectiveMeasureWeight', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'weightType, from 0 to 1' },
      ],
    },
    {
      name: 'RollupRuleShape', targetClass: 'RollupRule', label: 'Rollup rule conformance',
      comment: `A rollup rule has a child activity set (default all), a minimum count and percent, exactly one set of conditions and exactly one action (${SS}: rollupRuleType).`,
      constraints: [
        { path: 'childActivitySet', maxCount: 1, datatype: 'xsd:string', in: CHILD_ACTIVITY_SETS, comment: 'childActivityType (default all)' },
        { path: 'minimumCount', maxCount: 1, datatype: ['xsd:nonNegativeInteger', 'xsd:integer'], minInclusive: 0, comment: 'default 0' },
        { path: 'minimumPercent', maxCount: 1, datatype: NUMBER, minInclusive: 0, maxInclusive: 1, comment: 'percentType, from 0 to 1' },
        { path: 'rollupConditions', minCount: 1, maxCount: 1, comment: 'exactly one <imsss:rollupConditions>' },
        { path: 'rollupActionEl', minCount: 1, maxCount: 1, comment: 'exactly one <imsss:rollupAction>' },
      ],
    },
    {
      name: 'RollupConditionsShape', targetClass: 'RollupConditions', label: 'Rollup conditions conformance',
      comment: `A rollup rule's conditions combine by all or any (default any), and there is at least one (${SS}: rollupRuleType).`,
      constraints: [
        { path: 'rollupConditionCombination', maxCount: 1, datatype: 'xsd:string', in: ['all', 'any'], comment: 'conditionCombinationType (default any)' },
        { path: 'rollupCondition', minCount: 1, comment: 'one or more <imsss:rollupCondition>' },
      ],
    },
    {
      name: 'RollupConditionShape', targetClass: 'RollupCondition', label: 'Rollup condition conformance',
      comment: `A rollup condition names what it tests, from the nine rollup conditions; its operator is not or noOp (${SS}: rollupRuleConditionType).`,
      constraints: [
        { path: 'rollupConditionName', minCount: 1, maxCount: 1, datatype: 'xsd:string', in: ROLLUP_CONDITIONS, comment: 'rollupRuleConditionType (required)' },
        { path: 'rollupConditionOperator', maxCount: 1, datatype: 'xsd:string', in: ['not', 'noOp'], comment: 'conditionOperatorType (default noOp)' },
      ],
    },
    {
      name: 'RollupActionShape', targetClass: 'RollupAction', label: 'Rollup action conformance',
      comment: `A rollup action is exactly one of satisfied, notSatisfied, completed, incomplete (${SS}: rollupActionType).`,
      constraints: [
        { path: 'rollupActionValue', minCount: 1, maxCount: 1, datatype: 'xsd:string', in: ROLLUP_ACTIONS, comment: 'rollupActionType (required)' },
      ],
    },
    {
      name: 'ObjectivesShape', targetClass: 'Objectives', label: 'Objectives conformance',
      comment: `Objectives have exactly one primary objective, which contributes to rollup, and any number of others (${SS}: objectivesType).`,
      constraints: [
        { path: 'primaryObjective', minCount: 1, maxCount: 1, comment: 'exactly one <imsss:primaryObjective>' },
      ],
    },
    {
      name: 'ObjectiveShape', targetClass: 'Objective', label: 'Objective conformance',
      comment: `An objective has at most one ID, which is required on objectives other than the primary one; satisfiedByMeasure is a boolean; the minimum normalized measure is from -1 to 1 (${SS}: objectiveType).`,
      constraints: [
        { path: 'objectiveID', maxCount: 1, datatype: 'xsd:anyURI', comment: 'xs:anyURI (required on objectives other than the primary one)' },
        { path: 'satisfiedByMeasure', maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' },
        { path: 'minNormalizedMeasure', maxCount: 1, datatype: NUMBER, minInclusive: -1, maxInclusive: 1, comment: 'measureType, from -1 to 1 (default 1.0)' },
      ],
    },
    {
      name: 'ObjectiveMappingShape', targetClass: 'ObjectiveMapping', label: 'Objective mapping conformance',
      comment: `A map names its global objective; its read and write flags are booleans (read default true, write default false) (${SS}: objectiveMappingType).`,
      constraints: [
        { path: 'targetObjectiveID', minCount: 1, maxCount: 1, datatype: 'xsd:anyURI', comment: 'xs:anyURI (required)' },
        { path: 'readSatisfiedStatus', maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' },
        { path: 'readNormalizedMeasure', maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' },
        { path: 'writeSatisfiedStatus', maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' },
        { path: 'writeNormalizedMeasure', maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' },
      ],
    },
    {
      name: 'AdlObjectiveShape', targetClass: 'AdlObjective', label: 'ADL objective conformance',
      comment: `An adlseq:objective names the objective it extends and has at least one map (${ADLSEQ}: objectiveType).`,
      constraints: [
        { path: 'objectiveID', minCount: 1, maxCount: 1, datatype: 'xsd:anyURI', comment: 'xs:anyURI (required)' },
        { path: 'adlMapInfo', minCount: 1, comment: 'one or more <adlseq:mapInfo>' },
      ],
    },
    {
      name: 'AdlObjectiveMappingShape', targetClass: 'AdlObjectiveMapping', label: 'ADL objective mapping conformance',
      comment: `An adlseq:mapInfo names its global objective; its read and write flags are booleans (read default true, write default false) (${ADLSEQ}: mapInfoType).`,
      constraints: [
        { path: 'targetObjectiveID', minCount: 1, maxCount: 1, datatype: 'xsd:anyURI', comment: 'xs:anyURI (required)' },
        ...['readRawScore', 'readMinScore', 'readMaxScore', 'readCompletionStatus', 'readProgressMeasure'].map(path => ({ path, maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' })),
        ...['writeRawScore', 'writeMinScore', 'writeMaxScore', 'writeCompletionStatus', 'writeProgressMeasure'].map(path => ({ path, maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' })),
      ],
    },
    {
      name: 'RandomizationControlsShape', targetClass: 'RandomizationControls', label: 'Randomization controls conformance',
      comment: `The timings are never, once or onEachNewAttempt (default never); selectCount is a non-negative integer; reorderChildren is a boolean (default false) (${SS}: randomizationType).`,
      constraints: [
        { path: 'randomizationTiming', maxCount: 1, datatype: 'xsd:string', in: RANDOM_TIMINGS, comment: 'randomTimingType (default never)' },
        { path: 'selectCount', maxCount: 1, datatype: ['xsd:nonNegativeInteger', 'xsd:integer'], minInclusive: 0, comment: 'xs:nonNegativeInteger' },
        { path: 'reorderChildren', maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' },
        { path: 'selectionTiming', maxCount: 1, datatype: 'xsd:string', in: RANDOM_TIMINGS, comment: 'randomTimingType (default never)' },
      ],
    },
    {
      name: 'DeliveryControlsShape', targetClass: 'DeliveryControls', label: 'Delivery controls conformance',
      comment: `tracked (default true), completionSetByContent and objectiveSetByContent (default false) are booleans (${SS}: deliveryControlsType).`,
      constraints: [
        { path: 'tracked', maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' },
        { path: 'completionSetByContent', maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' },
        { path: 'objectiveSetByContent', maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' },
      ],
    },
    {
      name: 'AuxiliaryResourceShape', targetClass: 'AuxiliaryResource', label: 'Auxiliary resource conformance',
      comment: `An auxiliary resource has exactly one ID and one purpose (${SS}: auxiliaryResourceType).`,
      constraints: [
        { path: 'auxiliaryResourceID', minCount: 1, maxCount: 1, datatype: 'xsd:anyURI', comment: 'xs:anyURI (required)' },
        { path: 'purpose', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required' },
      ],
    },
    {
      name: 'RollupConsiderationsShape', targetClass: 'RollupConsiderations', label: 'Rollup considerations conformance',
      comment: `The four requiredFor attributes are always, ifAttempted, ifNotSkipped or ifNotSuspended (default always); measureSatisfactionIfActive is a boolean (default true) (${ADLSEQ}: rollupConsiderationsType).`,
      constraints: [
        ...['requiredForSatisfied', 'requiredForNotSatisfied', 'requiredForCompleted', 'requiredForIncomplete'].map(path => ({ path, maxCount: 1, datatype: 'xsd:string', in: ROLLUP_CONSIDERATIONS, comment: 'rollupConsiderationType (default always)' })),
        { path: 'measureSatisfactionIfActive', maxCount: 1, datatype: 'xsd:boolean', comment: 'default true' },
      ],
    },
    {
      name: 'ConstrainedChoiceConsiderationsShape', targetClass: 'ConstrainedChoiceConsiderations', label: 'Constrained choice considerations conformance',
      comment: `preventActivation and constrainChoice are booleans (default false) (${ADLSEQ}: constrainChoiceConsiderationsType).`,
      constraints: [
        { path: 'preventActivation', maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' },
        { path: 'constrainChoice', maxCount: 1, datatype: 'xsd:boolean', comment: 'default false' },
      ],
    },
    {
      name: 'NavigationInterfaceShape', targetClass: 'NavigationInterface', label: 'Navigation interface conformance',
      comment: `Each hideLMSUI value is one of the seven hideable controls (${ADLNAV}: hideLMSUIType).`,
      constraints: [
        { path: 'hideLMSUI', datatype: 'xsd:string', in: HIDE_LMS_UI, comment: 'hideLMSUIType' },
      ],
    },
  ],
};
