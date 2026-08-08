/**
 * THE FOUR ATTRIBUTION WRITERS, RUN FOR REAL, AND THE BYTES READ BACK OFF THE POD.
 *
 * ★ NOT A UNIT TEST WITH A FAKE POD. Each writer below is the real exported function, publishing
 * through `@interego/solid`'s real `publish()` onto the live CSS behind `gate.interego.xwisee.com`.
 * What is asserted is what a reader FETCHING THE POD gets back, not what the driver composed —
 * the whole claim being checked is about what a third party can find in the record.
 *
 * The rule these were audited against: `prov:wasAttributedTo` names whoever AUTHORED the record.
 * A human author in the author position is correct; an agent-authored record naming the pod
 * owner is the defect. Whether an act was on somebody's behalf is a separate, per-act statement
 * and is never stamped unconditionally.
 *
 *   RAILWAY_PROJECT_TOKEN=$(cat .interego/railway-token.txt) \
 *     npx tsx tools/drive-attribution-writers-live.ts
 *
 * `INTEREGO_GATE_SECRET` may be supplied directly to skip the Railway lookup.
 */

import { ContextGraphsSDK } from '@interego/solid';
// Relative, not by package name: these two integrations are not linked into the root
// `node_modules`, which is why their own tests import `../src/index.js` too.
import { recordAgentAction } from '../integrations/compliance-overlay/src/index.js';
import { storeMemory } from '../integrations/openclaw-memory/src/bridge.js';
import { recordCrossAgentAudit } from '../applications/agent-collective/src/pod-publisher.js';
import type { IRI } from '@interego/core';

const GATE = process.env['INTEREGO_GATE'] ?? 'https://gate.interego.xwisee.com';
const POD_NAME = process.env['INTEREGO_POD'] ?? 'u-eth-8f3b8e939600';
const POD = `${GATE}/${POD_NAME}/`;
const stamp = Date.now().toString(36);

const HUMAN = 'https://identity.interego.xwisee.com/users/u-eth-8f3b8e939600/profile#me' as IRI;
const AGENT = 'did:web:identity.interego.xwisee.com:agents:attribution-probe' as IRI;
const OTHER_AGENT = 'did:web:identity.interego.xwisee.com:agents:attribution-counterparty' as IRI;

/** `defaultCitation` is required on `OverlayConfig`; each call below overrides it explicitly. */
const OVERLAY = { podUrl: POD, defaultCitation: { framework: 'soc2' } } as const satisfies
  { podUrl: string; defaultCitation: { framework: 'soc2' } };

const log = (...a: unknown[]): void => { process.stdout.write(a.map(String).join(' ') + '\n'); };
const head = (s: string): void => { log('\n== ' + s + ' ' + '='.repeat(Math.max(0, 70 - s.length))); };
let failures = 0;
function must(what: string, ok: boolean, detail = ''): void {
  if (!ok) failures++;
  log((ok ? '  OK   ' : '  FAIL ') + what + (detail ? ' — ' + detail : ''));
}

