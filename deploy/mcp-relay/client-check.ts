/**
 * An HTTPS diagnostic host for the same MCP App. It holds no account credentials
 * and makes no network requests. An operator forwards its visible tool requests
 * through their MCP connection and pastes the real responses. This lets a browser
 * exercise client key custody even when its surrounding host cannot be automated.
 */
import { createHash } from 'node:crypto';
import { HMD_APP_HTML } from './hmd-app.js';

const PANEL = `<details class="control" open><summary>MCP client verification transport</summary>
<p>Load a real render_hmd tool result. Forward each request below through your Interego MCP connection, then paste its response. This page has no connector token and cannot execute requests by itself. Private keys remain in this browser.</p>
<div class="field"><label for="client-tool-result">Viewer tool result</label><textarea id="client-tool-result"></textarea></div>
<button class="go" id="client-load">Load viewer result</button>
<pre class="src" id="client-outgoing" aria-label="Outgoing MCP request">No pending request</pre>
<div class="field"><label for="client-response">MCP response</label><textarea id="client-response"></textarea></div>
<button class="go" id="client-deliver">Deliver MCP response</button>
<p role="status" id="client-transport-status"></p></details>`;

const HOST = String.raw`
(function(){
  var pending=null, sequence=0;
  var byId=function(id){return document.getElementById(id);};
  var status=function(text){byId('client-transport-status').textContent=text;};
  window.openai={toolOutput:null,callTool:function(name,args){
    if(pending)return Promise.reject(new Error('A request is still awaiting its MCP response.'));
    return new Promise(function(resolve,reject){
      pending={id:++sequence,resolve:resolve,reject:reject};
      byId('client-outgoing').textContent=JSON.stringify({id:pending.id,name:name,arguments:args},null,2);
      status('Awaiting the actual MCP response.');
    });
  }};
  byId('client-load').addEventListener('click',function(){try{
    if(pending)throw new Error('Deliver the pending response before changing the viewer.');
    var data=JSON.parse(byId('client-tool-result').value);
    data=data.structuredContent||data;
    if(!data.descriptorUrl||!data.clientEncryption||!data.hmd)throw new Error('Load a render_hmd result with its client context.');
    window.openai.toolOutput=data;
    window.dispatchEvent(new CustomEvent('openai:set_globals',{detail:{globals:{toolOutput:data}}}));
    status('Viewer loaded. No key or credential was imported.');
  }catch(e){status(e.message);}});
  byId('client-deliver').addEventListener('click',function(){try{
    if(!pending)throw new Error('There is no pending request.');
    var data=JSON.parse(byId('client-response').value);
    if(data.id!==pending.id||!data.result)throw new Error('Expected {id:'+pending.id+', result:<actual MCP response>}.');
    var done=pending;pending=null;
    byId('client-response').value='';byId('client-outgoing').textContent='No pending request';
    done.resolve(data.result);status('MCP response delivered to this browser.');
  }catch(e){status(e.message);}});
})();
`;

export const CLIENT_CHECK_HTML = HMD_APP_HTML
  .replace('<title>HyperMarkdown viewer</title>', '<title>Interego client encryption verification</title>')
  .replace('<div class="wrap">', '<div class="wrap">' + PANEL)
  .replace('<script>', '<script>' + HOST);

const scriptHashes = [...CLIENT_CHECK_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map(match => `'sha256-${createHash('sha256').update(match[1]!).digest('base64')}'`);
export const CLIENT_CHECK_CSP = `default-src 'none'; script-src ${scriptHashes.join(' ')}; style-src 'unsafe-inline'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
