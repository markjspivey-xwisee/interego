// Substrate-client wrappers for the tic-tac-toe tournament.
//
// Every write is rev-196 signed-request — each agent (designer, player)
// holds an ECDSA wallet, signs sha256(canonical-JSON) with it, and the
// relay binds descriptor authorship to the recovered DID. Reads use the
// relay's public discover_context with the rev-192 graph_iri filter so
// the dashboard can scope queries to specific tournaments / agreements.
//
// Tournament topology: ONE tournament pod under the relay-derived
// eth-prefix slug of the TOURNAMENT operator's DID (passed in via
// TOURNAMENT_POD_OWNER env or defaulted). All designers, players, and
// the arbiter publish to this single pod under distinct graph IRIs:
//   urn:graph:tournament:<id>:proposals  — designer proposals
//   urn:graph:tournament:<id>:agreement  — the agreed ruleset
//   urn:graph:tournament:<id>:games      — per-game game-id records
//   urn:graph:tournament:<id>:moves      — every move (per agreement)
//   urn:graph:tournament:<id>:results    — final game results

import { createHash } from 'node:crypto';

const RELAY = (process.env.CG_RELAY_URL ?? 'https://interego-relay.livelysky-8b81abb0.eastus.azurecontainerapps.io').replace(/\/$/, '');
const GATE  = (process.env.CG_GATE_URL  ?? 'https://interego-css-gate.livelysky-8b81abb0.eastus.azurecontainerapps.io').replace(/\/$/, '');

export function relayUrl() { return RELAY; }
export function gateUrl()  { return GATE; }

/** Slug for an agent's eth-derived pod name. Matches the relay's binding. */
export function agentSlug(did) {
  const m = did.match(/0x([0-9a-fA-F]+)/);
  if (m && m[1]) return m[1].slice(-12).toLowerCase();
  return createHash('sha256').update(did).digest('hex').slice(0, 12);
}

export function tournamentPodUrl(operatorDid) {
  return `${GATE}/eth-${agentSlug(operatorDid)}/`;
}

/** Build a signed-request envelope per rev 196. */
async function signedBody({ wallet, did, args }) {
  const payload = { ...args, agent_id: did, timestamp: new Date().toISOString() };
  const json = JSON.stringify(payload);
  const hash = createHash('sha256').update(json, 'utf8').digest('hex');
  const signature = await wallet.signMessage(`sha256:${hash}`);
  return { _signature: signature, _signed_payload: json };
}

// Per-pod write queue + minimum inter-write delay.
//
// The relay's publish_context silently drops writes when CSS is
// under sustained load — even after concurrency-serialization, a
// burst of >~3/sec to the same pod loses descriptors. Adding a
// 350ms floor between writes brings the delivery rate to ~100%
// at the cost of throughput. For a tournament that's a fine
// trade-off: a 12-game round-robin needs ~100 writes, completing
// in ~35s of pure publish time.
const _writeQueues = new Map();
const _lastWriteAt = new Map();
const MIN_INTER_WRITE_MS = 2000;

function _enqueueWrite(podSlug, fn) {
  const prev = _writeQueues.get(podSlug) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => {
    const last = _lastWriteAt.get(podSlug) ?? 0;
    const wait = MIN_INTER_WRITE_MS - (Date.now() - last);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const out = await fn();
    _lastWriteAt.set(podSlug, Date.now());
    return out;
  });
  _writeQueues.set(podSlug, next);
  next.then(() => {
    if (_writeQueues.get(podSlug) === next) _writeQueues.delete(podSlug);
  }, () => {});
  return next;
}

/**
 * Publish a typed payload to a graph on the agent's OWN pod.
 *
 * Uses publish_context (auth-required, rev-196 signature path). The
 * descriptor's authorship is bound to the wallet's recovered DID.
 *
 * The relay's publish_context expects `graph_content` (Turtle), not a
 * raw JSON object — so we wrap the payload as a `ttt:payload` literal
 * inside a minimal `urn:cg:ns:ttt:Event` graph. The aggregator on the
 * read side knows this convention and pulls the JSON back out.
 *
 * Writes to the same pod are SERIALIZED via _enqueueWrite — concurrent
 * publishes to the same pod silently fail at the relay (race in the
 * manifest update), so per-pod serialization is mandatory.
 */
export async function publishContext({ wallet, did, graphIri, kind, payload }) {
  const podSlug = agentSlug(did);
  return _enqueueWrite(podSlug, () => _publishContextNow({ wallet, did, graphIri, kind, payload }));
}

