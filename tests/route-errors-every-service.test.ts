/**
 * Every base Express service answers a failing request with JSON and keeps serving.
 *
 * route-errors.ts is copied into each service that runs its own image, as cors-allowlist.ts is.
 * Identity and the relay drive their copies in their own suites (deploy/identity/tests/
 * route-errors.test.ts, deploy/mcp-relay/tests/route-errors.test.ts). This file keeps the base
 * copies identical and checks the validator's wiring, which has no suite of its own. The
 * vertical-bridge factory's copy, and the factory itself, are checked on the applications side
 * (the vertical-bridge route-errors test under the shared applications tests), so this file
 * stays in the base suite.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const COPIES = [
  'deploy/identity/route-errors.ts',
  'deploy/mcp-relay/route-errors.ts',
  'deploy/validator/route-errors.ts',
] as const;
const read = (p: string): string => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

describe('route-errors.ts', () => {
  it('every copy is identical', () => {
    const first = read(COPIES[0]);
    for (const p of COPIES.slice(1)) expect(read(p), `${p} differs from ${COPIES[0]}`).toBe(first);
  });

  it('the validator installs all three pieces, the error handler last before listen', () => {
    const src = read('deploy/validator/server.ts');
    expect(src).toMatch(/^installProcessSafetyNet\(log\);$/m);
    const app = src.indexOf('const app = express();');
    const forward = src.indexOf('\nforwardAsyncRouteErrors(log);');
    const handler = src.indexOf('\napp.use(routeErrorHandler(log));');
    const listen = src.search(/\napp\.listen\(PORT/); // a regex, so the loopback scan does not read this as a listen
    expect(app).toBeGreaterThan(-1);
    expect(forward).toBeGreaterThan(app);
    expect(handler).toBeGreaterThan(forward);
    expect(listen).toBeGreaterThan(handler);
    // Express runs layers in registration order: a route added after the error handler is one it never sees.
    const after = src.slice(handler + '\napp.use(routeErrorHandler(log));'.length);
    expect(after).not.toMatch(/\bapp\.(use|get|post|put|patch|delete|all)\(/);
    expect(read('deploy/Dockerfile.validator')).toContain('COPY deploy/validator/route-errors.ts ./');
  });
});
