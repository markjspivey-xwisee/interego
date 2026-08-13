/**
 * A NORMAL AGENT, BEHIND A BOUNDARY — NOT AN AGENT WITH ITS HANDS CUT OFF.
 *
 * ── THE MISTAKE THIS REPLACES ────────────────────────────────────────────────
 *
 * The delegate shipped with every built-in DENIED: no Bash, no Read, no Write, one MCP server. It
 * is safe in the way a brick is safe. Asked to convert a drawing it could not, asked to look at a
 * file it could not, and the whole design went looking for capabilities to hand it one at a time.
 *
 * What is wanted is an ORDINARY Claude Code agent — the one you would get by starting a session
 * yourself — with a boundary around it, so that somebody typing in a Discord channel cannot get
 * free rein over the machine it runs on. That is a permission problem, and permission systems
 * have a shape: default posture, a sandbox, hard limits that are never negotiable, and a human
 * who can be asked.
 *
 * ── THE MECHANISM, MEASURED ──────────────────────────────────────────────────
 *
 * `probe-permission-gate.ts` established the three facts this file depends on, because a
 * permission system that is assumed rather than measured is not one:
 *
 *   · a `PreToolUse` hook FIRES in headless `-p` mode                        — measured
 *   · it receives the full tool call on stdin                                — measured
 *   · returning `permissionDecision: 'deny'` genuinely STOPS the tool        — measured
 *
 * The first attempt to measure it reported "no hook, and Bash ran anyway", which would have said
 * this design was impossible. That was a broken nested-quote command in the probe, not the CLI.
 *
 * ── THE FOUR ANSWERS ─────────────────────────────────────────────────────────
 *
 * `decide` returns one of four things, and the ORDER matters more than any individual rule:
 *
 *   1. `deny`   — never askable. Credential stores, the app's own config, the delegate keys. There
 *                 is no phrasing of a channel message that should reach these, so they are not put
 *                 to a human at all: an approval dialog for "read your private keys" is a phishing
 *                 surface, not a safeguard.
 *   2. `allow`  — inside the agent's own workspace, or a directory its human nominated. This is
 *                 the ordinary case and it must be genuinely ordinary, or the agent is useless.
 *   3. `granted`— matched a standing grant the human gave earlier. This is what makes the whole
 *                 thing usable: you approve `npm test` in your project once, not every turn.
 *   4. `ask`    — everything else. The turn does NOT hang waiting: a subprocess cannot block for
 *                 hours, and a channel is not a modal dialog. It is refused for now, the request
 *                 is recorded, and the human is told wherever they are. Approving writes a grant,
 *                 and the NEXT attempt goes straight through.
 *
 * ★ REFUSING NOW AND ASKING ANYWAY IS THE WHOLE TRICK. It is what lets the permission outlive the
 * turn. The agent gets a refusal it can explain — "I asked Mark whether I may run that" — instead
 * of a timeout, which is what a person actually saw when the old blanket denial met a real task.
 *
 * ── ★★ WHAT THIS IS NOT: IT IS A GUARDRAIL, NOT A SANDBOX ────────────────────
 *
 * MEASURED against the built gate, and it decides how far anything here may be trusted:
 *
 *   deny   `cat ~/.ssh/id_rsa`                          — named outright
 *   ALLOW  `node steal.js`, from a script it just wrote in its own workspace
 *
 * The second line is the whole limitation. This judges what a command NAMES; a child process it
 * starts is not a tool call, reaches no hook, and inherits the user's full rights. Writing a file
 * into its own workspace is ordinary and allowed — it has to be, or the agent cannot convert an
 * image or run a build — and executing one is the same. So anything able to get the agent to write
 * and run code is past every rule in this file.
 *
 * ★ AND TWO OTHER PROBE CASES WERE REFUSED FOR THE WRONG REASON, which is why the line above is
 * stated so flatly. A `node -e` that assembled a credential path at runtime was denied — because
 * the word `ssh` appeared inside a quoted string and tripped {@link EGRESS}. An exfiltrating
 * `fetch` was denied because `//example.com` looked path-shaped. Neither refusal came from
 * reasoning about reach, and a check that passes for the wrong reason is evidence for nothing.
 *
 * So the honest claim is the narrow one: this stops an agent being STEERED, in plain terms, into
 * doing something out of bounds — the realistic failure when a stranger in a channel can type at
 * it. It does not contain an agent that is trying, or one that has been manipulated into
 * assembling its own way out. Containing that needs the OS: a restricted token, a separate
 * low-privilege account, or a container — none of which is here.
 *
 * Do not add a rule to this file and conclude the escape is closed. The escape is structural, and
 * the tests in `tests/workspace-desktop-permission.test.ts` PIN it open on purpose so that nobody
 * reads a growing list of clever regexes as a boundary it never was.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';

/** What a hook is being asked about. Mirrors the PreToolUse payload the CLI writes to stdin. */
export interface ToolCall {
  readonly tool: string;
  /** The tool's own arguments, as the CLI passes them. Shapes differ per tool. */
  readonly input: Readonly<Record<string, unknown>>;
}

