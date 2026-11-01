const $ = id => document.getElementById(id);
const sourceNames = { duke: 'Duke MyChart', apple: 'Apple Health', oura: 'Oura' };
let setup = null;
let status = null;
let busy = false;
let pairing = null;
const ATLAS_URL = 'https://mayya-health-atlas.goldenfleece.chatgpt.site/';
const ATLAS_LINK_KEY = 'interego.health.atlasLink';
let atlasLink = null;
let atlasDraft = null;
let atlasDraftSourceStamp = null;
let atlasAutoChoiceInitialized = false;

function captureAtlasLink() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('atlas-link');
  if (token !== null) {
    // Remove the one-time link credential before network activity or OAuth navigation.
    history.replaceState(null, '', location.pathname + location.search);
    try { sessionStorage.removeItem(ATLAS_LINK_KEY); } catch { /* storage may be unavailable */ }
    if (typeof token === 'string' && token.length >= 16 && token.length <= 2048 && !/[\s\u0000-\u001f\u007f]/u.test(token)) {
      atlasLink = { token, expiresAt: Date.now() + 15 * 60 * 1000 };
      try { sessionStorage.setItem(ATLAS_LINK_KEY, JSON.stringify(atlasLink)); } catch { /* held in memory only */ }
    }
  } else {
    try {
      const saved = JSON.parse(sessionStorage.getItem(ATLAS_LINK_KEY) || 'null');
      if (typeof saved?.token === 'string' && saved.token.length >= 16 && saved.token.length <= 2048 && saved.expiresAt > Date.now() && saved.expiresAt <= Date.now() + 15 * 60 * 1000) atlasLink = saved;
      else sessionStorage.removeItem(ATLAS_LINK_KEY);
    } catch { try { sessionStorage.removeItem(ATLAS_LINK_KEY); } catch { /* no storage */ } }
  }
}
captureAtlasLink();

