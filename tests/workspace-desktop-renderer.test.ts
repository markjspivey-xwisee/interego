/**
 * THE DESKTOP RENDERER, DRIVEN AS A REAL SCRIPT IN A REAL DOM.
 *
 * ★ WHY THIS FILE EXISTS. Until it did, the desktop shell had NO automated test at all, and
 * every renderer defect the published artifact ever shipped was caught the same way: by driving
 * its real script in a document and looking at what it drew. Type-checking a renderer proves
 * nothing about what it renders — the artifact's worst bugs all typechecked. Each case below is
 * a sentence the shell must or must not be able to put on screen.
 *
 * ★ WHAT IS REAL HERE AND WHAT IS SCRIPTED, stated exactly, because a harness that STANDS IN
 * for the thing under test cannot verify it.
 *   REAL: `src/renderer.ts`, bundled by esbuild the same way `npm run build` bundles it, and
 *         executed in jsdom against the shipping `index.html`. REAL: every line of
 *         `@interego/workspace-client` — the roster fold, the grant verification, the chain
 *         walk, the canvas outcomes, the Turtle readers. Nothing is stubbed inside them.
 *   SCRIPTED: exactly one thing, `window.interego`, which in the app is an IPC channel to the
 *         main process and beyond it the network. The relay is a genuinely external dependency
 *         and it is NOT verified here — it is verified against the live fleet by
 *         `applications/shared-workspace/tools/drive-membership-live.ts`, which runs the same
 *         module functions with two real identities and two real pods. The payload shapes below
 *         were taken from that run's output, not invented.
 *
 * ★ THE BUNDLE IS BUILT HERE RATHER THAN READ FROM `dist/`. The suite tests built output, and a
 * stale `dist/` has twice hidden a change in this repo — once by hiding a fix and once by
 * hiding a removal. Bundling in the test makes a stale renderer impossible. The MODULE still
 * comes from its own `dist/` (esbuild follows the package `exports`), which is the same
 * arrangement every other test here runs under: run
 * `npm run build --workspace @interego/workspace-client` first.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { build } from 'esbuild';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DESKTOP = join(ROOT, 'applications/shared-workspace/desktop');
const RELAY = 'https://relay.interego.xwisee.com';

const POD_A = 'u-eth-8f3b8e939600';        // the convener, from the live run
const POD_B = 'u-eth-e9dfa2a9e44f';        // the member, from the live run
const WEBID = (p: string): string => 'https://identity.interego.xwisee.com/users/' + p + '/profile#me';
const SLUG = 'drive-demo';
const WS = RELAY + '/ns/' + POD_A + '/' + SLUG;
const SHAPE = RELAY + '/ns/' + POD_A + '/' + SLUG + '-shapes';
const ROLES = RELAY + '/ns/' + POD_A + '/' + SLUG + '-roles';
const GRANT_A = WS + '-grant-' + POD_A;
const GRANT_B = WS + '-grant-' + POD_B;
const ACC = (pod: string): string => RELAY + '/ns/' + pod + '/' + POD_A + '--' + SLUG + '-acceptance';
const STREAM = (pod: string): string => RELAY + '/ns/' + pod + '/' + POD_A + '--' + SLUG + '-stream';
const CANVAS = (pod: string): string => RELAY + '/ns/' + pod + '/' + POD_A + '--' + SLUG + '-canvas';
/** Descriptor URLs come back as the fleet-internal host. Nothing may ever fetch one. */
const DESC = (pod: string, n: number): string => 'http://css.railway.internal:3456/' + pod + '/context-graphs/' + n + '.ttl';

/** A TriG document shaped like the relay's: descriptor-level triples, then the signed block. */
const trig = (iri: string, body: string): string =>
  '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix dct: <http://purl.org/dc/terms/> .\n'
  + '<urn:iep:descriptor> dct:title "DESCRIPTOR LEVEL — outside the signed block" .\n'
  + '<' + iri + '> {\n' + body + '\n}\n';

let bundle = '';
beforeAll(async () => {
  const out = await build({
    entryPoints: [join(DESKTOP, 'src/renderer.ts')],
    bundle: true, format: 'iife', platform: 'browser', target: 'es2020', write: false,
    logLevel: 'silent',
  });
  bundle = (out.outputFiles[0] as { text: string }).text;
}, 60_000);

// ── the scripted relay ───────────────────────────────────────────────────────

interface Doc { readonly graph: string; readonly cid: string; readonly url: string; readonly content: string; readonly validFrom?: string; readonly supersedes?: readonly string[]; readonly authorship?: unknown }

/**
 * A pod, as the relay reports one: a set of published documents, addressable by graph IRI.
 *
 * Deliberately a store rather than a per-call table of answers — a table lets a test assert an
 * outcome the substrate could never produce, which is how a green renderer test can coexist
 * with a broken client.
 */
class Pod {
  readonly docs: Doc[] = [];
  constructor(readonly name: string) {}
  put(d: Doc): this { this.docs.push(d); return this; }
  headOf(graph: string): Doc | undefined {
    const all = this.docs.filter((d) => d.graph === graph);
    return all.length ? all[all.length - 1] : undefined;
  }
}

interface Scripted {
  readonly pods: Map<string, Pod>;
  inbox: Record<string, unknown>[];
  /** Per-tool overrides for the failure paths, which a happy store cannot produce. */
  fail: Map<string, (input: Record<string, unknown>) => unknown>;
  calls: { name: string; input: Record<string, unknown> }[];
  writeEligible: boolean;
}

function scripted(): Scripted {
  const a = new Pod(POD_A);
  const b = new Pod(POD_B);
  a.put({ graph: SHAPE, cid: 'cid-shape', url: DESC(POD_A, 1), content: trig(SHAPE, '<' + SHAPE + '#EntryShape> a <http://www.w3.org/ns/shacl#NodeShape> .') });
  a.put({ graph: ROLES, cid: 'cid-roles', url: DESC(POD_A, 2), content: trig(ROLES, '') });
  a.put({
    graph: WS, cid: 'cid-ws', url: DESC(POD_A, 3),
    authorship: { signedBy: 'did:ethr:0xA', authorshipVerified: true },
    content: trig(WS, '<' + WS + '> a wsp:Workspace ; dct:title "Live drive" ;\n'
      + '  wsp:convener <' + WEBID(POD_A) + '> ;\n'
      + '  wsp:roleProfile <' + ROLES + '> ;\n'
      + '  wsp:entryShape <' + SHAPE + '> ;\n'
      + '  wsp:grantCapability <' + ROLES + '#Convene> .'),
  });
  const grant = (iri: string, pod: string, role: string, cid: string, n: number): Doc => ({
    graph: iri, cid, url: DESC(POD_A, n),
    content: trig(iri, '<' + iri + '> a wsp:MembershipGrant ; wsp:workspace <' + WS + '> ;\n'
      + '  wsp:grantedTo <' + WEBID(pod) + '> ; wsp:role <' + ROLES + '#' + role + '> .'),
  });
  a.put(grant(GRANT_A, POD_A, 'Convener', 'cid-grant-a', 4));
  a.put(grant(GRANT_B, POD_B, 'Contributor', 'cid-grant-b', 5));
  const acceptance = (pod: string, grantIri: string, grantCid: string, n: number): Doc => ({
    graph: ACC(pod), cid: 'cid-acc-' + pod, url: DESC(pod, n),
    authorship: { signedBy: 'did:ethr:0x' + pod.slice(-4), authorshipVerified: true },
    content: trig(ACC(pod), '<' + ACC(pod) + '> a wsp:MembershipAcceptance ; wsp:workspace <' + WS + '> ;\n'
      + '  wsp:member <' + WEBID(pod) + '> ; wsp:accepts <' + grantIri + '> ;\n'
      + '  wsp:acceptsCid "' + grantCid + '" ; wsp:stream <' + STREAM(pod) + '> .'),
  });
  a.put(acceptance(POD_A, GRANT_A, 'cid-grant-a', 6));
  b.put(acceptance(POD_B, GRANT_B, 'cid-grant-b', 20));
  return {
    pods: new Map([[POD_A, a], [POD_B, b]]),
    inbox: [], fail: new Map(), calls: [], writeEligible: true,
  };
}

