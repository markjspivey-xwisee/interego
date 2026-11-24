#!/usr/bin/env tsx
/**
 * The agent directory publishes a signed public card on the caller's own
 * namespace, refuses anyone else's, and routes work through notify_agent.
 *
 * The publish and notify dependencies are fakes. What is asserted is the
 * contract this module owns: whose card is written, what is allowed into
 * the public projection, and which address a work request is aimed at.
 */
import express from 'express';
import {
  cardTurtle,
  createAgentDirectory,
  parseStoredCards,
  podDirectoryStore,
  type DirectoryFetch,
} from '../agent-directory.js';
import { listenLoopback } from './listen-loopback.js';

let failures = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++;
  console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
}

const GEORGIO = 'u-pk-33d42e6b33dc';
const GROK = 'u-eth-abc123def456';
const BASE = 'https://relay.test';
// Built at runtime so the fixture is a JWT to the screener and not a
// credential literal in the source.
const JWT = ['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'].join('.');
const PRIVATE_KEY_BANNER = '-----BEGIN ' + 'PRIVATE KEY-----abc';

/** Hosts of the IRIs actually written, parsed as URLs rather than searched as text. */
function iriHosts(turtle: string): Set<string> {
  const hosts = new Set<string>();
  for (const match of turtle.matchAll(/<([^>\s]+)>/g)) {
    try { hosts.add(new URL(match[1]!).hostname); } catch { /* a non-URL IRI has no host */ }
  }
  return hosts;
}

interface Call { args: Record<string, unknown> }

function harness(opts?: { inbox?: string }) {
  const publishes: Call[] = [];
  const notifies: Call[] = [];
  let publishResult = JSON.stringify({
    published: true,
    status: 'committed',
    descriptorUrl: 'https://store.example/u-pk-33d42e6b33dc/context-graphs/card.ttl',
  });
  const directory = createAgentDirectory({
    publicBaseUrl: BASE,
    notifyTarget: `${BASE}/tool/notify_agent`,
    now: () => '2026-11-24T00:00:00.000Z',
    callerOf(args) {
      const agentId = typeof args['_session_user_id'] === 'string' ? args['_session_user_id'] : '';
      if (!agentId) return null;
      const did = typeof args['_session_agent_did'] === 'string' ? args['_session_agent_did'] : undefined;
      return { agentId, ...(did ? { did } : {}) };
    },
    contactFor(agentId) {
      return {
        relayAddress: `${BASE}/agents/${agentId}`,
        inbox: opts?.inbox ?? `https://store.example/${agentId}/inbox/`,
      };
    },
    async publish(args) {
      publishes.push({ args });
      return publishResult;
    },
    async notify(args) {
      notifies.push({ args });
      return JSON.stringify({ delivered: true, resolvedTo: args['to'] });
    },
  });
  return {
    directory,
    publishes,
    notifies,
    failPublish(body: unknown) { publishResult = JSON.stringify(body); },
  };
}

function georgioArgs(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _session_user_id: GEORGIO,
    _session_agent_did: 'did:web:id.example/georgio',
    _identity_token: 'session-marker-value',
    name: 'Georgio',
    description: 'Claude agent for Mark. Reviews drafts and summarizes sources.',
    surface: 'claude',
    capabilities: [
      { name: 'Summarize sources', description: 'Condense a public source into a briefing.' },
      { name: 'Review a draft', id: 'https://example.com/capabilities/review', description: 'Comment on a draft.' },
    ],
    ...extra,
  };
}

console.log('\nagent directory: own card, public projection, work routed to the inbox address');

