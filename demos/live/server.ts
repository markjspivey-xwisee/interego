/**
 * Interego, live — a demo you run on your own machine and click through in your browser.
 *
 *   npx tsx demos/live/server.ts          then open http://localhost:4747
 *
 * Everything it does is a real call to the deployed services, made with real identities:
 *
 *   You            your own relay connection: you sign in with your passkey on the relay's page,
 *                  the token comes back to this process on a loopback redirect, and every action
 *                  in your name is the relay's `act` tool following a Foxxi affordance, signed by
 *                  your session agent — what a Claude connector does.
 *   Claude Code    the agent's own wallet (DEMO_AGENT_KEY_FILE) and pod; it writes a course with a
 *   agent          headless Claude and signs its authoring, publishing and one attempted forgery.
 *   Verifier       a fresh headless Claude that gets only the skill generated from Foxxi's
 *                  affordance declarations, and the bridge's MCP endpoint.
 *   Jev            TypeSafe's System One model (TYPESAFE_API_KEY), choosing among the courses.
 *   Foxxi bridge   https://foxxi-bridge.interego.xwisee.com: grades, issues, verifies; its own
 *                  cmi5 LMS and LTI 1.3 LMS launch courses for both learners in part three.
 *
 * Keys and tokens stay in this process. The page gets state and a ledger of every call.
 */
import express, { type Request, type Response } from 'express';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Hub } from './lib/ledger.js';
import { RelayAuth, RelayMcp, RELAY } from './lib/relay.js';
import { BRIDGE, callTool, getJson, signedRoute, walletSigner } from './lib/foxxi.js';
import { claudeBin, runClaudeAgent, type AgentEvent } from './lib/claude-agent.js';
import { authorCourse, courseFromForm, type AuthoredCourse } from './lib/author.js';
import { answerSection, takeaway, type DeliveredSection } from './lib/learner.js';
import { lessonForLearner, lessonOfAuPage, reportAu, scoreLesson, type AuScore } from './lib/au.js';
import { rankCourses, recommendNext, type RankableCourse, type RecordForRecommendation } from './lib/jev.js';
import { freshChapters, type ChapterId, type DemoState, type CastMember, type Service } from './lib/cast.js';
import { parseCourseCatalogProducts, FEDERATED_CATALOG_TYPE, type FederatedCourseCatalog } from '../../applications/foxxi-content-intelligence/src/course-catalog-product.js';
import { SAMPLE_COURSE } from '../../applications/foxxi-content-intelligence/src/sample-content.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const PORT = Number(process.env['DEMO_PORT'] ?? 4747);
const ORIGIN = `http://localhost:${PORT}`;
const GATE = (process.env['INTEREGO_GATE'] ?? 'https://gate.interego.xwisee.com').replace(/\/$/, '');
const IDENTITY = 'https://identity.interego.xwisee.com';
const TENANT_POD = process.env['FOXXI_TENANT_POD'] ?? `${GATE}/foxxi/`;
const AGENT_KEY_FILE = process.env['DEMO_AGENT_KEY_FILE'] ?? 'D:/devstuff/harness/context-graphs/.interego/claude-code-agent.json';
const SKILL_DIR = join(ROOT, 'docs', 'skills', 'foxxi');
const ACTION = (verb: string): string => `${RELAY}/ns/iep/action/foxxi/${verb}`;

const hub = new Hub();
const auth = new RelayAuth(`${ORIGIN}/oauth/callback`, 'Interego Live Demo');
const relay = new RelayMcp(auth);
const agent = existsSync(AGENT_KEY_FILE) ? walletSigner(AGENT_KEY_FILE) : undefined;
const agentPod = agent ? `${GATE}/u-eth-${agent.address.slice(2, 14).toLowerCase()}/` : undefined;

/** A public, reachable spelling of a pod URL the relay may have written with its internal host. */
const publicPod = (u: string): string => u.replace(/^https?:\/\/css\.railway\.internal:\d+/, GATE);
const podOfSegment = (did: string): string | undefined => { const m = /(u-pk-[0-9a-f]{12}|u-eth-[0-9a-f]{12}|u-did-[0-9a-f]{12})/.exec(did); return m ? `${GATE}/${m[1]}/` : undefined; };

// ── What the page renders ─────────────────────────────────────────────────────────────────────

interface You { sessionDid: string; pod: string; userId: string; webId: string; personDid: string; authorized?: boolean; owner?: string; credentialUrl?: string }
let you: You | undefined;
const chapters = freshChapters();
const services: Record<string, Service> = {};
let bridgeBuild = '';