/** The role table, served as Turtle at a relay `/ns/` IRI — one hop, no HTML alternate. */
const ROLE_TURTLE = '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .\n'
  + '<' + ROLES + '#Read> a wsp:Capability ; rdfs:label "Read the channel" ; rdfs:comment "Fold every log." .\n'
  + '<' + ROLES + '#Post> a wsp:Capability ; rdfs:label "Post to the channel" ; rdfs:comment "Append to your own log." .\n'
  + '<' + ROLES + '#Convene> a wsp:Capability ; rdfs:label "Invite and revoke" ; rdfs:comment "Publish grants." .\n'
  + '<' + ROLES + '#Convener> a wsp:Role ; rdfs:label "Convener" ; rdfs:comment "Holds the pod grants are read from." ;\n'
  + '  wsp:permits <' + ROLES + '#Read>, <' + ROLES + '#Post>, <' + ROLES + '#Convene> .\n'
  + '<' + ROLES + '#Contributor> a wsp:Role ; rdfs:label "Contributor" ; rdfs:comment "Reads and writes their own log." ;\n'
  + '  wsp:permits <' + ROLES + '#Read>, <' + ROLES + '#Post> .\n';

function tool(s: Scripted, viewerPod: string, name: string, input: Record<string, unknown>): unknown {
  s.calls.push({ name, input });
  const override = s.fail.get(name);
  if (override) { const r = override(input); if (r !== undefined) return r; }
  const podOf = (n: unknown): Pod | undefined => s.pods.get(String(n ?? viewerPod));
  switch (name) {
    case 'get_pod_status': {
      const pod = input['pod_url'] ? String(input['pod_url']).replace(/\/$/, '').split('/').pop() as string : viewerPod;
      return {
        pod: 'http://css.railway.internal:3456/' + pod + '/',
        displayName: null, css: 'http://css.railway.internal:3456/',
        registry: { owner: WEBID(pod) },
        delegationRegistry: { owner: WEBID(pod), rows: [{ agent: 'did:ethr:0x1' }] },
        sessionAgent: { did: 'did:ethr:0xsession', scope: 'ReadWrite' },
      };
    }
    case 'verify_agent':
      return { verified: false, enforcement: { basis: 'registry-only', scope: 'ReadWrite', writeEligible: s.writeEligible, note: 'no signed delegation credential anchors this agent' } };
    case 'resolve_webfinger': {
      const pod = /acct:([^@]+)@/.exec(String(input['resource']))?.[1] ?? '';
      if (!s.pods.has(pod)) return { error: 'not_found', message: 'no such account' };
      return {
        subject: String(input['resource']),
        webId: RELAY + '/agents/' + pod,
        links: [
          { rel: 'http://webfinger.net/rel/profile-page', href: 'http://css.railway.internal:3456/' + pod + '/profile/card' },
          { rel: 'http://www.w3.org/ns/ldp#inbox', href: 'http://css.railway.internal:3456/' + pod + '/inbox/' },
        ],
      };
    }
    case 'read_inbox':
      return { inbox: 'x', count: s.inbox.length, items: s.inbox.slice(0, Number(input['limit'] ?? 50)) };
    case 'get_current_head': {
      const pod = podOf(input['pod_name']);
      const urn = String(input['urn']);
      const d = pod?.headOf(urn);
      if (!d) return { urn, podUrl: 'http://css.railway.internal:3456/' + String(input['pod_name']) + '/', message: 'No descriptor on this pod describes the requested urn.' };
      return { urn, podUrl: 'http://css.railway.internal:3456/' + String(input['pod_name']) + '/', head: { descriptorUrl: d.url, cid: d.cid } };
    }
    case 'get_descriptor': {
      for (const p of s.pods.values()) for (const d of p.docs) if (d.url === String(input['url'])) {
        return { graph: { content: d.content }, authorship: d.authorship ?? null };
      }
      return { error: 'not_found', message: 'no descriptor at that url' };
    }
    case 'discover_context': {
      const podName = String(input['pod_name']);
      const pod = s.pods.get(podName);
      if (!pod) return { pod: 'http://css.railway.internal:3456/' + podName + '/', entries: [] };
      const graph = input['graph_iri'] ? String(input['graph_iri']) : null;
      const docs = graph ? pod.docs.filter((d) => d.graph === graph) : pod.docs;
      return {
        pod: 'http://css.railway.internal:3456/' + podName + '/',
        entries: docs.map((d) => ({
          descriptorUrl: d.url, cid: d.cid, validFrom: d.validFrom ?? '2026-08-06T12:00:00.000Z',
          describes: [d.graph], supersedes: d.supersedes ? d.supersedes.slice() : [],
        })),
      };
    }
    case 'dereference':
      return String(input['iri']) === ROLES
        ? { status: 'ok', contentType: 'text/turtle', representation: ROLE_TURTLE }
        : { status: 'error', httpStatus: 404 };
    case 'publish_context': {
      const pod = s.pods.get(viewerPod);
      if (!pod) return { error: 'scope_violation', code: 403, message: 'agent is not registered on this pod' };
      const graph = String(input['graph_iri']);
      const prior = pod.headOf(graph);
      if (input['if_match'] && prior && input['if_match'] !== prior.cid && input['if_match'] !== prior.url) {
        return {
          error: 'precondition_failed', code: 412,
          message: 'The revision you asserted is not the current head.',
          expected: { cid: String(input['if_match']) },
          currentHead: { cid: prior.cid, descriptorUrl: prior.url },
          retryHint: 'Re-read the manifest, or call get_current_head { urn, pod_name } then resend publish_context with the returned head cid as if_match.',
        };
      }
      const n = 1000 + pod.docs.length;
      const url = DESC(viewerPod, n);
      pod.put({
        graph, cid: 'cid-' + n, url, content: trig(graph, String(input['graph_content']).replace(/^@prefix[^\n]*\n/gm, '')),
        validFrom: new Date(Date.parse('2026-08-06T13:00:00.000Z') + n).toISOString(),
        supersedes: prior ? [prior.url] : [],
        authorship: { signedBy: 'did:ethr:0xsession', authorshipVerified: true },
      });
      return {
        status: 'committed', descriptorUrl: url, cid: 'cid-' + n,
        precondition: input['if_match'] ? { passed: true, expectedCid: String(input['if_match']), observedCid: String(input['if_match']) } : undefined,
        supersedesPriorVersions: prior ? [prior.url] : [],
        authorship: { signed: true, signer: 'did:ethr:0xsession' },
      };
    }
    case 'notify_agent':
      return { delivered: true, channels: [{ type: 'ldn', status: 'delivered' }] };
    default:
      return { error: 'unknown_tool', message: name };
  }
}

