/**
 * @module model/delegate
 * @description THE DELEGATE AFFORDANCE — seating, reading, revoking and attributing an agent
 *              that acts for a human. The live half of `model/delegation.ts`.
 *
 * ── WHY THIS IS AT THE SUBSTRATE AND NOT IN A VERTICAL ───────────────────────────────────────
 *
 * ★ THIS FILE WAS WRITTEN INSIDE `@interego/workspace-client` AND THAT WAS A LAYERING DEFECT.
 * "An agent a person authorises to act for them" is an Interego concept: `model/delegation.ts`
 * has carried `AuthorizedAgentData.delegatedBy` — "the owner who delegated authority to this
 * agent" — since the protocol rename, `iep:Delegate rdfs:subClassOf iep:AuthorizedAgent` has been
 * in `docs/ns/iep.ttl` just as long, and the relay has enforced a pod-resident delegation registry
 * at `<pod>/agents` the whole time. Shared-workspace is ONE vertical; Foxxi, agentic-performance,
 * the agent mesh, the Discord conduit and the desktop shell all need the same thing. A second
 * vertical reaching sideways into a peer's client package for it is worse than either of them
 * having it, so it is here, where all of them can compose it.
 *
 * ★ AND WHAT WAS ACTUALLY DUPLICATED, WHICH IS THE PART THAT WOULD HAVE ROTTED. The vertical
 * re-declared `DelegationScope` as its own union of the same four strings, and declared a
 * `Delegate` row type that was a lossy copy of `AuthorizedAgentData` — same `agentId`, `scope`,
 * `label`, `validFrom`, but dropping `delegatedBy`, `revoked` and `capabilities`. Two spellings
 * of one registry row, one of which could not represent a revocation. Both are gone: the scope
 * union is imported from `./types.js` and a delegate row IS an `AuthorizedAgentData`, widened
 * with the two fields a reader derives from it and nothing else.
 *
 * ── WHAT A DELEGATE IS, EXACTLY ──────────────────────────────────────────────────────────────
 *
 * A keypair, and a row on the delegator's own pod naming the DID that key resolves to. That is
 * the whole of it. In particular:
 *
 *  · IT IS NOT A CHANNEL. Discord, a desktop app and a published artifact are surfaces a
 *    delegate SPEAKS THROUGH. The same delegate in two surfaces is one identity, and nothing
 *    about the surface appears in what establishes who authored a record. How a record ARRIVED
 *    is a different question from who wrote it, and this file answers only the second.
 *  · IT IS NOT THE HOST. An app holds a delegate's key; it does not own the delegate. The
 *    authoritative roster of a person's delegates is their POD's delegation registry — see
 *    {@link readDelegates} — and a delegate whose key lives on another machine appears in it
 *    exactly like one this app can drive.
 *  · IT IS NOT THE MODEL PROVIDER. Two delegates may both run on the same model and still be two
 *    delegates. Nothing here keys identity on a provider, and a UI that called one "the Claude
 *    agent" would be making provider and identity the same thing.
 *  · IT IS NOT AN AGENT CARD. `@interego/agent-interop` projects an agent's PUBLIC CAPABILITIES
 *    for peers to call. This is its AUTHORITY on one person's pod. One agent id can have both,
 *    either, or neither; they are two facets of one identity, not two kinds of agent, and
 *    nothing here mints a second notion of who an agent is.
 *  · THERE MAY BE SEVERAL. `register_agent` writes one row per agent and a pod carries many, so
 *    one person can authorise an Anthropic-backed delegate and an OpenAI-backed one, each with
 *    its own DID, its own scope and its own revocation. Everything below is plural.
 *
 * ★ AND THE MEASUREMENT THAT DECIDES {@link DELEGATE_SURFACE}, WHICH IS THE WHOLE REASON IT
 * EXISTS. Measured against the live relay, 2026-08-07, one secp256k1 key signed in three times:
 *
 *   client_name "interego-delegate"          -> did:web:identity…:agents:interego-delegate-u-eth-37a1a26c1551
 *   client_name "interego-delegate" (again)     the SAME did
 *   client_name "interego-workspace-desktop" -> did:web:identity…:agents:interego-workspace-desktop-u-eth-37a1a26c1551
 *
 * So the relay derives the agent DID from the pod (which is the key) AND the OAuth `client_name`
 * the host registered. A host that signed its delegates in under its OWN client name would mint
 * a DIFFERENT delegate per app: reinstall under another name, or speak through another surface,
 * and the same key becomes somebody else. The constant below is the fix, and it belongs at the
 * SUBSTRATE precisely because every host in every vertical has to use the same one for the
 * sentence "one delegate, several surfaces" to be true.
 */

import type { IRI } from './types.js';
import type { AuthorizedAgentData, DelegationScope } from './types.js';

/**
 * Re-exported so this module is SELF-SUFFICIENT through the narrow `@interego/core/delegate`
 * subpath. A browser bundle must not have to import the core barrel — which reaches SPARQL, SHACL
 * and `node:crypto` — just to name the scope of a delegation. Type-only, so it costs nothing.
 */
export type { DelegationScope, AuthorizedAgentData, IRI } from './types.js';

// ── Scope ────────────────────────────────────────────────────

/**
 * The four scopes the relay actually stores, as a runtime value.
 *
 * `./types.js` declares {@link DelegationScope} as a compile-time union; a form that offers the
 * choices needs them at runtime too, and deriving one from the other keeps a new scope from
 * being addable to only one of them. `Read` is deliberately absent — the relay's own tool schema
 * advertises it, and it silently stores `DiscoverOnly`, so offering it would be offering a scope
 * that is not the one you get.
 */
export const DELEGATION_SCOPES: readonly DelegationScope[] =
  ['ReadWrite', 'ReadOnly', 'PublishOnly', 'DiscoverOnly'];

/** The scopes the relay's publish gate accepts. `runScopeGate` tests exactly this. */
export const WRITE_ELIGIBLE_SCOPES: readonly DelegationScope[] = ['ReadWrite', 'PublishOnly'];

export const isDelegationScope = (s: unknown): s is DelegationScope =>
  typeof s === 'string' && (DELEGATION_SCOPES as readonly string[]).includes(s);

/** Whether a scope may publish at all. Accepts the unparsed string a registry row carries. */
export const scopeWriteEligible = (scope: string | null | undefined): boolean =>
  (WRITE_ELIGIBLE_SCOPES as readonly string[]).includes(scope ?? '');

/**
 * Shape-only agent-id validation.
 *
 * An IRI scheme followed by anything that is not whitespace or a Turtle-breaking delimiter. It
 * refuses `<`, `>`, `"` and backtick because an id carrying one would be written verbatim into a
 * Turtle IRI and could close the angle bracket early — the same injection class as
 * `escapeTurtleLiteral` guards on the literal side. It deliberately does NOT check that the id
 * resolves: that is the relay's answer to give, and pre-empting it here would refuse ids from
 * identity hosts this build has never heard of.
 */
export const AGENT_ID_RX = /^[A-Za-z][A-Za-z0-9+.-]*:[^\s<>"'{}|\\^`]+$/;

// ── Naming ───────────────────────────────────────────────────

/**
 * The label prefix that marks a registry row as a delegate rather than some other agent.
 *
 * ★ SUBSTRATE-NEUTRAL ON PURPOSE. The vertical spelled this `workspace-delegate `, which meant
 * every delegate anybody ever authorised — a Foxxi delegate, a research delegate, one that never
 * touches a workspace — was stamped with the name of one vertical. The row is on the person's
 * pod and is world-readable; it should say what the agent IS, not which application happened to
 * seat it.
 */
export const DELEGATE_LABEL_PREFIX = 'delegate ';

/**
 * Longest delegate name.
 *
 * The label is written into the pod's registry Turtle and rendered beside every record the
 * delegate writes. The cap is about the second: a name that does not fit on a line stops being
 * a way to tell two delegates apart, which is the only thing it is for.
 */
export const DELEGATE_NAME_MAX = 48;

export const delegateLabel = (name: string): string => DELEGATE_LABEL_PREFIX + name;

/** The delegate's name out of a registry row's label, or null when the row is not a delegate. */
export function parseDelegateLabel(label: string | null | undefined): string | null {
  if (typeof label !== 'string') return null;
  if (label.indexOf(DELEGATE_LABEL_PREFIX) !== 0) return null;
  const name = label.slice(DELEGATE_LABEL_PREFIX.length).trim();
  return name.length ? name : null;
}

/**
 * Why a proposed delegate name is refused, or null.
 *
 * ★ A CONTROL CHARACTER IS REFUSED RATHER THAN STRIPPED. A stripped name is not the name you
 * chose, and the row that gets written would not be the row you were shown — which is the whole
 * point of showing a plan before publishing one. The check is written with `charCodeAt` rather
 * than a regex literal because typing a raw control character into a source file is how a NUL
 * byte got committed twice in one week.
 */
export function delegateNameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Give this delegate a name. It is how you and everybody reading the record tell it from your others.';
  if (n.length > DELEGATE_NAME_MAX) {
    return 'That name is ' + n.length + ' characters; the limit is ' + DELEGATE_NAME_MAX
      + '. It is rendered beside every record this delegate writes.';
  }
  for (let i = 0; i < n.length; i++) {
    const c = n.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) {
      return 'That name contains a control character at position ' + (i + 1)
        + '. It is refused rather than stripped, because a stripped name is not the name you chose.';
    }
  }
  const bare = DELEGATE_LABEL_PREFIX.trim();
  if (n.indexOf(bare) === 0) {
    return 'The name does not need to start with "' + bare + '" — that is the prefix this client already adds.';
  }
  return null;
}