export type Decision =
  | { readonly kind: 'allow'; readonly why: string }
  | { readonly kind: 'granted'; readonly why: string; readonly rule: string }
  | { readonly kind: 'deny'; readonly why: string }
  | { readonly kind: 'ask'; readonly why: string; readonly rule: string; readonly what: string };

/** A standing grant a human gave. `rule` is what {@link ruleFor} produced when they were asked. */
export interface Grant {
  readonly rule: string;
  /** Free text, shown when the grants are listed so a person can tell what they agreed to. */
  readonly what: string;
  readonly grantedIso: string;
}

export interface Policy {
  /** The agent's own directory. Always writable, always readable, created if absent. */
  readonly workspace: string;
  /** Directories the human nominated. Same posture as the workspace inside them. */
  readonly nominated: readonly string[];
  /** Standing grants, by rule. */
  readonly grants: readonly Grant[];
}

/**
 * Paths no agent reaches, whatever anybody approves.
 *
 * ★ THESE ARE NOT ASKABLE AND THAT IS DELIBERATE. Everything here is a credential, a key, or the
 * configuration that decides what the agent itself may do. A dialog saying "Claude Desktop wants
 * to read .interego/relay-token.txt — allow?" is not a safeguard; it is a phishing prompt with the
 * app's own branding on it, arriving because a stranger typed something in a channel. The only
 * correct answer is one nobody is asked for.
 *
 * ★ AND THE AGENT'S OWN GRANTS ARE ON THE LIST, so an agent cannot widen its own boundary by
 * editing the file that describes it.
 */
const NEVER = [
  '.interego',            // relay tokens, the maintainer key, railway credentials
  '.ssh',
  '.aws',
  '.config/gh',
  '.claude/.credentials.json',
  'AppData/Roaming/@interego',      // this app's own store: delegate private keys
  'AppData/Roaming/npm/etc',
  'interego-agent-grants.json',
];

/** Command fragments that are never run, for the same reason the paths above are never read. */
const NEVER_RUN = [
  /\brm\s+-rf\s+[/~]/i,
  /\bmkfs\b/i,
  /\b(shutdown|reboot)\b/i,
  /\bcurl\b[^|]*\|\s*(ba)?sh/i,     // pipe-to-shell, whatever the URL
  /\bwget\b[^|]*\|\s*(ba)?sh/i,
  /\bgit\s+push\b/i,                // publishing under the human's credential
  /\bnpm\s+publish\b/i,
];

/** Tools that read or write the filesystem, and the argument each one names a path in. */
const PATH_ARG: Readonly<Record<string, string>> = {
  Read: 'file_path', Write: 'file_path', Edit: 'file_path', NotebookEdit: 'notebook_path',
  Glob: 'path', Grep: 'path',
};

