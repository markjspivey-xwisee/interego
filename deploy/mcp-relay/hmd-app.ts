/**
 * hmd-app — the GENERIC HyperMarkdown MCP-App renderer, served by the relay as a
 * `text/html;profile=mcp-app` resource (`ui://widget/hmd.html`). ONE reusable,
 * memory-free viewer: the `render_hmd` tool supplies a parsed HMD document as
 * structuredContent, this renders it (Enhanced / Markdown / HMD-source tabs), and
 * builds a form from each control's inline SHACL fields. Read-only actions fire a
 * direct `invoke_affordance` tools/call; mutating actions require explicit in-app
 * confirmation first (and the relay re-resolves the signed descriptor on execute).
 *
 * HMD stays Markdown+YAML-LD — this is only its interactive viewer, not a new
 * format. Content is UNTRUSTED (note authors control labels/links), so untrusted
 * strings go in via textContent/attributes, never innerHTML; only the sanitized
 * safeMarkdown() output (see hmd-app-logic) is assigned as HTML.
 */
import { HMD_APP_LOGIC_JS } from './hmd-app-logic.js';

const STYLE = String.raw`
:root{--bg:#fff;--fg:#16181d;--muted:#5b616e;--line:#e4e7ec;--card:#f7f8fa;--accent:#3538cd;--accent-fg:#fff;--ok:#067647;--warn:#b42318;--chip:#eef0f4;font-synthesis:none}
@media (prefers-color-scheme:dark){:root{--bg:#131519;--fg:#e7e9ee;--muted:#98a0ae;--line:#282c34;--card:#1b1e24;--accent:#8da2fb;--accent-fg:#0b0d10;--ok:#75e0a7;--warn:#fda29b;--chip:#20242c}}
:root[data-theme=dark]{--bg:#131519;--fg:#e7e9ee;--muted:#98a0ae;--line:#282c34;--card:#1b1e24;--accent:#8da2fb;--accent-fg:#0b0d10;--ok:#75e0a7;--warn:#fda29b;--chip:#20242c}
:root[data-theme=light]{--bg:#fff;--fg:#16181d;--muted:#5b616e;--line:#e4e7ec;--card:#f7f8fa;--accent:#3538cd;--accent-fg:#fff;--ok:#067647;--warn:#b42318;--chip:#eef0f4}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:760px;margin:0 auto;padding:18px 20px 28px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 12px;margin-bottom:4px}
h1.title{font-size:20px;font-weight:650;margin:0;letter-spacing:-.01em;text-wrap:balance}
.prov{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;background:var(--chip);color:var(--muted);display:inline-flex;gap:5px;align-items:center}
.prov.verified{color:var(--ok)}
.prov .dot{width:6px;height:6px;border-radius:50%;background:currentColor}
.tabs{display:flex;gap:2px;margin:14px 0 16px;border-bottom:1px solid var(--line)}
.tab{appearance:none;background:none;border:0;border-bottom:2px solid transparent;color:var(--muted);font:inherit;font-weight:600;font-size:13px;padding:8px 12px;cursor:pointer;margin-bottom:-1px}
.tab[aria-selected=true]{color:var(--fg);border-bottom-color:var(--accent)}
.tab:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:6px}
.pane{display:none}.pane.on{display:block}
.prose h1,.prose h2,.prose h3{letter-spacing:-.01em;margin:1.1em 0 .4em;line-height:1.3}
.prose h1{font-size:19px}.prose h2{font-size:17px}.prose h3{font-size:15px}
.prose p{margin:.55em 0}.prose ul,.prose ol{margin:.55em 0;padding-left:1.4em}
.prose code{background:var(--chip);padding:.1em .35em;border-radius:5px;font:.9em ui-monospace,SFMono-Regular,Menlo,monospace}
.prose blockquote{margin:.6em 0;padding:.2em .9em;border-left:3px solid var(--line);color:var(--muted)}
.prose a{color:var(--accent);text-underline-offset:2px}
pre.src{white-space:pre-wrap;word-break:break-word;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;margin:0}
.control{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:14px 15px;margin:14px 0}
.control h3{margin:0 0 2px;font-size:14.5px;font-weight:650;display:flex;align-items:center;gap:8px}
.badge{font-size:10.5px;font-weight:700;letter-spacing:.03em;text-transform:uppercase;padding:2px 7px;border-radius:6px;background:var(--chip);color:var(--muted)}
.badge.mutate{color:var(--warn)}
.badge.declarative{background:transparent;border:1px solid var(--line);color:var(--muted)}
.field input:disabled,.field textarea:disabled,.field select:disabled{opacity:.7;cursor:not-allowed}
.control .when{color:var(--muted);font-size:12.5px;margin:0 0 10px}
.field{margin:10px 0}
.field label{display:block;font-size:12.5px;font-weight:600;margin-bottom:4px}
.field .req{color:var(--warn)}
.field .desc{color:var(--muted);font-weight:400;font-size:12px;margin-left:6px}
.field input,.field textarea,.field select{width:100%;font:inherit;font-size:14px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:8px 10px}
.field textarea{min-height:76px;resize:vertical}
.field input:focus,.field textarea:focus,.field select:focus{outline:2px solid var(--accent);outline-offset:1px;border-color:var(--accent)}
.field .err{color:var(--warn);font-size:12px;margin-top:4px;display:none}
.field.invalid .err{display:block}
.field.invalid input,.field.invalid textarea{border-color:var(--warn)}
.actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}
button.go{appearance:none;font:inherit;font-weight:650;font-size:13.5px;padding:8px 16px;border-radius:9px;border:1px solid transparent;background:var(--accent);color:var(--accent-fg);cursor:pointer}
button.go.secondary{background:transparent;color:var(--fg);border-color:var(--line)}
button.go:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button.go:disabled{opacity:.55;cursor:default}
.status{font-size:12.5px;margin-top:10px}
.status.ok{color:var(--ok)}.status.err{color:var(--warn)}.status.muted{color:var(--muted)}
.confirm{border:1px dashed var(--warn);border-radius:9px;padding:10px 12px;margin-top:10px;font-size:12.5px}
.links{display:none;margin-top:20px;padding-top:14px;border-top:1px solid var(--line);font-size:12.5px}
.links a{color:var(--accent);margin-right:14px}
.empty{color:var(--muted);font-size:13px}
`;

