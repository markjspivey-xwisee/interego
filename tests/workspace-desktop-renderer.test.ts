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
import { capabilitiesIri, entryTurtle, presenceIri, type EntryAuthor } from '@interego/workspace-client';

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
  /**
   * The VIEWER's inbox. Every other pod's is {@link Scripted.inboxOf}.
   *
   * ★ ONE SHARED INBOX WAS A HARNESS THAT COULD NOT EXPRESS THE DEFECT IT WAS MEANT TO CATCH.
   * `read_inbox` answered identically for every session, so a request delivered to a delegate's
   * DELEGATOR's pod appeared in the DELEGATE's read — and the ask-and-wake path passed here for a
   * whole release while, live, the relay refuses any pod but the caller's and the notice sat unread
   * forever. A double that answers a question the substrate refuses cannot verify anything about it.
   */
  inbox: Record<string, unknown>[];
  /** Per-pod inboxes, keyed by the pod whose SESSION is asking. The viewer's is `inbox` above. */
  inboxOf: Map<string, Record<string, unknown>[]>;
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
    /**
     * ★ EVERY DELEGATE HAS ITS OWN POD, BECAUSE ON THE LIVE RELAY IT DOES. A delegate is a keypair
     * that signs into the relay in its own right, so the relay issues it a pod exactly as it issues
     * one to a person — and its DID CARRIES that pod, which is what makes its presence and
     * capability documents addressable from the DID alone. The fixture had only the two humans'
     * pods, so every write a delegate made to its OWN pod came back `scope_violation` — a 403 that
     * would have looked, in any test that did not read the response, exactly like the shell
     * declining to write. That is the failure this line removes.
     */
    pods: new Map([
      [POD_A, a], [POD_B, b],
      [podOfDelegate(D1), new Pod(podOfDelegate(D1))], [podOfDelegate(D2), new Pod(podOfDelegate(D2))],
    ]),
    inbox: [], inboxOf: new Map(), fail: new Map(), calls: [], writeEligible: true,
    // One delegate authorised on A's pod, with its key here — the ordinary state a person is in
    // once they have set one up. Cases about having none, or having one hosted elsewhere, say so.
    delegations: new Map([[POD_A, [delegationRow(D1, delegateLabel('Claude side'))]]]),
    keys: [{ address: KEY('0x1'), agentId: D1, why: null }],
  };
}

/** A delegate DID in the shape the live relay issues: the surface constant, then a pod. */
const DELEGATE = (n: string): string => 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-' + n;
/**
 * The delegate's OWN pod, read back out of its DID.
 *
 * Spelled here rather than imported so the fixture and the code under test derive it independently
 * — if they ever disagree about where a lease lives, that disagreement should fail a test rather
 * than be shared by both sides of it.
 */
const podOfDelegate = (did: string): string => did.slice(did.lastIndexOf('u-eth-'));
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
    case 'read_inbox': {
      // ★ THE CALLER'S OWN POD AND NOTHING ELSE, WHICH IS WHAT THE RELAY DOES. Measured:
      // `read_inbox: forbidden — you may only read your own inbox` for any other pod. So a notice
      // delivered to pod X is invisible to a session on pod Y, and a test that wants the delegate
      // to see something has to put it in the DELEGATE's inbox.
      if (input['pod_url']) return { error: 'forbidden', message: 'read_inbox: forbidden — you may only read your own inbox' };
      // The SESSION's pod, which for a delegate's own call is the pod inside its DID — not its
      // delegator's. That difference is the whole defect this keying exists to make expressible.
      const sessionPod = caller === 'did:ethr:0xsession' ? viewerPod : podOfDelegate(caller) ?? viewerPod;
      const items = sessionPod === viewerPod ? s.inbox : s.inboxOf.get(sessionPod) ?? [];
      return {
        inbox: 'http://css.railway.internal:3456/' + sessionPod + '/inbox/',
        count: items.length,
        items: items.slice(0, Number(input['limit'] ?? 50)),
      };
    }
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
      // ★ AN AGENT NEEDS NO DELEGATION TO WRITE ITS OWN POD, and modelling that is not a loosening
      // — it is the reason a presence lease is worth anything. A lease is the agent's statement
      // ABOUT ITSELF, so it goes where its own key owns the pod; measured on the live relay, the
      // same document written cross-pod under a delegation reads back authorshipVerified:false,
      // because the descriptor binding holds the proof's owner against the pod it landed on. A
      // harness that demanded a delegation row here would have made the only address where a
      // self-claim is CHECKABLE the one address it refused.
      const ownPod = caller !== 'did:ethr:0xsession' && podOfDelegate(caller) === target;
      if (caller !== 'did:ethr:0xsession' && !ownPod) {
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
  /** The account keyring the "main process" holds, and what the renderer did to it. */
  accounts: AccountScript;
  settle: () => Promise<void>;
  /** Push a session change the way the main process does, through the listener the shell installed. */
  pushSession: (s: Record<string, unknown>) => void;
}

/**
 * THE ACCOUNT KEYRING, WHICH IS THE OTHER SIDE OF THE IPC BOUNDARY.
 *
 * ★ WHAT IS SCRIPTED AND WHAT IS NOT, because the distinction is the whole value of these cases.
 * SCRIPTED: the OS secret store and the SIWE ceremony — a keychain and a live relay are exactly the
 * two things a jsdom document cannot have. NOT scripted: `checkPrivateKey`, which is REAL renderer
 * code bundled in from `src/privatekey.ts`, so every refusal asserted below is the sentence the
 * shipping app produces. `importPk` records what actually crossed, so a case can assert that a
 * malformed key was refused BEFORE the boundary rather than merely refused somewhere.
 *
 * ★ AND THE POD IS LOOKED UP, NEVER DERIVED. `pods` maps an address to whatever the scripted relay
 * answers, and the addresses used below deliberately do NOT match `u-eth-<first 12 hex>` — a shell
 * that computed the pod name from the address would pass a harness that derived it the same way,
 * and would then address a pod that does not exist the day the relay changes.
 */
interface AccountScript {
  /** address (lower case) -> the pod the scripted relay answers for that key. */
  readonly pods: Map<string, string>;
  /** What this machine holds, in the shape `account:list` returns. */
  keys: { address: string; pod: string | null; active: boolean; unreadable: string | null }[];
  /** Every private key that actually crossed the boundary. Empty is the assertion for a pre-flight refusal. */
  importPk: string[];
  /** Addresses `account:signInAs` was asked for, and addresses `account:forget` deleted. */
  switched: string[];
  forgotten: string[];
  signOuts: number;
  /** Make the sign-in half of an import fail, with the key already stored. A real state. */
  importFails?: string;
  /**
   * Make the import refuse BEFORE storing anything — what happens with no OS secret store.
   *
   * ★ A SEPARATE FLAG FROM {@link importFails} BECAUSE THEY ARE OPPOSITE FACTS ABOUT THE KEYRING,
   * and the shell says a different sentence for each. Collapsing them would let the copy claim a
   * key is safe on this machine when there was nowhere to put it.
   */
  refuseStore?: string;
  /** How long an import takes, so the in-flight sentence can be sampled the way a cold start is. */
  importMs?: number;
  /** What `window.confirm` answers. jsdom has no real one, and a dialog is a decision, not a detail. */
  confirm: boolean;
  confirms: string[];
}