function clearAtlasLink() {
  atlasLink = null;
  try { sessionStorage.removeItem(ATLAS_LINK_KEY); } catch { /* no storage */ }
}
function atlasSourceStamp() {
  return JSON.stringify({ owner: status?.owner?.principal, revision: status?.publication?.revision, count: status?.recordCount, sources: ['duke','apple'].map(name => sourceState(name).lastSync || null) });
}
function clearAtlasDraft() {
  atlasDraft = null;
  atlasDraftSourceStamp = null;
  $('atlas-projection-json').textContent = '';
  $('atlas-preview-panel').hidden = true;
}
function atlasHasPublishedRevision() {
  return Number.isInteger(status?.publication?.revision) && status.publication.revision > 0;
}
function renderPublication() {
  const p = status?.publication || {};
  const signed = isSignedIn();
  const allowed = signed && p.linked === true && p.ownerAllowed === true;
  if (atlasLink?.expiresAt <= Date.now()) clearAtlasLink();
  if (atlasDraft && (atlasDraftSourceStamp !== atlasSourceStamp() || (atlasDraft.expiresAt && Date.parse(atlasDraft.expiresAt) <= Date.now()))) clearAtlasDraft();
  const badge = $('atlas-badge');
  badge.className = 'status-badge';
  if (!signed) badge.textContent = 'Sign in to check';
  else if (!allowed) { badge.textContent = 'Account link required'; badge.classList.add('warning'); }
  else if (p.autoPublish) { badge.textContent = 'Automatic public updates enabled'; badge.classList.add('connected'); }
  else if (p.lastPublishedAt) badge.textContent = 'Public snapshot available';
  else badge.textContent = 'No public source snapshot yet';
  $('atlas-status').textContent = !signed
    ? (atlasLink ? 'A one-time Atlas link is ready in this browser. Sign in, then link the account that holds Mayya’s intended Duke chart.' : 'Sign in to manage the private-source updates shown in Mayya’s public Atlas.')
    : !allowed
      ? (atlasLink ? 'Link this signed-in account to the fixed public destination below. The source chart must match the configured Atlas subject.' : 'This account is not linked to Mayya’s Atlas. Open the administrator’s one-time account link to continue.')
      : p.pendingChanges ? 'Private Duke source changes are available. Prepare a preview to review the next public snapshot.'
      : p.lastPublishedAt ? 'The latest published source revision is shown below. Private imports and public release dates are different.'
      : 'This account is linked. A preview can be prepared after the intended Duke chart has been connected and imported.';
  $('atlas-claim').hidden = !atlasLink || allowed;
  $('atlas-claim').disabled = !signed || busy || !atlasLink;
  fieldList($('atlas-facts'), [
    ['Duke source last synced', signed ? dateText(status?.sources?.duke?.lastSync || p.sourceSyncAt) : 'Sign in to check'],
    ['Latest published clinical date', p.latestClinicalDate ? dateText(p.latestClinicalDate) : 'Not supplied'],
    ['Last public release', p.lastPublishedAt ? dateText(p.lastPublishedAt) : 'Not published'],
    ['Public revision', p.revision ? String(p.revision) : 'No source revision published'],
    ['Pending source changes', signed && allowed ? (p.pendingChanges ? 'Yes' : 'None reported') : 'Not checked']
  ]);
  $('atlas-preview').disabled = !allowed || busy;
  // The first release must use the reviewed draft and its local checkbox choice.
  $('atlas-automatic').disabled = !allowed || busy || !atlasHasPublishedRevision();
  $('atlas-automatic').textContent = p.autoPublish ? 'Pause automatic public updates' : 'Enable automatic public updates';
  if (!atlasAutoChoiceInitialized && atlasHasPublishedRevision() && allowed) {
    $('atlas-auto-choice').checked = p.autoPublish === true;
    atlasAutoChoiceInitialized = true;
  }
  $('atlas-publish').disabled = !allowed || busy || !atlasDraft;
}
function renderAtlasDraft(draft) {
  const projection = draft.projection;
  if (typeof draft.draftId !== 'string' || typeof draft.digest !== 'string' || !Object.hasOwn(draft,'baseRevision') || !projection || typeof projection !== 'object' || Array.isArray(projection)) throw new Error('The public preview could not be verified. Prepare it again.');
  atlasDraft = draft;
  atlasDraftSourceStamp = atlasSourceStamp();
  const stats = draft.stats || {};
  $('atlas-draft-date').textContent = 'Prepared ' + dateText(draft.createdAt);
  $('atlas-draft-summary').textContent = `${count(stats.projectedResources ?? stats.projectedEntries ?? 0)} structured source records contribute to this snapshot. The curated history is preserved; its narrative summaries are not rewritten by a sync.`;
  fieldList($('atlas-preview-facts'), [
    ['Current public revision', String(draft.baseRevision)],
    ['Preview expires', draft.expiresAt ? dateText(draft.expiresAt) : 'Not supplied'],
    ['Duke source sync', projection.meta?.publication?.sourceSyncAt ? dateText(projection.meta.publication.sourceSyncAt) : 'Not supplied'],
    ['Latest source clinical date', projection.meta?.publication?.latestClinicalDate ? dateText(projection.meta.publication.latestClinicalDate) : 'Not supplied']
  ]);
  const additions = $('atlas-additions'); additions.replaceChildren();
  const sections = stats.sections && typeof stats.sections === 'object' ? Object.entries(stats.sections) : Object.entries(projection).filter(([,value]) => Array.isArray(value)).map(([name,value]) => [name,value.length]);
  sections.filter(([,value]) => Number(value) > 0).forEach(([name,value]) => additions.append(element('li',`${String(name).replace(/([a-z])([A-Z])/g,'$1 $2')}: ${count(value)}`)));
  if (!additions.children.length) additions.append(element('li','No new structured entries were included. Review the complete snapshot below.'));
  const exclusions = $('atlas-exclusions'); exclusions.replaceChildren();
  const excluded = Array.isArray(draft.exclusions) ? draft.exclusions : Object.entries(draft.exclusions || {}).map(([reason,count]) => ({reason,count}));
  excluded.forEach(item => exclusions.append(element('li',`${String(item.reason || item.field || 'Excluded field').replaceAll('-',' ')}${item.count !== undefined ? ': '+count(item.count) : ''}`)));
  if (!excluded.length) exclusions.append(element('li','No additional source exclusions were reported. Raw narrative bodies and identifiers are outside the public field allow-list.'));
  const diff = $('atlas-diff'); diff.replaceChildren();
  const changes = Array.isArray(draft.diff) ? draft.diff : [];
  diff.hidden = changes.length === 0;
  if (changes.length) {
    diff.append(element('h4','Changes from the current public revision'));
    const list=element('ul');changes.forEach(change => list.append(element('li',`${change.operation || change.change || 'Change'} · ${change.section || 'Record'}${change.id ? ' · '+change.id : ''}`)));diff.append(list);
  }
  $('atlas-projection-json').textContent = JSON.stringify(projection,null,2);
  $('atlas-preview-panel').hidden = false;
  $('atlas-receipt').hidden = true;
  $('atlas-preview-panel').scrollIntoView({behavior:'smooth',block:'start'});
}

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}
function notify(message, error = false) {
  $('notice').textContent = message;
  $('notice').className = error ? 'notice error' : 'notice';
  $('notice').hidden = false;
}
function dateText(value) {
  if (!value) return 'No successful sync recorded';
  const d = new Date(value);
  return Number.isNaN(d.valueOf()) ? 'Date not available' : d.toLocaleString(undefined, {dateStyle:'medium', timeStyle:'short'});
}
function count(value) { return Number.isFinite(Number(value)) && value !== null ? Number(value).toLocaleString() : '—'; }
function fieldList(node, entries) {
  node.replaceChildren();
  entries.filter(([,value]) => value).forEach(([label,value]) => {
    const group = element('div');
    group.append(element('dt',label), element('dd',value));
    node.append(group);
  });
}
function isSignedIn() { return Boolean(status?.owner); }
function mayImport() { return isSignedIn() && status?.consent?.enabled === true && !busy; }
function sourceState(name) { return status?.sources?.[name] || {}; }
function isConnected(name) {
  const s = sourceState(name);
  return s.connected === true || ['connected','connected-session-only','ready'].includes(s.status);
}
function configured(name) { return setup?.[name]?.configured === true || sourceState(name).configured === true; }
function setBadge(name, text, kind = '') {
  const node = $(`${name}-badge`);
  node.textContent = text;
  node.className = `status-badge ${kind}`;
}
function renderCoverage(name) {
  const coverage = sourceState(name).coverage;
  const values = Array.isArray(coverage) ? coverage : [];
  const panel = $(`${name}-coverage`);
  panel.hidden = values.length === 0;
  const list = $(`${name}-coverage-list`);
  list.replaceChildren();
  values.forEach(item => {
    const row = element('p');
    const type = item.resourceType || item.metric || item.collection || item.type || 'Source';
    row.append(element('strong',type), document.createTextNode(` · ${item.status || 'Result recorded'}${Number.isFinite(item.count) ? ` · ${item.count} records` : ''}`));
    list.append(row);
  });
}
function render() {
  const signed = isSignedIn();
  $('sign-in').hidden = signed;
  $('signed-in').hidden = !signed;
  $('signed-in').textContent = signed ? 'Signed in to your private workspace' : '';
  $('consent-description').textContent = !signed
    ? 'Sign in to choose whether this workspace may import health information.'
    : status.consent?.enabled
      ? 'Private imports are enabled. You can pause new imports while retaining the source records already saved.'
      : 'Private imports are paused. Enable them before connecting a source or uploading new readings.';
  $('consent-button').textContent = status?.consent?.enabled ? 'Pause private imports' : 'Enable private imports';
  $('consent-button').disabled = !signed || busy;
  $('refresh-status').disabled = busy;
  $('record-source').disabled = !signed || busy;
  $('load-records').disabled = !signed || busy;
  $('record-total').textContent = signed ? `${count(status.recordCount ?? 0)} imported records in this workspace` : 'Sign in to view imported records.';

  ['duke','oura'].forEach(name => {
    const source = sourceState(name);
    const connected = isConnected(name);
    const ready = configured(name);
    const providerBlocked = name === 'oura' && (setup?.oura?.importEnabled === false || source.status === 'authorization_required');
    if (!setup) setBadge(name, 'Setup unavailable', 'warning');
    else if (providerBlocked) setBadge(name, 'Provider authorization needed', 'warning');
    else if (!ready) setBadge(name, 'App registration needed', 'warning');
    else if (!signed) setBadge(name, 'Sign in to connect');
    else if (connected) setBadge(name, source.status === 'connected-session-only' ? 'Connected for this session' : 'Connected', 'connected');
    else if (['reconnect-required','expired','revoked'].includes(source.status)) setBadge(name, 'Reconnect required', 'warning');
    else setBadge(name, 'Not connected');
    $(`${name}-last-sync`).textContent = signed ? dateText(source.lastSync) : 'Sign in to check';
    $(`${name}-count`).textContent = signed ? count(source.recordCount ?? 0) : '—';
    $(`${name}-connect`).disabled = !mayImport() || !ready || providerBlocked;
    $(`${name}-connect`).firstChild.textContent = connected ? 'Reconnect ' + (name === 'duke' ? 'MyChart ' : 'Oura ') : 'Connect ' + (name === 'duke' ? 'MyChart ' : 'Oura ');
    $(`${name}-sync`).disabled = !mayImport() || !connected || providerBlocked;
    $(`${name}-revoke`).disabled = !signed || !connected || busy;
    $(`${name}-registration`).hidden = !setup || (ready && !providerBlocked);
    fieldList($(`${name}-setup-fields`), [['Registered callback',setup?.[name]?.redirectUri],['Public signing keys',setup?.[name]?.jwksUri]]);
    $(`${name}-detail`).textContent = !setup
      ? 'Connection setup could not be verified. Refresh status to try again.'
      : providerBlocked
        ? 'Retained Oura imports and Interego agent access are disabled. An Oura account and OAuth approval alone do not authorize this use; additional provider authorization and a compliant connection design are required.'
        : !ready
        ? name === 'duke' ? 'The bridge is waiting for its Epic application registration. No Duke record access has been established.' : 'The bridge is waiting for its Oura application registration. No ring data access has been established.'
        : !signed ? 'Sign in to check this source and begin the account holder’s authorization.'
        : connected ? (name === 'duke' ? 'Authorization is recorded. Sync now to retrieve the information Duke makes available under the approved access.' : 'Authorization is recorded. Sync now to retrieve the data available under the wearer’s approved access.')
        : 'The account holder must complete the provider’s own sign-in and approval flow.';
    renderCoverage(name);
  });

  const apple = sourceState('apple');
  const uploaded = Boolean(apple.lastSync || apple.lastUpload || Number(apple.recordCount) > 0);
  const appleReady = setup?.apple?.supported === true;
  if (!setup) setBadge('apple','Setup unavailable','warning');
  else if (!appleReady) setBadge('apple','Upload endpoint unavailable','warning');
  else if (!signed) setBadge('apple','Sign in to pair');
  else if (uploaded) setBadge('apple','Upload received','connected');
  else if (apple.connected || pairing || ['paired','waiting-for-upload'].includes(apple.status)) setBadge('apple','Waiting for iPhone upload','warning');
  else setBadge('apple','Not connected');
  $('apple-last-sync').textContent = signed ? dateText(apple.lastUpload || apple.lastSync) : 'Sign in to check';
  $('apple-count').textContent = signed ? count(apple.recordCount ?? 0) : '—';
  $('apple-metrics').disabled = !mayImport() || !appleReady;
  $('apple-pair').disabled = !mayImport() || !appleReady;
  $('apple-revoke').disabled = !signed || busy || !(apple.connected || uploaded || pairing);
  if (!status?.consent?.enabled && pairing) clearPairing();
  renderPublication();
}

