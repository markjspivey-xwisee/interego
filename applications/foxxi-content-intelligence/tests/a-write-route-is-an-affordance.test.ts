/**
 * A route that changes or signs for something is offered as an affordance.
 *
 * ★ WHY. Foxxi is reached by following what its descriptor offers (GET /affordances): a client
 * names an action, the descriptor says where and how. A route the bridge serves but the descriptor
 * does not offer can only be used by a client that was told its path some other way, which is the
 * thing this bridge is built not to need. Nothing held new routes to that. `declared-but-
 * unimplemented` checks the descriptor against the handlers; this is the other direction.
 *
 * It is a ratchet. The routes below were not in applications/foxxi-content-intelligence/affordances.ts
 * on 2026-11-26. Some are offered by a descriptor of their own or are callbacks no agent starts;
 * nobody has gone through them one by one, so the list says only that, and may only shrink. A new
 * write route is offered in affordances.ts or added here with the reason it is not.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const server = readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8');
const descriptor = readFileSync(new URL('../affordances.ts', import.meta.url), 'utf8');

const NOT_IN_AFFORDANCES_TS: readonly string[] = [
  'delete /agent/mesh/enrolment',
  'post /agent/landing-tour',
  'post /agent/lattice/self',
  'post /agent/llm-telemetry/capture/read',
  'post /agent/llm-telemetry/capture/update',
  'post /agent/llm-telemetry/collector/create',
  'post /agent/llm-telemetry/collector/revoke',
  'post /agent/llm-telemetry/ingest',
  'post /agent/llm-telemetry/query',
  'post /agent/mesh-event',
  'post /agent/mesh/enrolment',
  'post /llm-telemetry/otlp/v1/logs',
  'post /lti/connections/revoke',
  'post /lti/play/:id',
  'post /ns/foxxi/composition/:hash/au/next',
  'post /ns/foxxi/composition/:hash/au/session',
  'post /play/grant',
];

const shape = (path: string): string => path.replace(/:[A-Za-z_]+/g, '{}').replace(/\{[^}]*\}/g, '{}');

describe('the write routes bridge/server.ts mounts itself', () => {
  const routes = [...new Set([...server.matchAll(/^app\.(post|put|delete|patch)\('(\/[^']*)'/gm)].map(m => `${m[1]} ${m[2]}`))].sort();
  const offered = new Set([...descriptor.matchAll(/targetTemplate: '\{base\}([^']*)'/g)].map(m => shape(m[1]!)));
  const unoffered = routes.filter(r => !offered.has(shape(r.slice(r.indexOf(' ') + 1))));

  it('finds the routes and the descriptor it is reading', () => {
    expect(routes.length).toBeGreaterThan(50);
    expect(offered.size).toBeGreaterThan(100);
  });

  it('are each offered in affordances.ts, or on the list of those that are not', () => {
    expect(unoffered).toEqual([...NOT_IN_AFFORDANCES_TS].sort());
  });

  it('include every route added for agents learning beside people, all of them offered', () => {
    for (const path of ['/agent/learning/beside', '/agent/learning/assign', '/agent/cmi5/launch', '/agent/scorm/host', '/agent/scorm/host/remove']) {
      expect(routes).toContain(`post ${path}`);
      expect(offered.has(path)).toBe(true);
    }
  });
});