/** An address the scripted relay knows, whose pod is deliberately unrelated to its hex. */
const ACCT = (n: string): string => '0x' + n.repeat(40).slice(0, 40);
/** A syntactically valid, in-range secp256k1 scalar. Not a real key and never used against anything. */
const PK = (n: string): string => '0x' + n.repeat(64).slice(0, 64);

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
async function open(opts: {
  viewer?: string; setup?: (s: Scripted) => void; coldStartMs?: number; agent?: AgentScript;
  accounts?: Partial<AccountScript>;
} = {}): Promise<Opened> {
  /**
   * ★ MUTABLE, BECAUSE SWITCHING IDENTITY IS THE FEATURE. Every scripted answer below reads this,
   * so signing in as a second key changes which pod the relay answers for, exactly as it does live.
   * A fixed viewer would have let a shell that ignored the switch pass.
   */
  let viewer = opts.viewer ?? POD_A;
  const agent: AgentScript = { prompts: [], cancels: 0, ...opts.agent };
  const accounts: AccountScript = {
    pods: new Map(), keys: [], importPk: [], switched: [], forgotten: [], signOuts: 0,
    confirm: true, confirms: [], ...opts.accounts,
  };
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
  /**
   * ★ A CONFIRMATION IS A DECISION AND IS SCRIPTED AS ONE. jsdom's `window.confirm` is a stub that
   * returns undefined, which is falsy — so a destructive path guarded by one would appear to be
   * refused in every test whether the guard existed or not, and deleting the guard would stay
   * green. This answers what the case says it answers, and records that it was asked.
   */
  (win as unknown as Record<string, unknown>)['confirm'] = (message?: string): boolean => {
    accounts.confirms.push(String(message ?? ''));
    return accounts.confirm;
  };
  let sessionListener: ((x: unknown) => void) | null = null;
  /** A live session, announced through the listener the shell installed, as the main process does. */
  const live = (pod: string): void => {
    sessionListener?.({ state: 'live', pod, method: 'wallet', expiresAt: Date.now() + 3600_000, renewable: true, why: null });
  };
  /** The pod the scripted relay answers for one account key. Looked up; never derived from the hex. */
  const podOfKey = (address: string): string => {
    const pod = accounts.pods.get(address.toLowerCase());
    if (!pod) throw new Error('the scripted relay knows no pod for ' + address + ' — name one in `accounts.pods`');
    return pod;
  };
  /** Adopt a key as the live identity: the pod changes, and so does what every later read answers. */
  const becomeAccount = (address: string): { pod: string; displayName: null; method: string; address: string } => {
    const pod = podOfKey(address);
    viewer = pod;
    for (const k of accounts.keys) (k as { active: boolean }).active = k.address === address.toLowerCase();
    const held = accounts.keys.find((k) => k.address === address.toLowerCase());
    if (held) held.pod = pod;
    live(pod);
    return { pod, displayName: null, method: 'wallet', address };
  };
  (win as unknown as Record<string, unknown>)['interego'] = {
    describe: async () => ({
      relay: RELAY, identityServer: 'https://identity.interego.xwisee.com',
      secretStore: true, hasStoredWallet: accounts.keys.length > 0, accounts: accounts.keys.slice(),
      signedInAs: null,
      session: { state: 'signed-out', pod: null, method: null, expiresAt: null, renewable: false, why: null },
      watchDescription: 're-read on a timer, not pushed',
    }),
    signInWithWallet: async () => {
      live(viewer);
      return { pod: viewer, displayName: null, method: 'wallet', address: '0x1', mintedNewKey: false };
    },
    signInWithBrowser: async () => ({ pod: viewer, displayName: null, method: 'browser' }),
    accountList: async () => ({ accounts: accounts.keys.slice(), secretStore: true }),
    /**
     * ★ THE MAIN PROCESS'S OWN GUARD IS SCRIPTED TOO, and it is the same one. The renderer refusing
     * a bad key is a courtesy; this refusing it is the guard, and a harness whose bridge accepted
     * anything would let a case assert "the renderer refused" while the real boundary did not.
     */
    accountImport: async (pk: string) => {
      accounts.importPk.push(pk);
      if (!/^0x[0-9a-f]{64}$/.test(pk)) throw new Error('That is not a secp256k1 private key. Nothing was stored.');
      if (accounts.refuseStore) throw new Error(accounts.refuseStore);
      const address = ACCT(pk.slice(2, 3));
      const before = accounts.keys.map((k) => k.address);
      const alreadyHeld = before.includes(address.toLowerCase());
      // Stored BEFORE the sign-in is attempted, exactly as the shipping handler does — which is
      // what makes the failing case below able to assert the honest copy about it.
      if (!alreadyHeld) accounts.keys.push({ address: address.toLowerCase(), pod: null, active: false, unreadable: null });
      if (accounts.importMs) await new Promise((r) => { setTimeout(r, accounts.importMs); });
      if (accounts.importFails) throw new Error(accounts.importFails);
      return { ...becomeAccount(address), alreadyHeld, kept: before.filter((a) => a !== address.toLowerCase()) };
    },
    accountSignInAs: async (address: string) => {
      accounts.switched.push(address);
      if (!accounts.keys.some((k) => k.address === address.toLowerCase())) {
        throw new Error('This machine holds no account key for ' + address + '.');
      }
      return becomeAccount(address);
    },
    accountForget: async (address: string) => {
      accounts.forgotten.push(address);
      accounts.keys = accounts.keys.filter((k) => k.address !== address.toLowerCase());
      return { forgotten: address, accounts: accounts.keys.slice() };
    },
    signOut: async () => {
      accounts.signOuts++;
      sessionListener?.({ state: 'signed-out', pod: null, method: null, expiresAt: null, renewable: false, why: null });
      return { accounts: accounts.keys.slice() };
    },
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
    doc: dom.window.document, win, s, agent, accounts, settle,
    pushSession: (next) => { sessionListener?.(next); },
  };
}

const text = (doc: Document, sel: string): string => (doc.querySelector(sel)?.textContent ?? '');
const click = (doc: Document, id: string): void => { (doc.getElementById(id) as HTMLElement).click(); };

/**
 * The publishes that put something in somebody's LOG, as against the ones that say a host is up.
 *
 * ★ THIS DISTINCTION IS THE POINT AND NOT A TEST CONVENIENCE. Switching a delegate on now writes a
 * presence lease — a short, signed, self-superseding document on the AGENT's own pod saying its
 * host is running — and every one of these cases asserts that a DRAFT was not published. Those two
 * facts are both true at once, and a `some(c => c.name === 'publish_context')` cannot express it:
 * it would either fail on the lease or, if the lease were removed to satisfy it, stop the agent
 * being visible to anybody else. Filtering on the graph is what keeps the assertion saying what it
 * meant, and {@link presencePublishes} pins the other half rather than leaving it unasserted.
 */
