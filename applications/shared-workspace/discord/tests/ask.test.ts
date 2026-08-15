/**
 * ADDRESSING AN AGENT, AND EVERY WAY THAT GOES WRONG.
 *
 * ★ THE ASSERTIONS THAT MATTER ARE THE ONES ABOUT WHAT WAS *NOT* WRITTEN. An ask is a permanent
 * record on somebody's pod and a notice into somebody's inbox; the failure this bot must never
 * produce is one of those existing without the other making sense — a notice pointing at nothing,
 * an entry addressed to a delegate that cannot append, an ask attributed to a pod the asker does
 * not control. Each of those has a case below and each checks the absence, not just the message.
 */

import { describe, it, expect } from 'vitest';
import { presenceIri, type WorkspaceClient } from '@interego/workspace-client';
import { ask, askCandidates, askChoices, resolveTarget, AUTOCOMPLETE_MAX } from '../src/ask.js';
import { LinkStore } from '../src/links.js';
import type { Deps } from '../src/workspace.js';

const RELAY = 'https://relay.interego.xwisee.com';
const BOT = 'did:web:identity.interego.xwisee.com:agents:interego-discord-u-eth-053ad15f9633';
const MARK = 'u-eth-8f3b8e939600';
const SAM = 'u-eth-4a1f00000001';
const MARK_USER = '346810589395288076';
const THREAD = '1400000000000000001';
const SLUG = 'd-' + THREAD;
const WORKSPACE = RELAY + '/ns/' + MARK + '/' + SLUG;
const SCRIBE = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-5c81be0001';
const TRIAGE = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-u-eth-5c81be0002';
const NOW = Date.parse('2026-08-08T12:00:00.000Z');

const webid = (pod: string): string => 'https://identity.interego.xwisee.com/users/' + pod + '/profile#me';
/** The `wsp:` term in full, so a fixture cannot drift from the namespace the readers use. */
const wsp = (t: string): string => '<https://markjspivey-xwisee.github.io/interego/applications/shared-workspace/wsp#' + t + '>';

interface World {
  /** Rows each pod's delegation registry reports. */
  readonly delegates: Record<string, readonly { agentId: string; label: string; scope: string }[]>;
  /** Pods whose presence document holds a live lease. */
  readonly running?: readonly string[];
  readonly podsThatFail?: readonly string[];
  readonly seated?: readonly string[];
}

