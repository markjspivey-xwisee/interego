import { signIn, generalGuestOffer, collectGeneralGuest } from './guest.js';
import { createAgentConnectionClient } from './agent-connection.js';
import { createVoice, matchSpoken } from './voice.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = (pack, id) => (pack.factions.findIndex(f => f.id === id) + 6) % 6;

const state = { token: sessionStorage.getItem('cpw-token') || '', tab: 'world', world: null, note: '', diagnosis: '', intervention: '', agent: { enabled: false }, invite: '', readAloud: false, heard: '', voiceNote: '', spokenWork: '', general: null };

// The shared voice module, served by this bridge. Speech in and out are the browser's own; this
// page sends no audio anywhere and asks no model what was said. The microphone opens only from
// the button below, and what is heard is matched against the labels on screen.
const voice = createVoice({
  onInterim: text => { state.heard = text; render(); },
  onFinal: text => command(text),
  onState: () => render(),
  onError: error => { state.voiceNote = error.message; render(); },
});

// The shared agent-connection client, served by this bridge. Opening a session needs this
// consultant's sign-in; everything after it uses the capability the session itself returned,
// which stays in this tab.
const agentClient = createAgentConnectionClient({
  root: '/agent-sessions',
  createHeaders: () => ({ Authorization: `Bearer ${state.token}` }),
  page: 'this coached-world tab',
  purpose: 'Each task is one mission for the agent I coach in a game world, and your answer is that agent\'s work product.',
});

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(state.token ? { Authorization: `Bearer ${state.token}` } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 401) { state.token = ''; sessionStorage.removeItem('cpw-token'); }
  if (!response.ok) throw new Error(body.detail || body.error || `request failed (${response.status})`);
  return body;
}

function hex(world) {
  const pack = world.pack;
  const S = 42;
  const pts = (cx, cy) => Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 180) * (60 * i - 30);
    return `${cx + (S - 2) * Math.cos(a)},${cy + (S - 2) * Math.sin(a)}`;
  }).join(' ');
  const shapes = world.territories.map(t => {
    const cx = S * Math.sqrt(3) * (t.q + t.r / 2);
    const cy = S * 1.5 * t.r;
    const share = t.control[t.heldBy] || 0;
    return `<g><polygon class="fill${hue(pack, t.heldBy)}" points="${pts(cx, cy)}" fill-opacity="${0.35 + share / 180}" stroke="#fffdf8" stroke-width="2"></polygon>
      <text x="${cx}" y="${cy}" text-anchor="middle" font-size="8" fill="#fffdf8">${esc(t.name.length > 12 ? t.name.slice(0, 11) + '.' : t.name)}</text></g>`;
  }).join('');
  return `<svg class="map" viewBox="-200 -180 400 360">${shapes}</svg>`;
}

function feed(world) {
  const items = world.feed.map(item => `<div><i class="c${hue(world.pack, item.factionId)}"></i><div>${esc(item.text)}<div class="kicker">${esc(item.t)} · ${esc(item.kind)}</div></div></div>`).join('');
  return `<div class="card"><div class="kicker">Live feed</div><div class="feed">${items || '<p>The front is quiet.</p>'}</div></div>`;
}

function agentPanel(world) {
  // Hidden when this world can not verify an agent: there is nothing to connect.
  if (!state.agent.enabled || !world.you?.factionId) return '';
  const link = state.agent.connection || { state: 'none' };
  const name = esc(world.you.roster[0]?.name || 'your agent');
  if (link.state === 'connected') {
    return `<div class="card"><div class="kicker">Connected agent</div>
      <p>${name} is now your own chat session, on its own subscription. Each mission goes to it as a brief, and what it writes is what you diagnose from. No API key is held here.</p>
      <p><code>${esc(link.actor || '')}</code></p>
      <button class="btn" data-act="agent-off">Disconnect</button></div>`;
  }
  if (link.state === 'waiting_for_agent') {
    const text = state.invite
      ? `<p>Paste this into an AI chat that has the Interego connector. It can be used once.</p><textarea class="invite" readonly rows="6">${esc(state.invite)}</textarea>
        <button class="btn primary" data-act="agent-copy">Copy the invitation</button>`
      : '<p>An invitation is open in another tab. Open a new one here to see its text.</p>';
    return `<div class="card"><div class="kicker">Connect an agent · waiting for your chat session</div>${text}
      <button class="btn" data-act="agent-on">New invitation</button>
      <button class="btn" data-act="agent-off">Cancel</button></div>`;
  }
  return `<div class="card"><div class="kicker">Connect an agent</div>
    <p>Have your own AI chat session be ${name}. It works on that session's subscription; this world asks for no API key and calls no model. Until you connect one, ${name} is simulated.</p>
    <button class="btn" data-act="agent-on">Connect an agent</button></div>`;
}