const entryPublishes = (o: Opened): { name: string; input: Record<string, unknown> }[] =>
  o.s.calls.filter((c) => c.name === 'publish_context' && !/\/agent-[^/]*-(presence|capabilities)$/.test(String(c.input['graph_iri'] ?? '')));

/** The presence leases. A lease is not an entry and must never be counted as one. */
const presencePublishes = (o: Opened): { name: string; input: Record<string, unknown> }[] =>
  o.s.calls.filter((c) => c.name === 'publish_context' && String(c.input['graph_iri'] ?? '').endsWith('-presence'));

/** The capability documents — what an agent says it can be asked, at its own DID-derived address. */
const capabilityPublishes = (o: Opened): { name: string; input: Record<string, unknown> }[] =>
  o.s.calls.filter((c) => c.name === 'publish_context' && String(c.input['graph_iri'] ?? '').endsWith('-capabilities'));
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

/**
 * ADDRESSING SOMEBODY ELSE'S AGENT FROM THIS SHELL, WHICH IT COULD NOT DO AT ALL.
 *
 * ★ THE ASYMMETRY THIS CLOSES, AND IT WAS COMPLETE. `wake()` here verifies an incoming ask
 * against `iep:addressedTo` and refuses anything not naming a key this machine holds; the shell
 * advertised an `askVia` inbox saying "you may address me"; and `postEntry` has accepted an
 * `addressedTo` argument since it was written. This surface supplied it ZERO times — `git log -S`
 * over the desktop directory returned no commit that ever contained the term. So the app could
 * receive a request and had no way whatsoever to make one, and the only client that could was
 * the Discord conduit.
 */