interface Opened {
  doc: Document;
  win: Window & typeof globalThis;
  s: Scripted;
  /** What the renderer asked the model, and how often it was told to stop. */
  agent: AgentScript;
  settle: () => Promise<void>;
  /** Push a session change the way the main process does, through the listener the shell installed. */
  pushSession: (s: Record<string, unknown>) => void;
}

/**
 * What the main process would report about this machine's model providers.
 *
 * ★ SCRIPTED FOR THE SAME REASON `call` IS: it is the OTHER side of the IPC boundary, and beyond
 * it a child process on somebody's laptop. What is NOT scripted is any decision made from it — the
 * seating check, the ceiling, "have I already answered", the draft validation and the honesty rule
 * about `loggedIn: null` are all real `@interego/workspace-client` and real renderer code here.
 * The shapes below are the ones `probeClaude` actually returns; they were taken from a live run of
 * `claude auth status --json` on this machine, not invented.
 */
interface AgentScript {
  providers?: readonly Record<string, unknown>[];
  unsupported?: readonly { id: string; label: string; why: string }[];
  /** What one model turn answers with. */
  think?: (prompt: string) => { ok: boolean; text: string | null; why: string; ms: number };
  /** Every prompt the renderer sent, so a test can assert what the agent was ASKED. */
  prompts: string[];
  cancels: number;
  probeThrows?: boolean;
}

const CLAUDE_READY = {
  id: 'claude-code', label: 'Claude Code (your own Claude subscription)', installed: true,
  path: 'C:\\claude.exe', shimOnly: false, loggedIn: true, authMethod: 'claude.ai',
  account: 'brother@example.com', subscription: 'max', usable: true,
  why: 'Signed in as brother@example.com on a max subscription (claude.ai).',
} as const;

/** The measured not-installed shape: `loggedIn` is null, NOT false. */
const CLAUDE_ABSENT = {
  id: 'claude-code', label: 'Claude Code (your own Claude subscription)', installed: false,
  path: null, shimOnly: false, loggedIn: null, authMethod: null, account: null,
  subscription: null, usable: false,
  why: 'The Claude Code CLI was not found on this machine.',
} as const;

/** Boot a window with the shipping HTML, the real bundle, and one scripted bridge. */
async function open(opts: { viewer?: string; setup?: (s: Scripted) => void; coldStartMs?: number; agent?: AgentScript } = {}): Promise<Opened> {
  const viewer = opts.viewer ?? POD_A;
  const agent: AgentScript = { prompts: [], cancels: 0, ...opts.agent };
  const s = scripted();
  opts.setup?.(s);
  const html = readFileSync(join(DESKTOP, 'index.html'), 'utf8');
  const dom = new JSDOM('<!doctype html><html><head><meta charset="utf-8"></head><body>' + html + '</body></html>', {
    runScripts: 'outside-only', url: 'file:///app/index.html', pretendToBeVisual: true,
  });
  const win = dom.window as unknown as Window & typeof globalThis;
  /**
   * ★ THE CLOCK IS COMPRESSED; NO LOGIC IS REPLACED.
   *
   * The shell waits real seconds on purpose — 700 ms between readback polls, so a write is
   * confirmed by reading it back rather than by taking the acknowledgement for it. Waiting
   * those seconds here would make a full run minutes long, and mocking the waits away would
   * delete the very behaviour under test. So `setTimeout` is capped at 1 ms: every wait still
   * HAPPENS, in the same order, with the same interleaving — it just happens fast.
   *
   * `setInterval` is deliberately NOT touched. The watch's 45 s refetch and the boot
   * checklist's 1 s tick are both intervals, and compressing them would spin the poll
   * continuously and stop `settle()` below from ever seeing the shell go quiet.
   */
  const realSetTimeout = win.setTimeout.bind(win) as (fn: () => void, ms?: number) => number;
  (win as unknown as Record<string, unknown>)['setTimeout'] = (fn: () => void, ms?: number): number =>
    realSetTimeout(fn, Math.min(ms ?? 0, 1));
  let sessionListener: ((x: unknown) => void) | null = null;
  (win as unknown as Record<string, unknown>)['interego'] = {
    describe: async () => ({
      relay: RELAY, identityServer: 'https://identity.interego.xwisee.com',
      secretStore: true, hasStoredWallet: true, signedInAs: null,
      session: { state: 'signed-out', pod: null, method: null, expiresAt: null, renewable: false, why: null },
      watchDescription: 're-read on a timer, not pushed',
    }),
    signInWithWallet: async () => {
      sessionListener?.({ state: 'live', pod: viewer, method: 'wallet', expiresAt: Date.now() + 3600_000, renewable: true, why: null });
      return { pod: viewer, displayName: null, method: 'wallet', address: '0x1', mintedNewKey: false };
    },
    signInWithBrowser: async () => ({ pod: viewer, displayName: null, method: 'browser' }),
    call: async (name: string, input: Record<string, unknown>) => {
      // The measured cold start: the FIRST pod-aware call provisions a pod and took 16.7 s on
      // the live fleet for a fresh wallet. Modelled here because the sentence the shell shows
      // during it only exists while it is in flight — a scripted relay that answers instantly
      // cannot exhibit the state the anti-spinner rule is about. This delay is the test's own
      // clock and is not compressed: the window's `setTimeout` is, this is node's.
      if (opts.coldStartMs && name === 'get_pod_status' && !s.calls.some((c) => c.name === 'get_pod_status')) {
        await new Promise((r) => { setTimeout(r, opts.coldStartMs); });
      }
      const payload = tool(s, viewer, name, input);
      return { ok: true, payload };
    },
    sessionStatus: async () => ({ state: 'live', pod: viewer, method: 'wallet', expiresAt: null, renewable: true, why: null }),
    renewSession: async () => ({ ok: true, session: { state: 'live', pod: viewer, method: 'wallet', expiresAt: null, renewable: true, why: null } }),
    onSessionChanged: (fn: (x: unknown) => void) => { sessionListener = fn; },
    agentProbe: async () => {
      if (agent.probeThrows) throw new Error('the probe blew up');
      return { providers: agent.providers ?? [CLAUDE_READY], unsupported: agent.unsupported ?? [] };
    },
    agentThink: async (prompt: string) => {
      agent.prompts.push(prompt);
      return agent.think ? agent.think(prompt) : { ok: true, text: 'A drafted reply.', why: 'ok', ms: 1200 };
    },
    agentCancel: async () => { agent.cancels++; return { stopped: 0 }; },
  };
  win.eval(bundle);
  /**
   * Drain until the shell stops issuing calls, rather than sleeping a fixed amount.
   *
   * A fixed sleep makes the result depend on how fast the machine is, which is how a suite
   * comes to be green on a laptop and red in CI. This waits for QUIET: several consecutive
   * rounds in which no new tool call was made. The rounds are real millisecond ticks because
   * the shell's waits are real timers (compressed above), not microtasks.
   */
  const settle = async (): Promise<void> => {
    let quiet = 0;
    let before = s.calls.length;
    for (let i = 0; i < 400 && quiet < 6; i++) {
      await new Promise((r) => { setTimeout(r, 4); });
      if (s.calls.length === before) quiet++;
      else { quiet = 0; before = s.calls.length; }
    }
  };
  await settle();
  return {
    doc: dom.window.document, win, s, agent, settle,
    pushSession: (next) => { sessionListener?.(next); },
  };
}

