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
// The label prefix comes from the substrate, never a literal: a fixture that spells it out is
// exactly the drift the constant exists to prevent, and it hid a real change once already.
import { delegateLabel } from '@interego/core/delegate';
// ★ THE REAL WRITER COMPOSES THE FIXTURES. A harness that spelled out the authorship triples
// itself could not notice the writer changing underneath it — and the writer is what decides
// whether an entry says it was spoken for its delegator or on the agent's own account.
import { entryTurtle, type EntryAuthor } from '@interego/workspace-client';

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
/**
 * The footing declaration a model is asked for, prefixed onto every scripted reply below.
 *
 * ★ IT IS NOT DECORATION ON THE FIXTURES. `checkDraft` REFUSES a draft that does not declare one —
 * a client that shipped an unfooted entry would be manufacturing, permanently and on somebody
 * else's pod, exactly the ambiguity this change removes. So a scripted model that omits it is a
 * model whose answer is correctly thrown away, and the case below that omits it on purpose asserts
 * precisely that.
 */
const BEHALF = 'FOOTING: ON THEIR BEHALF\n';
const OWN = 'FOOTING: MY OWN ACCOUNT\n';

const trig = (iri: string, body: string): string =>
  '@prefix wsp: <https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#> .\n'
  + '@prefix dct: <http://purl.org/dc/terms/> .\n'
  // The three `entryTurtle` also declares. A TriG graph block cannot carry its own `@prefix`, so
  // the entries spliced in below borrow these — see `entry`.
  + '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
  + '@prefix prov: <http://www.w3.org/ns/prov#> .\n'
  + '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .\n'
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
  /**
   * Each pod's OWN delegation registry rows.
   *
   * ★ PER POD, BECAUSE AUTHORISATION IS PER POD. One shared list would let a test assert a state
   * the substrate cannot produce — one person's delegate showing up as another's — and a harness
   * that can express the impossible cannot verify the possible.
   */
  delegations: Map<string, Record<string, unknown>[]>;
  /** Which delegate keys the "main process" holds, and what agent id each signs in as. */
  keys: { address: string; agentId: string | null; why: string | null }[];
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
    // One delegate authorised on A's pod, with its key here — the ordinary state a person is in
    // once they have set one up. Cases about having none, or having one hosted elsewhere, say so.
    delegations: new Map([[POD_A, [delegationRow(D1, delegateLabel('Claude side'))]]]),
    keys: [{ address: KEY('0x1'), agentId: D1, why: null }],
  };
}

/** A delegate DID in the shape the live relay issues: the surface constant, then a pod. */
const DELEGATE = (n: string): string => 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-' + n;
const D1 = DELEGATE('111111111111');
const D2 = DELEGATE('222222222222');
const KEY = (n: string): string => '0x' + n.padEnd(40, '0');
/** One row as `get_pod_status` reports it. */
const delegationRow = (agentId: string, label: string | null, scope = 'PublishOnly'): Record<string, unknown> =>
  ({ agentId, scope, label, validFrom: '2026-08-06T09:00:00.000Z' });

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

/**
 * The scripted relay.
 *
 * `caller` is the agent the relay would have authenticated — the viewer's own session, or a
 * DELEGATE's when the call came through the delegate channel. It is not a convenience: the whole
 * point of a delegate holding its own key is that the relay knows who asked, so a harness that
 * answered identically either way could not tell a real delegated write from a forged claim.
 */