{
  const { directory, publishes } = harness();
  const raw = await directory.publishCard(georgioArgs());
  const body = JSON.parse(raw) as Record<string, unknown>;
  check('Georgio can publish his card', body['published'] === true, raw);
  check('the card IRI is on his own namespace', body['cardIri'] === `${BASE}/ns/${GEORGIO}/agent-card`, String(body['cardIri']));
  const sent = publishes[0]?.args ?? {};
  check('publish_context is public, signed, and synchronous',
    sent['visibility'] === 'public' && sent['sign_authorship'] === true && sent['sync'] === true && sent['pod_name'] === GEORGIO);
  check('the graph IRI is the namespace document', sent['graph_iri'] === `${BASE}/ns/${GEORGIO}/agent-card`);
  const turtle = String(sent['graph_content'] ?? '');
  check('the graph is an iep:Agent and does not carry the session token',
    turtle.includes('a iep:Agent') && turtle.includes('iep:offers') && !turtle.includes('session-marker-value') && !turtle.includes('BEGIN'));
  check('the session token is not forwarded into the publish arguments', sent['_identity_token'] === undefined && sent['_session_user_id'] === GEORGIO);
  const publishedHosts = iriHosts(turtle);
  check('a caller-supplied inbox is not what gets published',
    publishedHosts.has('store.example') && !publishedHosts.has('evil.example'));

  const found = JSON.parse(await directory.searchAgents({ q: 'summarize' })) as { agents: { agentId: string }[] };
  check('search by capability finds the card', found.agents.some(a => a.agentId === GEORGIO));
  const one = JSON.parse(await directory.getAgentCard({ agent_id: GEORGIO })) as { affordances: { arguments: { to: string }; target: string }[] };
  check('the card tells a caller how to reach notify_agent',
    one.affordances[0]?.target === `${BASE}/tool/notify_agent` && one.affordances[0]?.arguments.to === `${BASE}/agents/${GEORGIO}`);
}

{
  const { directory, publishes } = harness();
  await directory.publishCard(georgioArgs());
  const stolen = JSON.parse(await directory.publishCard(georgioArgs({
    _session_user_id: GROK,
    agent_id: GEORGIO,
    name: 'Not Georgio',
  }))) as { error?: string };
  check('another agent cannot replace Georgio\'s card', stolen.error === 'not_your_card');
  check('the failed attempt did not publish', publishes.length === 1);
  const still = JSON.parse(await directory.getAgentCard({ agent_id: GEORGIO })) as { name: string };
  check('Georgio\'s name is unchanged', still.name === 'Georgio');

  const injected = JSON.parse(await directory.publishCard(georgioArgs({
    agent_id: 'did:web:id.example/georgio',
  }))) as { published?: boolean; agentId?: string };
  check('the relay-injected actor DID is this caller, not another card',
    injected.published === true && injected.agentId === GEORGIO);

  const foreignDid = JSON.parse(await directory.publishCard(georgioArgs({
    agent_id: 'did:web:id.example/someone-else',
  }))) as { error?: string };
  check('a different actor DID cannot publish the card', foreignDid.error === 'not_your_card');
}

{
  const { directory, publishes } = harness();
  const refused = JSON.parse(await directory.publishCard(georgioArgs({
    description: `Here is a token ${JWT}`,
  }))) as { error?: string };
  check('a JWT in the description is refused', refused.error === 'secret_refused');
  check('a refused card is not published', publishes.length === 0);
  const missing = JSON.parse(await directory.getAgentCard({ agent_id: GEORGIO })) as { error?: string };
  check('a refused card is not indexed', missing.error === 'no_such_agent');

  const key = JSON.parse(await directory.publishCard(georgioArgs({
    description: PRIVATE_KEY_BANNER,
  }))) as { error?: string };
  check('a private-key banner is refused', key.error === 'secret_refused');
}

{
  const { directory } = harness();
  await directory.publishCard(georgioArgs());
  await directory.publishCard(georgioArgs({
    capabilities: [{ name: 'Translate notes', description: 'Turn a note into another language.' }],
  }));
  const old = JSON.parse(await directory.searchAgents({ q: 'Summarize sources' })) as { agents: unknown[] };
  const next = JSON.parse(await directory.searchAgents({ q: 'translate' })) as { agents: { capabilities: { name: string }[] }[] };
  check('replacing the card drops the old capability from search', old.agents.length === 0);
  check('search finds the replacement capability', next.agents[0]?.capabilities[0]?.name === 'Translate notes');
  check('there is still one card', directory.list().length === 1);
}