/**
 * The agent id a delegate key resolves to, computed rather than waited for.
 *
 * The pod segment is a function of the key and {@link DELEGATE_SURFACE} is fixed, so a host that
 * holds a key can say which row on the pod is about it — and can show a person the id they are
 * being asked to authorise before anything signs in.
 */
export const delegateAgentId = (identityHost: string, podName: string): string =>
  'did:web:' + identityHost + ':agents:' + DELEGATE_SURFACE + '-' + podName;

/**
 * The OAuth `client_name` under which a delegate's key signs in, on every host, in every vertical.
 *
 * See the file header: the relay puts this string inside the agent DID. It is deliberately not
 * the name of any application — an app is where a delegate is running, not who it is.
 */
export const DELEGATE_SURFACE = 'interego-delegate';

// ── The registry row ─────────────────────────────────────────

/**
 * One agent a pod delegates: the substrate's own registry row, widened with what a reader
 * DERIVES from it and nothing else.
 *
 * ★ IT IS `AuthorizedAgentData`, NOT A COPY OF IT. Everything here except `name` and
 * `writeEligible` is a field `model/delegation.ts` already defines, `verifyDelegation` already
 * consumes and `agent-collective`'s request gate already checks. The two added fields are
 * functions of the row — `name` is a parse of `label`, `writeEligible` is a test on `scope` —
 * so nothing can disagree with the row it came from.
 */
export type DelegateRow = AuthorizedAgentData & {
  /** The name its delegator gave it, parsed from `label`; null when the row is not a delegate. */
  readonly name: string | null;
  /** Whether the relay would let it publish at all, from `scope` alone. */
  readonly writeEligible: boolean;
};

/** True when this row's label marks it as a delegate rather than some other agent. */
export const isDelegateRow = (r: DelegateRow): boolean => r.name !== null;

/**
 * Every agent a pod delegates, split into delegates and the rest.
 *
 * ★ `read: false` IS NOT AN EMPTY ROSTER. A registry that could not be read says nothing about
 * how many delegates somebody has, and a UI that drew "no delegates" from a failed read would be
 * making a statement about their pod from a call that did not happen.
 */
export interface DelegateRoster {
  readonly podName: string;
  readonly read: boolean;
  /** The pod owner the rows are delegations FROM, when the read established it. */
  readonly owner: IRI | null;
  readonly rows: readonly DelegateRow[];
  readonly delegates: readonly DelegateRow[];
  /** Rows that are agents but not delegates — a Discord conduit, another client's session. */
  readonly others: readonly DelegateRow[];
  readonly why: string | null;
}

/**
 * A relay refusal body, or null.
 *
 * The relay signals a refusal as a RESOLVED JSON body carrying `error` — 412 precondition_failed,
 * 422 shape_violation, 403 scope_violation — not as a rejection. Reading a resolved refusal as a
 * success is how a write that never landed gets reported as one.
 */
export function relayRefusal(p: unknown): (Record<string, unknown> & { error: unknown }) | null {
  if (p && typeof p === 'object' && 'error' in p && (p as Record<string, unknown>)['error']) {
    return p as Record<string, unknown> & { error: unknown };
  }
  return null;
}

/**
 * What the delegate affordance needs from a caller, and nothing more.
 *
 * ★ A PORT RATHER THAN A CLIENT. This module must be usable from the relay, a Node CLI, an
 * Electron main process and a browser artifact, which have four different transports and one of
 * which cannot import `node:` anything. Injection is also exactly how the rest of
 * `model/delegation.ts` already works — `fetchProfile`, `fetchCredential` and `verifier` are all
 * ports — so this stays consistent with the module it extends rather than introducing a second
 * style beside it.
 */
export interface DelegateRegistryPort {
  /**
   * Call a relay tool. MUST reject on transport failure and MAY resolve a refusal envelope;
   * both are handled. `opts.cache` is honoured when the transport has a cache.
   */
  readonly tool: (
    name: string,
    args: Record<string, unknown>,
    opts?: { readonly cache?: false | { readonly staleTime: number } },
  ) => Promise<unknown>;
  /**
   * Render a thrown transport error as a short lowercase phrase for a `why` sentence. Optional:
   * without it the error's own message is used, which is serviceable but rarely good copy.
   */
  readonly describeError?: (e: unknown) => string;
}

const describe = (port: DelegateRegistryPort, e: unknown): string =>
  port.describeError ? port.describeError(e) : String((e as { message?: unknown })?.message ?? e);

const rowOf = (r: Record<string, unknown>, owner: IRI | null): DelegateRow => {
  const label = typeof r['label'] === 'string' ? r['label'] : undefined;
  const scope = typeof r['scope'] === 'string' ? r['scope'] : '';
  return {
    agentId: String(r['agentId'] ?? '') as IRI,
    // The relay's `ownerProfileToTurtle` writes `iep:delegatedBy <pod owner>` for every row and
    // discards the agent's own value, so the registry's answer to "delegated by whom" IS the pod
    // owner. Carrying the owner here rather than leaving it empty keeps `DelegateRow` a real
    // `AuthorizedAgentData` instead of one with a required field faked.
    delegatedBy: (typeof r['delegatedBy'] === 'string' ? r['delegatedBy'] : owner ?? '') as IRI,
    ...(label === undefined ? {} : { label }),
    scope: scope as DelegationScope,
    validFrom: typeof r['validFrom'] === 'string' ? r['validFrom'] : '',
    ...(typeof r['validUntil'] === 'string' ? { validUntil: r['validUntil'] } : {}),
    ...(r['revoked'] === true ? { revoked: true } : {}),
    name: parseDelegateLabel(label ?? null),
    writeEligible: scopeWriteEligible(scope),
  };
};

/**
 * Read a pod's delegates from the pod itself.
 *
 * ★ THE POD IS THE ROSTER, AND AN APP'S KEYCHAIN IS NOT. `register_agent` is own-pod gated at the
 * relay, so these rows are a document only the pod owner can write — which makes them the
 * authority on who that person has authorised. An app that listed the delegates it happened to
 * hold keys for would be answering a different question ("which of these can I drive from here")
 * and drawing it as if it were this one.
 *
 * `cache: false`, like every other authorization read: a delegation revoked ninety seconds ago
 * must not still be listed.
 */
export async function readDelegates(
  port: DelegateRegistryPort,
  podName: string,
): Promise<DelegateRoster> {
  const none = (why: string): DelegateRoster =>
    ({ podName, read: false, owner: null, rows: [], delegates: [], others: [], why });
  let status: Record<string, unknown> | null;
  try {
    status = await port.tool('get_pod_status', { pod_name: podName }, { cache: false }) as Record<string, unknown> | null;
  } catch (e) {
    return none('pod ' + podName + '\'s delegation registry could not be read (' + describe(port, e).toLowerCase()
      + '), so how many delegates it lists is not established');
  }
  const bad = relayRefusal(status);
  if (bad) return none('the read of pod ' + podName + ' was refused: ' + String(bad['message'] ?? bad['error']));
  const reg = status?.['delegationRegistry'] as
    { rows?: readonly Record<string, unknown>[]; owner?: unknown } | null | undefined;
  if (!reg) {
    return none('pod ' + podName + ' reports no delegation registry at all, which is different from it delegating nothing');
  }
  const owner = (typeof reg.owner === 'string' ? reg.owner : null) as IRI | null;
  const rows = (Array.isArray(reg.rows) ? reg.rows : [])
    .map((r) => rowOf(r, owner))
    .filter((r) => r.agentId !== '');
  return {
    podName, read: true, owner, rows,
    delegates: rows.filter(isDelegateRow),
    others: rows.filter((r) => !isDelegateRow(r)),
    why: null,
  };
}

