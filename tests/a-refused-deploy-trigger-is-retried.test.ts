/**
 * A DEPLOY TRIGGER RAILWAY REFUSES IS TRIED AGAIN — ONLY WHEN IT WAS REFUSED, AND NEVER OVER A
 * DEPLOYMENT THAT MAY BE IN FLIGHT.
 *
 * On 2026-09-28 two consecutive `Auto-deploy master` runs failed at `serviceInstanceDeployV2`
 * with "GraphQL: Problem processing request", seconds after the image repoint had succeeded, and
 * the relay went on serving the previous build until a plain re-run shipped it (#560). Codex then
 * found the first retry re-triggered after ambiguous failures too, where Railway may already have
 * accepted the trigger — and re-triggering an in-flight deploy SIGTERMs the healthy container,
 * which is why `railway-redeploy.mjs` says "DO NOT RETRY". These pin the narrower rule.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { triggerWithRetry } from '../tools/railway-deploy-trigger.mjs';

const refusal = () => new Error('GraphQL: Problem processing request');

describe('the deploy trigger', () => {
  it('ships on a later attempt after answered refusals, waiting longer each time', async () => {
    let calls = 0;
    const trigger = vi.fn(async () => {
      calls++;
      if (calls < 3) throw refusal();
      return { serviceInstanceDeployV2: 'deployment-1' };
    });
    const sleep = vi.fn(async (_ms: number) => undefined);
    const reconcile = vi.fn(async () => undefined);
    expect(await triggerWithRetry(trigger, { sleep, reconcile })).toEqual({ serviceInstanceDeployV2: 'deployment-1' });
    expect(trigger).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(c => c[0])).toEqual([5000, 10000]);
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it('does not retry an ambiguous failure, where the trigger may have been accepted', async () => {
    const trigger = vi.fn(async () => { throw new Error('network: socket hang up'); });
    const sleep = vi.fn(async (_ms: number) => undefined);
    await expect(triggerWithRetry(trigger, { sleep })).rejects.toThrow(/socket hang up/);
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('follows a deployment that exists since the repoint instead of triggering over it', async () => {
    const trigger = vi.fn(async () => { throw refusal(); });
    const sleep = vi.fn(async (_ms: number) => undefined);
    expect(await triggerWithRetry(trigger, { sleep, reconcile: async () => 'deployment-already-running' }))
      .toEqual({ serviceInstanceDeployV2: 'deployment-already-running' });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails with the refusal once the attempts are spent, so the deploy job still goes red', async () => {
    const trigger = vi.fn(async () => { throw refusal(); });
    await expect(triggerWithRetry(trigger, { sleep: async () => undefined })).rejects.toThrow(/Problem processing request.*4 times/);
    expect(trigger).toHaveBeenCalledTimes(4);
  });

  it('does not wait at all when the first trigger is accepted', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    await triggerWithRetry(async () => ({ serviceInstanceDeployV2: 'd' }), { sleep });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('is the path railway-redeploy.mjs ships through: answered refusals only, reconciled against the pre-repoint deployment', () => {
    const src = readFileSync(new URL('../tools/railway-redeploy.mjs', import.meta.url), 'utf8');
    // The trigger's gql is NOT tolerant: a refusal throws `GraphQL: …`, a lost answer `network: …`.
    expect(src).toMatch(/await triggerWithRetry\(\(\) => gql\(\s*'mutation\(\$s:String!,\$e:String!\)\{ serviceInstanceDeployV2\(serviceId:\$s,environmentId:\$e\) \}',\s*\{ s: serviceId, e: environmentId \}\), \{/);
    expect(src).toMatch(/const deploymentBeforeRepoint = await latestDeploymentId\(\);\s*\n\s*\n\/\/ ── 3\. Repoint/);
    expect(src).toMatch(/return now && now !== deploymentBeforeRepoint \? now : undefined;/);
  });
});