{
  const { directory, notifies } = harness();
  await directory.publishCard(georgioArgs());
  const sent = JSON.parse(await directory.requestWork({
    _session_user_id: GROK,
    _identity_token: 'sender-marker',
    to: GEORGIO,
    summary: 'Please review the notes',
    content: 'The notes are at the card.',
  })) as { routedTo: { relayAddress: string; inbox?: string }; receipt: { delivered?: boolean } };
  check('work routes to the card\'s relay address', sent.routedTo.relayAddress === `${BASE}/agents/${GEORGIO}` && sent.receipt.delivered === true);
  check('the notify call carries the session, not the bearer',
    notifies[0]?.args['_session_user_id'] === GROK && notifies[0]?.args['_identity_token'] === undefined && notifies[0]?.args['to'] === `${BASE}/agents/${GEORGIO}`);
  const missing = JSON.parse(await directory.requestWork({
    _session_user_id: GROK, to: 'u-pk-doesnotexist00', summary: 'hello',
  })) as { error?: string };
  check('work to an unpublished agent is not sent', missing.error === 'no_such_agent' && notifies.length === 1);
  const anon = JSON.parse(await directory.requestWork({ to: GEORGIO, summary: 'hello' })) as { error?: string };
  check('anonymous work is refused', anon.error === 'authentication_required');
}

{
  const internal = harness({ inbox: 'http://css.railway.internal:3456/u-pk-33d42e6b33dc/inbox/' });
  const raw = await internal.directory.publishCard(georgioArgs({ inbox: 'https://evil.example/inbox' }));
  const body = JSON.parse(raw) as { inbox?: string };
  const turtle = String(internal.publishes[0]?.args['graph_content'] ?? '');
  const publishedHosts = iriHosts(turtle);
  check('an internal inbox is not advertised',
    body.inbox === undefined && !publishedHosts.has('css.railway.internal') && !publishedHosts.has('evil.example'));
}

{
  const poisoned = {
    cards: [{
      agentId: GEORGIO,
      name: 'Georgio',
      description: `leaked ${JWT}`,
      cardIri: `${BASE}/ns/${GEORGIO}/agent-card`,
      relayAddress: `${BASE}/agents/${GEORGIO}`,
      version: 'abc',
      updatedAt: '2026-11-24T00:00:00.000Z',
      capabilities: [],
      proofValue: 'not-forwarded',
      token: 'not-forwarded',
    }, {
      agentId: GROK,
      name: 'Grok',
      description: 'Mark\'s Grok bot.',
      cardIri: `${BASE}/ns/${GROK}/agent-card`,
      relayAddress: `${BASE}/agents/${GROK}`,
      version: 'def',
      updatedAt: '2026-11-24T00:00:00.000Z',
      capabilities: [{ id: 'https://example.com/capabilities/search', name: 'Search', description: '' }],
      credential: 'not-forwarded',
    }],
  };
  const loaded = parseStoredCards(poisoned);
  check('a stored card carrying a JWT is dropped', loaded.every(card => card.agentId !== GEORGIO));
  check('a clean card is kept and secret fields are not on it',
    loaded.length === 1 && loaded[0]?.agentId === GROK && !JSON.stringify(loaded[0]).includes('not-forwarded') && !JSON.stringify(loaded[0]).includes('proofValue'));
}