function work(m) {
  if (!m.work) return '';
  if (m.work.state === 'waiting') return '<div class="work"><div class="kicker">Connected agent</div><p>The brief is with your connected agent. Its work will appear here.</p></div>';
  if (m.work.state === 'answered') return `<div class="work"><div class="kicker">What ${esc(m.agent)} wrote</div><pre>${esc(m.work.text || '')}</pre></div>`;
  return `<div class="work"><div class="kicker">Connected agent</div><p>It did not answer (${esc(m.work.note || 'no answer')}), so this mission ran simulated.</p></div>`;
}

function voicePanel() {
  // Each half is shown only where this browser has it. With neither, there is no card.
  const { input, output } = voice.supported;
  if (!input && !output) return '';
  const listening = voice.state === 'listening' || voice.listeningRequested;
  const read = output ? `<button class="btn ${state.readAloud ? 'primary' : ''}" data-act="read-aloud" aria-pressed="${state.readAloud}">Read aloud: ${state.readAloud ? 'on' : 'off'}</button>
    ${voice.state === 'speaking' ? '<button class="btn" data-act="voice-stop">Stop reading</button>' : ''}` : '';
  const mic = input ? `<button class="btn ${listening ? 'primary' : ''}" data-act="voice-listen" aria-pressed="${listening}">${listening ? 'Stop listening' : 'Say a command'}</button>` : '';
  const status = voice.state === 'listening' ? `Listening. Say the name of a choice on this page.${state.heard ? ` Hearing: ${state.heard}` : ''}` : state.voiceNote;
  return `<div class="card voice"><div class="kicker">Voice</div><div class="voice-row">${mic}${read}</div>
    <p class="fine" data-voice-status role="status">${esc(status)}</p>
    ${input ? `<p class="fine" data-voice-notice>${esc(voice.notice)}</p>` : ''}</div>`;
}

/** What can be said right now: every enabled button on the page that carries data-say. */
function speakable() {
  return [...document.querySelectorAll('#app button[data-say]:not(:disabled)')].map(button => ({
    button,
    label: (button.querySelector('b') || button).textContent.trim(),
    aliases: button.dataset.say.split('|').filter(Boolean),
  }));
}

function command(text) {
  state.heard = '';
  const { match, ambiguous } = matchSpoken(text, speakable());
  if (match) {
    state.voiceNote = `Heard "${text}". Chose: ${match.label}.`;
    match.button.click();
  } else {
    state.voiceNote = ambiguous.length
      ? `Heard "${text}". That fits more than one choice (${ambiguous.map(option => option.label).join(', ')}), so nothing was done.`
      : `Heard "${text}". That matches nothing on this page, so nothing was done.`;
  }
  render();
}

/** The connected agent's work on the open mission, read once when it arrives. */
function announceWork(force = false) {
  const m = state.world?.you?.mission;
  if (m?.work?.state !== 'answered') return;
  const key = `${m.title}\n${m.work.text || ''}`;
  if (key === state.spokenWork && !force) return;
  state.spokenWork = key;
  if (state.readAloud) voice.speak(`${m.agent} wrote: ${m.work.text || ''}`);
}