// ── Seating and withdrawing one ──────────────────────────────

/** The three fields a delegation itself has. A vertical's form may have more — see below. */
export type DelegateField = 'agentId' | 'name' | 'scope';

/** A pre-call refusal, keyed to the field a form would highlight. */
export interface DelegateProblem<F extends string = DelegateField> {
  readonly field: F;
  readonly why: string;
}

/**
 * The exact call, plus the honest limits, as a value — before anything is written.
 *
 * ★ THE PLAN IS THE CONSENT SURFACE. A host renders `limits` verbatim at the moment somebody is
 * asked to authorise a delegate; they are measured facts about what the delegation actually
 * permits, not reassurance, and two of them say the grant is wider than the caller probably
 * wants. Putting them in a document nobody opens instead would defeat showing a plan at all.
 */
export interface DelegatePlan<F extends string = DelegateField> {
  readonly problems: readonly DelegateProblem<F>[];
  readonly call: { readonly tool: 'register_agent'; readonly args: Readonly<Record<string, unknown>> } | null;
  readonly limits: readonly string[];
}

/**
 * The `register_agent` call that seats a delegate, described before it is made.
 *
 * ★ THE SCOPE IS THE DELEGATOR'S CHOICE AND IS NOT DEFAULTED TO THE WIDEST. `ReadWrite` would
 * let this delegate do everything the person can, which is precisely what a delegate is not for.
 * `PublishOnly` is the narrowest scope that can still write.
 *
 * `pod_name` is deliberately NOT sent: `register_agent` is own-pod gated at the relay, and naming
 * a pod in the args would be asking for a refusal on the only pod the call can legitimately
 * target.
 */
export function delegatePlan(args: {
  readonly agentId: string;
  readonly name: string;
  readonly scope?: DelegationScope;
}): DelegatePlan {
  const problems: DelegateProblem[] = [];
  const agentId = args.agentId.trim();
  const name = args.name.trim();
  if (!agentId) {
    problems.push({ field: 'agentId', why: 'This delegate has no agent id yet. Mint or import a delegate key first — the id is derived from that key and cannot be typed in.' });
  } else if (!AGENT_ID_RX.test(agentId)) {
    problems.push({ field: 'agentId', why: 'That is not the shape of an agent id. A delegate\'s looks like `did:web:…:agents:' + DELEGATE_SURFACE + '-u-eth-…`.' });
  }
  // A `name` field of its own, which the vertical could not have: its problem union named a
  // Discord user id as one of three fields, so a bad NAME had to be reported against `agentId`
  // and a form highlighted the wrong input. The substrate owns the three fields a delegation
  // actually has.
  const nameProblem = delegateNameProblem(name);
  if (nameProblem) problems.push({ field: 'name', why: nameProblem });
  const scope: DelegationScope = args.scope ?? 'PublishOnly';
  const label = delegateLabel(name);
  return {
    problems,
    call: problems.length ? null : { tool: 'register_agent', args: { agent_id: agentId, scope, label } },
    limits: [
      'This publishes one row on YOUR pod naming one agent. It is a delegate acting for you — not you, and not any of your other delegates.',
      'Records it writes land on your pod and in your log, and they name IT as the author. A reader can tell them apart from something you wrote, and so can you.',
      // ★ SAID AT THE MOMENT OF CONSENT, because this is the thing a person is most likely to
      // assume the other way round. Authorising a delegate is not agreeing in advance to
      // everything it will say: what it says on your behalf and what it says on its own account
      // are different records, and the second kind is the reason to have one at all.
      'This delegation is STANDING and it is not an endorsement of anything it will say. Each entry separately declares whether the delegate was speaking FOR you — those you share responsibility for — or on its OWN account, where it alone is answerable. It decides that per entry, you can see which before it sends, and every reader can see it afterwards.',
      scope === 'PublishOnly'
        ? 'PublishOnly is POD-WIDE. The substrate has no per-graph delegation scope, so this delegate could publish any graph to your pod, not only the records you had in mind. What bounds it is that it is one named agent, every write is attributed to it, and you can withdraw it alone.'
        : 'Scope ' + scope + ' is POD-WIDE and wider than PublishOnly. Whatever it permits, this delegate may do on your whole pod.',
      'The label "' + label + '" is public, and is meant to be. Delegation rows are world-readable; the name is how you and everybody reading tell this delegate from your others. There is nothing in it to steal.',
      'Revoking it is your unilateral act from your own client, and it does not need the delegate to cooperate or even to be running.',
      'For up to 60 seconds after a revoke the relay may still accept a write it had already cached permission for. A client that re-asks before every write stops itself, but the relay alone is not the boundary.',
    ],
  };
}

/** What actually happened, established by reading the pod back rather than by the relay's ack. */
export interface DelegateOutcome<F extends string = string> {
  readonly kind: 'invalid' | 'refused' | 'unconfirmed' | 'published';
  readonly plan: DelegatePlan<F>;
  readonly response: Record<string, unknown> | null;
  /** The read-back. Null only when the write was refused, so there was nothing to confirm. */
  readonly roster: DelegateRoster | null;
  /** The row the read-back found, when it found one. */
  readonly listed: DelegateRow | null;
  /**
   * True when the relay reported it CHANGED an existing agent's scope rather than adding one.
   *
   * Surfaced because it is a silent widening or narrowing of authority the caller did not ask
   * about: re-registering an agent already held at `ReadWrite` narrows it to `PublishOnly`.
   */
  readonly rescopedFrom: string | null;
  readonly why: string;
}

/**
 * Run a {@link DelegatePlan}, then confirm it by reading the pod back.
 *
 * ★ `published` REQUIRES THE READ-BACK, NOT THE WRITE. A relay acknowledgement says the call was
 * accepted, not that the row is in the registry the write-scope gate consults — and those came
 * apart in practice. When the write appears to have succeeded but the row is not listed the
 * outcome is `unconfirmed`, which is deliberately not `refused`: the write may well have landed,
 * and telling somebody their delegation failed when it exists is its own defect.
 */
export async function publishDelegation<F extends string>(
  port: DelegateRegistryPort,
  args: {
    readonly plan: DelegatePlan<F>;
    /** The caller's own pod, for the read-back. */
    readonly verifyOnPod: string;
  },
): Promise<DelegateOutcome<F>> {
  const { plan } = args;
  const out = (
    kind: DelegateOutcome<F>['kind'],
    why: string,
    rest: Partial<DelegateOutcome<F>> = {},
  ): DelegateOutcome<F> =>
    ({ kind, plan, response: null, roster: null, listed: null, rescopedFrom: null, why, ...rest });

  if (!plan.call) {
    return out('invalid', plan.problems.map((p) => p.why).join(' ')
      || 'This delegation was not described completely enough to publish.');
  }
  let response: Record<string, unknown> | null;
  try {
    response = await port.tool(plan.call.tool, { ...plan.call.args }, { cache: false }) as Record<string, unknown> | null;
  } catch (e) {
    return out('refused', 'The relay refused to register the agent: ' + describe(port, e) + ' Nothing was written.');
  }
  const bad = relayRefusal(response);
  if (bad) {
    return out('refused', 'The relay refused to register the agent: ' + String(bad['message'] ?? bad['error'])
      + ' Nothing was written.', { response });
  }
  const rescopedFrom = response?.['rescoped'] === true && typeof response['previousScope'] === 'string'
    ? response['previousScope'] as string : null;

  // ── the read-back, which is the part that establishes anything ─────────────
  const roster = await readDelegates(port, args.verifyOnPod);
  const agentId = String(plan.call.args['agent_id']);
  const listed = roster.read ? roster.rows.find((r) => r.agentId === agentId) ?? null : null;
  if (!listed) {
    return out('unconfirmed', roster.read
      // Not "it failed": the write may well have landed. What is established is that reading the
      // pod back did not show it, and saying more than that would be inventing a fact either way.
      ? 'The relay accepted the registration, but reading pod ' + args.verifyOnPod + ' back did not list '
        + agentId + '. The row may still be there — what is established is that this read did not find it.'
      : 'The relay accepted the registration, but the pod could not be read back to confirm it: '
        + (roster.why ?? 'no reason was given'),
      { response, roster, rescopedFrom });
  }
  // The label carries the CLAIM in flows that use one (a conduit link naming which external
  // account the delegation is for). A row that exists under a DIFFERENT label is not the row that
  // was planned, and reporting it as published would confirm a binding nobody wrote.
  const wanted = typeof plan.call.args['label'] === 'string' ? plan.call.args['label'] as string : null;
  if (wanted !== null && listed.label !== wanted) {
    return out('unconfirmed',
      'The relay accepted the registration, but pod ' + args.verifyOnPod + ' lists ' + agentId
      + ' under the label "' + (listed.label ?? '') + '", not "' + wanted + '". The row that was planned is not the row that is there.',
      { response, roster, listed, rescopedFrom });
  }
  return out('published',
    'Published on pod ' + args.verifyOnPod + ' and read back from it: the delegation registry now lists '
    + agentId + ' with scope ' + listed.scope + (rescopedFrom ? ', re-scoped from ' + rescopedFrom : '') + '.',
    { response, roster, listed, rescopedFrom });
}

