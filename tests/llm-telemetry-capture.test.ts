import { describe, expect, it, vi } from 'vitest';
import { captureResource, readCapturePreferences, updateCapturePreferences, withCaptureConsent, type CaptureStore } from '../applications/llm-telemetry/capture.js';
import { RequestObservers, loadRequestObservers, type RequestObservationContext } from '../deploy/mcp-relay/request-observers.js';
import { createRelayObserver } from '../applications/llm-telemetry/relay-observer.js';
import { captureView } from '../applications/llm-telemetry/view.js';
import { eventStatement, normalizeEvent, telemetryMetadata } from '../applications/llm-telemetry/events.js';
import { mergeTelemetrySnapshot, normalizeQuery, telemetryReport } from '../applications/llm-telemetry/service.js';
import { parseHypermediaMarkdown, liftHypermediaMarkdown } from '@interego/core';

const actor = 'did:web:example.org:observer';
const time = '2026-09-17T00:01:00.000Z';
const event = (coverage = 'hook') => ({ kind: 'tool-completed', tool_use_id: 'op', source: 'client-one', session_id: 'chat-one', source_event_id: 'one', capture_mode: 'validation', coverage });
function store() {
  const records: unknown[] = []; let unavailable = false; let persist = true;
  const deps: CaptureStore = { now: () => time, load: async () => unavailable ? null : records,
    persist: async r => { if (persist) records.push({ ...r }); return persist; } };
  return { records, deps, unavailable: () => { unavailable = true; }, fail: () => { persist = false; } };
}
describe('independent durable capture consent', () => {
  it.each([[false,false],[true,false],[false,true],[true,true]])('gates server=%s and client=%s separately', async (server_enabled, client_enabled) => {
    const s = store();
    const preferences = await updateCapturePreferences(actor, { server_enabled, client_enabled }, s.deps);
    for (const [coverage, enabled] of [['server-observation',server_enabled], ['hook',client_enabled], ['runtime-adapter',client_enabled]] as const) {
      const work = vi.fn(async () => 'stored');
      const run = withCaptureConsent(actor, [event(coverage)], preferences.revision, s.deps, work);
      if (enabled) { expect(await run).toBe('stored'); expect(work).toHaveBeenCalledOnce(); }
      else { await expect(run).rejects.toMatchObject({ status:403 }); expect(work).not.toHaveBeenCalled(); }
    }
  });
  it('defaults both off, persists a single toggle without replacing the other, and retries exactly', async () => {
    const s = store(); expect(await readCapturePreferences(actor, s.deps)).toMatchObject({ revision:0, server_enabled:false, client_enabled:false });
    await updateCapturePreferences(actor, { server_enabled:true, expected_revision:0 }, s.deps);
    const both = await updateCapturePreferences(actor, { client_enabled:true, expected_revision:1 }, s.deps);
    expect(both).toMatchObject({ revision:2, server_enabled:true, client_enabled:true });
    expect(await updateCapturePreferences(actor, { client_enabled:true, expected_revision:1 }, s.deps)).toEqual(both);
    expect(s.records).toHaveLength(2);
    await expect(updateCapturePreferences(actor, { client_enabled:false, expected_revision:1 }, s.deps)).rejects.toMatchObject({ status:409 });
  });
  it('serializes racing toggles and scopes encrypted resources by observer', async () => {
    const s = store(); await Promise.all([updateCapturePreferences(actor, { server_enabled:true }, s.deps), updateCapturePreferences(actor, { client_enabled:true }, s.deps)]);
    expect(await readCapturePreferences(actor, s.deps)).toMatchObject({ revision:2, server_enabled:true, client_enabled:true });
    expect(captureResource(actor)).not.toBe(captureResource('did:web:other'));
    await expect(readCapturePreferences('did:web:other', s.deps)).rejects.toMatchObject({ status:503 });
  });
  it('refuses intake after disable, and refuses old server consent after re-enable', async () => {
    const s = store(); const p = await updateCapturePreferences(actor, { server_enabled:true, client_enabled:true }, s.deps);
    await updateCapturePreferences(actor, { server_enabled:false, client_enabled:false }, s.deps);
    const work=vi.fn(async()=>true);
    await expect(withCaptureConsent(actor,[event()],undefined,s.deps,work)).rejects.toMatchObject({status:403});
    await updateCapturePreferences(actor,{server_enabled:true},s.deps);
    await expect(withCaptureConsent(actor,[event('server-observation')],p.revision,s.deps,work)).rejects.toMatchObject({status:409});
    expect(work).not.toHaveBeenCalled();
  });
  it('refuses missing durability, conflicting revisions, malformed settings and mixed denied batches', async () => {
    const s=store();s.fail(); await expect(updateCapturePreferences(actor,{client_enabled:true},s.deps)).rejects.toMatchObject({status:502});
    expect(await readCapturePreferences(actor,s.deps)).toMatchObject({client_enabled:false});
    s.unavailable();await expect(withCaptureConsent(actor,[event()],undefined,s.deps,async()=>true)).rejects.toMatchObject({status:503});
    await expect(updateCapturePreferences(actor,{server_enabled:'true'},s.deps)).rejects.toMatchObject({status:400});
    await expect(updateCapturePreferences(actor,{observer:'someone-else'},s.deps)).rejects.toMatchObject({status:400});
    const conflict=store();conflict.records.push({observer:actor,revision:1,server_enabled:true,client_enabled:false,updated_at:time},{observer:actor,revision:1,server_enabled:false,client_enabled:false,updated_at:time});
    await expect(readCapturePreferences(actor,conflict.deps)).rejects.toMatchObject({status:503});
    const mixed=store();await updateCapturePreferences(actor,{server_enabled:true},mixed.deps);const work=vi.fn(async()=>true);
    await expect(withCaptureConsent(actor,[event('server-observation'),{...event(),source_event_id:'two'}],1,mixed.deps,work)).rejects.toMatchObject({status:403});expect(work).not.toHaveBeenCalled();
  });
  it('keeps an explicit manual action separate and validates it before storage', async () => {
    const s=store();s.unavailable();expect(await withCaptureConsent(actor,[event('manual-observation')],undefined,s.deps,async()=>true)).toBe(true);
    const work=vi.fn(async()=>true); await expect(withCaptureConsent(actor,[{...event('manual-observation'),prompt:'content'}],undefined,s.deps,work)).rejects.toMatchObject({status:400});expect(work).not.toHaveBeenCalled();
  });
  it('renders executable independent choices, preserving boolean defaults and revision', () => {
    const view=captureView('https://example.org',{observer:actor,revision:3,server_enabled:true,client_enabled:false,updated_at:time});
    const doc=parseHypermediaMarkdown(view.hmd);
    expect(doc.controls).toHaveLength(6);
    expect(view.controls.find(c=>c.id==='server')?.payload).toEqual({server_enabled:false,expected_revision:3});
    expect(view.controls.find(c=>c.id==='client')?.payload).toEqual({client_enabled:true,expected_revision:3});
    expect(liftHypermediaMarkdown(view.hmd).some(t=>t.p==='http://www.w3.org/ns/shacl#defaultValue'&&t.o==='false')).toBe(true);
    expect(view.body).toContain('does not install or trust');
  });
});

