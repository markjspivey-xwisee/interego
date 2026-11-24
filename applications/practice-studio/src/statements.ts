/**
 * xAPI statements for one scripted attempt, in the order phone-roleplay profile v3
 * describes for a consented call.
 *
 * A pass-gate, and any attempt the scenario leaves to a reviewer, closes with
 * `terminated` and does not send `completed`, `passed` or `failed`. Feedback-only
 * sends `completed` and then `terminated`. Terms come from the scenario's xapi
 * block when it names them, and otherwise from the v3 profile.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PHONE_ROLEPLAY_PROFILE, PHONE_ROLEPLAY_V3 } from './profile.js';
import { type Assessment, type ScenarioDoc, type XapiBlock } from './score.js';

const P = PHONE_ROLEPLAY_PROFILE;

export function canonicalXapi(): XapiBlock {
  return {
    profile: P,
    profileVersion: PHONE_ROLEPLAY_V3,
    verbs: {
      initialized: 'http://adlnet.gov/expapi/verbs/initialized',
      consented: `${P}/verbs/consented`,
      declinedConsent: `${P}/verbs/declined-consent`,
      scored: 'http://adlnet.gov/expapi/verbs/scored',
      completed: 'http://adlnet.gov/expapi/verbs/completed',
      passed: 'http://adlnet.gov/expapi/verbs/passed',
      failed: 'http://adlnet.gov/expapi/verbs/failed',
      terminated: 'http://adlnet.gov/expapi/verbs/terminated',
      turn: `${P}/verbs/took-turn`,
    },
    activityTypes: {
      scenario: `${P}/activity-types/roleplay-scenario`,
      criterion: `${P}/activity-types/rubric-criterion`,
      consent: `${P}/activity-types/consent-notice`,
      attempt: `${P}/activity-types/phone-roleplay-simulation`,
      turn: `${P}/activity-types/roleplay-turn`,
    },
    extensions: {
      pseudonym: `${P}/extensions/participant-phone-pseudonym`,
      scenario: `${P}/extensions/scenario`,
      attemptGraph: `${P}/extensions/interego-graph`,
      callId: `${P}/extensions/call-id`,
      concepts: `${P}/extensions/i2idlx-concepts`,
      criterionKey: `${P}/extensions/criterion-key`,
      passBar: `${P}/extensions/pass-bar`,
      criterionScores: `${P}/extensions/criterion-scores`,
      counterpartLine: `${P}/extensions/customer-line`,
      matchedReply: `${P}/extensions/matched-or-tapped-reply`,
      stepId: `${P}/extensions/step-id`,
      recognisedText: `${P}/extensions/recognised-text`,
      confirmedChoice: `${P}/extensions/confirmed-choice`,
      rubric: `${P}/extensions/rubric`,
    },
  };
}

/** A stable pseudonym. The learner's name is not written into a statement. */
export function pseudonymOf(learner: string): string {
  return `anon-${createHash('sha256').update(learner.trim().toLowerCase()).digest('hex').slice(0, 16)}`;
}

export interface StatementContext {
  scenario: ScenarioDoc;
  sessionId: string;
  learner: string;
  personaId: string;
  assessment: Assessment;
}

type Statement = Record<string, unknown>;

const lang = (scenario: ScenarioDoc, text: string) => ({ [scenario.language || 'en-US']: text });

function xapi(scenario: ScenarioDoc): XapiBlock {
  return scenario.xapi ?? canonicalXapi();
}

function ext(block: XapiBlock, key: string, fallback: string): string {
  return block.extensions[key] || fallback;
}

/** Pass-gate practice, and anything left to a reviewer, does not close the registration. */
export function closesAwaitingReview(scenario: ScenarioDoc): boolean {
  return scenario.resultAfterReview === true || scenario.assessmentUse === 'pass-gate';
}