/**
 * Withdraw a delegation, confirmed by the read-back FAILING to find it.
 *
 * ★ THE CHECK IS INVERTED ON PURPOSE. Success here is the row being absent, so the confirmation
 * that a revoke worked is the same read that would confirm a grant, read the other way. A revoke
 * reported from the relay's acknowledgement alone would be the one call in the set where "it
 * said yes" and "it is gone" are least safe to conflate.
 */
export async function revokeDelegation(
  port: DelegateRegistryPort,
  args: { readonly agentId: string; readonly podName: string },
): Promise<{ readonly kind: 'refused' | 'still-listed' | 'revoked'; readonly why: string; readonly roster: DelegateRoster | null }> {
  let response: Record<string, unknown> | null;
  try {
    response = await port.tool('revoke_agent', { agent_id: args.agentId }, { cache: false }) as Record<string, unknown> | null;
  } catch (e) {
    return { kind: 'refused', why: 'The revoke was refused (' + describe(port, e) + '). The delegation still stands.', roster: null };
  }
  const bad = relayRefusal(response);
  if (bad) {
    return { kind: 'refused', why: 'The revoke was refused: ' + String(bad['message'] ?? bad['error']), roster: null };
  }
  const roster = await readDelegates(port, args.podName);
  if (!roster.read) {
    return { kind: 'still-listed', why: 'The relay accepted the revoke, but the pod could not be read back to confirm it: ' + (roster.why ?? ''), roster };
  }
  if (roster.rows.some((r) => r.agentId === args.agentId)) {
    return { kind: 'still-listed', why: 'The relay accepted the revoke, but pod ' + args.podName + ' still lists ' + args.agentId + '.', roster };
  }
  return {
    kind: 'revoked', roster,
    // Measured: a caller who sees one more write land after revoking needs to know that is the
    // relay's 60s permission cache, not a revoke that did not take.
    why: 'Revoked, and read back from pod ' + args.podName + ': the registry no longer lists ' + args.agentId
      + '. The relay may still accept a write it had already cached permission for, for up to 60 seconds.',
  };
}

// ── Asking whether a delegation stands, right now ────────────

/**
 * One line of evidence behind a verdict.
 *
 * `y` / `n` are findings. `q` is "this was not established" — and it is a THIRD value on
 * purpose: a check that could not run is not a check that failed, and collapsing the two is how
 * absence gets rendered as a negative fact.
 *
 * ★ IT IS DEFINED HERE BECAUSE THE VERDICTS ARE. `checkDelegation` below is the substrate's, and a
 * vertical that declared its own `Check` to hold the substrate's findings would be the same
 * two-spellings-of-one-thing that `DelegateRow` already had to be rescued from.
 * `@interego/workspace-client` re-exports this one.
 */
export interface Check {
  readonly mark: 'y' | 'n' | 'q';
  readonly text: string;
  /** Detail a shell may show on hover — typically an address a reader cannot fetch. */
  readonly detail?: string;
}

/** What asking "may this agent write to that pod, and did that pod's owner say so" established. */
export interface DelegationVerdict {
  readonly agentId: string;
  readonly podName: string;
  readonly checks: readonly Check[];
  /** True only when EVERY check that ran is a finding in favour. A `q` never makes this true. */
  readonly ok: boolean;
  readonly why: string | null;
  /**
   * The row the pod's own registry carries for this agent, when it carries one.
   *
   * ★ A FULL {@link DelegateRow}, NOT A FOUR-FIELD COPY OF ONE. This carried its own `DelegationRow`
   * — `agentId`, `scope`, `label`, `validFrom` and nothing else — which is the same lossy
   * re-spelling of `AuthorizedAgentData` the vertical's `Delegate` type had to be rescued from: it
   * could not represent a revocation, and a caller holding one could not ask whether the row was
   * write-eligible without re-deriving it.
   */
  readonly row: DelegateRow | null;
  readonly scope: string | null;
  /** `signed-chain`, `registry-only`, `none` — the relay's word for what it is relying on. */
  readonly basis: string | null;
  /** Which pod `verify_agent` says it examined. Null when it did not say. */
  readonly examinedPod: string | null;
}

/**
 * Does `agentId` have write authority on `podName`, and does that pod's owner say the
 * delegation is for a particular party?
 *
 * ★ WHY THIS IS AT THE SUBSTRATE. Every sentence below is a statement about the relay's own
 * documents — a pod's delegation registry, and what `verify_agent` reports it will enforce. Nothing
 * in it is about workspaces, and it sat in a vertical's client package entangled with `readMember`,
 * a reader of a workspace `Viewer`. The Discord conduit, the desktop shell, Foxxi and any later
 * vertical all have to ask this same question before writing to somebody else's pod, and a second
 * copy of an authorization decision is the one thing this codebase can least afford.
 *
 * TWO QUESTIONS, AND THE SECOND ONE IS WHY THIS EXISTS. `verify_agent` answers the first
 * completely and answers the second not at all. A delegate that only asked the first would
 * accept ANY claimant's word for which pod is theirs: the moment one person delegates the
 * delegate, every other person can name that pod and have their words written onto it.
 *
 * `expectLabel` closes that. `register_agent` is own-pod gated, so a row's `label` is a string
 * only that pod's owner can have written — it is the owner naming, in their own document, who
 * this delegation is for. A delegate holds the claimant to it.
 *
 * ★ AND THE LABEL MUST NOT BE A SECRET, WHICH IS THE OPPOSITE OF THE OBVIOUS DESIGN. MEASURED:
 * `get_pod_status { pod_name: <anyone's> }` answers for any pod and returns the registry rows
 * WITH their labels. So a challenge-response scheme where the delegate mints a nonce and asks
 * the claimant to publish it is a scheme that publishes the nonce: the first party to read that
 * pod can present the same nonce and be believed. The label has to be a value that identifies
 * the intended party and is worthless to anybody else — the caller's own account identifier on
 * whatever platform it is bridging — and the caller must derive `expectLabel` from the identity
 * of the party actually asking, never from something they were told. Compared with `===` for
 * that reason: there is no secret here, so there is nothing for a constant-time compare to
 * protect, and a helper that implied otherwise would be documenting a property this does not have.
 *
 * Omit `expectLabel` to ask only the authority question — which is the right question at WRITE
 * time, when the binding was already established and what has changed since is whether the
 * delegation still stands.
 *
 * ★ `podOfUrl` IS REQUIRED AND IS THE CALLER'S, for the same reason `footingTurtle` borrows an IRI
 * guard: the substrate has no opinion about how a deployment lays out pod URLs, and a default
 * "last path segment" rule invented here would be a second, quieter answer to a question the
 * caller already answers elsewhere. Making it required is what stops the echo check from being
 * skipped by omission.
 */