const text = (doc: Document, sel: string): string => (doc.querySelector(sel)?.textContent ?? '');
const click = (doc: Document, id: string): void => { (doc.getElementById(id) as HTMLElement).click(); };
async function signInAndSettle(o: Opened): Promise<void> {
  click(o.doc, 'signin-wallet');
  await o.settle();
}
/**
 * Open a workspace the way a person does — by pasting its IRI.
 *
 * Needed wherever the scenario deliberately breaks the read that boot uses to CHOOSE one: a
 * viewer with no verified acceptance is correctly left in the lobby, so a test about the
 * channel has to say which channel.
 */
async function openByIri(o: Opened, iri: string): Promise<void> {
  (o.doc.getElementById('wsopen') as HTMLInputElement).value = iri;
  click(o.doc, 'openbtn');
  await o.settle();
}

// ── the cases ────────────────────────────────────────────────────────────────

describe('boot: the shell reaches a lobby without inventing anything', () => {
  it('names the pod it resolved rather than a display name', async () => {
    const o = await open();
    await signInAndSettle(o);
    expect(text(o.doc, '#whoami')).toBe(POD_A);
    expect(o.doc.getElementById('signin')?.hasAttribute('hidden')).toBe(true);
  });

  it('says which pod-aware call is slow instead of showing a bare spinner', async () => {
    const o = await open({ coldStartMs: 250 });
    click(o.doc, 'signin-wallet');
    // Sampled WHILE it is waiting, not after: the sentence naming the cold start belongs to the
    // `wait` state and is correctly replaced by the outcome once the call returns. Asserting
    // after settle would be asserting that the shell never finished.
    let seen = false;
    for (let i = 0; i < 300 && !seen; i++) {
      await new Promise((r) => { setTimeout(r, 2); });
      seen = /provisions a pod/.test(text(o.doc, '#steps') + text(o.doc, '#lobbysteps'));
    }
    expect(seen, 'the cold-start sentence was never on screen').toBe(true);
    await o.settle();
    // The elapsed count is what makes a 16 s wait legible rather than broken-looking.
    expect(text(o.doc, '#lobbysteps')).toMatch(/\d+(\.\d)?s/);
  });

  it('prints the handle it composed AND the result of resolving it', async () => {
    const o = await open();
    await signInAndSettle(o);
    const me = text(o.doc, '#mebody');
    expect(me).toContain('acct:' + POD_A + '@relay.interego.xwisee.com');
    // Composed is not the same as read, and the shell has to say which it did.
    expect(me).toMatch(/Resolved:/);
  });

  it('does not claim a handle resolves when the lookup did not return this pod', async () => {
    const o = await open({ setup: (s) => {
      s.fail.set('resolve_webfinger', (input) => (String(input['resource']).includes(POD_A)
        ? { subject: String(input['resource']), links: [{ rel: 'http://webfinger.net/rel/profile-page', href: 'http://css.railway.internal:3456/u-eth-somebodyelse/profile/card' }] }
        : undefined));
    } });
    await signInAndSettle(o);
    const me = text(o.doc, '#mebody');
    expect(me).toMatch(/resolving it did not return you/);
    expect(me).toContain('u-eth-somebodyelse');
    expect(me).not.toMatch(/^Resolved:/m);
  });
});

describe('the inbox is an unverified claim, and the shell renders it as one', () => {
  it('renders an offer whose grant verifies as verified, with the checks that ran', async () => {
    const o = await open({ viewer: POD_B, setup: (s) => {
      s.inbox = [{ type: 'Offer', about: GRANT_B, summary: 'Invitation to Live drive', actor: 'did:ethr:0xA' }];
      // B has not accepted yet in this scenario: drop the acceptance so the offer is live.
      const b = s.pods.get(POD_B) as Pod;
      b.docs.length = 0;
    } });
    await signInAndSettle(o);
    const list = text(o.doc, '#invitelist');
    expect(list).toContain('verified on pod ' + POD_A);
    expect(list).toContain('It names your own WebID as grantee');
    expect(list).toContain('the same pod the grant is on');
    expect(o.doc.querySelector('#invitelist button')?.textContent).toMatch(/Accept/);
  });

  it('★ REFUSES a grant delivered into the inbox that names somebody else', async () => {
    const o = await open({ viewer: POD_B, setup: (s) => {
      // The measured attack: the inbox is world-writable, so anyone can post any URL into it.
      s.inbox = [{ type: 'Offer', about: GRANT_A, summary: 'Totally legitimate invitation', actor: 'did:ethr:0xhostile' }];
      const b = s.pods.get(POD_B) as Pod;
      b.docs.length = 0;
    } });
    await signInAndSettle(o);
    const list = text(o.doc, '#invitelist');
    expect(list).toContain('not confirmed');
    expect(list).toMatch(/addressed to pod u-eth-8f3b8e939600, and you are u-eth-e9dfa2a9e44f/);
    // No Accept control at all — a refusal that still offers the action is not a refusal.
    expect(o.doc.querySelector('#invitelist button')?.textContent ?? '').not.toMatch(/Accept/);
  });

  it('does not render "nobody invited you" when the inbox read FAILED', async () => {
    const o = await open({ setup: (s) => { s.fail.set('read_inbox', () => ({ error: 'upstream', message: 'the pod did not answer' })); } });
    await signInAndSettle(o);
    const list = text(o.doc, '#invitelist');
    expect(list).not.toMatch(/No offers in your inbox/);
    expect(list).toContain('the pod did not answer');
  });
});

describe('the roster: two documents on two pods, and every non-seat carries its reason', () => {
  it('seats both members and names the test that seated them', async () => {
    const o = await open();
    await signInAndSettle(o);
    const roster = text(o.doc, '#roster');
    expect(roster).toContain(POD_A);
    expect(roster).toContain(POD_B);
    expect(roster).toMatch(/pins revision .*, which is the head/);
    expect(roster).toContain('Convener');
    expect(roster).toContain('Contributor');
  });

  it('reads role LABELS from the published table and never from an IRI fragment', async () => {
    const o = await open({ setup: (s) => { s.fail.set('dereference', () => ({ status: 'error', httpStatus: 503 })); } });
    await signInAndSettle(o);
    const roster = text(o.doc, '#roster');
    // The fragment says "#Convener". Rendering that as a label was a real defect.
    expect(roster).toContain('role not resolved');
    expect(roster).not.toContain('Convener');
    // The long form is the row's own tooltip, and it has to explain WHY the fragment is not
    // being shown — otherwise "role not resolved" reads as a bug rather than as a refusal.
    const tip = [...o.doc.querySelectorAll('#roster [title]')].map((n) => n.getAttribute('title') ?? '').join(' ');
    expect(tip).toMatch(/role profile has not resolved/);
  });

  it('★ says WHY a grant does not seat somebody instead of leaving the row bare', async () => {
    const o = await open({ setup: (s) => {
      // B was granted and has published nothing: the ordinary "invited" state, which used to
      // render identically to "their acceptance could not be read".
      (s.pods.get(POD_B) as Pod).docs.length = 0;
    } });
    await signInAndSettle(o);
    const roster = text(o.doc, '#roster');
    expect(roster).toContain('granted, but no acceptance published on their pod yet');
    expect(roster).toContain('invited');
  });

  it('★ tells an unseated viewer which of the two halves is missing, from the rows it holds', async () => {
    const o = await open({ viewer: POD_B, setup: (s) => { (s.pods.get(POD_B) as Pod).docs.length = 0; } });
    await signInAndSettle(o);
    // With no acceptance of their own, boot correctly leaves B in the lobby — being in no
    // workspace is an ordinary state, not an error — so the channel is opened by IRI.
    await openByIri(o, WS);
    const roster = text(o.doc, '#roster');
    expect(roster).toContain('You are writing, and you are not on the roster');
    // The contradicting record is in scope: a grant DOES name this pod. Saying "no grant names
    // your pod" while showing that row above it is the defect this asserts against.
    expect(roster).toContain('does name your pod, and it does not seat you');
    expect(roster).not.toMatch(/This read found no grant naming your pod/);
  });

  it('stops seating a member whose grant was revoked, and says their words are untouched', async () => {
    const o = await open({ setup: (s) => {
      const a = s.pods.get(POD_A) as Pod;
      a.put({ graph: GRANT_B, cid: 'cid-grant-b2', url: DESC(POD_A, 99),
        content: trig(GRANT_B, '<' + GRANT_B + '> a wsp:MembershipGrant ; wsp:workspace <' + WS + '> ;\n'
          + '  wsp:grantedTo <' + WEBID(POD_B) + '> ; wsp:role <' + ROLES + '#Contributor> ; wsp:revoked true .') });
    } });
    await signInAndSettle(o);
    const roster = text(o.doc, '#roster');
    expect(roster).toContain('revoked');
    expect(roster).toContain('revoking a grant cannot reach it');
  });
});