async function gateSecret(): Promise<string> {
  const direct = process.env['INTEREGO_GATE_SECRET'];
  if (direct) return direct;
  const t = process.env['RAILWAY_PROJECT_TOKEN'];
  if (!t) throw new Error('set INTEREGO_GATE_SECRET or RAILWAY_PROJECT_TOKEN');
  const EP = 'https://backboard.railway.com/graphql/v2';
  const g = async <T>(q: string, v: Record<string, unknown> = {}): Promise<T> => {
    const r = await fetch(EP, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Project-Access-Token': t }, body: JSON.stringify({ query: q, variables: v }) });
    const j = await r.json() as { data?: T; errors?: unknown };
    if (j.errors) throw new Error(JSON.stringify(j.errors));
    return j.data as T;
  };
  const pt = await g<{ projectToken: { projectId: string; environmentId: string } }>('{ projectToken { projectId environmentId } }');
  const proj = await g<{ project: { services: { edges: { node: { id: string; name: string } }[] } } }>(
    'query($id:String!){ project(id:$id){ services{ edges{ node{ id name } } } } }', { id: pt.projectToken.projectId });
  const svc = proj.project.services.edges.map(e => e.node).find(n => n.name === 'css-gate');
  if (!svc) throw new Error('no css-gate service');
  const vars = await g<{ variables: Record<string, string> }>(
    'query($p:String!,$e:String!,$s:String!){ variables(projectId:$p,environmentId:$e,serviceId:$s) }',
    { p: pt.projectToken.projectId, e: pt.projectToken.environmentId, s: svc.id });
  const secret = vars.variables['WRITE_SECRET'];
  if (!secret) throw new Error('css-gate declares no WRITE_SECRET');
  return secret;
}

/**
 * The gate wants a bearer on every mutating method. Installed on `globalThis` because
 * `storeMemory` and `recordAgentAction` call `publish()` with no fetch argument — which is the
 * shape their real runtimes use against an internal allow-all CSS, and not a thing to widen
 * their public config for the sake of a driver.
 */
function installAuthedFetch(secret: string): void {
  const real = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.startsWith(GATE) && method !== 'GET' && method !== 'HEAD') {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      headers.set('Authorization', 'Bearer ' + secret);
      return real(input, { ...init, headers });
    }
    return real(input, init);
  }) as typeof globalThis.fetch;
}

/** What a reader gets, not what we sent. */
async function fetchText(url: string): Promise<string> {
  const r = await fetch(url, { headers: { Accept: 'text/turtle, application/trig, */*' } });
  return r.ok ? r.text() : `<<HTTP ${r.status}>>`;
}