/** A relay stubbed at the tool boundary; every read below is one the real code makes. */
function world(w: World): { client: WorkspaceClient; calls: { name: string; args: Record<string, unknown> }[] } {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const seated = w.seated ?? [MARK, SAM];
  const client = {
    relay: RELAY,
    async tool(name: string, a: Record<string, unknown> = {}): Promise<unknown> {
      calls.push({ name, args: a });
      if (name === 'get_pod_status') {
        const pod = String(a['pod_name']);
        if ((w.podsThatFail ?? []).indexOf(pod) >= 0) throw new Error('that pod did not answer');
        return {
          pod: 'https://css.internal/' + pod + '/',
          registry: { owner: webid(pod) },
          delegationRegistry: {
            owner: webid(pod),
            rows: (w.delegates[pod] ?? []).map((d) => ({ agentId: d.agentId, label: d.label, scope: d.scope, validFrom: '2026-01-01T00:00:00Z' })),
          },
        };
      }
      if (name === 'discover_context') {
        const pod = String(a['pod_name']);
        const graph = String(a['graph_iri'] ?? '');
        if (graph.indexOf('-presence') > 0) {
          // ★ ONE READ, NEWEST-FIRST, NO TEMPORAL FILTER. The reader takes the HEAD and checks the
          // head's own window — because an older, longer-lived lease outlives the newer one that
          // superseded it, so "what is valid now" can hand back a claim already withdrawn.
          // ★ THE NAME CARRIES A HASH OF THE WHOLE DID NOW, so two distinct agents on one pod no
          // longer compose one address. The fixture reads the pod segment out of the same shape.
          const agentPod = /agent-(u-[a-z0-9-]+)-[0-9a-f]{16}-presence/.exec(graph)?.[1] ?? '';
          if ((w.running ?? []).indexOf(agentPod) < 0) return { entries: [] };
          return { entries: [{ descriptorUrl: 'https://css.internal/' + pod + '/lease-' + agentPod + '.ttl', validFrom: new Date(NOW - 41_000).toISOString(), validUntil: new Date(NOW + 139_000).toISOString() }] };
        }
        // The grant scan the roster fold falls back to.
        return {
          entries: seated.map((p) => ({ descriptorUrl: 'https://css/' + p + '-grant.ttl', describes: [WORKSPACE + '-grant-' + p] })),
        };
      }
      if (name === 'notify_agent') return { delivered: true, canonicalInbox: true, inbox: 'https://css/' + String(a['to']) + '/inbox' };
      throw new Error('unexpected tool ' + name);
    },
    async currentHead(iri: string): Promise<unknown> {
      const target = /-grant-(u-[a-z0-9-]+)$/.exec(iri)?.[1];
      if (target && seated.indexOf(target) >= 0) return { url: 'https://css.internal/' + target + '/grant.ttl', cid: 'c1', message: null };
      return { url: null, message: 'nothing published there' };
    },
    async descriptor(url: string): Promise<Record<string, unknown>> {
      const pod = /^https:\/\/css\.internal\/(u-[a-z0-9-]+)\//.exec(url)?.[1] ?? MARK;
      const leaseFor = /\/lease-(u-[a-z0-9-]+)\.ttl$/.exec(url)?.[1];
      if (leaseFor) {
        const agentId = 'did:web:identity.interego.xwisee.com:agents:interego-delegate-' + leaseFor;
        // ★ COMPOSED BY THE SHIPPED FUNCTION, not spelled out here. The document name carries a
        // hash of the WHOLE agent DID, and a fixture that wrote the old `agent-<pod>-presence`
        // shape by hand would locate no signed region and read as `unreadable` for a reason that
        // has nothing to do with what any of these tests are about.
        const iri = presenceIri(RELAY, agentId) as string;
        const iep = (t: string): string => '<https://markjspivey-xwisee.github.io/interego/ns/iep#' + t + '>';
        return {
          authorship: { authorshipVerified: true, signedBy: agentId, contentBinding: 'bound' },
          // ★ `iep:leaseExpires` IS IN HERE BECAUSE THE READER TURNS ON IT NOW. It used to be
          // written by every host and read by nobody — `stale`, `overlong` and the reported expiry
          // all came off the relay's own unsigned row — so a fixture without it still said
          // `running`, which measured the row and not the lease. It decides here, and a signed
          // expiry that disagrees with the row is reported as a finding rather than picked between.
          graph: { content: '<' + iri + '> {\n<' + iri + '> ' + iep('presenceOf') + ' <' + agentId + '> ;\n  '
            + '<http://purl.org/dc/terms/created> "' + new Date(NOW - 41_000).toISOString() + '" ;\n  '
            + iep('leaseExpires') + ' "' + new Date(NOW + 139_000).toISOString() + '" ;\n  '
            + iep('presenceHost') + ' "a test host" .\n}' },
        };
      }
      if (url.indexOf('/acc.ttl') > 0) {
        const iri = RELAY + '/ns/' + pod + '/' + MARK + '--' + SLUG + '-acceptance';
        return {
          // Names the grant's DESCRIPTOR URL — the older of the two accepted forms, and the one
          // `foldRoster` seats without also needing a pinned revision.
          graph: { content: '<' + iri + '> {\n<' + iri + '> ' + wsp('accepts') + ' <https://css.internal/' + pod + '/grant.ttl> ;\n  '
            + wsp('stream') + ' <' + RELAY + '/ns/' + pod + '/' + MARK + '--' + SLUG + '-stream> .\n}' },
          authorship: { signedBy: 'did:web:x:agents:' + pod, authorshipVerified: true },
        };
      }
      const iri = WORKSPACE + '-grant-' + pod;
      return {
        graph: { content: '<' + iri + '> {\n<' + iri + '> ' + wsp('grantedTo') + ' <' + webid(pod) + '> ;\n  '
          + wsp('workspace') + ' <' + WORKSPACE + '> .\n}' },
      };
    },
    async resolveMemberDoc(memberPod: string): Promise<unknown> {
      return { iri: RELAY + '/ns/' + memberPod + '/' + MARK + '--' + SLUG + '-acceptance', naming: 'qualified', found: true, head: { url: 'https://css.internal/' + memberPod + '/acc.ttl', cid: 'a1' }, forked: null, error: null };
    },
    async readWorkspaceRecord(): Promise<unknown> {
      return { kind: 'record', record: { head: { url: 'u', cid: 'c' }, regionFound: true, withheld: false, visibility: 'public' as const, convener: webid(MARK), roleProfile: null, entryShape: null, grantCapability: null, title: 'Roof decision', authorship: null, convenerPod: MARK, servedFrom: MARK } };
    },
  } as unknown as WorkspaceClient;
  return { client, calls };
}

