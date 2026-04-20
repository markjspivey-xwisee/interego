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
 *   3. On each event, fetches the newly-published descriptor Turtle,
 *      validates it against the bundled cg-shapes.ttl (plus any
 *      additional bundles configured at startup) using rdf-validate-shacl.
 *   4. Packages the validation report as a sh:ValidationReport inside a
 *      context graph, with prov:wasDerivedFrom pointing at BOTH the
 *      descriptor being validated AND the IPFS CID of the shape bundle
 *      (so historical findings remain verifiable against the exact
 *      ruleset that produced them — see LAYERS.md §4.1).
 *   5. Publishes the finding context graph back to the pod via the
 *      relay's publish_context endpoint.
 *
 * Status: SKELETON. The subscription loop + registration handshake +
 * report publishing are stubbed. Filling in rdf-validate-shacl
 * integration + report serialization is the first real PR. This file
 * stands up the process shape so the Azure deploy matrix can wire it
 * in and the validator can be iterated on from there.
 *
 * Environment:
 *   IDENTITY_URL   — identity server base URL (for /register-agent)
 *   RELAY_URL      — relay base URL (for /identity-token, /tool/publish_context)
 *   POD_URL        — target pod root (e.g. https://css.../u-pk-abc/)
 *   AGENT_ID       — self identity (e.g. urn:agent:validator:core-1.0:markj)
 *   AGENT_BEARER   — pre-issued identity bearer (for now; OAuth later)
 *   PORT           — health-check server port (default 9090)
 */

import express from 'express';

const PORT = parseInt(process.env['PORT'] ?? '9090');
const IDENTITY_URL = (process.env['IDENTITY_URL'] ?? '').replace(/\/?$/, '');
const RELAY_URL = (process.env['RELAY_URL'] ?? '').replace(/\/?$/, '');
const POD_URL = (process.env['POD_URL'] ?? '').replace(/\/?$/, '/');
const AGENT_ID = process.env['AGENT_ID'] ?? 'urn:agent:validator:core-1.0:default';
const AGENT_BEARER = process.env['AGENT_BEARER'] ?? '';

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
}

const state: ValidatorState = {
  registeredAt: null,
  subscribedTo: null,
  eventsProcessed: 0,
  findingsPublished: 0,
  lastEventAt: null,
  lastError: null,
};

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

// ── Validation + finding publishing (skeleton) ────────────────

/**
 * Fetch the newly-published descriptor, run SHACL, publish a finding.
 * Skeleton — each step is commented. Real implementation would:
 *
 *   1. GET descriptorUrl with text/turtle Accept
 *   2. Parse with N3.js into a dataset
 *   3. Load cg-shapes.ttl from the library's ontology manifest
 *   4. rdf-validate-shacl: Validator(shapes).validate(dataset)
 *   5. Convert the sh:ValidationReport back to Turtle
 *   6. Wrap as a ContextDescriptor with:
 *        .describes(descriptorUrl)
 *        .delegatedBy(ownerWebId, AGENT_ID, { role: 'Validator' })
 *        .semiotic({ modalStatus: report.conforms ? 'Asserted' : 'Asserted',
 *                    groundTruth: report.conforms,
 *                    epistemicConfidence: 1.0 })
 *        .trust({ trustLevel: 'SelfAsserted', issuer: agentDid })
 *        .addFacet({ type: 'Provenance', wasDerivedFrom: [descriptorUrl, bundleCid] })
 *   7. POST <relay>/tool/publish_context with that descriptor
 */
async function validateAndPublish(descriptorUrl: string): Promise<void> {
  state.eventsProcessed++;
  state.lastEventAt = new Date().toISOString();
  log(`validateAndPublish: ${descriptorUrl} (stub — no SHACL engine wired yet)`);
  // TODO: wire rdf-validate-shacl; publish finding; bump findingsPublished.
}

// ── HTTP ──────────────────────────────────────────────────────

const app = express();
app.use(express.json());

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
    config: {
      IDENTITY_URL: !!IDENTITY_URL,
      RELAY_URL: !!RELAY_URL,
      POD_URL: !!POD_URL,
      AGENT_BEARER: !!AGENT_BEARER,
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
  await validateAndPublish(descriptorUrl);
  res.json({ ok: true, eventsProcessed: state.eventsProcessed });
});

// ── Start ─────────────────────────────────────────────────────

app.listen(PORT, async () => {
  log(`Interego validator started on port ${PORT}`);
  log(`Agent: ${AGENT_ID}`);
  if (POD_URL) log(`Pod: ${POD_URL}`);
  if (RELAY_URL) log(`Relay: ${RELAY_URL}`);
  if (IDENTITY_URL) log(`Identity: ${IDENTITY_URL}`);
  if (AGENT_BEARER) {
    await registerSelf();
    await subscribeToPod();
  } else {
    log('AGENT_BEARER not set — registration + subscription skipped. /validate POST still works for manual testing.');
  }
});
