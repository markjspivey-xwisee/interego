/**
 * Increment 0's instrument: count the consent decisions in a real day of work.
 *
 * ★ WHY THIS FILE EXISTS, AND WHY IT IS ALLOWED TO BE LITERAL.
 *
 * The Editor Witness design rests on one empirical claim nobody has measured: that
 * developers press "reject always" often enough, on varied enough actions, for a standing
 * deny set to be worth anything. If a real day yields zero `reject_always` — or the same
 * `allow_always` on two tools and nothing else — then the standing-constraint thesis is
 * dead, the composition produces an empty set forever, and the honest outcome is to ship
 * a log and say so.
 *
 * That question is worth one day and no more, so this file is the cheapest thing that can
 * answer it. It publishes NOTHING. It holds counts in memory and prints a summary.
 *
 * ★ THIS IS NOT `map.ts`, AND THE DISTINCTION IS LOAD-BEARING.
 *
 * The house rule is that conformance is profile-driven: a spec-blind engine plus published
 * profile DATA, never `if (protocol === x)`. `map.ts` — which turns a frame into substrate
 * terms — will obey that in increment 1, reading a published mapping graph, with a guard
 * that greps it for exactly the foreign tokens spelled out below.
 *
 * This file is a measuring instrument pointed AT ACP. It necessarily knows what an ACP
 * permission request is called, in the same way a thermometer is calibrated in degrees.
 * It is deliberately excluded from the mapping layer so the guard on that layer stays
 * meaningful, and it is superseded — not extended — when `map.ts` lands. If you find
 * yourself adding substrate vocabulary here, you are writing the wrong file.
 */
import type { Frame, Observation, Observer } from './transport.js';

/** ACP tokens. Confined to this file on purpose — see the header. */
const PERMISSION_METHOD = 'session/request_permission';
const UPDATE_METHOD = 'session/update';

export interface Tally {
  /** Permission requests seen, whether or not an answer came back. */
  permissionRequests: number;
  /** Outcomes by the option KIND the human's chosen optionId resolved to. */
  outcomeByKind: Record<string, number>;
  /** Requests that were answered `cancelled` rather than `selected`. */
  cancelled: number;
  /** Requests still unanswered when the session ended. */
  unanswered: number;
  /** Distinct tool-call kinds observed, and how often. Tells us whether an eventual
   *  deny set would be VARIED or concentrated on one or two tools. */
  toolCallsByKind: Record<string, number>;
  /** ★ The number that decides the thesis: distinct (kind) values that ever received an
   *  always-scoped DENIAL. An empty set here means no standing constraints, ever. */
  deniedAlwaysKinds: string[];
  /** Distinct sessions observed. */
  sessions: number;
  frames: number;
}

const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };

/**
 * Correlate permission requests with their answers.
 *
 * The option KIND is not in the response — the response names an `optionId`, and the
 * kinds live in the REQUEST's `options` array. So the outcome is only knowable by
 * remembering the request and joining on the JSON-RPC id. Getting this wrong would be
 * invisible: you would count requests correctly and silently learn nothing about consent.
 */
