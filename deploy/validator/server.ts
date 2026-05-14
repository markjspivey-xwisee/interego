#!/usr/bin/env tsx
/**
 * Interego Validator-as-Agent Service (skeleton)
 *
 * LAYER: Layer 3 — reference implementation of the Layer 2 "validator as
 * first-class federated agent" pattern. See spec/LAYERS.md. The protocol
 * does not mandate this service; it's one concrete way to stand up a
 * validator that participates in a pod's federation rather than acting
 * as an out-of-band gatekeeper.
 *
 * What it does:
 *
 *   1. On startup, registers itself on the target pod's agent registry
 *      as a cg:AuthorizedAgent with role=Validator. The registration
 *      credential is issued by the relay's register_agent endpoint.
 *   2. Subscribes to Solid Notifications on the pod's context-graphs
 *      container (see deploy/mcp-relay/subscription-client.ts). New
 *      descriptor writes emit events.
 *   3. On each event, fetches the newly-published descriptor Turtle and
 *      hands it to an operator-provided SHACL engine — see "Bring your
 *      own SHACL engine" below.
 *   4. Packages the engine's sh:ValidationReport inside a context graph,
 *      with prov:wasDerivedFrom pointing at BOTH the descriptor being
 *      validated AND the shape set that produced the finding (so
 *      historical findings remain verifiable against the exact ruleset —
 *      see LAYERS.md §4.1).
 *   5. Publishes the finding context graph back to the pod via the
 *      relay's publish_context endpoint.
 *
 * Bring your own SHACL engine:
 *   This container runs no SHACL engine in-process — it stays a thin
 *   orchestrator with no RDF/SHACL dependency. The operator runs any
 *   engine (pyshacl, rdf-validate-shacl, Jena, TopBraid, ...) behind a
 *   small HTTP adapter and points SHACL_ENDPOINT at it. The contract is
 *   purely W3C-standard:
 *     Request  (POST application/json):
 *       { data: "<turtle>", dataFormat: "text/turtle",
 *         shapes?: "<turtle>", shapesFormat?: "text/turtle" }
 *     Response (application/json):
 *       { conforms: boolean, report?: "<sh:ValidationReport turtle>" }
 *   When SHACL_ENDPOINT is unset the validator runs in no-op mode:
 *   events are still recorded on /health, but nothing is validated or
 *   published — an honest no-op rather than a silent pretend-pass.
 *   See deploy/validator/README.md for adapter examples.
 *
 * Status: the SHACL hand-off + finding publication are live. The
 * subscription loop + registration handshake are still stubbed; until
 * the subscription client is wired, drive validation via POST /validate.
 *
 * Environment:
 *   IDENTITY_URL        — identity server base URL (for /register-agent)
 *   RELAY_URL           — relay base URL (for /tool/publish_context)
 *   POD_URL             — target pod root (e.g. https://css.../u-pk-abc/)
 *   AGENT_ID            — self identity (e.g. urn:agent:validator:core-1.0:markj)
 *   AGENT_BEARER        — pre-issued identity bearer (for now; OAuth later)
 *   OWNER_WEBID         — pod owner WebID for published findings (optional)
 *   SHACL_ENDPOINT      — operator-provided SHACL engine URL (BYO; see above)
 *   SHACL_ENDPOINT_TOKEN— optional bearer for the SHACL engine
 *   SHAPES_URL          — Turtle shape set to validate against (optional;
 *                         if unset, the engine uses its own configured shapes)
 *   PORT                — health-check server port (default 9090)
 */

import express from 'express';

const PORT = parseInt(process.env['PORT'] ?? '9090');
const IDENTITY_URL = (process.env['IDENTITY_URL'] ?? '').replace(/\/?$/, '');
const RELAY_URL = (process.env['RELAY_URL'] ?? '').replace(/\/?$/, '');
const POD_URL = (process.env['POD_URL'] ?? '').replace(/\/?$/, '/');
const AGENT_ID = process.env['AGENT_ID'] ?? 'urn:agent:validator:core-1.0:default';
const AGENT_BEARER = process.env['AGENT_BEARER'] ?? '';
const OWNER_WEBID = process.env['OWNER_WEBID'] ?? '';
const SHACL_ENDPOINT = process.env['SHACL_ENDPOINT'] ?? '';
const SHACL_ENDPOINT_TOKEN = process.env['SHACL_ENDPOINT_TOKEN'] ?? '';
const SHAPES_URL = process.env['SHAPES_URL'] ?? '';

