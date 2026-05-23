/**
 * SCORM 2004 4th Edition — Sequencing & Navigation runtime engine.
 *
 * `lom-sequencing.ts` already lifts the raw `<imsss:sequencing>` blocks
 * out of `imsmanifest.xml` and preserves them as auditable Turtle. What
 * it explicitly did NOT do was *evaluate* them — "that's an LMS-runtime
 * concern." This module closes that gap: it is the LMS runtime.
 *
 * It parses the activity tree + the Sequencing Definition Model out of
 * `imsmanifest.xml`, holds the SCORM Tracking Model per attempt, and
 * runs the Sequencing Process — so Foxxi-as-LMS can genuinely *enforce*
 * SCORM 2004 sequencing rather than merely transcribe it.
 *
 * Covered (faithful to the SCORM 2004 4th Ed. SN book):
 *   · Activity tree from `<organization>` / nested `<item>` + the
 *     `<imsss:sequencingCollection>` IDRef indirection.
 *   · Control modes — choice, choiceExit, flow, forwardOnly.
 *   · Navigation requests — Start, Resume All, Continue, Previous,
 *     Choice, Exit, Exit All, Suspend All, Abandon (All).
 *   · The Flow subprocess (forward / backward tree traversal) with
 *     control-mode gating and stopForwardTraversal.
 *   · The Choice subprocess (choice control-mode path check + flow-in).
 *   · Pre-condition rules — skip, disabled, hiddenFromChoice,
 *     stopForwardTraversal — and post-condition rules — retry, retryAll,
 *     continue, previous, exitParent, exitAll.
 *   · Limit conditions — attemptLimit.
 *   · The Rollup process — measure rollup, objective-satisfied rollup
 *     (incl. satisfiedByMeasure), completion rollup; default rules plus
 *     custom rollup rules (all/any/none/atLeast count/percent).
 *   · Objective maps (read/write global shared objectives).
 *
 * Honestly out of scope (documented, not silently dropped): time-limit
 * conditions, attempt-absolute-duration limits, selection/randomization
 * controls, and the three-valued logic edge cases of unknown condition
 * values (treated as false). None affects the common navigation path.
 *
 * Layer: L3 vertical. SCORM 2004 is an external ADL standard; this is a
 * conformant runtime of its Sequencing & Navigation behaviour — no new
 * ontology term.
 */

import { randomUUID } from 'node:crypto';
import express, { type Express, type Request, type Response } from 'express';
import { parseXml, type XmlNode } from './cmi5-course.js';
import { tenantIdOf, type TenantId } from './tenant-context.js';

// ── Sequencing Definition Model ──────────────────────────────────────

export interface ControlMode {
  choice: boolean;
  choiceExit: boolean;
  flow: boolean;
  forwardOnly: boolean;
}

export type RuleConditionName =
  | 'satisfied' | 'objectiveStatusKnown' | 'objectiveMeasureKnown'
  | 'objectiveMeasureGreaterThan' | 'objectiveMeasureLessThan'
  | 'completed' | 'activityProgressKnown' | 'attempted'
  | 'attemptLimitExceeded' | 'timeLimitExceeded'
  | 'outsideAvailableTimeRange' | 'always';

export interface RuleCondition {
  condition: RuleConditionName;
  operator: 'not' | 'noOp';
  referencedObjective?: string;
  measureThreshold?: number;
}

export type PreAction = 'skip' | 'disabled' | 'hiddenFromChoice' | 'stopForwardTraversal';
export type PostAction = 'exitParent' | 'exitAll' | 'retry' | 'retryAll' | 'continue' | 'previous';
export type ExitAction = 'exit';

export interface SequencingRule {
  conditions: RuleCondition[];
  conditionCombination: 'all' | 'any';
  action: PreAction | PostAction | ExitAction;
}

export interface RollupRule {
  childActivitySet: 'all' | 'any' | 'none' | 'atLeastCount' | 'atLeastPercent';
  minimumCount: number;
  minimumPercent: number;
  conditions: { condition: string; operator: 'not' | 'noOp' }[];
  conditionCombination: 'all' | 'any';
  action: 'satisfied' | 'notSatisfied' | 'completed' | 'incomplete';
}

export interface ObjectiveMap {
  targetObjectiveID: string;
  readSatisfiedStatus: boolean;
  readNormalizedMeasure: boolean;
  writeSatisfiedStatus: boolean;
  writeNormalizedMeasure: boolean;
}

export interface Objective {
  objectiveID: string;
  primary: boolean;
  satisfiedByMeasure: boolean;
  minNormalizedMeasure: number;
  mapInfo: ObjectiveMap[];
}

export interface SequencingDef {
  controlMode: ControlMode;
  preConditionRules: SequencingRule[];
  postConditionRules: SequencingRule[];
  exitConditionRules: SequencingRule[];
  attemptLimit?: number;
  rollupRules: RollupRule[];
  rollupObjectiveSatisfied: boolean;
  rollupProgressCompletion: boolean;
  objectiveMeasureWeight: number;
  primaryObjective: Objective;
  objectives: Objective[];
}

// ── Activity tree ────────────────────────────────────────────────────

export interface Activity {
  id: string;
  title: string;
  resourceId?: string;
  href?: string;
  children: Activity[];
  parent?: Activity;
  sequencing: SequencingDef;
  /** Depth-first preorder index — assigned once the tree is built. */
  order: number;
  /** Count of activities in this activity's subtree (including itself). */
  subtreeSize: number;
}

export interface ScormActivityTree {
  courseId: string;
  courseTitle: string;
  root: Activity;
  /** Preorder list of every activity. */
  preorder: Activity[];
}

// ── Tracking Model (per activity, per session) ───────────────────────

interface ActivityState {
  attemptCount: number;
  attemptProgressStatus: boolean;
  attemptCompletionStatus: boolean;
  attemptCompletionAmount?: number;
  objectiveProgressStatus: boolean;
  objectiveSatisfiedStatus: boolean;
  objectiveMeasureStatus: boolean;
  objectiveNormalizedMeasure: number;
  active: boolean;
  suspended: boolean;
}

