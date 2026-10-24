/**
 * The pev: namespace, its published files, and the action IRIs every affordance and every signed
 * envelope names.
 *
 * The canonical vocabulary is ontology/pev.ttl (OWL) and ontology/pev-shapes.ttl (SHACL, the
 * in-process subset only). Byte copies are published under docs/applications/practice-evidence/
 * so each namespace IRI below dereferences.
 *
 * PEV_ACTION is the one table of action IRIs. affordances.ts declares each affordance with
 * `action: PEV_ACTION.<key>`, and the handlers check every envelope's `payload.action` against the
 * same constant, so a person signs for exactly one act and an envelope cannot be replayed at
 * another.
 */
import { readFileSync } from 'node:fs';

export const PEV_NS = 'https://markjspivey-xwisee.github.io/interego/applications/practice-evidence/pev#';
export const PEV_ONTOLOGY_IRI = 'https://markjspivey-xwisee.github.io/interego/applications/practice-evidence/pev';
export const PEV_SHAPES_NS = 'https://markjspivey-xwisee.github.io/interego/applications/practice-evidence/pev/shapes#';

/** The full IRI of a pev: term. */
export function pevTerm(local: string): string {
  return PEV_NS + local;
}

/** Every act this vertical offers, by camelCase key. The kebab tail is the affordance's name. */
export const PEV_ACTION = {
  registerRole: 'urn:iep:action:pev:register-role',
  authorScenario: 'urn:iep:action:pev:author-scenario',
  draftScenarioPacket: 'urn:iep:action:pev:draft-scenario-packet',
  draftScenario: 'urn:iep:action:pev:draft-scenario',
  ratifyScenario: 'urn:iep:action:pev:ratify-scenario',
  listScenarios: 'urn:iep:action:pev:list-scenarios',
  startAttempt: 'urn:iep:action:pev:start-attempt',
  say: 'urn:iep:action:pev:say',
  counterpartPacket: 'urn:iep:action:pev:counterpart-packet',
  recordTurns: 'urn:iep:action:pev:record-turns',
  endConversation: 'urn:iep:action:pev:end-conversation',
  judgeAttempt: 'urn:iep:action:pev:judge-attempt',
  judgePacket: 'urn:iep:action:pev:judge-packet',
  recordJudgment: 'urn:iep:action:pev:record-judgment',
  reviewQueue: 'urn:iep:action:pev:review-queue',
  countersignAttempt: 'urn:iep:action:pev:countersign-attempt',
  overrideAttempt: 'urn:iep:action:pev:override-attempt',
  contestReview: 'urn:iep:action:pev:contest-review',
  retractReview: 'urn:iep:action:pev:retract-review',
  calibration: 'urn:iep:action:pev:calibration',
  scenarioResults: 'urn:iep:action:pev:scenario-results',
  projectAttempt: 'urn:iep:action:pev:project-attempt',
  holderCopy: 'urn:iep:action:pev:holder-copy',
  exportRecord: 'urn:iep:action:pev:export-record',
  redactAttempt: 'urn:iep:action:pev:redact-attempt',
  getAttempt: 'urn:iep:action:pev:get-attempt',
  signAsDemoRole: 'urn:iep:action:pev:sign-as-demo-role',
} as const;

export type PevActionKey = keyof typeof PEV_ACTION;
export type PevAction = (typeof PEV_ACTION)[PevActionKey];

const ACTION_PREFIX = 'urn:iep:action:pev:';

/** `urn:iep:action:pev:register-role` → `pev.register_role`; null for anything that is not a pev action. */
export function toolNameOf(action: string): string | null {
  if (!action.startsWith(ACTION_PREFIX)) return null;
  const tail = action.slice(ACTION_PREFIX.length);
  if (!/^[a-z]+(?:-[a-z]+)*$/.test(tail)) return null;
  return `pev.${tail.split('-').join('_')}`;
}

/** True for an IRI in the pev action family (used to refuse signing anything else). */
export function isPevAction(action: unknown): action is string {
  return typeof action === 'string' && toolNameOf(action) !== null;
}

/** Read a canonical Turtle artifact from the sibling ontology/ directory, from source or a build. */
function readOntologyFile(file: string): string {
  const candidates = [
    new URL(`../ontology/${file}`, import.meta.url),
    new URL(`../../ontology/${file}`, import.meta.url),
  ];
  for (const url of candidates) {
    try { return readFileSync(url, 'utf8'); } catch { /* try the next location */ }
  }
  throw new Error(`pev ontology artifact not found: ${file}`);
}

export const readOntologyTurtle = (): string => readOntologyFile('pev.ttl');
export const readShapesTurtle = (): string => readOntologyFile('pev-shapes.ttl');