describe('the stream: five states for a body, and they do not look the same', () => {
  it('renders an entry read out of the SIGNED region', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_A) as Pod).put({
        graph: STREAM(POD_A), cid: 'cid-e0', url: DESC(POD_A, 30),
        content: trig(STREAM(POD_A), '<' + STREAM(POD_A) + '/e/0> a wsp:Entry ; wsp:workspace <' + WS + '> ;\n'
          + '  wsp:seq "0"^^<http://www.w3.org/2001/XMLSchema#nonNegativeInteger> ; dct:description "hello from the signed block" .'),
      });
    } });
    await signInAndSettle(o);
    expect(text(o.doc, '#stream')).toContain('hello from the signed block');
  });

  it('★ never reads a body out of the DESCRIPTOR level, only the signed block', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_A) as Pod).put({
        graph: STREAM(POD_A), cid: 'cid-e0', url: DESC(POD_A, 30),
        // The description sits OUTSIDE the signed region — bytes nobody signed.
        content: '@prefix dct: <http://purl.org/dc/terms/> .\n'
          + '<urn:iep:descriptor> dct:description "UNSIGNED — must never be rendered as the message" .\n'
          + '<' + STREAM(POD_A) + '> {\n<' + STREAM(POD_A) + '/e/0> a <urn:x> .\n}\n',
      });
    } });
    await signInAndSettle(o);
    const stream = text(o.doc, '#stream');
    expect(stream).not.toContain('UNSIGNED');
    expect(stream).toContain('carries no dct:description');
  });

  it('distinguishes "carries no description" from "carries an empty one"', async () => {
    const o = await open({ setup: (s) => {
      const a = s.pods.get(POD_A) as Pod;
      a.put({ graph: STREAM(POD_A), cid: 'c1', url: DESC(POD_A, 31), validFrom: '2026-08-06T10:00:00.000Z',
        content: trig(STREAM(POD_A), '<' + STREAM(POD_A) + '/e/0> a wsp:Entry ; dct:description "" .') });
    } });
    await signInAndSettle(o);
    const stream = text(o.doc, '#stream');
    expect(stream).toContain('carries a dct:description, and it is empty');
    expect(stream).not.toContain('carries no dct:description');
  });

  it('★ does not report an unreadable log as an empty one', async () => {
    const o = await open({ setup: (s) => {
      s.fail.set('discover_context', (input) => (input['graph_iri'] === STREAM(POD_B)
        ? { error: 'upstream_error', message: 'that pod did not answer' } : undefined));
    } });
    await signInAndSettle(o);
    const stream = text(o.doc, '#stream');
    expect(stream).toContain('one member being unreachable is not the channel being down');
    expect(stream).not.toMatch(new RegExp('member on ' + POD_B + ' has written nothing'));
  });

  it('marks an entry whose own wsp:workspace is a DIFFERENT workspace', async () => {
    const other = RELAY + '/ns/' + POD_A + '/some-other-space';
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_A) as Pod).put({
        graph: STREAM(POD_A), cid: 'c1', url: DESC(POD_A, 32),
        content: trig(STREAM(POD_A), '<' + STREAM(POD_A) + '/e/0> a wsp:Entry ; wsp:workspace <' + other + '> ;\n'
          + '  dct:description "written under a different record" .'),
      });
    } });
    await signInAndSettle(o);
    const stream = text(o.doc, '#stream');
    expect(stream).toContain('written under a different record');
    expect(stream).toContain('not this one');
  });
});

describe('posting: the acknowledgement is not the check', () => {
  it('reports the shape the WORKSPACE declared, not one the shell chose', async () => {
    const o = await open();
    await signInAndSettle(o);
    (o.doc.getElementById('composer') as HTMLTextAreaElement).value = 'a real entry';
    click(o.doc, 'send');
    await o.settle();
    expect(text(o.doc, '#postresult')).toContain(SHAPE);
    const sent = o.s.calls.filter((c) => c.name === 'publish_context').pop();
    expect(sent?.input['conforms_to_shapes']).toEqual([SHAPE]);
  });

  it('★ does not say "Posted" when the entry never reads back', async () => {
    const o = await open({ setup: (s) => {
      // The relay takes the write and the log never shows it — the case where an optimistic
      // shell says "Posted" on the strength of the acknowledgement alone.
      s.fail.set('publish_context', () => ({ status: 'accepted', descriptorUrl: DESC(POD_A, 777), cid: 'cid-777' }));
    } });
    await signInAndSettle(o);
    (o.doc.getElementById('composer') as HTMLTextAreaElement).value = 'never lands';
    click(o.doc, 'send');
    // The readback polls 34 times at 700 ms; the assertion is on the intermediate state, which
    // is the one that must not read as success.
    await o.settle();
    const panel = text(o.doc, '#postresult');
    expect(panel).toContain('Confirming it is readable back rather than taking the acknowledgement for it');
    expect(panel).not.toContain('Posted to your pod');
    // The text stays in the composer: clearing it before confirmation loses what they wrote.
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('never lands');
  });

  it('holds the composer shut while the record has not been read', async () => {
    const o = await open({ setup: (s) => {
      s.fail.set('get_current_head', (input) => (input['urn'] === WS
        ? { error: 'upstream_error', message: 'the workspace record could not be resolved' } : undefined));
    } });
    await signInAndSettle(o);
    // The same read boot uses to CHOOSE a workspace is the one being broken here, so boot
    // rightly opens none; the channel is opened by IRI to reach the state under test.
    await openByIri(o, WS);
    expect((o.doc.getElementById('send') as HTMLButtonElement).disabled).toBe(true);
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).placeholder)
      .toMatch(/which shape a post is validated against is not established/);
  });
});

