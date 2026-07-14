// Regression: the affordance follower MUST NOT send a request body on a GET — the
// Fetch spec throws "Request with GET/HEAD method cannot have body". An HMD read
// control is invoked with the schema-required `{}` payload, which was being
// serialized and forwarded as a GET body → the follow failed before reaching the
// target (georgio's live health-probe end-to-end test). Covers both follow paths:
// act() pre-resolved (the graph-declared-target path) and followAffordance()
// (descriptor-declared).
import { describe, it, expect } from 'vitest';
import { act, followAffordance } from '@interego/core';
import type { IRI } from '@interego/core';

type Init = { method?: string; body?: unknown };
const resp = (text: string, ct = 'text/plain') => ({
  status: 200, statusText: 'OK', ok: true,
  headers: { get: (_h: string) => ct },
  text: async () => text,
});

describe('follower omits the body on GET', () => {
  it('act() on a pre-resolved GET affordance sends NO body, even with a payload', async () => {
    let captured: unknown = 'UNSET';
    const fetchFn = (async (_url: string, init?: Init) => { captured = init?.body; return resp('ok'); }) as never;
    const res = await act(
      { action: 'https://x/ns#peek', target: 'https://relay.example/health', method: 'GET' },
      {}, // the schema-required payload that used to become a GET body
      { fetch: fetchFn },
    );
    expect(res.status).toBe(200);
    expect(res.body).toBe('ok');
    expect(captured).toBeUndefined();
  });

  it('followAffordance() on a descriptor GET affordance sends NO body', async () => {
    const descriptor = `@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix hydra: <http://www.w3.org/ns/hydra/core#> .
<https://relay.example/desc.ttl> a iep:ContextDescriptor ; iep:affordance <#peek> .
<#peek> a iep:Affordance, hydra:Operation ; iep:action <https://x/ns#peek> ; hydra:target <https://relay.example/health> ; hydra:method "GET" .`;
    let captured: unknown = 'UNSET';
    const fetchFn = (async (url: string, init?: Init) => {
      if (url.endsWith('desc.ttl')) return resp(descriptor, 'text/turtle');
      captured = init?.body;
      return resp('ok');
    }) as never;
    const r = await followAffordance('https://relay.example/desc.ttl', 'https://x/ns#peek' as IRI, {}, { fetch: fetchFn });
    expect(r.status).toBe(200);
    expect(captured).toBeUndefined();
  });

  it('POST still forwards the body (no regression for mutating affordances)', async () => {
    let captured: unknown = 'UNSET';
    const fetchFn = (async (_url: string, init?: Init) => { captured = init?.body; return resp('{}', 'application/json'); }) as never;
    await act(
      { action: 'https://x/ns#do', target: 'https://relay.example/act', method: 'POST' },
      { a: 1 },
      { fetch: fetchFn },
    );
    expect(captured).toBe(JSON.stringify({ a: 1 }));
  });
});
