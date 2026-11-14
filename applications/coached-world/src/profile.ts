/**
 * The xAPI profile for one world, built from the pack.
 *
 * Same document shape Foxxi already checks in `xapi-profile-supplied.ts` (a profile
 * the caller brings: statement templates, determining properties, rules). Phone-roleplay
 * is that shape specialised to a call's criteria. This is the same shape specialised
 * to whatever verbs and activity types the pack names. The world does not register
 * the profile; it serves the document, and a profile server may keep it.
 */
import type { WorldPack } from './pack.js';
import { verbId } from './pack.js';

export interface ProfileDocument {
  readonly id: string;
  readonly type: 'Profile';
  readonly concepts: ReadonlyArray<{ readonly id: string; readonly type: 'Verb'; readonly inScheme: string }>;
  readonly templates: ReadonlyArray<Record<string, unknown>>;
}

export function missionActivityType(pack: WorldPack): string {
  return `${pack.profileId}/activity-types/mission`;
}
export function symptomActivityType(pack: WorldPack): string {
  return `${pack.profileId}/activity-types/symptom`;
}

export function buildProfile(pack: WorldPack): ProfileDocument {
  const id = pack.profileId;
  const names = ['initialized', 'observed', 'progressed', 'measured'] as const;
  return {
    id,
    type: 'Profile',
    concepts: names.map(name => ({ id: verbId(pack, name), type: 'Verb' as const, inScheme: id })),
    templates: [
      {
        id: `${id}/templates/initialized`,
        type: 'StatementTemplate',
        verb: verbId(pack, 'initialized'),
        objectActivityType: missionActivityType(pack),
        rules: [
          { location: '$.context.registration', presence: 'included' },
          { location: `$.result.extensions['${id}/ext/cause']`, presence: 'excluded' },
        ],
      },
      {
        id: `${id}/templates/observed`,
        type: 'StatementTemplate',
        verb: verbId(pack, 'observed'),
        objectActivityType: symptomActivityType(pack),
        contextParentActivityType: [missionActivityType(pack)],
        rules: [
          { location: '$.context.registration', presence: 'included' },
          { location: '$.result.response', presence: 'included' },
        ],
      },
      {
        id: `${id}/templates/progressed`,
        type: 'StatementTemplate',
        verb: verbId(pack, 'progressed'),
        objectActivityType: missionActivityType(pack),
        rules: [{ location: '$.context.registration', presence: 'included' }],
      },
      {
        id: `${id}/templates/measured`,
        type: 'StatementTemplate',
        verb: verbId(pack, 'measured'),
        objectActivityType: missionActivityType(pack),
        rules: [
          { location: '$.context.registration', presence: 'included' },
          { location: '$.result.score.raw', presence: 'included' },
          { location: '$.result.success', presence: 'included' },
        ],
      },
    ],
  };
}