function log(msg: string): void {
  console.log(`[validator] ${msg}`);
}

// ── State ─────────────────────────────────────────────────────

interface ValidatorState {
  registeredAt: string | null;
  subscribedTo: string | null;
  eventsProcessed: number;
  findingsPublished: number;
  lastEventAt: string | null;
  lastError: string | null;
  shapesLoaded: boolean;
  lastConforms: boolean | null;
}

const state: ValidatorState = {
  registeredAt: null,
  subscribedTo: null,
  eventsProcessed: 0,
  findingsPublished: 0,
  lastEventAt: null,
  lastError: null,
  shapesLoaded: false,
  lastConforms: null,
};

/** Cached SHAPES_URL body, fetched once at startup. */
let shapesCache: string | null = null;

/**
 * Fetch and cache the configured shape set. A missing or unreachable
 * SHAPES_URL is not fatal — the validator simply sends no shapes and
 * lets the operator's engine fall back to its own configured ruleset.
 */
async function loadShapes(): Promise<void> {
  if (!SHAPES_URL) return;
  try {
    const resp = await fetch(SHAPES_URL, {
      headers: { Accept: 'text/turtle' },
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      log(`loadShapes: ${resp.status} fetching ${SHAPES_URL} — proceeding without bundled shapes`);
      return;
    }
    shapesCache = await resp.text();
    state.shapesLoaded = true;
    log(`loadShapes: cached ${shapesCache.length} bytes from ${SHAPES_URL}`);
  } catch (err) {
    state.lastError = `loadShapes: ${(err as Error).message}`;
    log(`loadShapes: ${state.lastError} — proceeding without bundled shapes`);
  }
}

/** Extract the pod slug (last path segment) from a pod root URL. */
function podNameFromUrl(url: string): string {
  const parts = url.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'default';
}

// ── Registration ──────────────────────────────────────────────

/**
 * Register this validator as an agent on the target pod. Idempotent:
 * if the agent is already in the pod's registry, returns success
 * without re-issuing a credential.
 *
 * Skeleton implementation — real version calls
 * `POST <relay>/tool/register_agent` with Authorization: Bearer <token>.
 */
async function registerSelf(): Promise<boolean> {
  if (!IDENTITY_URL || !RELAY_URL || !POD_URL || !AGENT_BEARER) {
    log(`registerSelf: missing config; skipping (IDENTITY_URL=${!!IDENTITY_URL}, RELAY_URL=${!!RELAY_URL}, POD_URL=${!!POD_URL}, AGENT_BEARER=${!!AGENT_BEARER})`);
    return false;
  }
  try {
    const resp = await fetch(`${RELAY_URL}/tool/register_agent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGENT_BEARER}` },
      body: JSON.stringify({
        agent_id: AGENT_ID,
        pod_url: POD_URL,
        scope: 'Read',
        role: 'Validator',
        label: `Validator (${AGENT_ID})`,
      }),
    });
    if (!resp.ok) {
      log(`registerSelf: ${resp.status} ${await resp.text()}`);
      return false;
    }
    state.registeredAt = new Date().toISOString();
    log(`registerSelf: registered as ${AGENT_ID} on ${POD_URL}`);
    return true;
  } catch (err) {
    state.lastError = `register: ${(err as Error).message}`;
    log(`registerSelf: ${state.lastError}`);
    return false;
  }
}

// ── Subscription (skeleton) ───────────────────────────────────

/**
 * Subscribe to Solid Notifications on `<pod>/context-graphs/`.
 * Skeleton — real version uses deploy/mcp-relay/subscription-client.ts
 * (once it's exported as a package or moved under src/solid/).
 *
 * For now this stub just records the intended target so the /health
 * endpoint surfaces what the validator would be watching.
 */
async function subscribeToPod(): Promise<void> {
  const target = `${POD_URL}context-graphs/`;
  state.subscribedTo = target;
  log(`subscribeToPod: watching ${target} (stub — wire real subscription client in follow-up)`);
}

// ── Validation + finding publishing ───────────────────────────

interface ValidationResult {
  /** True once the SHACL engine returned a well-formed response. */
  validated: boolean;
  /** The engine's verdict, when validation ran. */
  conforms?: boolean;
  /** True once the finding was published to the pod via the relay. */
  published: boolean;
  /** Failure reason, when validation or publication did not complete. */
  error?: string;
}

