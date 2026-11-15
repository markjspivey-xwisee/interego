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
const INITIALIZE_METHOD = 'initialize';
/**
 * The editor's requests whose result says which mode a session starts in, and where that
 * session's id is: in the result for a new or forked session, in the request for one that
 * is loaded or resumed.
 */
const SESSION_OPENERS: ReadonlyMap<string, 'result' | 'params'> = new Map([
  ['session/new', 'result'],
  ['session/fork', 'result'],
  ['session/load', 'params'],
  ['session/resume', 'params'],
]);
const SET_MODE_METHOD = 'session/set_mode';
const SET_CONFIG_METHOD = 'session/set_config_option';
/** The session config option that carries the mode (its id, and its ACP category). */
const MODE_CONFIG = 'mode';
/** ACP's ToolKind for a tool call that switches the session mode. */
const SWITCH_MODE_KIND = 'switch_mode';
/** Tool call statuses after which no permission request can name that call. */
const TERMINAL_STATUSES = new Set(['completed', 'failed']);
/** The mode a request is counted under when the agent never said which mode its session is in. */
export const UNANNOUNCED_MODE = 'unannounced';
/**
 * Mode ids both agents use. An answer whose optionId is one of these, or one of the ids a
 * session's result advertised, may be the old agent's ExitPlanMode answer (see trap b).
 */
const KNOWN_MODE_IDS = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions', 'auto'];