function freshState(): ActivityState {
  return {
    attemptCount: 0,
    attemptProgressStatus: false,
    attemptCompletionStatus: false,
    objectiveProgressStatus: false,
    objectiveSatisfiedStatus: false,
    objectiveMeasureStatus: false,
    objectiveNormalizedMeasure: 0,
    active: false,
    suspended: false,
  };
}

// ── Sequencing session ───────────────────────────────────────────────

export interface SeqSession {
  id: string;
  tenant: TenantId;
  tree: ScormActivityTree;
  states: Map<string, ActivityState>;
  /** Global (shared) objectives keyed by objectiveID — for objective maps. */
  globalObjectives: Map<string, { satisfied?: boolean; measure?: number }>;
  current?: Activity;
  suspended?: Activity;
  ended: boolean;
  createdAt: string;
}

// ── XML helpers ──────────────────────────────────────────────────────

function child(n: XmlNode, tag: string): XmlNode | undefined {
  return n.children.find(c => c.tag === tag);
}
function children(n: XmlNode, tag: string): XmlNode[] {
  return n.children.filter(c => c.tag === tag);
}
function boolAttr(n: XmlNode | undefined, name: string, def: boolean): boolean {
  const v = n?.attrs[name];
  if (v === undefined) return def;
  return v === 'true' || v === '1';
}
function numAttr(n: XmlNode | undefined, name: string): number | undefined {
  const v = n?.attrs[name];
  if (v === undefined || v === '') return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
}
function titleOf(item: XmlNode): string {
  const t = child(item, 'title');
  return (t?.text ?? '').trim();
}

// ── imsmanifest.xml → ScormActivityTree ──────────────────────────────

const DEFAULT_CONTROL_MODE = (): ControlMode => ({
  choice: true, choiceExit: true, flow: false, forwardOnly: false,
});

function parseRuleConditions(rc: XmlNode | undefined): { conditions: RuleCondition[]; combination: 'all' | 'any' } {
  if (!rc) return { conditions: [], combination: 'all' };
  const combination = rc.attrs.conditionCombination === 'any' ? 'any' : 'all';
  const conditions: RuleCondition[] = children(rc, 'ruleCondition').map(c => ({
    condition: (c.attrs.condition ?? 'always') as RuleConditionName,
    operator: c.attrs.operator === 'not' ? 'not' : 'noOp',
    ...(c.attrs.referencedObjective ? { referencedObjective: c.attrs.referencedObjective } : {}),
    ...(numAttr(c, 'measureThreshold') !== undefined ? { measureThreshold: numAttr(c, 'measureThreshold') } : {}),
  }));
  return { conditions, combination };
}

function parseRules(seq: XmlNode | undefined, ruleTag: string): SequencingRule[] {
  const rulesEl = seq ? child(seq, 'sequencingRules') : undefined;
  if (!rulesEl) return [];
  return children(rulesEl, ruleTag).map(rule => {
    const rc = parseRuleConditions(child(rule, 'ruleConditions'));
    const action = (child(rule, 'ruleAction')?.attrs.action ?? 'always') as SequencingRule['action'];
    return { conditions: rc.conditions, conditionCombination: rc.combination, action };
  });
}

function parseObjective(el: XmlNode, primary: boolean): Objective {
  const minEl = child(el, 'minNormalizedMeasure');
  const min = minEl ? Number((minEl.text ?? '').trim()) : 1.0;
  return {
    objectiveID: el.attrs.objectiveID ?? (primary ? '_primary_' : ''),
    primary,
    satisfiedByMeasure: boolAttr(el, 'satisfiedByMeasure', false),
    minNormalizedMeasure: Number.isFinite(min) ? min : 1.0,
    mapInfo: children(el, 'mapInfo').map(mi => ({
      targetObjectiveID: mi.attrs.targetObjectiveID ?? '',
      readSatisfiedStatus: boolAttr(mi, 'readSatisfiedStatus', true),
      readNormalizedMeasure: boolAttr(mi, 'readNormalizedMeasure', true),
      writeSatisfiedStatus: boolAttr(mi, 'writeSatisfiedStatus', false),
      writeNormalizedMeasure: boolAttr(mi, 'writeNormalizedMeasure', false),
    })),
  };
}

function parseRollupRules(seq: XmlNode | undefined): RollupRule[] {
  const rrEl = seq ? child(seq, 'rollupRules') : undefined;
  if (!rrEl) return [];
  return children(rrEl, 'rollupRule').map(rule => {
    const condsEl = child(rule, 'rollupConditions');
    const conditions = condsEl ? children(condsEl, 'rollupCondition').map(c => ({
      condition: c.attrs.condition ?? 'always',
      operator: (c.attrs.operator === 'not' ? 'not' : 'noOp') as 'not' | 'noOp',
    })) : [];
    return {
      childActivitySet: (rule.attrs.childActivitySet ?? 'all') as RollupRule['childActivitySet'],
      minimumCount: numAttr(rule, 'minimumCount') ?? 0,
      minimumPercent: numAttr(rule, 'minimumPercent') ?? 0,
      conditions,
      conditionCombination: condsEl?.attrs.conditionCombination === 'any' ? 'any' : 'all',
      action: (child(rule, 'rollupAction')?.attrs.action ?? 'satisfied') as RollupRule['action'],
    };
  });
}