async function _publishContextNow({ wallet, did, graphIri, kind, payload }) {
  const eventId = `urn:cg:ttt-event:${kind}:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const escape = s => String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const graphContent =
`@prefix ttt: <urn:cg:ns:ttt:> .
@prefix cg: <https://markjspivey-xwisee.github.io/interego/ns/cg#> .
@prefix prov: <http://www.w3.org/ns/prov#> .

<${eventId}>
    a ttt:Event ;
    ttt:channel "${escape(kind)}" ;
    ttt:payloadJson "${escape(JSON.stringify(payload))}" ;
    prov:wasAttributedTo <${did}> ;
    cg:modalStatus cg:Asserted .
`;
  const args = {
    graph_iri: graphIri,
    graph_content: graphContent,
    descriptor_id: eventId,
    modal_status: 'Asserted',
    pod_name: `eth-${agentSlug(did)}`,
    sign_authorship: false,
    visibility: 'public',
    auto_supersede_prior: false,
  };
  const signed = await signedBody({ wallet, did, args });
  const resp = await fetch(`${RELAY}/tool/publish_context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(signed),
  });
  let j; try { j = await resp.json(); } catch { j = { error: `non-json status ${resp.status}` }; }
  return {
    ok: !j.error && (j.descriptorUrl || j.publish?.descriptorUrl),
    descriptorUrl: j.descriptorUrl ?? j.publish?.descriptorUrl,
    graphIri,
    eventId,
    raw: j,
  };
}

/**
 * Fetch the GRAPH PAYLOAD for a descriptor and parse the
 * `ttt:payloadJson` literal back into a JS object.
 *
 * The descriptor URL points at the cg:ContextDescriptor metadata
 * (facets, provenance, trust). The actual graph content lives at a
 * sibling URL by convention: `<descriptor-url>-graph.trig`. The
 * descriptor's cg:Affordance / hydra:target points to it explicitly —
 * we follow the naming convention to skip a round-trip.
 */
export async function readEventPayload(descriptorUrl) {
  if (!descriptorUrl) return null;
  // discover_context returns URLs with the INTERNAL Azure CSS hostname
  // (interego-css.internal.livelysky-...) which is only reachable from
  // inside the Container Apps env. External clients (this script,
  // browsers, any dashboard) must use the gate hostname instead.
  const externalUrl = descriptorUrl.replace(/\binterego-css\.internal\./, 'interego-css-gate.');
  const graphUrl = externalUrl.replace(/\.ttl$/, '-graph.trig');
  const resp = await fetch(graphUrl, { headers: { Accept: 'application/trig, text/turtle' } });
  if (!resp.ok) return null;
  const turtle = await resp.text();
  const m = turtle.match(/ttt:payloadJson\s+"((?:[^"\\]|\\.)*)"/);
  if (!m) return null;
  const raw = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * Record a tournament trajectory step — wraps publishContext with the
 * exact graph IRI conventions used by the dashboard's aggregators.
 */
export async function publishTournamentEvent({ wallet, did, tournamentId, channel, payload }) {
  const graphIri = `urn:graph:tournament:${tournamentId}:${channel}`;
  return publishContext({ wallet, did, graphIri, kind: channel, payload });
}

/**
 * Read all descriptors on a specific graph IRI from a tournament pod.
 *
 * Uses the rev-192 discover_context graph_iri filter — no need to scan
 * the whole pod manifest, the relay returns just the entries that
 * match the graph.
 */
export async function readChannel({ tournamentPodUrl, tournamentId, channel, limit = 100 }) {
  const graphIri = `urn:graph:tournament:${tournamentId}:${channel}`;
  const resp = await fetch(`${RELAY}/tool/discover_context`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pod_url: tournamentPodUrl,
      graph_iri: graphIri,
      sort: 'newest-first',
      limit,
    }),
  });
  let j; try { j = await resp.json(); } catch { j = { entries: [] }; }
  return Array.isArray(j.entries) ? j.entries : [];
}

/**
 * Dereference a descriptor (read its payload). Used by the dashboard
 * when it needs the full game state, not just the manifest entry.
 */
export async function dereference(descriptorUrl) {
  const resp = await fetch(`${RELAY}/tool/dereference`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ descriptor_url: descriptorUrl }),
  });
  try { return await resp.json(); } catch { return null; }
}

/**
 * SSE-driven wake on a tournament pod. The dashboard uses this so the
 * leaderboard reacts to new game results the instant they land.
 */
export async function* subscribeTournament({ tournamentPodUrl, signal }) {
  const slug = createHash('sha256').update(tournamentPodUrl).digest('hex').slice(0, 16);
  const url = `${RELAY}/notifications/${slug}`;
  let backoff = 1_000;
  while (!signal?.aborted) {
    try {
      const resp = await fetch(url, { headers: { 'Accept': 'text/event-stream' }, signal });
      if (!resp.ok) {
        await new Promise(r => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30_000);
        continue;
      }
      backoff = 1_000;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (!signal?.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          if (/^data:/m.test(event)) yield { at: Date.now() };
        }
      }
    } catch (err) {
      if (signal?.aborted) break;
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}