function tool(s: Scripted, viewerPod: string, name: string, input: Record<string, unknown>, caller = 'did:ethr:0xsession'): unknown {
  s.calls.push({ name, input });
  const override = s.fail.get(name);
  if (override) { const r = override(input); if (r !== undefined) return r; }
  const podOf = (n: unknown): Pod | undefined => s.pods.get(String(n ?? viewerPod));
  switch (name) {
    case 'get_pod_status': {
      const pod = input['pod_url'] ? String(input['pod_url']).replace(/\/$/, '').split('/').pop() as string
        : input['pod_name'] ? String(input['pod_name']) : viewerPod;
      return {
        pod: 'http://css.railway.internal:3456/' + pod + '/',
        displayName: null, css: 'http://css.railway.internal:3456/',
        registry: { owner: WEBID(pod) },
        delegationRegistry: { owner: WEBID(pod), rows: s.delegations.get(pod) ?? [] },
        sessionAgent: { did: 'did:ethr:0xsession', scope: 'ReadWrite' },
      };
    }
    /**
     * ★ OWN-POD GATED, LIKE THE RELAY'S. `register_agent` takes no `pod_name` and writes only the
     * authenticated pod's registry. A harness that let a caller name a pod would make the flow
     * testable in a way the substrate never permits.
     */
    case 'register_agent': {
      const rows = s.delegations.get(viewerPod) ?? [];
      const at = rows.findIndex((r) => r['agentId'] === input['agent_id']);
      const row = delegationRow(String(input['agent_id']), (input['label'] as string) ?? null, String(input['scope'] ?? 'PublishOnly'));
      if (at >= 0) rows[at] = row; else rows.push(row);
      s.delegations.set(viewerPod, rows);
      return { registered: true, agent: input['agent_id'], scope: input['scope'] };
    }
    case 'revoke_agent': {
      const rows = (s.delegations.get(viewerPod) ?? []).filter((r) => r['agentId'] !== input['agent_id']);
      s.delegations.set(viewerPod, rows);
      return { revoked: true };
    }
    case 'verify_agent': {
      // When asked about a delegate on a pod, answer from that pod's own rows — which is what the
      // relay's scope gate reads. Asked about the viewer's session, keep the measured shape.
      const askPod = input['pod_name'] ? String(input['pod_name']) : viewerPod;
      const row = (s.delegations.get(askPod) ?? []).find((r) => r['agentId'] === input['agent_id']);
      if (row) {
        const eligible = ['ReadWrite', 'PublishOnly'].includes(String(row['scope']));
        return { subject_pod_name: askPod, verified: true, enforcement: { basis: 'signed-chain', scope: row['scope'], writeEligible: eligible, note: '' } };
      }
      if (input['pod_name']) {
        return { subject_pod_name: askPod, verified: false, enforcement: { basis: 'none', scope: null, writeEligible: false, note: 'agent is not registered on this pod' } };
      }
      return { verified: false, enforcement: { basis: 'registry-only', scope: 'ReadWrite', writeEligible: s.writeEligible, note: 'no signed delegation credential anchors this agent' } };
    }
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
      // ★ THE WRITE LANDS ON THE NAMED POD, AND THE RELAY'S SCOPE GATE DECIDES. A delegate writes
      // to its DELEGATOR's pod, not its own, so a harness pinned to `viewerPod` could not exercise
      // a delegated write at all — and could not exercise the 403 either.
      const target = input['pod_name'] ? String(input['pod_name']) : viewerPod;
      const pod = s.pods.get(target);
      if (!pod) return { error: 'scope_violation', code: 403, message: 'agent is not registered on this pod' };
      if (caller !== 'did:ethr:0xsession') {
        const row = (s.delegations.get(target) ?? []).find((r) => r['agentId'] === caller);
        if (!row || !['ReadWrite', 'PublishOnly'].includes(String(row['scope']))) {
          return { error: 'scope_violation', code: 403, message: 'agent is not registered on this pod' };
        }
      }
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
      const url = DESC(target, n);
      pod.put({
        graph, cid: 'cid-' + n, url, content: trig(graph, String(input['graph_content']).replace(/^@prefix[^\n]*\n/gm, '')),
        validFrom: new Date(Date.parse('2026-08-06T13:00:00.000Z') + n).toISOString(),
        supersedes: prior ? [prior.url] : [],
        authorship: { signedBy: caller, authorshipVerified: true },
      });
      return {
        status: 'committed', descriptorUrl: url, cid: 'cid-' + n,
        precondition: input['if_match'] ? { passed: true, expectedCid: String(input['if_match']), observedCid: String(input['if_match']) } : undefined,
        supersedesPriorVersions: prior ? [prior.url] : [],
        // Measured shape: `signer` is the agent the relay authenticated, `verificationMethod` is
        // the relay's OWN key — one key for every pod and every agent on the deployment.
        authorship: { signed: true, signer: caller, verificationMethod: 'did:ethr:0xd144353a7A2Fa81E126e072AD3b16cD245c83331' },
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
      return agent.think ? agent.think(prompt) : { ok: true, text: BEHALF + 'A drafted reply.', why: 'ok', ms: 1200 };
    },
    agentCancel: async () => { agent.cancels++; return { stopped: 0 }; },
    /**
     * ★ THE KEYRING, WHICH IS NOT THE ROSTER. This answers "which delegates can this machine
     * DRIVE"; the pod's own delegation registry answers "which has this person AUTHORISED". The
     * renderer reads both and the two are deliberately allowed to disagree here, because they
     * disagree in reality: a delegate hosted on another laptop is authorised and not drivable.
     */
    delegateList: async () => ({ delegates: s.keys.slice(), secretStore: true }),
    delegateMint: async () => {
      const address = KEY('0xdead' + (s.keys.length + 1));
      const agentId = DELEGATE('9'.repeat(11) + String(s.keys.length + 1));
      s.keys.push({ address, agentId, why: null });
      return { address, agentId, pod: 'u-eth-minted', privateKey: '0x' + 'a'.repeat(64) };
    },
    delegateImport: async (pk: string) => {
      if (!/^0x[0-9a-fA-F]{64}$/.test(pk)) throw new Error('That is not a secp256k1 private key.');
      const address = KEY('0xbeef' + (s.keys.length + 1));
      const agentId = DELEGATE('8'.repeat(11) + String(s.keys.length + 1));
      s.keys.push({ address, agentId, why: null });
      return { address, agentId, pod: 'u-eth-imported' };
    },
    delegateForget: async (address: string) => {
      const at = s.keys.findIndex((k) => k.address === address);
      if (at >= 0) s.keys.splice(at, 1);
      return { forgotten: address };
    },
    /**
     * A call made under a DELEGATE's own session. The scripted relay is told which agent asked,
     * so a delegated write is gated on that pod's registry exactly as the live one is.
     */
    delegateCall: async (address: string, name: string, input: Record<string, unknown>) => {
      const k = s.keys.find((x) => x.address === address);
      if (!k?.agentId) return { ok: false, error: { code: 'delegate_unavailable', message: 'this app holds no key for ' + address, retryable: false, retryAfterMs: null } };
      return { ok: true, payload: tool(s, viewer, name, input, k.agentId) };
    },
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
 * Authorise a delegate on a pod AND hold its key here.
 *
 * ★ BOTH HALVES, SEPARATELY, BECAUSE THEY ARE SEPARATE FACTS. The row on the pod is the
 * AUTHORITY; the key is what lets this machine drive it. Tests that want a delegate hosted
 * elsewhere set only the first, and tests that want a key with no delegation set only the second.
 */
const seatDelegate = (s: Scripted, pod: string, args: { agentId: string; name: string; address?: string; scope?: string; hosted?: boolean }): void => {
  const rows = s.delegations.get(pod) ?? [];
  rows.push(delegationRow(args.agentId, delegateLabel(args.name), args.scope ?? 'PublishOnly'));
  s.delegations.set(pod, rows);
  if (args.hosted !== false) s.keys.push({ address: args.address ?? KEY('0x' + args.agentId.slice(-6)), agentId: args.agentId, why: null });
};

/** Choose which delegate speaks here, through the picker, the way a person does. */
async function speakAs(o: Opened, agentId: string): Promise<void> {
  const sel = o.doc.getElementById('agentwho') as HTMLSelectElement;
  sel.value = agentId;
  sel.dispatchEvent(new o.win.Event('change'));
  await o.settle();
}

/** Sign in and pick the delegate the default store authorises, which most agent cases want. */
async function signInAndSpeak(o: Opened): Promise<void> {
  await signInAndSettle(o);
  await speakAs(o, D1);
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
/**
 * One entry in somebody's log.
 *
 * `by` is who COMPOSED it, which is not the pod. Omitted, the pod's owner wrote it — the ordinary
 * case, and the one the conduit path produces. Given a delegate DID, the entry is written the way
 * `entryTurtle` writes a delegate's: attributed to the AGENT, with a second subject stating whom
 * that agent acted for. Pass `null` for the case that must never render as the owner — an entry
 * that names nobody at all.
 */
/**
 * One entry in a pod's log.
 *
 * ★ THE VALID CASES ARE COMPOSED BY THE REAL WRITER, NOT BY THIS FILE. `entryTurtle` is the one
 * thing in the system that decides which triples say "this was written for that person", and a
 * fixture that spelled them out here would let the writer and the reader drift apart while this
 * harness stayed green — which is exactly the class of defect it exists to catch. The prefix block
 * is stripped because a TriG graph block cannot contain `@prefix`; `trig` declares the same five.
 *
 * `by === null` is the deliberately malformed case — an entry naming no author at all — and is the
 * only one written by hand, because no writer will produce it.
 */
const entry = (pod: string, n: number, body: string, at: string, by?: string | null, footing?: 'own-account'): Doc => {
  const author: EntryAuthor = by === undefined || by === null
    ? { kind: 'principal', webId: WEBID(pod) }
    : { kind: 'delegate', agentId: by, footing: footing === 'own-account' ? { kind: 'own-account' } : { kind: 'on-behalf-of', principal: WEBID(pod) } };
  const written = by === null
    ? '<' + STREAM(pod) + '/e/' + n + '> a wsp:Entry ; wsp:workspace <' + WS + '> ;\n'
      + '  wsp:seq "' + n + '"^^xsd:nonNegativeInteger ; dct:description "' + body + '" .'
    : entryTurtle({ streamIri: STREAM(pod), workspace: WS, seq: n, body, prior: null, author, createdIso: at })
      .replace(/^@prefix[^\n]*\n/gm, '').trim();
  return {
    graph: STREAM(pod), cid: 'cid-ag-' + pod + '-' + n, url: DESC(pod, 200 + n), validFrom: at,
    content: trig(STREAM(pod), written),
  };
};

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

describe('the first run reads as one sequence, and admits what it cannot know', () => {
  it('names the pod and the model account as established', async () => {
    const o = await open();
    await signInAndSettle(o);
    const steps = text(o.doc, '#setupsteps');
    expect(steps).toContain('1. Your account — you are pod ' + POD_A);
    expect(steps).toContain('brother@example.com');
  });

  it('★ never says the user has not linked Discord — it says it cannot know', async () => {
    // The easiest honesty failure on this screen. Whether a pod delegates a bot is a question
    // about that pod's registry and it needs an agent id to ask; the app has none until the user
    // types one. A checklist that drew that as an unticked box would be asserting something it
    // had not checked — and would keep asserting it after a link made from another client.
    const o = await open();
    await signInAndSettle(o);
    const steps = text(o.doc, '#setupsteps');
    expect(steps).toContain('nothing here is a claim either way');
    expect(steps).not.toContain('Discord — you have not');
    // Rendered as "not established", never as a finding against.
    const discord = [...o.doc.querySelectorAll('#setupsteps .q')].map((n) => n.textContent ?? '');
    expect(discord.some((t) => t.startsWith('5. Discord'))).toBe(true);
  });

  it('★ a workspace list that failed to read is not reported as "you are in none"', async () => {
    const o = await open({ setup: (s) => {
      s.fail.set('discover_context', (input) => (String(input['pod_name'] ?? '') === POD_A
        ? { error: 'upstream_error', message: 'the pod manifest could not be read' } : undefined));
    } });
    await signInAndSettle(o);
    const steps = text(o.doc, '#setupsteps');
    expect(steps).toContain('how many you are in is not established');
    expect(steps).not.toContain('you are in none yet');
  });

  // NOTE: this block used to carry a case asserting that an ABSENT CLI is a finding against. It
  // was wrong, and an adversarial review caught it: `CLAUDE_ABSENT` has `loggedIn: null`, so
  // nothing at all was established about the account and a cross claimed otherwise. The two cases
  // that replaced it — one per side of the rule — live in the local-agent block below.
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
    // ★ AND NOBODY IS SELECTED, which is a different state from "off". A delegate is chosen, not
    // defaulted — defaulting one would be the app deciding who speaks for somebody.
    expect(text(o.doc, '#agentwhy')).toContain('Choose which of your delegates speaks in this channel');
    expect(o.agent.prompts).toHaveLength(0);
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('');
    // Once one IS chosen, the off state says what it says.
    await speakAs(o, D1);
    expect(text(o.doc, '#agentwhy')).toContain('It reads nothing and writes nothing');
  });

  it('★ a draft goes in the composer and NOTHING is published until the person sends it', async () => {
    // The whole point of the panel. An agent that writes on somebody's behalf without them seeing
    // it is not a feature, so the draft lands where their own typing would and stops there.
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide about the roof?', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: BEHALF + 'We agreed to re-tile in spring.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('We agreed to re-tile in spring.');
    expect(text(o.doc, '#agentresult')).toContain('NOTHING has been written yet');
    expect(o.s.calls.some((c) => c.name === 'publish_context')).toBe(false);
    // ★ AND THE FOOTING IS ON THE BUTTON, BEFORE IT SPEAKS. Consenting to send is consenting to
    // one of two different records, and a control that named only the author would be asking for
    // consent to a distinction it did not show.
    expect(text(o.doc, '#agentsend')).toBe('Send as Claude side, speaking for you');
    expect(text(o.doc, '#agentresult')).toContain('shares responsibility for it');
  });

  /**
   * ★ THE OTHER HALF OF THE SAME CONTROL. Same delegate, same button, a different record — and the
   * person can see which one before it exists. If this and the case above ever render the same, a
   * person is being asked to approve two different things with one label.
   */
  it('★ a delegate speaking on its OWN account says so on the button, before it is sent', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide about the roof?', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: OWN + 'My own read: patching is the weaker option.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(text(o.doc, '#agentsend')).toBe('Send as Claude side, speaking for itself');
    expect(text(o.doc, '#agentresult')).toContain('on its OWN account — you are not answerable for what it says');
    // And what lands says it too. The button and the triples are one decision, made once.
    click(o.doc, 'agentsend');
    await o.settle();
    const ttl = String(o.s.calls.filter((c) => c.name === 'publish_context').slice(-1)[0]?.input['graph_content']);
    expect(ttl).toContain('iep:actedOnOwnAccount');
    expect(ttl).not.toContain('prov:Delegation');
    expect(ttl).not.toContain(WEBID(POD_A));
  });

  /**
   * ★ AND A MODEL THAT DECLARES NOTHING GETS NOTHING WRITTEN. The refusal is the guard: defaulting
   * to "on their behalf" is the original defect, and defaulting to "own account" would let a
   * delegate disown anything by dropping a line.
   */
  it('★ a draft with no footing declaration is refused, and nothing is published', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide about the roof?', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: 'We agreed to re-tile in spring.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(text(o.doc, '#agentresult')).toContain('did not declare which footing');
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('');
    expect((o.doc.getElementById('agentsend') as HTMLButtonElement).hasAttribute('hidden')).toBe(true);
    expect(o.s.calls.some((c) => c.name === 'publish_context')).toBe(false);
  });

  it('★ the prompt it is given carries the channel and never a caller\'s text', async () => {
    // Copied from the bridge affordance's contract: "a caller who could pass text would be the
    // author, and the agent would be a signature on somebody else's sentence."
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'Roof question', '2026-08-07T10:00:00.000Z')); },
    });
    await signInAndSpeak(o);
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
    await signInAndSpeak(o);
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
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(text(o.doc, '#agentwhy')).toContain('has written in this channel since');
    expect(o.agent.prompts).toHaveLength(0);
  });

  it('★ never draws over text the person is in the middle of writing', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'Anything?', '2026-08-07T10:00:00.000Z'));
    } });
    await signInAndSpeak(o);
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
    await signInAndSpeak(o);
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
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(text(o.doc, '#agentresult')).toContain('Not logged in');
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('');
  });

  it('★ an over-long draft is refused rather than truncated', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'hello', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: BEHALF + 'x'.repeat(5000), why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(text(o.doc, '#agentresult')).toContain('refused rather than truncated');
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('');
  });

  /**
   * ★ THE FOUR BELOW ARE DEFECTS AN ADVERSARIAL REVIEWER FOUND IN THE FIRST VERSION OF THIS
   * FEATURE, after every test above was already green. Each was reachable, each was silent, and
   * two of them wrote to somebody's permanent public log. They are pinned here in the shape that
   * produced them.
   */
  /**
   * ★ THE UNDATED-ENTRY CASE IS NOT HERE, AND ITS ABSENCE IS DELIBERATE.
   *
   * It was written here first, and it PASSED with the defect deliberately restored: the scripted
   * store cannot get an undated entry as far as `decideTurn`, so the case asserted nothing while
   * being counted as a regression test — worse than no test. It lives in
   * `tests/workspace-client-localagent.test.ts` instead, at the altitude where the ordering is
   * decided, and it was verified to FAIL against the reverted sort before being kept. A DOM is the
   * right place to test what the shell draws and the wrong place to test an ordering rule.
   */
  it('★ refuses outright when part of the channel could not be read', async () => {
    // Losing the read of the agent's OWN latest reply made it answer the same message twice. A
    // partial channel cannot answer "who spoke last", so it is not asked to.
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'A question', '2026-08-07T10:00:00.000Z'));
      s.fail.set('get_descriptor', (input) => (String(input['url']).endsWith('200.ttl')
        ? { error: 'upstream_error', message: 'that descriptor could not be read' } : undefined));
    } });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(o.agent.prompts).toHaveLength(0);
    expect(text(o.doc, '#agentwhy')).toContain('could not be read');
  });

  it('★ switching workspace turns the agent off and discards its draft', async () => {
    // THE CROSS-WORKSPACE LEAK. `teardownWorkspace` reset every other piece of channel state and
    // not the agent's, so an in-flight turn composed from one channel wrote its draft into
    // another's composer — and with auto-post on, published it there.
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'A question', '2026-08-07T10:00:00.000Z'));
    } });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).not.toBe('');
    await openByIri(o, WS);
    expect(text(o.doc, '#agentstate')).toBe('Off');
    expect((o.doc.getElementById('composer') as HTMLTextAreaElement).value).toBe('');
    expect(o.agent.cancels).toBeGreaterThan(0);
  });

  it('★ a probe that threw is not rendered as "nothing is installed on this machine"', async () => {
    const o = await open({ agent: { prompts: [], cancels: 0, probeThrows: true } });
    await signInAndSettle(o);
    const steps = text(o.doc, '#setupsteps');
    expect(steps).toContain('not established');
    expect(steps).not.toContain('was found on this machine');
    const unknown = [...o.doc.querySelectorAll('#setupsteps .q')].map((n) => n.textContent ?? '');
    expect(unknown.some((t) => t.startsWith('2. Your agent\'s model'))).toBe(true);
    expect([...o.doc.querySelectorAll('#setupsteps .n')]).toHaveLength(0);
  });

  it('★ a CLI that is absent is "not established", not a finding that you are signed out', async () => {
    // `loggedIn: null` means the tool was never there to ask. Only `loggedIn === false` is the
    // tool having answered no, and only that may be drawn as a finding against.
    const o = await open({ agent: { prompts: [], cancels: 0, providers: [CLAUDE_ABSENT] } });
    await signInAndSettle(o);
    const unknown = [...o.doc.querySelectorAll('#setupsteps .q')].map((n) => n.textContent ?? '');
    expect(unknown.some((t) => t.startsWith('2. Your agent\'s model'))).toBe(true);
    expect(text(o.doc, '#setupsteps')).toContain('not something this app can see from here');
  });

  it('an installed CLI that answered "not signed in" IS a finding against', async () => {
    // The other side of the same rule: here the tool was asked and answered, so understating it
    // as unknown would hide a real blocker behind a shrug.
    const o = await open({ agent: { prompts: [], cancels: 0, providers: [{
      ...CLAUDE_ABSENT, installed: true, path: 'C:\\claude.exe', loggedIn: false,
      why: 'Claude Code is installed but not signed in. Run `claude auth login`.',
    }] } });
    await signInAndSettle(o);
    const against = [...o.doc.querySelectorAll('#setupsteps .n')].map((n) => n.textContent ?? '');
    expect(against.some((t) => t.startsWith('2. Your agent\'s model'))).toBe(true);
    expect(text(o.doc, '#setupsteps')).toContain('claude auth login');
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

/**
 * ★ A DELEGATE IS NOT THE PERSON, AND THE SCREEN HAS TO SHOW IT.
 *
 * Every case below was checked with the correction reverted — the agent writing under the
 * viewer's own session and WebID, the picker gone, the stream labelling every entry by its pod's
 * role — and every one of them failed. The module tests pin the DECISIONS; these pin what a
 * person can actually see, which is where the old defect was invisible.
 */
describe('delegates: separate identities, plural, and visible as such', () => {
  it('★ with no delegate authorised, nothing speaks — and it is not the person who does', async () => {
    const o = await open({ setup: (s) => {
      s.delegations.clear(); s.keys.length = 0;
      (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'A question', '2026-08-07T10:00:00.000Z'));
    } });
    await signInAndSettle(o);
    expect((o.doc.getElementById('agenttoggle') as HTMLButtonElement).disabled).toBe(true);
    expect(text(o.doc, '#agentwhy')).toContain('You have not authorised a delegate');
    expect(text(o.doc, '#agentwhy')).toContain('Nothing here will write as you');
    expect(o.agent.prompts).toHaveLength(0);
    expect(o.s.calls.some((c) => c.name === 'publish_context')).toBe(false);
  });

  it('★ the picker lists the POD\'s delegates, and one hosted elsewhere is shown and not selectable', async () => {
    const o = await open({ setup: (s) => {
      // Authorised on the pod, key NOT on this machine. A real delegate, running somewhere else.
      seatDelegate(s, POD_A, { agentId: D2, name: 'Codex side', hosted: false });
    } });
    await signInAndSettle(o);
    const opts = [...o.doc.querySelectorAll('#agentwho option')] as HTMLOptionElement[];
    const codex = opts.find((x) => x.value === D2);
    expect(codex?.textContent).toContain('Codex side');
    expect(codex?.textContent).toContain('no key on this machine');
    expect(codex?.disabled).toBe(true);
    // And the one this machine DOES hold a key for is selectable.
    expect(opts.find((x) => x.value === D1)?.disabled).toBe(false);
  });

  it('★ a delegate whose scope cannot publish is offered as unusable rather than hidden', async () => {
    const o = await open({ setup: (s) => {
      seatDelegate(s, POD_A, { agentId: D2, name: 'Reader only', scope: 'ReadOnly' });
    } });
    await signInAndSettle(o);
    const opt = ([...o.doc.querySelectorAll('#agentwho option')] as HTMLOptionElement[]).find((x) => x.value === D2);
    expect(opt?.textContent).toContain('scope ReadOnly, cannot publish');
    expect(opt?.disabled).toBe(true);
  });

  it('★ the delegate\'s entry names the DELEGATE, and the person\'s names the person', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What about the roof?', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: BEHALF + 'Patching buys a year.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    // The draft is the delegate's, so the PERSON's Post is withheld and the delegate has its own.
    expect((o.doc.getElementById('send') as HTMLButtonElement).disabled).toBe(true);
    const own = o.doc.getElementById('agentsend') as HTMLButtonElement;
    expect(own.hasAttribute('hidden')).toBe(false);
    expect(own.textContent).toContain('Send as Claude side');
    own.click();
    await o.settle();
    const published = o.s.calls.filter((c) => c.name === 'publish_context');
    expect(published).toHaveLength(1);
    const ttl = String(published[0]?.input['graph_content']);
    // ★ THE TRIPLES. The agent is the author; the delegation is a prov:Delegation over THIS act,
    // which is what makes it a statement about this sentence rather than about the agent.
    expect(ttl).toContain('prov:wasAttributedTo <' + D1 + '>');
    expect(ttl).toContain('<' + D1 + '> prov:qualifiedDelegation <');
    expect(ttl).toContain('a prov:Delegation ;');
    expect(ttl).toContain('prov:agent <' + WEBID(POD_A) + '> ;');
    expect(ttl).toMatch(/prov:hadActivity <[^>]+#act>/);
    expect(ttl).not.toContain('prov:wasAttributedTo <' + WEBID(POD_A) + '>');
  });

  it('★ the person\'s own Post attributes to the person, and nothing acted on their behalf', async () => {
    const o = await open();
    await signInAndSettle(o);
    (o.doc.getElementById('composer') as HTMLTextAreaElement).value = 'I typed this myself.';
    click(o.doc, 'send');
    await o.settle();
    const ttl = String(o.s.calls.filter((c) => c.name === 'publish_context')[0]?.input['graph_content']);
    expect(ttl).toContain('prov:wasAttributedTo <' + WEBID(POD_A) + '>');
    expect(ttl).not.toContain('prov:actedOnBehalfOf');
  });

  it('★ editing a delegate\'s draft makes the words yours, and Post comes back', async () => {
    // The corrected defect, moved one button along: a draft sitting beside a live Post is a
    // one-click way to publish an agent's prose under a person's name.
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'A question', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: BEHALF + 'A drafted reply.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    const ta = o.doc.getElementById('composer') as HTMLTextAreaElement;
    expect((o.doc.getElementById('send') as HTMLButtonElement).disabled).toBe(true);
    ta.value = 'A drafted reply, but I changed it.';
    ta.dispatchEvent(new o.win.Event('input'));
    await o.settle();
    expect((o.doc.getElementById('send') as HTMLButtonElement).disabled).toBe(false);
    expect((o.doc.getElementById('agentsend') as HTMLButtonElement).hasAttribute('hidden')).toBe(true);
    click(o.doc, 'send');
    await o.settle();
    const ttl = String(o.s.calls.filter((c) => c.name === 'publish_context')[0]?.input['graph_content']);
    expect(ttl).toContain('prov:wasAttributedTo <' + WEBID(POD_A) + '>');
    expect(ttl).not.toContain(D1);
  });

  it('★ one log, three authors: the person, and two of their delegates, all told apart', async () => {
    const o = await open({ setup: (s) => {
      seatDelegate(s, POD_A, { agentId: D2, name: 'Codex side' });
      const a = s.pods.get(POD_A) as Pod;
      a.put(entry(POD_A, 0, 'I would rather not spend the money.', '2026-08-07T10:00:00.000Z'));
      a.put(entry(POD_A, 1, 'Consider the flashing too.', '2026-08-07T10:01:00.000Z', D1));
      a.put(entry(POD_A, 2, 'And the gutters.', '2026-08-07T10:02:00.000Z', D2));
    } });
    await signInAndSettle(o);
    const authors = [...o.doc.querySelectorAll('#stream .mauthor')].map((n) => n.textContent ?? '');
    expect(authors).toContain('You');
    expect(authors).toContain('Claude side, speaking for the person whose pod this is');
    expect(authors).toContain('Codex side, speaking for the person whose pod this is');
    // And the ROLE is still shown, separately — a capacity, not an author.
    expect(text(o.doc, '#stream')).toContain('Convener');
  });

  /**
   * ★ THE SENTENCE THE MAINTAINER ASKED FOR, ON SCREEN: "Mark's delegate, speaking for Mark" and
   * "Mark's delegate, speaking for itself" must not look the same.
   *
   * Same delegate, same registry row, same standing — two entries in one log, and the shell has to
   * draw them differently in the label, in the badge, and in the tooltip. Reverting any one of the
   * three fails this.
   */
  it('★ the same delegate speaking FOR the person and FOR ITSELF are drawn differently', async () => {
    const o = await open({ setup: (s) => {
      const a = s.pods.get(POD_A) as Pod;
      a.put(entry(POD_A, 0, 'They have decided to patch it.', '2026-08-07T10:00:00.000Z', D1));
      a.put(entry(POD_A, 1, 'For my part I think that is the weaker option.', '2026-08-07T10:01:00.000Z', D1, 'own-account'));
    } });
    await signInAndSettle(o);
    const authors = [...o.doc.querySelectorAll('#stream .mauthor')] as HTMLElement[];
    const labels = authors.map((n) => n.textContent ?? '');
    expect(labels).toContain('Claude side, speaking for the person whose pod this is');
    expect(labels).toContain('Claude side, a delegate of the person whose pod this is, speaking for itself');
    // The badge, so a reader skimming the column sees it without hovering anything.
    const badges = [...o.doc.querySelectorAll('#stream .badge')].map((n) => n.textContent ?? '');
    expect(badges).toContain('⚙');
    expect(badges).toContain('⚙!');
    // And the tooltip states who is answerable, in words, both ways round.
    const forThem = authors.find((n) => (n.textContent ?? '').endsWith('speaking for the person whose pod this is')) as HTMLElement;
    const forSelf = authors.find((n) => (n.textContent ?? '').includes('speaking for itself')) as HTMLElement;
    expect(forThem.title).toContain('retains responsibility');
    expect(forSelf.title).toContain('is not answerable');
    // ★ AND THE STANDING DELEGATION IS REPORTED AS UNCHANGED IN BOTH. A reader told "speaking for
    // itself" must not conclude the agent was never authorised.
    expect(forThem.title).toContain('registry lists this agent');
    expect(forSelf.title).toContain('registry lists this agent');
  });

  /**
   * ★ ABSENCE IS NOT EVIDENCE, AT THE SURFACE. An entry by a delegate that declares no footing is
   * neither reading, and the shell has to draw a third thing rather than picking the flattering
   * one. This entry is written by hand precisely because no writer in this repo will emit it.
   */
  it('★ a delegate entry that states no footing renders as "not stated", not as either', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_A) as Pod).put({
        graph: STREAM(POD_A), cid: 'cid-nf', url: DESC(POD_A, 260), validFrom: '2026-08-07T10:00:00.000Z',
        content: trig(STREAM(POD_A), '<' + STREAM(POD_A) + '/e/0> a wsp:Entry ; wsp:workspace <' + WS + '> ;\n'
          + '  wsp:seq "0"^^xsd:nonNegativeInteger ; prov:wasAttributedTo <' + D1 + '> ;\n'
          + '  prov:wasGeneratedBy <' + STREAM(POD_A) + '/e/0#act> ; dct:description "No footing here." .'),
      });
    } });
    await signInAndSettle(o);
    const el = [...o.doc.querySelectorAll('#stream .mauthor')]
      .find((n) => (n.textContent ?? '').includes('Claude side')) as HTMLElement;
    expect(el.textContent).toBe('Claude side, a delegate of the person whose pod this is — footing not stated');
    expect(el.title).toContain('does not say');
    expect([...o.doc.querySelectorAll('#stream .badge')].map((n) => n.textContent)).toContain('⚙?');
  });

  it('★ an entry that names no author renders as that, never as the pod owner', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_A) as Pod).put(entry(POD_A, 0, 'Who wrote this?', '2026-08-07T10:00:00.000Z', null));
    } });
    await signInAndSettle(o);
    const authors = [...o.doc.querySelectorAll('#stream .mauthor')].map((n) => n.textContent ?? '');
    expect(authors).toContain('author not stated');
    expect(authors).not.toContain('You');
  });

  it('★ an entry claiming a delegation the pod does not record is marked, not believed', async () => {
    const o = await open({ setup: (s) => {
      // The entry claims D2 acted for A; A's registry lists only D1.
      (s.pods.get(POD_A) as Pod).put(entry(POD_A, 0, 'Not really authorised.', '2026-08-07T10:00:00.000Z', D2));
    } });
    await signInAndSettle(o);
    const el = [...o.doc.querySelectorAll('#stream .mauthor')].find((n) => (n.textContent ?? '').includes('unnamed delegate'));
    expect(el).not.toBe(undefined);
    expect((el as HTMLElement).title).toContain('does NOT list this agent');
  });

  it('★ the roster draws each member\'s delegates as their own rows, with their own scope', async () => {
    const o = await open({ setup: (s) => {
      seatDelegate(s, POD_A, { agentId: D2, name: 'Codex side', scope: 'ReadOnly' });
    } });
    await signInAndSettle(o);
    const roster = text(o.doc, '#roster');
    expect(roster).toContain('Claude side');
    expect(roster).toContain('Codex side');
    expect(roster).toContain('delegate of ' + POD_A);
    expect(roster).toContain(D1);
    // Each delegate's own scope, on its own row — not the member's.
    expect(roster).toContain('ReadOnly');
    expect(roster).toContain('PublishOnly');
    // ★ AND THE ROSTER SAYS WHAT IT DOES NOT SETTLE. A list of somebody's delegates read as a
    // blanket endorsement of everything those delegates say is the exact misreading this whole
    // change removes, and a roster row is where a reader is most likely to make it.
    const badge = [...o.doc.querySelectorAll('#roster .badge')]
      .find((n) => (n as HTMLElement).title.includes('delegate of pod')) as HTMLElement;
    expect(badge.title).toContain('does NOT mean everything it writes is said on their behalf');
  });

  it('★ your own delegates card calls the delegation standing, and not an endorsement', async () => {
    const o = await open();
    await signInAndSettle(o);
    const card = text(o.doc, '#delegatelist');
    expect(card).toContain('STANDING delegations');
    expect(card).toContain('on its OWN account, where it alone is answerable');
  });

  it('★ the lobby card shows the exact register_agent call before it is made, and then makes it', async () => {
    const o = await open({ setup: (s) => { s.delegations.clear(); s.keys.length = 0; } });
    await signInAndSettle(o);
    expect(text(o.doc, '#delegatelist')).toContain('Your pod authorises no delegates');
    click(o.doc, 'delegatemint');
    await o.settle();
    // Minting is not authorising, and the card says so rather than implying a delegate exists.
    expect(text(o.doc, '#delegateresult')).toContain('your pod does not authorise it yet');
    expect(o.s.calls.some((c) => c.name === 'register_agent')).toBe(false);
    // The key is shown ONCE, with the reason it is being shown at all.
    expect(text(o.doc, '#delegatekeyout')).toContain('copy it now');
    (o.doc.getElementById('delegatename') as HTMLInputElement).value = 'Research assistant';
    (o.doc.getElementById('delegatename') as HTMLInputElement).dispatchEvent(new o.win.Event('input'));
    await o.settle();
    const plan = text(o.doc, '#delegateplan');
    expect(plan).toContain('has not been made');
    expect(plan).toContain(delegateLabel('Research assistant'));
    expect(plan).toContain('PublishOnly');
    expect(plan).toContain('name IT as the author');
    expect(plan).toContain('STANDING and it is not an endorsement of anything it will say');
    click(o.doc, 'delegateauthorise');
    await o.settle();
    expect(o.s.calls.some((c) => c.name === 'register_agent')).toBe(true);
    expect(text(o.doc, '#delegateresult')).toContain('read back from your own pod');
  });

  it('★ forgetting a key is never rendered as a revocation', async () => {
    const o = await open();
    await signInAndSettle(o);
    const forget = [...o.doc.querySelectorAll('#delegatelist button')].find((b) => (b.textContent ?? '').includes('Forget its key')) as HTMLButtonElement;
    expect(forget).not.toBe(undefined);
    forget.click();
    await o.settle();
    expect(o.s.calls.some((c) => c.name === 'revoke_agent')).toBe(false);
    expect(text(o.doc, '#delegateresult')).toContain('NOT a revocation');
    expect(text(o.doc, '#delegateresult')).toContain('still on your pod');
  });

  it('★ revoking says what survives it, and stops that delegate speaking at once', async () => {
    const o = await open({ setup: (s) => {
      (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'A question', '2026-08-07T10:00:00.000Z'));
    } });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(text(o.doc, '#agentstate')).not.toBe('Off');
    const revoke = [...o.doc.querySelectorAll('#delegatelist button')].find((b) => (b.textContent ?? '') === 'Revoke') as HTMLButtonElement;
    revoke.click();
    await o.settle();
    expect(o.s.calls.some((c) => c.name === 'revoke_agent')).toBe(true);
    expect(text(o.doc, '#delegateresult')).toContain('still names the delegate as its author');
    expect(text(o.doc, '#delegateresult')).toContain('revoking cannot reach it');
    expect(text(o.doc, '#agentstate')).toBe('Off');
    expect(text(o.doc, '#delegatelist')).toContain('Your pod authorises no delegates');
  });

  it('★ a registry that could not be read is never drawn as "you have no delegates"', async () => {
    const o = await open({ setup: (s) => {
      s.fail.set('get_pod_status', (i) => (i['pod_name'] === POD_A ? { error: 'upstream_error', message: 'the pod did not answer' } : undefined));
    } });
    await signInAndSettle(o);
    expect(text(o.doc, '#delegatelist')).toContain('not established');
    expect(text(o.doc, '#delegatelist')).not.toContain('authorises no delegates');
    const unknown = [...o.doc.querySelectorAll('#setupsteps .q')].map((n) => n.textContent ?? '');
    expect(unknown.some((t) => t.startsWith('4. A delegate'))).toBe(true);
  });

  it('★ the panel never says a delegate signed with its own key', async () => {
    // MEASURED: the proof\'s verificationMethod is the RELAY\'s one delegation key, identical for
    // every pod and every agent. Only the issuer distinguishes them.
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'A question', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: BEHALF + 'A drafted reply.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    (o.doc.getElementById('agentsend') as HTMLButtonElement).click();
    await o.settle();
    const result = text(o.doc, '#postresult');
    expect(result).toContain('the relay signed a statement that the caller it authenticated as ' + D1);
    expect(result).toContain('the relay\'s own key, the same one for every pod and every agent here');
    expect(result).toContain('NOT your delegate\'s own wallet signature');
    expect(result).not.toMatch(/signed by Claude side|signed by your delegate/);
  });

  it('★ the model provider is named as the engine, never as the identity', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'A question', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: BEHALF + 'A drafted reply.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(text(o.doc, '#agentwhy')).toContain('which is how it thinks, not who it is');
    const result = text(o.doc, '#agentresult');
    expect(result).toContain('author it will carry');
    expect(result).toContain('model it ran on');
    // The identity row must carry the DID, not the provider's name.
    expect(result).toContain(D1);
  });

  it('★ the prompt tells the model it is the delegate and not the person', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'A question', '2026-08-07T10:00:00.000Z')); },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    const prompt = o.agent.prompts[0] as string;
    expect(prompt).toContain('You are Claude side, a delegate of');
    expect(prompt).toContain('Do not impersonate them');
    expect(prompt).not.toContain('as THEIR entry');
    // ★ AND IT IS ASKED WHICH FOOTING IT IS ON, rather than told. The shell reaches the real
    // `briefPrompt`, so this is the same contract `checkDraft` parses on the way back.
    expect(prompt).toContain('FOOTING: ON THEIR BEHALF');
    expect(prompt).toContain('FOOTING: MY OWN ACCOUNT');
  });
});