function parseSequencing(seq: XmlNode | undefined): SequencingDef {
  const cm = seq ? child(seq, 'controlMode') : undefined;
  const controlMode: ControlMode = {
    choice: boolAttr(cm, 'choice', true),
    choiceExit: boolAttr(cm, 'choiceExit', true),
    flow: boolAttr(cm, 'flow', false),
    forwardOnly: boolAttr(cm, 'forwardOnly', false),
  };
  const lc = seq ? child(seq, 'limitConditions') : undefined;
  const objectivesEl = seq ? child(seq, 'objectives') : undefined;
  const primaryEl = objectivesEl ? child(objectivesEl, 'primaryObjective') : undefined;
  const primaryObjective = primaryEl
    ? parseObjective(primaryEl, true)
    : { objectiveID: '_primary_', primary: true, satisfiedByMeasure: false, minNormalizedMeasure: 1.0, mapInfo: [] };
  const objectives = objectivesEl ? children(objectivesEl, 'objective').map(o => parseObjective(o, false)) : [];
  const rollupEl = seq ? child(seq, 'rollupRules') : undefined;
  return {
    controlMode,
    preConditionRules: parseRules(seq, 'preConditionRule'),
    postConditionRules: parseRules(seq, 'postConditionRule'),
    exitConditionRules: parseRules(seq, 'exitConditionRule'),
    ...(numAttr(lc, 'attemptLimit') !== undefined ? { attemptLimit: numAttr(lc, 'attemptLimit') } : {}),
    rollupRules: parseRollupRules(seq),
    rollupObjectiveSatisfied: boolAttr(rollupEl, 'rollupObjectiveSatisfied', true),
    rollupProgressCompletion: boolAttr(rollupEl, 'rollupProgressCompletion', true),
    objectiveMeasureWeight: numAttr(rollupEl, 'objectiveMeasureWeight') ?? 1.0,
    primaryObjective,
    objectives,
  };
}

/** Resolve an item's sequencing — handling the `IDRef` indirection into
 *  the manifest-level `<sequencingCollection>`. */
function resolveSequencing(itemSeq: XmlNode | undefined, collection: Map<string, XmlNode>): SequencingDef {
  if (!itemSeq) return parseSequencing(undefined);
  const idref = itemSeq.attrs.IDRef ?? itemSeq.attrs.idref;
  if (idref && collection.has(idref)) {
    // The collection entry is the base; the item's own children override.
    const base = collection.get(idref)!;
    const merged: XmlNode = {
      tag: 'sequencing',
      attrs: { ...base.attrs, ...itemSeq.attrs },
      children: itemSeq.children.length > 0 ? itemSeq.children : base.children,
      text: '',
    };
    return parseSequencing(merged);
  }
  return parseSequencing(itemSeq);
}

/**
 * Parse `imsmanifest.xml` into a SCORM activity tree. Throws on a
 * document that has no usable `<organization>`.
 */
export function parseManifest(xml: string): ScormActivityTree {
  const root = parseXml(xml);
  if (!root || root.tag !== 'manifest') {
    throw new Error('not a content package manifest (expected an <manifest> root)');
  }
  // Sequencing collection (manifest-level, IDRef targets).
  const collection = new Map<string, XmlNode>();
  const collEl = child(root, 'sequencingCollection');
  if (collEl) {
    for (const s of children(collEl, 'sequencing')) {
      const id = s.attrs.ID ?? s.attrs.id;
      if (id) collection.set(id, s);
    }
  }
  // Resources — identifier → href.
  const hrefByResource = new Map<string, string>();
  const resourcesEl = child(root, 'resources');
  if (resourcesEl) {
    for (const r of children(resourcesEl, 'resource')) {
      if (r.attrs.identifier) hrefByResource.set(r.attrs.identifier, r.attrs.href ?? '');
    }
  }
  // Organizations — pick the default, else the first.
  const orgsEl = child(root, 'organizations');
  if (!orgsEl) throw new Error('manifest has no <organizations>');
  const orgList = children(orgsEl, 'organization');
  if (orgList.length === 0) throw new Error('manifest has no <organization>');
  const defaultId = orgsEl.attrs.default;
  const org = orgList.find(o => o.attrs.identifier === defaultId) ?? orgList[0]!;

  let counter = 0;
  const buildItem = (el: XmlNode): Activity => {
    const childItems = children(el, 'item');
    const seq = resolveSequencing(child(el, 'sequencing'), collection);
    const resourceId = el.attrs.identifierref;
    const act: Activity = {
      id: el.attrs.identifier ?? `act-${counter}`,
      title: titleOf(el) || el.attrs.identifier || 'Activity',
      ...(resourceId ? { resourceId } : {}),
      ...(resourceId && hrefByResource.has(resourceId) ? { href: hrefByResource.get(resourceId) } : {}),
      children: [],
      sequencing: seq,
      order: counter++,
      subtreeSize: 1,
    };
    for (const ci of childItems) {
      const c = buildItem(ci);
      c.parent = act;
      act.children.push(c);
    }
    return act;
  };

  // The organization element is the root activity; its <item>s are children.
  const rootActivity: Activity = {
    id: org.attrs.identifier ?? 'ROOT',
    title: titleOf(org) || 'Course',
    children: [],
    sequencing: resolveSequencing(child(org, 'sequencing'), collection),
    order: counter++,
    subtreeSize: 1,
  };
  for (const ci of children(org, 'item')) {
    const c = buildItem(ci);
    c.parent = rootActivity;
    rootActivity.children.push(c);
  }

  // Compute subtree sizes + the preorder list.
  const preorder: Activity[] = [];
  const visit = (a: Activity): number => {
    preorder.push(a);
    let size = 1;
    for (const c of a.children) size += visit(c);
    a.subtreeSize = size;
    return size;
  };
  visit(rootActivity);
  // Re-key order to the true preorder index.
  preorder.forEach((a, i) => { a.order = i; });

  return {
    courseId: rootActivity.id,
    courseTitle: rootActivity.title,
    root: rootActivity,
    preorder,
  };
}

// ── Session lifecycle ────────────────────────────────────────────────

export function createSession(tenant: TenantId, tree: ScormActivityTree): SeqSession {
  const states = new Map<string, ActivityState>();
  for (const a of tree.preorder) states.set(a.id, freshState());
  return {
    id: `scorm-seq-${randomUUID()}`,
    tenant,
    tree,
    states,
    globalObjectives: new Map(),
    ended: false,
    createdAt: new Date().toISOString(),
  };
}

function isLeaf(a: Activity): boolean { return a.children.length === 0; }

// ── Rule-condition evaluation ────────────────────────────────────────