export function practiceStatements(ctx: StatementContext): Statement[] {
  const { scenario, sessionId, assessment } = ctx;
  const block = xapi(scenario);
  const persona = scenario.personas.find((p) => p.id === ctx.personaId);
  const activityId = scenario.source || `urn:studio:scenario:${scenario.scenarioKey}`;
  const graph = `urn:studio:attempt:${sessionId}`;
  const rubric = scenario.rubricRef || `${activityId}#rubric`;
  const scenarioIri = persona?.variantOf || scenario.source || activityId;
  const pseudo = pseudonymOf(ctx.learner);
  const X = {
    pseudonym: ext(block, 'pseudonym', canonicalXapi().extensions['pseudonym']!),
    scenario: ext(block, 'scenario', canonicalXapi().extensions['scenario']!),
    graph: ext(block, 'attemptGraph', canonicalXapi().extensions['attemptGraph']!),
    call: ext(block, 'callId', canonicalXapi().extensions['callId']!),
    rubric: ext(block, 'rubric', canonicalXapi().extensions['rubric']!),
    line: ext(block, 'counterpartLine', canonicalXapi().extensions['counterpartLine']!),
    step: ext(block, 'stepId', canonicalXapi().extensions['stepId']!),
    matched: ext(block, 'matchedReply', canonicalXapi().extensions['matchedReply']!),
    recognised: ext(block, 'recognisedText', canonicalXapi().extensions['recognisedText']!),
    confirmed: ext(block, 'confirmedChoice', canonicalXapi().extensions['confirmedChoice']!),
    key: ext(block, 'criterionKey', canonicalXapi().extensions['criterionKey']!),
    concepts: ext(block, 'concepts', canonicalXapi().extensions['concepts']!),
    passBar: ext(block, 'passBar', canonicalXapi().extensions['passBar']!),
    scores: ext(block, 'criterionScores', canonicalXapi().extensions['criterionScores']!),
  };
  const types = { ...canonicalXapi().activityTypes, ...block.activityTypes };
  const verbs = { ...canonicalXapi().verbs, ...block.verbs };
  let clock = Date.now();
  const stamp = (): string => new Date(clock++).toISOString();
  const actor = {
    objectType: 'Agent',
    name: 'Learner',
    account: { homePage: 'https://markjspivey-xwisee.github.io/interego/applications/practice-studio', name: pseudo },
  };
  const scenarioAct = () => ({
    objectType: 'Activity',
    id: activityId,
    definition: {
      type: types['scenario'],
      name: lang(scenario, scenario.activity?.name || scenario.title),
      description: lang(scenario, scenario.activity?.description || scenario.situation || scenario.title),
      ...((scenario.activity?.concepts ?? []).length ? { extensions: { [X.concepts]: scenario.activity!.concepts } } : {}),
    },
  });
  const context = (cmi5: boolean, parent: boolean): Record<string, unknown> => ({
    registration: sessionId,
    platform: `${scenario.ui?.brand ? `${scenario.ui.brand} ` : ''}practice studio`,
    language: scenario.language || 'en-US',
    extensions: {
      [X.pseudonym]: pseudo,
      [X.scenario]: scenarioIri,
      [X.graph]: graph,
      [X.call]: sessionId,
      [X.rubric]: rubric,
    },
    contextActivities: {
      category: [
        { objectType: 'Activity', id: block.profileVersion || PHONE_ROLEPLAY_V3 },
        ...(cmi5 ? [{ objectType: 'Activity', id: 'https://w3id.org/xapi/cmi5/context/categories/cmi5' }] : []),
      ],
      grouping: [{
        objectType: 'Activity',
        id: graph,
        definition: { type: types['attempt'], name: lang(scenario, `${scenario.title} practice`) },
      }],
      ...(parent ? { parent: [scenarioAct()] } : {}),
    },
  });
  const statement = (verb: string, label: string, object: unknown, result: Record<string, unknown> | undefined, cmi5: boolean, parent: boolean): Statement => ({
    id: randomUUID(),
    actor,
    verb: { id: verb, display: { 'en-US': label } },
    object,
    context: context(cmi5, parent),
    timestamp: stamp(),
    ...(result ? { result } : {}),
  });

  const out: Statement[] = [
    statement(verbs['initialized']!, 'initialized', scenarioAct(), undefined, true, false),
    statement(verbs['consented']!, 'consented', {
      objectType: 'Activity',
      id: `${activityId}#consent`,
      definition: { type: types['consent'], name: lang(scenario, 'Consent to a scored practice session') },
    }, { success: true, response: 'Agreed in the practice studio' }, false, true),
  ];
  for (const turn of assessment.turns) {
    const resultExt: Record<string, unknown> = {
      [X.confirmed]: turn.confirmed,
      [X.matched]: turn.choiceText,
    };
    if (turn.recognised) resultExt[X.recognised] = turn.recognised;
    out.push(statement(verbs['turn']!, 'took a turn', {
      objectType: 'Activity',
      id: `${activityId}/turn/${turn.n}`,
      definition: {
        type: types['turn'],
        name: lang(scenario, `Exchange ${turn.n}`),
        extensions: { [X.line]: turn.customerLine, [X.step]: turn.stepId },
      },
    }, { response: turn.response, extensions: resultExt }, false, true));
  }
  const scoreMap: Record<string, number> = {};
  for (const criterion of assessment.criteria) {
    scoreMap[criterion.id] = criterion.raw;
    out.push(statement(verbs['scored']!, 'scored', {
      objectType: 'Activity',
      id: criterion.activityId,
      definition: {
        type: types['criterion'],
        name: lang(scenario, criterion.title),
        description: lang(scenario, criterion.description),
        extensions: {
          [X.key]: criterion.id,
          ...(criterion.concepts.length ? { [X.concepts]: criterion.concepts } : {}),
        },
      },
    }, {
      score: {
        raw: criterion.raw,
        min: criterion.min,
        max: criterion.max,
        scaled: criterion.max === 0 ? 0 : Math.round((criterion.raw / criterion.max) * 10000) / 10000,
      },
      response: criterion.evidence || criterion.title,
    }, false, true));
  }
  const duration = `PT${Math.max(1, assessment.turns.length * 20)}S`;
  if (!closesAwaitingReview(scenario)) {
    out.push(statement(verbs['completed']!, 'completed', scenarioAct(), {
      completion: true,
      success: assessment.pass,
      duration,
      score: { raw: assessment.points, min: 0, max: assessment.max, scaled: assessment.max === 0 ? 0 : Math.round((assessment.points / assessment.max) * 10000) / 10000 },
      extensions: { [X.passBar]: { minPercent: assessment.minPercent }, [X.scores]: scoreMap },
    }, true, false));
  }
  out.push(statement(verbs['terminated']!, 'terminated', scenarioAct(), { duration }, true, false));
  return out;
}