function observerContext(policy: {server_enabled:boolean;revision:number}) {
  const deliveries: Array<Record<string,unknown>>=[]; let ticks=0;
  const follow=vi.fn(async (_descriptor:string, action:string, payload:Record<string,unknown>)=> {
    if(action.endsWith('capture-read')) return JSON.stringify({status:200,body:JSON.stringify({preferences:{...policy}})});
    deliveries.push(payload);return JSON.stringify({status:200,body:JSON.stringify({ok:true,durable:true,statementIds:['start','end']})});
  });
  const context:RequestObservationContext={principal:actor,tool:'dereference',now:()=>new Date(Date.parse(time)+ticks++*1000).toISOString(),follow};
  return{context,follow,deliveries};
}
describe('automatic Interego request observations',()=>{
  it('records actual start/end boundaries, preserves result and records no arguments, results or invented usage',async()=>{
    const c=observerContext({server_enabled:true,revision:1}); const observers=new RequestObservers([createRelayObserver()]);
    const work=vi.fn(async()=>({content:[{type:'text',text:'private output'}],structuredContent:{value:42}}));
    const result=await observers.run(c.context,work);expect(work).toHaveBeenCalledOnce();expect(result.structuredContent).toEqual({value:42});
    const payload=c.deliveries[0]!;expect(payload.capture_revision).toBe(1);const events=payload.events as Record<string,unknown>[];
    expect(events.map(e=>normalizeEvent(e).kind)).toEqual(['tool-started','tool-completed']);
    expect(events[0]).toMatchObject({session_scope:'relay-day',session_id:'relay-day-2026-09-17',coverage:'server-observation',observed_at:time});
    expect(events[1]).toMatchObject({status:'unknown',observed_at:'2026-09-17T00:01:01.000Z'});
    expect(JSON.stringify(payload)).not.toMatch(/private output|input_tokens|tool_input|credentials|model/);
  });
  it('does nothing without authenticated context, without installed modules, or when opted out',async()=>{
    const c=observerContext({server_enabled:false,revision:0});const observers=new RequestObservers([createRelayObserver()]);
    expect(await observers.run(undefined,async()=>9)).toBe(9);expect(c.follow).not.toHaveBeenCalled();
    expect(await new RequestObservers().run(c.context,async()=>8)).toBe(8);expect(c.follow).not.toHaveBeenCalled();
    expect(await observers.run(c.context,async()=>7)).toBe(7);expect(c.deliveries).toHaveLength(0);
  });
  it('never observes telemetry traffic and immediately invalidates cached opt-out after settings actions',async()=>{
    const policy={server_enabled:false,revision:0};const c=observerContext(policy);const observers=new RequestObservers([createRelayObserver()]);
    await observers.run(c.context,async()=>1);policy.server_enabled=true;policy.revision=1;
    await observers.run({...c.context,tool:'act',selector:{reference:'https://foxxi-bridge.interego.xwisee.com/affordances',action:'https://relay.interego.xwisee.com/ns/iep/action/llm-telemetry/capture-update'}},async()=>2);
    expect(c.deliveries).toHaveLength(0);await observers.run(c.context,async()=>3);expect(c.deliveries).toHaveLength(1);
  });
  it('keeps work available when consent lookup or delivery fails, without retaining result contents',async()=>{
    const c=observerContext({server_enabled:true,revision:1});c.follow.mockRejectedValueOnce(new Error('private network detail'));
    const observers=new RequestObservers([createRelayObserver()]);let result=await observers.run(c.context,async()=>({structuredContent:{ok:true}}));
    expect(result.structuredContent).toEqual({ok:true});expect(JSON.stringify(result)).toContain('unavailable');expect(JSON.stringify(result)).not.toContain('private network detail');
    c.follow.mockImplementationOnce(async()=>JSON.stringify({status:200,body:JSON.stringify({preferences:{server_enabled:true,revision:1}})})).mockRejectedValueOnce(new Error('private failure'));
    result=await observers.run(c.context,async()=>({structuredContent:{ok:true}}));expect(JSON.stringify(result)).toContain('unconfirmed');expect(result.structuredContent).toEqual({ok:true});
  });
  it('records failures while preserving the original thrown error, including undefined',async()=>{
    const c=observerContext({server_enabled:true,revision:1});const observers=new RequestObservers([createRelayObserver()]);
    const error=new Error('private failure');await expect(observers.run(c.context,async()=>{throw error;})).rejects.toBe(error);
    expect((c.deliveries[0]!.events as Record<string,unknown>[])[1]).toMatchObject({kind:'tool-failed',status:'error'});
    await expect(observers.run(c.context,async()=>{throw undefined;})).rejects.toBeUndefined();
  });
  it('bounds stuck observers and rejects remote observer installation',async()=>{
    const c=observerContext({server_enabled:true,revision:1});const observers=new RequestObservers([{id:'stuck',begin:()=>new Promise(()=>{})}],5);
    expect(await observers.run(c.context,async()=>({value:4}))).toMatchObject({value:4});
    await expect(loadRequestObservers('["https://example.org/observer.js"]')).rejects.toThrow('local');
  });
  it('reports overlapping sources as observations and keeps relay-day groups distinct from chats',()=>{
    const server=eventStatement(actor,normalizeEvent({...event('server-observation'),source:'interego-relay',session_scope:'relay-day',session_id:'relay-day-2026-09-17'}),time);
    const client=eventStatement(actor,normalizeEvent({...event(),source_event_id:'client-one'}),time);
    const snapshot=mergeTelemetrySnapshot(actor,[server,client],[server,client]);
    const report=telemetryReport(actor,snapshot,{},time);expect(report.coverage.capture_channels).toEqual({server:1,client:1});expect(report.insights.some(i=>i.kind==='overlapping-observers')).toBe(true);
    const query=normalizeQuery({capture_channel:'server'});expect(telemetryReport(actor,snapshot,query,time).statements.map(s=>s.id)).toEqual([server.id]);expect(telemetryMetadata(server)?.session_scope).toBe('relay-day');
  });
});