const BOOT_JS = String.raw`
var DATA = null;
function q(id){return document.getElementById(id)}
// ── read the tool output (ChatGPT compat first, then MCP Apps bridge) ──
function readToolOutput(){ try{ if(window.openai&&window.openai.toolOutput) return window.openai.toolOutput; }catch(e){} return null; }
function hydrate(d){ if(shouldRehydrate(DATA,d)){ DATA=d; render(); } }
// ChatGPT sets the tool output ASYNCHRONOUSLY (the iframe can mount before the
// approval-gated structuredContent arrives) and signals it via the
// openai:set_globals CustomEvent. But that event ALSO fires for theme / displayMode
// / focus / etc. with NO toolOutput — so re-render ONLY when THIS event actually
// delivers a toolOutput (matching the documented useOpenAiGlobal guard). Do NOT
// fall back to the existing output here: that would rebuild the DOM on every theme
// event and wipe the user's in-progress form input / confirm box / status.
window.addEventListener('openai:set_globals',function(ev){
  var g=(ev&&ev.detail&&ev.detail.globals)||{};
  if(g.toolOutput===undefined) return;
  hydrate(g.toolOutput);
},{passive:true});
window.addEventListener('message',function(ev){
  if(ev.source!==window.parent) return;
  var m=ev.data; if(!m||typeof m!=='object') return;
  // MCP Apps standard delivery (fallback path to the ChatGPT event above).
  if(m.method==='ui/notifications/tool-result'){ hydrate((m.params&&m.params.structuredContent)||null); }
  else if(m.id!=null && PENDING[m.id]){ var p=PENDING[m.id]; delete PENDING[m.id]; if(m.error) p.reject(new Error(m.error.message||'tool error')); else p.resolve(m.result); }
});
// ── invoke a tool: prefer window.openai.callTool, else JSON-RPC postMessage ──
var RPC=1, PENDING={};
function callTool(name,args){
  try{ if(window.openai&&typeof window.openai.callTool==='function'){ var r=window.openai.callTool(name,args); return Promise.resolve(r); } }catch(e){}
  return new Promise(function(resolve,reject){
    var id='hmd-'+(RPC++); PENDING[id]={resolve:resolve,reject:reject};
    try{ window.parent.postMessage({jsonrpc:'2.0',id:id,method:'tools/call',params:{name:name,arguments:args}},'*'); }
    catch(e){ delete PENDING[id]; reject(e); }
    setTimeout(function(){ if(PENDING[id]){ delete PENDING[id]; reject(new Error('timed out waiting for '+name)); } },60000);
  });
}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e;}
function selectTab(name){
  ['enhanced','markdown','source'].forEach(function(t){
    q('tab-'+t).setAttribute('aria-selected',String(t===name));
    q('pane-'+t).classList.toggle('on',t===name);
  });
}
function render(){
  var d=DATA||{};
  q('title').textContent=d.title||'HyperMarkdown';
  var prov=q('prov'); var a=d.authorship||{};
  if(a.authorshipVerified){ prov.className='prov verified'; prov.innerHTML=''; prov.appendChild(el('span','dot')); prov.appendChild(document.createTextNode('Authorship verified'+(a.effectiveTrustLevel?' · '+a.effectiveTrustLevel:''))); }
  else { prov.className='prov'; prov.innerHTML=''; prov.appendChild(el('span','dot')); prov.appendChild(document.createTextNode(a.reason?'Unverified':'Self-asserted')); }
  // Enhanced: prose + controls
  var enh=q('pane-enhanced'); enh.innerHTML='';
  var prose=el('div','prose'); prose.innerHTML=safeMarkdown(d.body||''); enh.appendChild(prose);
  var controls=(d.controls||[]);
  if(!controls.length){ enh.appendChild(el('p','empty','This document publishes no controls.')); }
  controls.forEach(function(c){ enh.appendChild(renderControl(c,d)); });
  // Markdown + source
  q('pane-markdown').innerHTML=''; q('pane-markdown').appendChild(mkpre(d.body||'(no body)'));
  q('pane-source').innerHTML=''; q('pane-source').appendChild(mkpre(d.hmd||'(no source)'));
  // links
  var lw=q('links'); lw.innerHTML='';
  (d.links||[]).forEach(function(l){ var A=el('a',null,l.label||l.href); A.href=sanitizeHref(l.href||'#'); A.target='_blank'; A.rel='noopener noreferrer'; lw.appendChild(A); });
  lw.style.display=(d.links&&d.links.length)?'block':'none';
}
function mkpre(t){var p=el('pre','src');p.textContent=t;return p;}
function renderControl(c,d){
  var card=el('div','control');
  // A control is EXECUTABLE only if the server resolved a real target for it
  // (descriptor or signed graph). A DECLARATIVE control (authority-closed, no
  // target) describes an interaction shape but has no execution endpoint — show it
  // read-only instead of firing a doomed submit. The read/mutate split applies only
  // to executable controls (and keys on method, never the author-controlled name).
  var executable=(c&&c.executable===true);
  var kind=executable?classifyAction(c.action,c.method):'declarative';
  var h=el('h3'); h.appendChild(document.createTextNode(prettyAction(c.action)));
  var b=el('span','badge'+(kind==='mutate'?' mutate':'')+(kind==='declarative'?' declarative':'')); b.textContent=(kind==='declarative'?'declarative':(kind==='mutate'?'writes':'reads')); h.appendChild(b);
  card.appendChild(h);
  if(c.whenToUse){ card.appendChild(el('p','when',c.whenToUse)); }
  var fields=(c.fields||[]);
  var inputs={};
  fields.forEach(function(f){
    var key=localName(f.path);
    var fw=el('div','field'); var lab=el('label'); lab.textContent=(f.name||key);
    if(isRequired(f)){ var r=el('span','req',' *'); lab.appendChild(r); }
    if(f.description){ var ds=el('span','desc',f.description); lab.appendChild(ds); }
    fw.appendChild(lab);
    var m=inputModel(f), inp;
    if(m.kind==='textarea'){ inp=el('textarea'); }
    else if(m.kind==='boolean'){ inp=el('select'); [['','—'],['true','true'],['false','false']].forEach(function(o){var op=el('option',null,o[1]);op.value=o[0];inp.appendChild(op);}); }
    else { inp=el('input'); inp.type=(m.kind==='number'?'number':m.kind==='date'?'date':m.kind==='datetime-local'?'datetime-local':'text'); }
    if(f.maxLength && Number(f.maxLength)>0 && (inp.tagName==='INPUT'||inp.tagName==='TEXTAREA')) inp.maxLength=Number(f.maxLength);
    if(!executable){ inp.disabled=true; }
    inp.setAttribute('data-key',key);
    var err=el('div','err');
    fw.appendChild(inp); fw.appendChild(err);
    card.appendChild(fw); inputs[key]={field:f,input:inp,wrap:fw,err:err};
  });
  if(!executable){
    // Declarative: informational only — no submit, no invoke_affordance.
    card.appendChild(el('p','when','Declarative — describes an interaction (its input shape above) but declares no execution endpoint on this note, so it can’t be submitted from here.'));
    return card;
  }
  var actions=el('div','actions');
  var btn=el('button','go'+(kind==='mutate'?' secondary':'')); btn.textContent=(kind==='mutate'?'Review & '+prettyAction(c.action):prettyAction(c.action));
  var status=el('div','status muted');
  var confirmBox=el('div','confirm'); confirmBox.style.display='none';
  actions.appendChild(btn); card.appendChild(actions); card.appendChild(confirmBox); card.appendChild(status);

  function validateAll(){
    var ok=true, values={};
    fields.forEach(function(f){ var key=localName(f.path); var io=inputs[key]; var v=io.input.value; values[key]=v;
      var e=validateValue(f,v); io.wrap.classList.toggle('invalid',!!e); io.err.textContent=e||''; if(e) ok=false; });
    return ok?{values:values}:null;
  }
  function doExecute(payload){
    btn.disabled=true; status.className='status muted'; status.textContent='Submitting…';
    callTool('invoke_affordance',{descriptor_url:d.descriptorUrl,action_iri:c.action,payload:payload}).then(function(res){
      status.className='status ok'; status.textContent='Done.';
    }).catch(function(e){ status.className='status err'; status.textContent='Failed: '+(e&&e.message?e.message:'error'); }).then(function(){ btn.disabled=false; });
  }
  btn.addEventListener('click',function(){
    confirmBox.style.display='none';
    var r=validateAll(); if(!r){ status.className='status err'; status.textContent='Please fix the highlighted fields.'; return; }
    var payload=collectPayload(fields,r.values);
    if(kind==='read'){ doExecute(payload); return; }
    // mutation → explicit confirmation before any tools/call. Show the EXACT
    // payload (textContent, so untrusted values stay inert) so consent is
    // informed: what you confirm is exactly what is submitted.
    confirmBox.innerHTML=''; confirmBox.style.display='block';
    confirmBox.appendChild(el('div',null,'This will submit a signed “'+prettyAction(c.action)+'” action. It sends:'));
    var pv=el('pre','src'); pv.style.margin='8px 0'; pv.style.maxHeight='none'; pv.textContent=JSON.stringify(payload,null,2); confirmBox.appendChild(pv);
    var row=el('div','actions');
    var yes=el('button','go'); yes.textContent='Confirm & submit';
    var no=el('button','go secondary'); no.textContent='Cancel';
    // Disable BOTH confirm buttons synchronously so a double-activation (mouse or
    // keyboard) can never fire the mutating tools/call twice.
    yes.addEventListener('click',function(){ yes.disabled=true; no.disabled=true; confirmBox.style.display='none'; doExecute(payload); });
    no.addEventListener('click',function(){ confirmBox.style.display='none'; status.className='status muted'; status.textContent='Cancelled.'; });
    row.appendChild(yes); row.appendChild(no); confirmBox.appendChild(row);
  });
  return card;
}
function prettyAction(iri){ var n=localName(iri).replace(/[-_]/g,' ').replace(/([a-z])([A-Z])/g,'$1 $2'); return n.charAt(0).toUpperCase()+n.slice(1); }
// boot — wire tabs via addEventListener (NO inline onclick, so the widget runs
// under a strict/nonce Content-Security-Policy) then render any initial output.
(function(){
  ['enhanced','markdown','source'].forEach(function(t){ var b=q('tab-'+t); if(b) b.addEventListener('click',function(){ selectTab(t); }); });
  // Render an empty state immediately (so the frame is never blank), then hydrate
  // if the output was already delivered synchronously; openai:set_globals /
  // tool-result hydrate later. hydrate() is guarded (only re-renders on a new HMD
  // document), so these paths never wipe in-progress UI state.
  DATA=null; render(); hydrate(readToolOutput());
})();
`;

/** The complete self-contained widget document served at `ui://widget/hmd.html`. */
export const HMD_APP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>HyperMarkdown viewer</title><style>${STYLE}</style></head><body><div class="wrap"><header><h1 class="title" id="title">HyperMarkdown</h1><span class="prov" id="prov"></span></header><div class="tabs" role="tablist"><button class="tab" id="tab-enhanced" role="tab" aria-selected="true">Enhanced</button><button class="tab" id="tab-markdown" role="tab" aria-selected="false">Markdown</button><button class="tab" id="tab-source" role="tab" aria-selected="false">HMD source</button></div><div class="pane on" id="pane-enhanced"></div><div class="pane" id="pane-markdown"></div><div class="pane" id="pane-source"></div><div class="links" id="links"></div></div><script>${HMD_APP_LOGIC_JS}\n${BOOT_JS}</script></body></html>`;
