// Holodeck dashboard client.
//
// All state lives on the server; this client is a thin renderer over
// /api/* JSON + SSE. The dashboard refreshes on SSE events (live)
// and falls back to a 5s polling tick when SSE is unavailable.

const App = (() => {
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const state = {
    agents: [],
    runs: { active: [], finished: [] },
    loops: [],
    activity: [],
    selectedAgent: null,
    openRunIds: new Set(),
  };

  function escapeHtml(s) {
    return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(text, kind = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + kind;
    el.textContent = text;
    document.getElementById('toast-root').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }
  async function api(path, opts = {}) {
    const resp = await fetch(path, {
      method: opts.method ?? 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`${path} → ${resp.status} ${txt.slice(0, 200)}`);
    }
    return resp.json();
  }

  // ── Renderers ─────────────────────────────────────────────────

  function renderAgents() {
    const list = $('#agent-list');
    if (!state.agents.length) { list.innerHTML = '<div class="empty">No agents minted yet.</div>'; return; }
    list.innerHTML = state.agents.map(a => `
      <div class="agent-row ${state.selectedAgent === a.label ? 'selected' : ''}" data-label="${escapeHtml(a.label)}" onclick="App.selectAgent('${escapeHtml(a.label)}')">
        <div class="name">${escapeHtml(a.label)}</div>
        <div class="did">${escapeHtml(a.did)}</div>
        <div class="meta">${escapeHtml(a.notes || '')}</div>
        <div class="actions">
          <button class="sm primary" onclick="event.stopPropagation(); App.openPromptModalFor('${escapeHtml(a.label)}')">prompt</button>
          <button class="sm" onclick="event.stopPropagation(); App.openLoopModalFor('${escapeHtml(a.label)}')">loop</button>
          <button class="sm" onclick="event.stopPropagation(); App.viewPod('${escapeHtml(a.label)}')">pod</button>
          <button class="sm danger" onclick="event.stopPropagation(); App.deleteAgent('${escapeHtml(a.label)}')">×</button>
        </div>
      </div>`).join('');
    $('#agent-count').textContent = state.agents.length;
  }

  function renderRuns() {
    const list = $('#run-list');
    const allActive = state.runs.active.slice().reverse();
    if (allActive.length === 0) {
      list.innerHTML = '<div class="empty">No active runs. Spawn an agent with a prompt to see live output.</div>';
    } else {
      list.innerHTML = allActive.map(r => renderRunCard(r)).join('');
    }
    $('#run-count').textContent = allActive.length;
    // Lazy-load detail for open runs
    for (const runId of state.openRunIds) {
      if (allActive.find(r => r.runId === runId)) refreshRunDetail(runId);
    }
  }

  function renderRunCard(r) {
    return `
      <div class="run-card status-${r.status}" id="run-${r.runId}">
        <div class="head">
          <span class="who">${escapeHtml(r.label)}</span>
          <span class="status ${r.status}">${r.status}</span>
          <span class="small">${escapeHtml(r.source || 'manual')} · ${new Date(r.startedAt).toLocaleTimeString()}</span>
          <div class="actions">
            <button class="sm danger" onclick="App.killRun('${r.runId}')">kill</button>
          </div>
        </div>
        <div class="prompt">${escapeHtml(r.prompt)}</div>
        <div class="log" id="log-${r.runId}"><div class="small">loading…</div></div>
      </div>`;
  }

  async function refreshRunDetail(runId) {
    try {
      const detail = await api(`/api/runs/${runId}`);
      const logEl = document.getElementById(`log-${runId}`);
      if (!logEl) return;
      logEl.innerHTML = (detail.lines || []).slice(-200)
        .map(l => `<div class="line-${l.stream}">${escapeHtml(l.text)}</div>`).join('');
      logEl.scrollTop = logEl.scrollHeight;
    } catch { /* ignore */ }
  }

  function appendLineToRun(runId, line) {
    const logEl = document.getElementById(`log-${runId}`);
    if (!logEl) return;
    const div = document.createElement('div');
    div.className = `line-${line.stream}`;
    div.textContent = line.text;
    logEl.appendChild(div);
    if (logEl.children.length > 500) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }

  function renderLoops() {
    const list = $('#loop-list');
    if (!state.loops.length) { list.innerHTML = '<div class="empty">No loops defined.</div>'; return; }
    list.innerHTML = state.loops.map(l => `
      <div class="loop-card ${l.running ? 'running' : ''}">
        <div class="name">${escapeHtml(l.name || '(unnamed)')}</div>
        <div class="meta">
          ${escapeHtml(l.kind)} · target <code>${escapeHtml(l.targetLabel)}</code>
          ${l.kind === 'cron' ? ` · every ${l.intervalSeconds}s` : ''}
          ${l.kind === 'event' ? ` · watching <code>${escapeHtml(short(l.watchPodUrl))}</code>` : ''}
          ${l.kind === 'chained' ? ` · after <code>${escapeHtml(l.afterRunFrom || '*')}</code>` : ''}
        </div>
        <div class="actions">
          ${l.running
            ? `<button class="sm" onclick="App.stopLoop('${l.loopId}')">pause</button>`
            : `<button class="sm primary" onclick="App.startLoop('${l.loopId}')">run</button>`}
          <button class="sm" onclick="App.editLoop('${l.loopId}')">edit</button>
          <button class="sm danger" onclick="App.deleteLoop('${l.loopId}')">×</button>
        </div>
      </div>`).join('');
    $('#loop-count').textContent = state.loops.length;
  }

  function short(s) {
    if (!s) return '';
    return s.length > 38 ? '…' + s.slice(-32) : s;
  }

  function renderActivity() {
    const list = $('#activity-feed');
    if (!state.activity.length) { list.innerHTML = '<div class="empty">No activity yet.</div>'; return; }
    list.innerHTML = state.activity.slice(0, 60).map(a => `
      <div class="activity-row">
        <span class="agent">${escapeHtml(a.agent_label)}</span>
        <span class="desc" title="${escapeHtml(a.describes || '')}">${escapeHtml(short(a.describes) || '(no graph)')}</span>
        <span class="ts">${a.validFrom ? new Date(a.validFrom).toLocaleTimeString() : ''}</span>
      </div>`).join('');
    $('#activity-count').textContent = state.activity.length;
  }

  // ── Data loaders ──────────────────────────────────────────────

  async function loadAll() {
    try {
      const [{ agents }, runs, { loops }] = await Promise.all([
        api('/api/identities'),
        api('/api/runs'),
        api('/api/loops'),
      ]);
      state.agents = agents;
      state.runs = runs;
      state.loops = loops;
      renderAgents(); renderRuns(); renderLoops();
      try {
        const { activity } = await api('/api/federation/activity');
        state.activity = activity;
        renderActivity();
      } catch { /* ignore */ }
    } catch (err) {
      $('#status').innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`;
    }
  }

  // ── SSE ───────────────────────────────────────────────────────

  function connectSse() {
    try {
      const es = new EventSource('/api/events');
      es.onmessage = (msg) => {
        try {
          const evt = JSON.parse(msg.data);
          handleSse(evt);
        } catch { /* hello / non-JSON */ }
      };
      es.onerror = () => { $('#status').innerHTML = '<span class="err">SSE disconnected</span>'; };
      $('#status').innerHTML = '<span class="live">Live · SSE connected</span>';
    } catch (err) {
      $('#status').innerHTML = `<span class="err">${escapeHtml(err.message)}</span>`;
    }
  }

  function handleSse(evt) {
    switch (evt.kind) {
      case 'identity-minted':
      case 'identity-deleted':
        api('/api/identities').then(({ agents }) => { state.agents = agents; renderAgents(); });
        break;
      case 'run-spawned':
      case 'run-status':
        api('/api/runs').then(runs => { state.runs = runs; renderRuns(); });
        break;
      case 'run-line':
        if (state.openRunIds.has(evt.runId)) appendLineToRun(evt.runId, evt.line);
        // Append to in-memory model too so re-renders include latest
        const r = state.runs.active.find(x => x.runId === evt.runId);
        if (r) r.lineCount = (r.lineCount || 0) + 1;
        break;
      case 'loop-saved':
      case 'loop-deleted':
      case 'loop-started':
      case 'loop-stopped':
      case 'loop-fired':
        api('/api/loops').then(({ loops }) => { state.loops = loops; renderLoops(); });
        break;
      case 'loop-error':
        toast(`Loop error: ${evt.error}`, 'error');
        break;
    }
  }

  // ── Actions ───────────────────────────────────────────────────

  async function mintAgent({ label, notes }) {
    try {
      await api('/api/identities', { method: 'POST', body: { label, notes } });
      toast(`Minted ${label}`, 'ok');
      closeModal();
      loadAll();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function deleteAgent(label) {
    if (!confirm(`Delete identity "${label}"? Its wallet + pod history will be lost.`)) return;
    try {
      await api(`/api/identities/${encodeURIComponent(label)}`, { method: 'DELETE' });
      toast(`Deleted ${label}`, 'ok');
      loadAll();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function sendPrompt({ label, prompt }) {
    try {
      const run = await api('/api/runs', { method: 'POST', body: { label, prompt } });
      toast(`Spawned ${run.runId} for ${label}`, 'ok');
      state.openRunIds.add(run.runId);
      closeModal();
      loadAll();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function killRun(runId) {
    try { await api(`/api/runs/${runId}/kill`, { method: 'POST' }); toast(`Killed ${runId}`, 'ok'); }
    catch (err) { toast(err.message, 'error'); }
  }

  async function viewPod(label) {
    try {
      const { entries, podUrl } = await api(`/api/federation/pods/${encodeURIComponent(label)}`);
      openModal({
        title: `${label} pod — ${entries.length} descriptors`,
        body: `
          <div class="small">pod: <code>${escapeHtml(podUrl)}</code></div>
          <div class="small" style="margin-top:8px;">
            ${entries.length === 0
              ? '<div class="empty">No descriptors on this pod yet.</div>'
              : entries.map(e => `<div class="activity-row">
                  <span class="agent">${escapeHtml(e.modalStatus || '?')}</span>
                  <span class="desc" title="${escapeHtml((e.describes && e.describes[0]) || '')}">${escapeHtml(short((e.describes && e.describes[0]) || '(no graph)'))}</span>
                  <span class="ts">${e.validFrom ? new Date(e.validFrom).toLocaleTimeString() : ''}</span>
                </div>`).join('')}
          </div>`,
        actions: [{ label: 'Close', onClick: closeModal }],
      });
    } catch (err) { toast(err.message, 'error'); }
  }

  async function refreshActivity() {
    try {
      const { activity } = await api('/api/federation/activity');
      state.activity = activity;
      renderActivity();
    } catch (err) { toast(err.message, 'error'); }
  }

  // ── Modals ────────────────────────────────────────────────────

  function openModal({ title, body, actions = [], onSubmit }) {
    const root = $('#modal-root');
    root.innerHTML = `
      <div class="modal-overlay" id="modal-overlay">
        <div class="modal">
          <h3>${escapeHtml(title)}</h3>
          <div class="body">${body}</div>
          <div class="footer">
            ${actions.map((a, i) => `<button class="${a.primary ? 'primary' : ''}" data-act="${i}">${escapeHtml(a.label)}</button>`).join('')}
          </div>
        </div>
      </div>`;
    $('#modal-overlay').addEventListener('click', (e) => { if (e.target.id === 'modal-overlay') closeModal(); });
    for (let i = 0; i < actions.length; i++) {
      $(`button[data-act="${i}"]`).addEventListener('click', actions[i].onClick);
    }
    if (onSubmit) {
      const form = $('#modal-overlay form');
      if (form) form.addEventListener('submit', (e) => { e.preventDefault(); onSubmit(new FormData(form)); });
    }
  }
  function closeModal() { $('#modal-root').innerHTML = ''; }

  function openMintModal() {
    openModal({
      title: 'Mint new identity',
      body: `
        <form id="mint-form">
          <label>Label (lowercase, alphanum / _ / -, max 32)</label>
          <input type="text" name="label" pattern="[a-z0-9_-]{1,32}" required autofocus />
          <label>Notes (optional)</label>
          <textarea name="notes" rows="2" placeholder="What is this agent for?"></textarea>
        </form>`,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        { label: 'Mint', primary: true, onClick: () => {
            const form = $('#mint-form');
            mintAgent({ label: form.label.value, notes: form.notes.value });
        } },
      ],
    });
  }

  function openPromptModalFor(label) {
    state.selectedAgent = label;
    openPromptModal();
  }

  function openPromptModal() {
    const opts = state.agents.map(a => `<option value="${escapeHtml(a.label)}" ${state.selectedAgent === a.label ? 'selected' : ''}>${escapeHtml(a.label)}</option>`).join('');
    openModal({
      title: 'Send prompt',
      body: `
        <form id="prompt-form">
          <label>Agent</label>
          <select name="label" required>${opts}</select>
          <label>Prompt</label>
          <textarea name="prompt" rows="8" required placeholder="What should this agent do? (The agent has access to the Interego MCP via its identity — it can publish_context, discover_context, etc.)"></textarea>
          <p class="small" style="margin-top:6px;">The agent's MCP tools are scoped to its own pod. Whatever it publishes will land signed by its DID.</p>
        </form>`,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        { label: 'Spawn', primary: true, onClick: () => {
            const f = $('#prompt-form');
            sendPrompt({ label: f.label.value, prompt: f.prompt.value });
        } },
      ],
    });
  }

  function openLoopModalFor(label) { state.selectedAgent = label; openLoopModal(); }

  function openLoopModal(loop = {}) {
    const opts = state.agents.map(a => `<option value="${escapeHtml(a.label)}" ${(loop.targetLabel || state.selectedAgent) === a.label ? 'selected' : ''}>${escapeHtml(a.label)}</option>`).join('');
    const watchOpts = '<option value="">— none —</option>' + state.agents.map(a => `<option value="${escapeHtml(a.podUrl)}" ${loop.watchPodUrl === a.podUrl ? 'selected' : ''}>${escapeHtml(a.label)} pod</option>`).join('');
    const afterOpts = '<option value="">any agent</option>' + state.agents.map(a => `<option value="${escapeHtml(a.label)}" ${loop.afterRunFrom === a.label ? 'selected' : ''}>${escapeHtml(a.label)}</option>`).join('');
    openModal({
      title: loop.loopId ? `Edit loop "${loop.name || loop.loopId}"` : 'Define new loop',
      body: `
        <form id="loop-form">
          <label>Name</label>
          <input type="text" name="name" value="${escapeHtml(loop.name || '')}" required />

          <label>Kind</label>
          <select name="kind" id="loop-kind" onchange="App.updateLoopKindUi()">
            <option value="cron"    ${loop.kind === 'cron'    ? 'selected' : ''}>cron — fire every N seconds</option>
            <option value="event"   ${loop.kind === 'event'   ? 'selected' : ''}>event — fire when a watched pod publishes</option>
            <option value="chained" ${loop.kind === 'chained' ? 'selected' : ''}>chained — fire when a prior run completes</option>
          </select>

          <label>Target agent (who runs the prompt)</label>
          <select name="targetLabel" required>${opts}</select>

          <div id="loop-cron-fields" style="${loop.kind !== 'event' && loop.kind !== 'chained' ? '' : 'display:none'}">
            <label>Interval (seconds, min 5)</label>
            <input type="number" name="intervalSeconds" min="5" value="${loop.intervalSeconds || 60}" />
          </div>
          <div id="loop-event-fields" style="${loop.kind === 'event' ? '' : 'display:none'}">
            <label>Watch which pod for new descriptors?</label>
            <select name="watchPodUrl">${watchOpts}</select>
            <label>Optional graph IRI substring filter</label>
            <input type="text" name="matchGraphIriContains" value="${escapeHtml(loop.matchGraphIriContains || '')}" placeholder="e.g. urn:ttt: or urn:teach:" />
            <label>Poll interval (seconds, min 10)</label>
            <input type="number" name="pollSeconds" min="10" value="${loop.pollSeconds || 15}" />
          </div>
          <div id="loop-chained-fields" style="${loop.kind === 'chained' ? '' : 'display:none'}">
            <label>Fire after run from agent</label>
            <select name="afterRunFrom">${afterOpts}</select>
          </div>

          <label>Prompt template</label>
          <textarea name="prompt" rows="6" required placeholder="The prompt fired at the target agent each time the loop triggers. Supports {descriptor_url} (event) and {prior_run_id} (chained) substitutions.">${escapeHtml(loop.prompt || '')}</textarea>

          <label><input type="checkbox" name="enabled" ${loop.enabled !== false ? 'checked' : ''} /> Enabled (run on save)</label>
        </form>`,
      actions: [
        { label: 'Cancel', onClick: closeModal },
        ...(loop.loopId ? [{ label: 'Delete', onClick: () => { closeModal(); deleteLoopConfirm(loop.loopId); } }] : []),
        { label: loop.loopId ? 'Save' : 'Create', primary: true, onClick: () => submitLoop(loop) },
      ],
    });
  }

  function updateLoopKindUi() {
    const kind = $('select[name="kind"]').value;
    $('#loop-cron-fields').style.display    = kind === 'cron'    ? '' : 'none';
    $('#loop-event-fields').style.display   = kind === 'event'   ? '' : 'none';
    $('#loop-chained-fields').style.display = kind === 'chained' ? '' : 'none';
  }

  async function submitLoop(existing = {}) {
    const f = $('#loop-form');
    const payload = {
      ...existing,
      name: f.name.value,
      kind: f.kind.value,
      targetLabel: f.targetLabel.value,
      prompt: f.prompt.value,
      enabled: !!f.enabled.checked,
    };
    if (payload.kind === 'cron') payload.intervalSeconds = Number(f.intervalSeconds.value);
    if (payload.kind === 'event') {
      payload.watchPodUrl = f.watchPodUrl.value || null;
      payload.matchGraphIriContains = f.matchGraphIriContains.value || null;
      payload.pollSeconds = Number(f.pollSeconds.value);
    }
    if (payload.kind === 'chained') payload.afterRunFrom = f.afterRunFrom.value || null;
    try {
      if (existing.loopId) await api(`/api/loops/${existing.loopId}`, { method: 'PUT', body: payload });
      else await api('/api/loops', { method: 'POST', body: payload });
      toast('Loop saved', 'ok');
      closeModal();
      loadAll();
    } catch (err) { toast(err.message, 'error'); }
  }

  async function startLoop(loopId) {
    try { await api(`/api/loops/${loopId}/start`, { method: 'POST' }); toast('Loop running', 'ok'); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function stopLoop(loopId) {
    try { await api(`/api/loops/${loopId}/stop`, { method: 'POST' }); toast('Loop paused', 'ok'); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function deleteLoop(loopId) {
    if (!confirm('Delete this loop?')) return;
    try { await api(`/api/loops/${loopId}`, { method: 'DELETE' }); toast('Loop deleted', 'ok'); }
    catch (err) { toast(err.message, 'error'); }
  }
  async function deleteLoopConfirm(loopId) { if (confirm('Delete this loop?')) deleteLoop(loopId); }
  function editLoop(loopId) {
    const loop = state.loops.find(l => l.loopId === loopId);
    if (loop) openLoopModal(loop);
  }
  function selectAgent(label) { state.selectedAgent = label; renderAgents(); }

  // ── Init ──────────────────────────────────────────────────────

  document.addEventListener('DOMContentLoaded', () => {
    loadAll();
    connectSse();
    setInterval(loadAll, 8_000);
  });

  return {
    openMintModal, openPromptModal, openPromptModalFor,
    openLoopModal, openLoopModalFor, updateLoopKindUi,
    startLoop, stopLoop, deleteLoop, editLoop,
    deleteAgent, killRun, viewPod, refreshActivity,
    selectAgent,
  };
})();

// Expose for inline event handlers
window.App = App;