function coach(world) {
  const you = world.you;
  if (!you?.factionId) return '<div class="card"><p>Pick a faction. You consult for an agent; you do not command one.</p></div>';
  const tier = world.pack.tiers[you.tier];
  const gate = you.gate === 'eligible' ? `<div class="card"><div class="kicker">Course gate · ${esc(world.pack.tiers[you.tier + 1]?.label || '')}</div>
    <p>This world does not mark the course passed or completed. It asks Foxxi to launch <code>${esc(you.courseIri || '')}</code> for your own account. When the course's activities meet moveOn, Foxxi records satisfied for that course. Then check the record.</p>
    <button class="btn" data-act="launch">Open the course</button>
    <button class="btn primary" data-act="gate">Check the record</button></div>` : '';
  const roster = you.roster.map(a => `<div class="choice"><b>${esc(a.name)}</b><div>${esc(a.role)}</div><div>last ${esc(a.hist.at(-1))}</div>${a.memory[0] ? `<div>${esc(a.memory[0].text)}</div>` : ''}</div>`).join('');
  let mission = `<button class="btn primary" data-act="mission" data-say="send the agent on a mission|mission">Send ${esc(you.roster[0]?.name || 'the agent')} on a mission</button>`;
  if (you.mission) {
    const m = you.mission;
    const lines = m.statements.map(s => `<div class="stmt"><span></span><span><b>${esc(s.verb.display.en)}</b> ${esc(s.result?.response || s.object.definition?.name?.en || '')}</span></div>`).join('');
    const causes = world.pack.causes.map(c => `<button class="choice ${state.diagnosis === c.id ? 'on' : ''}" data-diag="${esc(c.id)}" data-say ${c.minTier > you.tier ? 'disabled' : ''}><b>${esc(c.label)}</b><div>${esc(c.bem)}</div></button>`).join('');
    const ivs = world.pack.interventions.map(i => `<button class="choice ${state.intervention === i.id ? 'on' : ''}" data-iv="${esc(i.id)}" data-say ${i.minTier > you.tier ? 'disabled' : ''}><b>${esc(i.label)}</b> <span>${i.cost}</span><div>${esc(i.composes)}</div></button>`).join('');
    mission = `<div class="kicker">${esc(m.type)} · ${esc(m.territory)}</div><h2>${esc(m.title)}</h2><p>${esc(m.agent)} · ${esc(m.kpi)} · baseline ${esc(m.before)}</p>
      <div class="choices">${m.co.map(c => `<span class="choice">${esc(c.agent)} · ${esc(c.name)} · ${c.ally ? 'ally' : 'rival'}</span>`).join('')}</div>
      <div>${lines}</div>${work(m)}
      <div class="kicker">Diagnose</div><div class="choices">${causes}</div>
      <div class="kicker">Intervene</div><div class="choices">${ivs}</div>
      <button class="btn primary" data-act="intervene" data-say="deploy" ${state.diagnosis && state.intervention ? '' : 'disabled'}>Deploy and measure</button>`;
  }
  return `${gate}<div class="card"><div class="row"><div class="kicker">${esc(tier?.label || '')} · ${you.roster.length}/${you.rosterCap}</div><div>${esc(you.influence)} influence · rank ${esc(you.rank)}</div></div><div class="choices">${roster}</div></div>
    ${agentPanel(world)}${voicePanel()}<div class="card">${mission}</div>`;
}

function market(world) {
  if (!world.you?.factionId) return '';
  const cards = world.market.map(a => `<div class="card"><b>${esc(a.name)}</b><div>${esc(a.role)}</div><div>${a.factionId ? esc(a.factionId) : 'unattached'} · ${esc(a.completion)}</div>
    <button class="btn" data-buy="${esc(a.id)}">Take on · ${esc(Math.round(a.price * (a.factionId && a.factionId !== world.you.factionId ? 1.4 : 1)))}</button></div>`).join('');
  return `<div class="market">${cards || '<p>No one is unattached.</p>'}</div>`;
}

