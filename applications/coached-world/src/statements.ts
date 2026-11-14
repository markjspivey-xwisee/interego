/**
 * Mission statements for one registration, in the pack's profile.
 *
 * The hidden cause is not written on the stream the consultant reads first.
 * `passed` and `completed` (and the other cmi5 result verbs) are refused here
 * even if a caller asks: those are the course's to send, after a review.
 */
import { randomUUID } from 'node:crypto';
import { validateAgainstSuppliedProfile } from '../../foxxi-content-intelligence/src/xapi-profile-supplied.js';
import { GATE_VERBS, verbId, type Symptom, type WorldPack } from './pack.js';
import { buildProfile, missionActivityType, symptomActivityType, type ProfileDocument } from './profile.js';
import { WorldError } from './errors.js';

export interface XapiStatement {
  readonly id: string;
  readonly version: '2.0.0';
  readonly timestamp: string;
  readonly actor: { readonly objectType: 'Agent'; readonly account: { readonly homePage: string; readonly name: string } };
  readonly verb: { readonly id: string; readonly display: { readonly en: string } };
  readonly object: { readonly objectType: 'Activity'; readonly id: string; readonly definition: { readonly type: string; readonly name?: { readonly en: string } } };
  readonly result?: { readonly success?: boolean; readonly score?: { readonly raw: number }; readonly response?: string; readonly extensions?: Readonly<Record<string, string>> };
  readonly context: {
    readonly registration: string;
    readonly contextActivities: {
      readonly category: ReadonlyArray<{ readonly id: string; readonly definition?: { readonly type: string } }>;
      readonly parent?: ReadonlyArray<{ readonly id: string; readonly definition: { readonly type: string } }>;
    };
  };
}

export interface StatementBuild {
  readonly registration: string;
  readonly statements: readonly XapiStatement[];
  readonly profile: ProfileDocument;
}

const ADL_PROFILE = 'http://adlnet.gov/expapi/activities/profile';

function actor(homePage: string, name: string): XapiStatement['actor'] {
  return { objectType: 'Agent', account: { homePage, name } };
}

function category(pack: WorldPack): XapiStatement['context']['contextActivities']['category'] {
  return [{ id: pack.profileId, definition: { type: ADL_PROFILE } }];
}

function assertNotAGateVerb(id: string): void {
  if ((GATE_VERBS as readonly string[]).includes(id)) {
    throw new WorldError(409, 'gate-verb-refused', `${id} is sent by the course after review, never by this world`);
  }
}

export function buildMissionStatements(input: {
  readonly pack: WorldPack;
  readonly homePage: string;
  readonly actorDid: string;
  readonly missionId: string;
  readonly missionTitle: string;
  readonly missionObject: string;
  readonly symptoms: readonly Symptom[];
  readonly herring: Symptom | undefined;
  readonly progressed: number;
  readonly measured: { readonly raw: number; readonly success: boolean } | undefined;
  readonly timestamp: string;
  readonly registration?: string;
}): StatementBuild {
  const { pack } = input;
  const profile = buildProfile(pack);
  const registration = input.registration ?? randomUUID();
  const missionIri = `${pack.profileId}/missions/${input.missionId}`;
  const parent = [{ id: missionIri, definition: { type: missionActivityType(pack) } }];
  const base = {
    version: '2.0.0' as const,
    timestamp: input.timestamp,
    actor: actor(input.homePage, input.actorDid),
  };
  const contextFor = (withParent: boolean): XapiStatement['context'] => ({
    registration,
    contextActivities: { category: category(pack), ...(withParent ? { parent } : {}) },
  });
  const statements: XapiStatement[] = [];
  const push = (statement: XapiStatement): void => {
    assertNotAGateVerb(statement.verb.id);
    const checked = validateAgainstSuppliedProfile(statement as unknown as Record<string, unknown>, profile as unknown as Record<string, unknown>);
    if (checked.matchedTemplates.length === 0) {
      throw new WorldError(500, 'profile-mismatch', checked.violations.map(v => v.message).join('; ') || 'statement matched no template');
    }
    statements.push(statement);
  };

  const initialized = verbId(pack, 'initialized');
  push({
    ...base,
    id: `${input.homePage}statements/${randomUUID()}`,
    verb: { id: initialized, display: { en: pack.verbs.initialized } },
    object: { objectType: 'Activity', id: missionIri, definition: { type: missionActivityType(pack), name: { en: input.missionTitle } } },
    context: contextFor(false),
  });

  const observed = verbId(pack, 'observed');
  const lines = input.herring ? [...input.symptoms, input.herring] : [...input.symptoms];
  for (const symptom of lines) {
    push({
      ...base,
      id: `${input.homePage}statements/${randomUUID()}`,
      verb: { id: observed, display: { en: pack.verbs.observed } },
      object: {
        objectType: 'Activity',
        id: `${pack.profileId}/symptoms/${encodeURIComponent(symptom.verb)}`,
        definition: { type: symptomActivityType(pack), name: { en: symptom.verb } },
      },
      result: { response: `${symptom.verb} ${input.missionObject}: ${symptom.result}` },
      context: contextFor(true),
    });
  }

  const progressed = verbId(pack, 'progressed');
  for (let i = 0; i < input.progressed; i++) {
    push({
      ...base,
      id: `${input.homePage}statements/${randomUUID()}`,
      verb: { id: progressed, display: { en: pack.verbs.progressed } },
      object: { objectType: 'Activity', id: missionIri, definition: { type: missionActivityType(pack), name: { en: input.missionTitle } } },
      result: { response: `${input.missionObject} checkpoint ${i + 1}` },
      context: contextFor(false),
    });
  }

  if (input.measured) {
    const measured = verbId(pack, 'measured');
    push({
      ...base,
      id: `${input.homePage}statements/${randomUUID()}`,
      verb: { id: measured, display: { en: pack.verbs.measured } },
      object: { objectType: 'Activity', id: missionIri, definition: { type: missionActivityType(pack), name: { en: input.missionTitle } } },
      result: { success: input.measured.success, score: { raw: input.measured.raw } },
      context: contextFor(false),
    });
  }
  return { registration, statements, profile };
}