function cast(): CastMember[] {
  return [
    { id: 'you', name: 'You', initials: 'YOU', role: you ? 'signed in through your relay connection' : 'not signed in yet', ...(you ? { identity: you.personDid, identityHref: you.webId, pod: you.pod, status: you.authorized ? 'ok' : 'warn', statusText: you.authorized ? 'your session agent is authorized on your pod' : 'sign-in done; authorize the session agent' } : { status: '' }) },
    { id: 'claude', name: 'Claude Code agent', initials: 'CC', role: 'its own wallet and pod; writes with Claude', ...(agent ? { identity: agent.did, pod: agentPod, status: 'ok' } : { status: 'err', note: `No wallet at ${AGENT_KEY_FILE}; set DEMO_AGENT_KEY_FILE.` }) },
    { id: 'verifier', name: 'Verifier', initials: 'V', role: 'a fresh Claude that knows only the generated skill', identity: `Claude ${process.env['DEMO_AGENT_MODEL'] ?? 'sonnet'} · skill interego-foxxi`, status: services['claude']?.status === 'ok' ? 'ok' : 'warn' },
    { id: 'jev', name: 'Jev', initials: 'J', role: 'TypeSafe System One model', identity: process.env['JEV_MODEL'] ?? 'jev-latest', status: services['typesafe']?.status === 'ok' ? 'ok' : 'warn' },
    { id: 'bridge', name: 'Foxxi bridge', initials: 'FX', role: 'grades, issues, verifies', identity: BRIDGE.replace(/^https:\/\//, ''), identityHref: `${BRIDGE}/affordances`, status: services['foxxi']?.status === 'ok' ? 'ok' : 'warn', ...(bridgeBuild ? { note: `build ${bridgeBuild.slice(0, 8)}` } : {}) },
  ];
}

function state(): DemoState {
  return {
    services: Object.values(services),
    cast: cast(),
    facts: [
      { label: 'relay', value: RELAY.replace(/^https:\/\//, ''), href: `${RELAY}/.well-known/oauth-authorization-server` },
      { label: 'bridge', value: BRIDGE.replace(/^https:\/\//, ''), href: `${BRIDGE}/affordances` },
      { label: 'pods', value: GATE.replace(/^https:\/\//, '') },
      { label: 'skill', value: 'docs/skills/foxxi/SKILL.md' },
    ],
    chapters,
  };
}
const push = (): void => hub.emit('state', state());

function setChapter(id: ChapterId, patch: { status?: 'locked' | 'active' | 'done'; data?: Record<string, unknown>; replace?: boolean }): void {
  const c = chapters[id];
  if (patch.status) c.status = patch.status;
  if (patch.data) c.data = patch.replace ? patch.data : { ...c.data, ...patch.data };
  push();
}
const unlock = (id: ChapterId): void => { if (chapters[id].status === 'locked') setChapter(id, { status: 'active' }); };

// ── Services at start ─────────────────────────────────────────────────────────────────────────

async function probe(): Promise<void> {
  const check = async (id: string, label: string, fn: () => Promise<{ status: Service['status']; detail: string }>): Promise<void> => {
    services[id] = { id, label, status: 'busy', detail: 'checking' };
    push();
    try { services[id] = { id, label, ...(await fn()) }; } catch (e) { services[id] = { id, label, status: 'err', detail: (e as Error).message }; }
    push();
  };
  await Promise.all([
    check('relay', 'Relay', async () => { const r = await fetch(`${RELAY}/health`, { signal: AbortSignal.timeout(10_000) }); const j = await r.json() as { build?: string }; return { status: r.ok ? 'ok' : 'err', detail: `build ${String(j.build ?? '').slice(0, 8)}` }; }),
    check('foxxi', 'Foxxi bridge', async () => { const r = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(10_000) }); const j = await r.json() as { build?: string }; bridgeBuild = String(j.build ?? ''); return { status: r.ok ? 'ok' : 'err', detail: `build ${bridgeBuild.slice(0, 8)}` }; }),
    check('pods', 'Pods', async () => { const r = await fetch(`${GATE}/healthz`, { signal: AbortSignal.timeout(10_000) }); return { status: r.ok ? 'ok' : 'err', detail: GATE }; }),
    check('typesafe', 'Jev', async () => ({ status: process.env['TYPESAFE_API_KEY'] ? 'ok' : 'err', detail: process.env['TYPESAFE_API_KEY'] ? 'TYPESAFE_API_KEY is set' : 'set TYPESAFE_API_KEY to let Jev rank courses' })),
    check('claude', 'Claude CLI', async () => { const v = execFileSync(claudeBin(), ['--version'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 20_000 }).trim(); return { status: 'ok', detail: v }; }),
  ]);
}

// ── You: sign-in, identity, authorizing the session agent ──────────────────────────────────────

/** Who the relay says you are: its signing tool names your session agent and your pod. */
async function identify(): Promise<You> {
  const sig = await hub.track({ actor: 'you', service: 'relay', tool: 'sign_request', summary: 'asking the relay who this session acts as' }, async () => {
    const r = await relay.call('sign_request', { payload: { purpose: 'interego-live: identify this session' } });
    const env = r.json ?? {};
    const payload = JSON.parse(String(env['_signed_payload'] ?? '{}')) as { agent_id?: string; subject_pod_url?: string };
    return { value: { env, payload }, summary: `session agent ${payload.agent_id ?? '?'}`, response: { signed_as: env['signed_as'], anchor: env['anchor'], signatureAuthority: env['signatureAuthority'], payload } };
  });
  const sessionDid = String(sig.payload.agent_id ?? '');
  const pod = publicPod(String(sig.payload.subject_pod_url ?? podOfSegment(sessionDid) ?? ''));
  const userId = /\/(u-[a-z]+-[0-9a-f]{12})\/?$/.exec(pod)?.[1] ?? /(u-pk-[0-9a-f]{12}|u-eth-[0-9a-f]{12}|u-did-[0-9a-f]{12})/.exec(sessionDid)?.[1] ?? '';
  if (!sessionDid || !pod || !userId) throw new Error(`the relay did not say which session and pod this is: ${JSON.stringify(sig.payload).slice(0, 200)}`);
  return { sessionDid, pod: pod.endsWith('/') ? pod : `${pod}/`, userId, webId: `${IDENTITY}/users/${userId}/profile#me`, personDid: `did:web:identity.interego.xwisee.com:users:${userId}` };
}

async function afterSignIn(): Promise<void> {
  await hub.track({ actor: 'you', service: 'relay', tool: 'initialize', summary: 'opening an MCP session as you' }, async () => {
    const r = await relay.initialize();
    const info = r['serverInfo'] as { name?: string; version?: string } | undefined;
    return { value: r, summary: `MCP session open: ${info?.name ?? 'relay'} ${info?.version ?? ''}` };
  });
  you = await identify();
  const verified = await agentVerified(you.sessionDid);
  you.authorized = verified;
  setChapter('signin', { data: { signedIn: true, pod: you.pod, signer: you.sessionDid, surface: 'interego-live-demo', authorized: verified }, ...(verified ? { status: 'done' } : {}) });
  for (const id of ['discover', 'claim', 'teach', 'cmi5'] as ChapterId[]) unlock(id);
}

/**
 * Whether Foxxi will accept what your session signs: the relay's own check says the delegation
 * credential on your pod verifies and is anchored to the key the relay signs with — the two
 * conditions the bridge's delegated-caller check makes. The owner it names is you.
 */
async function agentVerified(sessionDid: string): Promise<boolean> {
  try {
    const r = await hub.track({ actor: 'you', service: 'relay', tool: 'verify_agent', summary: 'is your session agent delegated on your pod?' }, async () => {
      const v = await relay.call('verify_agent', { agent_id: sessionDid });
      const j = v.json ?? {};
      const signing = (j['signing'] ?? {}) as { canSignDelegatedRequests?: boolean | null; note?: string };
      const ok = j['valid'] === true && String(j['trustLevel'] ?? '') === 'CryptographicallyVerified' && signing.canSignDelegatedRequests !== false;
      if (ok && you && typeof j['owner'] === 'string') you.owner = String(j['owner']);
      return { value: ok, summary: ok ? `delegation verified; owner ${String(j['owner'] ?? '?')}` : `not yet: ${String(j['reason'] ?? signing.note ?? j['trustLevel'] ?? v.text).slice(0, 160)}`, response: j };
    });
    return r;
  } catch { return false; }
}

// ── Actions ───────────────────────────────────────────────────────────────────────────────────

type Handler = (body: Record<string, unknown>) => Promise<void>;

/** Your action on Foxxi, the connector way: the relay follows the affordance and signs as your session. */
async function youAct(verb: string, payload: Record<string, unknown>, summary: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return hub.track({ actor: 'you', service: 'relay → foxxi', tool: `act · ${verb}`, summary, request: { descriptor_url: `${BRIDGE}/affordances`, action_iri: ACTION(verb), payload, sign_payload: true } }, async () => {
    const r = await relay.call('act', { descriptor_url: `${BRIDGE}/affordances`, action_iri: ACTION(verb), payload, sign_payload: true });
    const j = r.json ?? {};
    // The relay reports the target's HTTP status beside its body; accept either wrapping.
    const status = Number(j['status'] ?? j['httpStatus'] ?? (r.isError ? 400 : 200));
    let body: unknown = j['body'] ?? j['response'] ?? j;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = { text: body }; } }
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const refused = status >= 400 || b['kind'] === 'refusal';
    return { value: { status, body: b }, status: refused ? (status >= 500 ? 'err' : 'refused') : 'ok', code: status, response: b, summary: refused ? String(b['error'] ?? b['iep:refusalReason'] ?? `HTTP ${status}`).slice(0, 240) : summary };
  });
}

const handlers: Record<string, Handler> = {
  async authorize() {
    if (!you) throw new Error('sign in first');
    const who = you;
    await hub.track({ actor: 'you', service: 'relay', tool: 'register_agent', summary: 'delegating this app\'s session agent on your pod, so Foxxi can verify what it signs', request: { agent_id: who.sessionDid, scope: 'PublishOnly' } }, async () => {
      const r = await relay.call('register_agent', { agent_id: who.sessionDid, scope: 'PublishOnly', label: 'Interego Live demo session' });
      const j = r.json ?? {};
      if (typeof j['credential'] === 'string') who.credentialUrl = publicPod(String(j['credential']));
      return { value: j, status: r.isError ? 'err' : 'ok', summary: r.isError ? r.text.slice(0, 200) : `delegation credential ${j['repaired'] ? 're-signed' : 'written'} on your pod, scope ${String(j['scope'] ?? 'PublishOnly')}`, response: j, links: who.credentialUrl ? [{ label: 'the credential', href: who.credentialUrl }] : [] };
    });
    who.authorized = await agentVerified(who.sessionDid);
    setChapter('signin', { data: { authorized: who.authorized, ...(who.credentialUrl ? { credentialUrl: who.credentialUrl } : {}) }, ...(who.authorized ? { status: 'done' } : {}) });
    if (!who.authorized) throw new Error('the relay wrote the delegation but Foxxi cannot verify it yet; try again in a moment');
  },

  async author(body) {
    if (!agent || !agentPod) throw new Error('no agent wallet');
    const topic = String(body['topic'] ?? '').trim() || 'why a credential should rest on evidence a third party graded';
    const courseId = `LIVE-${Date.now().toString(36).toUpperCase()}`;
    const transcript: { kind: string; text?: string }[] = [];
    setChapter('author', { data: { topic, writing: true, transcript, course: undefined, published: undefined, error: undefined } });
    const { course, costUsd } = await hub.track({ actor: 'claude', service: 'claude-cli', tool: 'write the course', summary: `writing a short course on “${topic}”` }, async () => {
      const r = await authorCourse(topic, courseId, (e: AgentEvent) => {
        if (e.kind === 'thinking' || e.kind === 'started') { transcript.push({ kind: e.kind === 'started' ? 'started' : 'thinking', text: e.text?.slice(0, 600) }); setChapter('author', { data: { transcript } }); }
      });
      return { value: r, summary: `${r.course.title}: ${r.course.scos.length} sections${r.costUsd !== undefined ? ` · $${r.costUsd.toFixed(3)}` : ''}` };
    });
    setChapter('author', { data: { writing: false, draft: publicCourse(course), costUsd } });
    // For testing the demo headlessly: the answers go to this process's console only, never to the page.
    if (process.env['DEMO_DEBUG']) console.log(`[demo] answers for ${course.courseId}: ${course.scos.map((s) => `${s.id}=${(s.assessment ?? []).map((q) => q.answer).join('|') || '-'}`).join(' ')}`);
    const authored = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'scorm-author-signed', summary: 'publishing it as a real SCORM 2004 course; the answers are hashed at authoring', request: { course: publicCourse(course) } }, async () => {
      const r = await signedRoute('/agent/scorm/author', { course }, agent);
      const refused = r.status >= 400;
      return { value: r, status: refused ? 'refused' : 'ok', code: r.status, response: r.json, summary: refused ? String(r.json['error'] ?? r.status) : `course ${course.courseId} authored by ${agent.did.slice(0, 22)}…`, links: typeof r.json['courseIri'] === 'string' ? [{ label: 'the course', href: String(r.json['courseIri']) }] : [] };
    });
    if (authored.status >= 400) throw new Error(String(authored.json['error'] ?? `authoring failed with HTTP ${authored.status}`));
    const meta = await getJson(`/agent/scorm/course/${encodeURIComponent(course.courseId)}?author_did=${encodeURIComponent(agent.did)}`);
    setChapter('author', { data: { course: meta.json, authoredResponse: authored.json } });
    await handlers['publish']!({});
  },

  async 'reset-author'() {
    setChapter('author', { status: 'active', replace: true, data: {} });
  },

  async publish() {
    if (!agent || !agentPod) throw new Error('no agent wallet');
    const r = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'foxxi.publish_course_catalog_product', summary: 'publishing its pod\'s catalog as a HyprCat FederatedCatalog', request: { tenant_pod_url: agentPod } }, async () => {
      const a = await callTool('foxxi.publish_course_catalog_product', { tenant_pod_url: agentPod }, agent);
      return { value: a, status: a.refused ? 'refused' : 'ok', code: a.httpStatus, response: a.answer, summary: a.refused ? a.refused.error : `${String(a.answer['products'] ?? 0)} course(s) as a data product`, links: [a.answer['descriptorUrl'], a.answer['graphUrl']].filter((x): x is string => typeof x === 'string').map((href, i) => ({ label: i ? 'catalog graph' : 'descriptor', href })) };
    });
    if (r.refused) { setChapter('author', { data: { publishError: r.refused.error } }); throw new Error(r.refused.error); }
    let turtle: string | undefined;
    if (typeof r.answer['graphUrl'] === 'string') { try { turtle = await (await fetch(String(r.answer['graphUrl']), { headers: { accept: 'text/turtle, application/trig' } })).text(); } catch { turtle = undefined; } }
    setChapter('author', { status: 'done', data: { published: { ...r.answer, ...(turtle ? { turtle } : {}) }, publishError: undefined } });
    unlock('forgery');
    unlockLti();
  },

  async discover() {
    if (!you) throw new Error('sign in first: the walk goes through your connection');
    const pods = [...new Set([TENANT_POD, agentPod, you.pod].filter((p): p is string => !!p))];
    const labels: Record<string, string> = { [TENANT_POD]: 'Foxxi tenant', ...(agentPod ? { [agentPod]: 'Claude Code agent' } : {}), [you.pod]: 'you' };
    const found: (FederatedCourseCatalog & { pod: string; podLabel: string; descriptorUrl: string; attributedTo?: string; issuerMatches: boolean | null })[] = [];
    const summary: { pod: string; label: string; entries: number; catalogs: number; unreachable?: boolean }[] = [];
    setChapter('discover', { data: { walking: true, pods: pods.map((p) => ({ pod: p, label: labels[p], entries: 0, catalogs: 0 })) } });
    for (const pod of pods) {
      try {
        const entries = await hub.track({ actor: 'you', service: 'relay', tool: 'discover_context', summary: `reading the manifest of ${labels[pod] ?? pod}`, request: { pod_url: pod, sort: 'newest-first', limit: 2000 } }, async () => {
          const r = await relay.call('discover_context', { pod_url: pod, sort: 'newest-first', limit: 2000 });
          const list = listEntries(r.json ?? parseLoose(r.text));
          return { value: list, summary: `${list.length} descriptors; ${list.filter((e) => e.conformsTo.includes(FEDERATED_CATALOG_TYPE)).length} typed hyprcat:FederatedCatalog`, response: { entries: list.length, sample: list.slice(0, 3) } };
        });
        let catalogs = 0;
        for (const e of entries.filter((x) => x.conformsTo.includes(FEDERATED_CATALOG_TYPE))) {
          const got = await hub.track({ actor: 'you', service: 'relay', tool: 'get_descriptor', summary: 'reading the catalog graph', request: { url: e.descriptorUrl } }, async () => {
            const r = await relay.call('get_descriptor', { url: e.descriptorUrl });
            const t = graphText(r.json, r.text);
            // Who the descriptor says published it: the catalog's own issuer has to be the same identity.
            const attributed = /prov:wasAttributedTo\s+<([^>]+)>/.exec(String(r.json?.['turtle'] ?? ''))?.[1];
            return { value: { turtle: t, attributed }, summary: t ? `${t.length} bytes of Turtle${attributed ? `, attributed to ${attributed}` : ''}` : 'no graph in the answer', response: { bytes: t?.length ?? 0, ...(attributed ? { attributedTo: attributed } : {}) } };
          });
          const attributedTo = e.issuer ?? got.attributed;
          for (const c of parseCourseCatalogProducts(got.turtle ?? '')) {
            catalogs += 1;
            found.push({ ...c, pod, podLabel: labels[pod] ?? pod, descriptorUrl: publicPod(e.descriptorUrl), ...(attributedTo ? { attributedTo } : {}), issuerMatches: attributedTo && c.issuedBy ? sameIdentity(attributedTo, c.issuedBy) : null });
          }
        }
        summary.push({ pod, label: labels[pod] ?? pod, entries: entries.length, catalogs });
      } catch {
        summary.push({ pod, label: labels[pod] ?? pod, entries: 0, catalogs: 0, unreachable: true });
      }
      setChapter('discover', { data: { pods: summary } });
    }
    setChapter('discover', { data: { walking: false, catalogs: found, pods: summary, ranking: undefined } });
  },

  async rank(body) {
    const d = chapters.discover.data as { catalogs?: FederatedCourseCatalog[] };
    const products = (d.catalogs ?? []).flatMap((c) => c.products.map((p) => ({ key: p.courseId ?? p.iri, title: p.title ?? p.courseId ?? p.iri, ...(p.description ? { description: p.description } : {}), ...(p.category ? { category: p.category } : {}), provider: (c as { podLabel?: string }).podLabel ?? c.issuedBy ?? '' })));
    if (products.length === 0) throw new Error('walk the pods first; there is nothing to rank yet');
    const goal = String(body['goal'] ?? '').trim() || 'why a credential should rest on evidence a third party graded';
    const ranking = await hub.track({ actor: 'jev', service: 'typesafe', tool: 'systemone · choice', summary: `which course teaches: “${goal}”`, request: { goal, courses: products } }, async () => {
      const r = await rankCourses(goal, products);
      return { value: r, summary: `${r.options[0]?.title ?? '?'} at ${Math.round((r.options[0]?.p ?? 0) * 100)}%, ${r.latencyMs} ms`, response: r };
    });
    setChapter('discover', { data: { ranking }, status: 'done' });
  },

  async pick(body) {
    const courseId = String(body['courseId'] ?? '');
    const d = chapters.discover.data as { catalogs?: FederatedCourseCatalog[] };
    const product = (d.catalogs ?? []).flatMap((c) => c.products).find((p) => p.courseId === courseId);
    const authorDid = (d.catalogs ?? []).find((c) => c.products.some((p) => p.courseId === courseId))?.issuedBy;
    const meta = await getJson(`/agent/scorm/course/${encodeURIComponent(courseId)}${authorDid?.startsWith('did:') ? `?author_did=${encodeURIComponent(authorDid)}` : ''}`);
    if (meta.status >= 400) throw new Error(String(meta.json['error'] ?? `the course ${courseId} is not playable on the bridge`));
    setChapter('learn', { status: 'active', replace: true, data: { course: meta.json, product, authorDid } });
  },

  async launch() {
    const d = chapters.learn.data as { course?: { courseId?: string; authoredBy?: string } };
    if (!d.course?.courseId) throw new Error('choose a course first');
    const r = await youAct('scorm-launch-signed', { course_id: d.course.courseId, ...(d.course.authoredBy ? { author_did: d.course.authoredBy } : {}) }, 'starting an attempt on the SCORM engine');
    if (r.status >= 400) { setChapter('learn', { data: { error: String(r.body['error'] ?? r.status), refused: r.status < 500 } }); return; }
    setChapter('learn', { data: { sessionId: r.body['sessionId'], sco: r.body['sco'], result: undefined, lastGraded: undefined, error: undefined } });
  },

  async submit(body) {
    const d = chapters.learn.data as { sessionId?: string; statements?: unknown[] };
    if (!d.sessionId) throw new Error('start the course first');
    const answers = Array.isArray(body['answers']) ? (body['answers'] as unknown[]).map((a) => String(a)) : [];
    const r = await youAct('scorm-submit-signed', { session_id: d.sessionId, ...(answers.length ? { answers } : {}) }, answers.length ? `submitting ${answers.length} answer(s) to the engine` : 'continuing');
    if (r.status >= 400) { setChapter('learn', { data: { error: String(r.body['error'] ?? r.status), refused: r.status < 500 } }); return; }
    const graded = r.body['graded'] as { correct?: number; total?: number; passed?: boolean } | undefined;
    if (r.body['done']) {
      setChapter('learn', { status: r.body['passed'] ? 'done' : 'active', data: { result: r.body, sco: undefined, sessionId: undefined, ...(graded ? { lastGraded: graded } : {}), error: undefined } });
      if (r.body['passed']) unlock('claim');
      return;
    }
    setChapter('learn', { data: { sco: r.body['sco'], ...(graded ? { lastGraded: graded } : {}), error: undefined } });
  },

  async standings() {
    const learn = chapters.learn.data as { course?: { courseId?: string } };
    const r = await youAct('earned-credentials-signed', { ...(learn.course?.courseId ? { course_ids: [learn.course.courseId] } : {}) }, 'reading your record and your wallet');
    if (r.status >= 400) { setChapter('claim', { data: { error: String(r.body['error'] ?? r.status), refused: r.status < 500 } }); return; }
    setChapter('claim', { data: { standings: r.body['standings'], learner: r.body['learner'], error: undefined } });
  },

  async claim(body) {
    const courseId = String(body['courseId'] ?? '');
    const r = await youAct('claim-credential-signed', { course_id: courseId }, 'asking the tenant to sign what your record earned');
    if (r.status >= 400) { setChapter('claim', { data: { error: String(r.body['error'] ?? r.status), refused: r.status < 500 } }); return; }
    if (r.body['decision'] === 'already-held') { setChapter('claim', { status: 'done', data: { alreadyHeld: r.body['credential'], error: undefined } }); unlock('verify'); return; }
    setChapter('claim', { status: 'done', data: { credential: r.body, error: undefined } });
    unlock('verify');
    await handlers['standings']!({});
  },

  async verify(body) {
    const claim = chapters.claim.data as { credential?: { vc?: Record<string, unknown>; descriptorUrl?: string }; alreadyHeld?: { descriptorUrl?: string } };
    const link = claim.credential?.descriptorUrl ?? claim.alreadyHeld?.descriptorUrl;
    let vc = claim.credential?.vc;
    if (!vc && link) vc = await readWalletCredential(String(link));
    if (!vc || !link) throw new Error('claim a credential first');
    const tamper = body['tamper'] === true;
    const handed = tamper ? tampered(vc) : undefined;
    const skillText = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const transcript: { kind: string; text?: string; detail?: unknown }[] = [];
    setChapter('verify', { replace: true, data: { running: true, tampered: tamper, link, transcript, skill: { name: 'interego-foxxi', bytes: Buffer.byteLength(skillText), text: skillText } } });
    // The honest way to hand over a credential is its link: the verifier reads the bytes the issuer
    // signed from the holder's wallet. A tampered copy has no link, so it goes over as JSON, and the
    // page then shows exactly what the agent checked against the original.
    const ask = 'Before I rely on it, check it properly. Then tell me in two or three sentences whether I can rely on it and why, naming each check you made.';
    const prompt = handed
      ? `Someone sent me this Open Badges credential, issued by a Foxxi tenant on Interego, and asked me to accept it as proof they completed the course. ${ask}\n\n${JSON.stringify(handed, null, 2)}`
      : `Someone sent me a link to their Open Badges credential, issued by a Foxxi tenant on Interego, and asked me to accept it as proof they completed the course: ${link}\n\n${ask}`;
    const run = await hub.track({ actor: 'verifier', service: 'claude-cli', tool: 'a fresh agent, one skill', summary: tamper ? 'verifying a copy with one field changed' : 'verifying your credential' }, async () => {
      const out = await runClaudeAgent({
        prompt,
        mcpServers: { foxxi: { type: 'http', url: `${BRIDGE}/mcp` } },
        skills: [{ name: 'interego-foxxi', dir: SKILL_DIR }],
        maxTurns: 10,
        onEvent: (e) => { transcript.push({ kind: e.kind, ...(e.text ? { text: e.text.slice(0, 1400) } : {}), ...(e.detail !== undefined && e.kind !== 'done' ? { detail: e.detail } : {}) }); setChapter('verify', { data: { transcript } }); },
      });
      return { value: out, summary: `${out.toolUses.map((u) => u.name.replace(/^mcp__foxxi__/, '')).join(' → ') || 'no tools'}${out.costUsd !== undefined ? ` · $${out.costUsd.toFixed(3)}` : ''}`, status: out.exitCode === 0 ? 'ok' : 'err' };
    });
    const verifyUse = [...run.toolUses].reverse().find((u) => /verify_credential/.test(u.name) && u.output);
    let checks: Record<string, boolean> | undefined;
    let valid: boolean | undefined;
    let readFrom: string | undefined;
    if (verifyUse?.output) { try { const j = JSON.parse(verifyUse.output) as { checks?: Record<string, boolean>; valid?: boolean; readFrom?: string }; checks = j.checks; valid = j.valid; readFrom = j.readFrom; } catch { /* not JSON */ } }
    // What the agent actually put in front of the verifier, against the credential the holder has.
    const sent = (verifyUse?.input as { credential?: unknown } | undefined)?.credential;
    const differences = sent && typeof sent === 'object' ? diffJson(vc, sent, 'credential') : undefined;
    setChapter('verify', { status: 'done', data: { running: false, verdict: run.result, ...(checks ? { checks } : {}), ...(valid !== undefined ? { valid } : {}), ...(readFrom ? { readFrom } : {}), ...(differences ? { differences } : {}), toolsUsed: run.toolUses.map((u) => u.name), costUsd: run.costUsd } });
  },

  async forgery() {
    if (!agent || !agentPod) throw new Error('no agent wallet');
    // The agent's own course: the one it wrote in this session, or the one you took if it wrote that.
    type Course = { courseId?: string; courseIri?: string; title?: string; authoredBy?: string };
    const written = (chapters.author.data as { course?: Course }).course;
    const taken = (chapters.learn.data as { course?: Course }).course;
    const course = written?.courseId ? written : taken?.authoredBy && sameIdentity(taken.authoredBy, agent.did) ? taken : undefined;
    if (!course?.courseId) throw new Error('let the agent write its course first');
    const statement = {
      id: randomUUID(), version: '2.0.0',
      // The bridge names a DIRECT caller by its checksummed address, and a self-written statement's
      // actor must be exactly that; lower case would be refused as someone else's statement.
      actor: { objectType: 'Agent', account: { homePage: BRIDGE, name: `did:ethr:${agent.address}` } },
      verb: { id: 'http://adlnet.gov/expapi/verbs/passed', display: { en: 'passed' } },
      object: { objectType: 'Activity', id: String(course.courseIri ?? `${BRIDGE}/agent/scorm/course/${course.courseId}`), definition: { name: { en: String(course.title ?? course.courseId) } } },
      result: { success: true, completion: true, score: { scaled: 1 } },
      timestamp: new Date().toISOString(),
    };
    setChapter('forgery', { replace: true, data: { attempted: true, statement } });
    await hub.track({ actor: 'claude', service: 'foxxi', tool: 'xapi-statements/write', summary: 'writing its own “passed” into its own record', request: { statements: [statement] } }, async () => {
      const r = await signedRoute('/agent/xapi-statements/write', { statements: [statement] }, agent);
      return { value: r, status: r.status >= 400 ? 'refused' : 'ok', code: r.status, response: r.json, summary: r.status >= 400 ? String(r.json['error'] ?? r.status) : 'accepted: the record is its own to write' };
    });
    const claim = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'claim-credential-signed', summary: 'asking for the credential on the strength of it', request: { course_id: course.courseId } }, async () => {
      const r = await signedRoute('/agent/credentials/claim', { course_id: course.courseId }, agent);
      return { value: r, status: r.status >= 400 ? 'refused' : 'ok', code: r.status, response: r.json, summary: r.status >= 400 ? String(r.json['error'] ?? r.status) : 'issued' };
    });
    setChapter('forgery', { status: 'done', data: claim.status >= 400 ? { refusal: { status: claim.status, error: String(claim.json['error'] ?? '') } } : { issued: claim.json } });
  },

  // ── Part two: two learners, one record standard ─────────────────────────────────────────────

  async 'draft-course'(body) {
    if (!you) throw new Error('sign in first: the course is published as yours');
    const topic = String(body['topic'] ?? '').trim() || 'how to tell an agent\'s claim from its evidence';
    const transcript: { kind: string; text?: string }[] = [];
    setChapter('teach', { data: { drafting: true, transcript, draft: undefined, error: undefined } });
    const { course, costUsd } = await hub.track({ actor: 'claude', service: 'claude-cli', tool: 'draft a course for you', summary: `drafting a course on “${topic}” for you to edit` }, async () => {
      const r = await authorCourse(topic, `YOU-${Date.now().toString(36).toUpperCase()}`, (e: AgentEvent) => {
        if (e.kind === 'thinking' || e.kind === 'started') { transcript.push({ kind: e.kind, text: e.text?.slice(0, 600) }); setChapter('teach', { data: { transcript } }); }
      });
      return { value: r, summary: `${r.course.title}: ${r.course.scos.length} sections, yours to edit${r.costUsd !== undefined ? ` · $${r.costUsd.toFixed(3)}` : ''}` };
    });
    // Your draft: the answers are yours to see and change, so they go to the page. Nothing is published yet.
    setChapter('teach', { data: { drafting: false, draft: course, ...(costUsd !== undefined ? { draftCostUsd: costUsd } : {}) } });
  },

  async 'publish-course'(body) {
    if (!you) throw new Error('sign in first: the course is published as yours');
    const course = courseFromForm(body['course'], `YOU-${Date.now().toString(36).toUpperCase()}`);
    const r = await youAct('scorm-author-signed', { course }, 'publishing your course on the SCORM engine, signed as you; the answers are hashed there');
    if (r.status >= 400) { setChapter('teach', { data: { error: String(r.body['error'] ?? r.status), refused: r.status < 500 } }); return; }
    const authorDid = String(r.body['authoredBy'] ?? you.sessionDid);
    const meta = await getJson(`/agent/scorm/course/${encodeURIComponent(course.courseId)}?author_did=${encodeURIComponent(authorDid)}`);
    setChapter('teach', { status: 'done', data: { published: { ...meta.json, authorDid }, error: undefined } });
    unlock('agentLearns');
    unlockLti();
  },

  async 'agent-learn'() {
    if (!agent) throw new Error('no agent wallet');
    const pub = (chapters.teach.data as { published?: { courseId?: string; title?: string; authorDid?: string } }).published;
    if (!pub?.courseId) throw new Error('publish your course first');
    const sections: { id: string; title: string; questions: string[]; answers?: string[]; graded?: unknown }[] = [];
    const transcript: { kind: string; section: string; text?: string }[] = [];
    setChapter('agentLearns', { replace: true, data: { running: true, course: pub, sections, transcript } });
    const launched = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'scorm-launch-signed', summary: `the agent starts your course “${pub.title}” with its own wallet`, request: { course_id: pub.courseId, author_did: pub.authorDid } }, async () => {
      const r = await signedRoute('/agent/scorm/launch', { course_id: pub.courseId, ...(pub.authorDid ? { author_did: pub.authorDid } : {}) }, agent);
      return { value: r, status: r.status >= 400 ? 'refused' : 'ok', code: r.status, response: r.json, summary: r.status >= 400 ? String(r.json['error'] ?? r.status) : 'an attempt started on the engine' };
    });
    if (launched.status >= 400) throw new Error(String(launched.json['error'] ?? `launch failed with HTTP ${launched.status}`));
    const sessionId = String(launched.json['sessionId'] ?? '');
    let sco = launched.json['sco'] as DeliveredSection | undefined;
    let result: Record<string, unknown> | undefined;
    for (let step = 0; step < 12 && sco && !result; step++) {
      const section: DeliveredSection = sco;
      const entry: (typeof sections)[number] = { id: section.id, title: section.title, questions: (section.assessment ?? []).map((q) => q.question) };
      sections.push(entry);
      setChapter('agentLearns', { data: { sections } });
      let answers: string[] = [];
      if (section.assessment?.length) {
        const read = await hub.track({ actor: 'claude', service: 'claude-cli', tool: 'read and answer', summary: `the agent reads section ${section.id} and answers ${section.assessment.length} question(s)` }, async () => {
          const a = await answerSection(section, (e: AgentEvent) => {
            if (e.kind === 'thinking' && e.text) { transcript.push({ kind: 'thinking', section: section.id, text: e.text.slice(0, 500) }); setChapter('agentLearns', { data: { transcript } }); }
          });
          return { value: a, summary: `answered ${a.answers.map((x) => `“${x}”`).join(', ')}${a.costUsd !== undefined ? ` · $${a.costUsd.toFixed(3)}` : ''}` };
        });
        answers = read.answers;
        entry.answers = answers;
      }
      const sent = answers;
      const submitted = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'scorm-submit-signed', summary: sent.length ? `submitting ${sent.length} answer(s) to the engine` : 'continuing', request: { session_id: sessionId, ...(sent.length ? { answers: sent } : {}) } }, async () => {
        const r = await signedRoute('/agent/scorm/submit', { session_id: sessionId, ...(sent.length ? { answers: sent } : {}) }, agent);
        const g = r.json['graded'] as { correct?: number; total?: number } | undefined;
        return { value: r, status: r.status >= 400 ? 'refused' : 'ok', code: r.status, response: r.json, summary: r.status >= 400 ? String(r.json['error'] ?? r.status) : g ? `${g.correct} of ${g.total} correct` : 'next section' };
      });
      if (submitted.status >= 400) throw new Error(String(submitted.json['error'] ?? `submit failed with HTTP ${submitted.status}`));
      if (submitted.json['graded']) entry.graded = submitted.json['graded'];
      if (submitted.json['done']) result = submitted.json;
      else sco = submitted.json['sco'] as DeliveredSection | undefined;
      setChapter('agentLearns', { data: { sections } });
    }
    setChapter('agentLearns', { data: { running: false, result } });
    if (!result?.['passed']) return;
    await handlers['agent-claim']!({});
  },

  /** The agent claims its credential for your course. A refusal leaves the chapter open to claim again. */
  async 'agent-claim'() {
    if (!agent) throw new Error('no agent wallet');
    const d = chapters.agentLearns.data as { result?: { passed?: unknown }; course?: { courseId?: string } };
    const pub = (chapters.teach.data as { published?: { courseId?: string } }).published;
    if (d.result?.passed !== true || !pub?.courseId) throw new Error('the agent claims a credential only for a course it has passed');
    const courseId = pub.courseId;
    const claim = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'claim-credential-signed', summary: 'the agent claims what its own record earned', request: { course_id: courseId } }, async () => {
      const r = await signedRoute('/agent/credentials/claim', { course_id: courseId }, agent);
      return { value: r, status: r.status >= 400 ? 'refused' : 'ok', code: r.status, response: r.json, summary: r.status >= 400 ? String(r.json['error'] ?? r.status) : `${String(r.json['decision'] ?? 'issued')}: a credential in the agent's own wallet` };
    });
    if (claim.status >= 400) { setChapter('agentLearns', { data: { claimError: String(claim.json['error'] ?? claim.status) } }); return; }
    setChapter('agentLearns', { status: 'done', data: { credential: claim.json, claimError: undefined } });
    unlock('work');
  },

  async 'record-work'(body) {
    const who = body['who'] === 'agent' ? 'agent' : 'you';
    if (who === 'you') {
      if (!you) throw new Error('sign in first');
      const pub = (chapters.teach.data as { published?: { courseIri?: string; title?: string } }).published;
      if (!pub?.courseIri) throw new Error('publish your course first: it is the evidence of your work');
      // Teaching succeeded only if the learner passed: a course that was merely published taught nobody.
      const learned = (chapters.agentLearns.data as { result?: { passed?: unknown; score?: unknown } }).result;
      if (learned?.passed !== true) throw new Error('your teaching is recorded once the agent has passed your course (chapter 9)');
      const score = learned.score;
      const payload = { task_name: `Taught “${pub.title}” to an AI agent`, task_id: pub.courseIri, success: true, ...(typeof score === 'number' ? { quality: score } : {}), actor_kind: 'human', activity_type: TEACHING };
      const r = await youAct('record-performance-signed', payload, 'recording your work as a person, so your record stays private');
      setChapter('work', { data: { you: r.status >= 400 ? { error: String(r.body['error'] ?? r.status) } : { ...r.body, payload } } });
    } else {
      if (!agent) throw new Error('no agent wallet');
      const course = agentsCourse();
      if (!course?.courseIri) throw new Error('let the agent write the course you take in part one first: it is the evidence of its work');
      const learned = (chapters.learn.data as { result?: { passed?: unknown; score?: unknown } }).result;
      if (learned?.passed !== true) throw new Error('the agent\'s teaching is recorded once you have passed its course (chapter 4)');
      const score = learned.score;
      const payload = { task_name: `Taught “${course.title ?? course.courseId}” to a person`, task_id: course.courseIri, success: true, ...(typeof score === 'number' ? { quality: score } : {}), activity_type: TEACHING };
      const r = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'record-performance-signed', summary: 'the agent records its work as an agent, which makes its record public', request: payload }, async () => {
        const s = await signedRoute('/agent/record-performance', payload, agent);
        return { value: s, status: s.status >= 400 ? 'refused' : 'ok', code: s.status, response: s.json, summary: s.status >= 400 ? String(s.json['error'] ?? s.status) : `recorded as statement ${String(s.json['statementId'] ?? '').slice(0, 8)}…` };
      });
      setChapter('work', { data: { agent: r.status >= 400 ? { error: String(r.json['error'] ?? r.status) } : { ...r.json, payload } } });
    }
    const w = chapters.work.data as { you?: { recorded?: boolean }; agent?: { recorded?: boolean } };
    if (w.you?.recorded || w.agent?.recorded) unlock('records');
    if (w.you?.recorded && w.agent?.recorded) setChapter('work', { status: 'done' });
  },

  async 'review-records'() {
    if (!you || !agent) throw new Error('sign in first');
    const self = you;
    setChapter('records', { replace: true, status: 'active', data: { running: true } });
    const both = await readRecords();
    const youReadAgent = await youAct('review-record', { subject_did: agent.did }, 'you read the agent\'s record');
    const agentReadYou = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'review-record', summary: 'the agent tries to read your record', request: { subject_did: self.webId } }, async () => {
      const r = await signedRoute('/agent/review-record', { subject_did: self.webId }, agent);
      return { value: r, status: r.status >= 400 ? 'refused' : 'ok', code: r.status, response: r.json, summary: r.status >= 400 ? String(r.json['error'] ?? r.status) : 'read it' };
    });
    setChapter('records', { status: 'done', data: {
      running: false,
      you: both.you,
      agent: both.agent,
      cross: {
        youReadAgent: { status: youReadAgent.status, ...(youReadAgent.status >= 400 ? { error: String(youReadAgent.body['error'] ?? '') } : { subjectKind: recordView(youReadAgent.body, youReadAgent.status).subjectKind }) },
        agentReadYou: { status: agentReadYou.status, ...(agentReadYou.status >= 400 ? { error: String(agentReadYou.json['error'] ?? '') } : {}) },
      },
    } });
    unlock('next');
  },

  async recommend() {
    const recs = chapters.records.data as { you?: RecordView; agent?: RecordView };
    if (!recs.you?.summary || !recs.agent?.summary) throw new Error('assemble the two records first');
    const out: Record<string, unknown> = {};
    for (const [who, view] of [['you', recs.you], ['agent', recs.agent]] as const) {
      const courses = candidateCourses(who);
      out[`${who}Courses`] = courses.length;
      if (courses.length === 0) { out[who] = { none: 'Every course the demo knows of was written by this learner.' }; continue; }
      const record: RecordForRecommendation = {
        learner: who === 'you' ? 'a person' : 'an AI agent',
        competencies: (view.competencies ?? []).map((c) => ({ label: c.label, ...(c.level ? { level: c.level } : {}), ...(c.basis ? { basis: c.basis } : {}), ...(c.status ? { status: c.status } : {}) })),
        credentialsHeld: (view.credentials ?? []).filter((c) => c.verified).map((c) => c.name),
        experiences: Number(view.summary?.['experienceCount'] ?? 0),
        performances: Number(view.summary?.['performanceCount'] ?? 0),
      };
      out[who] = await hub.track({ actor: 'jev', service: 'typesafe', tool: 'systemone · choice', summary: `what ${who === 'you' ? 'you' : 'the agent'} should learn next, from the record alone`, request: { record, courses } }, async () => {
        const r = await recommendNext(record, courses);
        return { value: r, summary: `${r.options[0]?.title ?? '?'} at ${Math.round((r.options[0]?.p ?? 0) * 100)}%, ${r.latencyMs} ms`, response: r };
      });
    }
    setChapter('next', { status: 'done', data: out });
  },

  // ── Part three: the standards the rest of the learning world speaks ───────────────────────────

  async 'cmi5-launch'(body) {
    const who = body['who'] === 'agent' ? 'agent' : 'you';
    const course = await hub.track({ actor: 'bridge', service: 'foxxi', tool: 'cmi5 course', summary: 'finding the cmi5 course the bridge publishes of its own' }, async () => {
      const c = await cmi5Course();
      return { value: c, summary: `${c.title}: ${c.aus.length} activities`, response: c };
    });
    setChapter('cmi5', { data: { course, error: undefined } });
    if (who === 'you') {
      if (!you) throw new Error('sign in first: the launch is for you');
      const r = await youAct('cmi5-launch-signed', { course_id: course.id }, 'launching your next activity in the course, signed as you');
      if (r.status >= 400) throw new Error(String(r.body['error'] ?? `the launch answered ${r.status}`));
      const launch = launchOf(r.body);
      setChapter('cmi5', { data: { you: { ...launch, state: 'launched' } } });
      void watchRegistration('you', launch.registration).catch(() => undefined);
      return;
    }
    if (!agent) throw new Error('no agent wallet');
    const launched = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'cmi5-launch-signed', summary: 'the agent launches its next activity with its own wallet', request: { course_id: course.id } }, async () => {
      const r = await signedRoute('/agent/cmi5/launch', { course_id: course.id }, agent);
      return { value: r, status: r.status >= 400 ? 'refused' : 'ok', code: r.status, response: r.json, summary: r.status >= 400 ? String(r.json['error'] ?? r.status) : `“${String(r.json['auTitle'] ?? '')}”, moveOn ${String(r.json['moveOn'] ?? '')}, launch data staged` };
    });
    if (launched.status >= 400) throw new Error(String(launched.json['error'] ?? `the launch answered ${launched.status}`));
    const launch = launchOf(launched.json);
    const transcript: { kind: string; section: string; text?: string }[] = [];
    setChapter('cmi5', { data: { agent: { ...launch, state: 'reading', transcript } } });
    const lesson = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'open the activity', summary: 'the agent opens the activity page its launch URL names', request: { launchUrl: launch.launchUrl.split('?')[0] } }, async () => {
      const page = await (await fetch(launch.launchUrl)).text();
      const l = lessonOfAuPage(page);
      return { value: l, summary: `${l.title}: ${l.fragments.length} parts` };
    });
    const section = lessonForLearner(lesson);
    const onEvent = (e: AgentEvent): void => { if (e.kind === 'thinking' && e.text) { transcript.push({ kind: 'thinking', section: section.id, text: e.text.slice(0, 500) }); setChapter('cmi5', { data: { agent: { ...launch, state: 'reading', transcript } } }); } };
    let score: AuScore | null = null;
    let note: string | undefined;
    if (section.assessment?.length) {
      const read = await hub.track({ actor: 'claude', service: 'claude-cli', tool: 'read and answer', summary: `the agent reads “${lesson.title}” and answers ${section.assessment.length} question(s)` }, async () => {
        const a = await answerSection(section, onEvent, 'phrase');
        return { value: a, summary: `answered ${a.answers.map((x) => `“${x}”`).join(', ')}${a.costUsd !== undefined ? ` · $${a.costUsd.toFixed(3)}` : ''}` };
      });
      score = scoreLesson(lesson, read.answers);
    } else {
      const read = await hub.track({ actor: 'claude', service: 'claude-cli', tool: 'read', summary: `the agent reads “${lesson.title}”` }, async () => {
        const t = await takeaway(section, onEvent);
        return { value: t, summary: `${t.text.slice(0, 160)}${t.costUsd !== undefined ? ` · $${t.costUsd.toFixed(3)}` : ''}` };
      });
      note = read.text;
    }
    const reported = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'cmi5 AU → LRS', summary: 'the activity trades its one-time URL for an auth-token and reports to the LRS', request: { registration: launch.registration } }, async () => {
      const r = await reportAu(launch.launchUrl, lesson, score);
      return { value: r, summary: `${r.sent.join(', ')}${score ? ` · scored itself ${Math.round(score.scaled * 100)}%` : ''}` };
    });
    setChapter('cmi5', { data: { agent: { ...launch, state: 'reported', transcript, sent: reported.sent, ...(score ? { score } : {}), ...(note ? { note } : {}) } } });
    await watchRegistration('agent', launch.registration, 60_000);
  },

  async 'lti-launch'(body) {
    const who = body['who'] === 'agent' ? 'agent' : 'you';
    if (who === 'you') {
      if (!you) throw new Error('sign in first: the LMS launches the course for you');
      const course = agentsCourse();
      if (!course?.courseId) throw new Error('let the agent write its course in part one first: that is the course your LMS launches for you');
      const r = await youAct('lti-launch-signed', { course_id: course.courseId }, `asking Foxxi's LMS to launch “${course.title ?? course.courseId}” for you`);
      if (r.status >= 400) throw new Error(String(r.body['error'] ?? `the launch answered ${r.status}`));
      setChapter('lti', { data: { error: undefined, you: { course, initiationUrl: String(r.body['initiationUrl'] ?? ''), expiresAt: r.body['expiresAt'], lineItem: r.body['lineItem'], resourceLink: r.body['resourceLink'], context: r.body['context'], platform: r.body['platform'], learner: r.body['learner'] } } });
      return;
    }
    if (!agent) throw new Error('no agent wallet');
    const pub = (chapters.teach.data as { published?: { courseId?: string; title?: string } }).published;
    if (!pub?.courseId) throw new Error('publish your course in chapter 8 first: that is the course the LMS launches for the agent');
    const hops: { step: string; status: number; detail: string }[] = [];
    const sections: { id: string; title: string; questions: string[]; answers?: string[]; graded?: unknown }[] = [];
    const transcript: { kind: string; section: string; text?: string }[] = [];
    const show = (extra: Record<string, unknown> = {}): void => setChapter('lti', { data: { error: undefined, agent: { course: pub, hops, sections, transcript, ...extra } } });
    show({ running: true });
    const started = await hub.track({ actor: 'claude', service: 'foxxi · LMS', tool: 'lti-launch-signed', summary: `the agent asks Foxxi's LMS to launch your course “${pub.title ?? pub.courseId}”`, request: { course_id: pub.courseId } }, async () => {
      const r = await signedRoute('/agent/lti/launch', { course_id: pub.courseId }, agent);
      return { value: r, status: r.status >= 400 ? 'refused' : 'ok', code: r.status, response: r.json, summary: r.status >= 400 ? String(r.json['error'] ?? r.status) : 'a one-use launch, good for five minutes' };
    });
    if (started.status >= 400) throw new Error(String(started.json['error'] ?? `the launch answered ${started.status}`));
    hops.push({ step: 'The LMS starts the launch for the signer', status: started.status, detail: `line item “${String((started.json['lineItem'] as { label?: string } | undefined)?.label ?? '')}”` });
    const login = await hub.track({ actor: 'claude', service: 'foxxi · tool', tool: 'OIDC login', summary: 'the Tool starts the login and sends the agent to the LMS to authorize it' }, async () => {
      const r = await fetch(String(started.json['initiationUrl']), { redirect: 'manual' });
      return { value: { status: r.status, location: r.headers.get('location') ?? '' }, status: r.status === 302 ? 'ok' : 'err', code: r.status, summary: `${r.status} to the LMS's authorization endpoint` };
    });
    hops.push({ step: 'The Tool’s OIDC login', status: login.status, detail: 'redirects to the LMS with a state and a nonce' });
    if (login.status !== 302 || !login.location) throw new Error(`the Tool's login answered ${login.status}`);
    const authz = await hub.track({ actor: 'claude', service: 'foxxi · LMS', tool: 'authorize', summary: 'the LMS spends the one-use grant and signs an id_token for the Tool' }, async () => {
      const r = await fetch(login.location, { headers: { accept: 'application/json' } });
      const j = await r.json().catch(() => ({})) as { form_post?: { action?: string; fields?: Record<string, string> }; error?: string; error_description?: string };
      return { value: { status: r.status, ...j }, status: r.ok ? 'ok' : 'refused', code: r.status, summary: r.ok ? 'a signed id_token, to post to the Tool' : String(j.error_description ?? j.error ?? r.status) };
    });
    if (authz.status !== 200 || !authz.form_post?.action || !authz.form_post.fields) throw new Error(`the LMS's authorization answered ${authz.status}: ${String(authz.error_description ?? authz.error ?? '')}`);
    const claims = claimsOf(authz.form_post.fields['id_token'] ?? '');
    hops.push({ step: 'The LMS’s authorization', status: authz.status, detail: `an id_token for ${short(String(claims['sub'] ?? ''))}, signed by the LMS` });
    show({ running: true, claims });
    const toolLaunch = await hub.track({ actor: 'claude', service: 'foxxi · tool', tool: 'launch', summary: "the Tool checks the id_token against the LMS's published keys and opens the course" }, async () => {
      const r = await fetch(authz.form_post!.action!, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(authz.form_post!.fields!).toString() });
      return { value: { status: r.status, location: r.headers.get('location') ?? '' }, status: r.status === 302 ? 'ok' : 'refused', code: r.status, summary: r.status === 302 ? 'verified; the course is open' : `answered ${r.status}` };
    });
    hops.push({ step: 'The Tool’s launch', status: toolLaunch.status, detail: 'id_token verified against the LMS’s published keys' });
    if (toolLaunch.status !== 302 || !toolLaunch.location) throw new Error(`the Tool's launch answered ${toolLaunch.status}`);
    const playUrl = toolLaunch.location;
    let view = await (await fetch(playUrl, { headers: { accept: 'application/json' } })).json() as Record<string, unknown>;
    let result: Record<string, unknown> | undefined;
    for (let step = 0; step < 12 && !result; step++) {
      const sco = view['sco'] as DeliveredSection | undefined;
      if (!sco) throw new Error(String(view['error'] ?? 'the course player gave no section'));
      const entry: (typeof sections)[number] = { id: sco.id, title: sco.title, questions: (sco.assessment ?? []).map((q) => q.question) };
      sections.push(entry);
      show({ running: true, claims });
      let answers: string[] = [];
      if (sco.assessment?.length) {
        const read = await hub.track({ actor: 'claude', service: 'claude-cli', tool: 'read and answer', summary: `the agent reads section ${sco.id} and answers ${sco.assessment.length} question(s)` }, async () => {
          const a = await answerSection(sco, (e: AgentEvent) => { if (e.kind === 'thinking' && e.text) { transcript.push({ kind: 'thinking', section: sco.id, text: e.text.slice(0, 500) }); show({ running: true, claims }); } });
          return { value: a, summary: `answered ${a.answers.map((x) => `“${x}”`).join(', ')}${a.costUsd !== undefined ? ` · $${a.costUsd.toFixed(3)}` : ''}` };
        });
        answers = read.answers;
        entry.answers = answers;
      }
      const sent = answers;
      const next = await hub.track({ actor: 'claude', service: 'foxxi · tool', tool: 'course player', summary: sent.length ? `submitting ${sent.length} answer(s)` : 'continuing', request: sent.length ? { answers: sent } : {} }, async () => {
        const r = await fetch(playUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ answers: sent }) });
        const j = await r.json().catch(() => ({})) as Record<string, unknown>;
        const g = j['graded'] as { correct?: number; total?: number } | undefined;
        return { value: { status: r.status, json: j }, status: r.ok ? 'ok' : 'refused', code: r.status, response: j, summary: !r.ok ? String(j['error'] ?? r.status) : j['done'] ? `done: ${j['passed'] ? 'passed' : 'not passed'}, grade ${(j['gradebook'] as { posted?: boolean } | undefined)?.posted ? 'posted to the LMS' : 'not posted'}` : g ? `${g.correct} of ${g.total} correct` : 'next section' };
      });
      if (next.status >= 400) throw new Error(String(next.json['error'] ?? `the course player answered ${next.status}`));
      if (next.json['graded']) entry.graded = next.json['graded'];
      if (next.json['done']) result = next.json;
      else view = next.json;
      show({ running: true, claims });
    }
    const gb = result?.['gradebook'] as { posted?: boolean; status?: number; scoreGiven?: number; scoreMaximum?: number; why?: string } | undefined;
    if (gb) hops.push({ step: 'The grade back to the LMS (AGS)', status: gb.status ?? 0, detail: gb.posted ? `${gb.scoreGiven} of ${gb.scoreMaximum}, with a token for the Tool's signed assertion` : String(gb.why ?? 'not posted') });
    show({ running: false, claims, ...(result ? { result } : {}) });
    await handlers['lti-gradebook']!({});
  },

  async 'lti-gradebook'() {
    const gradebook: Record<string, unknown> = {};
    if (you) {
      const r = await youAct('lti-gradebook-signed', {}, 'reading your row of the LMS gradebook');
      gradebook['you'] = r.status >= 400 ? { error: String(r.body['error'] ?? r.status) } : { rows: r.body['rows'] ?? [], learner: r.body['learner'] };
    }
    if (agent) {
      const r = await hub.track({ actor: 'claude', service: 'foxxi · LMS', tool: 'lti-gradebook-signed', summary: 'the agent reads its row of the LMS gradebook' }, async () => {
        const s = await signedRoute('/agent/lti/gradebook', {}, agent);
        return { value: s, status: s.status >= 400 ? 'refused' : 'ok', code: s.status, response: s.json, summary: s.status >= 400 ? String(s.json['error'] ?? s.status) : `${(s.json['rows'] as unknown[] | undefined)?.length ?? 0} course(s) in the gradebook` };
      });
      gradebook['agent'] = r.status >= 400 ? { error: String(r.json['error'] ?? r.status) } : { rows: r.json['rows'] ?? [], learner: r.json['learner'] };
    }
    setChapter('lti', { data: { gradebook } });
    const graded = (who: 'you' | 'agent'): boolean => ((gradebook[who] as { rows?: { result?: unknown }[] } | undefined)?.rows ?? []).some((row) => row.result);
    if (graded('you') && graded('agent')) setChapter('lti', { status: 'done' });
    if (graded('you') || graded('agent')) unlock('after');
  },

  async 'records-after'() {
    if (!you || !agent) throw new Error('sign in first');
    const before = chapters.records.data as { you?: RecordView; agent?: RecordView };
    setChapter('after', { replace: true, status: 'active', data: { running: true, before: { you: before.you?.summary, agent: before.agent?.summary } } });
    const both = await readRecords();
    setChapter('after', { status: 'done', data: { running: false, you: both.you, agent: both.agent } });
  },
};

