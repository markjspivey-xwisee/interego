/**
 * The discovery surface every vertical inherits.
 *
 * ★ WHY. `GET /affordances` answered Turtle unconditionally. `Accept:
 * application/ld+json` and `?format=jsonld` were both ignored, so a JSON-LD client
 * asking correctly received Turtle labelled `text/turtle` and could only cope by
 * disregarding the Content-Type it had just asked about. Verified against production:
 *
 *   Accept: text/turtle          -> text/turtle
 *   Accept: application/ld+json  -> text/turtle
 *   Accept: application/json     -> text/turtle
 *   ?format=jsonld               -> text/turtle
 *
 * The relay's own /ns projection negotiates properly; the manifest route did not —
 * and this is the route an agent is told to walk to find out what a vertical can do.
 *
 * No RDF parser was ever needed for the fix: the manifest is GENERATED from the same
 * `Affordance` objects the entry point already projects to JSON-LD. It is a second
 * serializer over one source, not a format conversion. I had originally reported this
 * as blocked on a missing dependency, which was wrong.
 *
 * The projection is now shared between the two routes, so this file also pins that
 * they cannot drift: two copies is how an entry point and a manifest start disagreeing
 * about what a capability accepts, with no way for a caller to tell which one lied.
 *
 * BEHAVIOURAL — it boots the real mount and negotiates against it.
 *
 * Run: npx tsx applications/_shared/vertical-bridge/affordance-manifest.test.ts
 */
import { createVerticalBridge } from './index.js';
import { listenLoopback } from './listen-loopback.js';
import type { Affordance } from '../affordance-mcp/index.js';

let failures = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
  if (cond) { console.log(`  ok   ${name}`); return; }
  failures++; console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
};

/**
 * ★ The URL this bridge SAYS it lives at, which is not the one this test dials.
 *
 * These were one constant — `http://localhost:6099` — used as both the manifest's
 * `deploymentUrl` and the fetch target, which is what forced a FIXED port: the projected
 * `target` is asserted below, so the port had to be known before `createVerticalBridge`
 * was called, and therefore before anything had bound. `app.listen(6099)` then bound
 * `{ address: "::" }` — every interface — for the whole run.
 *
 * Splitting them is also the truer model: a deployed bridge's published identity is its
 * public URL, while the socket it is reached on is whatever the proxy in front of it dialled.
 * The manifest assertions below check the PUBLISHED identity; the requests go to loopback.
 */
const DEPLOYMENT_URL = 'https://manifest-test.example';

const affordances = [{
  action: 'urn:iep:action:demo:ping',
  toolName: 'demo.ping',
  title: 'Ping',
  description: 'Returns pong.',
  method: 'POST',
  targetTemplate: '{base}/demo/ping',
  inputs: [{ name: 'msg', type: 'string', required: true, description: 'What to echo.' }],
  outputs: { description: 'The echo.' },
}] as unknown as Affordance[];

const app = createVerticalBridge({
  verticalName: 'manifest-test',
  affordances,
  handlers: { 'demo.ping': async (a: Record<string, unknown>) => ({ pong: a.msg }) },
  deploymentUrl: DEPLOYMENT_URL,
});
// Loopback, ephemeral, unref'd, and closed with its connections destroyed — see
// ./listen-loopback.ts for the `::`-binding and never-completing-close defects this
// replaces. Both were live in this file.
const listener = await listenLoopback(app);

const get = async (path: string, accept?: string) => {
  const r = await fetch(listener.base + path, accept ? { headers: { Accept: accept } } : undefined);
  return { status: r.status, type: r.headers.get('content-type') ?? '', vary: r.headers.get('vary') ?? '', body: await r.text() };
};

console.log('\n/affordances: the manifest negotiates, and agrees with the entry point');

try {
  // ── Turtle stays the default ─────────────────────────────────────────────
  // Existing consumers send no Accept, or */*. They must keep getting Turtle.
  const dflt = await get('/affordances');
  check('no Accept still yields Turtle', /text\/turtle/.test(dflt.type), dflt.type);
  const ttl = await get('/affordances', 'text/turtle');
  check('Accept: text/turtle yields Turtle', /text\/turtle/.test(ttl.type), ttl.type);
  check('the Turtle body is a manifest', /hydra:|iep:/.test(ttl.body), ttl.body.slice(0, 60));

  // ── …and JSON-LD is actually available ───────────────────────────────────
  for (const [label, path, accept] of [
    ['Accept: application/ld+json', '/affordances', 'application/ld+json'],
    ['Accept: application/json', '/affordances', 'application/json'],
    ['?format=jsonld', '/affordances?format=jsonld', undefined],
  ] as const) {
    const r = await get(path, accept);
    check(`${label} yields JSON-LD`, /application\/ld\+json/.test(r.type), r.type);
  }

  const jsonld = JSON.parse((await get('/affordances', 'application/ld+json')).body);
  check('Vary: Accept is set so caches do not serve one representation for the other',
    /accept/i.test((await get('/affordances')).vary));
  check('the manifest is typed', Array.isArray(jsonld['@type']) && jsonld['@type'].includes('iep:AffordanceManifest'),
    JSON.stringify(jsonld['@type']));
  check('the manifest is self-identifying', typeof jsonld['@id'] === 'string' && jsonld['@id'].endsWith('/affordances'));

  // ── An affordance a client cannot invoke is not an affordance ────────────
  const one = jsonld.affordances?.[0];
  check('each affordance carries its input contract', !!one?.expects, JSON.stringify(one).slice(0, 100));
  check('…naming the required fields',
    Array.isArray(one?.expects?.required) && one.expects.required.includes('msg'),
    JSON.stringify(one?.expects));
  check('…and their descriptions', one?.expects?.properties?.msg?.description === 'What to echo.');
  check('the target is resolved, not a {base} template', one?.target === `${DEPLOYMENT_URL}/demo/ping`, String(one?.target));

  // ── The two surfaces must not drift ──────────────────────────────────────
  const entry = JSON.parse((await get('/', 'application/ld+json')).body);
  check('the entry point and the manifest project an affordance identically',
    JSON.stringify(entry.affordances?.[0]) === JSON.stringify(one),
    'a second copy of the projection is how they start disagreeing');
} finally {
  await listener.close();
}

if (failures > 0) { console.error(`\n${failures} assertion(s) failed\n`); process.exit(1); }
console.log('\nThe manifest serves what it was asked for, and says the same thing twice.\n');