export async function checkDelegation(
  port: DelegateRegistryPort,
  args: {
    readonly agentId: string;
    readonly podName: string;
    /** The exact `label` the row must carry, when a binding is being established. */
    readonly expectLabel?: string;
    /** The pod name a pod URL belongs to, or null when the caller cannot name one. */
    readonly podOfUrl: (u: unknown) => string | null;
  },
): Promise<DelegationVerdict> {
  const checks: Check[] = [];
  const no = (why: string, extra?: Partial<DelegationVerdict>): DelegationVerdict => {
    checks.push({ mark: 'n', text: why });
    return { agentId: args.agentId, podName: args.podName, checks, ok: false, why, row: null, scope: null, basis: null, examinedPod: null, ...extra };
  };

  // ── 1. the pod's OWN registry, which only its owner can write ──────────────
  let status: Record<string, unknown> | null;
  try { status = await port.tool('get_pod_status', { pod_name: args.podName }, { cache: false }) as Record<string, unknown> | null; }
  catch (e) { return no('the delegation registry on ' + args.podName + ' could not be read (' + describe(port, e).toLowerCase() + '), so whether it names this agent is not established'); }
  const bad = relayRefusal(status);
  if (bad) return no('the read of ' + args.podName + ' was refused: ' + String(bad['message'] ?? bad['error']));
  const served = args.podOfUrl(status?.['pod']);
  if (served && served !== args.podName) {
    return no('get_pod_status was asked about pod ' + args.podName + ' and answered for pod ' + served
      + '. These disagree, so no delegation is being read out of it.');
  }
  const reg = status?.['delegationRegistry'] as { rows?: readonly Record<string, unknown>[]; owner?: unknown } | null | undefined;
  if (!reg) {
    return no('pod ' + args.podName + ' reports no delegation registry at all, so whether it delegates anything to this agent '
      + 'is not established — that is different from it delegating nothing');
  }
  const raw = Array.isArray(reg.rows) ? reg.rows : [];
  const hit = raw.find((r) => r && r['agentId'] === args.agentId);
  if (!hit) {
    return no('pod ' + args.podName + '\'s own delegation registry lists ' + raw.length + ' live agent'
      + (raw.length === 1 ? '' : 's') + ' and this one is not among them. Nothing was written.');
  }
  // Built by the SAME function that builds a roster row, so a caller cannot get one shape here and
  // a different one from `readDelegates` for the same registry line.
  const row = rowOf(hit, (typeof reg.owner === 'string' ? reg.owner : null) as IRI | null);
  checks.push({ mark: 'y', text: 'Pod ' + args.podName + '\'s own delegation registry — a document only its owner can write — lists this agent with scope ' + (row.scope || 'none reported') });

  // ── 2. the claim the row carries, when one is being asked for ──────────────
  if (args.expectLabel !== undefined) {
    if (row.label === undefined) {
      return no('that row carries no label, so this pod\'s owner has not said who the delegation is for. '
        + 'A row with no label is not evidence against the claimant — it is no evidence either way, and a binding is not made on no evidence.', { row, scope: row.scope });
    }
    if (row.label !== args.expectLabel) {
      return no('that row\'s label is "' + row.label + '", and the delegation would have to be labelled "' + args.expectLabel
        + '" to be a delegation for the party asking. It must be that exactly, with nothing before or after it.', { row, scope: row.scope });
    }
    checks.push({ mark: 'y', text: 'Its label is "' + args.expectLabel + '" — this pod\'s owner naming, in a document only they can write, who the delegation is for' });
  }

  // ── 3. what the relay will actually DO, which is not the same question ─────
  let v: Record<string, unknown> | null;
  try { v = await port.tool('verify_agent', { agent_id: args.agentId, pod_name: args.podName }, { cache: false }) as Record<string, unknown> | null; }
  catch (e) { return no('verify_agent did not answer (' + describe(port, e).toLowerCase() + '), so what the relay would enforce here is not established', { row, scope: row.scope }); }
  const vbad = relayRefusal(v);
  if (vbad) return no('verify_agent was refused: ' + String(vbad['message'] ?? vbad['error']), { row, scope: row.scope });
  const examinedPod = typeof v?.['subject_pod_name'] === 'string' ? v['subject_pod_name'] as string : null;
  // ★ THE ECHO, AND THE DEFECT IT CLOSES IS IN THE RELAY'S OWN HISTORY. `verify_agent` once
  // answered about the CALLER's pod when asked by `pod_name`, and the wrong answer was shaped
  // exactly like the right one. The field exists so that is checkable; not checking it would
  // leave the fix unused.
  if (examinedPod !== null && examinedPod !== args.podName) {
    return no('verify_agent was asked about pod ' + args.podName + ' and its answer says it examined pod ' + examinedPod
      + '. These disagree, so it is not being read as a verdict about either.', { row, scope: row.scope, examinedPod });
  }
  const enf = v?.['enforcement'] as Record<string, unknown> | undefined;
  if (!enf) {
    return no('verify_agent answered without an enforcement block, so what the relay grants this agent on ' + args.podName
      + ' is not established here', { row, scope: row.scope, examinedPod });
  }
  const basis = typeof enf['basis'] === 'string' ? enf['basis'] : null;
  const scope = typeof enf['scope'] === 'string' ? enf['scope'] : (row.scope || null);
  if (enf['writeEligible'] !== true) {
    return no('the relay reports this agent is not write-eligible on ' + args.podName + ' (basis ' + (basis ?? 'not reported')
      + ', scope ' + (scope ?? 'not reported') + '). ' + String(enf['note'] ?? '')
      + ' A write would be refused, so it is not attempted.', { row, scope, basis, examinedPod });
  }
  checks.push({ mark: 'y', text: 'The relay reports this agent write-eligible on ' + args.podName + ' with scope ' + (scope ?? 'not reported') + ', on basis "' + (basis ?? 'not reported') + '"' });
  // Reported rather than folded into the verdict: it is what the relay is relying on, and
  // "the pod owner wrote the row but the signed chain does not anchor" is a real state a reader
  // should see rather than have decided for them.
  if (basis === 'registry-only') {
    checks.push({ mark: 'q', text: 'The signed delegation credential did not anchor; the relay is enforcing this from the pod\'s own registry alone. That registry is still a document only the pod owner can write, so it is authorisation — it is just not a cryptographic chain.' });
  }
  return { agentId: args.agentId, podName: args.podName, checks, ok: true, why: null, row, scope, basis, examinedPod };
}

// ── What the relay's signature on a descriptor actually proves ───────────────

/**
 * WHAT THE SIGNATURE ON ONE OF THESE DESCRIPTORS PROVES, AND WHAT IT DOES NOT.
 *
 * ★ THIS IS NOT COMMENTARY. Every client that renders an authorship block is tempted to print
 * "signed by <name>" — which readers take to mean that person's own key. MEASURED on the live
 * relay, on a delegated write and on an own-pod write alike: `verificationMethod` is
 * `did:ethr:0xd144353a…3331`, ONE key, the relay's own delegation signer, identical for every pod
 * and every agent on this deployment. `issuer` is the agent the relay authenticated. So the proof
 * is the RELAY's attestation about who asked, not the author's attestation about what they wrote —
 * and the difference matters most in exactly the case that makes it easiest to miss, where the
 * agent that asked is not the person whose pod it landed on.
 *
 * ★ AT THE SUBSTRATE FOR THE SAME REASON AS EVERYTHING ABOVE: the block being read is the RELAY's,
 * so what it proves is one answer, not one per vertical.
 */
export interface AuthorshipReading {
  /** Did a proof arrive at all? Absence is reported as absence, never as an unsigned verdict. */
  readonly present: boolean;
  /** The agent the relay authenticated when it signed. Null when none was reported. */
  readonly signerAgent: string | null;
  /** The key the signature verifies against. On this relay: the relay's own. */
  readonly verificationMethod: string | null;
  /** `bound-at-signing` | `unbound` | whatever the relay reported. */
  readonly contentBinding: string | null;
  readonly proves: readonly string[];
  readonly doesNotProve: readonly string[];
}

export function readAuthorship(a: unknown): AuthorshipReading {
  if (!a || typeof a !== 'object') {
    return {
      present: false, signerAgent: null, verificationMethod: null, contentBinding: null,
      proves: [],
      doesNotProve: ['No authorship block came back with this descriptor, so nothing is established about who wrote it. That is not the same as it being unsigned.'],
    };
  }
  const p = a as Record<string, unknown>;
  const signer = typeof p['signer'] === 'string' ? p['signer'] as string
    : typeof p['signedBy'] === 'string' ? p['signedBy'] as string : null;
  const vm = typeof p['verificationMethod'] === 'string' ? p['verificationMethod'] as string : null;
  const binding = typeof p['contentBinding'] === 'string' ? p['contentBinding'] as string : null;
  const signed = p['signed'] === true || p['authorshipVerified'] === true;
  const proves: string[] = [];
  const doesNot: string[] = [];
  if (signed) {
    proves.push(signer
      ? 'The relay signed a statement that the caller it had authenticated as ' + signer + ' published this descriptor.'
      : 'The relay signed a statement about this descriptor, and the response named no agent in it.');
    if (binding === 'bound-at-signing') {
      proves.push('The signed payload commits to a digest of the entry\'s canonical triples, so the text cannot be changed afterwards without the proof failing.');
    } else if (binding === 'unbound') {
      doesNot.push('The proof carries no content digest, so it covers WHICH descriptor was written and not WHAT it says. The text could be replaced and the proof would still verify.');
    } else if (binding !== null) {
      doesNot.push('The content binding is reported as "' + binding + '", which is neither a check that passed nor one that failed — nothing was verified about the text here.');
    }
  } else {
    doesNot.push('The block reports no successful signature, so who asked for this write is not established by it.');
  }
  doesNot.push(vm
    ? 'The signature verifies against ' + vm + ' — the relay\'s own delegation key, the same one for every pod and every agent on this deployment. It is NOT the author\'s wallet, and it is not evidence that any human key signed anything.'
    : 'The block names no verification method, so what key this would verify against is not established.');
  doesNot.push('It says nothing about whether the pod owner authorised the agent named above. That is a separate document — the pod\'s own delegation registry — and it is what checkDelegation reads.');
  return { present: true, signerAgent: signer, verificationMethod: vm, contentBinding: binding, proves, doesNotProve: doesNot };
}