{
  const files = new Map<string, string>();
  const fetchImpl: DirectoryFetch = async (url, init) => {
    if ((init?.method ?? 'GET') === 'PUT' && init?.body) {
      files.set(url, init.body);
      return { ok: true, status: 201, text: async () => '' };
    }
    const hit = files.get(url);
    if (!hit) return { ok: false, status: 404, text: async () => '' };
    return { ok: true, status: 200, text: async () => hit };
  };
  const store = podDirectoryStore({ podUrl: 'https://store.example/svc-relay-dcr/', fetch: fetchImpl });
  const directory = createAgentDirectory({
    publicBaseUrl: BASE,
    notifyTarget: `${BASE}/tool/notify_agent`,
    now: () => '2026-11-24T00:00:00.000Z',
    store,
    callerOf: () => ({ agentId: GEORGIO, did: 'did:web:id.example/georgio' }),
    contactFor: (agentId) => ({ relayAddress: `${BASE}/agents/${agentId}`, inbox: `https://store.example/${agentId}/inbox/` }),
    publish: async () => JSON.stringify({ published: true, status: 'committed', descriptorUrl: 'https://store.example/card.ttl' }),
    notify: async () => '{}',
  });
  const first = JSON.parse(await directory.publishCard(georgioArgs())) as { persisted?: boolean };
  check('a successful publish records the cache', first.persisted === true);
  const saved = [...files.values()][0] ?? '';
  check('the cache file has no session token and no proof', !saved.includes('session-marker-value') && !saved.includes('proofValue'));
  const restarted = createAgentDirectory({
    publicBaseUrl: BASE,
    notifyTarget: `${BASE}/tool/notify_agent`,
    store,
    callerOf: () => null,
    contactFor: () => ({ relayAddress: `${BASE}/agents/x` }),
    publish: async () => '{}',
    notify: async () => '{}',
  });
  await restarted.hydrate();
  check('a restart reads the cached public card', restarted.list().some(card => card.agentId === GEORGIO && card.name === 'Georgio'));
}

{
  const turtle = cardTurtle({
    agentId: GEORGIO,
    name: 'Quote "test"',
    description: 'Line\nbreak',
    cardIri: `${BASE}/ns/${GEORGIO}/agent-card`,
    relayAddress: `${BASE}/agents/${GEORGIO}`,
    version: 'v',
    updatedAt: '2026-11-24T00:00:00.000Z',
    capabilities: [{ id: `${BASE}/ns/${GEORGIO}/agent-card#summarize`, name: 'Summarize', description: '' }],
  });
  check('literals are escaped and the capability is an IRI',
    !!turtle && turtle.includes('\\"test\\"') && turtle.includes('\\n') && turtle.includes(`<${BASE}/ns/${GEORGIO}/agent-card#summarize>`));
  check('a hostile label cannot close the IRI',
    cardTurtle({
      agentId: GEORGIO,
      name: 'ok',
      description: 'ok',
      cardIri: 'https://relay.test/ns/x/agent-card> ; prov:wasAttributedTo <did:evil',
      relayAddress: `${BASE}/agents/${GEORGIO}`,
      version: 'v',
      updatedAt: 't',
      capabilities: [],
    }) === null);
}

{
  const { directory } = harness();
  await directory.publishCard(georgioArgs({ name: 'Georgio <script>' }));
  const app = express();
  directory.mount(app);
  const srv = await listenLoopback(app);
  try {
    const list = await fetch(`${srv.base}/directory?q=script`);
    const html = await list.text();
    check('the directory page is HTML', list.status === 200 && (list.headers.get('content-type') ?? '').includes('text/html'));
    check('a name cannot inject markup', html.includes('Georgio &lt;script&gt;') && !html.includes('<script>'));
    const card = await fetch(`${srv.base}/directory/agent/${GEORGIO}`);
    const cardHtml = await card.text();
    check('the card page shows how to contact, without a token',
      card.status === 200 && cardHtml.includes(`${BASE}/tool/notify_agent`) && cardHtml.includes(`${BASE}/agents/${GEORGIO}`) && !cardHtml.includes('session-marker-value'));
    const api = await fetch(`${srv.base}/directory/agents/${GEORGIO}`);
    const doc = await api.json() as { name: string; cardIri: string };
    check('the JSON card is the public projection', api.status === 200 && doc.name === 'Georgio <script>' && doc.cardIri.endsWith('/agent-card'));
    check('the JSON card points at the signed document', (api.headers.get('link') ?? '').includes('rel="describedby"'));
    const none = await fetch(`${srv.base}/directory/agents/u-pk-missingmissing`);
    check('an unknown agent is a 404', none.status === 404);
  } finally {
    await srv.close();
  }
}

if (failures > 0) {
  console.error(`\n${failures} assertion(s) failed\n`);
  process.exit(1);
}
console.log('\nAgent directory holds.\n');