function diplomacy(world) {
  const you = world.you;
  if (!you?.factionId) return '';
  const rows = world.pack.factions.filter(f => f.id !== you.factionId).map(f => {
    const key = [you.factionId, f.id].sort().join('|');
    const on = world.pacts.includes(key);
    return `<div class="card"><b>${esc(f.name)}</b><div>${esc(f.motto)}</div>${on ? `<button class="btn" data-dissolve="${esc(f.id)}">Dissolve pact</button>` : `<button class="btn primary" data-pact="${esc(f.id)}">Propose pact · ${esc(world.pack.pactProposalCost)}</button>`}</div>`;
  }).join('');
  return rows;
}

function ranks(world) {
  const body = world.leaderboard.map((row, i) => `<tr class="${row.you ? 'you' : ''}"><td>${i + 1}</td><td>${esc(row.name)}</td><td>${esc(row.factionId)}</td><td>${row.roi.toFixed(2)}x</td><td>+${esc(row.growth)}</td></tr>`).join('');
  return `<div class="card"><div class="kicker">Consultant ROI and agent growth</div><table><thead><tr><th>#</th><th>Consultant</th><th>Faction</th><th>ROI</th><th>Growth</th></tr></thead><tbody>${body}</tbody></table></div>`;
}

function worldTab(world) {
  const cards = world.standings.map(s => `<div class="faction edge${hue(world.pack, s.id)}"><b>${esc(s.name)}</b><div>${s.territories} territories · ${s.consultants} consultants · ${s.agents} agents</div>
    ${world.you?.factionId ? '' : `<button class="btn primary" data-join="${esc(s.id)}" ${state.token ? '' : 'disabled'}>Join</button>`}</div>`).join('');
  return `<div class="card">${hex(world)}</div><div class="factions">${cards}</div>`;
}

function render() {
  const world = state.world;
  const root = document.getElementById('app');
  if (!world) { root.textContent = 'The world did not load.'; return; }
  const you = world.you;
  const tabs = you?.factionId ? ['world', 'coach', 'market', 'diplomacy', 'ranks'] : ['world'];
  const panel = { world: worldTab, coach, market, diplomacy, ranks }[state.tab] || worldTab;
  root.innerHTML = `<header class="top"><div><h1>${esc(world.pack.title)}</h1><p class="tag">${esc(world.pack.tagline)}</p></div>
    <div class="meta"><div><div class="kicker">${esc(world.pack.season.name)}</div><b>${esc(world.clock.long)}</b></div>
    <div><div class="kicker">Online</div><b>${esc(world.online)}</b></div>
    ${you ? `<div><div class="kicker">You</div><b>${esc(you.name)}</b></div>` : `<button class="btn primary" data-act="guest">Join as guest</button>${state.general ? ' <button class="btn" data-act="general-guest">Use my Interego guest</button>' : ''}`}</div></header>
    ${state.note ? `<div class="card">${esc(state.note)}</div>` : ''}
    <div class="tabs">${tabs.map(id => `<button class="${state.tab === id ? 'on' : ''}" data-tab="${id}">${id}</button>`).join('')}</div>
    <div class="layout"><div class="main">${panel(world)}</div><div class="side">${feed(world)}</div></div>`;
}

async function refresh() {
  state.world = await api('/world');
  // Whether an agent can be connected here and, when signed in, what this consultant's is doing.
  state.agent = await api('/agent-sessions').catch(() => ({ enabled: false }));
  if ((state.agent.connection?.state || 'none') === 'none') state.invite = '';
  if (state.world.you && !state.world.you.factionId) state.tab = 'world';
  announceWork();
  render();
}

