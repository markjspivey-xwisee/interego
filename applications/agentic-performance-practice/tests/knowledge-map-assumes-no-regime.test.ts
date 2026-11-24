/**
 * POST /knowledge/map makes no map for a regime it was not given.
 *
 * The regime chooses the knowledge strategy: codify where the work is Evident
 * or Knowable, enable a flow where it is Emergent. The route used to read a
 * missing regime, and a misspelt one, as Knowable. A caller passing on the
 * `diagnosis.domain` of an unclassified plan (which has none) was answered
 * with things to codify. Found on 2026-11-24 against the deployed bridge.
 */
import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { attachPerformanceRoutes } from '../compatibility/foxxi-performance-routes.js';

const components = [
  { component: 'lived', description: 'reading a customer who is about to leave' },
  { component: 'recorded', description: 'the refund limits table' },
];

async function withRoutes<T>(run: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  attachPerformanceRoutes(app, { selfBaseUrl: 'https://bridge.example' });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  try { return await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`); } finally { server.close(); }
}

async function map(base: string, body: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`${base}/knowledge/map`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
}

describe('POST /knowledge/map assumes no regime', () => {
  it('refuses a regime that was not given, and makes no map', async () => {
    await withRoutes(async base => {
      const answer = await map(base, { competency: 'refund authority', components });
      expect(answer.status).toBe(400);
      expect(answer.body.knowledgeMap).toBeUndefined();
      expect(answer.body.error).toContain('none was given');
      expect(answer.body.error).toContain('Evident, Knowable, Emergent, Turbulent');
    });
  });

  it('refuses a regime that is not one of the four names exactly, and says what it got', async () => {
    await withRoutes(async base => {
      for (const regime of ['emergent', 'Complex', '', null, 3, ['Emergent']]) {
        const answer = await map(base, { competency: 'refund authority', regime, components });
        expect(answer.status, JSON.stringify(regime)).toBe(400);
        expect(answer.body.knowledgeMap, JSON.stringify(regime)).toBeUndefined();
        expect(answer.body.error, JSON.stringify(regime)).toContain(`got ${JSON.stringify(regime)}`);
      }
    });
  });

  it('routes each regime it is given to that regime\'s strategy', async () => {
    await withRoutes(async base => {
      const strategyOf = async (regime: string) => {
        const answer = await map(base, { competency: 'refund authority', regime, components });
        expect(answer.status, regime).toBe(200);
        const made = answer.body.knowledgeMap as { regime: string; strategy: { strategy: string }; toCodify: string[]; toConnect: string[] };
        expect(made.regime).toBe(regime);
        return made;
      };
      const emergent = await strategyOf('Emergent');
      expect(emergent.strategy.strategy).toBe('connect-and-flow');
      expect(emergent.toCodify).toEqual([]);
      expect(emergent.toConnect).toHaveLength(2);
      const knowable = await strategyOf('Knowable');
      expect(knowable.toCodify).toHaveLength(1);
      expect((await strategyOf('Turbulent')).toCodify).toEqual([]);
      expect((await strategyOf('Evident')).toCodify).toHaveLength(1);
    });
  });
});

describe('GET /knowledge says what POST /knowledge/map takes', () => {
  it('publishes the input, the four regimes and the refusal', async () => {
    await withRoutes(async base => {
      const index = await (await fetch(`${base}/knowledge`)).json() as { _affordances: { mapKnowledge: Record<string, unknown> } };
      const act = index._affordances.mapKnowledge;
      expect(act).toMatchObject({ method: 'POST', href: 'https://bridge.example/knowledge/map' });
      const expects = act.expects as Record<string, unknown>;
      expect(Object.keys(expects).sort()).toEqual(['competency', 'components', 'performer', 'regime']);
      for (const regime of ['Evident', 'Knowable', 'Emergent', 'Turbulent']) expect(expects.regime).toContain(`'${regime}'`);
      expect(expects.regime).toContain('required');
      expect(act.refuses).toContain('400');
    });
  });

  it('is answered by the route as it describes itself: what it names as required is required', async () => {
    await withRoutes(async base => {
      expect((await map(base, { regime: 'Emergent', components })).status).toBe(400);
      expect((await map(base, { competency: 'refund authority', regime: 'Emergent' })).status).toBe(400);
      expect((await map(base, { competency: 'refund authority', regime: 'Emergent', components })).status).toBe(200);
    });
  });
});