/** Both learner records, each read as its own subject: you as the person your credentials name, the agent as itself. */
async function readRecords(): Promise<{ you: RecordView; agent: RecordView }> {
  if (!you || !agent) throw new Error('sign in first');
  const self = you;
  const signer = agent;
  // Your record is read as YOU, the person the credentials name, not as this app's session agent.
  const yours = await youAct('review-record', { subject_did: self.webId }, 'assembling your IEEE P2997 learner record, as yourself');
  const theirs = await hub.track({ actor: 'claude', service: 'foxxi', tool: 'review-record', summary: 'the agent assembles its own learner record' }, async () => {
    const r = await signedRoute('/agent/review-record', {}, signer, 120_000);
    return { value: r, status: r.status >= 400 ? 'refused' : 'ok', code: r.status, response: recordView(r.json, r.status), summary: r.status >= 400 ? String(r.json['error'] ?? r.status) : 'its record, public because it records as an agent' };
  });
  return { you: recordView(yours.body, yours.status), agent: recordView(theirs.json, theirs.status) };
}

// ── Part three: cmi5 and LTI ──────────────────────────────────────────────────────────────────

interface Cmi5CourseView { id: string; title: string; aus: { id: string; title: string; moveOn?: string }[] }
let cmi5CourseCache: Cmi5CourseView | undefined;

