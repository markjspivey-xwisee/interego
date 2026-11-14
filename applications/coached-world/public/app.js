import { signIn } from './guest.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const hue = (pack, id) => (pack.factions.findIndex(f => f.id === id) + 6) % 6;

const state = { token: sessionStorage.getItem('cpw-token') || '', tab: 'world', world: null, note: '', diagnosis: '', intervention: '' };

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

function coach(world) {
  const you = world.you;
  if (!you?.factionId) return '<div class="card"><p>Pick a faction. You consult for an agent; you do not command one.</p></div>';
  const tier = world.pack.tiers[you.tier];
  const gate = you.gate === 'eligible' ? `<div class="card"><div class="kicker">Course gate · ${esc(world.pack.tiers[you.tier + 1]?.label || '')}</div>
    <p>This world does not mark the course passed or completed. It asks Foxxi to launch <code>${esc(you.courseIri || '')}</code> for your own account. When the course's activities meet moveOn, Foxxi records satisfied for that course. Then check the record.</p>
    <button class="btn" data-act="launch">Open the course</button>
    <button class="btn primary" data-act="gate">Check the record</button></div>` : '';
  const roster = you.roster.map(a => `<div class="choice"><b>${esc(a.name)}</b><div>${esc(a.role)}</div><div>last ${esc(a.hist.at(-1))}</div>${a.memory[0] ? `<div>${esc(a.memory[0].text)}</div>` : ''}</div>`).join('');
  let mission = `<button class="btn primary" data-act="mission">Send ${esc(you.roster[0]?.name || 'the agent')} on a mission</button>`;
  if (you.mission) {
    const m = you.mission;
    const lines = m.statements.map(s => `<div class="stmt"><span></span><span><b>${esc(s.verb.display.en)}</b> ${esc(s.result?.response || s.object.definition?.name?.en || '')}</span></div>`).join('');
    const causes = world.pack.causes.map(c => `<button class="choice ${state.diagnosis === c.id ? 'on' : ''}" data-diag="${esc(c.id)}" ${c.minTier > you.tier ? 'disabled' : ''}><b>${esc(c.label)}</b><div>${esc(c.bem)}</div></button>`).join('');
    const ivs = world.pack.interventions.map(i => `<button class="choice ${state.intervention === i.id ? 'on' : ''}" data-iv="${esc(i.id)}" ${i.minTier > you.tier ? 'disabled' : ''}><b>${esc(i.label)}</b> <span>${i.cost}</span><div>${esc(i.composes)}</div></button>`).join('');
    mission = `<div class="kicker">${esc(m.type)} · ${esc(m.territory)}</div><h2>${esc(m.title)}</h2><p>${esc(m.agent)} · ${esc(m.kpi)} · baseline ${esc(m.before)}</p>
      <div class="choices">${m.co.map(c => `<span class="choice">${esc(c.agent)} · ${esc(c.name)} · ${c.ally ? 'ally' : 'rival'}</span>`).join('')}</div>
      <div>${lines}</div>
      <div class="kicker">Diagnose</div><div class="choices">${causes}</div>
      <div class="kicker">Intervene</div><div class="choices">${ivs}</div>
      <button class="btn primary" data-act="intervene" ${state.diagnosis && state.intervention ? '' : 'disabled'}>Deploy and measure</button>`;
  }
  return `${gate}<div class="card"><div class="row"><div class="kicker">${esc(tier?.label || '')} · ${you.roster.length}/${you.rosterCap}</div><div>${esc(you.influence)} influence · rank ${esc(you.rank)}</div></div><div class="choices">${roster}</div></div>
    <div class="card">${mission}</div>`;
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
    ${you ? `<div><div class="kicker">You</div><b>${esc(you.name)}</b></div>` : `<button class="btn primary" data-act="guest">Join as guest</button>`}</div></header>
    ${state.note ? `<div class="card">${esc(state.note)}</div>` : ''}
    <div class="tabs">${tabs.map(id => `<button class="${state.tab === id ? 'on' : ''}" data-tab="${id}">${id}</button>`).join('')}</div>
    <div class="layout"><div class="main">${panel(world)}</div><div class="side">${feed(world)}</div></div>`;
}

async function refresh() {
  state.world = await api('/world');
  if (state.world.you && !state.world.you.factionId) state.tab = 'world';
  render();
}

document.getElementById('app').addEventListener('click', async event => {
  const target = event.target.closest('button');
  if (!target) return;
  try {
    if (target.dataset.tab) { state.tab = target.dataset.tab; render(); return; }
    if (target.dataset.diag) { state.diagnosis = target.dataset.diag; render(); return; }
    if (target.dataset.iv) { state.intervention = target.dataset.iv; render(); return; }
    if (target.dataset.act === 'guest') {
      const session = await signIn();
      state.token = session.token;
      sessionStorage.setItem('cpw-token', session.token);
      state.note = `Signed in as ${session.name}. Pick a faction.`;
    } else if (target.dataset.join) {
      await api('/faction', { method: 'POST', body: { factionId: target.dataset.join } });
      state.tab = 'coach';
      state.note = 'Your agent is on its pod. Read what it does, then change what it works with.';
    } else if (target.dataset.act === 'mission') {
      await api('/missions', { method: 'POST', body: {} });
      state.diagnosis = ''; state.intervention = '';
    } else if (target.dataset.act === 'intervene') {
      const result = await api('/missions/intervene', { method: 'POST', body: { diagnosis: state.diagnosis, interventionId: state.intervention } });
      state.note = result.matched ? `The cause was ${result.cause.label}. The score moved ${result.delta}.` : `No lift. The cause was ${result.cause.label}.`;
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

refresh().then(() => setInterval(() => refresh().catch(() => undefined), 3000)).catch(error => {
  document.getElementById('app').textContent = error.message;
});