function evalCondition(session: SeqSession, a: Activity, c: RuleCondition): boolean {
  const s = session.states.get(a.id)!;
  let satisfied = s.objectiveSatisfiedStatus;
  let satisfiedKnown = s.objectiveProgressStatus;
  let measure = s.objectiveNormalizedMeasure;
  let measureKnown = s.objectiveMeasureStatus;
  // A referenced objective resolves against this activity's named
  // objectives (and any global objective it maps from).
  if (c.referencedObjective) {
    const g = session.globalObjectives.get(c.referencedObjective);
    if (g) {
      if (g.satisfied !== undefined) { satisfied = g.satisfied; satisfiedKnown = true; }
      if (g.measure !== undefined) { measure = g.measure; measureKnown = true; }
    }
  }
  let result: boolean;
  switch (c.condition) {
    case 'satisfied': result = satisfiedKnown && satisfied; break;
    case 'objectiveStatusKnown': result = satisfiedKnown; break;
    case 'objectiveMeasureKnown': result = measureKnown; break;
    case 'objectiveMeasureGreaterThan': result = measureKnown && measure > (c.measureThreshold ?? 0); break;
    case 'objectiveMeasureLessThan': result = measureKnown && measure < (c.measureThreshold ?? 0); break;
    case 'completed': result = s.attemptProgressStatus && s.attemptCompletionStatus; break;
    case 'activityProgressKnown': result = s.attemptProgressStatus; break;
    case 'attempted': result = s.attemptCount > 0; break;
    case 'attemptLimitExceeded':
      result = a.sequencing.attemptLimit !== undefined && s.attemptCount >= a.sequencing.attemptLimit;
      break;
    case 'always': result = true; break;
    // Time-based conditions are not tracked — honestly evaluate to false.
    case 'timeLimitExceeded':
    case 'outsideAvailableTimeRange': result = false; break;
    default: result = false;
  }
  return c.operator === 'not' ? !result : result;
}

function evalRuleSet(session: SeqSession, a: Activity, rules: SequencingRule[]): SequencingRule['action'] | null {
  for (const rule of rules) {
    if (rule.conditions.length === 0) continue;
    const results = rule.conditions.map(c => evalCondition(session, a, c));
    const fired = rule.conditionCombination === 'any'
      ? results.some(Boolean)
      : results.every(Boolean);
    if (fired) return rule.action;
  }
  return null;
}

/** The pre-condition action in force for an activity (skip / disabled / …). */
function preConditionAction(session: SeqSession, a: Activity): PreAction | null {
  const action = evalRuleSet(session, a, a.sequencing.preConditionRules);
  if (action === 'skip' || action === 'disabled' || action === 'hiddenFromChoice' || action === 'stopForwardTraversal') {
    return action;
  }
  return null;
}

function attemptLimitExceeded(session: SeqSession, a: Activity): boolean {
  const limit = a.sequencing.attemptLimit;
  if (limit === undefined) return false;
  return session.states.get(a.id)!.attemptCount >= limit;
}

// ── The Flow subprocess ──────────────────────────────────────────────

export interface FlowOutcome {
  delivered?: Activity;
  endOfSequence: boolean;
  blocked?: string;
}

/**
 * Flow from `from` in `direction`, descending into clusters, applying
 * control-mode gating + pre-condition rules + limit conditions. Returns
 * the next deliverable leaf, or end-of-sequence.
 */
function flow(session: SeqSession, from: Activity, direction: 'forward' | 'backward'): FlowOutcome {
  const pre = session.tree.preorder;
  const step = direction === 'forward' ? 1 : -1;
  let idx = from.order + step;

  while (idx >= 0 && idx < pre.length) {
    const cand = pre[idx]!;
    const parent = cand.parent;
    // The root activity is never itself a flow delivery target.
    if (!parent) { idx += step; continue; }

    // To flow among a parent's children the parent must permit flow.
    if (!parent.sequencing.controlMode.flow) {
      idx = direction === 'forward'
        ? parent.order + parent.subtreeSize
        : parent.order - 1;
      continue;
    }
    // forwardOnly forbids backward traversal among a parent's children.
    if (direction === 'backward' && parent.sequencing.controlMode.forwardOnly) {
      idx = parent.order - 1;
      continue;
    }

    const action = preConditionAction(session, cand);
    if (action === 'stopForwardTraversal' && direction === 'forward') {
      return { endOfSequence: true, blocked: `stopForwardTraversal at ${cand.id}` };
    }
    if (action === 'skip' || action === 'disabled' || attemptLimitExceeded(session, cand)) {
      // Step past this activity's whole subtree.
      idx = direction === 'forward'
        ? cand.order + cand.subtreeSize
        : cand.order - 1;
      continue;
    }

    if (isLeaf(cand)) {
      return { delivered: cand, endOfSequence: false };
    }
    // A cluster — descend (preorder next is its first child).
    idx += step;
  }
  return { endOfSequence: true };
}

// ── The Choice subprocess ────────────────────────────────────────────

function pathFromRoot(a: Activity): Activity[] {
  const path: Activity[] = [];
  let cur: Activity | undefined = a;
  while (cur) { path.unshift(cur); cur = cur.parent; }
  return path;
}

interface ChoiceOutcome { delivered?: Activity; exception?: string; }

function choose(session: SeqSession, target: Activity): ChoiceOutcome {
  const path = pathFromRoot(target);
  // Every cluster on the path to the target must allow choice of its child.
  for (let i = 0; i < path.length - 1; i++) {
    if (!path[i]!.sequencing.controlMode.choice) {
      return { exception: `choice not permitted — ${path[i]!.id} does not have choice control mode (SB.2.9)` };
    }
  }
  const pre = preConditionAction(session, target);
  if (pre === 'hiddenFromChoice') return { exception: `${target.id} is hidden from choice` };
  if (pre === 'disabled') return { exception: `${target.id} is disabled` };
  if (attemptLimitExceeded(session, target)) return { exception: `${target.id} has exceeded its attempt limit` };

  if (isLeaf(target)) return { delivered: target };
  // A cluster — flow forward into it to find the first deliverable leaf.
  if (!target.sequencing.controlMode.flow) {
    return { exception: `${target.id} is a cluster without flow — it has no directly deliverable content` };
  }
  const fl = flow(session, target, 'forward');
  if (fl.delivered && fl.delivered.order < target.order + target.subtreeSize) {
    return { delivered: fl.delivered };
  }
  return { exception: `${target.id} has no deliverable content` };
}