document.getElementById('app').addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.tab) { state.tab = target.dataset.tab; render(); return; }
    if (target.dataset.diag) { state.diagnosis = target.dataset.diag; render(); return; }
    if (target.dataset.iv) { state.intervention = target.dataset.iv; render(); return; }
    if (target.dataset.act === 'general-guest') { location.assign(state.general.startUrl); return; }
    if (target.dataset.act === 'voice-listen') {
      // The only place the microphone is opened: this click.
      state.voiceNote = '';
      if (voice.state === 'listening' || voice.listeningRequested) voice.stopListening(); else voice.startListening();
      render(); return;
    }
    if (target.dataset.act === 'read-aloud') {
      state.readAloud = !state.readAloud;
      if (state.readAloud) announceWork(true); else voice.stop();
      render(); return;
    }
    if (target.dataset.act === 'voice-stop') { voice.stop(); render(); return; }
    if (target.dataset.act === 'guest') {
      const session = await signIn();
      state.token = session.token;
      sessionStorage.setItem('cpw-token', session.token);
      state.note = `Signed in as ${session.name}. Pick a faction.`;
    } else if (target.dataset.join) {
      await api('/faction', { method: 'POST', body: { factionId: target.dataset.join } });
      state.tab = 'coach';
      state.note = 'Your agent is on its pod. Read what it does, then change what it works with.';
    } else if (target.dataset.act === 'agent-on') {
      // A new session each time: the one before it, and whoever was paired with it, is closed.
      await agentClient.disconnect();
      state.invite = await agentClient.connect();
      state.note = 'Paste the invitation into your AI chat. It expires in five minutes.';
    } else if (target.dataset.act === 'agent-copy') {
      await navigator.clipboard.writeText(state.invite);
      state.note = 'Invitation copied.';
    } else if (target.dataset.act === 'agent-off') {
      await agentClient.disconnect();
      await api('/agent-sessions', { method: 'DELETE', body: {} });
      state.invite = '';
      state.note = 'Agent disconnected. Missions are simulated again.';
    } else if (target.dataset.act === 'mission') {
      await api('/missions', { method: 'POST', body: {} });
      state.diagnosis = ''; state.intervention = '';
    } else if (target.dataset.act === 'intervene') {
      const result = await api('/missions/intervene', { method: 'POST', body: { diagnosis: state.diagnosis, interventionId: state.intervention } });
      state.note = result.matched ? `The cause was ${result.cause.label}. The score moved ${result.delta}.` : `No lift. The cause was ${result.cause.label}.`;
      if (state.readAloud) voice.speak(state.note);
      state.diagnosis = ''; state.intervention = '';
    } else if (target.dataset.act === 'launch') {
      const launched = await api('/gate/launch', { method: 'POST', body: {} });
      state.note = `Course opened for this account. ${launched.launchUrl}`;
    } else if (target.dataset.act === 'gate') {
      const result = await api('/gate/refresh', { method: 'POST', body: {} });
      state.note = result.promoted ? `The course record is in. You now hold the next tier.` : 'The course has not sent passed and completed yet.';
    } else if (target.dataset.buy) {
      const result = await api('/market/transfer', { method: 'POST', body: { agentId: target.dataset.buy } });
      state.note = `${result.agent} now answers to you. Their memory came with them.`;
    } else if (target.dataset.pact) {
      const result = await api('/pacts', { method: 'POST', body: { factionId: target.dataset.pact } });
      state.note = result.accepted ? 'Pact signed.' : 'The other faction declined.';
    } else if (target.dataset.dissolve) {
      await api('/pacts', { method: 'DELETE', body: { factionId: target.dataset.dissolve } });
      state.note = 'Pact dissolved.';
    }
    await refresh();
  } catch (error) {
    state.note = error.message;
    render();
  }
});

/** Whether the general guest door is offered here, and the session waiting after a return from it. */
async function arrive() {
  state.general = await generalGuestOffer().catch(() => null);
  const here = new URL(location.href);
  if (here.searchParams.get('arrived') !== 'general') return;
  here.searchParams.delete('arrived');
  history.replaceState(null, '', here.pathname + here.search);
  if (!state.general) return;
  const session = await collectGeneralGuest(state.general).catch(() => null);
  if (!session?.token) { state.note = 'The guest did not arrive. Try again.'; return; }
  state.token = session.token;
  sessionStorage.setItem('cpw-token', session.token);
  state.note = `Signed in as ${session.name}. Pick a faction.`;
}

arrive().catch(() => undefined).then(() => refresh()).then(() => setInterval(() => refresh().catch(() => undefined), 3000)).catch(error => {
  document.getElementById('app').textContent = error.message;
});
