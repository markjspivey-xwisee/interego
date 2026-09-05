/**
 * Cold-start, independently inspectable composition:
 *
 *   failing agent policy
 *     -> AGP regime-first diagnosis
 *     -> FOXXI A2A course + SCORM/cmi5/xAPI
 *     -> held-out production evaluation + IEEE-LER/TLA roll-up
 *     -> AGP performance-readiness evidence
 *     -> generic Application Lab evidence guard
 *     -> declarative Release Control state transition
 *
 * No network, model, private key, infrastructure deployment, or privileged
 * mutation is hidden in this program.  It is deliberately a pure proof kit;
 * signing and publishing the prepared graphs remain separate Interego actions.
 */
import { createHash } from 'node:crypto';
import AdmZip from 'adm-zip';
import { canonicalJson } from '@interego/core';
import {
  authorFragment,
  authorLesson,
  authorModule,
  composeCourse,
} from '../../applications/foxxi-content-intelligence/src/emergent-content.js';
import { generateCmi5Xml, generateScormZip } from '../../applications/foxxi-content-intelligence/src/content-package.js';
import { buildPassedSessionTrace } from '../../applications/foxxi-content-intelligence/src/cmi5.js';
import { validateStatement } from '../../applications/foxxi-content-intelligence/src/xapi-validate.js';
import { ingestExternalRun } from '../../applications/foxxi-content-intelligence/src/agent-run-ingest.js';
import { assembleEnterpriseLearnerRecord } from '../../applications/foxxi-content-intelligence/src/learner-record.js';
import { evaluateProficiency } from '../../applications/foxxi-content-intelligence/src/ler-tla-vocab.js';
import {
  InMemoryStatementStore,
  type StoredStatement,
} from '../../applications/foxxi-content-intelligence/src/statement-store.js';
import {
  diagnose,
  evaluateIntervention,
  recommendInterventions,
  type PerformanceSituation,
} from '../../applications/agentic-performance-practice/src/performance-architecture.js';
import {
  preparePerformanceReadiness,
  verifyPerformanceReadinessDocument,
} from '../../applications/agentic-performance-practice/src/readiness-attestation.js';
import {
  SIGNED_DOMAIN_RUNTIME,
  applyEffects,
  evaluateGuard,
  parseSignedJsonDocument,
  signedJsonGraph,
  type ApplicationAction,
  type ApplicationContract,
  type ApplicationEvidenceRecord,
  type Json,
} from '../../integrations/application-runtime/application-lab-runtime.js';

export const SHOWCASE_ID = 'ttt-optimal-play';
export const SHOWCASE_AGENT = 'did:example:agent:ttt-learner';
export const SHOWCASE_AUTHOR = 'did:example:agent:performance-consultant';
export const SHOWCASE_SIGNER = 'did:example:agent:evidence-publisher';

type Mark = 'X' | 'O' | '-';
type Turn = 'X' | 'O';

export interface TicTacToeCase {
  readonly id: string;
  readonly board: string;
  readonly expectedMove: number;
  readonly capability: 'win-now' | 'block-loss';
}

export interface PolicyArtifact {
  readonly schema: 'foxxi.agent-policy/tic-tac-toe-v1';
  readonly id: string;
  readonly playsAs: 'X';
  readonly objective: 'win-or-draw';
  readonly tieBreak: 'lowest-index';
  readonly moveTable: Readonly<Record<string, number>>;
}

export interface PolicyEvaluation {
  readonly suiteDigest: string;
  readonly totalCases: number;
  readonly passedCases: number;
  readonly failedCases: number;
  readonly cases: readonly {
    id: string;
    board: string;
    expectedMove: number;
    selectedMove: number | null;
    passed: boolean;
  }[];
}