async function run(): Promise<number> {
  installAuthedFetch(await gateSecret());
  log('pod', POD, '· run', stamp);

  // ── 1. integrations/openclaw-memory — an agent's own memory ───────────────────────────────
  head('openclaw-memory: an agent stores a memory while delegated by a human');
  const mem = await storeMemory(
    { text: `Attribution probe ${stamp}: the delegating human never typed this sentence.` },
    { podUrl: POD, authoringAgentDid: AGENT, onBehalfOf: HUMAN },
  );
  const memGraph = await fetchText(mem.graphUrl);
  const memDesc = await fetchText(mem.descriptorUrl);
  log('   graph      ', mem.graphUrl);
  must('the memory is attributed to the AGENT that composed it',
    memGraph.includes(`wasAttributedTo> <${AGENT}>`), memGraph.split('\n').find(l => l.includes('wasAttributedTo'))?.trim() ?? '');
  must('and NOT to the human who delegated it', !memGraph.includes(`wasAttributedTo> <${HUMAN}>`));
  must('the human is the STANDING delegation on the descriptor',
    memDesc.includes('onBehalfOf') && memDesc.includes(HUMAN));
  must('no per-act footing is derived from a config value',
    !memGraph.includes('qualifiedDelegation') && !memGraph.includes('actedOnOwnAccount'));

  // ── 2. integrations/compliance-overlay — a tool call, with a per-act principal ─────────────
  head('compliance-overlay: a tool call the runtime states a principal for');
  const act = await recordAgentAction(
    {
      toolName: 'probe.read_ledger', args: { scope: stamp }, outcome: 'success',
      resultSummary: 'read 1 row', agentDid: AGENT, onBehalfOf: HUMAN, durationMs: 12,
    },
    OVERLAY,
    { framework: 'soc2' },
  );
  const actGraph = await fetchText(act.graphUrl);
  log('   graph      ', act.graphUrl);
  must('the action is attributed to the AGENT that performed it',
    actGraph.includes(`wasAttributedTo> <${AGENT}>`), actGraph.split('\n').find(l => l.includes('wasAttributedTo'))?.trim() ?? '');
  must('and NOT to the principal', !actGraph.includes(`wasAttributedTo> <${HUMAN}>`));
  must('the principal is stated as a PER-ACT prov:Delegation over this action',
    actGraph.includes('qualifiedDelegation') && actGraph.includes('#Delegation')
    && actGraph.includes(`#agent> <${HUMAN}>`) && actGraph.includes(`#hadActivity> <${act.eventIri}>`));

  head('compliance-overlay: the same call with NO principal stated');
  const solo = await recordAgentAction(
    { toolName: 'probe.read_ledger', args: { scope: stamp + '-solo' }, outcome: 'success', agentDid: AGENT },
    OVERLAY, { framework: 'soc2' },
  );
  const soloGraph = await fetchText(solo.graphUrl);
  log('   graph      ', solo.graphUrl);
  must('attributed to the agent', soloGraph.includes(`wasAttributedTo> <${AGENT}>`));
  must('★ and states NEITHER footing — absence is a third answer',
    !soloGraph.includes('qualifiedDelegation') && !soloGraph.includes('actedOnOwnAccount'));

  // ── 3. applications/agent-collective — a cross-agent audit entry ───────────────────────────
  head('agent-collective: an inbound cross-agent audit entry in the human\'s pod');
  const audit = await recordCrossAgentAudit(
    {
      exchangeIri: `urn:iep:ac-chimein:probe-${stamp}` as IRI,
      auditedAgentDid: OTHER_AGENT, direction: 'Inbound', humanOwnerDid: HUMAN,
    },
    { podUrl: POD, authoringAgentDid: AGENT },
  );
  const auditGraph = await fetchText(audit.graphUrl);
  const auditDesc = await fetchText(audit.descriptorUrl);
  log('   graph      ', audit.graphUrl);
  must('the audit entry is attributed to the AGENT that wrote it',
    auditGraph.includes(`prov:wasAttributedTo <${AGENT}>`), auditGraph.split('\n').find(l => l.includes('wasAttributedTo'))?.trim() ?? '');
  must('and NOT to the pod owner', !auditGraph.includes(`prov:wasAttributedTo <${HUMAN}>`));
  must('the AUDITED agent stays the subject, not the author',
    auditGraph.includes(`ac:auditedAgent <${OTHER_AGENT}>`) && !auditGraph.includes(`prov:wasAttributedTo <${OTHER_AGENT}>`));
  must('the human is the standing delegation on the descriptor',
    auditDesc.includes('onBehalfOf') && auditDesc.includes(HUMAN));

  // ── 4. packages/solid sdk.ts — the no-agent branch, which was already right ────────────────
  head('solid SDK: no agent configured, so the OWNER is the author (unchanged, and checked)');
  const sdk = new ContextGraphsSDK({ podUrl: POD, ownerWebId: HUMAN, agentId: undefined });
  const own = await sdk.publish(`urn:graph:probe:sdk-human:${stamp}`,
    `<urn:graph:probe:sdk-human:${stamp}> <http://purl.org/dc/terms/description> "written by a person, through the SDK" .`);
  const ownDesc = await fetchText(own.descriptorUrl);
  log('   descriptor ', own.descriptorUrl);
  must('★ the human IS the author, and that was never the defect',
    ownDesc.includes(`wasAttributedTo <${HUMAN}>`) || ownDesc.includes(`wasAttributedTo\n    <${HUMAN}>`),
    ownDesc.split('\n').find(l => l.includes('wasAttributedTo'))?.trim() ?? '');
  must('and no agent is invented to fill the generating slot',
    !ownDesc.includes('urn:agent:sdk:default'));

  head('solid SDK: an agent configured with no owner');
  const sdkAgent = new ContextGraphsSDK({ podUrl: POD, ownerWebId: undefined, agentId: AGENT });
  const byAgent = await sdkAgent.publish(`urn:graph:probe:sdk-agent:${stamp}`,
    `<urn:graph:probe:sdk-agent:${stamp}> <http://purl.org/dc/terms/description> "written by an agent, through the SDK" .`);
  const agentDesc = await fetchText(byAgent.descriptorUrl);
  log('   descriptor ', byAgent.descriptorUrl);
  must('the AGENT is the author', agentDesc.includes(AGENT) && agentDesc.includes('wasAttributedTo'),
    agentDesc.split('\n').find(l => l.includes('wasAttributedTo'))?.trim() ?? '');
  must('and nothing serialises the string "undefined" into an IRI', !agentDesc.includes('<undefined>'));

  log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'));
  return failures === 0 ? 0 : 1;
}

run().then(c => process.exit(c)).catch(e => { log('driver threw:', (e as Error).stack ?? String(e)); process.exit(2); });
