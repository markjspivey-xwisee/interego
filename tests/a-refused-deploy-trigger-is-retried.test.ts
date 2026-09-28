/**
 * A DEPLOY TRIGGER RAILWAY REFUSES ONCE IS TRIED AGAIN, NOT LEFT WRITTEN BUT UNSHIPPED.
 *
 * On 2026-09-28 two consecutive `Auto-deploy master` runs failed at `serviceInstanceDeployV2`
 * with "GraphQL: Problem processing request", seconds after the image repoint had succeeded.
 * The relay went on serving the previous build under a source that named the new one, until a
 * plain re-run of the failed job shipped it. `tools/railway-deploy-trigger.mjs` retries the
 * trigger, a bounded number of times, and `tools/railway-redeploy.mjs` must go through it.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { triggerWithRetry } from '../tools/railway-deploy-trigger.mjs';

const refused = { _transient: 'Problem processing request' };

describe('the deploy trigger is retried', () => {
  it('ships on a later attempt after transient refusals, waiting longer each time', async () => {
    const answers = [refused, refused, { serviceInstanceDeployV2: 'deployment-1' }];
    const trigger = vi.fn(async () => answers.shift()!);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const log = vi.fn();
    expect(await triggerWithRetry(trigger, { sleep, log })).toEqual({ serviceInstanceDeployV2: 'deployment-1' });
    expect(trigger).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map(c => c[0])).toEqual([5000, 10000]);
    expect(log).toHaveBeenCalledTimes(2);
  });

  it('does not wait at all when the first trigger is accepted', async () => {
    const sleep = vi.fn(async (_ms: number) => undefined);
    await triggerWithRetry(async () => ({ serviceInstanceDeployV2: 'd' }), { sleep });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('fails with the refusal once the attempts are spent, so the deploy job still goes red', async () => {
    const trigger = vi.fn(async () => refused);
    await expect(triggerWithRetry(trigger, { sleep: async () => undefined })).rejects.toThrow(/Problem processing request.*4 times/);
    expect(trigger).toHaveBeenCalledTimes(4);
  });

  it('is the path railway-redeploy.mjs ships through', () => {
    const src = readFileSync(new URL('../tools/railway-redeploy.mjs', import.meta.url), 'utf8');
    expect(src).toMatch(/await triggerWithRetry\(\(\) => gql\(\s*'mutation\(\$s:String!,\$e:String!\)\{ serviceInstanceDeployV2/);
    expect(src).toMatch(/serviceInstanceDeployV2\(serviceId:\$s,environmentId:\$e\) \}',\s*\{ s: serviceId, e: environmentId \}, \{ tolerant: true \}\)/);
  });
});
