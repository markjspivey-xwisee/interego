/**
 * SCORM 2004 4th Edition — Sequencing & Navigation (SN) data model — the single source.
 *
 * Transcribed from the normative IMS Simple Sequencing v1.0 XSD binding (the IMSSS
 * schema SCORM 2004 adopts: imsss_v1p0*.xsd) plus the ADL sequencing and navigation
 * extension schemas (adlseq_v1p3.xsd, adlnav_v1p3.xsd). The <imsss:sequencing>
 * element is attached to CP <item>/<organization> nodes and drives the activity
 * tree's sequencing behaviour (control modes, sequencing rules, limit/rollup rules,
 * objectives, randomization, delivery controls) and the navigation request model.
 *
 * Composed into the PGSL lattice (composeSpecOntology) and projected to OWL/SHACL/
 * JSON-LD on dereference at <bridge>/ns/scorm-sn. The SCORM SN engine validates a
 * parsed manifest's sequencing collection against the SHACL shapes this model
 * publishes (validateAgainstModel) — so a manifest is checked against THIS ontology,
 * and every conformance result cites its shape IRI.
 */
import type { OntologyModel } from '../spec-ontology.js';

export const SCORM_SN_MODEL: OntologyModel = {
  module: 'scorm-sn',
  title: 'SCORM 2004 4th Ed — Sequencing & Navigation (IMSSS + ADL)',
  description:
    'OWL + SHACL ontology of the SCORM 2004 4th Edition Sequencing & Navigation binding: the IMS Simple Sequencing v1.0 schema (Sequencing, ControlMode, SequencingRules with pre/exit/post-condition rules and their RuleConditions, LimitConditions, RollupRules/RollupConditions, Objectives with measure mapping, RandomizationControls, DeliveryControls, AuxiliaryResources) plus the ADL extensions adlseq_v1p3 (rollupConsiderations, constrainedChoiceConsiderations, objectivesGlobalToSystem) and adlnav_v1p3 (presentation / navigationInterface / hideLMSUI). Composed into PGSL and projected here; the SCORM SN runtime validates manifests against the shapes below.',
  version: '1.3.4',
  spec: 'https://adlnet.gov/projects/scorm-2004-4th-edition/',
  prefixes: {
    imsss: 'http://www.imsglobal.org/xsd/imsss#',
    adlseq: 'http://www.adlnet.org/xsd/adlseq_v1p3#',
    adlnav: 'http://www.adlnet.org/xsd/adlnav_v1p3#',
  },
  classes: [
    { name: 'Sequencing', label: 'Sequencing', comment: 'Root sequencing definition (imsss:sequencing / sequencingType) attached to a CP item/organization; aggregates control mode, sequencing rules, limit conditions, rollup rules, objectives, randomization, delivery controls and auxiliary resources. May carry ID and IDRef for the sequencing collection.' },
    { name: 'ControlMode', label: 'Control Mode', comment: 'Non-exclusive set of acceptable control modes for an activity cluster (imsss:controlMode / controlModeType).' },
    { name: 'SequencingRules', label: 'Sequencing Rules', comment: 'Container of pre-condition, exit-condition and post-condition sequencing rules (imsss:sequencingRules / sequencingRulesType).' },
    { name: 'SequencingRule', label: 'Sequencing Rule', comment: 'Abstract base of a sequencing rule: an optional set of rule conditions and a rule action (sequencingRuleType, abstract).' },
    { name: 'PreConditionRule', label: 'Pre-Condition Rule', comment: 'A sequencing rule evaluated before an activity is delivered; its action is from the pre-condition action vocabulary (imsss:preConditionRule / preConditionRuleType).', subClassOf: ['SequencingRule'] },
    { name: 'ExitConditionRule', label: 'Exit-Condition Rule', comment: 'A sequencing rule evaluated when an activity terminates; its action is "exit" (imsss:exitConditionRule / exitConditionRuleType).', subClassOf: ['SequencingRule'] },
    { name: 'PostConditionRule', label: 'Post-Condition Rule', comment: 'A sequencing rule evaluated after an activity terminates; its action is from the post-condition action vocabulary (imsss:postConditionRule / postConditionRuleType).', subClassOf: ['SequencingRule'] },
    { name: 'RuleConditions', label: 'Rule Conditions', comment: 'The set of rule conditions of a sequencing rule, combined by conditionCombination all/any (anonymous ruleConditions complexType).' },
    { name: 'RuleCondition', label: 'Rule Condition', comment: 'A single sequencing rule condition: a condition name, optional not/noOp operator, optional referencedObjective and measureThreshold (anonymous ruleCondition complexType).' },
    { name: 'RuleAction', label: 'Rule Action', comment: 'The action a sequencing rule produces when its conditions evaluate true (anonymous ruleAction complexType, one per rule kind with a constrained action vocabulary).' },
    { name: 'LimitConditions', label: 'Limit Conditions', comment: 'Attempt and duration limit conditions for an activity (imsss:limitConditions / limitConditionsType).' },
    { name: 'RollupRules', label: 'Rollup Rules', comment: 'Container of rollup rules plus the objective/progress rollup and measure-weight controls (imsss:rollupRules / rollupRulesType).' },
    { name: 'RollupRule', label: 'Rollup Rule', comment: 'A single rollup rule: a child-activity set, count/percent bounds, a set of rollup conditions and a rollup action (rollupRuleType).' },
    { name: 'RollupConditions', label: 'Rollup Conditions', comment: 'The set of rollup conditions of a rollup rule, combined by conditionCombination all/any (anonymous rollupConditions complexType).' },
    { name: 'RollupCondition', label: 'Rollup Condition', comment: 'A single rollup condition: a condition name with optional not/noOp operator (anonymous rollupCondition complexType).' },
    { name: 'RollupAction', label: 'Rollup Action', comment: 'The action a rollup rule applies to the parent when its conditions hold (anonymous rollupAction complexType).' },
    { name: 'Objectives', label: 'Objectives', comment: 'The objectives of an activity: exactly one primaryObjective that contributes to rollup plus zero or more non-rollup objectives (imsss:objectives / objectivesType).' },
    { name: 'Objective', label: 'Objective', comment: 'A learning objective with optional minimum normalized measure and objective measure mappings (objectiveType; primaryObjective/objective add objectiveID).' },
    { name: 'ObjectiveMapping', label: 'Objective Mapping', comment: 'Maps a local objective to a global (shared) objective, controlling read/write of satisfied status and normalized measure (imsss:mapInfo / objectiveMappingType).' },
    { name: 'RandomizationControls', label: 'Randomization Controls', comment: 'Controls for selecting and ordering child activities (imsss:randomizationControls / randomizationType).' },
    { name: 'DeliveryControls', label: 'Delivery Controls', comment: 'Controls for how an activity is tracked and whether content sets completion/objective status (imsss:deliveryControls / deliveryControlsType).' },
    { name: 'AuxiliaryResources', label: 'Auxiliary Resources', comment: 'Container of auxiliary resource references available during an activity (imsss:auxiliaryResources / auxiliaryResourcesType).' },
    { name: 'AuxiliaryResource', label: 'Auxiliary Resource', comment: 'A reference to an auxiliary resource with an identifier and a purpose (auxiliaryResourceType).' },
    // ADL adlseq extensions
    { name: 'RollupConsiderations', label: 'Rollup Considerations', comment: 'ADL extension: when an activity is considered for the four rollup actions, and whether measure is included while active (adlseq:rollupConsiderations / rollupConsiderationsType).' },
    { name: 'ConstrainedChoiceConsiderations', label: 'Constrained Choice Considerations', comment: 'ADL extension: constrains choice/activation navigation relative to the current activity (adlseq:constrainedChoiceConsiderations / constrainChoiceConsiderationsType).' },
    // ADL adlnav extensions
    { name: 'Presentation', label: 'Presentation', comment: 'ADL navigation extension: presentation settings for an activity, containing the navigation interface (adlnav:presentation / presentationType).' },
    { name: 'NavigationInterface', label: 'Navigation Interface', comment: 'ADL navigation extension: which LMS-provided UI navigation controls to hide for an activity (adlnav:navigationInterface / navigationInterfaceType).' },
  ],
  properties: [
    // Sequencing root
    { name: 'seqID', kind: 'datatype', label: 'ID', comment: 'xs:ID of a sequencing definition in the sequencing collection (sequencingType/@ID).', domain: 'Sequencing', range: 'xsd:string' },
    { name: 'seqIDRef', kind: 'datatype', label: 'IDRef', comment: 'xs:IDREF to a sequencing definition in the sequencing collection (sequencingType/@IDRef).', domain: 'Sequencing', range: 'xsd:string' },
    { name: 'controlMode', kind: 'object', label: 'controlMode', comment: 'The control mode of the sequencing definition (sequencingType/controlMode).', domain: 'Sequencing', range: 'ControlMode' },
    { name: 'sequencingRules', kind: 'object', label: 'sequencingRules', comment: 'The sequencing rules (sequencingType/sequencingRules).', domain: 'Sequencing', range: 'SequencingRules' },
    { name: 'limitConditions', kind: 'object', label: 'limitConditions', comment: 'The limit conditions (sequencingType/limitConditions).', domain: 'Sequencing', range: 'LimitConditions' },
    { name: 'auxiliaryResources', kind: 'object', label: 'auxiliaryResources', comment: 'The auxiliary resources (sequencingType/auxiliaryResources).', domain: 'Sequencing', range: 'AuxiliaryResources' },
    { name: 'rollupRules', kind: 'object', label: 'rollupRules', comment: 'The rollup rules (sequencingType/rollupRules).', domain: 'Sequencing', range: 'RollupRules' },
    { name: 'objectives', kind: 'object', label: 'objectives', comment: 'The objectives (sequencingType/objectives).', domain: 'Sequencing', range: 'Objectives' },
    { name: 'randomizationControls', kind: 'object', label: 'randomizationControls', comment: 'The randomization controls (sequencingType/randomizationControls).', domain: 'Sequencing', range: 'RandomizationControls' },
    { name: 'deliveryControls', kind: 'object', label: 'deliveryControls', comment: 'The delivery controls (sequencingType/deliveryControls).', domain: 'Sequencing', range: 'DeliveryControls' },
    { name: 'rollupConsiderations', kind: 'object', label: 'rollupConsiderations', comment: 'ADL extension: rollup considerations of the sequencing definition (adlseq:rollupConsiderations).', domain: 'Sequencing', range: 'RollupConsiderations' },
    { name: 'constrainedChoiceConsiderations', kind: 'object', label: 'constrainedChoiceConsiderations', comment: 'ADL extension: constrained choice considerations of the sequencing definition (adlseq:constrainedChoiceConsiderations).', domain: 'Sequencing', range: 'ConstrainedChoiceConsiderations' },
    { name: 'adlObjectives', kind: 'object', label: 'adlseq objectives', comment: 'ADL extension: additional adlseq objectives container of the sequencing definition (adlseq objectives, mapping local to global objectives with the same objectiveType/mapInfo structure).', domain: 'Sequencing', range: 'Objectives' },
    { name: 'presentation', kind: 'object', label: 'presentation', comment: 'ADL navigation extension: presentation settings of the sequencing definition (adlnav:presentation).', domain: 'Sequencing', range: 'Presentation' },
    { name: 'objectivesGlobalToSystem', kind: 'datatype', label: 'objectivesGlobalToSystem', comment: 'ADL extension attribute on a CP item: whether global objectives are shared system-wide (true) or per-learner-per-course (false). Default true (adlseq:objectivesGlobalToSystem).', domain: 'Sequencing', range: 'xsd:boolean' },
    // ControlMode (controlModeType)
    { name: 'choice', kind: 'datatype', label: 'choice', comment: 'Whether the learner may freely choose any child activity. Default true (controlModeType/@choice).', domain: 'ControlMode', range: 'xsd:boolean' },
    { name: 'choiceExit', kind: 'datatype', label: 'choiceExit', comment: 'Whether a choice navigation request may terminate the activity. Default true (controlModeType/@choiceExit).', domain: 'ControlMode', range: 'xsd:boolean' },
    { name: 'flow', kind: 'datatype', label: 'flow', comment: 'Whether flow (continue/previous) navigation is permitted through the children. Default false (controlModeType/@flow).', domain: 'ControlMode', range: 'xsd:boolean' },
    { name: 'forwardOnly', kind: 'datatype', label: 'forwardOnly', comment: 'Whether backward (previous) flow traversal is prohibited. Default false (controlModeType/@forwardOnly).', domain: 'ControlMode', range: 'xsd:boolean' },
    { name: 'useCurrentAttemptObjectiveInfo', kind: 'datatype', label: 'useCurrentAttemptObjectiveInfo', comment: 'Whether only current-attempt objective info is used in sequencing for the children. Default true (controlModeType/@useCurrentAttemptObjectiveInfo).', domain: 'ControlMode', range: 'xsd:boolean' },
    { name: 'useCurrentAttemptProgressInfo', kind: 'datatype', label: 'useCurrentAttemptProgressInfo', comment: 'Whether only current-attempt progress info is used in sequencing for the children. Default true (controlModeType/@useCurrentAttemptProgressInfo).', domain: 'ControlMode', range: 'xsd:boolean' },
    // SequencingRules
    { name: 'preConditionRule', kind: 'object', label: 'preConditionRule', comment: 'A pre-condition rule (sequencingRulesType/preConditionRule).', domain: 'SequencingRules', range: 'PreConditionRule' },
    { name: 'exitConditionRule', kind: 'object', label: 'exitConditionRule', comment: 'An exit-condition rule (sequencingRulesType/exitConditionRule).', domain: 'SequencingRules', range: 'ExitConditionRule' },
    { name: 'postConditionRule', kind: 'object', label: 'postConditionRule', comment: 'A post-condition rule (sequencingRulesType/postConditionRule).', domain: 'SequencingRules', range: 'PostConditionRule' },
    // SequencingRule -> conditions + action
    { name: 'ruleConditions', kind: 'object', label: 'ruleConditions', comment: 'The optional set of conditions of a sequencing rule (sequencingRuleType/ruleConditions).', domain: 'SequencingRule', range: 'RuleConditions' },
    { name: 'ruleAction', kind: 'object', label: 'ruleAction', comment: 'The action of a sequencing rule (sequencingRuleType extension/ruleAction).', domain: 'SequencingRule', range: 'RuleAction' },
    // RuleConditions / RuleCondition
    { name: 'ruleConditionCombination', kind: 'datatype', label: 'conditionCombination', comment: 'How the rule conditions are combined: all/any. Default all for sequencing rules (ruleConditions/@conditionCombination).', domain: 'RuleConditions', range: 'xsd:string' },
    { name: 'ruleCondition', kind: 'object', label: 'ruleCondition', comment: 'A single rule condition (ruleConditions/ruleCondition).', domain: 'RuleConditions', range: 'RuleCondition' },
    { name: 'referencedObjective', kind: 'datatype', label: 'referencedObjective', comment: 'IRI of the objective the condition refers to (ruleCondition/@referencedObjective).', domain: 'RuleCondition', range: 'xsd:anyURI' },
    { name: 'measureThreshold', kind: 'datatype', label: 'measureThreshold', comment: 'Normalized measure threshold in [-1,1] used by measure-comparison conditions (ruleCondition/@measureThreshold, measureType).', domain: 'RuleCondition', range: 'xsd:decimal' },
    { name: 'conditionOperator', kind: 'datatype', label: 'operator', comment: 'Whether the condition is negated: not / noOp. Default noOp (ruleCondition/@operator, conditionOperatorType).', domain: 'RuleCondition', range: 'xsd:string' },
    { name: 'ruleConditionName', kind: 'datatype', label: 'condition', comment: 'The named sequencing rule condition (ruleCondition/@condition, sequencingRuleConditionType). Required.', domain: 'RuleCondition', range: 'xsd:string' },
    // RuleAction
    { name: 'ruleActionValue', kind: 'datatype', label: 'action', comment: 'The action token of a sequencing rule, constrained per rule kind (pre/exit/post). Required (ruleAction/@action).', domain: 'RuleAction', range: 'xsd:string' },
    // LimitConditions (limitConditionsType)
    { name: 'attemptLimit', kind: 'datatype', label: 'attemptLimit', comment: 'Maximum number of attempts on the activity (limitConditionsType/@attemptLimit).', domain: 'LimitConditions', range: 'xsd:nonNegativeInteger' },
    { name: 'attemptAbsoluteDurationLimit', kind: 'datatype', label: 'attemptAbsoluteDurationLimit', comment: 'Maximum absolute (wall-clock) duration of a single attempt (limitConditionsType/@attemptAbsoluteDurationLimit, xs:duration).', domain: 'LimitConditions', range: 'xsd:duration' },
    { name: 'attemptExperiencedDurationLimit', kind: 'datatype', label: 'attemptExperiencedDurationLimit', comment: 'Maximum experienced (active) duration of a single attempt (limitConditionsType/@attemptExperiencedDurationLimit, xs:duration).', domain: 'LimitConditions', range: 'xsd:duration' },
    { name: 'activityAbsoluteDurationLimit', kind: 'datatype', label: 'activityAbsoluteDurationLimit', comment: 'Maximum absolute duration accumulated across attempts on the activity (limitConditionsType/@activityAbsoluteDurationLimit, xs:duration).', domain: 'LimitConditions', range: 'xsd:duration' },
    { name: 'activityExperiencedDurationLimit', kind: 'datatype', label: 'activityExperiencedDurationLimit', comment: 'Maximum experienced duration accumulated across attempts on the activity (limitConditionsType/@activityExperiencedDurationLimit, xs:duration).', domain: 'LimitConditions', range: 'xsd:duration' },
    { name: 'beginTimeLimit', kind: 'datatype', label: 'beginTimeLimit', comment: 'Earliest time the activity may begin (limitConditionsType/@beginTimeLimit, xs:dateTime).', domain: 'LimitConditions', range: 'xsd:dateTime' },
    { name: 'endTimeLimit', kind: 'datatype', label: 'endTimeLimit', comment: 'Latest time the activity may be delivered (limitConditionsType/@endTimeLimit, xs:dateTime).', domain: 'LimitConditions', range: 'xsd:dateTime' },
    // RollupRules (rollupRulesType)
    { name: 'rollupRule', kind: 'object', label: 'rollupRule', comment: 'A single rollup rule (rollupRulesType/rollupRule).', domain: 'RollupRules', range: 'RollupRule' },
    { name: 'rollupObjectiveSatisfied', kind: 'datatype', label: 'rollupObjectiveSatisfied', comment: 'Whether the activity contributes to its parent objective satisfaction rollup. Default true (rollupRulesType/@rollupObjectiveSatisfied).', domain: 'RollupRules', range: 'xsd:boolean' },
    { name: 'rollupProgressCompletion', kind: 'datatype', label: 'rollupProgressCompletion', comment: 'Whether the activity contributes to its parent progress/completion rollup. Default true (rollupRulesType/@rollupProgressCompletion).', domain: 'RollupRules', range: 'xsd:boolean' },
    { name: 'objectiveMeasureWeight', kind: 'datatype', label: 'objectiveMeasureWeight', comment: 'Weight of this activity measure in the parent rollup measure, in [0,1]. Default 1.0000 (rollupRulesType/@objectiveMeasureWeight, weightType).', domain: 'RollupRules', range: 'xsd:decimal' },
    // RollupRule (rollupRuleType)
    { name: 'childActivitySet', kind: 'datatype', label: 'childActivitySet', comment: 'Which children the rollup rule considers: all/any/none/atLeastCount/atLeastPercent. Default all (rollupRuleType/@childActivitySet, childActivityType).', domain: 'RollupRule', range: 'xsd:string' },
    { name: 'minimumCount', kind: 'datatype', label: 'minimumCount', comment: 'Minimum number of children for the atLeastCount set. Default 0 (rollupRuleType/@minimumCount).', domain: 'RollupRule', range: 'xsd:nonNegativeInteger' },
    { name: 'minimumPercent', kind: 'datatype', label: 'minimumPercent', comment: 'Minimum fraction of children for the atLeastPercent set, in [0,1]. Default 0 (rollupRuleType/@minimumPercent, percentType).', domain: 'RollupRule', range: 'xsd:decimal' },
    { name: 'rollupConditions', kind: 'object', label: 'rollupConditions', comment: 'The rollup conditions of the rule (rollupRuleType/rollupConditions).', domain: 'RollupRule', range: 'RollupConditions' },
    { name: 'rollupActionEl', kind: 'object', label: 'rollupAction', comment: 'The action of the rollup rule (rollupRuleType/rollupAction).', domain: 'RollupRule', range: 'RollupAction' },
    // RollupConditions / RollupCondition
    { name: 'rollupConditionCombination', kind: 'datatype', label: 'conditionCombination', comment: 'How the rollup conditions are combined: all/any. Default any (rollupConditions/@conditionCombination).', domain: 'RollupConditions', range: 'xsd:string' },
    { name: 'rollupCondition', kind: 'object', label: 'rollupCondition', comment: 'A single rollup condition (rollupConditions/rollupCondition).', domain: 'RollupConditions', range: 'RollupCondition' },
    { name: 'rollupConditionOperator', kind: 'datatype', label: 'operator', comment: 'Whether the rollup condition is negated: not / noOp. Default noOp (rollupCondition/@operator, conditionOperatorType).', domain: 'RollupCondition', range: 'xsd:string' },
    { name: 'rollupConditionName', kind: 'datatype', label: 'condition', comment: 'The named rollup condition (rollupCondition/@condition, rollupRuleConditionType). Required.', domain: 'RollupCondition', range: 'xsd:string' },
    // RollupAction
    { name: 'rollupActionValue', kind: 'datatype', label: 'action', comment: 'The rollup action applied to the parent: satisfied/notSatisfied/completed/incomplete. Required (rollupAction/@action, rollupActionType).', domain: 'RollupAction', range: 'xsd:string' },
    // Objectives / Objective / ObjectiveMapping
    { name: 'primaryObjective', kind: 'object', label: 'primaryObjective', comment: 'The single objective that contributes to activity rollup (objectivesType/primaryObjective). Its objectiveID is optional.', domain: 'Objectives', range: 'Objective' },
    { name: 'objective', kind: 'object', label: 'objective', comment: 'An objective that does not contribute to activity rollup (objectivesType/objective). Its objectiveID is required.', domain: 'Objectives', range: 'Objective' },
    { name: 'objectiveID', kind: 'datatype', label: 'objectiveID', comment: 'Identifier (IRI/GUID) of the objective (primaryObjective/objective @objectiveID, xs:anyURI).', domain: 'Objective', range: 'xsd:anyURI' },
    { name: 'satisfiedByMeasure', kind: 'datatype', label: 'satisfiedByMeasure', comment: 'Whether objective satisfaction is determined by the normalized measure against minNormalizedMeasure. Default false (objectiveType/@satisfiedByMeasure).', domain: 'Objective', range: 'xsd:boolean' },
    { name: 'minNormalizedMeasure', kind: 'datatype', label: 'minNormalizedMeasure', comment: 'Minimum normalized measure required for satisfaction, in [-1,1]. Default 1.00000 (objectiveType/minNormalizedMeasure, measureType).', domain: 'Objective', range: 'xsd:decimal' },
    { name: 'mapInfo', kind: 'object', label: 'mapInfo', comment: 'A mapping of this local objective to a global objective (objectiveType/mapInfo).', domain: 'Objective', range: 'ObjectiveMapping' },
    { name: 'targetObjectiveID', kind: 'datatype', label: 'targetObjectiveID', comment: 'Identifier (IRI/GUID) of the global objective mapped to. Required (objectiveMappingType/@targetObjectiveID, xs:anyURI).', domain: 'ObjectiveMapping', range: 'xsd:anyURI' },
    { name: 'readSatisfiedStatus', kind: 'datatype', label: 'readSatisfiedStatus', comment: 'Whether the local objective reads satisfied status from the global objective. Default true (objectiveMappingType/@readSatisfiedStatus).', domain: 'ObjectiveMapping', range: 'xsd:boolean' },
    { name: 'readNormalizedMeasure', kind: 'datatype', label: 'readNormalizedMeasure', comment: 'Whether the local objective reads normalized measure from the global objective. Default true (objectiveMappingType/@readNormalizedMeasure).', domain: 'ObjectiveMapping', range: 'xsd:boolean' },
    { name: 'writeSatisfiedStatus', kind: 'datatype', label: 'writeSatisfiedStatus', comment: 'Whether the local objective writes satisfied status to the global objective. Default false (objectiveMappingType/@writeSatisfiedStatus).', domain: 'ObjectiveMapping', range: 'xsd:boolean' },
    { name: 'writeNormalizedMeasure', kind: 'datatype', label: 'writeNormalizedMeasure', comment: 'Whether the local objective writes normalized measure to the global objective. Default false (objectiveMappingType/@writeNormalizedMeasure).', domain: 'ObjectiveMapping', range: 'xsd:boolean' },
    // RandomizationControls (randomizationType)
    { name: 'randomizationTiming', kind: 'datatype', label: 'randomizationTiming', comment: 'When children are reordered: never/once/onEachNewAttempt. Default never (randomizationType/@randomizationTiming, randomTimingType).', domain: 'RandomizationControls', range: 'xsd:string' },
    { name: 'selectCount', kind: 'datatype', label: 'selectCount', comment: 'Number of child activities to select (randomizationType/@selectCount).', domain: 'RandomizationControls', range: 'xsd:nonNegativeInteger' },
    { name: 'reorderChildren', kind: 'datatype', label: 'reorderChildren', comment: 'Whether children are reordered when randomization is applied. Default false (randomizationType/@reorderChildren).', domain: 'RandomizationControls', range: 'xsd:boolean' },
    { name: 'selectionTiming', kind: 'datatype', label: 'selectionTiming', comment: 'When the child subset is selected: never/once/onEachNewAttempt. Default never (randomizationType/@selectionTiming, randomTimingType).', domain: 'RandomizationControls', range: 'xsd:string' },
    // DeliveryControls (deliveryControlsType)
    { name: 'tracked', kind: 'datatype', label: 'tracked', comment: 'Whether the activity is tracked for sequencing/rollup. Default true (deliveryControlsType/@tracked).', domain: 'DeliveryControls', range: 'xsd:boolean' },
    { name: 'completionSetByContent', kind: 'datatype', label: 'completionSetByContent', comment: 'Whether completion status is set by the content (SCO) rather than the LMS. Default false (deliveryControlsType/@completionSetByContent).', domain: 'DeliveryControls', range: 'xsd:boolean' },
    { name: 'objectiveSetByContent', kind: 'datatype', label: 'objectiveSetByContent', comment: 'Whether the primary objective satisfied status is set by the content rather than the LMS. Default false (deliveryControlsType/@objectiveSetByContent).', domain: 'DeliveryControls', range: 'xsd:boolean' },
    // AuxiliaryResources
    { name: 'auxiliaryResource', kind: 'object', label: 'auxiliaryResource', comment: 'An auxiliary resource reference (auxiliaryResourcesType/auxiliaryResource).', domain: 'AuxiliaryResources', range: 'AuxiliaryResource' },
    { name: 'auxiliaryResourceID', kind: 'datatype', label: 'auxiliaryResourceID', comment: 'Identifier (IRI) of the auxiliary resource. Required (auxiliaryResourceType/@auxiliaryResourceID, xs:anyURI).', domain: 'AuxiliaryResource', range: 'xsd:anyURI' },
    { name: 'purpose', kind: 'datatype', label: 'purpose', comment: 'The purpose of the auxiliary resource. Required (auxiliaryResourceType/@purpose).', domain: 'AuxiliaryResource', range: 'xsd:string' },
    // ADL adlseq: RollupConsiderations (rollupConsiderationsType)
    { name: 'requiredForSatisfied', kind: 'datatype', label: 'requiredForSatisfied', comment: 'When the activity must be evaluated before a "satisfied" rollup: always/ifAttempted/ifNotSkipped/ifNotSuspended. Default always (rollupConsiderationsType/@requiredForSatisfied).', domain: 'RollupConsiderations', range: 'xsd:string' },
    { name: 'requiredForNotSatisfied', kind: 'datatype', label: 'requiredForNotSatisfied', comment: 'When the activity must be evaluated before a "not satisfied" rollup. Default always (rollupConsiderationsType/@requiredForNotSatisfied).', domain: 'RollupConsiderations', range: 'xsd:string' },
    { name: 'requiredForCompleted', kind: 'datatype', label: 'requiredForCompleted', comment: 'When the activity must be evaluated before a "completed" rollup. Default always (rollupConsiderationsType/@requiredForCompleted).', domain: 'RollupConsiderations', range: 'xsd:string' },
    { name: 'requiredForIncomplete', kind: 'datatype', label: 'requiredForIncomplete', comment: 'When the activity must be evaluated before an "incomplete" rollup. Default always (rollupConsiderationsType/@requiredForIncomplete).', domain: 'RollupConsiderations', range: 'xsd:string' },
    { name: 'measureSatisfactionIfActive', kind: 'datatype', label: 'measureSatisfactionIfActive', comment: 'Whether measure-based satisfaction is evaluated while the activity is active. Default true (rollupConsiderationsType/@measureSatisfactionIfActive).', domain: 'RollupConsiderations', range: 'xsd:boolean' },
    // ADL adlseq: ConstrainedChoiceConsiderations (constrainChoiceConsiderationsType)
    { name: 'preventActivation', kind: 'datatype', label: 'preventActivation', comment: 'Whether choosing a descendant that would activate this cluster out of flow order is prevented. Default false (constrainChoiceConsiderationsType/@preventActivation).', domain: 'ConstrainedChoiceConsiderations', range: 'xsd:boolean' },
    { name: 'constrainChoice', kind: 'datatype', label: 'constrainChoice', comment: 'Whether choice navigation is constrained to the flow-adjacent activities. Default false (constrainChoiceConsiderationsType/@constrainChoice).', domain: 'ConstrainedChoiceConsiderations', range: 'xsd:boolean' },
    // ADL adlnav: Presentation / NavigationInterface
    { name: 'navigationInterface', kind: 'object', label: 'navigationInterface', comment: 'The navigation interface settings (presentationType/navigationInterface).', domain: 'Presentation', range: 'NavigationInterface' },
    { name: 'hideLMSUI', kind: 'datatype', label: 'hideLMSUI', comment: 'An LMS-provided navigation control to hide for the activity: previous/continue/exit/exitAll/abandon/abandonAll/suspendAll (navigationInterfaceType/hideLMSUI, hideLMSUIType). Repeatable.', domain: 'NavigationInterface', range: 'xsd:string' },
  ],
  vocabularies: [
    {
      name: 'SequencingRuleConditionName', label: 'Sequencing Rule Conditions', comment: 'The condition vocabulary for sequencing (pre/exit/post) rule conditions (sequencingRuleConditionType).',
      members: [
        { name: 'satisfied', label: 'satisfied' },
        { name: 'objectiveStatusKnown', label: 'objectiveStatusKnown' },
        { name: 'objectiveMeasureKnown', label: 'objectiveMeasureKnown' },
        { name: 'objectiveMeasureGreaterThan', label: 'objectiveMeasureGreaterThan' },
        { name: 'objectiveMeasureLessThan', label: 'objectiveMeasureLessThan' },
        { name: 'completed', label: 'completed' },
        { name: 'activityProgressKnown', label: 'activityProgressKnown' },
        { name: 'attempted', label: 'attempted' },
        { name: 'attemptLimitExceeded', label: 'attemptLimitExceeded' },
        { name: 'timeLimitExceeded', label: 'timeLimitExceeded' },
        { name: 'outsideAvailableTimeRange', label: 'outsideAvailableTimeRange' },
        { name: 'always', label: 'always' },
      ],
    },
    {
      name: 'RollupRuleConditionName', label: 'Rollup Rule Conditions', comment: 'The condition vocabulary for rollup rule conditions (rollupRuleConditionType) — the sequencing-condition set minus the measure-comparison and always conditions.',
      members: [
        { name: 'satisfied', label: 'satisfied' },
        { name: 'objectiveStatusKnown', label: 'objectiveStatusKnown' },
        { name: 'objectiveMeasureKnown', label: 'objectiveMeasureKnown' },
        { name: 'completed', label: 'completed' },
        { name: 'activityProgressKnown', label: 'activityProgressKnown' },
        { name: 'attempted', label: 'attempted' },
        { name: 'attemptLimitExceeded', label: 'attemptLimitExceeded' },
        { name: 'timeLimitExceeded', label: 'timeLimitExceeded' },
        { name: 'outsideAvailableTimeRange', label: 'outsideAvailableTimeRange' },
      ],
    },
    {
      name: 'ConditionOperator', label: 'Condition Operator', comment: 'Negation operator on a rule condition (conditionOperatorType).',
      members: [
        { name: 'not', label: 'not' },
        { name: 'noOp', label: 'noOp' },
      ],
    },
    {
      name: 'ConditionCombination', label: 'Condition Combination', comment: 'How a rule\'s conditions are combined (conditionCombinationType).',
      members: [
        { name: 'all', label: 'all' },
        { name: 'any', label: 'any' },
      ],
    },
    {
      name: 'PreConditionRuleAction', label: 'Pre-Condition Rule Actions', comment: 'The action vocabulary for pre-condition sequencing rules (preConditionRuleActionType).',
      members: [
        { name: 'skip', label: 'skip' },
        { name: 'disabled', label: 'disabled' },
        { name: 'hiddenFromChoice', label: 'hiddenFromChoice' },
        { name: 'stopForwardTraversal', label: 'stopForwardTraversal' },
      ],
    },
    {
      name: 'ExitConditionRuleAction', label: 'Exit-Condition Rule Actions', comment: 'The action vocabulary for exit-condition sequencing rules (exitConditionRuleActionType).',
      members: [
        { name: 'exit', label: 'exit' },
      ],
    },
    {
      name: 'PostConditionRuleAction', label: 'Post-Condition Rule Actions', comment: 'The action vocabulary for post-condition sequencing rules (postConditionRuleActionType).',
      members: [
        { name: 'exitParent', label: 'exitParent' },
        { name: 'exitAll', label: 'exitAll' },
        { name: 'retry', label: 'retry' },
        { name: 'retryAll', label: 'retryAll' },
        { name: 'continue', label: 'continue' },
        { name: 'previous', label: 'previous' },
      ],
    },
    {
      name: 'RollupAction', label: 'Rollup Actions', comment: 'The action vocabulary applied to a parent by a rollup rule (rollupActionType).',
      members: [
        { name: 'satisfied', label: 'satisfied' },
        { name: 'notSatisfied', label: 'notSatisfied' },
        { name: 'completed', label: 'completed' },
        { name: 'incomplete', label: 'incomplete' },
      ],
    },
    {
      name: 'ChildActivitySet', label: 'Child Activity Set', comment: 'Which subset of children a rollup rule considers (childActivityType).',
      members: [
        { name: 'all', label: 'all' },
        { name: 'any', label: 'any' },
        { name: 'none', label: 'none' },
        { name: 'atLeastCount', label: 'atLeastCount' },
        { name: 'atLeastPercent', label: 'atLeastPercent' },
      ],
    },
    {
      name: 'RandomTiming', label: 'Randomization / Selection Timing', comment: 'When selection or reordering of children occurs (randomTimingType).',
      members: [
        { name: 'never', label: 'never' },
        { name: 'once', label: 'once' },
        { name: 'onEachNewAttempt', label: 'onEachNewAttempt' },
      ],
    },
    {
      name: 'RollupConsideration', label: 'Rollup Consideration', comment: 'ADL extension: when an activity is included in a rollup action (rollupConsiderationType).',
      members: [
        { name: 'always', label: 'always' },
        { name: 'ifAttempted', label: 'ifAttempted' },
        { name: 'ifNotSkipped', label: 'ifNotSkipped' },
        { name: 'ifNotSuspended', label: 'ifNotSuspended' },
      ],
    },
    {
      name: 'HideLMSUI', label: 'Hide LMS UI Controls', comment: 'ADL navigation extension: LMS-provided navigation controls that may be hidden (hideLMSUIType).',
      members: [
        { name: 'previous', label: 'previous' },
        { name: 'continue', label: 'continue' },
        { name: 'exit', label: 'exit' },
        { name: 'exitAll', label: 'exitAll' },
        { name: 'abandon', label: 'abandon' },
        { name: 'abandonAll', label: 'abandonAll' },
        { name: 'suspendAll', label: 'suspendAll' },
      ],
    },
  ],
  shapes: [
    {
      name: 'ControlModeShape', targetClass: 'ControlMode', label: 'ControlMode conformance',
      comment: 'controlModeType: each control flag is at most one boolean (defaults choice/choiceExit/useCurrent*=true, flow/forwardOnly=false).',
      constraints: [
        { path: 'choice', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'choiceExit', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'flow', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'forwardOnly', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'useCurrentAttemptObjectiveInfo', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'useCurrentAttemptProgressInfo', maxCount: 1, datatype: 'xsd:boolean' },
      ],
    },
    {
      name: 'RuleConditionShape', targetClass: 'RuleCondition', label: 'Sequencing rule condition conformance',
      comment: 'ruleCondition: condition is required and from sequencingRuleConditionType; operator from conditionOperatorType; measureThreshold ∈ [-1,1]; referencedObjective is an IRI.',
      constraints: [
        { path: 'ruleConditionName', minCount: 1, maxCount: 1, in: ['satisfied', 'objectiveStatusKnown', 'objectiveMeasureKnown', 'objectiveMeasureGreaterThan', 'objectiveMeasureLessThan', 'completed', 'activityProgressKnown', 'attempted', 'attemptLimitExceeded', 'timeLimitExceeded', 'outsideAvailableTimeRange', 'always'], comment: 'sequencingRuleConditionType (required)' },
        { path: 'conditionOperator', maxCount: 1, in: ['not', 'noOp'], comment: 'conditionOperatorType (default noOp)' },
        { path: 'measureThreshold', maxCount: 1, datatype: 'xsd:decimal', minInclusive: -1, maxInclusive: 1, comment: 'measureType ∈ [-1,1]' },
        { path: 'referencedObjective', maxCount: 1, nodeKind: 'IRI', comment: 'xs:anyURI' },
      ],
    },
    {
      name: 'RuleConditionsShape', targetClass: 'RuleConditions', label: 'Sequencing rule conditions conformance',
      comment: 'ruleConditions: conditionCombination is all/any (default all); at least one ruleCondition (maxOccurs unbounded).',
      constraints: [
        { path: 'ruleConditionCombination', maxCount: 1, in: ['all', 'any'], comment: 'conditionCombinationType (default all)' },
        { path: 'ruleCondition', minCount: 1, comment: 'one or more ruleCondition' },
      ],
    },
    {
      name: 'PreConditionRuleActionShape', targetClass: 'PreConditionRule', label: 'Pre-condition rule action conformance',
      comment: 'preConditionRule/ruleAction/@action MUST be one of preConditionRuleActionType.',
      constraints: [
        { path: 'ruleAction', minCount: 1, maxCount: 1, comment: 'exactly one ruleAction' },
      ],
    },
    {
      name: 'PostConditionRuleActionShape', targetClass: 'PostConditionRule', label: 'Post-condition rule action conformance',
      comment: 'postConditionRule/ruleAction/@action MUST be one of postConditionRuleActionType.',
      constraints: [
        { path: 'ruleAction', minCount: 1, maxCount: 1, comment: 'exactly one ruleAction' },
      ],
    },
    {
      name: 'ExitConditionRuleActionShape', targetClass: 'ExitConditionRule', label: 'Exit-condition rule action conformance',
      comment: 'exitConditionRule/ruleAction/@action MUST be "exit" (exitConditionRuleActionType).',
      constraints: [
        { path: 'ruleAction', minCount: 1, maxCount: 1, comment: 'exactly one ruleAction' },
      ],
    },
    {
      name: 'RuleActionShape', targetClass: 'RuleAction', label: 'Rule action conformance',
      comment: 'ruleAction/@action is required; the union of all permitted sequencing rule action tokens (pre/exit/post) — the rule kind narrows it further via its rule-specific shape.',
      constraints: [
        { path: 'ruleActionValue', minCount: 1, maxCount: 1, in: ['skip', 'disabled', 'hiddenFromChoice', 'stopForwardTraversal', 'exit', 'exitParent', 'exitAll', 'retry', 'retryAll', 'continue', 'previous'], comment: 'pre/exit/post action vocabularies (required)' },
      ],
    },
    {
      name: 'LimitConditionsShape', targetClass: 'LimitConditions', label: 'Limit conditions conformance',
      comment: 'limitConditionsType: attemptLimit is a non-negative integer; the four duration limits are xs:duration; begin/end time limits are xs:dateTime.',
      constraints: [
        { path: 'attemptLimit', maxCount: 1, datatype: 'xsd:nonNegativeInteger' },
        { path: 'attemptAbsoluteDurationLimit', maxCount: 1, datatype: 'xsd:duration' },
        { path: 'attemptExperiencedDurationLimit', maxCount: 1, datatype: 'xsd:duration' },
        { path: 'activityAbsoluteDurationLimit', maxCount: 1, datatype: 'xsd:duration' },
        { path: 'activityExperiencedDurationLimit', maxCount: 1, datatype: 'xsd:duration' },
        { path: 'beginTimeLimit', maxCount: 1, datatype: 'xsd:dateTime' },
        { path: 'endTimeLimit', maxCount: 1, datatype: 'xsd:dateTime' },
      ],
    },
    {
      name: 'RollupRulesShape', targetClass: 'RollupRules', label: 'Rollup rules conformance',
      comment: 'rollupRulesType: objectiveMeasureWeight (weightType) ∈ [0,1] default 1.0000; rollup flags are booleans (default true).',
      constraints: [
        { path: 'rollupObjectiveSatisfied', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'rollupProgressCompletion', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'objectiveMeasureWeight', maxCount: 1, datatype: 'xsd:decimal', minInclusive: 0, maxInclusive: 1, comment: 'weightType ∈ [0,1]' },
      ],
    },
    {
      name: 'RollupRuleShape', targetClass: 'RollupRule', label: 'Rollup rule conformance',
      comment: 'rollupRuleType: childActivitySet from childActivityType (default all); minimumCount non-negative integer (default 0); minimumPercent ∈ [0,1] (percentType, default 0); exactly one rollupConditions and one rollupAction.',
      constraints: [
        { path: 'childActivitySet', maxCount: 1, in: ['all', 'any', 'none', 'atLeastCount', 'atLeastPercent'], comment: 'childActivityType (default all)' },
        { path: 'minimumCount', maxCount: 1, datatype: 'xsd:nonNegativeInteger' },
        { path: 'minimumPercent', maxCount: 1, datatype: 'xsd:decimal', minInclusive: 0, maxInclusive: 1, comment: 'percentType ∈ [0,1]' },
        { path: 'rollupConditions', minCount: 1, maxCount: 1, comment: 'exactly one rollupConditions' },
        { path: 'rollupActionEl', minCount: 1, maxCount: 1, comment: 'exactly one rollupAction' },
      ],
    },
    {
      name: 'RollupConditionsShape', targetClass: 'RollupConditions', label: 'Rollup conditions conformance',
      comment: 'rollupConditions: conditionCombination all/any (default any); at least one rollupCondition (maxOccurs unbounded).',
      constraints: [
        { path: 'rollupConditionCombination', maxCount: 1, in: ['all', 'any'], comment: 'conditionCombinationType (default any)' },
        { path: 'rollupCondition', minCount: 1, comment: 'one or more rollupCondition' },
      ],
    },
    {
      name: 'RollupConditionShape', targetClass: 'RollupCondition', label: 'Rollup condition conformance',
      comment: 'rollupCondition: condition required and from rollupRuleConditionType; operator from conditionOperatorType (default noOp).',
      constraints: [
        { path: 'rollupConditionName', minCount: 1, maxCount: 1, in: ['satisfied', 'objectiveStatusKnown', 'objectiveMeasureKnown', 'completed', 'activityProgressKnown', 'attempted', 'attemptLimitExceeded', 'timeLimitExceeded', 'outsideAvailableTimeRange'], comment: 'rollupRuleConditionType (required)' },
        { path: 'rollupConditionOperator', maxCount: 1, in: ['not', 'noOp'], comment: 'conditionOperatorType (default noOp)' },
      ],
    },
    {
      name: 'RollupActionShape', targetClass: 'RollupAction', label: 'Rollup action conformance',
      comment: 'rollupAction/@action MUST be one of rollupActionType (satisfied/notSatisfied/completed/incomplete) and is required.',
      constraints: [
        { path: 'rollupActionValue', minCount: 1, maxCount: 1, in: ['satisfied', 'notSatisfied', 'completed', 'incomplete'], comment: 'rollupActionType (required)' },
      ],
    },
    {
      name: 'ObjectivesShape', targetClass: 'Objectives', label: 'Objectives conformance',
      comment: 'objectivesType: exactly one primaryObjective (contributes to rollup); zero or more objective (do not contribute to rollup).',
      constraints: [
        { path: 'primaryObjective', minCount: 1, maxCount: 1, comment: 'exactly one primaryObjective' },
        { path: 'objective', comment: 'zero or more objective' },
      ],
    },
    {
      name: 'ObjectiveShape', targetClass: 'Objective', label: 'Objective conformance',
      comment: 'objectiveType: objectiveID is an IRI; satisfiedByMeasure boolean (default false); minNormalizedMeasure ∈ [-1,1] (measureType, default 1.00000).',
      constraints: [
        { path: 'objectiveID', maxCount: 1, nodeKind: 'IRI', comment: 'xs:anyURI (required on non-primary objective)' },
        { path: 'satisfiedByMeasure', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'minNormalizedMeasure', maxCount: 1, datatype: 'xsd:decimal', minInclusive: -1, maxInclusive: 1, comment: 'measureType ∈ [-1,1]' },
      ],
    },
    {
      name: 'ObjectiveMappingShape', targetClass: 'ObjectiveMapping', label: 'Objective mapping conformance',
      comment: 'objectiveMappingType: targetObjectiveID required IRI; read/write status/measure flags are booleans (read* default true, write* default false).',
      constraints: [
        { path: 'targetObjectiveID', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'xs:anyURI (required)' },
        { path: 'readSatisfiedStatus', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'readNormalizedMeasure', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'writeSatisfiedStatus', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'writeNormalizedMeasure', maxCount: 1, datatype: 'xsd:boolean' },
      ],
    },
    {
      name: 'RandomizationControlsShape', targetClass: 'RandomizationControls', label: 'Randomization controls conformance',
      comment: 'randomizationType: randomizationTiming/selectionTiming from randomTimingType (default never); selectCount non-negative integer; reorderChildren boolean (default false).',
      constraints: [
        { path: 'randomizationTiming', maxCount: 1, in: ['never', 'once', 'onEachNewAttempt'], comment: 'randomTimingType (default never)' },
        { path: 'selectCount', maxCount: 1, datatype: 'xsd:nonNegativeInteger' },
        { path: 'reorderChildren', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'selectionTiming', maxCount: 1, in: ['never', 'once', 'onEachNewAttempt'], comment: 'randomTimingType (default never)' },
      ],
    },
    {
      name: 'DeliveryControlsShape', targetClass: 'DeliveryControls', label: 'Delivery controls conformance',
      comment: 'deliveryControlsType: tracked (default true), completionSetByContent (default false), objectiveSetByContent (default false) are booleans.',
      constraints: [
        { path: 'tracked', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'completionSetByContent', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'objectiveSetByContent', maxCount: 1, datatype: 'xsd:boolean' },
      ],
    },
    {
      name: 'AuxiliaryResourceShape', targetClass: 'AuxiliaryResource', label: 'Auxiliary resource conformance',
      comment: 'auxiliaryResourceType: auxiliaryResourceID required IRI; purpose required string.',
      constraints: [
        { path: 'auxiliaryResourceID', minCount: 1, maxCount: 1, nodeKind: 'IRI', comment: 'xs:anyURI (required)' },
        { path: 'purpose', minCount: 1, maxCount: 1, datatype: 'xsd:string', comment: 'required' },
      ],
    },
    {
      name: 'RollupConsiderationsShape', targetClass: 'RollupConsiderations', label: 'ADL rollup considerations conformance',
      comment: 'adlseq rollupConsiderationsType: the four requiredFor* attributes are from rollupConsiderationType (default always); measureSatisfactionIfActive boolean (default true).',
      constraints: [
        { path: 'requiredForSatisfied', maxCount: 1, in: ['always', 'ifAttempted', 'ifNotSkipped', 'ifNotSuspended'], comment: 'rollupConsiderationType (default always)' },
        { path: 'requiredForNotSatisfied', maxCount: 1, in: ['always', 'ifAttempted', 'ifNotSkipped', 'ifNotSuspended'], comment: 'rollupConsiderationType (default always)' },
        { path: 'requiredForCompleted', maxCount: 1, in: ['always', 'ifAttempted', 'ifNotSkipped', 'ifNotSuspended'], comment: 'rollupConsiderationType (default always)' },
        { path: 'requiredForIncomplete', maxCount: 1, in: ['always', 'ifAttempted', 'ifNotSkipped', 'ifNotSuspended'], comment: 'rollupConsiderationType (default always)' },
        { path: 'measureSatisfactionIfActive', maxCount: 1, datatype: 'xsd:boolean' },
      ],
    },
    {
      name: 'ConstrainedChoiceConsiderationsShape', targetClass: 'ConstrainedChoiceConsiderations', label: 'ADL constrained choice considerations conformance',
      comment: 'adlseq constrainChoiceConsiderationsType: preventActivation and constrainChoice are booleans (default false).',
      constraints: [
        { path: 'preventActivation', maxCount: 1, datatype: 'xsd:boolean' },
        { path: 'constrainChoice', maxCount: 1, datatype: 'xsd:boolean' },
      ],
    },
    {
      name: 'NavigationInterfaceShape', targetClass: 'NavigationInterface', label: 'ADL navigation interface conformance',
      comment: 'adlnav navigationInterfaceType: each hideLMSUI value MUST be one of hideLMSUIType; repeatable (maxOccurs unbounded).',
      constraints: [
        { path: 'hideLMSUI', in: ['previous', 'continue', 'exit', 'exitAll', 'abandon', 'abandonAll', 'suspendAll'], comment: 'hideLMSUIType' },
      ],
    },
  ],
};