describe('the canvas: "Saved" means the head is YOURS', () => {
  it('offers Create only when the relay SAID nothing is published there', async () => {
    const o = await open();
    await signInAndSettle(o);
    expect(text(o.doc, '#save')).toBe('Create on your pod');
    expect((o.doc.getElementById('save') as HTMLButtonElement).disabled).toBe(false);
  });

  it('★ refuses to offer Create when the read did not RESOLVE', async () => {
    const o = await open({ setup: (s) => {
      // Neither a head nor a reason: a read this client cannot interpret. Offering an
      // unconditional overwrite here would clobber whatever is actually at the IRI.
      s.fail.set('get_current_head', (input) => (input['urn'] === CANVAS(POD_A) ? { urn: input['urn'] } : undefined));
    } });
    await signInAndSettle(o);
    expect((o.doc.getElementById('save') as HTMLButtonElement).disabled).toBe(true);
    expect(text(o.doc, '#canvasresult')).toContain('will not offer to create or overwrite on the strength of a read it could not parse');
  });

  it('says Saved after a write that becomes the readable head', async () => {
    const o = await open();
    await signInAndSettle(o);
    (o.doc.getElementById('canvas') as HTMLTextAreaElement).value = 'first revision';
    click(o.doc, 'save');
    await o.settle();
    expect(text(o.doc, '#canvasresult')).toContain('Saved — your revision is the head');
  });

  it('★ does NOT say Saved when somebody else\'s revision became the head', async () => {
    const o = await open({ setup: (s) => {
      // The write is accepted and returns a descriptor; a concurrent writer's revision is what
      // the head read then reports. "The CID changed" is satisfied — and it is not your write.
      let published = false;
      s.fail.set('publish_context', (input) => {
        if (String(input['graph_iri']) !== CANVAS(POD_A) || published) return undefined;
        published = true;
        const a = s.pods.get(POD_A) as Pod;
        a.put({ graph: CANVAS(POD_A), cid: 'cid-theirs', url: DESC(POD_A, 555), content: trig(CANVAS(POD_A), '<' + CANVAS(POD_A) + '> dct:description "theirs" .') });
        return { status: 'committed', descriptorUrl: DESC(POD_A, 444), cid: 'cid-mine' };
      });
    } });
    await signInAndSettle(o);
    (o.doc.getElementById('canvas') as HTMLTextAreaElement).value = 'mine';
    click(o.doc, 'save');
    await o.settle();
    const panel = text(o.doc, '#canvasresult');
    expect(panel).not.toContain('Saved — your revision is the head');
    expect(panel).toMatch(/Accepted, but not yet readable|The head moved, but not to your write/);
  });

  it('renders a 412 with both revisions and offers the merge the retryHint describes', async () => {
    const o = await open({ setup: (s) => {
      const a = s.pods.get(POD_A) as Pod;
      a.put({ graph: CANVAS(POD_A), cid: 'cid-head-now', url: DESC(POD_A, 40), content: trig(CANVAS(POD_A), '<' + CANVAS(POD_A) + '> dct:description "loaded" .') });
    } });
    await signInAndSettle(o);
    // Move the head under the panel, then save with the revision the panel is still holding.
    (o.s.pods.get(POD_A) as Pod).put({ graph: CANVAS(POD_A), cid: 'cid-head-moved', url: DESC(POD_A, 41), content: trig(CANVAS(POD_A), '<' + CANVAS(POD_A) + '> dct:description "somebody else" .') });
    (o.doc.getElementById('canvas') as HTMLTextAreaElement).value = 'my edit';
    click(o.doc, 'save');
    await o.settle();
    const panel = text(o.doc, '#canvasresult');
    expect(panel).toContain('412 precondition_failed');
    expect(panel).toContain('cid-head-now');       // expected.cid — what was asserted
    expect(panel).toContain('cid-head-moved');     // currentHead.cid — what is actually there
    expect(panel).toContain('retryHint');
    expect([...o.doc.querySelectorAll('#canvasresult button')].map((b) => b.textContent)).toContain('Merge forward');
  });

  it('merges forward onto the head the retryHint names', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_A) as Pod).put({ graph: CANVAS(POD_A), cid: 'cid-head-now', url: DESC(POD_A, 40), content: trig(CANVAS(POD_A), '<' + CANVAS(POD_A) + '> dct:description "loaded" .') });
    } });
    await signInAndSettle(o);
    (o.s.pods.get(POD_A) as Pod).put({ graph: CANVAS(POD_A), cid: 'cid-head-moved', url: DESC(POD_A, 41), content: trig(CANVAS(POD_A), '<' + CANVAS(POD_A) + '> dct:description "somebody else" .') });
    (o.doc.getElementById('canvas') as HTMLTextAreaElement).value = 'my edit';
    click(o.doc, 'save');
    await o.settle();
    const merge = [...o.doc.querySelectorAll('#canvasresult button')].find((b) => b.textContent === 'Merge forward') as HTMLElement;
    merge.click();
    await o.settle();
    expect(text(o.doc, '#canvasresult')).toMatch(/Saved — merged onto .* and your revision is the head/);
  });
});

describe('a lapsed session is painted over the window, never over nothing', () => {
  it('★ says the session lapsed rather than letting an empty workspace stand for one', async () => {
    const o = await open();
    await signInAndSettle(o);
    expect(o.doc.getElementById('sessionbar')?.className).toBe('live');
    // Exactly how the main process delivers it: the listener the shell installed.
    o.pushSession({
      state: 'lapsed', pod: POD_A, method: 'wallet', expiresAt: Date.now() - 1000, renewable: false,
      why: 'the relay refused to renew this session (HTTP 400): invalid_grant',
    });
    const bar = o.doc.getElementById('sessionbar') as HTMLElement;
    expect(bar.hidden).toBe(false);
    expect(bar.className).toBe('lapsed');
    const msg = text(o.doc, '#sessionmsg');
    expect(msg).toContain('This session has lapsed');
    expect(msg).toContain('invalid_grant');
    // The sentence that makes this worth a bar at all: what is on screen is not a current
    // statement about anybody's pod.
    expect(msg).toContain('not a current statement about anybody');
  });

  it('says a renewal is in progress rather than showing a lapse for it', async () => {
    const o = await open();
    await signInAndSettle(o);
    o.pushSession({ state: 'renewing', pod: POD_A, method: 'wallet', expiresAt: Date.now() + 60_000, renewable: true, why: 'the token was about to expire' });
    expect((o.doc.getElementById('sessionbar') as HTMLElement).className).toBe('renewing');
    expect(text(o.doc, '#sessionmsg')).toContain('Reads in flight are unaffected');
  });

  it('★ never invents an expiry the grant did not report', async () => {
    const o = await open();
    await signInAndSettle(o);
    o.pushSession({ state: 'live', pod: POD_A, method: 'wallet', expiresAt: null, renewable: false, why: null });
    const msg = text(o.doc, '#sessionmsg');
    expect(msg).toContain('did not report an expiry');
    expect(msg).toContain('rather than on a guessed clock');
  });

});

describe('write eligibility is a relay verdict, and it withdraws the controls', () => {
  it('★ offers nothing to write when the relay says the agent is not write-eligible', async () => {
    const o = await open({ setup: (s) => { s.writeEligible = false; } });
    await signInAndSettle(o);
    for (const id of ['send', 'save', 'stalesave', 'createbtn']) {
      expect((o.doc.getElementById(id) as HTMLButtonElement).disabled, id + ' should be disabled').toBe(true);
    }
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).placeholder).toBe('Not write-eligible on this pod.');
    expect(text(o.doc, '#writes-to')).toContain('not write-eligible');
  });
});