async function request(path, body) {
  const options = {credentials:'same-origin',cache:'no-store',headers:{Accept:'application/json'}};
  if (body !== undefined) {
    options.method = 'POST';
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-CSRF-Token'] = status?.csrfToken || '';
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path,options);
  if (response.status === 401) { status = null; render(); throw new Error('Sign in with Interego to continue.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (path === '/api/atlas/preview' && [502,504].includes(response.status)) {
      throw new Error('The public preview timed out or was interrupted. Retry the preview; your existing source records were kept. No public snapshot was released.');
    }
    const atlasCode = data.code || data.error;
    if (path.startsWith('/api/atlas/') && typeof atlasCode === 'string' && /^atlas_[a-z_]+$/.test(atlasCode) && typeof data.message === 'string' && data.message.length <= 400 && !/[\u0000-\u001f\u007f]/.test(data.message)) {
      if (response.status === 409) clearAtlasDraft();
      throw new Error(data.message);
    }
    if (data.code === 'authorization_required' || data.error === 'authorization_required' || data.status === 'authorization_required') {
      throw new Error('Retained Oura imports require provider authorization. An Oura account or OAuth approval alone does not enable this connection.');
    }
    const messages = {403:'The action was not authorized. Refresh your session and try again.',409:'The connection needs attention. Refresh status before trying again.',413:'The upload exceeded this endpoint’s size limit.',429:'Too many requests. Try again shortly.',503:'This connection is not ready. Check the application setup details.'};
    throw new Error(messages[response.status] || 'The request could not finish. Your existing source records were kept.');
  }
  return data;
}
async function refresh() {
  let setupError = false;
  try { setup = await request('/setup'); } catch { setupError = true; }
  try { status = await request('/api/status'); }
  catch (error) { if (status) notify(error.message,true); }
  render();
  if (setupError) notify('The setup status could not be loaded. Refresh status to try again.',true);
}
async function perform(task) {
  if (busy) return;
  busy = true; render();
  try { await task(); }
  catch (error) { notify(error.message || 'This action could not finish.',true); }
  finally { busy = false; render(); }
}
function providerRedirect(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('The provider authorization link was not available.'); }
  const hosts = new Set(['health-apis.duke.edu','cloud.ouraring.com','developer.ouraring.com']);
  if (url.protocol !== 'https:' || !hosts.has(url.hostname)) throw new Error('The provider authorization link could not be verified.');
  location.assign(url.href);
}
function clearPairing() {
  pairing = null;
  $('pairing-token').value = '';
  $('pairing-result').hidden = true;
}
function showPairing(result) {
  if (typeof result.token !== 'string' || !result.token) throw new Error('No pairing credential was returned. Try again.');
  pairing = result;
  $('pairing-token').value = result.token;
  fieldList($('pairing-fields'),[['Upload endpoint',result.endpoint],['Expires',result.expiresAt ? dateText(result.expiresAt) : 'Not supplied'],['Allowed readings',Array.isArray(result.metrics) ? result.metrics.join(', ') : 'Selected metrics']]);
  if (result.instructionsUrl) {
    const target = new URL(result.instructionsUrl,location.origin);
    if (target.origin === location.origin) $('shortcut-instructions').href = target.href;
  }
  $('pairing-result').hidden = false;
  $('pairing-result').scrollIntoView({behavior:'smooth',block:'nearest'});
}
function renderRecords(result) {
  const records = Array.isArray(result.records) ? result.records : [];
  const host = $('records-view');
  host.replaceChildren();
  if (!records.length) { host.append(element('p','No imported records were returned for this selection.','empty-state')); return; }
  host.append(element('p',`Showing ${records.length.toLocaleString()} of ${count(result.total ?? records.length)} records. Source dates and retrieval dates are kept separate.`,'records-caption'));
  const table = element('table');
  table.className = 'record-table';
  const thead = element('thead'); const header = element('tr');
  ['Source','Record type','Clinical date','Retrieved','Source evidence'].forEach(label => { const th=element('th',label);th.scope='col';header.append(th); });
  thead.append(header); table.append(thead);
  const tbody=element('tbody');
  records.forEach(record => {
    const row=element('tr');
    [sourceNames[record.source] || record.source || 'Source not supplied',record.resourceType || record.metric || 'Record',record.clinicalDate ? dateText(record.clinicalDate) : 'Date not supplied',record.retrievedAt ? dateText(record.retrievedAt) : 'Date not supplied'].forEach(value => row.append(element('td',value)));
    const cell=element('td');const details=element('details');details.append(element('summary','View record'));
    details.append(element('pre',JSON.stringify(record.raw ?? record,null,2)));cell.append(details);row.append(cell);tbody.append(row);
  });
  table.append(tbody);host.append(table);
}

