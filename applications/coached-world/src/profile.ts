/**
 * The xAPI profile for one world, built from the pack.
 *
 * Same document shape Foxxi already checks in `xapi-profile-supplied.ts` (a profile
 * the caller brings: statement templates, determining properties, rules). Phone-roleplay
 * is that shape specialised to a call's criteria. This is the same shape specialised
 * to whatever verbs and activity types the pack names. The world does not register
 * the profile; it serves the document, and a profile server may keep it.
 *
 * It is a whole xAPI Profiles 1.0 document, so a profile server or another processor can
 * take it as served: it says what it conforms to, which version it is, and it declares
 * every verb, activity type and extension its templates name, each with a label and a
 * definition. A statement names the VERSION in its category, because the version is what
 * its templates belong to, and each template requires it. The patterns say what one
 * registration holds, and the tests run them over what the world really emits.
 */
import type { WorldPack } from './pack.js';
import { verbId } from './pack.js';

type Lang = { readonly en: string };
export interface ProfileConcept {
  readonly id: string;
  readonly type: 'Verb' | 'ActivityType' | 'ResultExtension';
  readonly inScheme: string;
  readonly prefLabel: Lang;
  readonly definition: Lang;
  readonly inlineSchema?: string;
}
export interface ProfileDocument {
  readonly '@context': 'https://w3id.org/xapi/profiles/context';
  readonly id: string;
  readonly type: 'Profile';
  readonly conformsTo: 'https://w3id.org/xapi/profiles#1.0';
  readonly prefLabel: Lang;
  readonly definition: Lang;
  readonly versions: ReadonlyArray<{ readonly id: string; readonly generatedAtTime: string }>;
  readonly author: { readonly type: 'Organization'; readonly name: string };
  readonly concepts: readonly ProfileConcept[];
  readonly templates: ReadonlyArray<Record<string, unknown>>;
  readonly patterns: ReadonlyArray<Record<string, unknown>>;
}

/**
 * When this shape of document was first written. A version's time is when that version was
 * made, so it is a constant: a document that restamps itself on every request says it is a
 * new version each time it is read.
 */
const VERSION_GENERATED_AT = '2026-11-15T00:00:00Z';

/** The version a statement names in its category and every concept, template and pattern is in. */
export function profileVersion(pack: WorldPack): string {
  return `${pack.profileId}/v/1`;
}
export function missionActivityType(pack: WorldPack): string {
  return `${pack.profileId}/activity-types/mission`;
}
export function symptomActivityType(pack: WorldPack): string {
  return `${pack.profileId}/activity-types/symptom`;
}

const VERBS = {
  initialized: 'An agent opened a mission, or took it up again to settle it. The first statement of the mission\'s registration.',
  observed: 'An agent saw one symptom of the mission. What it saw is the response; the cause behind it is not stated.',
  progressed: 'An agent got somewhere on the mission. The response is the checkpoint it reached or the work it wrote.',
  measured: 'The mission\'s measure was read after an intervention: a raw score, and whether the intervention matched the cause.',
} as const;