export const HELD_OUT_CASES: readonly TicTacToeCase[] = Object.freeze([
  { id: 'win-diagonal-a', board: 'X-O-XO---', expectedMove: 8, capability: 'win-now' },
  { id: 'win-diagonal-b', board: 'XOO-X----', expectedMove: 8, capability: 'win-now' },
  { id: 'win-row', board: 'O-OXX----', expectedMove: 5, capability: 'win-now' },
  { id: 'win-column', board: 'OX-OX----', expectedMove: 7, capability: 'win-now' },
  { id: 'block-row', board: 'X--OO--X-', expectedMove: 5, capability: 'block-loss' },
  { id: 'block-column-a', board: 'XO--O---X', expectedMove: 7, capability: 'block-loss' },
  { id: 'block-diagonal', board: 'X-O-O---X', expectedMove: 6, capability: 'block-loss' },
  { id: 'block-diagonal-b', board: 'OX--O-X--', expectedMove: 8, capability: 'block-loss' },
]);

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertBoard(board: string): void {
  if (board.length !== 9 || ![...board].every(x => x === 'X' || x === 'O' || x === '-')) {
    throw new Error(`invalid tic-tac-toe board: ${board}`);
  }
}

function winner(board: string): Turn | null {
  const lines = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]] as const;
  for (const [a, b, c] of lines) {
    const mark = board[a] as Mark;
    if (mark !== '-' && mark === board[b] && mark === board[c]) return mark;
  }
  return null;
}

function legalMoves(board: string): number[] {
  assertBoard(board);
  return [...board].flatMap((mark, index) => mark === '-' ? [index] : []);
}

function play(board: string, move: number, turn: Turn): string {
  if (board[move] !== '-') throw new Error(`illegal move ${move} on ${board}`);
  return `${board.slice(0, move)}${turn}${board.slice(move + 1)}`;
}

const scoreMemo = new Map<string, number>();
function minimaxScore(board: string, turn: Turn): number {
  const won = winner(board);
  // Prefer an earlier win and, when a loss is unavoidable, delay it.  Without
  // the depth term every eventual win is tied and the declared lowest-index
  // tie-break can legally ignore a win available on this move.
  if (won) {
    const filled = 9 - legalMoves(board).length;
    return won === 'X' ? 10 - filled : filled - 10;
  }
  const moves = legalMoves(board);
  if (!moves.length) return 0;
  const key = `${turn}:${board}`;
  const old = scoreMemo.get(key);
  if (old !== undefined) return old;
  const scores = moves.map(move => minimaxScore(play(board, move, turn), turn === 'X' ? 'O' : 'X'));
  const score = turn === 'X' ? Math.max(...scores) : Math.min(...scores);
  scoreMemo.set(key, score);
  return score;
}

function optimalMove(board: string): number {
  const scored = legalMoves(board).map(move => ({ move, score: minimaxScore(play(board, move, 'X'), 'O') }));
  if (!scored.length) throw new Error(`no legal move on ${board}`);
  const best = Math.max(...scored.map(x => x.score));
  return scored.find(x => x.score === best)!.move;
}