function deps(client: WorkspaceClient, store: LinkStore): Deps {
  return { relay: RELAY, client, agentId: BOT, store };
}

function store(opts: { linked?: boolean; bound?: boolean } = {}): LinkStore {
  const s = new LinkStore('C:\\nonexistent\\ask-test-' + Math.random().toString(36).slice(2) + '.json');
  // The store writes to disk on `bind`; these tests only read, so the write path is stubbed out.
  (s as unknown as { save(): void }).save = (): void => { /* not persisted in a test */ };
  if (opts.linked !== false) {
    s.bind({ discordUserId: MARK_USER, pod: MARK, webId: webid(MARK), boundAt: 'now', scopeAtBinding: 'PublishOnly', basisAtBinding: 'signed-chain' });
  }
  if (opts.bound !== false) {
    s.bindThread({ threadId: THREAD, convenerPod: MARK, workspace: WORKSPACE, slug: SLUG, title: 'Roof decision', startedAt: 'now', startedBy: MARK_USER });
  }
  return s;
}

const TWO_DELEGATES: World = {
  delegates: {
    [SAM]: [
      { agentId: SCRIBE, label: 'delegate sam-scribe', scope: 'PublishOnly' },
      { agentId: TRIAGE, label: 'delegate sam-triage', scope: 'ReadOnly' },
    ],
    // ★ THE BOT'S OWN ROW IS HERE AND IS NOT A DELEGATE. Its label is `discord-link <id>`, not
    // `delegate <name>`, so `readDelegates` puts it in `others` — which is exactly why the picker
    // never offers the conduit itself as somebody who can be asked anything.
    [MARK]: [{ agentId: BOT, label: 'discord-link ' + MARK_USER, scope: 'PublishOnly' }],
  },
  running: ['u-eth-5c81be0001'],
};

describe('who can be asked', () => {
  it('reads each seated pod\'s OWN registry and reports presence per delegate', async () => {
    const { client } = world(TWO_DELEGATES);
    const out = await askCandidates(deps(client, store()), { threadId: THREAD, discordUserId: MARK_USER, nowMs: NOW });
    expect(out.kind).toBe('candidates');
    if (out.kind !== 'candidates') return;
    expect(out.targets.map((t) => t.name)).toEqual(['sam-scribe', 'sam-triage']);
    expect(out.targets[0]?.presence.state).toBe('running');
    // ★ PER AGENT, NOT PER HUMAN. One person, two delegates, two different answers.
    expect(out.targets[1]?.presence.state).toBe('never');
    expect(out.noneOn).toContain(MARK);
  });

  it('reports a pod that did not answer as unread — never as "they have no agents"', async () => {
    const { client } = world({ ...TWO_DELEGATES, podsThatFail: [SAM] });
    const out = await askCandidates(deps(client, store()), { threadId: THREAD, discordUserId: MARK_USER, nowMs: NOW });
    if (out.kind !== 'candidates') throw new Error('expected candidates');
    expect(out.targets).toHaveLength(0);
    expect(out.unread.map((u) => u.pod)).toEqual([SAM]);
  });

  it('says nothing at all about a thread that is not a workspace', async () => {
    const { client } = world(TWO_DELEGATES);
    const out = await askCandidates(deps(client, store({ bound: false })), { threadId: THREAD, discordUserId: MARK_USER });
    expect(out.kind).toBe('not-a-workspace');
  });
});

