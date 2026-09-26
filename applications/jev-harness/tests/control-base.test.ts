/**
 * Where a judgment's controls point. A bridge that runs on a CI runner serves its judgments at
 * localhost, which no reader can follow; its executable controls can still name the deployed
 * bridge, which answers the same verbs and reads any judgment back from the pod.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';
import { contextFromEnv, controlsFor, judgmentUrl, type PublishContext } from '../src/descriptor.js';
import { calibrationControls } from '../src/calibration-publish.js';
import { navigate } from '../src/judgments/navigate.js';
import { inventory } from '../src/repo.js';
import { fixtureRepo, idOf, preferringJev } from './helpers.js';

// contextFromEnv reads JEV_HARNESS_CONTROL_BASE, which the jev-harness workflow sets to the deployed
// bridge for its whole job. This file expects the controls of a bridge at localhost, so it clears it.
vi.stubEnv('JEV_HARNESS_CONTROL_BASE', '');
afterAll(() => { vi.unstubAllEnvs(); });
const local: PublishContext = { ...contextFromEnv('http://localhost:6090'), controlBase: 'https://harness.example' };

describe('the control base', () => {
  it('sends executable controls to the deployed bridge while the judgment stays where it was made', async () => {
    const inv = inventory(fixtureRepo(), { includeHeads: true });
    const j = await navigate(preferringJev((q, state) => (q === 'change' ? idOf(state, 'src/rollup.ts') : undefined)), inv, { task: 'rollup emits satisfied once per block' });
    const controls = controlsFor(j, local);
    const targets = controls.filter((c) => !c.declarative).map((c) => c.target);
    expect(targets.length).toBeGreaterThan(0);
    expect(targets.every((t) => t?.startsWith('https://harness.example/jev-harness/'))).toBe(true);
    expect(judgmentUrl(j, local)).toBe(`http://localhost:6090/jev-harness/judgments/${j.id}`);
    expect(calibrationControls(local, 'fixture')[0]?.target).toBe('https://harness.example/jev-harness/calibration');
  });

  it('defaults to the bridge\'s own base, as before', async () => {
    const plain = contextFromEnv('http://localhost:6090');
    expect(plain.controlBase).toBeUndefined();
    expect(calibrationControls(plain, 'fixture')[0]?.target).toBe('http://localhost:6090/jev-harness/calibration');
  });
});