export function createTally(): { tally: Tally; observer: Observer; finish(): Tally } {
  const tally: Tally = {
    permissionRequests: 0,
    outcomeByKind: {},
    cancelled: 0,
    unanswered: 0,
    toolCallsByKind: {},
    deniedAlwaysKinds: [],
    sessions: 0,
    frames: 0,
  };

  /** id -> { optionId -> kind, toolKind } for requests awaiting an answer. */
  const pending = new Map<string, { kinds: Map<string, string>; toolKind: string }>();
  const seenSessions = new Set<string>();
  const deniedAlways = new Set<string>();

  const idOf = (f: Frame): string | null =>
    typeof f.id === 'string' || typeof f.id === 'number' ? String(f.id) : null;

  const observer: Observer = (o: Observation) => {
    tally.frames++;
    const f = o.frame;
    if (!f) return;

    const sid = (f.params as { sessionId?: unknown } | undefined)?.sessionId;
    if (typeof sid === 'string' && !seenSessions.has(sid)) {
      seenSessions.add(sid);
      tally.sessions = seenSessions.size;
    }

    // ── a permission REQUEST (agent -> editor) ──────────────────────────
    if (f.method === PERMISSION_METHOD) {
      tally.permissionRequests++;
      const id = idOf(f);
      const p = f.params as {
        toolCall?: { kind?: unknown };
        options?: ReadonlyArray<{ optionId?: unknown; kind?: unknown }>;
      } | undefined;
      const toolKind = typeof p?.toolCall?.kind === 'string' ? p.toolCall.kind : 'unknown';
      const kinds = new Map<string, string>();
      for (const opt of p?.options ?? []) {
        if (typeof opt?.optionId === 'string' && typeof opt?.kind === 'string') {
          kinds.set(opt.optionId, opt.kind);
        }
      }
      if (id !== null) pending.set(id, { kinds, toolKind });
      return;
    }

    // ── tool calls, for variety ─────────────────────────────────────────
    if (f.method === UPDATE_METHOD) {
      const u = (f.params as { update?: Record<string, unknown> } | undefined)?.update;
      const kind = u?.['kind'];
      if (typeof kind === 'string') bump(tally.toolCallsByKind, kind);
      return;
    }

    // ── the ANSWER (editor -> agent): a result carrying an outcome ──────
    const id = idOf(f);
    if (id === null || !pending.has(id) || f.result === undefined) return;
    const ctx = pending.get(id)!;
    pending.delete(id);

    const outcome = (f.result as { outcome?: { outcome?: unknown; optionId?: unknown } } | undefined)?.outcome;
    if (outcome?.outcome === 'cancelled') { tally.cancelled++; return; }
    if (typeof outcome?.optionId !== 'string') return;

    const kind = ctx.kinds.get(outcome.optionId) ?? 'unknown';
    bump(tally.outcomeByKind, kind);
    // "always" is the axis that matters: a once-scoped answer is a UI event, an
    // always-scoped one is a rule the human intends to persist.
    if (kind.startsWith('reject') && kind.endsWith('always')) {
      deniedAlways.add(ctx.toolKind);
      tally.deniedAlwaysKinds = [...deniedAlways].sort();
    }
  };

  return {
    tally,
    observer,
    finish(): Tally {
      tally.unanswered = pending.size;
      return tally;
    },
  };
}

/** Human-readable verdict. States plainly whether the thesis survived. */
export function summarise(t: Tally): string {
  const always = Object.entries(t.outcomeByKind)
    .filter(([k]) => k.endsWith('always'))
    .reduce((n, [, v]) => n + v, 0);
  const lines = [
    '',
    '─── Editor Witness · increment 0 · nothing was published ───',
    `  frames observed        ${t.frames}`,
    `  sessions               ${t.sessions}`,
    `  permission requests    ${t.permissionRequests}`,
    `  outcomes by kind       ${JSON.stringify(t.outcomeByKind)}`,
    `  cancelled              ${t.cancelled}`,
    `  unanswered at exit     ${t.unanswered}`,
    `  tool calls by kind     ${JSON.stringify(t.toolCallsByKind)}`,
    `  always-scoped total    ${always}`,
    `  tool kinds ever denied ${t.deniedAlwaysKinds.length ? t.deniedAlwaysKinds.join(', ') : '(none)'}`,
    '',
  ];
  if (t.permissionRequests === 0) {
    lines.push('  VERDICT: no permission requests at all. Either the agent needed no',
      '  approval for this work, or the editor auto-approves. Not yet informative —',
      '  re-run on work that touches files.');
  } else if (t.deniedAlwaysKinds.length === 0) {
    lines.push('  VERDICT: no always-scoped DENIALS. On this evidence the standing-constraint',
      '  thesis is unsupported: the deny set would be empty, so there is nothing for a',
      '  vertical to subtract and no downward causation. Ship the trace as a log.');
  } else {
    lines.push(`  VERDICT: ${t.deniedAlwaysKinds.length} tool kind(s) received a standing denial.`,
      '  A non-empty deny set exists, so increment 1 has something to carry.');
  }
  lines.push('');
  return lines.join('\n');
}