// ── The scope ceiling ────────────────────────────────────────

/** A ceiling verdict, with the sentence a surface shows when it refuses. */
export interface CeilingVerdict {
  readonly ok: boolean;
  readonly why: string;
}

/**
 * May this delegate write on its delegator's pod at all, from the delegation alone?
 *
 * ★ THE SUBSTRATE HALF OF A CEILING, AND ONLY THAT HALF. This is what the delegator controls PER
 * DELEGATE: a delegate given `ReadOnly` cannot write even though its delegator can, and its
 * sibling given `PublishOnly` still can. A vertical that also has its own ceiling — a workspace
 * role, a tenant capability, a cohort — applies this one AND its own, sequentially, and must not
 * pretend to intersect two capability vocabularies that were never mapped onto each other.
 *
 * ★ ABSENCE IS NOT EVIDENCE. A row whose scope the reader could not see is not a row that grants
 * nothing AND not a row that grants everything — it is a question, and a question is not
 * permission.
 */
export function scopeCeiling(args: {
  readonly scope: string | null;
  readonly delegateName: string | null;
}): CeilingVerdict {
  const who = args.delegateName ? '"' + args.delegateName + '"' : 'this delegate';
  if (args.scope === null) {
    return {
      ok: false,
      why: 'Your pod\'s registry row for ' + who + ' reports no scope, so what you delegated to it is not established. '
        + 'That is not the same as it being permitted, so nothing is written.',
    };
  }
  if (!scopeWriteEligible(args.scope)) {
    return {
      ok: false,
      why: 'You delegated ' + who + ' with scope ' + args.scope + ', which cannot publish. The relay would refuse the '
        + 'write, and this refuses it first. Widen the delegation on your own pod if you meant it to be able to write.',
    };
  }
  return {
    ok: true,
    why: 'You delegated ' + who + ' scope ' + args.scope + ', which may publish.',
  };
}

// ── Footing: standing delegation is not the same fact as this particular act ──

/**
 * WHAT ONE UTTERANCE WAS MADE ON, which is NOT the same question as whether its author is a
 * delegate.
 *
 * ★ TWO FACTS THAT WERE ONE, AND THE CONFLATION LAUNDERED AN AGENT'S OPINIONS INTO ITS HUMAN'S.
 *
 *   · STANDING, and a fact about the AGENT. An agent is always the delegate of a specific human,
 *     by a row on that human's own pod, revocable by them alone. That row is the authority on it
 *     ({@link readDelegates}); it does not change from one sentence to the next and no record has
 *     to restate it.
 *   · PER-ACT, and a fact about THIS UTTERANCE. Sometimes a delegate speaks FOR its human —
 *     representing them, with the human sharing responsibility for what was said. Sometimes it
 *     participates as a peer, reasoning and taking a position of its own, and THE AGENT ALONE IS
 *     ACCOUNTABLE. Every delegate-authored record used to get `<agent> prov:actedOnBehalfOf
 *     <human>` unconditionally, which said the first of those about both — so nobody could ever
 *     say "the agent said that, not me."
 *
 * ★ PROV-O ALREADY DRAWS THIS LINE AND THE SHAPE BELOW IS ITS OWN, NOT OURS. Quoting the
 * ontology:
 *
 *     prov:Delegation — "Delegation is the assignment of authority and responsibility to an agent
 *     (by itself or by another agent) to carry out A SPECIFIC ACTIVITY as a delegate or
 *     representative, WHILE THE AGENT IT ACTS ON BEHALF OF RETAINS SOME RESPONSIBILITY FOR THE
 *     OUTCOME of the delegated work."
 *
 * That is precisely the for-the-human footing, and PROV scopes it to one activity: `prov:Delegation`
 * carries `prov:hadActivity` (whose domain is the union `Delegation, Derivation, End, Start`), and
 * `prov:qualifiedDelegation` is reached from the agent. PROV even states the entailment itself —
 * `prov:actedOnBehalfOf owl:propertyChainAxiom (prov:qualifiedDelegation prov:agent)` — so writing
 * the qualified form ADDS the standing relation rather than replacing it. Nothing is minted for
 * this side.
 *
 * ★ ONE TERM IS MINTED, FOR THE SIDE PROV HAS NO WORD FOR. There is no negative form of a
 * Delegation, and absence cannot serve as one: a reader that took "no Delegation" for
 * "on its own account" would be defaulting, and one that took it for "on the human's behalf" would
 * restore the defect. So `iep:actedOnOwnAccount` (declared in `docs/ns/iep.ttl`, domain
 * `prov:Agent`, range `prov:Activity` — the same subject position `prov:actedOnBehalfOf` takes)
 * states the other footing POSITIVELY, and absence stays a third answer.
 */
export type EntryFooting =
  /** A prov:Delegation covers this act: the delegate spoke for `principal`, who shares in it. */
  | { readonly kind: 'on-behalf-of'; readonly principal: string }
  /** `iep:actedOnOwnAccount` covers this act: the agent's own position, the agent's own account. */
  | { readonly kind: 'own-account' }
  /**
   * The record says neither, so this reader says neither.
   *
   * ★ NOT A DEFAULT IN FAVOUR OF ANYBODY. This is the whole reason the two statements are both
   * positive: an entry that does not declare its footing is a finding about the entry, and a
   * surface has to draw it as one rather than picking the reading that flatters somebody.
   */
  | { readonly kind: 'not-stated'; readonly why: string };

/** The two a WRITER may choose. `not-stated` is a reading outcome and never a thing to write. */
export type StatedFooting = Exclude<EntryFooting, { kind: 'not-stated' }>;

/**
 * The PROV statements {@link judgeAuthorship} reasons over, as plain IRI lists.
 *
 * ★ EVERY FIELD IS A LIST BECAUSE THE COUNT IS PART OF THE ANSWER. The author of a record controls
 * its bytes, so "how many `prov:wasAttributedTo` does it state" and "how many activities does the
 * Delegation name" are questions a reader has to be able to ask; a caller handing over one value
 * per field would already have chosen, and choosing is what this refuses to do.
 */
export interface AuthorshipStatements {
  /** `prov:wasAttributedTo` — who composed it. */
  readonly attributedTo: readonly string[];
  /** `prov:wasGeneratedBy` — the ACT, which is what any per-act statement has to be about. */
  readonly generatedBy: readonly string[];
  /** `prov:qualifiedDelegation` — the Delegation nodes the author is linked to. */
  readonly qualifiedDelegation: readonly string[];
  /** `prov:agent` — inside a Delegation, the party that retains responsibility. */
  readonly delegationAgent: readonly string[];
  /** `prov:hadActivity` — inside a Delegation, the one act it is scoped to. */
  readonly delegationActivity: readonly string[];
  /** `iep:actedOnOwnAccount` — the activities the author declares it answered for alone. */
  readonly actedOnOwnAccount: readonly string[];
}

/** The activity IRI a record's footing statements are scoped to. Derived, never guessed. */
export const footingActivityIri = (entryIri: string): string => entryIri + '#act';
/** The `prov:Delegation` node for one record. Named rather than blank — see {@link footingTurtle}. */
export const footingDelegationIri = (entryIri: string): string => entryIri + '#delegation';

