#!/usr/bin/env tsx
/**
 * The reject-always probe: put the missing button on the menu, and see if it gets used.
 *
 * ★ WHY THIS IS A SEPARATE ADAPTER AND NOT PART OF THE WITNESS.
 *
 * The Editor Witness has exactly one invariant: it is INVISIBLE. Every frame is forwarded
 * unmodified, unparsable frames included, because an observer that edits the stream is not
 * an observer. This program does the opposite on purpose — it rewrites permission menus.
 * Putting it in the same file would make that invariant untrue and unenforceable, so it
 * lives beside the witness rather than inside it. Run them together; they compose:
 *
 *     editor  <->  witness (measures)  <->  probe (modifies)  <->  real agent
 *
 * The witness sits nearer the editor so it observes the menu the human actually SAW,
 * including the injected option, and the answer the human actually gave.
 *
 * ★ WHAT IT IS FOR. Increment 0 established that `reject_always` is never offered: the
 * production ACP agent constructs allow_always / allow_once / reject_once and nothing else,
 * so the deny set is empty for structural reasons and no amount of watching real work can
 * say what a developer WOULD do. You cannot measure a choice nobody is given. This supplies
 * the choice.
 *
 * ★ WHY IT MUST ALSO ENFORCE, NOT JUST OFFER.
 *
 * A button labelled "reject always" that asks again next time is a lie, and a developer
 * would learn within minutes not to trust it — poisoning the very behaviour being measured.
 * So when the option is chosen this process records a standing rule and auto-denies later
 * requests for the same tool itself, without troubling the human. That is what makes the
 * offer real, and it is also a faithful preview of what increment 1 would do with a
 * published constraint.
 *
 * ★ THE STANDING RULE IS KEYED ON toolName, NOT toolCall.kind.
 *
 * `kind` is a ~6-valued enum (read/edit/execute/…) shared by many tools; denying "execute"
 * forever because you refused one command would be absurd. The agent's own persisted rules
 * key on toolName ("Bash", "Edit"), and so does this.
 *
 * PRIVACY: like the witness, this publishes nothing. Rules and counters are in memory; the
 * optional --json file is local. Nothing about prompts, paths or diffs leaves the machine.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { LineSplitter } from '../../editor-witness/src/transport.js';

// Frame tracing is ON while the instrument itself is being debugged; PROBE_TRACE=0
// silences it. Method names only, never params.
const TRACE = process.env['PROBE_TRACE'] !== '0';
const TRACE_CAP = 80;
let traced = 0;

const REJECT_ALWAYS_ID = 'iep_reject_always';
const PERMISSION_METHOD = 'session/request_permission';

interface PermOption { optionId?: unknown; kind?: unknown; name?: unknown }
interface Frame {
  id?: unknown;
  method?: unknown;
  params?: { toolCall?: { kind?: unknown; title?: unknown }; options?: PermOption[]; [k: string]: unknown };
  result?: { outcome?: { outcome?: unknown; optionId?: unknown } };
  [k: string]: unknown;
}

function parseArgv(argv: readonly string[]): { jsonOut?: string; cmd: string[] } {
  const dash = argv.indexOf('--');
  const flags = dash === -1 ? argv : argv.slice(0, dash);
  const cmd = dash === -1 ? [] : argv.slice(dash + 1);
  const j = flags.indexOf('--json');
  return { ...(j !== -1 && flags[j + 1] ? { jsonOut: flags[j + 1] } : {}), cmd };
}

const { jsonOut, cmd } = parseArgv(process.argv.slice(2));
if (cmd.length === 0) {
  process.stderr.write(
    'reject-always-probe: give the agent command after `--`.\n'
    + '  e.g. tsx src/inject.ts -- node <sdk>/dist/examples/agent.js\n');
  process.exit(2);
}

// stderr only: stdout IS the protocol channel.
const note = (s: string): void => { process.stderr.write(s + '\n'); };

const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'] });
child.on('error', (e) => { note(`[probe] could not start agent: ${e.message}`); process.exit(1); });

/** toolName -> the standing deny the human authored. */
const standing = new Map<string, { at: number; toolKind: string }>();
/** requestId -> the toolName it concerned, so the answer can be attributed. */
const pending = new Map<string, { toolName: string; toolKind: string }>();
/** requestId -> when we forwarded it, so the answer's latency is visible. A human takes
 *  seconds; an editor answering from policy takes milliseconds. That gap is the tell. */
