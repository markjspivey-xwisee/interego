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
      'Records it writes land on your pod and in your log, and they name IT as the author and YOU as the person it acted for. A reader can tell them apart from something you wrote, and so can you.',
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
      readonly onBehalfOf: string;
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

/**
 * Judge authorship from the PROV statements a record carries.
 *
 * ★ THE ONE CHECK THAT MAKES THIS WORTH ANYTHING. A record sits in a log on its author's own pod
 * and its bytes are theirs — so `prov:wasAttributedTo` is a CLAIM, and a member could name
 * anybody in it. What holds it down is the pair of documents around it: the record must say the
 * agent acted for the pod's own OWNER, and that owner's own delegation registry — a document
 * only they can write — must list the agent. Neither can be manufactured by a third party, and
 * where they disagree the disagreement is REPORTED rather than resolved.
 *
 * ★ IT TAKES THE IRIs, NOT A SERIALIZATION. The judgment is the portable part and does not care
 * whether the statements arrived as Turtle, JSON-LD or a parsed store; a caller extracts the two
 * lists however its format demands and gets the same eight answers. That is also what keeps this
 * module free of a parser dependency, which a browser bundle would otherwise pay for.
 *
 * `delegates` may be null: this is then answered as far as the record alone establishes it, with
 * `authorised: null`, rather than not answered at all.
 */
export function judgeAuthorship(
  statements: { readonly attributedTo: readonly string[]; readonly actedOnBehalfOf: readonly string[] } | null,
  args: { readonly logOwnerWebId: string | null; readonly delegates: DelegateRoster | null },
): EntryAuthorship {
  if (statements === null) {
    return { kind: 'unstated', why: 'the signed region of this record could not be located, so nothing about its author was read from bytes anybody signed' };
  }
  const attributed = statements.attributedTo;
  const behalf = statements.actedOnBehalfOf;
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
  if (author === args.logOwnerWebId) {
    if (behalf.length) {
      return { kind: 'disputed', why: 'this record is attributed to the pod owner and ALSO carries a prov:actedOnBehalfOf statement naming ' + behalf.join(', ') + '. A person does not act on their own behalf through themselves, so what this record is saying is not established.' };
    }
    return { kind: 'principal', webId: author };
  }
  if (behalf.length === 0) {
    return { kind: 'disputed', why: 'this record is attributed to ' + author + ', which is not the owner of the pod it is on (' + args.logOwnerWebId + '), and it states no prov:actedOnBehalfOf. So it claims an author who is neither the log\'s owner nor declared to be acting for them.' };
  }
  if (behalf.length > 1) {
    return { kind: 'disputed', why: 'this record carries ' + behalf.length + ' prov:actedOnBehalfOf statements (' + behalf.join(', ') + '), so who ' + author + ' was acting for is not decided' };
  }
  const principal = behalf[0] as string;
  if (principal !== args.logOwnerWebId) {
    return { kind: 'disputed', why: 'this record says ' + author + ' acted on behalf of ' + principal + ', and the pod this log is on belongs to ' + args.logOwnerWebId + '. A record in somebody\'s log declaring it was written for a third party is not something this reader will render as either of them speaking.' };
  }
  const row = args.delegates?.read ? args.delegates.rows.find((r) => r.agentId === author) ?? null : null;
  return {
    kind: 'delegate',
    agentId: author,
    onBehalfOf: principal,
    name: row?.name ?? null,
    authorised: args.delegates?.read ? row !== null : null,
    scope: row?.scope ?? null,
  };
}

/**
 * The short label a surface puts beside a record, so every surface says the same thing.
 *
 * ★ THE INTERESTING CASES ARE THE ONES A NAME CANNOT CARRY. "Unstated" and "disputed" both have
 * to read as what they are; a shell that reduced them to a person's name would be inventing one.
 * The long sentence for those two is on the authorship value itself, in `why`.
 */
export function authorshipLine(a: EntryAuthorship, args: { readonly displayName?: string | null } = {}): string {
  const who = args.displayName ? args.displayName : 'the person whose pod this is';
  switch (a.kind) {
    case 'principal': return who;
    case 'delegate': return (a.name ? a.name : 'an unnamed delegate') + ', acting for ' + who;
    case 'unstated': return 'author not stated';
    case 'disputed': return 'authorship disputed';
  }
}