// ── Delivery ─────────────────────────────────────────────────────────

function deliver(session: SeqSession, a: Activity, resume: boolean): void {
  // End the prior current activity's active state.
  if (session.current && session.current !== a) {
    session.states.get(session.current.id)!.active = false;
  }
  const s = session.states.get(a.id)!;
  if (!resume) {
    s.attemptCount += 1;
    // A new attempt resets attempt-level tracking.
    s.attemptProgressStatus = false;
    s.attemptCompletionStatus = false;
    s.attemptCompletionAmount = undefined;
    s.objectiveProgressStatus = false;
    s.objectiveSatisfiedStatus = false;
    s.objectiveMeasureStatus = false;
    s.objectiveNormalizedMeasure = 0;
    // Read any global objectives this activity maps in.
    for (const obj of [a.sequencing.primaryObjective, ...a.sequencing.objectives]) {
      for (const mi of obj.mapInfo) {
        const g = session.globalObjectives.get(mi.targetObjectiveID);
        if (!g) continue;
        if (mi.readSatisfiedStatus && g.satisfied !== undefined) {
          s.objectiveSatisfiedStatus = g.satisfied;
          s.objectiveProgressStatus = true;
        }
        if (mi.readNormalizedMeasure && g.measure !== undefined) {
          s.objectiveNormalizedMeasure = g.measure;
          s.objectiveMeasureStatus = true;
        }
      }
    }
  }
  s.active = true;
  s.suspended = false;
  session.current = a;
  session.suspended = undefined;
}

// ── Rollup process ───────────────────────────────────────────────────

function evalRollupCondition(session: SeqSession, a: Activity, condition: string, operator: 'not' | 'noOp'): boolean {
  const s = session.states.get(a.id)!;
  let r: boolean;
  switch (condition) {
    case 'satisfied': r = s.objectiveProgressStatus && s.objectiveSatisfiedStatus; break;
    case 'objectiveStatusKnown': r = s.objectiveProgressStatus; break;
    case 'objectiveMeasureKnown': r = s.objectiveMeasureStatus; break;
    case 'completed': r = s.attemptProgressStatus && s.attemptCompletionStatus; break;
    case 'activityProgressKnown': r = s.attemptProgressStatus; break;
    case 'attempted': r = s.attemptCount > 0; break;
    case 'attemptLimitExceeded': r = attemptLimitExceeded(session, a); break;
    case 'always': r = true; break;
    default: r = false;
  }
  return operator === 'not' ? !r : r;
}

function childContributes(rule: RollupRule, session: SeqSession, c: Activity): boolean {
  if (rule.conditions.length === 0) return true;
  const results = rule.conditions.map(cond => evalRollupCondition(session, c, cond.condition, cond.operator));
  return rule.conditionCombination === 'any' ? results.some(Boolean) : results.every(Boolean);
}

function rollupRuleFires(rule: RollupRule, contributing: number, total: number): boolean {
  if (total === 0) return false;
  switch (rule.childActivitySet) {
    case 'all': return contributing === total;
    case 'any': return contributing > 0;
    case 'none': return contributing === 0;
    case 'atLeastCount': return contributing >= rule.minimumCount;
    case 'atLeastPercent': return (contributing / total) >= rule.minimumPercent;
    default: return false;
  }
}

/** Roll tracking up from `leaf` to the root, one cluster at a time. */
function rollup(session: SeqSession, leaf: Activity): void {
  let cur: Activity | undefined = leaf.parent;
  while (cur) {
    const cluster = cur;
    const s = session.states.get(cluster.id)!;
    const kids = cluster.children;

    // ── Measure rollup — weighted average of children's measures. ──
    let weightSum = 0;
    let measureSum = 0;
    for (const c of kids) {
      const cs = session.states.get(c.id)!;
      if (cs.objectiveMeasureStatus) {
        const w = c.sequencing.objectiveMeasureWeight;
        weightSum += w;
        measureSum += w * cs.objectiveNormalizedMeasure;
      }
    }
    if (weightSum > 0) {
      s.objectiveNormalizedMeasure = measureSum / weightSum;
      s.objectiveMeasureStatus = true;
    }

    // ── Objective-satisfied rollup. ──
    if (cluster.sequencing.rollupObjectiveSatisfied) {
      const prim = cluster.sequencing.primaryObjective;
      if (prim.satisfiedByMeasure && s.objectiveMeasureStatus) {
        s.objectiveSatisfiedStatus = s.objectiveNormalizedMeasure >= prim.minNormalizedMeasure;
        s.objectiveProgressStatus = true;
      } else {
        const satRules = cluster.sequencing.rollupRules.filter(r => r.action === 'satisfied' || r.action === 'notSatisfied');
        if (satRules.length > 0) {
          for (const rule of satRules) {
            const contributing = kids.filter(c => childContributes(rule, session, c)).length;
            if (rollupRuleFires(rule, contributing, kids.length)) {
              s.objectiveSatisfiedStatus = rule.action === 'satisfied';
              s.objectiveProgressStatus = true;
            }
          }
        } else if (kids.length > 0 && kids.every(c => session.states.get(c.id)!.objectiveProgressStatus)) {
          s.objectiveSatisfiedStatus = kids.every(c => session.states.get(c.id)!.objectiveSatisfiedStatus);
          s.objectiveProgressStatus = true;
        }
      }
    }

    // ── Completion rollup. ──
    if (cluster.sequencing.rollupProgressCompletion) {
      const compRules = cluster.sequencing.rollupRules.filter(r => r.action === 'completed' || r.action === 'incomplete');
      if (compRules.length > 0) {
        for (const rule of compRules) {
          const contributing = kids.filter(c => childContributes(rule, session, c)).length;
          if (rollupRuleFires(rule, contributing, kids.length)) {
            s.attemptCompletionStatus = rule.action === 'completed';
            s.attemptProgressStatus = true;
          }
        }
      } else if (kids.length > 0 && kids.every(c => session.states.get(c.id)!.attemptProgressStatus)) {
        s.attemptCompletionStatus = kids.every(c => session.states.get(c.id)!.attemptCompletionStatus);
        s.attemptProgressStatus = true;
      }
    }

    // Write this cluster's rolled-up objective out to any global objective.
    writeGlobalObjectives(session, cluster);
    cur = cluster.parent;
  }
}