const askedAtMs = new Map<string, number>();

const tally = {
  requestsSeen: 0,
  menusAugmented: 0,
  rejectAlwaysChosen: 0,
  standingRules: [] as string[],
  autoDeniedByStandingRule: 0,
  autoDeniedByTool: {} as Record<string, number>,
  otherOutcomes: {} as Record<string, number>,
  /** reject_always answers arriving too fast to be human — the client's policy, not consent. */
  machineSpeedRejectAlways: 0,
};

/**
 * The tool's stable name. ACP puts the human-facing title on toolCall.title; the agent's own
 * rules key on the tool NAME, which claude-code-acp surfaces in _meta when it is available.
 * Falling back to the title is imperfect but still far finer-grained than `kind`.
 */
function toolNameOf(p: Frame['params']): string {
  const meta = (p as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const fromMeta = meta && typeof meta === 'object'
    ? (meta as Record<string, unknown>)['toolName'] ?? (meta as Record<string, unknown>)['tool_name']
    : undefined;
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  // ★ The title fallback needs cleaning, not just splitting. `_meta.toolName` gives a real
  // name ("Edit") when the agent supplies it, but for a shell tool it is often absent and
  // the title is the COMMAND — so the naive first-word split produced a rule keyed on
  // "`echo", complete with the backtick. That reads as a bug in the prompt ("Reject always
  // (`echo)") and scopes the rule to a token the developer never chose.
  const t = p?.toolCall?.title;
  if (typeof t === 'string' && t) {
    const head = t.split(/[\s(]/)[0] ?? t;
    const cleaned = head.replace(/^[`'"*_~\-\[(]+|[`'"*_~\-\])]+$/g, '');
    if (cleaned) return cleaned;
  }
  const k = p?.toolCall?.kind;
  return typeof k === 'string' ? `kind:${k}` : 'unknown';
}

const send = (w: NodeJS.WritableStream, o: unknown): void => { w.write(JSON.stringify(o) + '\n'); };

// ── agent -> editor ────────────────────────────────────────────────────────
// Augment permission menus; auto-answer anything already under a standing deny.
const fromAgent = new LineSplitter();
child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  for (const line of fromAgent.push(chunk)) handleFromAgent(line);
});
child.stdout.on('end', () => {
  for (const line of fromAgent.flush()) handleFromAgent(line);
  finish();
});

function handleFromAgent(line: string): void {
  let f: Frame | null = null;
  try { const v: unknown = JSON.parse(line); if (v && typeof v === 'object') f = v as Frame; } catch { /* forward as-is */ }

  // ★ Trace what the agent actually asks the editor to do. Diagnosing "it said it wrote
  // the file but the file is not there" needs to separate a tool that never ran from one
  // the EDITOR was asked to run and did not. Method names ONLY — never params, which carry
  // prompts, paths and file contents. Capped so a long session cannot flood the log.
  if (TRACE && f?.method && traced < TRACE_CAP) {
    traced += 1;
    note(`[probe] frame agent->editor: ${String(f.method)}`);
    if (traced === TRACE_CAP) note('[probe] frame trace cap reached; further frames not logged');
  }

  if (!f || f.method !== PERMISSION_METHOD) { process.stdout.write(line + '\n'); return; }

  tally.requestsSeen += 1;
  const p = f.params;
  const toolName = toolNameOf(p);
  const toolKind = typeof p?.toolCall?.kind === 'string' ? p.toolCall.kind : 'unknown';

  // ── already denied forever: answer it ourselves, do not ask again ──
  const rule = standing.get(toolName);
  if (rule) {
    const options = Array.isArray(p?.options) ? p!.options : [];
    const reject = options.find(o => o.kind === 'reject_once') ?? options[options.length - 1];
    if (reject && typeof reject.optionId === 'string') {
      tally.autoDeniedByStandingRule += 1;
      tally.autoDeniedByTool[toolName] = (tally.autoDeniedByTool[toolName] ?? 0) + 1;
      note(`[probe] standing deny on "${toolName}" — auto-rejected without asking (${tally.autoDeniedByTool[toolName]}x)`);
      send(child.stdin, { jsonrpc: '2.0', id: f.id, result: { outcome: { outcome: 'selected', optionId: reject.optionId } } });
      return; // never reaches the editor: that is what "always" means
    }
    // No reject option to translate into — fall through and ask, rather than invent one.
    note(`[probe] standing deny on "${toolName}" but the agent offered no reject option; asking anyway`);
  }

  // ── add the missing option, unless the agent already offers it ──
  const options = Array.isArray(p?.options) ? [...p!.options] : [];
  if (!options.some(o => o.kind === 'reject_always')) {
    options.push({ optionId: REJECT_ALWAYS_ID, kind: 'reject_always', name: `Reject always (${toolName})` });
    tally.menusAugmented += 1;
  }
  if (typeof f.id === 'string' || typeof f.id === 'number') {
    pending.set(String(f.id), { toolName, toolKind });
  }
  // ★ Announce every request as it happens. The tally only lands when the thread ends,
  // which is useless while diagnosing "it never asked me": the question is whether the
  // AGENT failed to ask or the EDITOR answered silently, and those look identical from the
  // UI. With this line in the editor's log, an ask with no visible prompt is provably the
  // editor auto-answering — and the round-trip time below says how fast.
  const offeredKinds = options.map(o => String(o.kind));
  note(`[probe] ASK #${tally.requestsSeen} tool="${toolName}" kind=${toolKind} offered=[${offeredKinds.join(', ')}]`);
  askedAtMs.set(String(f.id), Date.now());
  // Re-serialised deliberately — this frame is being CHANGED. Every other frame above is
  // forwarded as its original text.
  send(process.stdout, { ...f, params: { ...p, options } });
}

// ── editor -> agent ────────────────────────────────────────────────────────
// Intercept a reject_always answer: record the rule, and translate it into something the
// agent understands, because the agent has never heard of reject_always.
const fromEditor = new LineSplitter();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  for (const line of fromEditor.push(chunk)) handleFromEditor(line);
});
process.stdin.on('end', () => {
  for (const line of fromEditor.flush()) handleFromEditor(line);
  child.stdin.end();
});

