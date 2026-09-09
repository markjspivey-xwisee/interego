/** Generic client-interaction UI. Private signing happens only at the holder's origin. */
export const HMD_INTERACTION_JS = String.raw`
var INTERACTION_NOTIFIED=Object.create(null);
function interactionValue(value){
  if(value&&value.structuredContent) value=value.structuredContent;
  if(value&&typeof value.status==='number'&&typeof value.body==='string'){
    if(value.status>=400) throw new Error(value.statusText||'Request refused');
    value=JSON.parse(value.body);
  }
  if(value&&value.interaction)value=value.interaction;
  return value;
}
function validInteraction(value){
  return value&&value.schema==='interego.client-interaction/v1'&&typeof value.id==='string'
    && /^[a-zA-Z0-9_-]{43}$/.test(value.id)
    && ['pending','reviewing','submitting','completed','cancelled','expired','failed'].indexOf(value.status)!==-1
    && value.descriptorUrl==='urn:interego:client-interaction:v1:'+value.id;
}
function viewerOutput(value){
  var v;
  try{v=interactionValue(value);}catch(e){v={error:e.message};}
  if(isHmdDoc(v)) return v;
  if(v&&isHmdDoc(v.view)) return v.view;
  if(validInteraction(v)){
    if(DATA&&DATA.descriptorUrl===v.descriptorUrl&&DATA.interaction&&DATA.interaction.expiresAt===v.expiresAt) return null;
    return {descriptorUrl:v.descriptorUrl,title:'Signing request',body:'',hmd:JSON.stringify(v,null,2),controls:[],interaction:v};
  }
  if(DATA||v==null) return null;
  // Nested action results must never erase an existing document or its form.
  return {descriptorUrl:'urn:interego:tool-result',title:'Action result',body:'',hmd:'',controls:[],toolResult:v};
}
function renderInteraction(initial){
  var card=el('section','control'), state=el('p','status muted','Checking signing request…');
  state.setAttribute('role','status');state.setAttribute('aria-live','polite');
  var detail=el('p','when','This action requires a signature from a registered key.');
  var origin=el('p','when'), row=el('div','actions');
  var sign=el('button','go','Review and sign'), refresh=el('button','go secondary','Check result'), cancel=el('button','go secondary','Cancel request');
  var output=el('pre','src');output.hidden=true;
  sign.disabled=true;cancel.disabled=true;
  row.appendChild(sign);row.appendChild(refresh);row.appendChild(cancel);
  card.appendChild(detail);card.appendChild(origin);card.appendChild(row);card.appendChild(state);card.appendChild(output);
  if(!validInteraction(initial)){state.textContent='Invalid signing request.';refresh.disabled=true;return card;}
  var reference=initial.descriptorUrl, id=initial.id, current=null, timer=null, busy=false;
  function active(v){return ['pending','reviewing','submitting'].indexOf(v.status)!==-1;}
  function control(action){return (action==='urn:interego:client-interaction:status'
    ?callTool('render_hmd',{descriptor_url:reference})
    :callTool('invoke_affordance',{descriptor_url:reference,action_iri:action,payload:{}})).then(function(result){
    if(result&&result.isError) throw new Error('Signing request access was refused.');
    var v=interactionValue(result);
    if(!validInteraction(v)||v.id!==id) throw new Error('Signing result does not match this request.');
    return v;
  });}
  function signingLink(v){
    var u=new URL(v.signingUrl);
    if(u.protocol!=='https:'||u.username||u.password||u.hash||u.pathname!=='/sign-action'
      ||u.search!=='?request='+id) throw new Error('Invalid signing destination.');
    return u;
  }
  function inform(v){
    var notificationKey=id+':'+v.expiresAt+':'+v.status;
    if(INTERACTION_NOTIFIED[notificationKey])return;
    INTERACTION_NOTIFIED[notificationKey]=true;
    var text=JSON.stringify({kind:'interego-signing-result',requestId:id,descriptorUrl:reference,status:v.status,result:v.result||null});
    // Host continuation is a request, not an approval assertion. The visible
    // result remains available if the host declines to resume the conversation.
    if(BRIDGE_READY){
      rpcRequest('ui/update-model-context',{content:[{type:'text',text:text}]}).catch(function(){});
      rpcRequest('ui/message',{role:'user',content:[{type:'text',text:'Verify this server signing result through its authenticated status control: '+text}]}).catch(function(){
        if(card.isConnected)state.textContent+=' The host did not resume the conversation; the result is displayed here.';
      });
    }else if(window.openai&&typeof window.openai.sendFollowUpMessage==='function'){
      Promise.resolve().then(function(){return window.openai.sendFollowUpMessage({prompt:'Verify this server signing result through its authenticated status control: '+text});}).catch(function(){});
    }
  }
  function show(v){
    current=v;var pending=active(v),done=v.status==='completed'&&v.result&&v.result.committed===true;
    detail.textContent='Authenticated agent: '+(v.actor||'current session')+'. This action requires a registered-key signature.';
    sign.disabled=!pending||v.status==='submitting';cancel.disabled=!pending||v.status==='submitting';
    state.className='status '+(done?'ok':v.status==='failed'?'err':'muted');
    state.textContent=done?'Signed, verified and submitted.':v.status==='completed'?'Signing finished. Inspect the result below.':v.status==='pending'||v.status==='reviewing'?'Waiting for your signature. The result will appear here automatically.':v.status==='submitting'?'Verifying and submitting…':'Request '+v.status+'.';
    if(pending){var u=signingLink(v);origin.textContent='Signing at '+u.origin;}
    else{origin.textContent='';output.hidden=false;output.textContent=JSON.stringify(v.result||{status:v.status},null,2);inform(v);}
    if(v.blocker)state.textContent+=' '+v.blocker;
    reportSize();
  }
  function check(){
    if(!card.isConnected||busy)return;
    clearTimeout(timer);busy=true;refresh.disabled=true;
    control('urn:interego:client-interaction:status').then(function(v){if(card.isConnected)show(v);}).catch(function(e){
      current=null;sign.disabled=true;cancel.disabled=true;state.className='status err';state.textContent='Unable to check signing: '+e.message;reportSize();
    }).finally(function(){
      busy=false;refresh.disabled=false;
      if(card.isConnected&&current&&active(current))timer=setTimeout(check,5000);
    });
  }
  refresh.addEventListener('click',check);
  sign.addEventListener('click',function(){
    if(!current||sign.disabled)return;
    var url;try{url=signingLink(current).href;}catch(e){state.textContent=e.message;return;}
    // No prefetch, credential forwarding or popup on mount: only a holder click.
    var opened=BRIDGE_READY?rpcRequest('ui/open-link',{url:url}):window.openai&&typeof window.openai.openExternal==='function'
      ?Promise.resolve().then(function(){return window.openai.openExternal({href:url});}):Promise.reject(new Error('This host cannot open the signing interface.'));
    opened.then(function(r){if(r&&r.isError)throw new Error('The host refused to open the signing interface.');check();}).catch(function(e){state.textContent=e.message;reportSize();});
  });
  cancel.addEventListener('click',function(){
    if(cancel.disabled||busy)return;
    clearTimeout(timer);busy=true;cancel.disabled=true;sign.disabled=true;
    control('urn:interego:client-interaction:cancel').then(function(v){if(card.isConnected)show(v);}).catch(function(e){state.textContent='Could not cancel: '+e.message;}).finally(function(){busy=false;check();});
  });
  Promise.resolve().then(check); // Attach the panel and start the host handshake first.
  return card;
}
`;