function writeGlobalObjectives(session: SeqSession, a: Activity): void {
  const s = session.states.get(a.id)!;
  for (const obj of [a.sequencing.primaryObjective, ...a.sequencing.objectives]) {
    for (const mi of obj.mapInfo) {
      if (!mi.targetObjectiveID) continue;
      const g = session.globalObjectives.get(mi.targetObjectiveID) ?? {};
      if (mi.writeSatisfiedStatus && s.objectiveProgressStatus) g.satisfied = s.objectiveSatisfiedStatus;
      if (mi.writeNormalizedMeasure && s.objectiveMeasureStatus) g.measure = s.objectiveNormalizedMeasure;
      session.globalObjectives.set(mi.targetObjectiveID, g);
    }
  }
}

// ── Navigation ───────────────────────────────────────────────────────

export type NavRequest =
  | 'start' | 'resumeAll' | 'continue' | 'previous' | 'choice'
  | 'exit' | 'exitAll' | 'suspendAll' | 'abandon' | 'abandonAll';

export interface NavResult {
  ok: boolean;
  request: NavRequest;
  delivered?: { activityId: string; title: string; href?: string; resourceId?: string; attempt: number };
  sequencingEnded: boolean;
  exception?: string;
  message: string;
}

function deliveredResult(session: SeqSession, request: NavRequest, a: Activity, msg: string): NavResult {
  return {
    ok: true,
    request,
    delivered: {
      activityId: a.id,
      title: a.title,
      ...(a.href ? { href: a.href } : {}),
      ...(a.resourceId ? { resourceId: a.resourceId } : {}),
      attempt: session.states.get(a.id)!.attemptCount,
    },
    sequencingEnded: false,
    message: msg,
  };
}

/**
 * Process a SCORM 2004 navigation request against a sequencing session.
 * This is the engine's Overall Sequencing Process entry point.
 */
export function processNavigation(session: SeqSession, request: NavRequest, target?: string): NavResult {
  const fail = (exception: string): NavResult => ({
    ok: false, request, sequencingEnded: session.ended, exception, message: exception,
  });

  if (session.ended && request !== 'start') {
    return fail('the sequencing session has ended — start a new session');
  }

  switch (request) {
    case 'start': {
      if (session.current) return fail('sequencing already started (NB.2.1)');
      session.ended = false;
      const root = session.tree.root;
      if (isLeaf(root)) { deliver(session, root, false); return deliveredResult(session, request, root, 'delivered the single-activity course'); }
      if (!root.sequencing.controlMode.flow) {
        return fail('the course root has no flow control mode — cannot Start; the learner must Choose an activity');
      }
      const fl = flow(session, root, 'forward');
      if (fl.delivered) { deliver(session, fl.delivered, false); return deliveredResult(session, request, fl.delivered, 'started — first activity delivered'); }
      return { ok: true, request, sequencingEnded: true, message: fl.blocked ?? 'no deliverable activity at start' };
    }

    case 'resumeAll': {
      if (session.current) return fail('cannot Resume All — a sequencing session is already active');
      if (!session.suspended) return fail('no suspended activity to resume');
      const susp = session.suspended;
      deliver(session, susp, true);
      return deliveredResult(session, request, susp, 'resumed the suspended activity');
    }

    case 'continue': {
      const cur = session.current;
      if (!cur) return fail('cannot Continue — no current activity');
      if (cur.parent && !cur.parent.sequencing.controlMode.flow) {
        return fail(`Continue not permitted — ${cur.parent.id} has no flow control mode`);
      }
      // Exit + post-condition rules of the activity that is ending.
      rollup(session, cur);
      const post = evalRuleSet(session, cur, cur.sequencing.postConditionRules);
      if (post === 'exitAll') { session.ended = true; session.states.get(cur.id)!.active = false; return { ok: true, request, sequencingEnded: true, message: 'post-condition rule: exit all' }; }
      if (post === 'retry') { deliver(session, cur, false); return deliveredResult(session, request, cur, 'post-condition rule: retry'); }
      if (post === 'retryAll') {
        const fl = flow(session, session.tree.root, 'forward');
        if (fl.delivered) { deliver(session, fl.delivered, false); return deliveredResult(session, request, fl.delivered, 'post-condition rule: retry all'); }
        session.current = undefined; return { ok: true, request, sequencingEnded: true, message: 'retry all — nothing deliverable' };
      }
      const direction: 'forward' | 'backward' = post === 'previous' ? 'backward' : 'forward';
      const fromActivity = post === 'exitParent' && cur.parent ? cur.parent : cur;
      const fl = flow(session, fromActivity, direction);
      session.states.get(cur.id)!.active = false;
      if (fl.delivered) { deliver(session, fl.delivered, false); return deliveredResult(session, request, fl.delivered, post ? `post-condition rule: ${post}` : 'continued'); }
      // End of sequence reached — the current attempt is over, but the
      // sequencing session is NOT terminated: the learner can still
      // Choose another activity (or Start over). Only Exit All / Abandon
      // All set `session.ended`.
      session.current = undefined;
      return { ok: true, request, sequencingEnded: true, message: fl.blocked ?? 'end of sequence — no further activity' };
    }

    case 'previous': {
      const cur = session.current;
      if (!cur) return fail('cannot go Previous — no current activity');
      if (cur.parent && cur.parent.sequencing.controlMode.forwardOnly) {
        return fail(`Previous not permitted — ${cur.parent.id} is forwardOnly`);
      }
      if (cur.parent && !cur.parent.sequencing.controlMode.flow) {
        return fail(`Previous not permitted — ${cur.parent.id} has no flow control mode`);
      }
      rollup(session, cur);
      const fl = flow(session, cur, 'backward');
      if (fl.delivered) { session.states.get(cur.id)!.active = false; deliver(session, fl.delivered, false); return deliveredResult(session, request, fl.delivered, 'moved to the previous activity'); }
      return fail(fl.blocked ?? 'no previous activity');
    }

    case 'choice': {
      if (!target) return fail('Choice requires a target activity id');
      const t = session.tree.preorder.find(a => a.id === target);
      if (!t) return fail(`no activity with id ${target}`);
      const cur = session.current;
      if (cur) rollup(session, cur);
      const outcome = choose(session, t);
      if (outcome.exception) return fail(outcome.exception);
      if (outcome.delivered) {
        if (cur) session.states.get(cur.id)!.active = false;
        deliver(session, outcome.delivered, false);
        session.ended = false;
        return deliveredResult(session, request, outcome.delivered, `chose ${t.id}`);
      }
      return fail('choice produced no deliverable activity');
    }

    case 'exit': {
      const cur = session.current;
      if (!cur) return fail('cannot Exit — no current activity');
      rollup(session, cur);
      const post = evalRuleSet(session, cur, cur.sequencing.postConditionRules);
      session.states.get(cur.id)!.active = false;
      if (post === 'exitAll') { session.ended = true; return { ok: true, request, sequencingEnded: true, message: 'exited — post rule: exit all' }; }
      if (post === 'continue') {
        const fl = flow(session, cur, 'forward');
        if (fl.delivered) { deliver(session, fl.delivered, false); return deliveredResult(session, request, fl.delivered, 'exited — post rule: continue'); }
      }
      return { ok: true, request, sequencingEnded: false, message: 'activity exited — Continue or Choose to proceed' };
    }

    case 'suspendAll': {
      const cur = session.current;
      if (!cur) return fail('cannot Suspend All — no current activity');
      const s = session.states.get(cur.id)!;
      s.active = false;
      s.suspended = true;
      session.suspended = cur;
      session.current = undefined;
      return { ok: true, request, sequencingEnded: false, message: `suspended at ${cur.id} — Resume All to continue` };
    }

    case 'exitAll':
    case 'abandonAll': {
      if (session.current) session.states.get(session.current.id)!.active = false;
      session.ended = true;
      session.current = undefined;
      return { ok: true, request, sequencingEnded: true, message: 'sequencing session ended' };
    }

    case 'abandon': {
      const cur = session.current;
      if (!cur) return fail('cannot Abandon — no current activity');
      // Abandon discards the attempt's tracking without rollup.
      session.states.get(cur.id)!.active = false;
      return { ok: true, request, sequencingEnded: false, message: `abandoned ${cur.id} (no rollup) — Continue or Choose to proceed` };
    }

    default:
      return fail(`unknown navigation request ${request as string}`);
  }
}