export interface Tally {
  /**
   * The ACP protocol version the agent answered `initialize` with, or null if no answer was
   * seen. Every count below reads ACP v1 frames. The draft v2 has no `current_mode_update`
   * and puts a permission request's tool call under `subject`, so a v2 session's counts
   * are not measurements and summarise() says so instead of printing them.
   */
  protocolVersion: number | null;
  /** Permission requests seen, whether or not an answer came back. */
  permissionRequests: number;
  /**
   * ★ WHAT WAS ON THE MENU — how many requests OFFERED each option kind.
   *
   * Without this the instrument cannot tell two very different worlds apart:
   *   (a) developers were offered "reject always" and never picked it   → thesis dead
   *   (b) "reject always" was never on the menu                          → thesis UNTESTED
   * Both produce zero always-scoped denials. Reporting (b) as (a) is not a rounding
   * error, it is a confidently wrong conclusion drawn from a measurement that never
   * happened — and the first live run hit exactly that case.
   */
  offeredKinds: Record<string, number>;
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
   *  always-scoped DENIAL. An empty set here means no standing constraints, ever. A
   *  standing denial of a mode switch is not one of these: see the field after it. */
  deniedAlwaysKinds: string[];
  /**
   * reject_always answers to a tool call of kind `switch_mode`: a refusal to leave (or
   * enter) plan mode, which the reject-always probe can put on that menu. It denies no tool,
   * so it is kept out of deniedAlwaysKinds and the verdict, and reported on its own line.
   */
  standingDenialsOfModeSwitch: number;
  /**
   * ★ THE SESSION MODES SEEN, AND HOW MANY PERMISSION REQUESTS AROSE UNDER EACH.
   *
   * Without this the tally is uninterpretable, because the mode decides WHO answered.
   * The production agent, @agentclientprotocol/claude-agent-acp, advertises in its own
   * words (dist/session-mode.js):
   *   default            "Always ask before making changes"
   *   acceptEdits        "Automatically accept all file edits"
   *   plan               "Create a plan before making changes"
   *   auto               "Claude handles permission decisions"
   *   bypassPermissions  "Accepts all permissions" (only when bypass is allowed)
   * Its predecessor, @zed-industries/claude-code-acp, also had dontAsk ("Don't prompt for
   * permissions, deny if not pre-approved") and no auto.
   *
   * So `{allow_once: 40}` means forty human decisions under `default`, and something
   * else entirely if the developer switched to acceptEdits at 09:05 — after which the
   * agent, not the person, is producing the answers. That is the same
   * "generated by the measurer" failure this instrument exists to avoid, except the
   * generator is the vendor's policy engine rather than a script.
   *
   * Each session has its own mode, and the agent says what it is in four places, all read:
   *   - the result of the editor's session/new, load, resume or fork (`modes.currentModeId`,
   *     else the `mode` config option). This is the only place the successor says which mode
   *     a session STARTS in, and it is not `default` there: it is the user's
   *     `permissions.defaultMode`, or for a resumed session the mode it was last in, and
   *     from 0.107.0 a session with no defaultMode starts in `auto`. No update announces it.
   *   - session/update with `sessionUpdate: 'current_mode_update'`, which carries no `kind`
   *     and was once dropped on the floor;
   *   - session/update with `sessionUpdate: 'config_option_update'`, whose `mode` option
   *     the successor sends after every mode change, including one the editor made;
   *   - the result of the editor's own session/set_mode or session/set_config_option, which
   *     neither agent announces otherwise (the successor only when it falls back).
   * A request in a session none of these named is counted under "unannounced", not
   * guessed to be `default`.
   */
  modeRequests: Record<string, number>;
  /**
   * Modes entered, in order, so a mid-session switch is visible rather than averaged. A
   * session that starts in a mode other than `default` appears here too, at its start.
   */
  modeTimeline: string[];
  /**
   * ★ TRAP (b) — answers that were really SESSION MODE SWITCHES, most of them labelled
   * "allow_always".
   *
   * The production agent's ExitPlanMode prompt, from @agentclientprotocol/claude-agent-acp
   * (dist/permissions/options/tools.js and options.js), verbatim:
   *   { optionId: "exit-plan-default",    name: "Yes, manually approve edits", kind: "allow_once" }
   *   { optionId: "exit-plan-clear-auto", name: "Yes, clear context (N% used) and use auto mode", kind: "allow_always" }
   *   { optionId: "exit-plan-auto",       name: "Yes, and use auto mode", kind: "allow_always" }
   *   { optionId: "exit-plan-bypass",     name: "Yes, and bypass permissions", kind: "allow_always" }
   *   { optionId: "reject",               name: "No, keep planning", kind: "reject_once" }
   * That is the order it is sent in when the session offers auto and bypass and was not in
   * bypassPermissions before plan mode. When it was, bypass leads: exit-plan-clear-bypass
   * ("Yes, clear context (N% used) and bypass permissions"), then exit-plan-bypass, then
   * exit-plan-auto. With neither on offer, those entries are exit-plan-clear-accept-edits
   * and exit-plan-accept-edits ("Yes, auto-accept edits"). The clear-context entry is there
   * only when the request carries a plan. And when Claude Code asks to open on the decline
   * option (`defaultToNo`), the reject comes first and the rest follow in the same order.
   * Its predecessor, @zed-industries/claude-code-acp, sent instead:
   *   { kind: "allow_always", name: "Yes, and auto-accept edits", optionId: "acceptEdits" }
   *   { kind: "allow_once",   name: "Yes, and manually approve edits", optionId: "default" }
   *   { kind: "reject_once",  name: "No, keep planning",  optionId: "plan" }
   *
   * Choosing an allow here grants nothing about the tool being asked about. It puts the
   * whole session into another mode (dist/permissions/effects.js: auto, bypassPermissions,
   * acceptEdits or default; a clear-context answer restarts the session in that mode), where
   * the agent may answer later prompts itself. Counting it as "always-allow this tool" adds
   * a grant that was never made and hides a mode change that reinterprets everything after.
   *
   * Detected from the wire rather than from either vendor's ids: an answer that is not a
   * rejection, to a request about a tool call of ACP tool kind `switch_mode` (both agents
   * give ExitPlanMode that kind, and the successor gives it EnterPlanMode too), is a mode
   * switch WHEN IT IS GIVEN. Allowing a mode-switching call switches the mode; nothing that
   * arrives afterwards can make it a grant, so nothing afterwards is waited for. The
   * agent's later `current_mode_update` in the same session only confirms it, and switches
   * never confirmed are counted (modeSwitchesUnconfirmed) rather than turned back into
   * grants. The old agent's ids were mode names, so for a request whose tool kind is not
   * `switch_mode` (it sent none in the request) an answer whose optionId names a mode also
   * counts, once that session's next announced mode is the one it named. A rejection is
   * never reclassified.
   */
  modeSwitchesMistakableForGrants: Array<{ optionId: string; kind: string; toolKind: string }>;
  /**
   * Of those switches, how many the agent never followed with a `current_mode_update` in
   * their session: a clear-context restart that failed, or a session that ended first.
   * They are still switches, but the witness does not know the mode that followed, and
   * keeps counting that session's later requests under the mode it last saw.
   */
  modeSwitchesUnconfirmed: number;
  /**
   * ★ TRAP (a) — a standing grant is not a frequency.
   *
   * `allow_always` installs a SESSION RULE, so that tool never asks again. Each tool can
   * therefore contribute at most ONE `allow_always` per session, and the total is a
   * decreasing function of how early the developer granted: grant Bash at 09:01 and forty
   * later uses are invisible; grant it at 17:00 and thirty-nine asks were counted first.
   * Read as a rate it is not merely noisy, it is inverted.
   *
   * So the honest unit is DISTINCT TOOLS placed under a standing grant.
   */
  standingGrantsByTool: Record<string, number>;
  /**
   * Requests that arrived for a tool ALREADY under a standing grant. Should be zero; a
   * non-zero value means the rule did not stick, and the allow_always count is then closer
   * to a real frequency than to a count of tools.
   */
  asksAfterStandingGrant: number;
  /** Distinct sessions observed. */
  sessions: number;
  frames: number;
}