describe('the switcher lists what this viewer accepted, read from their own pod', () => {
  it('lists the workspace and marks it verified against the convener\'s pod', async () => {
    const o = await open();
    await signInAndSettle(o);
    const list = text(o.doc, '#wslist');
    expect(list).toContain(WS);
    expect(list).toContain('workspace-qualified name');
    // The verdict is asserted as an ELEMENT, not by word: this workspace is also the OPEN one,
    // so its badge reads "open" rather than "verified" — matching on the word would have made
    // this pass for a row that had failed verification and happened to say the word elsewhere.
    expect(o.doc.querySelector('#wslist .verdict.ok')).not.toBe(null);
    expect(o.doc.querySelector('#wslist .verdict.no')).toBe(null);
  });

  it('★ does not silently drop an acceptance that no longer seats you — it says why', async () => {
    const o = await open({ viewer: POD_B, setup: (s) => {
      // B still holds an acceptance; A revoked the grant. The acceptance is a fact about B
      // either way, so it is listed with the reason rather than dropped.
      const a = s.pods.get(POD_A) as Pod;
      a.put({ graph: GRANT_B, cid: 'cid-grant-b2', url: DESC(POD_A, 98),
        content: trig(GRANT_B, '<' + GRANT_B + '> a wsp:MembershipGrant ; wsp:workspace <' + WS + '> ;\n'
          + '  wsp:grantedTo <' + WEBID(POD_B) + '> ; wsp:role <' + ROLES + '#Contributor> ; wsp:revoked true .') });
    } });
    await signInAndSettle(o);
    const list = text(o.doc, '#wslist');
    expect(list).toContain('not verified');
    expect(list).toContain('wsp:revoked true');
    expect(list).toContain('a record you published is a fact about you either way');
  });
});

describe('nothing in the renderer dereferences a fleet-internal address', () => {
  it('★ never puts a css.railway.internal URL in an href', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_A) as Pod).put({
        graph: STREAM(POD_A), cid: 'c1', url: DESC(POD_A, 33),
        content: trig(STREAM(POD_A), '<' + STREAM(POD_A) + '/e/0> a wsp:Entry ; dct:description "x" .'),
      });
    } });
    await signInAndSettle(o);
    for (const a of [...o.doc.querySelectorAll('[href], [src]')]) {
      const v = a.getAttribute('href') ?? a.getAttribute('src') ?? '';
      expect(v).not.toContain('css.railway.internal');
    }
  });

  it('★ renders a hostile literal as text and never as markup', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_A) as Pod).put({
        graph: STREAM(POD_A), cid: 'c1', url: DESC(POD_A, 34),
        content: trig(STREAM(POD_A), '<' + STREAM(POD_A) + '/e/0> a wsp:Entry ;\n'
          + '  dct:description "<img src=x onerror=alert(1)><script>bad()</script>" .'),
      });
    } });
    await signInAndSettle(o);
    expect(o.doc.querySelectorAll('#stream img')).toHaveLength(0);
    expect(o.doc.querySelectorAll('#stream script')).toHaveLength(0);
    expect(text(o.doc, '#stream')).toContain('<img src=x onerror=alert(1)>');
  });
});

// ── the model this machine can run the user's agent on ───────────────────────

/** An entry on somebody's log, the fixture the agent cases are built from. */
const entry = (pod: string, n: number, body: string, at: string): Doc => ({
  graph: STREAM(pod), cid: 'cid-ag-' + pod + '-' + n, url: DESC(pod, 200 + n), validFrom: at,
  content: trig(STREAM(pod), '<' + STREAM(pod) + '/e/' + n + '> a wsp:Entry ; wsp:workspace <' + WS + '> ;\n'
    + '  wsp:seq "' + n + '"^^<http://www.w3.org/2001/XMLSchema#nonNegativeInteger> ; dct:description "' + body + '" .'),
});

describe('the model the agent runs on is the user\'s own, or it is absent', () => {
  it('names the account and plan it would run under', async () => {
    const o = await open();
    await signInAndSettle(o);
    const body = text(o.doc, '#modelbody');
    expect(body).toContain('brother@example.com');
    expect(body).toContain('max');
  });

  it('★ an absent CLI reports "not established", never that the user is signed out', async () => {
    // ABSENCE IS NOT EVIDENCE, and this is the exact place it would be easiest to get wrong: the
    // tool is not installed, so whether this person has a Claude subscription is not something the
    // app has ANY evidence about. Rendering `loggedIn: null` as "no" would be a statement about
    // somebody's account made from a filesystem check that never looked at their account.
    const o = await open({ agent: { prompts: [], cancels: 0, providers: [CLAUDE_ABSENT] } });
    await signInAndSettle(o);
    const body = text(o.doc, '#modelbody');
    expect(body).toContain('not established');
    expect(body).toContain('not found on this machine');
    expect(body).not.toContain('signed in\tno');
  });

  it('★ says Codex is unsupported here rather than offering it', async () => {
    const o = await open({ agent: { prompts: [], cancels: 0, unsupported: [{ id: 'codex', label: 'OpenAI Codex', why: 'Not supported by this app. Only Claude Code has been measured end to end.' }] } });
    await signInAndSettle(o);
    expect(text(o.doc, '#modelbody')).toContain('Only Claude Code has been measured end to end');
  });

  it('★ a probe that throws does not leave a claim about the machine on screen', async () => {
    const o = await open({ agent: { prompts: [], cancels: 0, probeThrows: true } });
    await signInAndSettle(o);
    expect(text(o.doc, '#modelresult')).toContain('nothing is being claimed about it either way');
    // And with no provider established, the agent cannot be switched on at all.
    expect((o.doc.getElementById('agenttoggle') as HTMLButtonElement).disabled).toBe(true);
  });
});

// ── linking a chat account by publishing a delegation ────────────────────────