describe('the picker', () => {
  it('values every choice with the full agent DID, never a nickname', async () => {
    const { client } = world(TWO_DELEGATES);
    const out = await askCandidates(deps(client, store()), { threadId: THREAD, discordUserId: MARK_USER, nowMs: NOW });
    const choices = askChoices(out, '', NOW);
    expect(choices.map((c) => c.value)).toContain(SCRIBE);
    expect(choices[0]?.name).toContain('said so');
    expect(choices.length).toBeLessThanOrEqual(AUTOCOMPLETE_MAX);
  });

  it('puts an agent that said it was running first', async () => {
    const { client } = world(TWO_DELEGATES);
    const out = await askCandidates(deps(client, store()), { threadId: THREAD, discordUserId: MARK_USER, nowMs: NOW });
    expect(askChoices(out, '', NOW)[0]?.value).toBe(SCRIBE);
  });

  it('turns an empty list into a sentence saying WHICH kind of empty it is', async () => {
    // ★ Discord renders a list and nothing else, so "nobody has agents" and "nobody's pod
    // answered" would look identical — and the second is a failed read drawn as a fact about
    // other people's pods.
    const { client } = world({ delegates: {}, podsThatFail: [SAM, MARK] });
    const out = await askCandidates(deps(client, store()), { threadId: THREAD, discordUserId: MARK_USER, nowMs: NOW });
    const rows = askChoices(out, '', NOW);
    expect(rows.some((r) => r.name.indexOf('did not answer') >= 0)).toBe(true);
    expect(rows.every((r) => r.value.startsWith('?'))).toBe(true);
  });
});

describe('resolving what somebody typed', () => {
  it('matches a full DID exactly and a label case-insensitively', async () => {
    const { client } = world(TWO_DELEGATES);
    const d = deps(client, store());
    expect((await resolveTarget(d, { threadId: THREAD, discordUserId: MARK_USER, spec: SCRIBE, nowMs: NOW })).kind).toBe('resolved');
    expect((await resolveTarget(d, { threadId: THREAD, discordUserId: MARK_USER, spec: 'SAM-SCRIBE', nowMs: NOW })).kind).toBe('resolved');
  });

  it('refuses rather than guessing when a label matches two', async () => {
    const { client } = world({
      delegates: { [SAM]: [
        { agentId: SCRIBE, label: 'delegate sam-scribe', scope: 'PublishOnly' },
        { agentId: TRIAGE, label: 'delegate other-scribe', scope: 'PublishOnly' },
      ], [MARK]: [] },
    });
    const got = await resolveTarget(deps(client, store()), { threadId: THREAD, discordUserId: MARK_USER, spec: 'scribe', nowMs: NOW });
    expect(got.kind).toBe('ambiguous');
  });

  it('lists what the pods DO name when nothing matches', async () => {
    const { client } = world(TWO_DELEGATES);
    const got = await resolveTarget(deps(client, store()), { threadId: THREAD, discordUserId: MARK_USER, spec: 'nobody', nowMs: NOW });
    expect(got.kind).toBe('no-match');
    if (got.kind !== 'no-match') return;
    expect(got.known.join(' ')).toContain('sam-scribe');
  });
});