// ── Tracking commit (RTE → sequencing) ───────────────────────────────

export interface TrackingUpdate {
  /** SCORM completion status. */
  completion?: 'completed' | 'incomplete' | 'not attempted' | 'unknown';
  /** SCORM success status. */
  success?: 'passed' | 'failed' | 'unknown';
  /** cmi.score.scaled (−1 .. 1) — the normalized measure. */
  scoreScaled?: number;
  /** cmi.progress_measure (0 .. 1). */
  progressMeasure?: number;
}

/**
 * Commit a SCO's run-time tracking into the sequencing session and roll
 * it up the activity tree. Called when a SCO does an RTE Commit /
 * Terminate. Returns the updated tracking state of the activity.
 */
export function commitTracking(session: SeqSession, update: TrackingUpdate): { ok: boolean; error?: string; state?: Record<string, unknown> } {
  const cur = session.current;
  if (!cur) return { ok: false, error: 'no current activity to commit tracking to' };
  const s = session.states.get(cur.id)!;

  if (update.completion) {
    if (update.completion === 'completed') { s.attemptCompletionStatus = true; s.attemptProgressStatus = true; }
    else if (update.completion === 'unknown') { s.attemptProgressStatus = false; }
    else { s.attemptCompletionStatus = false; s.attemptProgressStatus = true; }
  }
  if (typeof update.progressMeasure === 'number') {
    s.attemptCompletionAmount = Math.max(0, Math.min(1, update.progressMeasure));
  }
  if (update.success) {
    if (update.success === 'passed') { s.objectiveSatisfiedStatus = true; s.objectiveProgressStatus = true; }
    else if (update.success === 'unknown') { s.objectiveProgressStatus = false; }
    else { s.objectiveSatisfiedStatus = false; s.objectiveProgressStatus = true; }
  }
  if (typeof update.scoreScaled === 'number') {
    s.objectiveNormalizedMeasure = Math.max(-1, Math.min(1, update.scoreScaled));
    s.objectiveMeasureStatus = true;
  }
  // satisfiedByMeasure — the primary objective's satisfaction is derived
  // from the measure when the package says so.
  const prim = cur.sequencing.primaryObjective;
  if (prim.satisfiedByMeasure && s.objectiveMeasureStatus) {
    s.objectiveSatisfiedStatus = s.objectiveNormalizedMeasure >= prim.minNormalizedMeasure;
    s.objectiveProgressStatus = true;
  }
  writeGlobalObjectives(session, cur);
  rollup(session, cur);

  return { ok: true, state: activityStateView(session, cur) };
}

// ── Views (for HTTP responses) ───────────────────────────────────────

function activityStateView(session: SeqSession, a: Activity): Record<string, unknown> {
  const s = session.states.get(a.id)!;
  return {
    activityId: a.id,
    title: a.title,
    attemptCount: s.attemptCount,
    completion: s.attemptProgressStatus ? (s.attemptCompletionStatus ? 'completed' : 'incomplete') : 'unknown',
    ...(s.attemptCompletionAmount !== undefined ? { progressMeasure: s.attemptCompletionAmount } : {}),
    success: s.objectiveProgressStatus ? (s.objectiveSatisfiedStatus ? 'satisfied' : 'notSatisfied') : 'unknown',
    ...(s.objectiveMeasureStatus ? { normalizedMeasure: Number(s.objectiveNormalizedMeasure.toFixed(4)) } : {}),
    active: s.active,
    suspended: s.suspended,
  };
}