function handleFromEditor(line: string): void {
  let f: Frame | null = null;
  try { const v: unknown = JSON.parse(line); if (v && typeof v === 'object') f = v as Frame; } catch { /* forward */ }

  const id = f && (typeof f.id === 'string' || typeof f.id === 'number') ? String(f.id) : null;
  const ctx = id ? pending.get(id) : undefined;
  const outcome = f?.result?.outcome;

  if (!ctx || !outcome || typeof outcome.optionId !== 'string') {
    child.stdin.write(line + '\n');
    return;
  }
  pending.delete(id!);

  const waited = askedAtMs.has(id!) ? Date.now() - askedAtMs.get(id!)! : -1;
  askedAtMs.delete(id!);
  note(`[probe] ANSWER "${outcome.optionId}" after ${waited}ms`
    + (waited >= 0 && waited < 250 ? '  <- too fast for a human: the EDITOR answered, not you' : ''));

  if (outcome.optionId !== REJECT_ALWAYS_ID) {
    tally.otherOutcomes[outcome.optionId] = (tally.otherOutcomes[outcome.optionId] ?? 0) + 1;
    child.stdin.write(line + '\n');
    return;
  }

  // ★ A MACHINE-SPEED ANSWER IS NOT CONSENT, AND MUST NOT AUTHOR A STANDING RULE.
  //
  // This program APPENDS an option to a menu, which changes what a client that answers by
  // position selects. If the editor auto-answers from policy it can land on the injected
  // option, and the probe would then record a standing denial the developer never made —
  // and silently auto-deny that tool for the rest of the session, while the agent narrates
  // the failed calls as successes. Observed exactly that: a run where no prompt appeared,
  // no file was written, and the agent reported "Done".
  //
  // A standing constraint is a claim about a PERSON's intent. So a reject_always that came
  // back faster than a human could read the prompt is honoured ONCE and never persisted,
  // and it is reported loudly rather than counted.
  const HUMAN_FLOOR_MS = 250;
  if (waited >= 0 && waited < HUMAN_FLOOR_MS) {
    tally.machineSpeedRejectAlways += 1;
    note(`[probe] IGNORING reject_always for "${ctx.toolName}" — answered in ${waited}ms, `
      + 'far too fast for a human. The CLIENT chose it, probably by position because this '
      + 'probe appends an option. Honouring it once; NOT authoring a standing rule.');
    send(child.stdin, { jsonrpc: '2.0', id: f!.id, result: { outcome: { outcome: 'selected', optionId: 'reject' } } });
    return;
  }

  // ★ THE EVENT THIS WHOLE PROGRAM EXISTS TO OBSERVE.
  tally.rejectAlwaysChosen += 1;
  standing.set(ctx.toolName, { at: tally.requestsSeen, toolKind: ctx.toolKind });
  tally.standingRules = [...standing.keys()].sort();
  note(`[probe] ★ STANDING DENY authored for "${ctx.toolName}" — it will not be asked again`);

  // The agent cannot be sent an optionId it never offered. Translate to its own reject.
  send(child.stdin, { jsonrpc: '2.0', id: f!.id, result: { outcome: { outcome: 'selected', optionId: 'reject' } } });
}