describe('asking', () => {
  it('writes an entry addressed to the delegate and, for a running host, sends NO notice', async () => {
    const { client, calls } = world(TWO_DELEGATES);
    // The write path is exercised through `recordMessage`; only the publish is stubbed out here,
    // because what this asserts is the composition, not the relay.
    const published: Record<string, unknown>[] = [];
    const c = { ...client, async manifest(): Promise<unknown[]> { return []; } } as unknown as WorkspaceClient;
    const orig = c.tool.bind(c);
    (c as unknown as { tool: WorkspaceClient['tool'] }).tool = async (name, a) => {
      if (name === 'publish_context') { published.push(a); return { status: 'committed', descriptorUrl: 'https://css/e7.ttl' }; }
      if (name === 'verify_agent') return { enforcement: { writeEligible: true, scope: 'PublishOnly', basis: 'signed-chain', examinedPod: MARK } };
      return orig(name, a);
    };
    const out = await ask(deps(c, store()), {
      threadId: THREAD, discordUserId: MARK_USER, spec: SCRIBE, task: 'Check the underlay photos.', nowMs: NOW,
    });
    expect(out.kind).toBe('asked');
    if (out.kind !== 'asked') return;
    // ★ `iep:` AND NOT `wsp:`. Addressing an agent is not something a room invented — a Foxxi
    // record, a bare script's record and this entry must spell it identically, or an agent reading
    // two of them gets two answers to one question.
    expect(String(published[0]?.['graph_content'])).toContain('iep:addressedTo <' + SCRIBE + '>');
    expect(String(published[0]?.['pod_name'])).toBe(MARK);
    // ★ A RUNNING HOST IS ALREADY READING THE CHANNEL. A notice would be a second pointer at a
    // thing it is about to read anyway, and sending one regardless trains every reader to treat
    // the inbox as where requests live.
    expect(out.notice.attempted).toBe(false);
    expect(calls.some((k) => k.name === 'notify_agent')).toBe(false);
  });

  /**
   * ★★ THE MAILBOX. MEASURED LIVE, AND IT MADE ASK-AND-WAKE A SILENT DROP FOR A WHOLE RELEASE.
   *
   * The notice went to `target.pod` — the seated MEMBER's pod, i.e. the delegate's delegator. A
   * hosted delegate reads its inbox through its OWN session, and the relay answers
   * `read_inbox: forbidden — you may only read your own inbox` for any other pod. Two different
   * mailboxes: the request sat unread forever while the desktop panel reported "nothing was
   * waiting", `wake()` could never fire, and `verifyRequest`'s six checks never ran in production
   * once. A request vanishing into silence is worse than the feature not existing.
   *
   * The delegate's own pod is what `readPresence` and `readCapabilities` already derive from the
   * same DID — so everything about an agent is addressed from its id, including where to knock.
   */
  it('★★ sends the notice to the ADDRESSEE\'s own pod, not to its delegator\'s', async () => {
    const { client, calls } = world({ ...TWO_DELEGATES, running: [] });
    const c = { ...client, async manifest(): Promise<unknown[]> { return []; } } as unknown as WorkspaceClient;
    const orig = c.tool.bind(c);
    (c as unknown as { tool: WorkspaceClient['tool'] }).tool = async (name, a) => {
      if (name === 'publish_context') return { status: 'committed', descriptorUrl: 'https://css/e7.ttl' };
      if (name === 'verify_agent') return { enforcement: { writeEligible: true, scope: 'PublishOnly', basis: 'signed-chain', examinedPod: MARK } };
      return orig(name, a);
    };
    const out = await ask(deps(c, store()), {
      threadId: THREAD, discordUserId: MARK_USER, spec: SCRIBE, task: 'Check the underlay photos.', nowMs: NOW,
    });
    expect(out.kind).toBe('asked');
    if (out.kind !== 'asked') return;
    expect(out.notice.attempted).toBe(true);
    const sent = calls.filter((k) => k.name === 'notify_agent');
    expect(sent).toHaveLength(1);
    // `interego-delegate-u-eth-5c81be0001` → `u-eth-5c81be0001`. NOT `MARK`, whose seat it writes
    // under and whose registry authorises it — two different facts about two different pods.
    expect(sent[0]?.args['to']).toBe('u-eth-5c81be0001');
    expect(sent[0]?.args['to']).not.toBe(MARK);
    expect(out.target.agentPod).toBe('u-eth-5c81be0001');
    expect(out.target.pod).toBe(SAM);
    // And the acknowledgement says which pod it went to, so the two cannot be conflated on screen.
    expect(out.checks.some((k) => k.text.includes('u-eth-5c81be0001'))).toBe(true);
  });

  it('★ sends nothing at all, and says so, when it cannot name the addressee\'s pod', async () => {
    // A cross-issuer delegate — a Codex agent, a `did:key` — carries no pod segment this client can
    // read. Guessing a mailbox would be delivering into somebody else's inbox; the ask is still on
    // the record, which is what a host actually reads.
    const CODEX = 'did:web:codex.example.com:agents:codex-build-bot';
    const { client, calls } = world({
      delegates: {
        // The conduit's own row, so the ask can be written at all — see TWO_DELEGATES.
        [MARK]: [{ agentId: BOT, label: 'discord-link ' + MARK_USER, scope: 'PublishOnly' }],
        [SAM]: [{ agentId: CODEX, label: 'delegate codex', scope: 'PublishOnly' }],
      },
      running: [],
    });
    const c = { ...client, async manifest(): Promise<unknown[]> { return []; } } as unknown as WorkspaceClient;
    const orig = c.tool.bind(c);
    (c as unknown as { tool: WorkspaceClient['tool'] }).tool = async (name, a) => {
      if (name === 'publish_context') return { status: 'committed', descriptorUrl: 'https://css/e7.ttl' };
      if (name === 'verify_agent') return { enforcement: { writeEligible: true, scope: 'PublishOnly', basis: 'signed-chain', examinedPod: MARK } };
      return orig(name, a);
    };
    const out = await ask(deps(c, store()), { threadId: THREAD, discordUserId: MARK_USER, spec: CODEX, task: 'x', nowMs: NOW });
    expect(out.kind).toBe('asked');
    if (out.kind !== 'asked') return;
    expect(out.notice.attempted).toBe(false);
    expect(out.notice.why).toContain('cannot take a pod out of');
    expect(calls.some((k) => k.name === 'notify_agent')).toBe(false);
  });

  it('writes nothing when the target\'s own pod will not let it append', async () => {
    const { client, calls } = world(TWO_DELEGATES);
    const out = await ask(deps(client, store()), {
      threadId: THREAD, discordUserId: MARK_USER, spec: TRIAGE, task: 'anything', nowMs: NOW,
    });
    expect(out.kind).toBe('target-cannot-append');
    expect(calls.some((k) => k.name === 'publish_context')).toBe(false);
    expect(calls.some((k) => k.name === 'notify_agent')).toBe(false);
  });

  it('writes nothing and sends nothing for an unlinked asker', async () => {
    const { client, calls } = world(TWO_DELEGATES);
    const out = await ask(deps(client, store({ linked: false })), {
      threadId: THREAD, discordUserId: MARK_USER, spec: SCRIBE, task: 'x', nowMs: NOW,
    });
    expect(out.kind).toBe('not-linked');
    expect(calls).toHaveLength(0);
  });

  it('writes nothing for an empty task, because an empty entry is still a permanent record', async () => {
    const { client, calls } = world(TWO_DELEGATES);
    const out = await ask(deps(client, store()), { threadId: THREAD, discordUserId: MARK_USER, spec: SCRIBE, task: '   ', nowMs: NOW });
    expect(out.kind).toBe('empty-task');
    expect(calls).toHaveLength(0);
  });
});
