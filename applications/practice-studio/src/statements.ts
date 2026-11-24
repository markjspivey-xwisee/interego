/**
 * The xAPI block an authored scenario needs so the hosted player can read it.
 *
 * The studio does not emit statements. A real attempt is what that player writes
 * when a course launches it: consent, timing, review and the agent-test mark are
 * the player's. This module only supplies the profile terms a document is missing,
 * and the pass-gate rule the player already uses (`resultAfterReview`).
 */
import { PHONE_ROLEPLAY_PROFILE, PHONE_ROLEPLAY_V3 } from './profile.js';
import { type ScenarioDoc, type XapiBlock } from './score.js';

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

/** Pass-gate practice, and anything left to a reviewer, does not close the player's registration. */
export function closesAwaitingReview(scenario: ScenarioDoc): boolean {
  return scenario.resultAfterReview === true || scenario.assessmentUse === 'pass-gate';
}