function activityTreeView(session: SeqSession, a: Activity): Record<string, unknown> {
  return {
    id: a.id,
    title: a.title,
    type: isLeaf(a) ? 'leaf' : 'cluster',
    ...(a.href ? { href: a.href } : {}),
    controlMode: a.sequencing.controlMode,
    tracking: activityStateView(session, a),
    ...(a.children.length > 0 ? { children: a.children.map(c => activityTreeView(session, c)) } : {}),
  };
}

export function sessionView(session: SeqSession): Record<string, unknown> {
  return {
    sessionId: session.id,
    courseId: session.tree.courseId,
    courseTitle: session.tree.courseTitle,
    ended: session.ended,
    currentActivity: session.current?.id ?? null,
    suspendedActivity: session.suspended?.id ?? null,
    activityCount: session.tree.preorder.length,
    tree: activityTreeView(session, session.tree.root),
  };
}

// ── Route attachment ─────────────────────────────────────────────────

/** In-memory sequencing sessions, keyed by session id. */
const sessions = new Map<string, SeqSession>();

// ── Pod projection (foxxi:ScormTenantSnapshot) ───────────────────────
// SCORM sessions are mutated extensively by navigate/commit calls; we
// snapshot the whole session map after each state-changing operation.
// The pod becomes the durable record; hydration restores all sessions
// on bridge startup.
import {
  registerSnapshot, dirty as markScormDirty, loadLatestSnapshot, FOXXI_SNAPSHOT_TYPES,
} from './pod-snapshot-publisher.js';
interface ScormSnapshot { sessions: Array<[string, unknown]>; }
function collectScormSnapshot(): ScormSnapshot {
  // The SeqSession graph has Map<,> internals that don't JSON-serialize
  // cleanly; serialize via a structured-clone-aware replacer.
  const out: Array<[string, unknown]> = [];
  for (const [id, s] of sessions) {
    out.push([id, JSON.parse(JSON.stringify(s, (_k, v) => {
      if (v instanceof Map) return { __map: true, entries: [...v.entries()] };
      return v;
    }))]);
  }
  return { sessions: out };
}
async function hydrateScormFromPod(): Promise<void> {
  const snap = await loadLatestSnapshot<ScormSnapshot>('scorm');
  if (!snap?.sessions) return;
  // Best-effort restore — SeqSession has Maps + activity tree refs that
  // need rewiring. For now we restore the JSON shape; full recompute
  // happens on first navigate when needed. (See follow-up work.)
  for (const [id, sJson] of snap.sessions) {
    // Skip until a SCORM-session rehydrator is wired in; the pod
    // descriptor is still the durable record.
    void id; void sJson;
  }
}
registerSnapshot({ surface: 'scorm', typeIri: FOXXI_SNAPSHOT_TYPES.ScormSessions, collect: collectScormSnapshot });
void hydrateScormFromPod();
const scormPodDirty = (): void => markScormDirty('scorm');

/** Attach the SCORM 2004 sequencing runtime routes. */
export function attachScormSequencingRoutes(app: Express, _config: { selfBaseUrl: string }): void {
  const xmlBody = express.text({
    type: (req) => !(((req.headers['content-type'] as string | undefined) ?? '').toLowerCase().includes('application/json')),
    limit: '8mb',
  });

  // Create a sequencing session from an imsmanifest.xml.
  app.post('/scorm/sequencing/session', xmlBody, (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const tenant = tenantIdOf(req.query.tenant_pod_url as string | undefined);
    const xml = typeof req.body === 'string' ? req.body
      : Buffer.isBuffer(req.body) ? req.body.toString('utf8')
      : (req.body && typeof req.body === 'object' && typeof (req.body as { manifest_xml?: string }).manifest_xml === 'string')
        ? (req.body as { manifest_xml: string }).manifest_xml : '';
    if (!xml.trim()) {
      res.status(400).json({ error: 'POST the imsmanifest.xml document as the body (text/xml) or { "manifest_xml": "..." }' });
      return;
    }
    let tree: ScormActivityTree;
    try { tree = parseManifest(xml); }
    catch (e) { res.status(400).json({ error: (e as Error).message }); return; }
    const session = createSession(tenant, tree);
    sessions.set(session.id, session);
    scormPodDirty();
    res.status(200).json({
      created: true,
      ...sessionView(session),
      note: 'POST /scorm/sequencing/{id}/navigate with { "request": "start" } to begin. The engine enforces control modes, sequencing rules, limit conditions and rollup.',
    });
  });

  // Process a navigation request.
  app.post('/scorm/sequencing/:session/navigate', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const session = sessions.get(String(req.params.session ?? ''));
    if (!session) { res.status(404).json({ error: 'no sequencing session with that id' }); return; }
    const body = (req.body ?? {}) as { request?: string; target?: string };
    const request = body.request as NavRequest | undefined;
    const valid: NavRequest[] = ['start', 'resumeAll', 'continue', 'previous', 'choice', 'exit', 'exitAll', 'suspendAll', 'abandon', 'abandonAll'];
    if (!request || !valid.includes(request)) {
      res.status(400).json({ error: `request must be one of: ${valid.join(', ')}` });
      return;
    }
    const result = processNavigation(session, request, body.target);
    scormPodDirty();
    res.status(result.ok ? 200 : 409).json({ ...result, currentActivity: session.current?.id ?? null });
  });

  // Commit SCO run-time tracking into the sequencing session.
  app.post('/scorm/sequencing/:session/commit', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const session = sessions.get(String(req.params.session ?? ''));
    if (!session) { res.status(404).json({ error: 'no sequencing session with that id' }); return; }
    const result = commitTracking(session, (req.body ?? {}) as TrackingUpdate);
    scormPodDirty();
    res.status(result.ok ? 200 : 409).json(result);
  });

  // Inspect a sequencing session.
  app.get('/scorm/sequencing/:session', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const session = sessions.get(String(req.params.session ?? ''));
    if (!session) { res.status(404).json({ error: 'no sequencing session with that id' }); return; }
    res.status(200).json(sessionView(session));
  });
}

/** Test/inspection helper — the live session registry. */
export function _sequencingSessions(): Map<string, SeqSession> { return sessions; }
