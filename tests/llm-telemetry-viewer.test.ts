import { expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { HMD_APP_HTML } from '../deploy/mcp-relay/hmd-app.js';
import { telemetryView, captureView } from '../applications/llm-telemetry/view.js';

it('executes the real telemetry control with bound signing and keeps optional filters collapsed', async () => {
  const calls: Array<{ name: string; args: unknown }> = [];
  const view = telemetryView('https://example.org');
  const dom = new JSDOM(HMD_APP_HTML, { runScripts: 'dangerously', beforeParse(window) {
    Object.defineProperty(window, 'openai', { value: { toolOutput: view, callTool: async (name: string, args: unknown) => {
      calls.push({ name, args }); return { structuredContent: { status: 200, body: JSON.stringify({ view: { ...view, title: 'Observed sessions' } }) } };
    } } });
  } });
  try {
    const document = dom.window.document;
    await vi.waitFor(() => expect(document.getElementById('title')?.textContent).toBe('LLM activity'));
    const options = [...document.querySelectorAll('details')].find(e => e.querySelector('summary')?.textContent === 'Filters and options');
    expect(options?.open).toBe(false);
    const button = [...document.querySelectorAll('button')].find(b => b.textContent?.includes('My sessions'))!;
    button.click(); expect(calls).toHaveLength(0);
    const confirm = [...document.querySelectorAll('button')].find(b => b.textContent === 'Confirm & submit')!;
    confirm.click();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({ name: 'act', args: { descriptor_url: 'https://example.org/affordances', sign_payload: true, payload: { view: 'sessions' } } });
    await vi.waitFor(() => expect(document.getElementById('title')?.textContent).toBe('Observed sessions'));
  } finally { dom.window.close(); }
});

it('submits the opt-out control as boolean false with its displayed revision', async () => {
  const calls: Array<{name:string;args:unknown}>=[];
  const view=captureView('https://example.org',{observer:'did:web:observer',revision:4,server_enabled:true,client_enabled:true,updated_at:'2026-09-17T00:00:00Z'});
  const dom=new JSDOM(HMD_APP_HTML,{runScripts:'dangerously',beforeParse(window){
    Object.defineProperty(window,'openai',{value:{toolOutput:view,callTool:async(name:string,args:unknown)=>{
      calls.push({name,args});return{structuredContent:{status:200,body:JSON.stringify({view})}};
    }}});
  }});
  try {
    const document=dom.window.document;
    await vi.waitFor(()=>expect(document.getElementById('title')?.textContent).toBe('Capture settings'));
    [...document.querySelectorAll('button')].find(b=>b.textContent?.includes('Disable Interego recording'))!.click();
    [...document.querySelectorAll('button')].find(b=>b.textContent==='Confirm & submit')!.click();
    await vi.waitFor(()=>expect(calls).toHaveLength(1));
    expect(calls[0]).toMatchObject({name:'act',args:{sign_payload:true,payload:{server_enabled:false,expected_revision:4}}});
  } finally {dom.window.close();}
});
