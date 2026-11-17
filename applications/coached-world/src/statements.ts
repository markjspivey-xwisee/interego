/**
 * Mission statements for one registration, in the pack's profile.
 *
 * The hidden cause is not written on the stream the consultant reads first.
 * `passed` and `completed` (and the other cmi5 result verbs) are refused here
 * even if a caller asks: those are the course's to send, after a review.
 *
 * The statements of a registration are chained (xapi-x, section 6): each after the first names
 * the one emitted before it and that one's digest, so the order this world emitted them in can
 * be recomputed and cannot be changed afterward. Every statement of a mission's opening carries
 * one timestamp, so without the chain nothing but the array says which came first.
 */
import { randomUUID } from 'node:crypto';
import { validateAgainstSuppliedProfile } from '../../foxxi-content-intelligence/src/xapi-profile-supplied.js';
import { GATE_VERBS, verbId, type Symptom, type WorldPack } from './pack.js';
import { buildProfile, missionActivityType, profileVersion, symptomActivityType, type ProfileDocument } from './profile.js';
import { WorldError } from './errors.js';
import { chained } from '../../foxxi-content-intelligence/src/xapix/statement.js';
import { xapix } from '../../foxxi-content-intelligence/src/xapix/namespace.js';

export interface XapiStatement {
  /** Who stored it, as the LRS says. Set by an LRS on what it returns; this world sets none on what it writes. */
  readonly authority?: { readonly objectType?: string; readonly account?: { readonly homePage?: string; readonly name?: string } };
  readonly id: string;
  readonly version: '2.0.0';
  readonly timestamp: string;
  readonly actor: { readonly objectType: 'Agent'; readonly account: { readonly homePage: string; readonly name: string } };
  readonly verb: { readonly id: string; readonly display: { readonly en: string } };
  readonly object: { readonly objectType: 'Activity'; readonly id: string; readonly definition: { readonly type: string; readonly name?: { readonly en: string } } };
  readonly result?: { readonly success?: boolean; readonly score?: { readonly raw: number }; readonly response?: string; readonly extensions?: Readonly<Record<string, string>> };
  readonly context: {
    readonly registration: string;
    /** The xapi-x ordering keys: the statement before this one, its digest, and the signed order of the registration. */
    readonly extensions?: Readonly<Record<string, string>>;
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

/** The profile VERSION, which is what the templates belong to and what each of them requires here. */
function category(pack: WorldPack): XapiStatement['context']['contextActivities']['category'] {
  return [{ id: profileVersion(pack), definition: { type: ADL_PROFILE } }];
}

/**
 * The statements as they are sent: each naming the one emitted before it in the registration
 * (`after`, for the first of them) and its digest, and the order attestation when one is named.
 */
function inOrder(statements: readonly XapiStatement[], after: XapiStatement | undefined, orderAttestation: string | undefined): XapiStatement[] {
  type Loose = Record<string, unknown>;
  // The attestation is named before the links are made: a link carries the digest of the statement as it is sent.
  const named = orderAttestation === undefined ? statements
    : statements.map(s => ({ ...s, context: { ...s.context, extensions: { ...s.context.extensions, [xapix('orderAttestation')]: orderAttestation } } }));
  return chained([...(after ? [after] : []), ...named] as unknown as Loose[]).slice(after ? 1 : 0) as unknown as XapiStatement[];
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
  /** The statement emitted last in this registration, when there is one: the first built here names it. */
  readonly after?: XapiStatement;
  /** The IRI of the signed descriptor that lists this registration's statements in order, once one is to be written. */
  readonly orderAttestation?: string;
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
  const built: XapiStatement[] = [];
  const push = (statement: XapiStatement): void => { built.push(statement); };

  const initialized = verbId(pack, 'initialized');
  push({
    ...base,
    id: randomUUID(),
    verb: { id: initialized, display: { en: pack.verbs.initialized } },
    object: { objectType: 'Activity', id: missionIri, definition: { type: missionActivityType(pack), name: { en: input.missionTitle } } },
    context: contextFor(false),
  });

  const observed = verbId(pack, 'observed');
  const lines = input.herring ? [...input.symptoms, input.herring] : [...input.symptoms];
  for (const symptom of lines) {
    push({
      ...base,
      id: randomUUID(),
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
      id: randomUUID(),
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
      id: randomUUID(),
      verb: { id: measured, display: { en: pack.verbs.measured } },
      object: { objectType: 'Activity', id: missionIri, definition: { type: missionActivityType(pack), name: { en: input.missionTitle } } },
      result: { success: input.measured.success, score: { raw: input.measured.raw } },
      context: contextFor(false),
    });
  }
  // Checked as sent, with the ordering keys on them.
  const statements = inOrder(built, input.after, input.orderAttestation);
  for (const statement of statements) {
    assertNotAGateVerb(statement.verb.id);
    const checked = validateAgainstSuppliedProfile(statement as unknown as Record<string, unknown>, profile as unknown as Record<string, unknown>);
    if (checked.matchedTemplates.length === 0) {
      throw new WorldError(500, 'profile-mismatch', checked.violations.map(v => v.message).join('; ') || 'statement matched no template');
    }
  }
  return { registration, statements, profile };
}

/**
 * One statement for work an agent actually wrote, under the registration its mission opened.
 *
 * The verb is the pack's `progressed`: the agent got somewhere on the mission, and `response`
 * is what it wrote. It passes the same profile check as every other statement, and the gate
 * verbs are refused here as they are above.
 */
export function buildWorkStatement(input: {
  readonly pack: WorldPack;
  readonly homePage: string;
  readonly actorDid: string;
  readonly missionId: string;
  readonly missionTitle: string;
  readonly response: string;
  readonly timestamp: string;
  readonly registration: string;
  /** The statement emitted last in this registration: this one names it. */
  readonly after?: XapiStatement;
}): XapiStatement {
  const { pack } = input;
  const written: XapiStatement = {
    version: '2.0.0',
    timestamp: input.timestamp,
    actor: actor(input.homePage, input.actorDid),
    id: randomUUID(),
    verb: { id: verbId(pack, 'progressed'), display: { en: pack.verbs.progressed } },
    object: {
      objectType: 'Activity', id: `${pack.profileId}/missions/${input.missionId}`,
      definition: { type: missionActivityType(pack), name: { en: input.missionTitle } },
    },
    result: { response: input.response },
    context: { registration: input.registration, contextActivities: { category: category(pack) } },
  };
  const statement = inOrder([written], input.after, undefined)[0]!;
  assertNotAGateVerb(statement.verb.id);
  const checked = validateAgainstSuppliedProfile(statement as unknown as Record<string, unknown>, buildProfile(pack) as unknown as Record<string, unknown>);
  if (checked.matchedTemplates.length === 0) {
    throw new WorldError(500, 'profile-mismatch', checked.violations.map(v => v.message).join('; ') || 'statement matched no template');
  }
  return statement;
}