/** Modes in which a permission answer is NOT necessarily a human decision. */
const NON_HUMAN_MODES = new Set(['acceptEdits', 'bypassPermissions', 'dontAsk', 'auto']);

const bump = (m: Record<string, number>, k: string): void => { m[k] = (m[k] ?? 0) + 1; };
const unbump = (m: Record<string, number>, k: string): void => {
  if (!m[k]) return;
  m[k] -= 1;
  if (m[k] === 0) delete m[k];
};

type Json = Record<string, unknown>;
const asObject = (v: unknown): Json | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined;

/** The current value of the `mode` config option in a list of config options, if any. */
function modeFromConfigOptions(options: unknown): string | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const o of options) {
    const opt = asObject(o);
    const value = opt?.['currentValue'];
    if ((opt?.['id'] === MODE_CONFIG || opt?.['category'] === MODE_CONFIG) && typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Correlate permission requests with their answers.
 *
 * The option KIND is not in the response — the response names an `optionId`, and the
 * kinds live in the REQUEST's `options` array. So the outcome is only knowable by
 * remembering the request and joining on the JSON-RPC id. Getting this wrong would be
 * invisible: you would count requests correctly and silently learn nothing about consent.
 *
 * ★ AND THE JOIN IS PER DIRECTION. Each peer numbers its own requests, and both start
 * from the same small integers, so the agent's permission request 5 and the editor's
 * session/prompt 5 can be open at once. A permission request is answered by a result from
 * the EDITOR; the agent's result for the editor's request 5 is something else entirely,
 * and taking it for the answer once dropped the real one.
 */
export function createTally(): { tally: Tally; observer: Observer; finish(): Tally } {
  const tally: Tally = {
    protocolVersion: null,
    permissionRequests: 0,
    offeredKinds: {},
    outcomeByKind: {},
    cancelled: 0,
    unanswered: 0,
    toolCallsByKind: {},
    deniedAlwaysKinds: [],
    standingDenialsOfModeSwitch: 0,
    modeRequests: {},
    modeTimeline: [],
    modeSwitchesMistakableForGrants: [],
    modeSwitchesUnconfirmed: 0,
    standingGrantsByTool: {},
    asksAfterStandingGrant: 0,
    sessions: 0,
    frames: 0,
  };
  /** sessionId -> the mode the agent last said that session is in. */
  const modeOf = new Map<string, string>();
  /** toolKind -> true once an always-scoped GRANT is in force for it (trap a). */
  const standingGrant = new Set<string>();
  /** sessionId -> mode switches answered there that no current_mode_update has confirmed. */
  const awaitingAnnouncement = new Map<string, number>();
  /** sessionId -> answers there whose optionId names a mode, about a call not known to switch
   *  modes, in order: the old agent's ExitPlanMode answers when the call's kind was unseen
   *  (trap b). Held per session, so another session's frames cannot claim or evict them. */
  const modeNamedAnswers = new Map<string, Array<{ optionId: string; kind: string; toolKind: string; grantAdded: boolean }>>();
  /** Option ids that name a mode: the known ones, and any a session's result advertised. */
  const modeIds = new Set(KNOWN_MODE_IDS);
  /** toolCallId -> the kind the agent announced for that call, while the call is open. A
   *  permission request may leave the kind out (the old agent always did, and the
   *  successor does for a JetBrains AIR client), since the editor already holds it. */
  const announcedKind = new Map<string, string>();

  /** Agent's request id -> { optionId -> kind, toolKind, session } for permission requests
   *  awaiting the editor's answer. */
  const pending = new Map<string, { kinds: Map<string, string>; toolKind: string; sessionId: string }>();
  /** Editor's request id -> what it asked, for the requests whose result says something
   *  about the session: its protocol, its start mode, or a mode the editor set. */
  const asked = new Map<string, { method: string; sessionId: string; modeId?: string; announced?: boolean }>();
  const seenSessions = new Set<string>();
  const deniedAlways = new Set<string>();

  const idOf = (f: Frame): string | null =>
    typeof f.id === 'string' || typeof f.id === 'number' ? String(f.id) : null;
  const noteSession = (sid: string): void => {
    if (sid === '' || seenSessions.has(sid)) return;
    seenSessions.add(sid);
    tally.sessions = seenSessions.size;
  };
  /** Record that session `sid` is in `mode`. A session the witness knew nothing about is
   *  taken to have been in `default` for the timeline only, so a start in default is not
   *  listed as a change and a start in anything else is. */
  const enterMode = (sid: string, mode: string): void => {
    const before = modeOf.get(sid) ?? 'default';
    modeOf.set(sid, mode);
    if (mode !== before) tally.modeTimeline.push(mode);
  };

  /** ★ TRAP (b), the old agent's route: a current_mode_update naming the mode an earlier
   *  answer in the same session named as its optionId reclassifies that answer, undoing the
   *  outcome and only the grant it added. The most recent such answer is the one the
   *  announcement follows. Otherwise the announcement confirms a switch already counted. */
  const attributeAnnouncement = (sid: string, mode: string): void => {
    const named = modeNamedAnswers.get(sid);
    const at = named ? named.map(a => a.optionId).lastIndexOf(mode) : -1;
    if (named && at >= 0) {
      const [a] = named.splice(at, 1);
      if (named.length === 0) modeNamedAnswers.delete(sid);
      tally.modeSwitchesMistakableForGrants.push({ optionId: a!.optionId, kind: a!.kind, toolKind: a!.toolKind });
      unbump(tally.outcomeByKind, a!.kind);
      // Undo only the grant this answer added: an earlier one for the same tool stands.
      if (a!.grantAdded) {
        standingGrant.delete(a!.toolKind);
        unbump(tally.standingGrantsByTool, a!.toolKind);
      }
      return;
    }
    const waiting = awaitingAnnouncement.get(sid) ?? 0;
    if (waiting > 1) awaitingAnnouncement.set(sid, waiting - 1);
    else awaitingAnnouncement.delete(sid);
  };

  // ── a permission REQUEST (agent -> editor) ──────────────────────────
  const onPermissionRequest = (f: Frame, id: string | null, sid: string): void => {
    tally.permissionRequests++;
    bump(tally.modeRequests, modeOf.get(sid) ?? UNANNOUNCED_MODE);
    const p = f.params as {
      toolCall?: { kind?: unknown; toolCallId?: unknown };
      options?: ReadonlyArray<{ optionId?: unknown; kind?: unknown }>;
    } | undefined;
    const callId = p?.toolCall?.toolCallId;
    const toolKind = typeof p?.toolCall?.kind === 'string' ? p.toolCall.kind
      : (typeof callId === 'string' ? announcedKind.get(callId) : undefined) ?? 'unknown';
    // A standing grant should stop this tool asking again. If it asks anyway the rule did
    // not stick, and the allow_always total means something different — so it is counted
    // rather than assumed away.
    if (standingGrant.has(toolKind)) tally.asksAfterStandingGrant++;
    const kinds = new Map<string, string>();
    for (const opt of p?.options ?? []) {
      if (typeof opt?.optionId === 'string' && typeof opt?.kind === 'string') {
        kinds.set(opt.optionId, opt.kind);
      }
      // Count the MENU, not the choice. A kind that is never offered can never be
      // chosen by anyone, and a zero that means "impossible" must not be read as a
      // zero that means "declined".
      if (typeof opt?.kind === 'string') bump(tally.offeredKinds, opt.kind);
    }
    if (id !== null) pending.set(id, { kinds, toolKind, sessionId: sid });
  };

  // ── session/update (agent -> editor): modes, and tool calls for variety ─
  const onUpdate = (u: Json | undefined, sid: string): void => {
    // A mode change is a session/update too, discriminated by `sessionUpdate`, and it
    // carries no `kind` — so reading only `kind` silently dropped the one frame that
    // says who is answering from here on.
    if (u?.['sessionUpdate'] === 'current_mode_update') {
      const mode = u['currentModeId'];
      if (typeof mode !== 'string') return;
      // A mode the editor itself is setting in this session is announced as the editor's
      // doing, not as the outcome of an answer: it confirms and reclassifies nothing.
      let editorsOwn = false;
      for (const q of asked.values()) {
        if (q.sessionId === sid && q.modeId !== undefined) { q.announced = true; editorsOwn = true; }
      }
      if (!editorsOwn) attributeAnnouncement(sid, mode);
      enterMode(sid, mode);
      return;
    }
    // The successor follows every mode change with the full config options, the editor's
    // own included. Read for the mode only: it is not an announcement of an answer.
    if (u?.['sessionUpdate'] === 'config_option_update') {
      const mode = modeFromConfigOptions(u['configOptions']);
      if (mode !== undefined) enterMode(sid, mode);
      return;
    }
    const kind = u?.['kind'];
    if (typeof kind === 'string') bump(tally.toolCallsByKind, kind);
    // Remember each open call's kind for a request that names the call without it, and
    // forget it once the call has ended, so a long session does not accumulate them.
    const callId = u?.['toolCallId'];
    if (typeof callId === 'string') {
      if (TERMINAL_STATUSES.has(String(u?.['status']))) announcedKind.delete(callId);
      else if (typeof kind === 'string') announcedKind.set(callId, kind);
    }
  };

  // ── the editor's REQUESTS whose results the witness reads ───────────
  const onEditorRequest = (method: string, id: string, params: Json | undefined, sid: string): void => {
    const modeId = params?.['modeId'];
    const value = params?.['value'];
    if (method === INITIALIZE_METHOD || SESSION_OPENERS.has(method)) {
      asked.set(id, { method, sessionId: sid });
    } else if (method === SET_MODE_METHOD && typeof modeId === 'string') {
      asked.set(id, { method, sessionId: sid, modeId });
    } else if (method === SET_CONFIG_METHOD && params?.['configId'] === MODE_CONFIG && typeof value === 'string') {
      asked.set(id, { method, sessionId: sid, modeId: value });
    }
  };

  // ── the agent's RESULT for one of those requests ────────────────────
  const onAgentResult = (f: Frame, id: string): void => {
    const q = asked.get(id);
    if (!q) return;
    asked.delete(id);
    // An error changed nothing: no session opened, no mode set.
    const r = asObject(f.result);
    if (!r) return;
    if (q.method === INITIALIZE_METHOD) {
      const version = r['protocolVersion'];
      if (typeof version === 'number') tally.protocolVersion = version;
      return;
    }
    if (q.modeId !== undefined) {
      // The options in a set_config_option result are the agent's own word. A set_mode
      // result is empty, so take the mode asked for, unless the agent announced a mode for
      // this session meanwhile (the successor does when auto mode falls back to acceptEdits).
      const mode = modeFromConfigOptions(r['configOptions']) ?? (q.announced ? undefined : q.modeId);
      if (mode !== undefined) enterMode(q.sessionId, mode);
      return;
    }
    const where = SESSION_OPENERS.get(q.method);
    const opened = where === 'result' ? r['sessionId'] : q.sessionId;
    if (typeof opened !== 'string' || opened === '') return;
    noteSession(opened);
    const modes = asObject(r['modes']);
    const available = modes?.['availableModes'];
    if (Array.isArray(available)) {
      for (const m of available) {
        const mid = asObject(m)?.['id'];
        if (typeof mid === 'string') modeIds.add(mid);
      }
    }
    const current = modes?.['currentModeId'];
    const start = typeof current === 'string' ? current : modeFromConfigOptions(r['configOptions']);
    if (start !== undefined) enterMode(opened, start);
  };

  // ── the ANSWER (editor -> agent): a result carrying an outcome ──────
  const onAnswer = (f: Frame, id: string): void => {
    const ctx = pending.get(id);
    if (!ctx || f.result === undefined) return;
    pending.delete(id);

    const outcome = (f.result as { outcome?: { outcome?: unknown; optionId?: unknown } } | undefined)?.outcome;
    if (outcome?.outcome === 'cancelled') { tally.cancelled++; return; }
    if (typeof outcome?.optionId !== 'string') return;
    const optionId = outcome.optionId;
    const sid = ctx.sessionId;

    const kind = ctx.kinds.get(optionId) ?? 'unknown';
    const refused = kind.startsWith('reject');
    // ★ TRAP (b), at the moment of the answer. Allowing a mode-switching call is a mode
    // switch by construction, whatever its label, so it is never counted as an outcome
    // about a tool or as a grant, and nothing that happens before the agent announces the
    // mode can change that. The announcement only confirms it.
    if (ctx.toolKind === SWITCH_MODE_KIND && !refused) {
      tally.modeSwitchesMistakableForGrants.push({ optionId, kind, toolKind: ctx.toolKind });
      awaitingAnnouncement.set(sid, (awaitingAnnouncement.get(sid) ?? 0) + 1);
      return;
    }
    bump(tally.outcomeByKind, kind);
    // "always" is the axis that matters: a once-scoped answer is a UI event, an
    // always-scoped one is a rule the human intends to persist.
    if (refused) {
      if (kind.endsWith('always')) {
        // Refusing a mode switch for good denies no tool: it keeps the session in its mode.
        if (ctx.toolKind === SWITCH_MODE_KIND) tally.standingDenialsOfModeSwitch++;
        else {
          deniedAlways.add(ctx.toolKind);
          tally.deniedAlwaysKinds = [...deniedAlways].sort();
        }
      }
      return;
    }
    // ★ TRAP (a). A standing GRANT is recorded per TOOL, not as a tick in a frequency:
    // the tool stops asking afterwards, so a second one for the same tool cannot occur
    // and the total counts tools placed under a rule, not times you said yes.
    const grantAdded = kind.startsWith('allow') && kind.endsWith('always') && !standingGrant.has(ctx.toolKind);
    if (grantAdded) {
      standingGrant.add(ctx.toolKind);
      bump(tally.standingGrantsByTool, ctx.toolKind);
    }
    // Held, in its own session, for the old agent's route of trap (b).
    if (modeIds.has(optionId)) {
      const list = modeNamedAnswers.get(sid) ?? [];
      list.push({ optionId, kind, toolKind: ctx.toolKind, grantAdded });
      modeNamedAnswers.set(sid, list);
    }
  };

  const observer: Observer = (o: Observation) => {
    tally.frames++;
    const f = o.frame;
    if (!f) return;
    const fromAgent = o.direction === 'agent->editor';
    const params = asObject(f.params);
    const named = params?.['sessionId'];
    const sid = typeof named === 'string' ? named : '';
    noteSession(sid);
    const id = idOf(f);

    if (typeof f.method === 'string') {
      if (fromAgent) {
        if (f.method === PERMISSION_METHOD) onPermissionRequest(f, id, sid);
        else if (f.method === UPDATE_METHOD) onUpdate(asObject(params?.['update']), sid);
      } else if (id !== null) {
        onEditorRequest(f.method, id, params, sid);
      }
      return;
    }
    // A response: to the editor's request when the agent sends it, to the agent's when the
    // editor does.
    if (id === null) return;
    if (fromAgent) onAgentResult(f, id);
    else onAnswer(f, id);
  };

  return {
    tally,
    observer,
    finish(): Tally {
      tally.unanswered = pending.size;
      tally.modeSwitchesUnconfirmed = [...awaitingAnnouncement.values()].reduce((n, v) => n + v, 0);
      return tally;
    },
  };
}

/** Human-readable verdict. States plainly whether the thesis survived. */
export function summarise(t: Tally): string {
  const header = [
    '',
    '─── Editor Witness · increment 0 · nothing was published ───',
    `  frames observed        ${t.frames}`,
    `  sessions               ${t.sessions}`,
    `  protocol               ${t.protocolVersion === null ? '(no initialize answer seen)' : `ACP v${t.protocolVersion}`}`,
  ];
  // ★ A SESSION THIS INSTRUMENT CANNOT READ IS NOT A SESSION WITH NOTHING IN IT. The agent
  // serves the draft ACP v2 to an editor that asks for it. v2 announces no mode and puts a
  // permission request's tool call under `subject`, so every mode switch would read as a
  // grant on "unknown" and every request as unannounced. Printing those numbers would be
  // printing what the instrument failed to see.
  if (t.protocolVersion !== null && t.protocolVersion >= 2) {
    return [...header, '',
      `  VERDICT: NOT MEASURED. The agent answered initialize with ACP v${t.protocolVersion}; this witness`,
      '  reads ACP v1 frames only, so none of its counts describe this session. Set',
      '  CLAUDE_AGENT_ACP_PROTOCOL=v1 in the agent\'s environment (an `env` entry beside',
      '  `command` in the editor\'s agent settings) and run the session again.',
      ''].join('\n');
  }

  const always = Object.entries(t.outcomeByKind)
    .filter(([k]) => k.endsWith('always'))
    .reduce((n, [, v]) => n + v, 0);
  const offeredRejectAlways = (t.offeredKinds['reject_always'] ?? 0) > 0;
  const offeredAllowAlways = (t.offeredKinds['allow_always'] ?? 0) > 0;
  const lines = [
    ...header,
    `  permission requests    ${t.permissionRequests}`,
    `  options OFFERED        ${JSON.stringify(t.offeredKinds)}`,
    `  outcomes by kind       ${JSON.stringify(t.outcomeByKind)}`,
    `  cancelled              ${t.cancelled}`,
    `  unanswered at exit     ${t.unanswered}`,
    `  tool calls by kind     ${JSON.stringify(t.toolCallsByKind)}`,
    `  requests by mode       ${JSON.stringify(t.modeRequests)}`,
    `  standing GRANTS by tool ${JSON.stringify(t.standingGrantsByTool)}`,
    `  mode switches miscounted ${t.modeSwitchesMistakableForGrants.length}`,
    `  mode changes           ${t.modeTimeline.length ? t.modeTimeline.join(' → ') : '(none)'}`,
    `  always-scoped total    ${always}`,
    `  tool kinds ever denied ${t.deniedAlwaysKinds.length ? t.deniedAlwaysKinds.join(', ') : '(none)'}`,
    '',
  ];

  // ★ THREE OUTCOMES, NOT TWO. Zero always-scoped denials is ambiguous on its own:
  // it means "declined" only if the option was ON THE MENU. If the agent never offered
  // reject_always, nobody could have chosen it, and reporting that as evidence against
  // the thesis states a conclusion the run did not earn.
  if (t.permissionRequests === 0) {
    lines.push('  VERDICT: no permission requests at all. Either the agent needed no',
      '  approval for this work, or the editor auto-approves. Not yet informative —',
      '  re-run on work that touches files.');
  } else if (!offeredRejectAlways) {
    lines.push('  VERDICT: UNTESTED — not unsupported. `reject_always` was never OFFERED in',
      `  ${t.permissionRequests} permission request(s), so no human could have chosen it. The`,
      '  standing-constraint thesis has no supply here, but the reason is the AGENT’s menu,',
      '  not the developer’s behaviour — a different finding with a different remedy.',
      offeredAllowAlways
        ? '  Note the asymmetry: `allow_always` WAS offered. This ecosystem lets you make\n'
          + '  trust durable but not distrust — escalation persists, restraint does not.'
        : '  Neither always-scoped kind was offered; every decision here was per-event.');
  } else if (t.deniedAlwaysKinds.length === 0) {
    lines.push('  VERDICT: `reject_always` WAS offered'
      + ` (${t.offeredKinds['reject_always']} time(s)) and never chosen for a tool. On this`,
      '  evidence the standing-constraint thesis is genuinely unsupported: the deny set would',
      '  be empty, so there is nothing for a vertical to subtract and no downward causation.');
  } else {
    lines.push(`  VERDICT: ${t.deniedAlwaysKinds.length} tool kind(s) received a standing denial.`,
      '  A non-empty deny set exists, so increment 1 has something to carry.');
  }
  // A standing refusal of a mode switch is a decision about the session, not about a tool.
  if (t.standingDenialsOfModeSwitch > 0) {
    lines.push('',
      `  NOTE: ${t.standingDenialsOfModeSwitch} reject_always answer(s) refused a MODE SWITCH for good (a`,
      '  switch_mode tool call, such as approving a plan). That keeps the session in its mode',
      '  and denies no tool, so it is not counted in the deny set or the verdict above.');
  }
  // ★ MODE CAVEAT LAST, SO IT IS READ. A verdict about human behaviour is only about
  // human behaviour in the modes where a human is the one answering.
  const autoRequests = Object.entries(t.modeRequests)
    .filter(([m]) => NON_HUMAN_MODES.has(m))
    .reduce((n, [, v]) => n + v, 0);
  if (autoRequests > 0) {
    lines.push('',
      `  ⚠ ${autoRequests} of ${t.permissionRequests} request(s) arose in a mode where the AGENT or a`,
      '  classifier answers, not the developer — so those outcomes are not consent data.',
      '  Read the by-mode breakdown above before quoting any number from this run.');
  }
  const unannounced = t.modeRequests[UNANNOUNCED_MODE] ?? 0;
  if (unannounced > 0) {
    lines.push('',
      `  ⚠ ${unannounced} of ${t.permissionRequests} request(s) came from a session whose mode the agent never`,
      '  stated: no session/new, load, resume or fork result for it, and no mode update. Whether',
      '  a person or the agent answered them is unknown; they are not assumed to be `default`.');
  }

  // ★ Trap (a): say what the allow_always number IS, next to it, not in a source comment.
  const grantedTools = Object.keys(t.standingGrantsByTool).length;
  if (grantedTools > 0 || (t.outcomeByKind['allow_always'] ?? 0) > 0) {
    lines.push('',
      '  NOTE on allow_always: a standing grant stops that tool asking again, so this is',
      `  ${grantedTools} TOOL(S) placed under a rule — not a count of how often you allowed.`,
      '  Grant early and every later use is invisible; grant late and the asks were counted',
      '  first. Read as a rate it is not noisy, it is inverted.');
    if (t.asksAfterStandingGrant > 0) {
      lines.push(`  ⚠ ${t.asksAfterStandingGrant} ask(s) arrived for a tool already granted —`,
        '  the rule did not stick, so the count is closer to a frequency after all.');
    }
  }

  // ★ Trap (b): a mode switch wearing an allow_always (or allow_once) label.
  if (t.modeSwitchesMistakableForGrants.length > 0) {
    const ids = [...new Set(t.modeSwitchesMistakableForGrants.map(m => m.optionId))].join(', ');
    const labelledAlways = t.modeSwitchesMistakableForGrants.filter(m => m.kind === 'allow_always').length;
    lines.push('',
      `  NOTE: ${t.modeSwitchesMistakableForGrants.length} answer(s) were SESSION MODE SWITCHES (${ids}), not decisions`,
      `  about the tool being asked about; ${labelledAlways} of them were labelled allow_always. They are`,
      '  not in the outcome counts: each allowed a tool call of kind switch_mode, which changes',
      '  the session\'s mode and grants nothing, or named the mode the agent then announced in',
      '  that session — observed on the wire, not inferred from a vendor list.');
    if (t.modeSwitchesUnconfirmed > 0) {
      lines.push(`  ⚠ ${t.modeSwitchesUnconfirmed} of them the agent never followed with a mode update, so the mode`,
        '  their session went on in is unknown; its later requests stay under the mode last seen.');
    }
  }

  lines.push('');
  return lines.join('\n');
}