describe('addressing: naming which agent a message is for', () => {
  /** Somebody else's delegate, authorised on THEIR pod — the case the roster rail draws. */
  const withTheirDelegate = (s: Scripted, over: { scope?: string } = {}): void => {
    seatDelegate(s, POD_B, {
      agentId: D2, name: 'their scribe', hosted: false, ...(over.scope ? { scope: over.scope } : {}),
    });
  };
  /**
   * The Ask on ONE named delegate's row.
   *
   * ★ SELECTED BY DID AND NEVER BY POSITION. The first draft of this took the first `Ask …` in
   * the roster and got the VIEWER'S OWN delegate every time, because your own agents are listed
   * too — and they are addressable too, which is the point. A positional helper would have made
   * every case here silently assert something about the wrong agent.
   */
  const askButton = (o: Opened, did: string): HTMLButtonElement | null => {
    const row = [...o.doc.querySelectorAll('#roster .member')].find((m) => (m.textContent ?? '').includes(did));
    return (row?.querySelector('button') as HTMLButtonElement | null) ?? null;
  };

  it('★ writes iep:addressedTo into the entry, naming the agent that was chosen', async () => {
    const o = await open({ setup: withTheirDelegate });
    await signInAndSettle(o);
    const ask = askButton(o, D2);
    expect(ask?.textContent).toBe('Ask their scribe');
    ask?.click();
    await o.settle();
    (o.doc.getElementById('composer') as HTMLTextAreaElement).value = 'please summarise the thread';
    click(o.doc, 'send');
    await o.settle();
    const sent = entryPublishes(o).pop();
    expect(String(sent?.input['graph_content'])).toContain('iep:addressedTo <' + D2 + '>');
    // And the panel states the triple rather than the UI gesture, like every other line there.
    expect(text(o.doc, '#postresult')).toContain('iep:addressedTo ' + D2);
  });

  it('an ordinary post names no addressee at all, which is the unchanged default', async () => {
    const o = await open({ setup: withTheirDelegate });
    await signInAndSettle(o);
    (o.doc.getElementById('composer') as HTMLTextAreaElement).value = 'just talking';
    click(o.doc, 'send');
    await o.settle();
    const sent = entryPublishes(o).pop();
    expect(String(sent?.input['graph_content'])).not.toContain('iep:addressedTo');
    expect(text(o.doc, '#postresult')).toContain('this entry names no iep:addressedTo');
  });

  it('★ the addressee does NOT stick to the next message', async () => {
    // A sticky addressee makes "thanks" a second permanent request to the same agent, silently.
    const o = await open({ setup: withTheirDelegate });
    await signInAndSettle(o);
    askButton(o, D2)?.click();
    await o.settle();
    (o.doc.getElementById('composer') as HTMLTextAreaElement).value = 'first, addressed';
    click(o.doc, 'send');
    await o.settle();
    expect((o.doc.getElementById('askrow') as HTMLElement).hidden).toBe(true);
    (o.doc.getElementById('composer') as HTMLTextAreaElement).value = 'second, to nobody';
    click(o.doc, 'send');
    await o.settle();
    expect(String(entryPublishes(o).pop()?.input['graph_content'])).not.toContain('iep:addressedTo');
  });

  it('★ points the inbox on the ADDRESSEE\'s own pod, never its delegator\'s', async () => {
    // The bug this pins was measured and fixed once already on the Discord side: `read_inbox` is
    // own-pod only, so a notice sent to the seated member's pod lands where the agent cannot look.
    const o = await open({ setup: withTheirDelegate });
    await signInAndSettle(o);
    askButton(o, D2)?.click();
    await o.settle();
    (o.doc.getElementById('composer') as HTMLTextAreaElement).value = 'wake up and read this';
    click(o.doc, 'send');
    await o.settle();
    const notice = o.s.calls.filter((c) => c.name === 'notify_agent').pop();
    expect(notice?.input['to']).toBe(podOfDelegate(D2));
    expect(notice?.input['to']).not.toBe(POD_B);
    // ★ AND IT CARRIES NO TASK TEXT. An inbox on this relay is world-writable, so anything that
    // travelled by inbox is something a forger could have written. The pointer is the payload.
    expect(String(notice?.input['summary'] ?? '')).not.toContain('wake up and read this');
    expect(notice?.input['about']).toBeTruthy();
  });

  it('★ offers no Ask on a delegate its own pod will not let publish', async () => {
    // It could read the ask and never append the answer, leaving a permanent unanswerable entry
    // on YOUR log. Only its delegator can change that.
    const o = await open({ setup: (s) => { withTheirDelegate(s, { scope: 'ReadOnly' }); } });
    await signInAndSettle(o);
    expect(askButton(o, D2)?.disabled).toBe(true);
    expect(askButton(o, D2)?.getAttribute('title') ?? '').toContain('could read your ask and never answer it');
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

  /**
   * ★ THE DEFECT, DRAWN. Measured on the maintainer's own pod (2026-08-11): twenty retired test
   * memberships were listed as twenty rows, each carrying an honest explanation of why it was not
   * a workspace, and the ONE workspace he was really in was lost among them. Honest, and useless.
   *
   * The tombstone bytes below are the live ones: a supersession carrying `iep:modalStatus
   * "Retracted"` as a plain literal inside the signed block, and no `wsp:workspace` at all.
   */
  describe('★ retired acceptances do not crowd out the workspace you are actually in', () => {
    const RETIRED_ACC = (n: number): string => RELAY + '/ns/' + POD_A + '/' + POD_A + '--dead-' + n + '-acceptance';
    const tombstone = (iri: string): string =>
      '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .\n'
      + '@prefix dct: <http://purl.org/dc/terms/> .\n'
      + '<' + iri + '> {\n    <' + iri + '>\n      iep:modalStatus "Retracted" ;\n'
      + '      dct:description "Test membership created by an automated driver; retired during cleanup." .\n}\n';
    const withTwentyTombstones = (s: Scripted): void => {
      const a = s.pods.get(POD_A) as Pod;
      for (let n = 0; n < 20; n++) {
        a.put({ graph: RETIRED_ACC(n), cid: 'cid-dead-' + n, url: DESC(POD_A, 500 + n), content: tombstone(RETIRED_ACC(n)) });
      }
    };

    it('lists exactly the one live workspace, and puts no Open control on a retired one', async () => {
      const o = await open({ setup: withTwentyTombstones });
      await signInAndSettle(o);
      // One row in the list proper — the workspace this viewer is really in.
      expect(o.doc.querySelectorAll('#wslist > .item')).toHaveLength(1);
      expect(text(o.doc, '#wslist > .item')).toContain(WS);
      // And not one of the twenty offers anywhere to go.
      expect([...o.doc.querySelectorAll('#wslist button')].map((b) => b.textContent))
        .not.toContain('Open it anyway');
      for (let n = 0; n < 20; n++) {
        const row = [...o.doc.querySelectorAll('#wslist > .item')].find((r) => (r.textContent ?? '').includes(RETIRED_ACC(n)));
        expect(row, 'a retired acceptance must not be a row in the list of places to go').toBe(undefined);
      }
    });

    it('★ keeps every diagnostic — the count is on screen and the detail is one disclosure away', async () => {
      const o = await open({ setup: withTwentyTombstones });
      await signInAndSettle(o);
      const panel = o.doc.querySelector('#wslist details.withheld') as HTMLElement;
      expect(panel, 'the diagnostics must still be reachable, just not in the list').not.toBe(null);
      expect(text(o.doc, '#wslist details.withheld > summary')).toContain('20 acceptances');
      expect(text(o.doc, '#wslist details.withheld > summary')).toContain('retired by you');
      // Collapsed, so it states the count without competing with the one row above it.
      expect(panel.hasAttribute('open')).toBe(false);
      const body = panel.textContent ?? '';
      for (let n = 0; n < 20; n++) expect(body).toContain(RETIRED_ACC(n));
      expect(body).toContain('iep:modalStatus "Retracted"');
      // And the boot checklist accounts for them rather than quietly losing twenty records.
      expect(text(o.doc, '#lobbysteps')).toContain('20 retired');
    });

    it('★ draws "retired" and "could not be read" as different facts, never as one', async () => {
      const HALF = RELAY + '/ns/' + POD_A + '/half-acceptance';   // unqualified: the workspace must be read
      const o = await open({ setup: (s) => {
        withTwentyTombstones(s);
        (s.pods.get(POD_A) as Pod).put({
          graph: HALF, cid: 'cid-half', url: DESC(POD_A, 560),
          content: trig(HALF, '<' + HALF + '> dct:description "a read that came back short" .'),
        });
      } });
      await signInAndSettle(o);
      const panel = o.doc.querySelector('#wslist details.withheld') as HTMLElement;
      expect(text(o.doc, '#wslist details.withheld > summary')).toContain('20 retired by you');
      expect(text(o.doc, '#wslist details.withheld > summary')).toContain('1 this client could not read');
      // The two groups are separate elements with separate copy — a shell that rendered one
      // sentence for both would pass a substring test on either alone.
      const retiredHead = panel.querySelector('.note.retired') as HTMLElement;
      const badHead = panel.querySelector('.note.bad') as HTMLElement;
      expect(retiredHead.textContent).toContain('read out of the document, not guessed from what is missing');
      expect(badHead.textContent).toContain('NOT being reported as a retraction');
      // The short read is in the "could not be read" group and NOWHERE in the retired one.
      const bad = [...panel.querySelectorAll('.item.bad')].map((n) => n.textContent ?? '').join(' ');
      const retired = [...panel.querySelectorAll('.item.retired')].map((n) => n.textContent ?? '').join(' ');
      expect(bad).toContain(HALF);
      expect(retired).not.toContain(HALF);
    });

    it('★ a member who retired their own acceptance is not folded into the roster as seated', async () => {
      // The other half of the seat, and the one only the MEMBER can withdraw. Before this, the
      // fold read their acceptance's `wsp:accepts` and kept them seated and their log folded in.
      const o = await open({ setup: (s) => {
        (s.pods.get(POD_B) as Pod).put({
          graph: ACC(POD_B), cid: 'cid-acc-b2', url: DESC(POD_B, 21),
          content: tombstone(ACC(POD_B)),
        });
      } });
      await signInAndSettle(o);
      const roster = text(o.doc, '#roster');
      expect(roster).toContain('withdrawn it on their own pod');
      expect(roster).toContain('The grant naming them still stands');
      // ★ AND NOT AS A REVOCATION. Nobody unseated them.
      expect(roster).not.toContain('this grant was revoked');
    });

    it('★ a grant the convener retired is refused, and not reported as wsp:revoked', async () => {
      const o = await open({ setup: (s) => {
        (s.pods.get(POD_A) as Pod).put({ graph: GRANT_B, cid: 'cid-grant-b3', url: DESC(POD_A, 99), content: tombstone(GRANT_B) });
      } });
      await signInAndSettle(o);
      const roster = text(o.doc, '#roster');
      expect(roster).toContain('withdrawn it as an assertion');
      expect(roster).toContain('not the same as wsp:revoked');
      expect(roster).not.toContain('this grant was revoked.');
    });
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
    // ★ THE KEY THAT SIGNED IT, WHICH IS THE ONE INPUT TO AUTHORSHIP THAT IS NOT IN THE BYTES.
    // A delegate's entry is signed by the DELEGATE; a person's is carried by whatever key put it
    // on their pod. `judgeAuthorship` returns a delegate verdict only where the agent the entry
    // names is the agent that signed it — so a fixture that left this off would be exercising a
    // record the readers now (correctly) call disputed, which is not what these tests are about.
    authorship: { signedBy: by ?? WEBID(pod), authorshipVerified: true, contentBinding: 'bound' },
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
    expect(entryPublishes(o)).toHaveLength(0);
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
    const ttl = String(entryPublishes(o).slice(-1)[0]?.input['graph_content']);
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
    expect(entryPublishes(o)).toHaveLength(0);
  });

  /**
   * ★ THE AGENT IS NOW A PARTICIPANT OTHER PEOPLE CAN SEE, AND THIS PINS BOTH HALVES OF THAT.
   *
   * Before this, an agent could read the channel, think on its human's own subscription and append
   * a signed answer — and there was no way for anybody anywhere to find out it existed, was
   * available, or had just gone away. A Discord picker offering it would have been guessing.
   */
  it('★ switching a delegate on publishes a SHORT lease, on the AGENT\'s own pod, with its own key', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide about the roof?', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: OWN + 'A reply.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    const leases = presencePublishes(o);
    expect(leases).toHaveLength(1);
    const lease = leases[0]?.input as Record<string, unknown>;
    // ★ THE AGENT'S OWN POD, DERIVED FROM ITS DID — not the delegator's. Measured on the live
    // relay: a cross-pod write under a delegation reads back authorshipVerified:false, because the
    // descriptor binding holds the proof's owner against the pod the bytes landed on. A lease
    // nobody can verify is not evidence.
    const ownPod = D1.slice(D1.lastIndexOf('u-'));
    // ★ THE ADDRESS IS THE SHIPPED COMPOSITION, and it carries a hash of the WHOLE DID: two agents
    // sharing a pod used to compose one name, and the later publisher deleted the earlier one.
    expect(String(lease['graph_iri'])).toBe(presenceIri(RELAY, D1));
    expect(lease['pod_name']).toBe(ownPod);
    expect(lease['sign_authorship']).toBe(true);
    // One head, because a forked lease leaves a reader choosing between two claims about one
    // running process with no honest basis for choosing.
    expect(lease['auto_supersede_prior']).toBe(true);
    // ★ SHORT, AND THAT IS THE WHOLE MECHANISM. Past `valid_until` the relay's own temporal filter
    // stops answering for the document, so nothing anywhere runs a timer or notices an outage.
    const span = Date.parse(String(lease['valid_until'])) - Date.parse(String(lease['valid_from']));
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThanOrEqual(3 * 90_000);
    // It names itself INSIDE the signed region, so the filename is not the only thing claiming it.
    expect(String(lease['graph_content'])).toContain('iep:presenceOf <' + D1 + '>');
    // And the person is told, in their own panel, that this went out on their behalf.
    expect(text(o.doc, '#agentwhy')).toContain('said its host was running');
  });

  /**
   * ★ PRESENCE WITHOUT THIS IS HALF AN ANSWER. A peer that reads "its host is running" still has no
   * idea what it can be asked or by what route, and would have to guess.
   */
  it('★ also publishes what it can be asked, with iep:askVia and NO endpoint to call', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide?', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: OWN + 'A reply.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    const caps = capabilityPublishes(o);
    expect(caps).toHaveLength(1);
    expect(String(caps[0]?.input['graph_iri'])).toBe(capabilitiesIri(RELAY, D1));
    const ttl = String(caps[0]?.input['graph_content']);
    // ★ THIS AGENT RUNS ON SOMEBODY'S LAPTOP AND HAS NO ENDPOINT THAT WILL EVER ANSWER, so
    // advertising a `hydra:target` would advertise a call that cannot connect.
    expect(ttl).toContain('iep:askVia');
    expect(ttl).not.toContain('hydra:target');
    expect(ttl).toContain('iep:capabilityOf <' + D1 + '>');
    /**
     * ★★ AND THE ROUTE IS THE ADDRESS THE RELAY REPORTS FOR THIS DELEGATE'S OWN SESSION.
     *
     * It used to be `<relay>/ns/<the HUMAN's pod>/inbox`, composed here. That is wrong twice: it is
     * a `/ns/` graph name and 404s — measured against the live relay — so the ONE route a stranger
     * holding only the DID was told to use dereferenced to nothing; and it named the delegator's
     * pod, which is not the mailbox this agent polls, because the relay refuses `read_inbox` for
     * any pod but the caller's. Its own inbox is an address `notify_agent` accepts directly.
     */
    const ownPod = D1.slice(D1.lastIndexOf('u-'));
    expect(ttl).toContain('iep:askVia <http://css.railway.internal:3456/' + ownPod + '/inbox/>');
    expect(ttl).not.toContain('/ns/' + POD_A + '/inbox');
    expect(ttl).not.toContain('/ns//inbox');
  });

  it('★ publishes NOTHING when the relay names no inbox for that session, rather than a guess', async () => {
    const o = await open({
      setup: (s) => {
        (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide?', '2026-08-07T10:00:00.000Z'));
        s.fail.set('read_inbox', () => ({ count: 0, items: [] }));
      },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: OWN + 'A reply.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(capabilityPublishes(o)).toHaveLength(0);
    // A route nobody can deliver to is not a smaller offer than none; it is an offer that fails
    // silently at the far end, so the panel says the advertisement did not go out.
    expect(text(o.doc, '#agentwhy')).toContain('NOT managed to publish what it can be asked');
  });

  it('does not republish the capability on every heartbeat — it does not change every 90s', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide?', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: OWN + 'A reply.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    click(o.doc, 'agenttoggle');
    await o.settle();
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(capabilityPublishes(o)).toHaveLength(1);
  });

  /**
   * ★ THE DURABLE HALF OF "HAVE I ALREADY ANSWERED THIS", AND WITHOUT IT IT IS A COMMENT.
   *
   * `A.answered` dies with the process. A host restarted after answering reads the same ask, judges
   * it unanswered, and appends a SECOND permanent record saying the same thing to somebody's public
   * log — which cannot be edited or deleted. The link on the pod is what the next run, and the
   * substrate's own request verifier, walk to find out the answer already exists.
   */
  it('★ a delegate\'s answer DECLARES the ask it answers, so a restart cannot answer it twice', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide about the roof?', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: OWN + 'Patching buys a year.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    click(o.doc, 'agentsend');
    await o.settle();
    const ttl = String(entryPublishes(o).slice(-1)[0]?.input['graph_content']);
    // The ask it answered is the entry already in POD_B's log, by its descriptor URL.
    expect(ttl).toMatch(/prov:wasDerivedFrom <[^>]+>/);
    // `prov:` and not a minted term: "this was derived from that" is what PROV-O already says.
    expect(ttl).not.toContain('wsp:answers');
  });

  /**
   * ★★ WHICH MAILBOX THE HOST ACTUALLY POLLS, PINNED FROM BOTH SIDES.
   *
   * `wake()` reads through the DELEGATE's own session, and the relay answers
   * `read_inbox: forbidden — you may only read your own inbox` for any other pod. So a notice
   * delivered to the delegator's pod — which is where the Discord conduit sent every one of them
   * for a release — is invisible here, forever, while the panel says "nothing was waiting". The
   * unit double used to answer one shared inbox for every session, which is exactly why this
   * passed while production dropped every request on the floor.
   */
  it('★★ reads the DELEGATE\'s own inbox, and a notice on its delegator\'s pod is not in it', async () => {
    const ownPod = D1.slice(D1.lastIndexOf('u-'));
    const o = await open({
      // ★ NOTHING FOR IT TO ANSWER, deliberately: the point here is the inbox read, and a delegate
      // mid-draft is `busy` and does not wake. Every OTHER agent test covers the drafting path.
      setup: (s) => {
        // Delivered where the ask path USED to send it: the delegator's pod. Never seen.
        s.inbox = [{ type: 'Question', about: DESC(POD_B, 200), actor: 'did:ethr:0xB', summary: 'a request' }];
      },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    const why = text(o.doc, '#agentwhy');
    // The panel names the address it read, so "nothing was waiting" and "this read the wrong
    // mailbox" can never again be the same sentence on screen.
    expect(why).toContain('http://css.railway.internal:3456/' + ownPod + '/inbox/');
    expect(why).toContain('Nothing was waiting');
  });

  it('a PERSON\'s post declares no such link, because a person is not looping', async () => {
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide?', '2026-08-07T10:00:00.000Z')); },
    });
    await signInAndSettle(o);
    (o.doc.getElementById('composer') as HTMLTextAreaElement).value = 'I think we re-tile.';
    click(o.doc, 'send');
    await o.settle();
    expect(String(entryPublishes(o).slice(-1)[0]?.input['graph_content'])).not.toContain('wasDerivedFrom');
  });

  it('★ switching it off RETRACTS NOTHING — the lease lapses on its own', async () => {
    // ★ A RETRACTION WOULD BE A LIE OF OMISSION IN THE OTHER DIRECTION. A host that CRASHES cannot
    // publish one either, so a design that depended on a retraction would report a crashed agent as
    // available indefinitely. Lapsing is the behaviour that is the same for a clean stop and a
    // power cut, which is why it is the one that can be trusted.
    const o = await open({
      setup: (s) => { (s.pods.get(POD_B) as Pod).put(entry(POD_B, 0, 'What did we decide?', '2026-08-07T10:00:00.000Z')); },
      agent: { prompts: [], cancels: 0, think: () => ({ ok: true, text: OWN + 'A reply.', why: 'ok', ms: 900 }) },
    });
    await signInAndSpeak(o);
    click(o.doc, 'agenttoggle');
    await o.settle();
    const afterOn = presencePublishes(o).length;
    click(o.doc, 'agenttoggle');
    await o.settle();
    expect(presencePublishes(o)).toHaveLength(afterOn);
    expect(text(o.doc, '#agentwhy')).toContain('lapses on its own');
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
    expect(entryPublishes(o)).toHaveLength(0);
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
    expect(entryPublishes(o)).toHaveLength(0);
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
    const published = entryPublishes(o);
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
    const ttl = String(entryPublishes(o)[0]?.input['graph_content']);
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
    const ttl = String(entryPublishes(o)[0]?.input['graph_content']);
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
        // Signed by the delegate it names — the footing is what is missing here, not the signature.
        authorship: { signedBy: D1, authorshipVerified: true, contentBinding: 'bound' },
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

// ── signing in as an identity you already have ───────────────────────────────

/** One row of the sign-in keyring, found by the address it names. */
const accountRow = (o: Opened, address: string): HTMLElement => {
  const rows = [...o.doc.querySelectorAll('#signin-accounts .panel')] as HTMLElement[];
  const row = rows.find((r) => (r.textContent ?? '').includes(address));
  if (!row) throw new Error('the sign-in keyring lists no row for ' + address);
  return row;
};
const accountButton = (o: Opened, address: string, label: string): HTMLButtonElement => {
  const b = ([...accountRow(o, address).querySelectorAll('button')] as HTMLButtonElement[])
    .find((x) => (x.textContent ?? '').includes(label));
  if (!b) throw new Error('no "' + label + '" control for ' + address);
  return b;
};
/** Paste a key into the sign-in field and press the button, the way a person does. */
async function pasteAccountKey(o: Opened, value: string): Promise<void> {
  (o.doc.getElementById('signin-importkey') as HTMLInputElement).value = value;
  click(o.doc, 'signin-import');
  await o.settle();
}
const importHint = (o: Opened): string => text(o.doc, '#signin-importhint');

/**
 * THE GAP THIS WHOLE GROUP EXISTS FOR, FOUND BY THE MAINTAINER USING THE APP FOR REAL.
 *
 * "Use a wallet key on this machine" MINTED a key when it did not find one, and there was no way to
 * hand it a key you already had. Somebody whose pod already holds everything they have written
 * signed in and got a THIRD, empty identity. Two identities belonging to one human corrupt
 * everything downstream — the roster shows two members, attribution splits, and whose delegate an
 * agent is stops being answerable — so the affordance that makes one person one identity is worth
 * as many cases as the failure modes it has, which is what these are.
 */
describe('signing in with a wallet key you already have', () => {
  const KEY_A = PK('a');
  const KEY_B = PK('b');
  const ADDR_A = ACCT('a');
  const ADDR_B = ACCT('b');
  /** Two keys the scripted relay knows, whose pods are deliberately unrelated to their hex. */
  const twoKeys = (): Partial<AccountScript> => ({
    pods: new Map([[ADDR_A.toLowerCase(), POD_A], [ADDR_B.toLowerCase(), POD_B]]),
    keys: [{ address: ADDR_A.toLowerCase(), pod: POD_A, active: true, unreadable: null }],
  });

  it('★ a key that is not a key is refused by NAME, and never crosses the boundary', async () => {
    const o = await open({ accounts: twoKeys() });
    await pasteAccountKey(o, '0xnot-a-key-at-all');
    expect(importHint(o)).toContain('"n" at character 3');
    expect(importHint(o)).toContain('not a hexadecimal digit');
    // ★ THE ASSERTION THAT MAKES THIS A GUARD RATHER THAN A LABEL. Nothing was handed to the main
    // process, so a mistyped key never left this window at all.
    expect(o.accounts.importPk).toEqual([]);
    expect(o.doc.getElementById('signin')?.hasAttribute('hidden')).toBe(false);
  });

  it('★ an ADDRESS pasted by mistake is told it is an address, not told "invalid key"', async () => {
    const o = await open({ accounts: twoKeys() });
    await pasteAccountKey(o, ADDR_B);
    expect(importHint(o)).toContain('length of an Ethereum ADDRESS');
    expect(importHint(o)).toContain('cannot sign for it');
    expect(o.accounts.importPk).toEqual([]);
  });

  it('★ a short copy is told it is short, and a long one is told it is long', async () => {
    const o = await open({ accounts: twoKeys() });
    await pasteAccountKey(o, '0x' + 'a'.repeat(63));
    expect(importHint(o)).toContain('63 hexadecimal characters');
    expect(importHint(o)).toContain('this copy is short');
    await pasteAccountKey(o, '0x' + 'a'.repeat(70));
    expect(importHint(o)).toContain('70 hexadecimal characters');
    expect(importHint(o)).toContain('more than one key\'s worth');
    expect(o.accounts.importPk).toEqual([]);
  });

  it('★ 64 valid hex digits that are not a valid scalar are refused for THAT reason', async () => {
    const o = await open({ accounts: twoKeys() });
    // Zero and the group order itself: the two values a length-and-hex regex waves straight through.
    await pasteAccountKey(o, '0x' + '0'.repeat(64));
    expect(importHint(o)).toContain('all of them are zero');
    await pasteAccountKey(o, '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141');
    expect(importHint(o)).toContain('at or above the secp256k1 group order');
    expect(importHint(o)).toContain('not a truncation');
    expect(o.accounts.importPk).toEqual([]);
  });

  /**
   * ★ AND A LINE BREAK IS NOT WHAT ARRIVES HERE, WHICH THIS CASE FOUND ON ITS FIRST RUN.
   *
   * It was written with a `\n` in the middle, and passed the key straight through: an `<input>` is
   * single-line, so the HTML value sanitisation algorithm STRIPS CR and LF on the way in and the
   * renderer never sees one. Splicing a wrapped key back together silently is exactly the
   * behaviour the guard exists to prevent, and it is the DOM doing it, one layer below anything
   * this app can refuse. What survives a paste into a single-line field is the SPACE a wrap often
   * becomes, so that is what is asserted — and the `\s` guard still earns its place on the main
   * process's side of the boundary, where a key can arrive from anywhere.
   */
  it('★ a key with a space through the middle is refused rather than silently spliced together', async () => {
    const o = await open({ accounts: twoKeys() });
    await pasteAccountKey(o, '0x' + 'a'.repeat(32) + ' ' + 'a'.repeat(32));
    expect(importHint(o)).toContain('space or a line break inside it');
    expect(o.accounts.importPk).toEqual([]);
  });

  it('★ a valid key signs in as the pod the RELAY answered — never one derived from the address', async () => {
    const o = await open({ accounts: twoKeys() });
    await pasteAccountKey(o, KEY_B);
    expect(o.accounts.importPk).toEqual([KEY_B]);
    // The address is 0xbbbb…; a shell deriving `u-eth-<first 12 hex>` would say `u-eth-bbbbbbbbbbbb`.
    expect(text(o.doc, '#whoami')).toBe(POD_B);
    expect(text(o.doc, '#whoami')).not.toContain('bbbb');
    expect(o.doc.getElementById('signin')?.hasAttribute('hidden')).toBe(true);
    expect(o.doc.getElementById('signoutbtn')?.hasAttribute('hidden')).toBe(false);
  });

  it('★ the key is out of the field the instant it is read, and is nowhere in the document', async () => {
    const o = await open({ accounts: twoKeys() });
    await pasteAccountKey(o, KEY_B);
    expect((o.doc.getElementById('signin-importkey') as HTMLInputElement).value).toBe('');
    // Not just the field: nothing the shell drew may contain it, including the success copy.
    expect(o.doc.body.textContent ?? '').not.toContain(KEY_B.slice(2));
    for (const i of [...o.doc.querySelectorAll('input,textarea')] as HTMLInputElement[]) {
      expect(i.value).not.toContain(KEY_B.slice(2));
    }
  });

  it('★ importing a second identity KEEPS the first, and the screen says which', async () => {
    const o = await open({ accounts: twoKeys() });
    await pasteAccountKey(o, KEY_B);
    const note = text(o.doc, '#signinnote');
    expect(note).toContain('was KEPT');
    expect(note).toContain(ADDR_A.toLowerCase());
    expect(note).toContain('Nothing was overwritten');
    // ★ AND IT IS TRUE, NOT MERELY SAID. The keyring still holds both, and nothing was deleted.
    expect(o.accounts.keys.map((k) => k.address).sort()).toEqual([ADDR_A.toLowerCase(), ADDR_B.toLowerCase()].sort());
    expect(o.accounts.forgotten).toEqual([]);
  });

  it('★ re-pasting a key this machine already holds is a re-use, not a second identity', async () => {
    const o = await open({ accounts: twoKeys() });
    await pasteAccountKey(o, KEY_A);
    expect(text(o.doc, '#signinnote')).toContain('already held that key');
    expect(o.accounts.keys).toHaveLength(1);
  });

  it('★ a pod that does not exist yet is a WAIT with a measured range, not a failure', async () => {
    const o = await open({ accounts: { ...twoKeys(), importMs: 250 } });
    (o.doc.getElementById('signin-importkey') as HTMLInputElement).value = KEY_B;
    click(o.doc, 'signin-import');
    // Sampled WHILE it is in flight: the sentence belongs to the `wait` state and is correctly
    // replaced by the outcome. Asserting after settle would be asserting it never finished.
    let seen = '';
    for (let i = 0; i < 300 && !seen.includes('provisions'); i++) {
      await new Promise((r) => { setTimeout(r, 2); });
      seen = text(o.doc, '#steps');
    }
    expect(seen).toContain('provisions one on this first call');
    expect(seen).toContain('2 to 31 seconds');
    expect(seen).not.toContain('did not complete');
    // ★ `settle` CANNOT BE USED TO WAIT FOR THIS, and assuming it could is what this line found.
    // It waits for the shell to stop making TOOL CALLS, and a sign-in in flight makes none — so it
    // returned instantly, mid-provision, and the assertion below read an empty header. The thing to
    // wait for is the outcome itself.
    for (let i = 0; i < 400 && !text(o.doc, '#whoami'); i++) await new Promise((r) => { setTimeout(r, 4); });
    await o.settle();
    expect(text(o.doc, '#whoami')).toBe(POD_B);
  });

  it('★ a failed sign-in says the key WAS stored, because it was', async () => {
    const o = await open({ accounts: { ...twoKeys(), importFails: 'the relay refused this wallet proof' } });
    await pasteAccountKey(o, KEY_B);
    const note = text(o.doc, '#signinnote');
    expect(note).toContain('the relay refused this wallet proof');
    // ★ THE COPY THE DELEGATE IMPORT GOT WRONG. It stored the key and then said "nothing was
    // stored" — a false sentence about the one thing a person needs to know the truth of.
    expect(note).toContain('The key WAS stored on this machine');
    expect(note).not.toContain('did not change');
    expect(o.doc.getElementById('signin')?.hasAttribute('hidden')).toBe(false);
    // Every way back in is usable again, and the stored key is listed so it can be retried.
    for (const id of ['signin-wallet', 'signin-browser', 'signin-import']) {
      expect((o.doc.getElementById(id) as HTMLButtonElement).disabled).toBe(false);
    }
    expect(accountRow(o, ADDR_B.toLowerCase())).toBeTruthy();
  });

  it('★ and an import refused BEFORE storing does not claim the key is on this machine', async () => {
    // What happens with no OS secret store: there is nowhere to put a key that is not a plaintext
    // file, so the handler refuses before storing. A fixed "the key was stored" would tell somebody
    // their identity is safe here when it is nowhere.
    const o = await open({ accounts: { ...twoKeys(),
      refuseStore: 'The OS secret store is not available on this machine. NOTHING WAS STORED.' } });
    await pasteAccountKey(o, KEY_B);
    const note = text(o.doc, '#signinnote');
    expect(note).toContain('NOTHING WAS STORED');
    expect(note).toContain('keyring did not change');
    expect(note).not.toContain('The key WAS stored on this machine');
    expect(o.accounts.keys.map((k) => k.address)).toEqual([ADDR_A.toLowerCase()]);
  });

  it('★ the keyring names a pod only where the relay named one', async () => {
    const o = await open({ accounts: {
      pods: new Map([[ADDR_B.toLowerCase(), POD_B]]),
      keys: [{ address: ADDR_B.toLowerCase(), pod: null, active: true, unreadable: null }],
    } });
    expect(accountRow(o, ADDR_B.toLowerCase()).textContent).toContain('not established here');
    expect(accountRow(o, ADDR_B.toLowerCase()).textContent).toContain('does not work pod names out from addresses');
    expect(accountRow(o, ADDR_B.toLowerCase()).textContent).not.toContain('u-eth-bbbb');
  });

  it('★ a stored key that will not decrypt is shown as unreadable, and is not offered to sign in with', async () => {
    const o = await open({ accounts: {
      pods: new Map([[ADDR_A.toLowerCase(), POD_A]]),
      keys: [{ address: ADDR_A.toLowerCase(), pod: POD_A, active: false, unreadable: 'it was encrypted by a different OS user account' } ],
    } });
    const row = accountRow(o, ADDR_A.toLowerCase());
    expect(row.textContent).toContain('could not be read back');
    expect(row.textContent).toContain('a different OS user account');
    // ★ ABSENT AND UNREADABLE ARE DIFFERENT STATES. Offering "sign in with this" for a key that
    // cannot be read would fail every time; hiding the row entirely would tell somebody their pod
    // is gone when the key is still sitting there.
    //
    // ★ THE EXACT SET OF CONTROLS, NOT "NOT THIS ONE LABEL", AND THAT DISTINCTION IS WHY THIS LINE
    // READS AS IT DOES. It was written as `not.toContain('Sign in with this key')` and a mutant
    // that offered the button anyway SURVIVED: the row is not the active key, so the button it drew
    // said "Sign in with this one instead" and the assertion sailed past the very thing it named.
    expect(([...row.querySelectorAll('button')] as HTMLButtonElement[]).map((b) => b.textContent))
      .toEqual(['Delete this key from this machine']);
  });

  it('★ switching: signing out returns the card, and the other key signs in as its OWN pod', async () => {
    const o = await open({ accounts: twoKeys() });
    await signInAndSettle(o);
    expect(text(o.doc, '#whoami')).toBe(POD_A);
    click(o.doc, 'signoutbtn');
    await o.settle();
    expect(o.accounts.signOuts).toBe(1);
    expect(o.doc.getElementById('signin')?.hasAttribute('hidden')).toBe(false);
    expect(o.doc.getElementById('shell')?.hasAttribute('hidden')).toBe(true);
    expect(o.doc.getElementById('lobby')?.hasAttribute('hidden')).toBe(true);
    expect(text(o.doc, '#whoami')).toBe('');
    // ★ AND NOTHING OF THE PREVIOUS IDENTITY'S READS IS LEFT ON SCREEN UNDER THE NEXT ONE'S NAME.
    expect(text(o.doc, '#wstitle')).toBe('');
    // Now the second identity, from the keyring rather than from a paste.
    await pasteAccountKey(o, KEY_B);
    expect(o.accounts.switched).toEqual([]);
    expect(text(o.doc, '#whoami')).toBe(POD_B);
  });

  it('★ signing out keeps every key — it is not forgetting', async () => {
    const o = await open({ accounts: twoKeys() });
    await signInAndSettle(o);
    click(o.doc, 'signoutbtn');
    await o.settle();
    expect(o.accounts.forgotten).toEqual([]);
    expect(o.accounts.keys).toHaveLength(1);
    expect(accountRow(o, ADDR_A.toLowerCase())).toBeTruthy();
  });

  it('★ a stored key signs in through its own control, and that is the switch', async () => {
    const o = await open({ accounts: {
      pods: new Map([[ADDR_A.toLowerCase(), POD_A], [ADDR_B.toLowerCase(), POD_B]]),
      keys: [
        { address: ADDR_A.toLowerCase(), pod: POD_A, active: true, unreadable: null },
        { address: ADDR_B.toLowerCase(), pod: POD_B, active: false, unreadable: null },
      ],
    } });
    accountButton(o, ADDR_B.toLowerCase(), 'Sign in with this one instead').click();
    await o.settle();
    expect(o.accounts.switched).toEqual([ADDR_B.toLowerCase()]);
    expect(text(o.doc, '#whoami')).toBe(POD_B);
    // No key crossed the boundary: switching to a key already held must never re-send one.
    expect(o.accounts.importPk).toEqual([]);
  });

  it('★ deleting a key ASKS first, names what becomes unreachable, and obeys a no', async () => {
    const o = await open({ accounts: { ...twoKeys(), confirm: false } });
    accountButton(o, ADDR_A.toLowerCase(), 'Delete this key').click();
    await o.settle();
    expect(o.accounts.confirms[0]).toContain('permanently unreachable');
    expect(o.accounts.confirms[0]).toContain(POD_A);
    expect(o.accounts.confirms[0]).toContain('no recovery');
    // ★ A DIALOG THAT IS NOT OBEYED IS A DIALOG THAT IS NOT A GUARD.
    expect(o.accounts.forgotten).toEqual([]);
    expect(accountRow(o, ADDR_A.toLowerCase())).toBeTruthy();
  });

  /**
   * ★ THE STATE A REVIEW OF THE MAIN PROCESS FOUND, AND THE WAY OUT OF IT.
   *
   * Deleting the ACTIVE key while others remain leaves a machine holding keys with none chosen.
   * `accountSlots` marks a single key active on its own but will not pick between several, because
   * picking decides somebody's identity for them — and the plain wallet button's "nothing stored, so
   * mint" branch fell straight through that condition, minting a fresh empty pod for somebody
   * holding two real ones. The main process now refuses and says to pick one; this asserts that
   * picking one is a thing the screen actually offers, so the refusal is not a dead end.
   */
  it('★ deleting the active key leaves the others signable, so "none chosen" has a way out', async () => {
    const o = await open({ accounts: {
      pods: new Map([[ADDR_A.toLowerCase(), POD_A], [ADDR_B.toLowerCase(), POD_B]]),
      keys: [
        { address: ADDR_A.toLowerCase(), pod: POD_A, active: true, unreadable: null },
        { address: ADDR_B.toLowerCase(), pod: POD_B, active: false, unreadable: null },
      ],
    } });
    accountButton(o, ADDR_A.toLowerCase(), 'Delete this key').click();
    await o.settle();
    expect(o.accounts.keys.map((k) => k.address)).toEqual([ADDR_B.toLowerCase()]);
    accountButton(o, ADDR_B.toLowerCase(), 'Sign in with this').click();
    await o.settle();
    expect(text(o.doc, '#whoami')).toBe(POD_B);
  });

  it('★ deleting a key on a yes actually deletes it, and the row goes', async () => {
    const o = await open({ accounts: twoKeys() });
    accountButton(o, ADDR_A.toLowerCase(), 'Delete this key').click();
    await o.settle();
    expect(o.accounts.forgotten).toEqual([ADDR_A.toLowerCase()]);
    expect(o.doc.querySelectorAll('#signin-accounts .panel')).toHaveLength(0);
  });

  it('★ minting a fresh key says, in the same breath, that it is not a door to a pod you have', async () => {
    // No stored key at all: the plain wallet button is the only path, and it mints.
    const o = await open({ accounts: { pods: new Map(), keys: [] } });
    expect(o.doc.querySelectorAll('#signin-accounts .panel')).toHaveLength(0);
    (o.win as unknown as { interego: { signInWithWallet: () => Promise<unknown> } }).interego.signInWithWallet = async () =>
      ({ pod: POD_A, displayName: null, method: 'wallet', address: ADDR_A, mintedNewKey: true });
    await signInAndSettle(o);
    const note = text(o.doc, '#signinnote');
    expect(note).toContain('brand new pod with nothing on it yet');
    expect(note).toContain('sign out and paste its key instead');
    expect(note).toContain('not another door to it');
  });
});