let finished = false;
function finish(): void {
  if (finished) return;
  finished = true;
  const lines = [
    '',
    '─── reject-always probe · nothing was published ───',
    `  permission requests seen     ${tally.requestsSeen}`,
    `  menus given the extra option ${tally.menusAugmented}`,
    `  ★ reject_always chosen       ${tally.rejectAlwaysChosen}`,
    `  standing rules authored      ${tally.standingRules.length ? tally.standingRules.join(', ') : '(none)'}`,
    `  later asks auto-denied       ${tally.autoDeniedByStandingRule} ${JSON.stringify(tally.autoDeniedByTool)}`,
    `  other outcomes               ${JSON.stringify(tally.otherOutcomes)}`,
    '',
  ];
  if (tally.menusAugmented === 0) {
    lines.push('  No menu was augmented — either no permission was requested, or the agent',
      '  already offers reject_always (in which case use the witness alone).');
  } else if (tally.rejectAlwaysChosen === 0) {
    lines.push('  RESULT: the option was OFFERED and never taken. That is a real negative:',
      '  unlike increment 0, the developer could have chosen it and did not.');
  } else {
    lines.push(`  RESULT: ${tally.rejectAlwaysChosen} standing denial(s) authored across`,
      `  ${tally.standingRules.length} tool(s), suppressing ${tally.autoDeniedByStandingRule} later ask(s).`,
      '  The deny set is NOT empty when the button exists — increment 1 has an input.');
  }
  lines.push('');
  note(lines.join('\n'));
  if (jsonOut) {
    try { writeFileSync(jsonOut, JSON.stringify(tally, null, 2)); note(`[probe] tally -> ${jsonOut}`); }
    catch (e) { note(`[probe] could not write ${jsonOut}: ${(e as Error).message}`); }
  }
}

child.on('exit', () => { const t = setTimeout(() => { finish(); process.exit(0); }, 3000); t.unref?.(); });
process.on('SIGINT', () => { finish(); process.exit(0); });
process.on('SIGTERM', () => { finish(); process.exit(0); });

note('[probe] offering reject_always on every permission request; publishing nothing');
note(`[probe] agent: ${cmd.join(' ')}`);
