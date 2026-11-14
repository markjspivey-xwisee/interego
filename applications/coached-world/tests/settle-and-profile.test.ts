import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateAgainstSuppliedProfile } from '../../foxxi-content-intelligence/src/xapi-profile-supplied.js';
import { PackError } from '../src/errors.js';
import { loadPack, loadPackFile, publicPack } from '../src/pack.js';
import { buildProfile } from '../src/profile.js';
import { baseline, drawCause, openingSymptoms, settle } from '../src/settle.js';
import { buildMissionStatements } from '../src/statements.js';

const here = dirname(fileURLToPath(import.meta.url));
const orchard = loadPackFile(join(here, '../packs/orchard.json'));
const mandate = loadPackFile(join(here, '../packs/mandate.json'));
const zero = () => 0;

describe('a world pack is the policy', () => {
  it('loads two packs and does not hand the browser the cause map', () => {
    expect(orchard.title).toBe('Orchard');
    expect(mandate.factions).toHaveLength(4);
    expect(mandate.territories.length).toBeGreaterThan(10);
    const shown = publicPack(mandate);
    expect(JSON.stringify(shown)).not.toContain('addresses');
    expect(JSON.stringify(shown)).not.toContain('wrong procedure');
    expect(shown.causes.map(c => c.id)).toContain('skill');
  });

  it('refuses a pack that would have the world emit a cmi5 result verb', () => {
    const raw = JSON.parse(readFileSync(join(here, '../packs/orchard.json'), 'utf8')) as { verbs: { measured: string } };
    raw.verbs.measured = 'passed';
    expect(() => loadPack(raw)).toThrow(PackError);
    raw.verbs.measured = 'completed';
    expect(() => loadPack(raw)).toThrow(/passed, completed/);
  });

  it('keeps Mandate, and every faction name, out of the engine', () => {
    for (const file of ['settle.ts', 'statements.ts', 'profile.ts', 'world.ts', 'graphs.ts', 'server.ts']) {
      const source = readFileSync(join(here, '../src', file), 'utf8');
      expect(source, file).not.toMatch(/Mandate|meridian|Juno-7|Gilbert/);
    }
  });
});

describe('settlement', () => {
  const mission = orchard.missions[0]!;
  const timing = orchard.causes[0]!;
  const press = orchard.causes[1]!;

  it('moves the score only when the intervention addresses the drawn cause', () => {
    const hit = settle({
      pack: orchard, mission, tier: 0, cause: timing, before: 50, diagnosisId: 'timing', interventionId: 'calendar',
      allies: 0, rivals: 0, factionId: 'north', factionOrder: ['north', 'south'],
      control: { north: 50, south: 50 }, rng: zero,
    });
    expect(hit.matched).toBe(true);
    expect(hit.delta).toBeGreaterThan(0);
    expect(hit.after).toBe(hit.before + hit.delta);
    const miss = settle({
      pack: orchard, mission, tier: 0, cause: timing, before: 50, diagnosisId: 'press', interventionId: 'repair',
      allies: 0, rivals: 0, factionId: 'north', factionOrder: ['north', 'south'],
      control: { north: 50, south: 50 }, rng: zero,
    });
    expect(miss.matched).toBe(false);
    expect(miss.delta).toBe(0);
    expect(miss.after).toBe(50);
    expect(miss.diagnosed).toBe(false);
    expect(miss.gain).toBe(0);
    expect(press.id).toBe('press');
  });

  it('draws the cause from the mission weights and remembers a matching lesson in the baseline', () => {
    expect(drawCause(orchard, mission, 0, zero).id).toBe('timing');
    const plain = baseline(orchard, mission, 0, false, zero);
    const remembered = baseline(orchard, mission, 0, true, zero);
    expect(remembered - plain).toBe(orchard.scoring.memoryBaselineLift);
  });

  it('hides the cause id in the opening statements and checks them against the pack profile', () => {
    const cause = drawCause(orchard, mission, 0, zero);
    const { symptoms, herring } = openingSymptoms(orchard, cause, zero);
    const built = buildMissionStatements({
      pack: orchard, homePage: 'http://127.0.0.1:9/', actorDid: 'did:web:example:agents:pip',
      missionId: mission.id, missionTitle: mission.title, missionObject: mission.object,
      symptoms, herring, progressed: 1, measured: { raw: 60, success: true }, timestamp: '2026-11-14T00:00:00.000Z',
    });
    const profile = buildProfile(orchard);
    expect(built.profile.id).toBe(orchard.profileId);
    for (const statement of built.statements) {
      expect(statement.verb.id).not.toMatch(/\/passed$|adlnet\.gov\/expapi\/verbs\/(passed|completed|failed)/);
      expect(JSON.stringify(statement)).not.toContain('"cause"');
      expect(validateAgainstSuppliedProfile(statement as unknown as Record<string, unknown>, profile as unknown as Record<string, unknown>).matchedTemplates.length).toBeGreaterThan(0);
    }
    const mandateBuilt = buildMissionStatements({
      pack: mandate, homePage: 'http://127.0.0.1:9/', actorDid: 'did:web:example:agents:juno',
      missionId: mandate.missions[0]!.id, missionTitle: mandate.missions[0]!.title, missionObject: 'convoy',
      symptoms: mandate.causes[0]!.symptoms, herring: undefined, progressed: 0, measured: undefined,
      timestamp: '2026-11-14T00:00:00.000Z',
    });
    expect(mandateBuilt.profile.id).not.toBe(built.profile.id);
  });
});