function reachableXBoards(): string[] {
  const seen = new Set<string>();
  const xBoards = new Set<string>();
  const visit = (board: string, turn: Turn): void => {
    const key = `${turn}:${board}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (winner(board) || !board.includes('-')) return;
    if (turn === 'X') xBoards.add(board);
    for (const move of legalMoves(board)) visit(play(board, move, turn), turn === 'X' ? 'O' : 'X');
  };
  visit('---------', 'X');
  return [...xBoards].sort();
}

export function buildPolicy(strategy: 'first-open' | 'minimax'): { artifact: PolicyArtifact; digest: string } {
  const moveTable: Record<string, number> = {};
  for (const board of reachableXBoards()) {
    moveTable[board] = strategy === 'first-open' ? legalMoves(board)[0]! : optimalMove(board);
  }
  const artifact: PolicyArtifact = {
    schema: 'foxxi.agent-policy/tic-tac-toe-v1',
    id: `urn:foxxi:policy:${SHOWCASE_ID}:${strategy}`,
    playsAs: 'X',
    objective: 'win-or-draw',
    tieBreak: 'lowest-index',
    moveTable,
  };
  return { artifact, digest: sha256(canonicalJson(artifact)) };
}

export function evaluatePolicy(policy: PolicyArtifact, cases: readonly TicTacToeCase[] = HELD_OUT_CASES): PolicyEvaluation {
  const suiteDigest = sha256(canonicalJson(cases));
  const results = cases.map(test => {
    assertBoard(test.board);
    const selectedMove = policy.moveTable[test.board] ?? null;
    return { ...test, selectedMove, passed: selectedMove === test.expectedMove };
  });
  const passedCases = results.filter(x => x.passed).length;
  return {
    suiteDigest,
    totalCases: results.length,
    passedCases,
    failedCases: results.length - passedCases,
    cases: results.map(({ capability: _capability, ...result }) => result),
  };
}

function statementUuid(label: string): string {
  const hex = sha256(label);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function storedStatements(statements: readonly Record<string, unknown>[], prefix: string): StoredStatement[] {
  return statements.map((statement, index) => {
    const id = statementUuid(`${prefix}:${index}`);
    const withId: Record<string, unknown> = { ...statement, id };
    const errors = validateStatement(withId);
    if (errors.length) throw new Error(`generated xAPI statement ${prefix}:${index} is invalid: ${errors.join('; ')}`);
    return {
      id,
      statement: withId,
      stored: String(withId.timestamp ?? '2026-09-03T12:00:00.000Z'),
      voided: false,
    };
  });
}

export function buildReadinessReleaseContract(args: {
  applicationId: string;
  evidenceGraphIri: string;
  evidenceSigner: string;
}): ApplicationContract {
  return {
    schema: 'interego.application.contract/v1',
    applicationId: args.applicationId,
    version: '1.0.0',
    runtimeIri: SIGNED_DOMAIN_RUNTIME,
    actions: [
      {
        actionIri: `${args.applicationId}:action:accept-performance-readiness`,
        label: 'Accept performance readiness',
        description: 'Bind one independently verified, current AGP readiness descriptor to this exact candidate.',
        method: 'POST',
        target: SIGNED_DOMAIN_RUNTIME,
        goal: 'accept verified performance evidence',
        inputs: [{ name: 'readiness_descriptor', type: 'iri', required: true }],
        evidence: [{
          input: 'readiness_descriptor',
          role: 'performance-readiness',
          documentType: 'agp-performance-readiness',
          graphIri: args.evidenceGraphIri,
          signedBy: [args.evidenceSigner],
          requireCurrentHead: true,
        }],
        guard: { op: 'all', guards: [
          { op: 'eq', left: { path: '$state.status' }, right: 'review' },
          { op: 'eq', left: { path: '$evidence.readiness_descriptor.document.ready' }, right: true },
          { op: 'eq', left: { path: '$evidence.readiness_descriptor.document.modalStatus' }, right: 'Asserted' },
          { op: 'eq', left: { path: '$evidence.readiness_descriptor.document.subjectDigest' }, right: { path: '$state.candidateDigest' } },
          { op: 'eq', left: { path: '$evidence.readiness_descriptor.document.heldOutEvaluation.suiteDigest' }, right: { path: '$state.evaluationSuiteDigest' } },
          { op: 'eq', left: { path: '$evidence.readiness_descriptor.document.decisionRule.minimumCases' }, right: { path: '$state.readinessRule.minimumCases' } },
          { op: 'eq', left: { path: '$evidence.readiness_descriptor.document.decisionRule.allowedFailures' }, right: { path: '$state.readinessRule.allowedFailures' } },
        ] },
        effects: [
          { op: 'set', path: '$state.releaseReady', value: true },
          { op: 'set', path: '$state.readinessEvidence', value: {
            descriptorUrl: { path: '$evidence.readiness_descriptor.descriptorUrl' },
            cid: { path: '$evidence.readiness_descriptor.cid' },
            documentDigest: { path: '$evidence.readiness_descriptor.documentDigest' },
          } },
        ],
      },
      {
        actionIri: `${args.applicationId}:action:deploy`,
        label: 'Declare release deployed',
        description: 'Advance the application state only. This action has no infrastructure deployment target.',
        method: 'POST',
        target: SIGNED_DOMAIN_RUNTIME,
        goal: 'declare the reviewed candidate active',
        inputs: [],
        guard: { op: 'all', guards: [
          { op: 'eq', left: { path: '$state.releaseReady' }, right: true },
          { op: 'eq', left: { path: '$state.deployed' }, right: false },
          { op: 'countDistinct', path: '$state.approvals', itemPath: 'approver', gte: 2 },
        ] },
        effects: [
          { op: 'set', path: '$state.status', value: 'deployed' },
          { op: 'set', path: '$state.deployed', value: true },
          { op: 'set', path: '$state.deployedAt', value: { path: '$now' } },
        ],
      },
    ],
  };
}

function action(contract: ApplicationContract, suffix: string): ApplicationAction {
  const found = contract.actions.find(x => x.actionIri.endsWith(suffix));
  if (!found) throw new Error(`showcase contract lacks action ${suffix}`);
  return found;
}

export async function runShowcase(): Promise<{
  report: Record<string, unknown>;
  artifacts: {
    scormZip: Buffer;
    cmi5Xml: string;
    readinessGraph: string;
    readinessDocument: Record<string, Json>;
    releaseContract: ApplicationContract;
  };
}> {
  const baselinePolicy = buildPolicy('first-open');
  const candidatePolicy = buildPolicy('minimax');
  const before = evaluatePolicy(baselinePolicy.artifact);
  const after = evaluatePolicy(candidatePolicy.artifact);

  const situation: PerformanceSituation = {
    id: `urn:agp:situation:${SHOWCASE_ID}`,
    performer: { id: SHOWCASE_AGENT, kind: 'agent', role: 'release candidate' },
    workContext: 'Select a legal Tic-Tac-Toe move as X without model or network access.',
    competency: 'Win immediately when possible; otherwise block an immediate loss.',
    observed: `${before.passedCases}/${before.totalCases} held-out tactical cases passed`,
    frequency: 'frequent',
    criticality: 'moderate',
    modalStatus: 'Asserted',
    provenance: `urn:foxxi:evaluation-suite:${before.suiteDigest}`,
    domain: 'Knowable',
  };
  const exemplary = `${after.totalCases}/${after.totalCases} held-out tactical cases passed`;
  const diagnosis = diagnose({
    situation,
    exemplary,
    factorEvidence: {
      knowledgeSkill: { adequate: false, evidence: 'The baseline policy fails every held-out win-now and block-loss case.' },
    },
    couldPerformUnderIdealConditions: false,
    performedWellBefore: false,
  });
  const plan = recommendInterventions({
    diagnosis,
    situation,
    author: { id: SHOWCASE_AUTHOR, kind: 'agent', role: 'performance consultant' },
  });
  if (!plan.selected.some(x => x.type === 'instruction') || !plan.contentWarranted) {
    throw new Error('AGP did not select instruction for the demonstrated Knowable, frequent skill deficiency');
  }

  const scan = authorFragment({
    modality: 'concept', competencyPoint: 'tactical-scan', level: 'foundational',
    body: 'Before choosing a move: take an immediate win; otherwise block the opponent\'s immediate win; then compare future terminal outcomes.',
    authoredBy: { id: SHOWCASE_AUTHOR, kind: 'agent' },
    provenance: `derived from ${diagnosis.situationId}`,
  });
  const worked = authorFragment({
    modality: 'worked-example', competencyPoint: 'tactical-scan', level: 'working',
    body: 'On X--OO--X-, O threatens square 5. X has no immediate win, so square 5 is the only non-losing response.',
    authoredBy: { id: SHOWCASE_AUTHOR, kind: 'agent' },
    provenance: `held-out family ${before.suiteDigest}`,
  });
  const practice = authorFragment({
    modality: 'practice-task', competencyPoint: 'look-ahead', level: 'applied',
    body: 'For every legal move, recursively score X-win as +1, draw as 0, and O-win as -1; choose the maximum with lowest-index tie-break.',
    authoredBy: { id: SHOWCASE_AUTHOR, kind: 'agent' },
    provenance: 'deterministic minimax practice recipe',
  });
  const check = authorFragment({
    modality: 'assessment-item', competencyPoint: 'tactical-scan', level: 'applied',
    body: 'On X-O-XO---, which square wins immediately for X? ::: 8',
    authoredBy: { id: SHOWCASE_AUTHOR, kind: 'agent' },
    provenance: `assessment for ${SHOWCASE_ID}`,
  });
  const lesson = authorLesson({
    title: 'Win, block, then look ahead', competency: situation.competency,
    audience: 'agent', authoredBy: { id: SHOWCASE_AUTHOR, kind: 'agent' },
    positions: [
      { competencyPoint: 'tactical-scan', fragments: [scan, worked] },
      { competencyPoint: 'look-ahead', fragments: [practice] },
      { competencyPoint: 'assessment', fragments: [check] },
    ],
  });
  const module = authorModule({
    title: 'Optimal-play policy', competency: situation.competency,
    authoredBy: { id: SHOWCASE_AUTHOR, kind: 'agent' },
    positions: [{ competencyPoint: 'optimal-play', lessons: [lesson] }],
  });
  const course = composeCourse({
    title: 'Tic-Tac-Toe optimal play', competency: situation.competency,
    audience: 'agent', authoredBy: { id: SHOWCASE_AUTHOR, kind: 'agent' },
    positions: [{ competencyPoint: 'optimal-play', modules: [module] }],
    moveOn: 'Passed',
  });
  const cmi5Xml = generateCmi5Xml(course, lessonId => `https://foxxi.example/au/${encodeURIComponent(lessonId)}`);
  const scormZip = generateScormZip(course);
  const zipEntries = new AdmZip(scormZip).getEntries().map(x => x.entryName).sort();

  const cmi5Trace = buildPassedSessionTrace({
    actor: { account: { homePage: 'https://identity.interego.example/agents', name: SHOWCASE_AGENT }, name: 'TTT candidate' },
    session: {
      registration: '11111111-1111-4111-8111-111111111111',
      sessionId: '11111111-1111-4111-8111-111111111111',
      publisherId: 'urn:foxxi:publisher:showcase',
      auActivityId: lesson.id,
      courseActivityId: course.id,
      launchedAt: '2026-09-03T12:00:00.000Z',
    },
    scoreScaled: 1,
    masteryScore: 0.8,
    durationIso: 'PT2M',
    moveOnRule: 'Passed',
  });
  const learningRecords = storedStatements(cmi5Trace as unknown as Record<string, unknown>[], 'cmi5');

  const productionRecords = HELD_OUT_CASES.flatMap((test, index) => {
    const run = ingestExternalRun({
      agentDid: SHOWCASE_AGENT,
      agentName: 'TTT candidate',
      task: { id: `urn:foxxi:held-out:${test.id}`, name: `Solve ${test.id}`, description: test.board },
      toolCalls: [{ tool: 'policy.lookup', objectId: candidatePolicy.artifact.id, success: after.cases[index]!.passed, quality: 1 }],
      outcome: { success: after.cases[index]!.passed, quality: 1, durationIso: 'PT0.01S' },
      observedBy: SHOWCASE_AUTHOR,
      evaluationId: `urn:foxxi:evaluation:${after.suiteDigest}`,
      candidateId: `urn:sha256:${candidatePolicy.digest}`,
      harness: { name: 'deterministic-table-runner', version: '1.0.0', runtime: 'node' },
    });
    return storedStatements(run.statements.map((statement, statementIndex) => ({
      ...statement,
      timestamp: new Date(Date.parse('2026-09-03T12:10:00.000Z') + index * 1000 + statementIndex).toISOString(),
    })), `production:${test.id}`);
  });
  const records = [...learningRecords, ...productionRecords];
  // Exercise the actual pluggable LRS storage boundary, not an array standing
  // in for it. This proof uses the non-durable in-memory backend explicitly;
  // production can swap the same interface for pod/file/external-LRS storage.
  const lrs = new InMemoryStatementStore({ budgeted: false });
  for (const record of records) await lrs.put(record);
  const lrsRecords = await lrs.listAll();
  const elr = await assembleEnterpriseLearnerRecord({
    learnerDid: SHOWCASE_AGENT,
    learnerName: 'TTT candidate',
    learnerPodUrl: 'https://pod.example/ttt-candidate/',
    publicPodUrl: 'https://pod.example/ttt-candidate/',
    subjectKind: 'agent',
    tenantDid: 'did:web:foxxi.example',
    lrsEndpoint: 'https://lrs.foxxi.example',
    statements: lrsRecords,
    fetch: (async () => new Response('wallet intentionally absent in offline proof', { status: 404 })) as typeof fetch,
  });
  const proficiency = evaluateProficiency({ basis: 'performance', executions: after.totalCases, successes: after.passedCases, avgQuality: 1 });
  const interventionEvaluation = evaluateIntervention({
    plan, situation,
    response: { favourable: true, note: 'The A2A course was consumable as context and as portable LMS packages.' },
    capability: { assessed: true, passed: after.passedCases === after.totalCases, note: `${after.passedCases}/${after.totalCases} held-out cases passed.` },
    transfer: { transferred: true, evidence: `${productionRecords.length} xAPI production records in the agent ELR.` },
    newObserved: exemplary,
  });

  const readiness = preparePerformanceReadiness({
    candidateDigest: candidatePolicy.digest,
    regime: diagnosis.domain!,
    evaluationSuiteDigest: after.suiteDigest,
    totalCases: after.totalCases,
    passedCases: after.passedCases,
    diagnosisDescriptorUrl: 'https://pod.example/consulting/context-graphs/ttt-diagnosis.ttl',
    evaluationDescriptorUrls: [
      'https://pod.example/consulting/context-graphs/ttt-intervention-evaluation.ttl',
      'https://pod.example/consulting/context-graphs/ttt-held-out-evaluation.ttl',
    ],
    xapiStatementIds: lrsRecords.map(x => `urn:uuid:${x.id}`),
    portableRecordDescriptorUrl: 'https://pod.example/ttt-candidate/context-graphs/enterprise-learner-record.ttl',
    issuedAt: '2026-09-03T12:20:00.000Z',
    minimumCases: HELD_OUT_CASES.length,
    allowedFailures: 0,
  });
  const parsedReadiness = parseSignedJsonDocument(readiness.graphContent);
  const readinessVerification = verifyPerformanceReadinessDocument(readiness.document);
  if (!parsedReadiness.digestVerified || !readinessVerification.verified) throw new Error('prepared readiness graph failed self-verification');

  const applicationId = 'urn:graph:interego:application:release-readiness-showcase';
  const releaseContract = buildReadinessReleaseContract({
    applicationId,
    evidenceGraphIri: readiness.graphIri,
    evidenceSigner: SHOWCASE_SIGNER,
  });
  const readinessDescriptorUrl = 'https://pod.example/evidence/context-graphs/ttt-readiness.ttl';
  const evidence: ApplicationEvidenceRecord = {
    input: 'readiness_descriptor', role: 'performance-readiness',
    descriptorUrl: readinessDescriptorUrl, cid: `urn:sha256:${sha256(readiness.graphContent)}`,
    graphIri: readiness.graphIri, documentType: readiness.documentType,
    documentDigest: readiness.documentDigest,
    document: readiness.document as unknown as Record<string, Json>,
    signedBy: SHOWCASE_SIGNER,
    verificationMethod: `${SHOWCASE_SIGNER}#key-1`,
  };
  const state: Record<string, Json> = {
    status: 'review', candidateDigest: candidatePolicy.digest,
    evaluationSuiteDigest: after.suiteDigest,
    readinessRule: { minimumCases: HELD_OUT_CASES.length, allowedFailures: 0 },
    releaseReady: false,
    readinessEvidence: null, deployed: false,
    approvals: [{ approver: 'did:example:agent:reviewer-a' }, { approver: 'did:example:agent:reviewer-b' }],
  };
  const accept = action(releaseContract, ':action:accept-performance-readiness');
  const evidenceEnv = { readiness_descriptor: evidence };
  const acceptGuard = evaluateGuard(accept.guard, {
    state, payload: { readiness_descriptor: readinessDescriptorUrl }, evidence: evidenceEnv,
    actor: 'did:example:agent:release-controller', now: '2026-09-03T12:21:00.000Z',
  });
  if (!acceptGuard.supported || !acceptGuard.pass) throw new Error(`release readiness guard failed: ${acceptGuard.explanation}`);
  const acceptedState = applyEffects(state, accept.effects ?? [], { state, evidence: evidenceEnv });
  const deploy = action(releaseContract, ':action:deploy');
  const deployGuard = evaluateGuard(deploy.guard, { state: acceptedState });
  if (!deployGuard.supported || !deployGuard.pass) throw new Error(`release declaration guard failed: ${deployGuard.explanation}`);
  const deployedState = applyEffects(acceptedState, deploy.effects ?? [], {
    state: acceptedState, now: '2026-09-03T12:22:00.000Z',
  });
  const contractGraph = signedJsonGraph(`${applicationId}:contract`, 'application-contract', releaseContract as unknown as Record<string, Json>);

  const report = {
    schema: 'interego.showcase/foxxi-agp-release-v1',
    showcaseId: SHOWCASE_ID,
    boundaries: {
      interego: 'generic signed graphs, descriptor trust, current-head CAS, declarative guards/effects, replay',
      foxxi: 'content/KM, SCORM 2004, cmi5, xAPI, LRS projection, IEEE-LER, ADL-TLA',
      agp: 'regime-first diagnosis, intervention selection, transfer/outcome evaluation, readiness decision',
      releaseControl: 'consumes typed signed evidence and advances application state; it does not deploy infrastructure',
    },
    coldStart: { candidateDigest: baselinePolicy.digest, ...before },
    consulting: {
      regime: diagnosis.domain, regimeSource: diagnosis.regimeSource, method: diagnosis.method,
      skillDeficiency: diagnosis.skillDeficiency,
      selectedInterventions: plan.selected.map(x => x.type),
      contentWarranted: plan.contentWarranted, direction: plan.direction,
      evaluationVerdict: interventionEvaluation.verdict,
    },
    foxxi: {
      courseId: course.id,
      contentAddressedFragments: [scan, worked, practice, check].map(x => x.id),
      scorm: { sha256: sha256(scormZip), bytes: scormZip.length, entries: zipEntries },
      cmi5: { sha256: sha256(cmi5Xml), statementCount: learningRecords.length },
      xapi: {
        conformantStatements: lrsRecords.length,
        productionStatements: productionRecords.length,
        lrsBackend: lrs.backendDescription(),
        lrsRoundTripCount: await lrs.count(),
      },
      ler: { id: elr.id, summary: elr.summary },
      tla: proficiency,
    },
    improvedCandidate: { candidateDigest: candidatePolicy.digest, policyStates: Object.keys(candidatePolicy.artifact.moveTable).length, ...after },
    readiness: {
      graphIri: readiness.graphIri, documentDigest: readiness.documentDigest,
      ready: readiness.document.ready, modalStatus: readiness.document.modalStatus,
      digestVerified: parsedReadiness.digestVerified,
      ruleVerified: readinessVerification.verified,
      claimNotMade: readiness.document.explicitClaimNotMade,
    },
    releaseComposition: {
      contractDigest: contractGraph.digest,
      acceptedEvidence: acceptGuard.pass,
      activationReady: deployGuard.pass,
      finalApplicationState: deployedState,
      runtimeTarget: deploy.target,
      infrastructureEffects: 0,
    },
  };
  return {
    report,
    artifacts: {
      scormZip, cmi5Xml, readinessGraph: readiness.graphContent,
      readinessDocument: readiness.document as unknown as Record<string, Json>, releaseContract,
    },
  };
}