$('refresh-status').addEventListener('click',() => perform(async()=>{ await refresh(); notify('Connection status refreshed.'); }));
$('consent-button').addEventListener('click',() => perform(async()=>{
  const enabled = status?.consent?.enabled !== true;
  await request('/api/consent',{enabled});
  if (!enabled) clearPairing();
  await refresh(); notify(enabled ? 'Private imports enabled. Each source still needs its own authorization.' : 'New private imports paused. Existing source records are retained.');
}));
['duke','oura'].forEach(name => {
  $(`${name}-connect`).addEventListener('click',() => perform(async()=>{ const result=await request(`/api/${name}/start`,{});providerRedirect(result.url); }));
  $(`${name}-sync`).addEventListener('click',() => perform(async()=>{
    const result=await request(`/api/${name}/sync`,{});await refresh();
    notify(result.complete === false ? `${sourceNames[name]} returned a partial sync. Review source coverage; missing items have not been treated as negative results.` : `${sourceNames[name]} sync finished. Review the timestamp and source coverage.`,result.complete === false);
  }));
  $(`${name}-revoke`).addEventListener('click',() => perform(async()=>{await request('/api/revoke',{source:name});await refresh();notify(`${sourceNames[name]} disconnected from this workspace. Previously imported source records remain private.`);}));
});
$('apple-pair').addEventListener('click',() => perform(async()=>{
  const metrics=Array.from(document.querySelectorAll('#apple-metrics input:checked'),node=>node.value);
  if (!metrics.length) throw new Error('Choose at least one reading type for the iPhone pairing.');
  const result=await request('/api/apple/pair',{metrics});await refresh();showPairing(result);notify('Pairing credential created. The phone is not synced until an upload receives a successful receipt.');
}));
$('apple-revoke').addEventListener('click',() => perform(async()=>{await request('/api/revoke',{source:'apple'});clearPairing();await refresh();notify('Apple Health upload access revoked. The phone’s old pairing credential will no longer be accepted.');}));
$('copy-token').addEventListener('click',async()=>{
  try { await navigator.clipboard.writeText($('pairing-token').value);notify('Pairing token copied. Paste it only into the Shortcut’s Authorization header.'); }
  catch { $('pairing-token').focus();$('pairing-token').select();notify('Select and copy the token from the pairing field.',true); }
});
$('load-records').addEventListener('click',() => perform(async()=>{const source=$('record-source').value;renderRecords(await request('/api/records'+(source?'?source='+encodeURIComponent(source):'')));}));
$('atlas-claim').addEventListener('click',() => perform(async()=>{
  if (!atlasLink || atlasLink.expiresAt <= Date.now()) { clearAtlasLink(); throw new Error('The one-time Atlas account link has expired. Request a fresh administrator link.'); }
  await request('/api/atlas/claim',{token:atlasLink.token});clearAtlasLink();clearAtlasDraft();await refresh();notify('This account is linked to Mayya’s Atlas. Connect and import the intended Duke chart before previewing a public update.');
}));
$('atlas-preview').addEventListener('click',() => perform(async()=>{
  const draft=await request('/api/atlas/preview',{});renderAtlasDraft(draft);notify('Public preview prepared. Review the source dates, additions, exclusions, and complete sanitized snapshot before publishing.');
}));
// Keep this choice local through preview/status refreshes; publish sends it with the reviewed draft.
$('atlas-auto-choice').addEventListener('change',()=>{atlasAutoChoiceInitialized=true;});
$('atlas-automatic').addEventListener('click',() => perform(async()=>{
  if (!atlasHasPublishedRevision()) throw new Error('Review a public preview and publish the first snapshot before changing automatic public updates.');
  const enabled=status?.publication?.autoPublish !== true;await request('/api/atlas/automatic',{enabled});await refresh();$('atlas-auto-choice').checked=enabled;atlasAutoChoiceInitialized=true;notify(enabled?'Automatic public updates enabled for the allow-listed structured Duke fields after a successful Duke sync.':'Automatic public updates paused. Private imports can continue; the current public snapshot remains available.');
}));
$('atlas-publish').addEventListener('click',() => perform(async()=>{
  if (!atlasDraft || (atlasDraft.expiresAt && Date.parse(atlasDraft.expiresAt)<=Date.now())) { clearAtlasDraft();throw new Error('Prepare a fresh public preview before publishing.'); }
  const receipt=await request('/api/atlas/publish',{draftId:atlasDraft.draftId,digest:atlasDraft.digest,baseRevision:atlasDraft.baseRevision,autoPublish:$('atlas-auto-choice').checked});
  clearAtlasDraft();await refresh();const host=$('atlas-receipt');host.replaceChildren();
  host.append(element('strong',`Public snapshot released${receipt.revision ? ' · revision '+receipt.revision : ''}`),element('p','The reviewed snapshot is available at the fixed public Atlas. Source clinical dates remain separate from the release timestamp.'));
  const link=element('a','Open Mayya’s public Atlas ↗');link.href=ATLAS_URL;link.target='_blank';link.rel='noopener noreferrer';host.append(link);host.hidden=false;
  notify('The reviewed Atlas snapshot was published publicly.');
}));

const query=new URLSearchParams(location.search);
if (query.get('connected') === 'duke') notify('Duke MyChart authorization returned. Check the connection status below before syncing.');
else if (query.get('connected') === 'oura') notify('Retained Oura imports are not enabled. Review the provider authorization status below.',true);
else if (query.get('error') === 'oauth_state') notify('This sign-in attempt expired or belongs to another browser. Start sign-in again in this tab with your existing account.',true);
else if (['interego_exchange_failed','authentication_required','authentication_upstream_unavailable','authentication_response_invalid','authentication_challenge_mismatch'].includes(query.get('error'))) notify('Interego sign-in could not be verified. Try signing in again with your existing account. Reference: '+query.get('error')+'.',true);
else if (query.has('error')) notify('The source connection did not finish. Reconnect the source and check its status below.',true);
if (query.has('connected') || query.has('error')) history.replaceState(null,'',location.pathname);
refresh();