describe('linking Discord publishes a delegation, and shows the call first', () => {
  it('★ shows the exact call, unmade, before anything is published', async () => {
    const o = await open();
    await signInAndSettle(o);
    (o.doc.getElementById('botagent') as HTMLInputElement).value = 'did:ethr:0xBOT';
    (o.doc.getElementById('botagent') as HTMLInputElement).dispatchEvent(new o.win.Event('input'));
    (o.doc.getElementById('discorduser') as HTMLInputElement).value = '4242';
    (o.doc.getElementById('discorduser') as HTMLInputElement).dispatchEvent(new o.win.Event('input'));
    const plan = text(o.doc, '#discordplan');
    expect(plan).toContain('has not been made');
    expect(plan).toContain('did:ethr:0xBOT');
    expect(plan).toContain('PublishOnly');
    expect(plan).toContain('discord-link 4242');
    // Nothing was sent while the plan was merely rendered.
    expect(o.s.calls.some((c) => c.name === 'register_agent')).toBe(false);
  });

  it('★ states that PublishOnly is pod-wide at the moment of consent', async () => {
    // The bot's README calls this one of its two honest limits. A screen that said "Link Discord"
    // and quietly published a pod-wide publish delegation has not asked for consent to what it did.
    const o = await open();
    await signInAndSettle(o);
    (o.doc.getElementById('botagent') as HTMLInputElement).value = 'did:ethr:0xBOT';
    (o.doc.getElementById('discorduser') as HTMLInputElement).value = '4242';
    (o.doc.getElementById('discorduser') as HTMLInputElement).dispatchEvent(new o.win.Event('input'));
    const plan = text(o.doc, '#discordplan');
    expect(plan).toContain('POD-WIDE');
    expect(plan).toContain('not only workspace entries');
  });

  it('★ says the label is public, and mints no secret of its own', async () => {
    // The whole defect the bot's `links.ts` records: a nonce in a world-readable delegation row
    // lets whoever reads the pod first bind THEIR account to YOUR pod. A second publisher of that
    // row must not reintroduce it, and a UI that called the label a "code" would invite exactly
    // the design that was removed.
    const o = await open();
    await signInAndSettle(o);
    (o.doc.getElementById('botagent') as HTMLInputElement).value = 'did:ethr:0xBOT';
    (o.doc.getElementById('discorduser') as HTMLInputElement).value = '4242';
    (o.doc.getElementById('discorduser') as HTMLInputElement).dispatchEvent(new o.win.Event('input'));
    const plan = text(o.doc, '#discordplan');
    expect(plan).toContain('is public, and is meant to be');
    expect(plan).toContain('nothing in it to steal');
    expect(text(o.doc, '#discordcard')).not.toContain('one-time');
  });

  it('refuses a Discord id that is not a snowflake, without calling anything', async () => {
    const o = await open();
    await signInAndSettle(o);
    (o.doc.getElementById('botagent') as HTMLInputElement).value = 'did:ethr:0xBOT';
    (o.doc.getElementById('discorduser') as HTMLInputElement).value = 'not-digits';
    (o.doc.getElementById('discorduser') as HTMLInputElement).dispatchEvent(new o.win.Event('input'));
    expect(text(o.doc, '#discordhint')).toContain('digits only');
    expect((o.doc.getElementById('discordlink') as HTMLButtonElement).disabled).toBe(true);
    expect(o.s.calls.some((c) => c.name === 'register_agent')).toBe(false);
  });

  it('★ does not report a link as published on the relay\'s say-so alone', async () => {
    // `register_agent` answering {registered:true} is the relay describing its own action. The row
    // on the pod is the fact, and the two have disagreed before.
    const o = await open({ setup: (s) => {
      s.fail.set('register_agent', () => ({ registered: true }));
      // The pod's registry never lists the agent, so the read-back cannot confirm it.
    } });
    await signInAndSettle(o);
    (o.doc.getElementById('botagent') as HTMLInputElement).value = 'did:ethr:0xBOT';
    (o.doc.getElementById('discorduser') as HTMLInputElement).value = '4242';
    (o.doc.getElementById('discorduser') as HTMLInputElement).dispatchEvent(new o.win.Event('input'));
    click(o.doc, 'discordlink');
    await o.settle();
    const res = text(o.doc, '#discordresult');
    expect(res).toContain('not confirmed by reading your pod back');
    expect(res).not.toContain('Published, and read back');
  });
});

// ── the local agent ──────────────────────────────────────────────────────────

describe('the local agent is off, visible, and stoppable', () => {
  it('★ is off by default and has drafted nothing', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide about the roof?', '2026-08-07T10:00:00.000Z'));
    } });
    await signInAndSettle(o);
    expect(text(o.doc, '#agentstate')).toBe('Off');
    expect(text(o.doc, '#agentwhy')).toContain('It reads nothing and writes nothing');
    expect(o.agent.prompts).toHaveLength(0);
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('');
  });

  it('★ a draft goes in the composer and NOTHING is published until the person sends it', async () => {
    // The whole point of the panel. An agent that writes on somebody's behalf without them seeing
    // it is not a feature, so the draft lands where their own typing would and stops there.
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide about the roof?', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: 'We agreed to re-tile in spring.', why: 'ok', ms: 900 }) },
    });
    await signInAndSettle(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('We agreed to re-tile in spring.');
    expect(text(o.doc, '#agentresult')).toContain('NOTHING has been written yet');
    expect(o.s.calls.some((c) => c.name === 'publish_context')).toBe(false);
  });

  it('★ the prompt it is given carries the channel and never a caller\'s text', async () => {
    // Copied from the bridge affordance's contract: "a caller who could pass text would be the
    // author, and the agent would be a signature on somebody else's sentence."
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'Roof question', '2026-08-07T10:00:00.000Z')); },
    });
    await signInAndSettle(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(o.agent.prompts).toHaveLength(1);
    const prompt = o.agent.prompts[0] as string;
    expect(prompt).toContain('Roof question');
    expect(prompt).toContain('permanent');
    expect(prompt).toContain(WS);
  });

  it('★ turning it off reaches the child process, not just the flag', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'Anything?', '2026-08-07T10:00:00.000Z'));
    } });
    await signInAndSettle(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(o.agent.cancels).toBeGreaterThan(0);
    expect(text(o.doc, '#agentstate')).toBe('Off');
  });

  it('★ does not answer when the most recent entry in the channel is its own', async () => {
    // The dedupe rule, and the loop-forever defect it prevents. `entryTurtle` writes no derivation
    // link, so a client that only looked for `prov:wasDerivedFrom` would re-answer the same message
    // on every poll, permanently, on a public log.
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What about the roof?', '2026-08-07T10:00:00.000Z'));
      (s.pods.get(POD_A) as Pod).put(entry(POD_A, 1, 'We agreed to re-tile in spring.', '2026-08-07T10:01:00.000Z'));
    } });
    await signInAndSettle(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(text(o.doc, '#agentwhy')).toContain('most recent entry in this channel is your own');
    expect(o.agent.prompts).toHaveLength(0);
  });

  it('★ never draws over text the person is in the middle of writing', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'Anything?', '2026-08-07T10:00:00.000Z'));
    } });
    await signInAndSettle(o);
    const ta = o.doc.getElementById('composer') as HTMLTextAreaElement;
    ta.value = 'half a sentence I was typing';
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(ta.value).toBe('half a sentence I was typing');
    expect(o.agent.prompts).toHaveLength(0);
    expect(text(o.doc, '#agentwhy')).toContain('unsent text');
  });

  it('★ posts nothing when the model returns the nothing-to-add sentinel', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'ok', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: 'NOTHING TO ADD', why: 'ok', ms: 300 }) },
    });
    await signInAndSettle(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('');
    expect(text(o.doc, '#agentresult')).toContain('nothing worth adding');
    expect(o.s.calls.some((c) => c.name === 'publish_context')).toBe(false);
  });

  it('★ a model that refuses is reported, and nothing is drafted from it', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'hello', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: false, text: null, why: 'Claude Code refused this turn: Not logged in · Please run /login. Nothing was written.', ms: 1200 }) },
    });
    await signInAndSettle(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(text(o.doc, '#agentresult')).toContain('Not logged in');
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('');
  });

  it('★ an over-long draft is refused rather than truncated', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'hello', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: 'x'.repeat(5000), why: 'ok', ms: 900 }) },
    });
    await signInAndSettle(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(text(o.doc, '#agentresult')).toContain('refused rather than truncated');
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('');
  });

  it('★ an unseated viewer\'s agent refuses, and says which half is missing', async () => {
    const o = await open({ viewer: POD_B, setup: (s) => {
      // POD_B's acceptance is removed, so it holds a grant and no seat.
      const b = s.pods.get(POD_B) as Pod;
      b.docs.length = 0;
      (s.pods.get(POD_A) as Pod).put(entry(POD_A, 0, 'anyone there?', '2026-08-07T10:00:00.000Z'));
    } });
    await signInAndSettle(o);
    // Not seated, so the panel is not even offered — there is no log of theirs to write to.
    expect(o.doc.getElementById('agentcard')?.hasAttribute('hidden')).toBe(true);
    expect(o.agent.prompts).toHaveLength(0);
  });
});