/**
 * The cmi5 course the bridge publishes of its own, found the way any client would: compose the
 * sample course (the id is the composition's), and read its registration on the LMS. The bridge
 * seeds it at boot; if it is not registered, publishing it is open to anyone.
 */
async function cmi5Course(): Promise<Cmi5CourseView> {
  if (cmi5CourseCache) return cmi5CourseCache;
  const post = async (path: string, body: unknown): Promise<Record<string, unknown>> => {
    const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`${path} answered ${r.status}`);
    return await r.json() as Record<string, unknown>;
  };
  const course = (await post('/content/compose-course', SAMPLE_COURSE))['course'] as { id: string; title: string } | undefined;
  if (!course?.id) throw new Error('the bridge composed no course');
  let reg = await getJson(`/cmi5/course/${encodeURIComponent(course.id)}`);
  if (reg.status === 404) { await post('/content/publish-course', { course }); reg = await getJson(`/cmi5/course/${encodeURIComponent(course.id)}`); }
  if (reg.status !== 200) throw new Error(`the cmi5 LMS has no course ${course.id}`);
  type Node = { kind?: string; id?: string; title?: string; moveOn?: string; children?: Node[] };
  const aus: Cmi5CourseView['aus'] = [];
  const walk = (nodes: Node[]): void => { for (const n of nodes) { if (n.kind === 'au' && n.id) aus.push({ id: n.id, title: n.title ?? n.id, ...(n.moveOn ? { moveOn: n.moveOn } : {}) }); else if (Array.isArray(n.children)) walk(n.children); } };
  walk((reg.json['structure'] ?? []) as Node[]);
  cmi5CourseCache = { id: course.id, title: String(reg.json['title'] ?? course.title), aus };
  return cmi5CourseCache;
}

