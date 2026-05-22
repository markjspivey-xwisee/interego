/**
 * Local smoke for channel transport — actually sending delivered content.
 *
 *   npx tsx tools/content-transport-smoke.ts
 *
 * Verifies the webhook transport against a real in-process HTTP sink (a
 * genuine POST — the same code path that hits a Slack incoming webhook
 * or an email/SMS provider API): the rendered body and the configured
 * Authorization header arrive at the endpoint. Also verifies the honest
 * `none` path — an unconfigured channel is rendered and recorded, not
 * sent. The pod-descriptor transport (an Interego-native publish) needs
 * a live pod and is verified by the production demo. Exits non-zero on
 * any failure.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import { attachContentDeliveryRoutes } from '../src/content-delivery.js';

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};

async function run(): Promise<void> {
  console.log('Channel transport — webhook send + honest no-op');

  // The webhook sink — a real HTTP endpoint the transport POSTs to.
  const received: Array<{ auth: unknown; body: Record<string, unknown> }> = [];
  const sink = express();
  sink.use(express.json());
  sink.post('/hook', (req, res) => {
    received.push({ auth: req.headers['authorization'], body: (req.body ?? {}) as Record<string, unknown> });
    res.json({ ok: true });
  });
  const sinkServer = sink.listen(0);
  await new Promise<void>(r => sinkServer.once('listening', () => r()));
  const sinkUrl = `http://localhost:${(sinkServer.address() as AddressInfo).port}/hook`;

  // The delivery app — a webhook wired for `chat`, nothing for `email`.
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  attachContentDeliveryRoutes(app, {
    selfBaseUrl: 'http://localhost',
    authoritativeSource: 'did:web:test',
    transport: { webhooks: { chat: { url: sinkUrl, authHeader: 'Bearer test-key' } } },
  });
  const server = app.listen(0);
  await new Promise<void>(r => server.once('listening', () => r()));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: await r.json() as Record<string, unknown> };
  };

  try {
    const aid = await post('/content/job-aid', {
      competencyPoint: 'refund thresholds', triggerContext: 'opening a refund over $500',
      body: 'Over $500 → route the dispute to a lead; the rep handles $500 or less directly.',
    });
    check('a job aid is published', aid.status === 200 && typeof aid.json.id === 'string');
    const jobAidId = aid.json.id as string;

    // ── chat → a configured webhook: a real HTTP send ───────────────
    const chat = await post('/content/deliver', { jobAidId, channel: 'chat', learner: 'did:web:acme#rep-sam' });
    const chatT = (chat.json.transport ?? {}) as Record<string, unknown>;
    check('the chat delivery used the webhook transport, and it sent',
      chatT.mode === 'webhook' && chatT.sent === true, chatT);
    check('the webhook sink received exactly one real HTTP POST', received.length === 1, received.length);
    check('the webhook received the rendered chat body (Slack-shape { text })',
      typeof received[0]?.body.text === 'string' && (received[0].body.text as string).includes('refund'),
      received[0]?.body);
    check('the webhook received the configured Authorization header',
      received[0]?.auth === 'Bearer test-key', received[0]?.auth);
    check('the transport result carries the endpoint as its artifact', chatT.artifactUrl === sinkUrl, chatT.artifactUrl);

    // ── email → no webhook, no pod: an honest recorded-only no-op ────
    const email = await post('/content/deliver', { jobAidId, channel: 'email', learner: 'did:web:acme#rep-sam' });
    const emailT = (email.json.transport ?? {}) as Record<string, unknown>;
    check('an unconfigured channel honestly reports mode "none" (not sent)',
      emailT.mode === 'none' && emailT.sent === false, emailT);
    check('the unconfigured channel still produced a rendering',
      !!(email.json.rendering as Record<string, unknown> | undefined)?.body, email.json.rendering);
    check('the email channel did not POST to the chat webhook', received.length === 1, received.length);
  } finally {
    server.close();
    sinkServer.close();
  }
}

await run();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('\nChannel transport works: a configured channel genuinely POSTs to its');
console.log('webhook; an unconfigured one is rendered + recorded, honestly not sent.');