/**
 * Fetch the newly-published descriptor, hand it to the operator's SHACL
 * engine (BYO — see file header), and publish the resulting
 * sh:ValidationReport back to the pod as a finding context graph.
 *
 * Graceful degradation: with no SHACL_ENDPOINT the event is recorded but
 * nothing is validated; with no relay configured the finding is computed
 * but not published. Neither case throws.
 */
async function validateAndPublish(descriptorUrl: string): Promise<ValidationResult> {
  state.eventsProcessed++;
  state.lastEventAt = new Date().toISOString();

  if (!SHACL_ENDPOINT) {
    log(`validateAndPublish: ${descriptorUrl} — SHACL_ENDPOINT not set; event recorded, no validation (no-op mode).`);
    return { validated: false, published: false };
  }

  try {
    // 1. Fetch the descriptor Turtle.
    const descResp = await fetch(descriptorUrl, {
      headers: { Accept: 'text/turtle' },
      signal: AbortSignal.timeout(15000),
    });
    if (!descResp.ok) throw new Error(`fetch descriptor ${descResp.status}`);
    const data = await descResp.text();

    // 2. Hand off to the operator-provided SHACL engine. The contract is
    //    W3C-standard: Turtle data (+ optional Turtle shapes) in,
    //    { conforms, report } out. See file header + README.
    const engineResp = await fetch(SHACL_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(SHACL_ENDPOINT_TOKEN ? { Authorization: `Bearer ${SHACL_ENDPOINT_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        data,
        dataFormat: 'text/turtle',
        ...(shapesCache ? { shapes: shapesCache, shapesFormat: 'text/turtle' } : {}),
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!engineResp.ok) {
      throw new Error(`SHACL engine ${engineResp.status}: ${(await engineResp.text()).slice(0, 200)}`);
    }
    const { conforms, report } = (await engineResp.json()) as { conforms?: boolean; report?: string };
    if (typeof conforms !== 'boolean') {
      throw new Error('SHACL engine response missing boolean `conforms`');
    }
    state.lastConforms = conforms;

    // 3. Build the finding graph: the engine's sh:ValidationReport plus
    //    provenance linking it to the validated descriptor and, when a
    //    shape set was supplied, the ruleset that produced the verdict.
    const graphIri = `urn:cg:validator-finding:${Date.now()}`;
    const provLines = [`<${graphIri}> <http://www.w3.org/ns/prov#wasDerivedFrom> <${descriptorUrl}> .`];
    if (SHAPES_URL) {
      provLines.push(`<${graphIri}> <http://www.w3.org/ns/prov#wasDerivedFrom> <${SHAPES_URL}> .`);
    }
    const reportTurtle = report
      ?? `[] a <http://www.w3.org/ns/shacl#ValidationReport> ; <http://www.w3.org/ns/shacl#conforms> ${conforms} .`;
    const graphContent = `${reportTurtle}\n${provLines.join('\n')}\n`;

    // 4. Publish the finding back to the pod via the relay, when wired.
    let published = false;
    if (RELAY_URL && AGENT_BEARER && POD_URL) {
      const pubResp = await fetch(`${RELAY_URL}/tool/publish_context`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGENT_BEARER}` },
        body: JSON.stringify({
          pod_name: podNameFromUrl(POD_URL),
          agent_id: AGENT_ID,
          ...(OWNER_WEBID ? { owner_webid: OWNER_WEBID } : {}),
          descriptor_id: `urn:cg:validator:${Date.now()}`,
          graph_iri: graphIri,
          graph_content: graphContent,
          modal_status: 'Asserted',
          confidence: 1.0,
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!pubResp.ok) {
        throw new Error(`publish_context ${pubResp.status}: ${(await pubResp.text()).slice(0, 200)}`);
      }
      published = true;
      state.findingsPublished++;
    } else {
      log(`validateAndPublish: relay not configured; finding for ${descriptorUrl} computed (conforms=${conforms}) but not published.`);
    }

    log(`validateAndPublish: ${descriptorUrl} → conforms=${conforms}${published ? ' (published)' : ''}`);
    return { validated: true, conforms, published };
  } catch (err) {
    state.lastError = `validate: ${(err as Error).message}`;
    log(`validateAndPublish: ${state.lastError}`);
    return { validated: false, published: false, error: (err as Error).message };
  }
}

// ── HTTP ──────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// ── /.well-known/security.txt — RFC 9116 ─────────────────────
//
// Coordinated disclosure contact for security researchers. The
// validator deliberately has zero dependency on @interego/core (lean
// container, separate Dockerfile). Body MUST stay in lockstep with
// @interego/core's buildSecurityTxt — verified by
// tests/security-txt-consistency.test.ts so audit consistency holds.
// See spec/policies/14-vulnerability-management.md §5.3.
const SECURITY_CONTACT = process.env['SECURITY_CONTACT'];
const PUBLIC_BASE_URL = process.env['PUBLIC_BASE_URL'];
const SECURITY_TXT_BODY = (() => {
  const contact = SECURITY_CONTACT
    ? (SECURITY_CONTACT.startsWith('mailto:') || SECURITY_CONTACT.startsWith('https:') || SECURITY_CONTACT.startsWith('tel:')
        ? SECURITY_CONTACT
        : `mailto:${SECURITY_CONTACT}`)
    : 'https://github.com/markjspivey-xwisee/interego/security/advisories/new';
  const lines = [
    `Contact: ${contact}`,
    `Expires: 2027-01-01T00:00:00Z`,
    `Preferred-Languages: en`,
  ];
  if (PUBLIC_BASE_URL) {
    lines.push(`Canonical: ${PUBLIC_BASE_URL.replace(/\/$/, '')}/.well-known/security.txt`);
  }
  lines.push(`Policy: https://github.com/markjspivey-xwisee/interego/blob/main/spec/policies/14-vulnerability-management.md`);
  lines.push(`Acknowledgments: https://github.com/markjspivey-xwisee/interego/blob/main/SECURITY-ACKNOWLEDGMENTS.md`);
  lines.push('');
  return lines.join('\n');
})();
app.get(['/.well-known/security.txt', '/security.txt'], (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.send(SECURITY_TXT_BODY);
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    agent: AGENT_ID,
    pod: POD_URL || null,
    registeredAt: state.registeredAt,
    subscribedTo: state.subscribedTo,
    eventsProcessed: state.eventsProcessed,
    findingsPublished: state.findingsPublished,
    lastEventAt: state.lastEventAt,
    lastError: state.lastError,
    shapesLoaded: state.shapesLoaded,
    lastConforms: state.lastConforms,
    mode: SHACL_ENDPOINT ? 'active' : 'no-op (SHACL_ENDPOINT unset)',
    config: {
      IDENTITY_URL: !!IDENTITY_URL,
      RELAY_URL: !!RELAY_URL,
      POD_URL: !!POD_URL,
      AGENT_BEARER: !!AGENT_BEARER,
      SHACL_ENDPOINT: !!SHACL_ENDPOINT,
      SHAPES_URL: !!SHAPES_URL,
    },
  });
});

/**
 * POST /validate — manual validation trigger. Body: { descriptorUrl }.
 * Useful for testing without a live subscription, and for CI smoke tests.
 */
app.post('/validate', async (req, res) => {
  const { descriptorUrl } = (req.body ?? {}) as { descriptorUrl?: string };
  if (!descriptorUrl) {
    res.status(400).json({ error: 'descriptorUrl is required' });
    return;
  }
  const result = await validateAndPublish(descriptorUrl);
  res.json({ ok: true, eventsProcessed: state.eventsProcessed, result });
});

// ── Start ─────────────────────────────────────────────────────

app.listen(PORT, async () => {
  log(`Interego validator started on port ${PORT}`);
  log(`Agent: ${AGENT_ID}`);
  if (POD_URL) log(`Pod: ${POD_URL}`);
  if (RELAY_URL) log(`Relay: ${RELAY_URL}`);
  if (IDENTITY_URL) log(`Identity: ${IDENTITY_URL}`);
  if (SHACL_ENDPOINT) {
    log(`SHACL engine: ${SHACL_ENDPOINT}`);
  } else {
    log('SHACL_ENDPOINT not set — running in no-op mode (events recorded, nothing validated). See deploy/validator/README.md to bring your own SHACL engine.');
  }
  await loadShapes();
  if (AGENT_BEARER) {
    await registerSelf();
    await subscribeToPod();
  } else {
    log('AGENT_BEARER not set — registration + subscription skipped. /validate POST still works for manual testing.');
  }
});