interface Cmi5Launch { launchUrl: string; registration: string; auId: string; auTitle: string; moveOn: string; progress: string; learner: string; launchDataStaged: boolean }
function launchOf(j: Record<string, unknown>): Cmi5Launch {
  return {
    launchUrl: String(j['launchUrl'] ?? ''), registration: String(j['registration'] ?? ''), auId: String(j['auId'] ?? ''), auTitle: String(j['auTitle'] ?? ''),
    moveOn: String(j['moveOn'] ?? ''), progress: String(j['progress'] ?? ''), learner: String(j['learner'] ?? ''), launchDataStaged: j['launchDataStaged'] === true,
  };
}

/** Watch a registration on the LMS until its moveOn is met: the LMS records satisfied, and the chapter says so. */
async function watchRegistration(who: 'you' | 'agent', registration: string, forMs = 20 * 60_000): Promise<void> {
  const until = Date.now() + forMs;
  while (Date.now() < until) {
    const r = await getJson(`/cmi5/registration/${registration}`).catch(() => ({ status: 0, json: {} as Record<string, unknown> }));
    if (r.json['satisfied'] === true) {
      await hub.track({ actor: 'bridge', service: 'foxxi · LMS', tool: 'satisfied', summary: `the LMS recorded satisfied for ${who === 'you' ? 'your' : "the agent's"} activity: ${String(r.json['reason'] ?? '')}`, request: { registration } }, async () => ({ value: r.json, summary: 'moveOn met', response: r.json }));
      const d = chapters.cmi5.data as Record<string, Record<string, unknown> | undefined>;
      if (d[who]?.['registration'] !== registration) return;
      setChapter('cmi5', { data: { [who]: { ...d[who], state: 'satisfied', satisfiedAt: r.json['satisfiedAt'] } } });
      const now = chapters.cmi5.data as Record<string, { state?: string } | undefined>;
      if (now['you']?.state === 'satisfied' && now['agent']?.state === 'satisfied') setChapter('cmi5', { status: 'done' });
      unlock('after');
      return;
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
}

/** What an id_token says: its claims, read without checking the signature. The Tool is what checks it. */
function claimsOf(jwt: string): Record<string, unknown> {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return {}; }
}
const short = (s: string, n = 14): string => (s.length > n * 2 + 1 ? `${s.slice(0, n)}…${s.slice(-n)}` : s);

/** The LTI chapter opens once both courses exist: the agent's, which your LMS launches for you, and yours, which it launches for the agent. */
function unlockLti(): void {
  const yours = (chapters.teach.data as { published?: { courseId?: string } }).published?.courseId;
  if (yours && agentsCourse()?.courseId) unlock('lti');
}

/** The competency both of you exercise by teaching the other: an IRI, since it becomes the activity's type. */
const TEACHING = `${BRIDGE}/ns/foxxi/competency/instructional-design`;

/** The course the agent wrote and you took: its evidence of teaching. */
function agentsCourse(): { courseId?: string; courseIri?: string; title?: string } | undefined {
  type Course = { courseId?: string; courseIri?: string; title?: string; authoredBy?: string };
  const written = (chapters.author.data as { course?: Course }).course;
  const taken = (chapters.learn.data as { course?: Course }).course;
  if (taken?.courseIri && agent && taken.authoredBy && sameIdentity(taken.authoredBy, agent.did)) return taken;
  return written?.courseIri ? written : undefined;
}

interface RecordView {
  status: number;
  error?: string;
  learner?: string;
  subjectKind?: string;
  summary?: Record<string, unknown>;
  competencies?: { label: string; level?: string; basis?: string; status?: string }[];
  credentials?: { name: string; verified: boolean; id: string }[];
  recordId?: string;
}

/** What the page shows of an IEEE P2997 record: the summary, the competencies and the credentials. */
function recordView(body: Record<string, unknown>, status: number): RecordView {
  if (status >= 400) return { status, error: String(body['error'] ?? status) };
  const elr = (body['elr'] ?? {}) as Record<string, unknown>;
  const levelOf = (c: Record<string, unknown>): string | undefined => {
    const l = c['level'] ?? c['proficiencyLevel'] ?? c['tla:level'];
    const s = typeof l === 'string' ? l : typeof (l as { label?: unknown } | undefined)?.label === 'string' ? String((l as { label: string }).label) : undefined;
    // A TLA level IRI ends in its name, `LevelAdvancedBeginner`: shown as the words it stands for.
    return s ? s.split(/[#/]/).pop()?.replace(/^Level/, '').replace(/([a-z])([A-Z])/g, '$1 $2') : undefined;
  };
  return {
    status,
    learner: String((elr['learner'] as { did?: unknown } | undefined)?.did ?? ''),
    subjectKind: String(elr['subjectKind'] ?? body['subjectKind'] ?? ''),
    summary: (elr['summary'] ?? {}) as Record<string, unknown>,
    competencies: ((elr['competencies'] ?? []) as Record<string, unknown>[]).map((c) => ({
      label: String(c['label'] ?? c['id'] ?? ''),
      ...(levelOf(c) ? { level: levelOf(c) } : {}),
      ...(typeof c['basis'] === 'string' ? { basis: c['basis'] } : {}),
      ...(typeof c['modalStatus'] === 'string' ? { status: c['modalStatus'] } : {}),
    })),
    credentials: ((elr['credentials'] ?? []) as Record<string, unknown>[]).map((c) => ({ name: String(c['achievementName'] ?? c['id'] ?? ''), verified: c['verified'] === true, id: String(c['id'] ?? '') })),
    ...(typeof elr['id'] === 'string' ? { recordId: elr['id'] } : {}),
  };
}

/**
 * The courses a learner could take next: every course the demo knows of (the catalogs the walk
 * found, the one you wrote, the agent's) except those the learner wrote. That is a rule, so it is
 * applied here rather than asked of Jev; a learner record says what you learned, not what you taught.
 */
function candidateCourses(forWho: 'you' | 'agent'): RankableCourse[] {
  const all = new Map<string, RankableCourse & { author?: string }>();
  const d = chapters.discover.data as { catalogs?: (FederatedCourseCatalog & { podLabel?: string })[] };
  for (const c of d.catalogs ?? []) for (const p of c.products) {
    const key = p.courseId ?? p.iri;
    // An owner's catalog says who authored each engine-graded course in its description.
    const author = /authored by (\S+?)\.?$/.exec(p.description ?? '')?.[1];
    all.set(key, { key, title: p.title ?? key, ...(p.description ? { description: p.description } : {}), provider: c.podLabel ?? c.issuedBy ?? '', ...(author ? { author } : {}) });
  }
  const pub = (chapters.teach.data as { published?: { courseId?: string; title?: string; authorDid?: string } }).published;
  if (pub?.courseId && !all.has(pub.courseId)) all.set(pub.courseId, { key: pub.courseId, title: pub.title ?? pub.courseId, provider: 'you', ...(pub.authorDid ? { author: pub.authorDid } : {}) });
  const theirs = agentsCourse();
  if (theirs?.courseId && !all.has(theirs.courseId)) all.set(theirs.courseId, { key: theirs.courseId, title: theirs.title ?? theirs.courseId, provider: 'Claude Code agent', ...(agent ? { author: agent.did } : {}) });
  const mine = forWho === 'you' ? [you?.sessionDid, you?.personDid, you?.webId] : [agent?.did];
  const wroteIt = (c: { key: string; author?: string }): boolean =>
    (forWho === 'you' && c.key === pub?.courseId) || (c.author !== undefined && mine.some((m) => m !== undefined && sameIdentity(m, c.author!)));
  return [...all.values()].filter((c) => !wroteIt(c)).map(({ author: _author, ...c }) => c);
}

function publicCourse(c: AuthoredCourse): AuthoredCourse {
  // What the page shows of the agent's draft: the answers stay out of the ledger and the page.
  return { ...c, scos: c.scos.map((s) => ({ ...s, ...(s.assessment ? { assessment: s.assessment.map((q) => ({ question: q.question, answer: '(hashed at authoring)' })) } : {}) })) };
}

function tampered(vc: Record<string, unknown>): Record<string, unknown> {
  const copy = JSON.parse(JSON.stringify(vc)) as { credentialSubject?: { achievement?: { name?: string } } };
  if (copy.credentialSubject?.achievement) copy.credentialSubject.achievement.name = `${copy.credentialSubject.achievement.name ?? 'Course'} (with distinction)`;
  return copy as Record<string, unknown>;
}

interface Difference { path: string; holder?: unknown; checked?: unknown }
/** Where two JSON values differ, as paths with both sides (at most twelve): what changed in a copy. */
function diffJson(a: unknown, b: unknown, path: string, out: Difference[] = []): Difference[] {
  if (out.length >= 12) return out;
  if (a && b && typeof a === 'object' && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`, out);
    return out;
  }
  if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, ...(a !== undefined ? { holder: a } : {}), ...(b !== undefined ? { checked: b } : {}) });
  return out;
}

async function readWalletCredential(descriptorUrl: string): Promise<Record<string, unknown> | undefined> {
  const graphUrl = descriptorUrl.replace(/\.ttl$/, '-graph.trig');
  const text = await (await fetch(graphUrl)).text();
  const b64 = /bundleJson>\s+"([A-Za-z0-9+/=\s]+)"/.exec(text)?.[1];
  return b64 ? JSON.parse(Buffer.from(b64.replace(/\s+/g, ''), 'base64').toString('utf8')) as Record<string, unknown> : undefined;
}

interface Entry { descriptorUrl: string; conformsTo: string[]; issuer?: string }
function listEntries(j: unknown): Entry[] {
  const arr = Array.isArray(j) ? j : Array.isArray((j as { entries?: unknown })?.entries) ? (j as { entries: unknown[] }).entries : Array.isArray((j as { descriptors?: unknown })?.descriptors) ? (j as { descriptors: unknown[] }).descriptors : [];
  return arr.map((e) => e as Record<string, unknown>).filter((e) => typeof (e['descriptorUrl'] ?? e['url'] ?? e['descriptor']) === 'string').map((e) => ({
    descriptorUrl: String(e['descriptorUrl'] ?? e['url'] ?? e['descriptor']),
    conformsTo: (Array.isArray(e['conformsTo']) ? e['conformsTo'] : typeof e['conformsTo'] === 'string' ? [e['conformsTo']] : []).map(String),
    ...(typeof e['issuer'] === 'string' ? { issuer: String(e['issuer']) } : {}),
  }));
}
function parseLoose(t: string): unknown { try { return JSON.parse(t); } catch { return []; } }
function graphText(j: Record<string, unknown> | undefined, text: string): string | undefined {
  const g = j?.['graph'] as { content?: string } | string | undefined;
  if (typeof g === 'string') return g;
  if (g && typeof g.content === 'string') return g.content;
  for (const k of ['graphContent', 'graph_content', 'content', 'turtle', 'trig']) if (typeof j?.[k] === 'string') return String(j[k]);
  return text.includes('@prefix') ? text : undefined;
}
const sameIdentity = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(join(HERE, 'public'), { extensions: ['html'] }));

app.get('/api/state', (_req, res) => { res.json({ state: state(), ledger: hub.ledger }); });
app.get('/events', (req: Request, res: Response) => { hub.attach(res); res.write(`event: state\ndata: ${JSON.stringify(state())}\n\n`); req.on('close', () => undefined); });

app.post('/api/signin', async (_req, res) => {
  try {
    const url = await hub.track({ actor: 'you', service: 'relay', tool: 'register + authorize', summary: 'registering this app with the relay and opening its sign-in page' }, async () => {
      const u = await auth.start();
      return { value: u, summary: 'sign-in page opened on the relay' };
    });
    res.json({ ok: true, authorizeUrl: url });
  } catch (e) { res.status(502).json({ ok: false, error: (e as Error).message }); }
});

app.get('/oauth/callback', async (req, res) => {
  const code = String(req.query['code'] ?? '');
  const st = String(req.query['state'] ?? '');
  // In the sign-in window this closes itself; when the demo's own tab came here instead, it goes back.
  const page = (msg: string, ok: boolean): string => `<!doctype html><meta charset="utf-8"><title>Interego, live</title><body style="font:15px system-ui;padding:40px;background:#0b0e13;color:#e5e7eb"><h2 style="color:${ok ? '#34c77b' : '#f06a6a'}">${ok ? 'Signed in' : 'Sign-in did not finish'}</h2><p>${msg}</p><p><a href="/" style="color:#a78bfa">Back to the demo</a></p><script>var o=null;try{o=window.opener}catch(e){}${ok ? 'setTimeout(function(){if(o){try{o.focus()}catch(e){}window.close()}else{location.href="/"}},900)' : ''}</script></body>`;
  if (!code) { res.status(400).send(page(`The relay sent no code: ${String(req.query['error_description'] ?? req.query['error'] ?? 'unknown')}`, false)); return; }
  try {
    await hub.track({ actor: 'you', service: 'relay', tool: 'token', summary: 'exchanging the code for your session token (PKCE)' }, async () => {
      const t = await auth.finish(code, st);
      return { value: t, summary: `token for scope ${t.scope ?? 'mcp'}, good for ${Math.round((t.expiresAt - Date.now()) / 60000)} minutes` };
    });
    res.send(page('Your relay connection is open. The demo carries on from here.', true));
    afterSignIn().catch((e: Error) => { setChapter('signin', { data: { error: e.message } }); hub.toast(e.message); });
  } catch (e) { res.status(400).send(page((e as Error).message, false)); }
});

app.post('/api/chapter/:action', async (req, res) => {
  const action = String(req.params['action']);
  const h = handlers[action];
  if (!h) { res.status(404).json({ ok: false, error: `no action ${action}` }); return; }
  const chapterOf: Record<string, ChapterId> = { authorize: 'signin', author: 'author', 'reset-author': 'author', publish: 'author', discover: 'discover', rank: 'discover', pick: 'learn', launch: 'learn', submit: 'learn', standings: 'claim', claim: 'claim', verify: 'verify', forgery: 'forgery', 'draft-course': 'teach', 'publish-course': 'teach', 'agent-learn': 'agentLearns', 'agent-claim': 'agentLearns', 'record-work': 'work', 'review-records': 'records', recommend: 'next', 'cmi5-launch': 'cmi5', 'lti-launch': 'lti', 'lti-gradebook': 'lti', 'records-after': 'after' };
  try {
    await h((req.body ?? {}) as Record<string, unknown>);
    res.json({ ok: true, state: state() });
  } catch (e) {
    const id = chapterOf[action];
    if (id) setChapter(id, { data: { error: (e as Error).message } });
    res.json({ ok: false, error: (e as Error).message, state: state() });
  }
});

/** Sign "you" in without a browser, with a wallet, for testing this demo headlessly. */
async function headlessSignIn(keyFile: string): Promise<void> {
  const { mintBearer } = await import('../../applications/shared-workspace/tools/live-identity.js');
  const { Wallet } = await import('ethers');
  const saved = JSON.parse(readFileSync(keyFile, 'utf8')) as { privateKey: string };
  const bearer = await hub.track({ actor: 'you', service: 'relay', tool: 'siwe sign-in', summary: 'signing in with a wallet instead of a passkey (DEMO_YOU_WALLET)' }, async () => {
    const b = await mintBearer(RELAY, IDENTITY, new Wallet(saved.privateKey), 'Interego Live Demo');
    return { value: b, summary: 'token issued' };
  });
  auth.token = { accessToken: bearer.accessToken, ...(bearer.refreshToken ? { refreshToken: bearer.refreshToken } : {}), expiresAt: bearer.expiresAt ?? Date.now() + 3_600_000 };
  await afterSignIn();
}

app.listen(PORT, () => {
  console.log(`Interego, live — open ${ORIGIN}`);
  void probe();
  const wallet = process.env['DEMO_YOU_WALLET'];
  if (wallet) headlessSignIn(wallet).catch((e: Error) => { console.error(`headless sign-in failed: ${e.message}`); setChapter('signin', { data: { error: e.message } }); });
});