/**
 * The per-act footing statements for ONE record, as Turtle.
 *
 * ★ WHY IT IS AT THE SUBSTRATE. Which triples say "this act was on my human's behalf" is an
 * Interego answer, not a workspace one — the Discord conduit, the desktop shell and any later
 * vertical have to write the SAME triples or a reader crossing two of them gets two answers to one
 * question. What a vertical still owns is its own record type (`wsp:Entry`, its body, its sequence
 * number); the footing block is spliced into it.
 *
 * ★ NAMED NODES, NOT BLANK ONES. The Delegation and the Activity are fragments of the record's own
 * IRI. A blank node would be correct PROV and would break two things that matter here: the relay
 * signs canonical triples, and blank-node labels are not stable across a canonicalization; and the
 * readers on the far side are REGION-scoped regexes over Turtle, which cannot follow a `[ … ]` back
 * to the subject it hangs off. A fragment IRI is stable, dereferenceable-shaped, and checkable —
 * the reader can demand that the Delegation's `prov:hadActivity` be THIS record's act.
 *
 * ★ AND THE IRI GUARD IS THE CALLER'S, PASSED IN. A Turtle IRI reference ends at the first `>` and
 * the production has no escape for one, so an unchecked IRI can close the reference and write
 * triples its author never authorised. That guard already exists at the call site — which is also
 * the only place that can name WHICH argument was bad in the error — so it is borrowed rather than
 * copied. A third spelling of the IRIREF rule in this repo is a third thing to keep in agreement.
 */
export function footingTurtle(args: {
  readonly entryIri: string;
  /** The agent the record is attributed to. It is the subject of both footing statements. */
  readonly agentId: string;
  readonly footing: StatedFooting;
  /** The caller's own Turtle IRIREF guard: `(value, what) => '<value>'`, throwing on the rest. */
  readonly iri: (u: string, what: string) => string;
  readonly endedIso: string;
}): { readonly generatedBy: string; readonly blocks: string } {
  const { iri } = args;
  // Checked for its own sake even though the fragments below are derived from it: an error naming
  // `<entry>#act` would send a reader looking for a value no caller ever passed in.
  iri(args.entryIri, 'the record IRI a footing is being written for');
  const act = iri(footingActivityIri(args.entryIri), 'the activity IRI for this record');
  const agent = iri(args.agentId, 'the agent id this record is attributed to');
  const activityBlock = act + '\n'
    + '  a prov:Activity ;\n'
    + '  prov:wasAssociatedWith ' + agent + ' ;\n'
    + '  prov:endedAtTime "' + args.endedIso + '"^^xsd:dateTime .\n';
  if (args.footing.kind === 'own-account') {
    return {
      generatedBy: '  prov:wasGeneratedBy ' + act + ' ;\n',
      // No Delegation names this act, AND that is said rather than left to be inferred from the
      // absence of one — see `iep:actedOnOwnAccount`.
      blocks: '\n' + activityBlock + '\n' + agent + ' iep:actedOnOwnAccount ' + act + ' .\n',
    };
  }
  const del = iri(footingDelegationIri(args.entryIri), 'the delegation IRI for this record');
  const principal = iri(args.footing.principal, 'the WebID this delegate spoke for in this record');
  return {
    generatedBy: '  prov:wasGeneratedBy ' + act + ' ;\n',
    blocks: '\n' + activityBlock
      + '\n' + agent + ' prov:qualifiedDelegation ' + del + ' .\n'
      + '\n' + del + '\n'
      + '  a prov:Delegation ;\n'
      + '  prov:agent ' + principal + ' ;\n'
      + '  prov:hadActivity ' + act + ' .\n',
  };
}

// ── Authorship ───────────────────────────────────────────────

/**
 * WHO WROTE A RECORD.
 *
 * `unstated` is a real answer and a UI must render it as one: a record that names no author is
 * not a record the pod owner wrote, it is one that does not say. Absence is not evidence.
 */
export type EntryAuthorship =
  | { readonly kind: 'unstated'; readonly why: string }
  | { readonly kind: 'principal'; readonly webId: string }
  | {
      readonly kind: 'delegate';
      readonly agentId: string;
      /**
       * What THIS record was made on. Separate from `authorised` below on purpose: one is about
       * the utterance, the other about the agent's standing, and they can disagree in both
       * directions.
       */
      readonly footing: EntryFooting;
      /** The name their pod's registry gives it, when the registry was read and lists it. */
      readonly name: string | null;
      /**
       * Does the delegator's own pod list this agent?
       *
       * THREE VALUES. `null` is "the registry was not read", which is not "no" — a record whose
       * authorisation could not be checked must not render as an unauthorised one.
       */
      readonly authorised: boolean | null;
      readonly scope: string | null;
    }
  | { readonly kind: 'disputed'; readonly why: string };

/** Either a footing this reader is prepared to state, or the reason it will state none. */
type FootingRead =
  | { readonly ok: true; readonly footing: EntryFooting }
  | { readonly ok: false; readonly why: string };

/**
 * Which footing a record's own statements establish for the act that generated it.
 *
 * ★ EVERY REFUSAL BELOW IS A COUNT OR A MISMATCH, NEVER A PREFERENCE. The record's author controls
 * its bytes, so two Delegations, a Delegation over somebody else's activity, or both footings at
 * once are all things a record can say — and none of them is a footing. Where the statements do
 * not compose into one answer, the disagreement is reported and the reader picks nothing.
 */
function footingOf(st: AuthorshipStatements): FootingRead {
  const bad = (why: string): FootingRead => ({ ok: false, why });
  const stated = st.qualifiedDelegation.length + st.delegationAgent.length
    + st.delegationActivity.length + st.actedOnOwnAccount.length;

  if (st.generatedBy.length > 1) {
    return bad('this record names ' + st.generatedBy.length + ' different prov:wasGeneratedBy activities ('
      + st.generatedBy.join(', ') + '), so which act its footing statements are about is not decided');
  }
  if (st.generatedBy.length === 0) {
    if (stated === 0) {
      return {
        ok: true,
        footing: {
          kind: 'not-stated',
          why: 'this record names no prov:wasGeneratedBy activity and carries neither a prov:Delegation over one nor '
            + 'an iep:actedOnOwnAccount statement, so whether it was written for the person whose log it is in or on '
            + 'its author\'s own account is not stated — which is not the same as either of them',
        },
      };
    }
    return bad('this record carries per-act footing statements and names no prov:wasGeneratedBy activity for them to be '
      + 'about, so what act they are scoped to is not established');
  }
  const act = st.generatedBy[0] as string;

  if (st.actedOnOwnAccount.length > 1) {
    return bad('this record carries ' + st.actedOnOwnAccount.length + ' iep:actedOnOwnAccount statements ('
      + st.actedOnOwnAccount.join(', ') + '), so what its author is claiming sole accountability for is not decided');
  }
  const ownFor = st.actedOnOwnAccount.length === 1 ? st.actedOnOwnAccount[0] as string : null;
  if (ownFor !== null && ownFor !== act) {
    return bad('this record states iep:actedOnOwnAccount about ' + ownFor + ', which is not the activity that generated it ('
      + act + '), so it says nothing about the footing of this record');
  }
  const anyDelegation = st.qualifiedDelegation.length > 0 || st.delegationAgent.length > 0
    || st.delegationActivity.length > 0;

  if (ownFor !== null && anyDelegation) {
    // The one combination the ontology forbids outright. Both are POSITIVE statements, so this is
    // a record contradicting itself rather than a record that is merely quiet.
    return bad('this record states BOTH that a prov:Delegation covers the act that generated it and that its author '
      + 'iep:actedOnOwnAccount for that same act. Those are opposite claims about who is accountable, and this reader '
      + 'will not choose between them.');
  }
  if (ownFor !== null) return { ok: true, footing: { kind: 'own-account' } };
  if (!anyDelegation) {
    return {
      ok: true,
      footing: {
        kind: 'not-stated',
        why: 'this record names the act that generated it and says nothing about the footing of that act — no '
          + 'prov:Delegation covers it and it does not declare iep:actedOnOwnAccount either, so whether its author '
          + 'spoke for the person whose log this is or on its own account is not stated',
      },
    };
  }
  if (st.qualifiedDelegation.length !== 1) {
    return bad('this record carries ' + st.qualifiedDelegation.length + ' prov:qualifiedDelegation statements, so which '
      + 'delegation is being claimed over this act is not decided');
  }
  if (st.delegationAgent.length !== 1) {
    return bad('the prov:Delegation in this record names ' + st.delegationAgent.length + ' prov:agent values ('
      + st.delegationAgent.join(', ') + '), so who retains responsibility for this act is not decided');
  }
  if (st.delegationActivity.length !== 1) {
    return bad('the prov:Delegation in this record names ' + st.delegationActivity.length + ' prov:hadActivity values, so '
      + 'which act it is scoped to is not decided — and an unscoped delegation is the standing relation, not a statement '
      + 'about this record');
  }
  if (st.delegationActivity[0] !== act) {
    return bad('the prov:Delegation in this record is scoped to activity ' + st.delegationActivity[0] + ', and the act that '
      + 'generated this record is ' + act + '. A delegation over a different act says nothing about this one.');
  }
  return { ok: true, footing: { kind: 'on-behalf-of', principal: st.delegationAgent[0] as string } };
}