export function buildProfile(pack: WorldPack): ProfileDocument {
  const id = pack.profileId;
  const version = profileVersion(pack);
  const mission = missionActivityType(pack), symptom = symptomActivityType(pack);
  const cause = `${id}/ext/cause`;
  const lang = (en: string): Lang => ({ en });
  const names = ['initialized', 'observed', 'progressed', 'measured'] as const;
  const template = (name: (typeof names)[number], definition: string, more: Record<string, unknown>, rules: ReadonlyArray<Record<string, unknown>>): Record<string, unknown> => ({
    id: `${id}/templates/${name}`,
    type: 'StatementTemplate',
    inScheme: version,
    prefLabel: lang(pack.verbs[name]),
    definition: lang(definition),
    verb: verbId(pack, name),
    ...more,
    rules: [
      { location: '$.context.registration', presence: 'included' },
      { location: '$.context.contextActivities.category[*].id', presence: 'included', any: [version] },
      ...rules,
    ],
  });
  const pattern = (name: string, definition: string, primary: boolean, body: Record<string, unknown>): Record<string, unknown> => ({
    id: `${id}/patterns/${name}`, type: 'Pattern', inScheme: version, primary, prefLabel: lang(name), definition: lang(definition), ...body,
  });
  const t = (name: (typeof names)[number]): string => `${id}/templates/${name}`;
  const p = (name: string): string => `${id}/patterns/${name}`;
  return {
    '@context': 'https://w3id.org/xapi/profiles/context',
    id,
    type: 'Profile',
    conformsTo: 'https://w3id.org/xapi/profiles#1.0',
    prefLabel: lang(`${pack.title} — coached performance`),
    definition: lang(`What an agent does on a mission in ${pack.title}: it opens the mission, observes symptoms, progresses, and is measured after an intervention. The cause a mission hides is never on the stream, and the world sends no passed, failed or completed: those are a course's to send after review.`),
    versions: [{ id: version, generatedAtTime: VERSION_GENERATED_AT }],
    author: { type: 'Organization', name: `${pack.title} world pack` },
    concepts: [
      ...names.map(name => ({ id: verbId(pack, name), type: 'Verb' as const, inScheme: version, prefLabel: lang(pack.verbs[name]), definition: lang(VERBS[name]) })),
      { id: mission, type: 'ActivityType', inScheme: version, prefLabel: lang('mission'), definition: lang('A unit of work an agent is sent to do, with a measure that an intervention can move.') },
      { id: symptom, type: 'ActivityType', inScheme: version, prefLabel: lang('symptom'), definition: lang('Something observable about a mission that is going wrong. Several causes can show the same symptom.') },
      {
        id: cause, type: 'ResultExtension', inScheme: version, prefLabel: lang('cause'),
        definition: lang('The cause a mission hides. Declared so the rule that keeps it off the stream names a defined term; no statement carries it.'),
        inlineSchema: JSON.stringify({ type: 'string' }),
      },
    ],
    templates: [
      template('initialized', 'Opens a mission. Must not state the cause.', { objectActivityType: mission }, [
        { location: `$.result.extensions['${cause}']`, presence: 'excluded' },
      ]),
      template('observed', 'One symptom seen on a mission, which is its parent. The response says what was seen.', { objectActivityType: symptom, contextParentActivityType: [mission] }, [
        { location: '$.result.response', presence: 'included' },
      ]),
      template('progressed', 'A checkpoint reached on a mission, or the work an agent wrote for it.', { objectActivityType: mission }, []),
      template('measured', 'The measure read after an intervention, with whether the intervention matched.', { objectActivityType: mission }, [
        { location: '$.result.score.raw', presence: 'included' },
        { location: '$.result.success', presence: 'included' },
      ]),
    ],
    patterns: [
      // What the world writes, as the tests read it back from the builders. A settlement opens
      // with a second `initialized`: the statement builder writes one at the head of every batch,
      // and the batch that settles a mission is built under the mission's own registration.
      pattern('mission', 'One mission under one registration: it is opened, its symptoms are observed, the agent progresses any number of times, and it is settled at most once. A mission nobody settled ends without a measure.', true, {
        sequence: [t('initialized'), p('observations'), p('work'), p('outcome')],
      }),
      pattern('observations', 'The symptoms seen when the mission opened.', false, { oneOrMore: t('observed') }),
      pattern('work', 'The checkpoints reached and the work written.', false, { zeroOrMore: t('progressed') }),
      pattern('outcome', 'The settlement, present only when an intervention was made.', false, { optional: p('settlement') }),
      pattern('settlement', 'An intervention was made: the mission is taken up again, the agent progresses if the intervention matched the cause, and the measure is read.', false, {
        sequence: [t('initialized'), p('work'), t('measured')],
      }),
      pattern('standing-measure', 'A measure read with no symptoms observed first: an intervention the world made on its own, recorded under a registration of its own.', true, {
        sequence: [t('initialized'), t('measured')],
      }),
    ],
  };
}
