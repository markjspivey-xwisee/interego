/**
 * Local smoke for content forms — rendering content in any text form.
 *
 *   npx tsx tools/content-forms-smoke.ts
 *
 * The content is text, but text takes many forms. This checks each form
 * renders correctly (plain / markdown / static HTML hypertext / dynamic
 * interactive hypermedia), that `chooseForm` picks the form fitting the
 * situation, and that `POST /content/deliver` honours an explicit form.
 * No media is generated — every form is text. Exits non-zero on failure.
 */

import express from 'express';
import type { AddressInfo } from 'node:net';
import { renderInForm, chooseForm } from '../src/content-forms.js';
import type { ContentUnit } from '../src/content-channels.js';
import { attachContentDeliveryRoutes } from '../src/content-delivery.js';

let pass = 0, fail = 0;
const check = (label: string, cond: boolean, detail?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
};

const unit: ContentUnit = {
  title: 'Refund threshold job aid',
  kind: 'job-aid',
  competency: 'refund thresholds',
  blocks: [
    { label: 'The rule', text: 'A rep may authorise refunds up to $500; above that, route to a lead.' },
    { text: 'Up to what amount may a rep authorise a refund alone? ::: $500' },
  ],
  link: 'https://bridge.example/content/job-aid/aid-x',
};

// ── Each form renders correctly ─────────────────────────────────────

console.log('Content forms — render');
const plain = renderInForm(unit, 'plain');
check('plain → text/plain, no markup', plain.mediaType === 'text/plain' && !/[<>#]/.test(plain.body), plain.body.slice(0, 60));
check('plain carries the content', plain.body.includes('route to a lead'), plain.body);

const md = renderInForm(unit, 'markdown');
check('markdown → text/markdown with headings', md.mediaType === 'text/markdown' && md.body.includes('# Refund threshold job aid'), md.body.slice(0, 60));

const html = renderInForm(unit, 'html');
check('html → a static HTML page, no script (static hypertext)',
  html.mediaType === 'text/html' && html.body.includes('<!doctype html>')
  && html.body.includes('<section') && !html.body.includes('<script'), html.body.slice(0, 60));
check('html links the full version (hypertext)', html.body.includes('<a href="https://bridge.example'), true);

const inter = renderInForm(unit, 'interactive');
check('interactive → dynamic hypermedia: a self-contained HTML artifact with behaviour',
  inter.interactive === true && inter.mediaType === 'text/html'
  && inter.body.includes('<script') && inter.body.includes('<details'), inter.body.slice(0, 60));
check('interactive turns an assessment item into an inline self-check',
  inter.body.includes('<input') && inter.body.includes('Check') && inter.body.includes("chk("), true);

// ── chooseForm picks the form for the situation ─────────────────────

console.log('\nContent forms — chooseForm');
check('sms → plain (length-bounded, no markup)', chooseForm({ channel: 'sms' }) === 'plain');
check('chat → markdown', chooseForm({ channel: 'chat' }) === 'markdown');
check('email → html', chooseForm({ channel: 'email' }) === 'html');
check('a document job-aid → interactive (the situation calls for it)',
  chooseForm({ channel: 'document', kind: 'job-aid' }) === 'interactive');
check('a document reference → markdown (portable, no interactivity needed)',
  chooseForm({ channel: 'document', kind: 'reference' }) === 'markdown');
check('an agent audience → markdown — structured text to ingest, not hypermedia',
  chooseForm({ channel: 'document', kind: 'job-aid', audience: 'agent' }) === 'markdown');

// ── POST /content/deliver honours an explicit form ──────────────────

async function testRoute(): Promise<void> {
  console.log('\nContent forms — POST /content/deliver honours `form`');
  const app = express();
  app.use(express.json({ limit: '20mb' }));
  attachContentDeliveryRoutes(app, { selfBaseUrl: 'http://localhost', authoritativeSource: 'did:web:test' });
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
      competencyPoint: 'refund thresholds', triggerContext: 'a refund over $500',
      body: 'Over $500 → route to a lead.',
    });
    const jobAidId = aid.json.id as string;
    check('a job aid is published', aid.status === 200 && !!jobAidId);

    const explicit = await post('/content/deliver', { jobAidId, channel: 'document', form: 'interactive' });
    const er = (explicit.json.rendering ?? {}) as Record<string, unknown>;
    check('an explicit form is honoured — interactive HTML (collapsible hypermedia)',
      er.form === 'interactive' && er.mediaType === 'text/html'
      && typeof er.body === 'string' && (er.body as string).includes('<details'), er.form);

    const chosen = await post('/content/deliver', { jobAidId, channel: 'document' });
    const cr = (chosen.json.rendering ?? {}) as Record<string, unknown>;
    check('with no form, a document job-aid is chosen interactive for the situation',
      cr.form === 'interactive', cr.form);

    const asMd = await post('/content/deliver', { jobAidId, channel: 'document', form: 'markdown' });
    check('a caller can name a simpler form (markdown)',
      ((asMd.json.rendering ?? {}) as Record<string, unknown>).form === 'markdown', asMd.json.rendering);

    const sms = await post('/content/deliver', { jobAidId, channel: 'sms', form: 'interactive' });
    check('the SMS channel clamps to plain even if a richer form is asked',
      ((sms.json.rendering ?? {}) as Record<string, unknown>).form === 'plain', sms.json.rendering);
  } finally {
    server.close();
  }
}

await testRoute();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
console.log('\nContent forms work: the same content renders as plain text, markdown,');
console.log('static HTML hypertext, or dynamic interactive hypermedia — text in');
console.log('whatever form the situation calls for, no media generated.');