/**
 * Judge authorship from the PROV statements a record carries.
 *
 * ★ TWO QUESTIONS, ANSWERED SEPARATELY, WHICH IS THE WHOLE CORRECTION. "Who composed this" is
 * `prov:wasAttributedTo` and names whoever actually composed it — a person for their own words, the
 * AGENT for an agent's. "Was it made on the human's behalf" is a different question with three
 * answers, and it is settled per-act by {@link footingOf} rather than assumed from the first. A
 * reader that answered the second from the first would say of every delegate sentence what is only
 * true of some of them.
 *
 * ★ THE CHECK THAT MAKES THIS WORTH ANYTHING IS STILL HERE AND IS NOW THE STRONGER OF TWO. A record
 * sits in a log on somebody's own pod and its bytes are theirs — so every triple in it is a CLAIM.
 * What holds a for-the-human footing down is that the Delegation must name the pod's own OWNER as
 * the party retaining responsibility; naming a third party is refused. And what holds the AUTHOR
 * down is the delegator's own delegation registry, a document only they can write: `authorised`
 * below is that check, it is three-valued, and it is the one that matters for a record claiming no
 * footing at all.
 *
 * ★ AN UNSTATED FOOTING IS NO LONGER `disputed`, AND THAT IS A FIX RATHER THAN A RELAXATION. This
 * used to return `disputed` for any record whose author was not the log's owner and which carried
 * no `prov:actedOnBehalfOf` — absence read as a contradiction. But "the agent wrote this on its own
 * account" and "this record does not say" are both legitimate states of a record now, and neither
 * is a dispute. What was really being checked there — is this author anybody the pod owner
 * authorised — is `authorised`, which asks a document the record's author cannot write.
 *
 * ★ IT TAKES THE IRIs, NOT A SERIALIZATION. The judgment is the portable part and does not care
 * whether the statements arrived as Turtle, JSON-LD or a parsed store; a caller extracts the lists
 * however its format demands and gets the same answers. That is also what keeps this module free of
 * a parser dependency, which a browser bundle would otherwise pay for.
 *
 * `delegates` may be null: this is then answered as far as the record alone establishes it, with
 * `authorised: null`, rather than not answered at all.
 */
export function judgeAuthorship(
  statements: AuthorshipStatements | null,
  args: { readonly logOwnerWebId: string | null; readonly delegates: DelegateRoster | null },
): EntryAuthorship {
  if (statements === null) {
    return { kind: 'unstated', why: 'the signed region of this record could not be located, so nothing about its author was read from bytes anybody signed' };
  }
  const attributed = statements.attributedTo;
  if (attributed.length === 0) {
    return { kind: 'unstated', why: 'this record names no prov:wasAttributedTo, so who composed it is not stated in the record — which is not the same as the pod owner having written it' };
  }
  if (attributed.length > 1) {
    return { kind: 'disputed', why: 'this record names ' + attributed.length + ' different prov:wasAttributedTo authors (' + attributed.join(', ') + '), so who wrote it is not decided and this reader will not pick one' };
  }
  const author = attributed[0] as string;

  if (!args.logOwnerWebId) {
    return { kind: 'disputed', why: 'this record is attributed to ' + author + ' and this reader could not establish whose log it is in, so whether that is the owner or somebody acting for them is not decided' };
  }
  const read = footingOf(statements);
  if (author === args.logOwnerWebId) {
    // A person composing their own words has no footing question, so any footing statement here is
    // a record saying something about itself that cannot be true. `prov:Delegation` requires two
    // agents and nobody delegates to themselves.
    if (read.ok && read.footing.kind !== 'not-stated') {
      return {
        kind: 'disputed',
        why: 'this record is attributed to the pod owner and ALSO carries a per-act footing statement ('
          + (read.footing.kind === 'own-account' ? 'iep:actedOnOwnAccount' : 'a prov:Delegation naming ' + read.footing.principal)
          + '). A person does not act as a delegate of themselves, so what this record is saying is not established.',
      };
    }
    if (!read.ok) return { kind: 'disputed', why: read.why };
    return { kind: 'principal', webId: author };
  }
  if (!read.ok) return { kind: 'disputed', why: read.why };
  if (read.footing.kind === 'on-behalf-of' && read.footing.principal !== args.logOwnerWebId) {
    return {
      kind: 'disputed',
      why: 'this record says ' + author + ' acted as a delegate of ' + read.footing.principal + ' when it wrote this, and the '
        + 'pod this log is on belongs to ' + args.logOwnerWebId + '. A record in somebody\'s log declaring it was written for '
        + 'a third party is not something this reader will render as either of them speaking.',
    };
  }
  const row = args.delegates?.read ? args.delegates.rows.find((r) => r.agentId === author) ?? null : null;
  return {
    kind: 'delegate',
    agentId: author,
    footing: read.footing,
    name: row?.name ?? null,
    authorised: args.delegates?.read ? row !== null : null,
    scope: row?.scope ?? null,
  };
}

/**
 * The short label a surface puts beside a record, so every surface says the same thing.
 *
 * ★ THE THREE DELEGATE LINES MUST NOT LOOK ALIKE, WHICH IS THE POINT OF THE WHOLE CHANGE. "Mark's
 * delegate speaking for Mark" and "Mark's delegate speaking for itself" are different claims about
 * who is answerable for the sentence underneath, and a label that read the same for both would
 * leave the distinction in the graph and out of the reader's hands. The third — a record that
 * states no footing — says so, and is never quietly folded into either.
 *
 * ★ AND THE OTHER TWO CASES ARE THE ONES A NAME CANNOT CARRY. "Unstated" and "disputed" both have
 * to read as what they are; a shell that reduced them to a person's name would be inventing one.
 * The long sentence for those two is on the authorship value itself, in `why`.
 */
/**
 * The full sentence a surface shows about a footing, in one place so four of them agree.
 *
 * ★ THE SHORT LABEL IS NOT ENOUGH ON ITS OWN AND THE LONG ONE MUST NOT BE PER-SURFACE. A tooltip
 * in the desktop shell, a bracketed clause in a Discord message, a title attribute in the published
 * artifact and the line a person reads before letting their delegate speak are four renderings of
 * ONE fact, and the last time this vertical let a surface write its own copy for a substrate answer
 * the two came apart in the direction that flattered the reader. So the sentence is here, beside
 * the judgment that produced it.
 *
 * `who` is the person whose log the record is in — the party a delegation would name.
 */
export function footingLine(f: EntryFooting, args: { readonly who: string; readonly agentName?: string | null } = { who: 'the person whose pod this is' }): string {
  const me = args.agentName ? args.agentName : 'this delegate';
  switch (f.kind) {
    case 'on-behalf-of':
      return 'A prov:Delegation in this record covers the act that produced it and names ' + f.principal
        + ' as the party that retains responsibility for it — so ' + me + ' was speaking FOR them here, and they share in what it says.';
    case 'own-account':
      return 'This record declares iep:actedOnOwnAccount over the act that produced it: no delegation covers it, so '
        + me + ' was speaking for ITSELF here — its own reasoning and its own position — and ' + args.who
        + ' is not answerable for it. ' + me + ' is still ' + args.who + '\'s delegate; that is a standing fact about the '
        + 'agent and is unaffected by the footing of any one thing it says.';
    case 'not-stated':
      return 'This record does not say which footing it was made on — ' + f.why
        + '. That is not "on their behalf" and it is not "on its own account"; it is a record that does not say, and this '
        + 'reader will not fill it in for either of them.';
  }
}

export function authorshipLine(a: EntryAuthorship, args: { readonly displayName?: string | null } = {}): string {
  const who = args.displayName ? args.displayName : 'the person whose pod this is';
  switch (a.kind) {
    case 'principal': return who;
    case 'delegate': {
      const name = a.name ? a.name : 'an unnamed delegate';
      if (a.footing.kind === 'on-behalf-of') return name + ', speaking for ' + who;
      if (a.footing.kind === 'own-account') return name + ', a delegate of ' + who + ', speaking for itself';
      return name + ', a delegate of ' + who + ' — footing not stated';
    }
    case 'unstated': return 'author not stated';
    case 'disputed': return 'authorship disputed';
  }
}