/** True when `p` is inside `root` — resolved, so `..` cannot walk out of it. */
export function inside(root: string, p: string): boolean {
  const r = resolve(root);
  const t = resolve(p);
  if (r === t) return true;
  const rel = relative(r, t);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** True when the path touches something on the never list, wherever it sits. */
export function forbiddenPath(p: string): boolean {
  const norm = normalize(resolve(p)).split(sep).join('/');
  const home = normalize(homedir()).split(sep).join('/');
  return NEVER.some((n) => {
    const abs = n.startsWith('AppData') ? home + '/' + n : null;
    return norm.includes('/' + n) || norm.endsWith('/' + n) || (abs !== null && norm.startsWith(abs));
  });
}

/**
 * Whether a shell command stays inside the agent's own ground.
 *
 * ★ THIS IS THE RULE THAT DECIDES WHETHER THE AGENT IS USABLE AT ALL. The first version had no
 * case for Bash, so every command fell through to "ask" — and MEASURED, a gated agent asked to run
 * `echo INSIDE > made.txt` in its OWN workspace replied "I've requested permission". That is the
 * blanket denial it replaced, wearing a politer sentence. An agent that must ask before echoing a
 * word into its own directory is not a normal agent.
 *
 * ★ AND BASH CANNOT BE BLANKET-ALLOWED JUST BECAUSE THE CWD IS SAFE. `cat ~/.ssh/id_rsa` is a
 * shell command like any other; the working directory constrains RELATIVE paths and nothing else.
 * So the test is on what the command NAMES:
 *
 *   · an absolute path, or one climbing out with `..`, must land inside a permitted root
 *   · nothing that reaches the network — that is how a channel-driven agent exfiltrates, and it is
 *     worth an explicit question every time rather than a blanket yes
 *
 * Everything else — `echo`, `cat`, `node`, `npm test`, `git status`, a pipeline of them — runs.
 * Chaining with `&&` is ordinary and is not itself suspicious; what the chained commands NAME is
 * what matters, and each is checked.
 *
 * ★ PARSING A SHELL WITH A REGEX IS APPROXIMATE, AND THE APPROXIMATION IS DELIBERATELY ONE-SIDED.
 * A path this misses lands in "ask", never in "allow": the fallback of the whole function is the
 * human. That is the only direction in which being wrong is survivable.
 */

/** Reaching the network is always its own question. */
const EGRESS = /\b(curl|wget|nc|ncat|telnet|ssh|scp|sftp|rsync|ftp)\b/i;

/** Anything that looks like a filesystem path, absolute or climbing. */
const PATHISH = /(?:[A-Za-z]:[\\/]|\/|\.\.[\\/])[^\s'"|;&<>()]*/g;

export function bashStaysInside(command: string, roots: readonly string[]): boolean {
  if (EGRESS.test(command)) return false;
  const named = command.match(PATHISH) ?? [];
  for (const raw of named) {
    // A bare `/` or a flag like `-/` is not a path anybody is reading; skip what cannot resolve.
    const p = raw.replace(/["']/g, '');
    if (p.length < 2) continue;
    if (!roots.some((r) => inside(r, p))) return false;
  }
  return true;
}

/**
 * The rule a grant would be written as.
 *
 * ★ COARSER THAN THE CALL, ON PURPOSE. A grant keyed to the exact command would have to be given
 * again for `npm test -- --watch`, and a person asked the same question twenty times stops reading
 * it. Keyed to the tool and the FIRST WORD of a command — or the directory of a path — one answer
 * covers the thing they actually meant to permit.
 *
 * ★ AND NEVER TO THE WHOLE TOOL. `Bash` as a rule would turn one approval of `ls` into permission
 * to run anything, which is the failure this whole file exists to prevent.
 */
export function ruleFor(call: ToolCall): string {
  if (call.tool === 'Bash') {
    const cmd = String(call.input['command'] ?? '').trim();
    const head = cmd.split(/\s+/).slice(0, 2).join(' ') || '(empty)';
    return 'Bash(' + head + ' …)';
  }
  const arg = PATH_ARG[call.tool];
  if (arg) {
    const p = String(call.input[arg] ?? '');
    const dir = p ? resolve(p).split(sep).slice(0, -1).join('/') : '(none)';
    return call.tool + '(' + dir + '/…)';
  }
  return call.tool;
}

/** A short human sentence describing what is being asked for. */
export function describeCall(call: ToolCall): string {
  if (call.tool === 'Bash') return 'run `' + String(call.input['command'] ?? '').slice(0, 160) + '`';
  const arg = PATH_ARG[call.tool];
  if (arg) return (call.tool === 'Read' || call.tool === 'Glob' || call.tool === 'Grep' ? 'read ' : 'write ')
    + String(call.input[arg] ?? '');
  if (call.tool === 'WebFetch') return 'fetch ' + String(call.input['url'] ?? '');
  return 'use ' + call.tool;
}

/**
 * ★ THE ORDER IS THE POLICY. Hard denials are checked before anything can allow, standing grants
 * before anything can ask, and "ask" is the default — so a tool nobody thought about when this was
 * written arrives at the human rather than at the machine.
 */
export function decide(call: ToolCall, policy: Policy): Decision {
  // 1 · never, whatever anyone says.
  const arg = PATH_ARG[call.tool];
  if (arg) {
    const p = String(call.input[arg] ?? '');
    if (p && forbiddenPath(p)) {
      return { kind: 'deny', why: 'that path holds credentials or this app\'s own configuration, and no agent reaches it — this is not something you can approve' };
    }
  }
  if (call.tool === 'Bash') {
    const cmd = String(call.input['command'] ?? '');
    if (NEVER_RUN.some((rx) => rx.test(cmd))) {
      return { kind: 'deny', why: 'that command is on the never-run list (destructive, or it would publish under your credential) — this is not something you can approve' };
    }
    // A shell command can name any path, and reading it out of a command line is guesswork. So a
    // command that MENTIONS a forbidden path is refused even when the parse is uncertain: the
    // cost of a false refusal is one message, and of a false allow is a credential.
    if (NEVER.some((n) => cmd.includes(n))) {
      return { kind: 'deny', why: 'that command names a path holding credentials or this app\'s configuration' };
    }
  }

  // 2 · inside its own workspace, or somewhere its human nominated.
  const roots = [policy.workspace, ...policy.nominated];
  if (call.tool === 'Bash' && bashStaysInside(String(call.input['command'] ?? ''), roots)) {
    return { kind: 'allow', why: 'it names nothing outside its workspace and does not reach the network' };
  }
  if (arg) {
    const p = String(call.input[arg] ?? '');
    if (p && roots.some((r) => inside(r, p))) {
      return { kind: 'allow', why: 'inside ' + (inside(policy.workspace, p) ? 'its own workspace' : 'a directory you nominated') };
    }
  }

  // 3 · a standing grant.
  const rule = ruleFor(call);
  const held = policy.grants.find((g) => g.rule === rule);
  if (held) return { kind: 'granted', why: 'you approved this on ' + held.grantedIso.slice(0, 10), rule };

  // 4 · ask. Refused for now; the request outlives the turn.
  return { kind: 'ask', why: 'this is outside its workspace and you have not approved it', rule, what: describeCall(call) };
}

// ── where the policy lives ───────────────────────────────────────────────────

/**
 * ★ THE GRANTS ARE LOCAL, BECAUSE THE ENFORCEMENT IS LOCAL. The hook runs on this machine, in
 * front of a tool that acts on this machine, and a decision that had to cross the network to be
 * read would fail open exactly when the network did.
 *
 * Publishing them to the delegator's pod — so the boundary is auditable and revocable the way a
 * delegation is — is the natural next step and is NOT done here. Saying so plainly: what is
 * written below is a local file, and a second machine running the same delegate has its own.
 */
export function grantsPath(userData: string): string {
  return join(userData, 'interego-agent-grants.json');
}

/**
 * The stored half of the policy — what a person nominated and approved — with no agent involved.
 *
 * ★ SEPARATE FROM {@link readPolicy} BECAUSE THAT ONE CREATES A DIRECTORY. It takes an agent id
 * and mkdirs that agent's workspace, which is right when a turn is starting and wrong everywhere
 * else. MEASURED: the permission panel called it with the id `'listing'` to show what had been
 * granted, and produced `agent-workspaces/listing/` — a folder named after a UI action, appearing
 * among the real agents' workspaces, recreated every ten seconds by a poll. Reading what you
 * permitted should not invent an agent.
 */
export function readSettings(userData: string): { readonly nominated: readonly string[]; readonly grants: readonly Grant[] } {
  const p = grantsPath(userData);
  let stored: { nominated?: string[]; grants?: Grant[] } = {};
  if (existsSync(p)) {
    try { stored = JSON.parse(readFileSync(p, 'utf8')) as typeof stored; } catch { stored = {}; }
  }
  return {
    nominated: (stored.nominated ?? []).filter((d) => typeof d === 'string'),
    grants: (stored.grants ?? []).filter((g) => typeof g?.rule === 'string'),
  };
}

export function readPolicy(userData: string, agentId: string): Policy {
  const workspace = join(userData, 'agent-workspaces', agentId.replace(/[^a-zA-Z0-9-]/g, '_'));
  mkdirSync(workspace, { recursive: true });
  return { workspace, ...readSettings(userData) };
}

export function writeGrant(userData: string, grant: Grant): void {
  const p = grantsPath(userData);
  let stored: { nominated?: string[]; grants?: Grant[] } = {};
  if (existsSync(p)) {
    try { stored = JSON.parse(readFileSync(p, 'utf8')) as typeof stored; } catch { stored = {}; }
  }
  const grants = (stored.grants ?? []).filter((g) => g.rule !== grant.rule);
  grants.push(grant);
  writeFileSync(p, JSON.stringify({ ...stored, grants }, null, 2), { mode: 0o600, encoding: 'utf8' });
}

/** A stable id for one pending request, so the app and the hook name the same thing. */
export function requestId(call: ToolCall): string {
  return createHash('sha256').update(call.tool + '' + JSON.stringify(call.input)).digest('hex').slice(0, 16);
}

/** Withdraw a standing grant. What was permitted goes back to being asked about. */
export function revokeGrant(userData: string, rule: string): void {
  const p = grantsPath(userData);
  if (!existsSync(p)) return;
  let stored: { nominated?: string[]; grants?: Grant[] } = {};
  try { stored = JSON.parse(readFileSync(p, 'utf8')) as typeof stored; } catch { return; }
  writeFileSync(p, JSON.stringify({ ...stored, grants: (stored.grants ?? []).filter((g) => g.rule !== rule) }, null, 2),
    { mode: 0o600, encoding: 'utf8' });
}

/**
 * Add or remove a directory the agent may work in as freely as its own workspace.
 *
 * ★ A NOMINATION IS CHECKED AGAINST THE NEVER LIST TOO. Otherwise the answer to "no agent reaches
 * `.ssh`" is "nominate `~` and it does" — a boundary with a documented way through it is a
 * suggestion. This is the one place a person could widen the policy far enough to matter, so the
 * hard denials outrank it here exactly as they do in {@link decide}.
 */
export function nominate(userData: string, dir: string, on: boolean): { readonly ok: boolean; readonly why: string } {
  const abs = resolve(dir);
  if (on && forbiddenPath(abs)) {
    return { ok: false, why: 'that directory holds credentials or this app\'s own configuration, so it cannot be nominated' };
  }
  if (on && (abs === resolve(homedir()) || abs.split(sep).filter(Boolean).length <= 1)) {
    // ★ A whole drive or an entire home directory is not a nomination, it is a bypass: everything
    // on the never list lives inside one. Nominating a PROJECT is the intent; this keeps it so.
    return { ok: false, why: 'nominate a project directory rather than your whole home folder or a drive root' };
  }
  const p = grantsPath(userData);
  let stored: { nominated?: string[]; grants?: Grant[] } = {};
  if (existsSync(p)) {
    try { stored = JSON.parse(readFileSync(p, 'utf8')) as typeof stored; } catch { stored = {}; }
  }
  const rest = (stored.nominated ?? []).filter((d) => resolve(d) !== abs);
  writeFileSync(p, JSON.stringify({ ...stored, nominated: on ? [...rest, abs] : rest }, null, 2),
    { mode: 0o600, encoding: 'utf8' });
  return { ok: true, why: on ? 'the agent may now work in ' + abs : 'no longer nominated' };
}

// ── what is waiting on a person ──────────────────────────────────────────────

/** One thing an agent was refused and asked about, waiting to be answered. */
export interface PendingRequest {
  readonly id: string;
  readonly rule: string;
  readonly what: string;
  readonly tool: string;
  readonly agentName: string;
  readonly askedBy: string;
  readonly channel: string;
  readonly atIso: string;
}

/**
 * ★ ONE DEFINITION, USED BY BOTH SIDES. The gate writes requests and the app reads them, and they
 * are different processes that never speak — so the only thing joining them is this path. Written
 * out twice, a change to one is a panel that silently shows nothing forever while agents go on
 * asking: no error, no empty-state, just a boundary nobody can answer. `composeGate` takes the
 * directory from here rather than composing its own.
 */
export function requestsDir(userData: string): string {
  return join(userData, 'agent-requests');
}

export function requestsPath(userData: string): string {
  return join(requestsDir(userData), 'pending.jsonl');
}

/**
 * What is waiting to be answered, newest first, ONE PER RULE.
 *
 * ★ DEDUPED BY RULE RATHER THAN BY REQUEST, because an agent that is refused asks again — on the
 * next turn, and the turn after that. Listing every attempt buries the person under twenty copies
 * of one question, and the thing they are actually answering IS the rule: that is what a grant is
 * written against, so twenty attempts are one decision.
 *
 * ★ AND A LINE THAT WILL NOT PARSE IS SKIPPED, NOT FATAL. A separate process appends to this file
 * per tool call with no locking, so a torn final line is ordinary rather than exceptional, and it
 * must not stop a person seeing the requests above it.
 */
export function readPending(userData: string): readonly PendingRequest[] {
  const p = requestsPath(userData);
  if (!existsSync(p)) return [];
  let raw = '';
  try { raw = readFileSync(p, 'utf8'); } catch { return []; }
  const byRule = new Map<string, PendingRequest>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as PendingRequest;
      if (typeof r?.rule === 'string' && typeof r?.id === 'string') byRule.set(r.rule, r);
    } catch { /* a partial write is not a reason to show nothing */ }
  }
  return [...byRule.values()].sort((a, b) => String(b.atIso ?? '').localeCompare(String(a.atIso ?? '')));
}

/**
 * Forget a request, once it has been approved or turned down.
 *
 * The rewrite races the gate's appends, and it is benign in the only direction that matters: a
 * request that survives is asked again, and one that is lost reappears the next time the agent
 * tries. Neither outcome can grant anything.
 */
export function clearPending(userData: string, rule: string): void {
  const p = requestsPath(userData);
  if (!existsSync(p)) return;
  try {
    const kept = readFileSync(p, 'utf8').split('\n').filter((line) => {
      if (!line.trim()) return false;
      try { return (JSON.parse(line) as PendingRequest).rule !== rule; } catch { return false; }
    });
    writeFileSync(p, kept.length ? kept.join('\n') + '\n' : '', { mode: 0o600, encoding: 'utf8' });
  } catch { /* leaving it is survivable — the person can turn it down again */ }
}
