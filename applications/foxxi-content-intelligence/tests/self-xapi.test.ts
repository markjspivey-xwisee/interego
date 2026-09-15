import { describe, it, expect } from 'vitest';
import { readSelfXapi, writeSelfXapi, type SelfXapiDependencies } from '../src/self-xapi.js';

const did = 'did:web:learner.example:agent';
const id = 'bcc16121-a7f4-4f91-b9fd-bb7fa45a50f7';
const statement = () => ({ id, timestamp: '2026-09-15T03:00:00Z',
  actor: { objectType: 'Agent', account: { homePage: 'https://learner.example', name: did } },
  verb: { id: 'http://adlnet.gov/expapi/verbs/experienced' },
  object: { objectType: 'Activity', id: 'urn:lesson:one' },
  context: { registration: '6c091b62-c9f3-4835-9877-64995bddf9f0', extensions: { 'urn:evidence:graph': 'urn:graph:version:one' } },
});
function harness() {
  const requests: Array<{ method: string; query: string; body?: unknown }> = [];
  const saved: Array<Record<string, unknown>> = [];
  const enriched = { ...statement(), stored: '2026-09-15T03:00:01Z', authority: { account: { homePage: 'https://lrs.example', name: 'lrs' } } };
  const deps: SelfXapiDependencies = {
    request: async (method, query, body) => {
      requests.push({ method, query: query.toString(), body });
      return method === 'POST' ? { status: 200, body: [id] } : { status: 200, body: enriched };
    },
    persist: async s => { saved.push(s); return { persisted: true, descriptorUrl: 'https://pod.example/statement.ttl' }; },
  };
  return { deps, requests, saved, enriched };
}
describe('signed xAPI transport boundary', () => {
  it('preserves the expressive event, registration and exact LRS authority on durable write', async () => {
    const h = harness();
    const result = await writeSelfXapi(did, [statement()], h.deps);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, durable: true, statementIds: [id] });
    expect(h.requests.map(r => r.method)).toEqual(['POST', 'GET']);
    expect(h.saved).toEqual([h.enriched]);
    expect(h.saved[0]?.verb).toEqual(statement().verb);
  });
  it('refuses attribution to another agent before any LRS or durable write', async () => {
    const h = harness();
    expect((await writeSelfXapi('did:web:other.example', [statement()], h.deps)).status).toBe(403);
    expect(h.requests).toHaveLength(0); expect(h.saved).toHaveLength(0);
  });
  it('validates the whole bounded batch before writing any member', async () => {
    const h = harness();
    expect((await writeSelfXapi(did, [statement(), { actor: statement().actor }], h.deps)).status).toBe(400);
    expect(h.requests).toHaveLength(0);
    expect((await writeSelfXapi(did, [statement(), statement()], h.deps)).status).toBe(400);
    expect((await writeSelfXapi(did, Array.from({length: 21}, statement), h.deps)).status).toBe(400);
  });
  it('requires stable ids and observed timestamps and refuses forged LRS fields', async () => {
    for (const s of [{...statement(), id: undefined}, {...statement(), timestamp: undefined}, {...statement(), stored: '2026-09-15T03:00:02Z'}, {...statement(), authority: statement().actor}]) {
      const h = harness(); expect((await writeSelfXapi(did, [s], h.deps)).status).toBe(400); expect(h.requests).toHaveLength(0);
    }
  });
  it('does not claim attachment or statement-voiding transport', async () => {
    const h = harness();
    const s = {...statement(), verb: {id: 'http://adlnet.gov/expapi/verbs/voided'}, object: {objectType: 'StatementRef', id}};
    expect((await writeSelfXapi(did, [s], h.deps)).status).toBe(400);
    expect((await writeSelfXapi(did, [{...statement(), attachments: []}], h.deps)).status).toBe(400);
    expect(h.requests).toHaveLength(0);
  });
  it('returns the existing LRS immutability conflict without persisting', async () => {
    const h = harness(); h.deps.request = async () => ({ status: 409, body: {error: 'different content'} });
    expect(await writeSelfXapi(did, [statement()], h.deps)).toEqual({ status: 409, body: {error: 'different content'} });
    expect(h.saved).toHaveLength(0);
  });
  it('reports LRS acceptance separately when durable persistence fails', async () => {
    const h = harness(); h.deps.persist = async () => ({persisted: false});
    const r = await writeSelfXapi(did, [statement()], h.deps);
    expect(r.status).toBe(502); expect(r.body).toMatchObject({ok: false, lrsAccepted: true, durable: false, statementIds: [id]});
  });
  it('does not substitute submitted content for a missing LRS record', async () => {
    const h = harness(); h.deps.request = async method => method === 'POST' ? {status:200,body:[id]} : {status:404,body:{error:'missing'}};
    expect((await writeSelfXapi(did, [statement()], h.deps)).body).toMatchObject({ok:false,lrsAccepted:true,durable:false});
    expect(h.saved).toHaveLength(0);
  });
  it('returns real LRS pagination unchanged and bounds the requested page', async () => {
    const h = harness(); const result = {statements:[h.enriched], more:'/xapi/statements?cursor=next'};
    h.deps.request = async (method, query) => { h.requests.push({method,query:query.toString()}); return {status:200,body:result}; };
    expect(await readSelfXapi({registration:statement().context.registration, limit:2}, h.deps)).toEqual({status:200,body:result});
    expect(h.requests[0]?.query).toContain('limit=2');
    expect((await readSelfXapi({limit:201}, h.deps)).status).toBe(400);
    expect((await readSelfXapi({target:'https://other.example'}, h.deps)).status).toBe(400);
    expect((await readSelfXapi({cursor:{url:'https://other.example'}}, h.deps)).status).toBe(400);
    expect(h.saved).toHaveLength(0);
  });
  it('does not add query parameters to a by-id read', async () => {
    const h = harness(); await readSelfXapi({statementId:id}, h.deps);
    expect(h.requests[0]?.query).toBe(`statementId=${id}`);
  });
});
