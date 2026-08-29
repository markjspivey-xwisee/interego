/**
 * The pod suites are DORMANT BY CREDENTIAL, and this is what keeps that a STATED property
 * rather than a side effect — plus what keeps the registry beside it COMPLETE rather than
 * merely long.
 *
 * ★ WHAT WAS ALREADY TRUE BEFORE THIS FILE, MEASURED, so nobody re-fixes it. `pod-target.ts`
 * and `real-pod-gate.ts` had already done the hard half: a declared skip is honoured, a skip
 * names the host and the variable, and a DISCOVERED failure throws instead of skipping. Run
 * with no pod variables set — re-driven on 843fc4fa after every change in this unit, byte-for-
 * byte the same summary — the five suites report
 *
 *     Test Files 5 passed (5)   Tests 5 passed | 22 skipped (27)
 *     "Tier 2 pod tests skipped — INTEREGO_POD_WRITE_SECRET unset (host: https://gate.interego.xwisee.com)"
 *
 * ★ WHAT WAS NOT — and the first three of these are the ones the FIRST version of this file
 * also failed to catch, which is why each is now measured rather than restated.
 *
 *   1. NOBODY HAD MEASURED WHETHER CI ARMS THEM. It does not — no tracked workflow sets
 *      INTEREGO_POD_WRITE_SECRET or FOXXI_POD_WRITE_SECRET, so bridge-typecheck.yml's whole-tree
 *      `npx vitest run` executes all 22 bodies as PERMANENT SKIPS. Both halves of that sentence
 *      are measured below: the absence of an arming workflow, and the existence of the bare
 *      whole-tree step that would run them if one appeared. The previous version asserted
 *      `expect(POD.armedInCi).toEqual([])` under this name, which restates a constant declared
 *      four lines away and could not have failed for anything CI did.
 *   2. THE SWITCHES WERE NEVER EXERCISED. A declared skip was only ever taken on a tree where
 *      the credential was ALSO absent — the branch that matters, "the operator has a credential
 *      AND wants these off", had never once been evaluated. A check that passes for two
 *      possible reasons is evidence for neither.
 *   3. THE CENSUS WAS NEVER CLOSED, IN THREE SEPARATE WAYS.
 *        · A sixth suite could import `pod-target.ts` directly and skip `openRealPod()`.
 *        · The fingerprints hardcoded SINGLE quotes, so a suite written with double quotes —
 *          no rule in this repo's eslint config governs quote style, driven — or with
 *          `await import(...)`, the idiom THIS file uses, sailed through a green census while
 *          genuinely opening the gate.
 *        · Nothing forced the SET of externals to be complete. It said "the three live things"
 *          and omitted `RUN_PUBLIC_RELAY`, the only one CI actually arms. The rule in
 *          `shared-live-externals.ts` is now enforced here, so the next omission is red.
 *
 * ★★ AND FIVE MORE THE REVIEWER OF THAT VERSION REPRODUCED, EACH CLOSED HERE AND EACH DRIVEN
 * WITH THE MUTANT THAT MOTIVATED IT. They are recorded together because they share one shape:
 * every one was a check whose PROSE described a property its CODE did not test.
 *
 *   4. The routing assertion was `/beforeAll\([^)]*(?:.|\n)*?openRealPod\(\)/`, whose
 *      `(?:.|\n)*?` spans the whole file — so it proved only that `beforeAll(` occurs somewhere
 *      above `openRealPod()`, a comment counting for either. DRIVEN: with agent-collective's
 *      tier8 rewritten to call the gate at module scope, leaving `beforeAll(` behind in a
 *      comment, the old regex returns TRUE. `beforeAllArguments` now matches parentheses, and
 *      that mutant is red.
 *   5. The literal-address scan tested the dial and the URL against the SAME LINE. DRIVEN: a
 *      suite whose `fetch(` and address are one line break apart is invisible to it and flagged
 *      by the region scan that replaced it — while the registry's header asserted flatly that
 *      no collected module dialled a non-loopback literal address at all.
 *   6. Only POD's switches were checked for being READ, so the other three entries had no such
 *      check. DRIVEN: replacing `lrsql-gate.ts`'s off switch with a literal `false` was
 *      undetected. The rule is now PER CONSUMER for every entry — deliberately stronger than
 *      "somebody reads it", which would have stayed green here because lrs-adapter's tier8
 *      reads `SKIP_LRSQL_TESTS` directly while tier3 and tier3b stopped honouring it.
 *   7. ★★ THE ENV FINGERPRINTS MISSED DESTRUCTURING. DRIVEN with the reviewer's own evasion: a
 *      sixth pod suite taking the real write credential as
 *      `const { INTEREGO_POD_WRITE_SECRET } = process.env;` and PUTting to the live shared
 *      container was seen by NOTHING — not `envRead`, not the completeness rule. Both were
 *      widened; the same file now reds the pod census 6-vs-5 and the dial scan.
 *   8. Five comments stated measurements that were not true of the code beneath them. Every
 *      number in this file and in the registry has been re-derived on 843fc4fa rather than
 *      carried forward, and one of them changed sign in the process: the claim that regex
 *      tracking in `views()` recovers three call sites was backwards — see the note there.
 *   9. ★★ THE IMPORT CLOSURE STOPPED AT THE `tests/` BOUNDARY — the same defect as 3 and 7, one
 *      directory over. Resolving a module's imports answered "the target is not in the file",
 *      but only for helpers that lived under a `tests/` directory, so a suite reaching a shared
 *      external through a helper beside the production code was invisible for exactly the
 *      reason `pod-target.ts` had been. DRIVEN with the reviewer's control, described at
 *      `closure` below: a helper outside `tests/` reading the real write credential and a sixth
 *      suite importing it left the pod census at five and the file green. The walk now follows a
 *      relative specifier wherever it leads inside the repository — which is also how the two
 *      live addresses in `SHARED_ONLY_THROUGH_IMPORTED_CODE` became visible, since both are
 *      read in production modules that collected suites import.
 *
 * ★ WHY THE ENV TESTS RE-IMPORT THE MODULE. `pod-target.ts` reads `process.env` at MODULE
 * SCOPE, so a later `process.env` write cannot reach it — `vi.stubEnv` alone would assert
 * nothing. Each case stubs, `vi.resetModules()`, then dynamically imports, which exercises the
 * REAL `real-pod-gate.ts` over the REAL `pod-target.ts`. A stub standing in for either would be
 * testing the double instead of the composition, and the defect being guarded here lives in how
 * the two compose.
 *
 * ★ AND THIS FILE IS A NO-OP WHEN THE CREDENTIAL IS SET. Every env case stubs ALL SEVEN names
 * the gate consults (both credential spellings, both off switches, all three targeting vars),
 * so nothing in the ambient environment can change an outcome below. Nothing here reaches the
 * real pod, and that is a routing fact rather than an intention: a case that returns a declared
 * skip never calls `probePod()`, a case whose off-switch value is unreadable throws inside
 * `declaredSkip()` before it, and EVERY case that does reach `probePod()` has stubbed
 * `INTEREGO_POD_BASE` to `http://127.0.0.1:9` — the discard port — so the throw is provoked on
 * loopback and no packet leaves the machine. The remaining cases only read files.
 *
 * MEASURED on 843fc4fa, five ambient environments, byte-identical `101 passed (101)` in every
 * one — re-driven after the closure was widened, when the count moved from 96: nothing set;
 * `INTEREGO_POD_WRITE_SECRET` set with `INTEREGO_POD_BASE` pointed at the discard port; `SKIP_POD_TESTS=1`; `SKIP_POD_TESTS=true` with a credential; and
 * `SKIP_POD_TESTS=ture`, the value that makes the gate THROW. The last one is the sharp
 * version of the claim — an ambient value that reds all five pod suites changes nothing here.
 *
 * ★ AND THE SUITES THEMSELVES ARE NOT BROKEN WITH A CREDENTIAL SET, established without holding
 * the real secret and therefore without ever dialling the pod. With a placeholder credential and
 * `INTEREGO_POD_BASE=http://127.0.0.1:9`, all five REFUSE TO SKIP — the discovered-failure path,
 * unchanged, now naming `1/true/yes/on`. With a placeholder credential and each of
 * `SKIP_POD_TESTS=1/true/TRUE/yes/on`, all five report `5 passed | 22 skipped (27)` and print
 * `SKIP_POD_TESTS/SKIP_AZURE_TESTS declared`, reaching no network at all because the off switch
 * decides before `probePod()`. `SKIP_POD_TESTS=ture` throws in every one of them, naming the
 * spellings. What is still NOT driven is a run against the live pod with the real credential,
 * which nobody in this session holds; for that mode the evidence is that no code path taken when
 * a credential is present was changed — only the set of VALUES that count as a declaration was
 * widened, and widening it can only turn a run that would have dialled into a skip.
 *
 * ★ `vi.stubEnv` MUTATES THE ONE REAL `process.env`, and `vitest.config.ts` pins
 * `poolOptions.forks.singleFork`, so every module in a run shares this process. The `afterEach`
 * restore below is therefore load-bearing twice over: within this file, where each case stubs
 * all seven names and an unrestored stub would decide the next case's outcome, and across
 * files, where a leaked `SKIP_POD_TESTS` would silently disarm the five pod suites.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHARED_LIVE_EXTERNALS, COLLECTED_ROOTS, IMPORTS_BUT_NEVER_DIALS,
  SHARED_BUT_NOT_LIVE, SHARED_ONLY_THROUGH_IMPORTED_CODE, LIVE_BUT_NOT_SHARED,
  helperImport, envRead,
  type SharedLiveExternal,
} from './shared-live-externals.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Everything git will show you: tracked files AND untracked ones that are not ignored.
 *
 * ★ `--others --exclude-standard` IS NOT DECORATION. A sixth pod suite arrives untracked — it
 * is a new file on somebody's branch before they commit it — and a census reading only
 * `git ls-files` cannot see it at the one moment the author is still deciding what it does.
 * Found by writing this file: with `ls-files` alone it was absent from its own COLLECTED list,
 * and the exemption test failed saying so. `npm run lint` has the same blind spot and states it
 * — there it is deliberate, because a lint pin must be a property of the commit. Here it is not:
 * the question is what the working tree does right now.
 *
 * Existence is filtered because `git ls-files` also lists a file deleted in the working tree,
 * and every scan below reads what it lists.
 */
function scannableFiles(): string[] {
  const run = (args: string[]): string[] => {
    const r = spawnSync('git', args, { cwd: REPO, encoding: 'buffer' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr?.toString() ?? ''}`);
    return r.stdout.toString('utf8').split('\0').filter(Boolean);
  };
  const all = [...run(['ls-files', '-z']), ...run(['ls-files', '-z', '--others', '--exclude-standard'])];
  return [...new Set(all)].filter(f => existsSync(resolve(REPO, f)));
}

const TRACKED = scannableFiles();
const TRACKED_SET = new Set(TRACKED);

/**
 * Cached, because the widened closure below reads the same file from many modules' walks —
 * measured on this tree, 1,271 (module, file) pairs over 530 distinct files. Only successful
 * reads are remembered: `closure` relies on a missing file still throwing.
 */
const TEXT = new Map<string, string>();
const read = (rel: string): string => {
  let t = TEXT.get(rel);
  if (t === undefined) { t = readFileSync(resolve(REPO, rel), 'utf8'); TEXT.set(rel, t); }
  return t;
};

/** Any `.ts` under a collected root's `tests/` directory — modules AND the helpers beside them. */
const inTestTree = (f: string): boolean =>
  f.endsWith('.ts')
  && COLLECTED_ROOTS.some(r => f.startsWith(r + '/'))
  && (f.startsWith('tests/') || f.includes('/tests/'));

/**
 * The modules vitest actually collects. Derived the same way `test-files-are-runnable.test.ts`
 * derives it, and from `git ls-files` rather than a git PATHSPEC: `git grep -- 'tests/**\/*.ts'`
 * matches ZERO files here, because a pathspec is fnmatch without FNM_PATHNAME and needs a
 * second slash. A zero result there looks exactly like a clean scan.
 */
const COLLECTED = TRACKED.filter(f => f.endsWith('.test.ts') && inTestTree(f));

const POD = SHARED_LIVE_EXTERNALS.find(e => e.id === 'pod') as SharedLiveExternal;

/**
 * ★ THE FIX FOR THE SECOND ROUTE PAST THE CENSUS: THE TARGET IS NOT IN THE FILE.
 *
 * `pod-target.ts` is a helper, so a suite that reaches the pod through `real-pod-gate.ts` never
 * writes `INTEREGO_POD_WRITE_SECRET` in its own text. Fingerprinting a module's own bytes made
 * every consumer's membership depend on which of two files it happened to name. So a module is
 * fingerprinted against its text AND the text of every module it transitively imports.
 *
 * ★★ AND THE FIRST VERSION OF THAT WALK STOPPED AT THE `tests/` BOUNDARY, WHICH IS THE SAME
 * DEFECT ONE DIRECTORY OVER. It followed a specifier only when the file it named satisfied
 * `inTestTree`, so a suite reaching a shared external through a helper that lives beside the
 * production code was invisible for precisely the reason a suite reaching it through
 * `pod-target.ts` had been. DRIVEN BOTH WAYS with the reviewer's control — a helper at
 * `applications/_shared/live-pod-writer.ts` whose `podWriteAuth()` reads
 * INTEREGO_POD_WRITE_SECRET, imported by a sixth suite at
 * `applications/_shared/tests/tier9-control-pod-suite.test.ts`. Against the boundary walk the
 * whole file stayed GREEN, pod census five; against the walk below it fails
 * `expected [ …(6) ] to deeply equal [ …(5) ]` with the control named in the diff. Both files
 * were then deleted, which is why the control is described here rather than committed: a suite
 * that really reads the write credential is not something to leave in the tree.
 *
 * Only relative specifiers ending `.js` are followed, only into files git lists inside this
 * repository, and never into another `*.test.ts` — a test importing a test would union two
 * modules' consumer status and is not a thing this repo does. What it still cannot see —
 * `@interego/*` and every other non-relative specifier, a specifier that is not a literal, a
 * child process, an untracked or generated file — is listed in the registry's header, where the
 * lens as a whole is described.
 */
const REL_SPEC = /(?:from|import|require)\s*\(?\s*(['"\x60])(\.[^'"\x60]*?\.js)\1/g;

function closure(file: string): string[] {
  const seen = new Set<string>();
  const walk = (f: string): void => {
    if (seen.has(f)) return;
    seen.add(f);
    let t: string;
    try { t = read(f); } catch { return; }
    for (const m of t.matchAll(REL_SPEC)) {
      const target = relative(REPO, resolve(dirname(resolve(REPO, f)), m[2]!))
        .replace(/\\/g, '/')
        .replace(/\.js$/, '.ts');
      // `relative` answers with a leading `..` for anything above the repository root, and with
      // an absolute path for another drive; neither is in TRACKED_SET, and the explicit test
      // says so rather than relying on that.
      if (target.startsWith('../') || !TRACKED_SET.has(target)) continue;
      if (target.endsWith('.test.ts')) continue;
      walk(target);
    }
  };
  walk(file);
  return [...seen];
}

const CLOSURE = new Map(COLLECTED.map(f => [f, closure(f)] as const));
const closureFiles = (f: string): string[] => CLOSURE.get(f)!;

/**
 * Does any file in the module's closure match?
 *
 * ★ PER FILE RATHER THAN OVER ONE JOINED STRING, and the change is a narrowing rather than a
 * convenience. `envRead`'s destructuring branch spans newlines and `[^{}]*` crosses them, so
 * against a concatenation it can match a `{` at the end of one file and a `= process.env` at
 * the start of the next; per file that cannot happen. It also keeps the widened walk cheap —
 * the closures joined are 22.9 MB of string on this tree, measured, against 530 files read
 * once each.
 */
const closureHas = (f: string, re: RegExp): boolean => closureFiles(f).some(x => re.test(read(x)));

/**
 * TWO INDEX-ALIGNED VIEWS OF A MODULE, from one pass:
 *
 *   `code`  — comments replaced by spaces (newlines kept), string and template CONTENTS intact
 *   `shape` — the same, with string, template and regex-literal contents ALSO blanked
 *
 * Both are exactly as long as the input, so a range located structurally in `shape` slices the
 * matching TEXT out of `code`. That pairing is the whole reason this exists: finding where a
 * call's arguments end needs parentheses that are not inside a string, and reading the URL
 * inside those arguments needs the string back.
 *
 * Comments out and string literals in is the exact opposite of what a `toContain(name)` check
 * does, and is the reason one of the tests below could not detect what it named.
 *
 * ★★ IT TRACKS REGEX LITERALS, AND THAT IS NOT COMPLETENESS FOR ITS OWN SAKE. A quote-tracking
 * scanner desynchronises on a character class holding an unpaired quote and never recovers.
 * That is not hypothetical here: `REL_SPEC`, about forty lines above, is
 * `/…(['"\x60])…/`, and with regex tracking switched off this scanner enters string mode at
 * that apostrophe and stays there for the rest of the file — every block comment below it then
 * survives as "code".
 *
 * DRIVEN BOTH WAYS over all 329 collected modules on 843fc4fa, and the damage is visible in the
 * numbers rather than argued. WITH tracking: 113 call sites, the longest spanning 9 lines, not
 * one of them reaching the end-of-file fallback, and `shape`'s parentheses balance in all 329
 * modules. WITHOUT it: the parentheses fail to balance in 58 of the 329, and the scan reports
 * EXTRA call sites that are this file's own prose below being read as code — every one of them
 * then running to end of file, because a sentence has no closing parenthesis to find.
 *
 * (The count of those extras is deliberately not written down. It is a function of how many
 * times the paragraphs in this file happen to name a dialling call, so pinning it would put a
 * number here that the next comment edit falsifies — which is the defect class this unit spent
 * its time on. 113, 9, 0 and 58 do not move with prose, and those are the ones stated.)
 *
 * ★ AND IT IS STILL NOT A PARSER. Whether `/` opens a regex or divides is decided from the
 * preceding non-space character, the standard heuristic. Balancing everywhere today is evidence
 * it works on this tree, not a guarantee, so nothing here depends on it: `dialRegions` reports
 * a region it could not close rather than trusting it, the census asserts there are none, and
 * the two extractors below THROW rather than returning empty. An over-report is a red with a
 * filename in it; the failure mode that must not exist is the silent pass.
 */
type ScanMode = 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 're';

/** After one of these, a `/` opens a regex literal rather than dividing. */
const REGEX_MAY_START = /[({[\]},;:=!&|?+\-*%~^<>]$/;
const REGEX_AFTER_KEYWORD = /\b(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

function views(src: string): { code: string; shape: string } {
  let code = '';
  let shape = '';
  let recent = '';
  let mode: ScanMode = 'code';
  let i = 0;
  const keep = (ch: string, blankInShape: boolean): void => {
    code += ch;
    shape += blankInShape && ch !== '\n' ? ' ' : ch;
  };
  const drop = (ch: string): void => {
    const b = ch === '\n' ? '\n' : ' ';
    code += b;
    shape += b;
  };
  while (i < src.length) {
    const c = src[i]!;
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') { mode = 'line'; drop(' '); drop(' '); i += 2; continue; }
      if (c === '/' && d === '*') { mode = 'block'; drop(' '); drop(' '); i += 2; continue; }
      if (c === '/' && (recent === '' || REGEX_MAY_START.test(recent) || REGEX_AFTER_KEYWORD.test(recent))) {
        mode = 're'; keep(c, true); i += 1; continue;
      }
      if (c === "'") { mode = 'sq'; keep(c, false); i += 1; continue; }
      if (c === '"') { mode = 'dq'; keep(c, false); i += 1; continue; }
      if (c === '\x60') { mode = 'tpl'; keep(c, false); i += 1; continue; }
      keep(c, false);
      if (!/\s/.test(c)) recent = (recent + c).slice(-24);
      i += 1;
      continue;
    }
    if (mode === 'line') { if (c === '\n') mode = 'code'; drop(c); i += 1; continue; }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; drop(' '); drop(' '); i += 2; continue; }
      drop(c); i += 1; continue;
    }
    // Inside a string, a template or a regex — none of it is structure, so all of it is blanked
    // in `shape`. (A `${…}` interpolation goes with it: its parentheses blank in matched pairs,
    // so balance is preserved, and a dial written INSIDE an interpolation is not seen. Measured
    // on 843fc4fa: no collected module does that.)
    const inRegex = mode === 're';
    if (c === '\\') { keep(c, true); if (d !== undefined) keep(d, true); i += 2; continue; }
    if (inRegex && c === '[') {
      // A character class: `/` and quotes inside it are literal. Reading them as delimiters is
      // precisely how the previous scanner lost its place, so the class is consumed whole.
      keep(c, true);
      i += 1;
      while (i < src.length && src[i] !== ']' && src[i] !== '\n') {
        if (src[i] === '\\') {
          keep(src[i]!, true); i += 1;
          if (i < src.length) { keep(src[i]!, true); i += 1; }
          continue;
        }
        keep(src[i]!, true); i += 1;
      }
      continue;
    }
    // An unterminated regex at end of line is a misread `/`; recover rather than run on.
    if (inRegex && c === '\n') { mode = 'code'; recent = ''; keep(c, true); i += 1; continue; }
    if ((mode === 'sq' && c === "'") || (mode === 'dq' && c === '"')
      || (mode === 'tpl' && c === '\x60') || (inRegex && c === '/')) {
      mode = 'code';
      recent = 'x';
      keep(c, false);
      i += 1;
      continue;
    }
    keep(c, true);
    i += 1;
  }
  return { code, shape };
}

/** Comments out, string literals in. */
const codeOf = (src: string): string => views(src).code;

/**
 * The head of a call that opens a connection to something.
 *
 * Measured on 843fc4fa over the 329 collected modules, counting heads that are CODE — found in
 * `shape`, so a mention in prose or inside a string literal is not one, and these three numbers
 * are therefore stable against edits to any comment: `fetch(` 80, `.connect(` 33,
 * `new WebSocket(` ZERO. That last one is listed anyway, and its count being
 * zero is the reason to say so out loud rather than quietly drop it: the p2p suites reach a
 * relay through `WebSocketRelayMirror`, and the day one of them constructs a socket directly,
 * this is where that has to be noticed. `.connect(` is the loose one, since it catches any
 * object's `connect` method; that direction is deliberate, per the registry's note that an
 * over-report is a red with a filename and an under-report is the green tick this all exists
 * to stop.
 *
 * (Counting RAW text instead is higher on all three, `new WebSocket(` included, and every extra
 * hit is in the prose or the samples of this file. A scan that reads its own documentation as
 * code is the defect one paragraph up, arriving as a measurement rather than as a test — which
 * is also why no raw figure is written here.)
 */
const DIAL_HEAD_SOURCE = String.raw`(?:\bfetch\s*\(|new\s+WebSocket\s*\(|\.connect\s*\()`;

/**
 * Every dialling call in a module, as the TEXT of its arguments — parenthesis-matched, so a
 * call written across lines is one region rather than several fragments.
 *
 * Heads are found in `shape`, so a `fetch(` inside a comment or a string literal is not a call.
 * The region is then sliced out of `code`, so the URL inside it is still readable.
 *
 * `closed` is false when no matching parenthesis was found, in which case the region runs to
 * end-of-file. That over-reports — the right direction to fail in — but it is also the exact
 * symptom of a desynchronised scanner, so the census asserts there are none rather than
 * silently accepting a scan that has stopped understanding the file.
 */
function dialRegions(src: string): { line: number; text: string; closed: boolean }[] {
  const { code, shape } = views(src);
  const re = new RegExp(DIAL_HEAD_SOURCE, 'g');
  const out: { line: number; text: string; closed: boolean }[] = [];
  for (;;) {
    const m = re.exec(shape);
    if (m === null) break;
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = shape.length - 1;
    let closed = false;
    for (let i = open; i < shape.length; i += 1) {
      if (shape[i] === '(') depth += 1;
      else if (shape[i] === ')') {
        depth -= 1;
        if (depth === 0) { end = i; closed = true; break; }
      }
    }
    out.push({ line: code.slice(0, m.index).split('\n').length, text: code.slice(m.index, end + 1), closed });
  }
  return out;
}

/**
 * Hosts in a piece of text that name somewhere real: not loopback, dotted (a bare label is a
 * container name on an internal network, not a public address), and not in a namespace reserved
 * for documentation and tests.
 */
function literalHosts(text: string): string[] {
  const LOOPBACK = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)$/;
  const RESERVED = /(^|\.)((example|test|invalid|localhost)$|example\.(com|org|net)$)/;
  const URLRE = /\b(?:https?|wss?):\/\/([A-Za-z0-9._-]+)/g;
  const hosts: string[] = [];
  for (const m of text.matchAll(URLRE)) {
    const host = m[1]!;
    if (LOOPBACK.test(host) || !host.includes('.') || RESERVED.test(host)) continue;
    hosts.push(host);
  }
  return hosts;
}

/**
 * A workflow SETS a name if an assignment survives YAML comment-stripping.
 *
 * ★ THE STRIPPING IS NOT COSMETIC. Without it, `(^|[;&\s])NAME=` matched `PGSL_PG_IT=1` inside
 * a PROSE COMMENT in lrs-adapter-conformance.yml, and that workflow was reported as arming
 * pgsl-store. A text match standing in for a read is the defect class this whole file exists
 * to close, and the first version of this check had it.
 */
function stripYamlComments(text: string): string {
  return text.split('\n').map((line) => {
    let q: '"' | "'" | null = null;
    for (let i = 0; i < line.length; i += 1) {
      const c = line[i]!;
      if (q) { if (c === q) q = null; continue; }
      if (c === '"' || c === "'") { q = c; continue; }
      if (c === '#' && (i === 0 || /\s/.test(line[i - 1]!))) return line.slice(0, i);
    }
    return line;
  }).join('\n');
}

function setsVar(text: string, name: string): boolean {
  const code = stripYamlComments(text);
  return new RegExp(String.raw`^\s*${name}:\s`, 'm').test(code)
    || new RegExp(String.raw`(^|[;&\s])${name}=`, 'm').test(code);
}

/**
 * A file that SETS an environment variable, as opposed to reading one.
 *
 * ★ IT IS THE LOAD-BEARING HALF OF "DORMANT". Two of the names in
 * `SHARED_ONLY_THROUGH_IMPORTED_CODE` address something genuinely live — a Solid pod and a
 * PostgreSQL — and the argument for their being outside `SHARED_LIVE_EXTERNALS` is not that
 * they are harmless but that every path behind them is guarded on the value being PRESENT, and
 * nothing here supplies one. That second half is a claim about the tree, so it is measured
 * rather than asserted in prose: this scan over every scannable file, and `setsVar` over
 * `.github`, are what would notice the day somebody sets one.
 *
 * Three spellings, which are the ones this repo writes: `vi.stubEnv('NAME', …)`,
 * `process.env.NAME = …` and `process.env['NAME'] = …`. `=[^=]` keeps a comparison out of it.
 * A name assigned through a VARIABLE — `vi.stubEnv(k, v)` in a loop, as this file does itself —
 * is not visible to it, so the scan is a floor rather than a proof; the guard it backs is
 * paired with a positive control on a file that really does set one.
 */
function setsEnvName(text: string, name: string): boolean {
  const code = codeOf(text);
  return new RegExp(String.raw`stubEnv\s*\(\s*(['"\x60])${name}\1`).test(code)
    || new RegExp(String.raw`process\.env\.${name}\s*=[^=]`).test(code)
    || new RegExp(String.raw`process\.env\[\s*(['"])${name}\1\s*\]\s*=[^=]`).test(code);
}

const ENV_READ_ANY = /process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\])/g;

/**
 * ★★ THE THIRD WAY TO READ `process.env`, AND THE COMPLETENESS RULE WAS BLIND TO IT TOO.
 * `envRead` in the registry was widened for destructuring after a reviewer smuggled a sixth pod
 * suite past every census with `const { INTEREGO_POD_WRITE_SECRET } = process.env;`; this is the
 * other half of that fix, because the fingerprints and the "every shared name is accounted for"
 * rule are two independent scans and closing one would have left the other open. A name read
 * only this way was invisible here, so a genuinely shared external reached by two suites that
 * both destructure would have gone unregistered AND unnoticed.
 *
 * `[^{}]*` is a negated class, so the multi-line form is covered. Each comma-separated part
 * yields its KEY: `{ A, B: local, C = 'x' }` gives A, B and C, and a part whose leading token is
 * not an identifier — `...rest`, or the tail of a default value that itself contained a comma —
 * yields nothing rather than a guess.
 */
const ENV_DESTRUCTURE = /\{([^{}]*)\}\s*=\s*process\.env\b/g;
const DESTRUCTURED_KEY = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::|=|$)/;

/**
 * Whole-line comments removed. Deliberately NOT the `views()` scanner above, and the reason is a
 * defect the FIRST version of that scanner had, in this very file.
 *
 * ★ A STATEFUL STRIPPER CAN DESYNCHRONISE ON A REGEX LITERAL. `ENV_READ_ANY` above contains the
 * character class `['"]` — one unpaired apostrophe, to a scanner that tracks only quotes — so
 * the quote-only stripper entered string mode there and never left, and every comment for the
 * rest of the file survived as "code". `views()` now tracks regex literals precisely because of
 * that, which fixes the case that was found; what it cannot promise is that no OTHER input
 * desynchronises it, since it decides `/` by heuristic. Its parentheses do balance across all
 * 329 collected modules today, which is evidence about this tree rather than a property of the
 * algorithm.
 *
 * A census over 329 arbitrary modules cannot rest on that promise, so this one is stateless and
 * per-line: a line whose first non-space characters are `//`, `/*` or `*` is prose. It cannot be
 * desynchronised by anything, and the case it must catch is exactly that shape. The two are
 * therefore used in different places on purpose — `views()` where the input is one known file
 * and an anchor assertion backs it, this where the input is the whole tree.
 *
 * ★ WHY ANY OF IT MATTERS. Over raw text `FOXXI_WALLET_SEED` measured as read by TWO modules,
 * so the completeness rule demanded it be registered or excused — and it was excused, in a
 * sentence claiming "both readers assign it a fixed test value". That sentence was FALSE.
 * `tests/personal-bridge.test.ts` reads nothing; it carries the literal
 * `process.env.FOXXI_WALLET_SEED` inside a paragraph EXPLAINING a different file. Comment lines
 * dropped, the one real reader is
 * `applications/foxxi-content-intelligence/tests/public-memory-commons.test.ts`. The rule had
 * written a false record into the registry about a name nobody shares — the same defect as
 * everything else here, arriving from the one direction not yet covered: prose forcing an entry
 * rather than hiding one.
 *
 * So this side is strict while the fingerprints stay liberal, and that asymmetry is the point.
 * A fingerprint that over-reports a CONSUMER goes red with a filename and a human looks; a rule
 * that over-reports a SHARED NAME gets a justification written for it and becomes documentation.
 */
function dropCommentLines(src: string): string {
  return src.split('\n').filter(l => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n');
}

/** Every env name read in a body of text, in all three spellings. Comments are the caller's job. */
function envNamesIn(text: string): Set<string> {
  const names = new Set<string>();
  for (const m of text.matchAll(ENV_READ_ANY)) names.add((m[1] ?? m[2])!);
  for (const m of text.matchAll(ENV_DESTRUCTURE)) {
    for (const part of m[1]!.split(',')) {
      const key = DESTRUCTURED_KEY.exec(part);
      if (key) names.add(key[1]!);
    }
  }
  return names;
}

/** Env names read in one file, comment lines dropped. Memoised: the closures share files. */
const ENV_NAMES = new Map<string, Set<string>>();
function envNamesFile(file: string): Set<string> {
  let s = ENV_NAMES.get(file);
  if (!s) { s = envNamesIn(dropCommentLines(read(file))); ENV_NAMES.set(file, s); }
  return s;
}

/** Env names each collected module reads, itself or through anything it imports. */
function envNamesOf(file: string): Set<string> {
  const names = new Set<string>();
  for (const f of closureFiles(file)) for (const n of envNamesFile(f)) names.add(n);
  return names;
}

/**
 * The same, restricted to the reads that live in the TEST TREE.
 *
 * ★ IT IS THE DISCRIMINATOR THE WIDENED WALK NEEDS. A name shared only because two suites
 * import one production file is a different fact from a name two suites read themselves, and
 * `SHARED_ONLY_THROUGH_IMPORTED_CODE` is allowed to account for the first kind only. Without
 * this that list would be a second place to excuse a test-tree read, which is the door the
 * registry's completeness rule exists to keep shut.
 */
function testTreeEnvNamesOf(file: string): Set<string> {
  const names = new Set<string>();
  for (const f of closureFiles(file)) {
    if (!inTestTree(f)) continue;
    for (const n of envNamesFile(f)) names.add(n);
  }
  return names;
}

/**
 * ★ THE EXEMPT MODULES ARE EXCLUDED HERE TOO, and leaving them in was a bug this caught in
 * itself. `IMPORTS_BUT_NEVER_DIALS` says a module reaches nothing; a module that reaches
 * nothing is not a second reader of anything. With this file counted, its own
 * `process.env['SCORM_CLOUD_KEY']` sample — written to prove `envRead` tells a read from a
 * mention — became a third SCORM reader, and its `envNamesOf` prose became a second
 * FOXXI_WALLET_SEED reader. An exemption that holds for one census and not the other is not an
 * exemption; it is a place for the next false record to land.
 */
const CENSUS_MODULES = COLLECTED.filter(f => !IMPORTS_BUT_NEVER_DIALS.includes(f));

const ENV_READERS = new Map<string, string[]>();
for (const f of CENSUS_MODULES) {
  for (const n of envNamesOf(f)) {
    if (!ENV_READERS.has(n)) ENV_READERS.set(n, []);
    ENV_READERS.get(n)!.push(f);
  }
}

/** The same census counting only reads that live in the test tree. */
const TEST_TREE_ENV_READERS = new Map<string, string[]>();
for (const f of CENSUS_MODULES) {
  for (const n of testTreeEnvNamesOf(f)) {
    if (!TEST_TREE_ENV_READERS.has(n)) TEST_TREE_ENV_READERS.set(n, []);
    TEST_TREE_ENV_READERS.get(n)!.push(f);
  }
}

describe('the live resources more than one test module shares', () => {
  it('scans a non-empty tree, so every census below can actually fail', () => {
    // Guards the guard. A broken `git ls-files` or a renamed root would make every scan in
    // this file vacuously true, which is the failure mode the scans exist to catch.
    expect(TRACKED.length).toBeGreaterThan(500);
    expect(COLLECTED.length).toBeGreaterThan(300);
    expect(SHARED_LIVE_EXTERNALS.length).toBeGreaterThan(0);
    expect(ENV_READERS.size).toBeGreaterThan(10);
  });

  it('follows an import out of the test tree, which is the hole this closes', () => {
    // ★★ THE NON-VACUITY ANCHOR FOR THE WIDENING ITSELF. A walk that silently stopped at the
    // `tests/` boundary again — or one that resolved nothing at all — would leave every census
    // in this file green while reading only the part of each module that happens to live under
    // a `tests/` directory. So the property is asserted on a real pair, in both halves: the
    // edge exists, and the file it reaches is one the old boundary excluded.
    const durability = 'tests/engagement-durability.test.ts';
    const store = 'deploy/mcp-relay/engagement-store.ts';
    expect(COLLECTED).toContain(durability);
    expect(inTestTree(store), `${store} is no longer outside the test tree`).toBe(false);
    expect(closureFiles(durability)).toContain(store);
    // And the reach is real rather than nominal: the name is read THERE and read nowhere in
    // the module's own text — which is exactly the shape that used to be invisible. (That
    // module does carry the string `process.env` once, inside a comment explaining the binding
    // it is asserting on, so the check is a READ rather than a mention, as everywhere else.)
    expect(envNamesFile(durability).has('RELAY_PGSL_PG_CONNSTR')).toBe(false);
    expect(envNamesOf(durability).has('RELAY_PGSL_PG_CONNSTR')).toBe(true);
    expect(testTreeEnvNamesOf(durability).has('RELAY_PGSL_PG_CONNSTR')).toBe(false);

    // ★ AND AT THE SCALE THE HEADER CLAIMS, so a walk that found ONE edge and stopped is red
    // too. Measured on this tree: 139 modules leave the test tree and 196 excluded files are
    // reached; the floors are well under both, because these move with the tree.
    const leaving = COLLECTED.filter(f => closureFiles(f).some(x => !inTestTree(x)));
    const reached = new Set(COLLECTED.flatMap(f => closureFiles(f)).filter(x => !inTestTree(x)));
    expect(leaving.length).toBeGreaterThan(100);
    expect(reached.size).toBeGreaterThan(150);
  });

  it('still refuses the two edges it always refused', () => {
    // A test importing a test would union two modules' consumer status, and nothing outside the
    // repository is scannable at all. Both are properties of `closure`, so both are checked
    // against the real walk rather than argued: no closure holds a `.test.ts` other than its
    // own entry point, and every file in every closure is something git listed here.
    for (const f of COLLECTED) {
      const others = closureFiles(f).filter(x => x !== f && x.endsWith('.test.ts'));
      expect(others, `${f}'s closure reached another test module`).toEqual([]);
      for (const x of closureFiles(f)) expect(TRACKED_SET.has(x)).toBe(true);
    }
  });

  it('resolves a module\'s helpers before fingerprinting it', () => {
    // The property the whole census rests on, asserted on a real pair rather than assumed:
    // tier3 names no LRS endpoint of its own, and is a consumer only through lrsql-gate.ts.
    const tier3 = 'applications/lrs-adapter/tests/tier3-real-lrs.test.ts';
    expect(closureFiles(tier3)).toContain('applications/lrs-adapter/tests/lrsql-gate.ts');
    expect(read(tier3)).not.toContain('localhost:8080');
    expect(closureHas(tier3, /localhost:8080/)).toBe(true);
  });

  for (const ext of SHARED_LIVE_EXTERNALS) {
    describe(ext.id, () => {
      it('is reached by exactly the modules the registry names — no sixth suite', () => {
        const measured = CENSUS_MODULES
          .filter(f => ext.fingerprints.some(re => closureHas(f, re)));
        // Sorted both sides: the failure message must read as a set difference, because the
        // thing a reader needs to see is WHICH module appeared, not that two arrays differ.
        expect(measured.slice().sort()).toEqual(ext.touchedBy.slice().sort());
      });

      it('names modules that exist and are collected', () => {
        for (const f of ext.touchedBy) expect(COLLECTED).toContain(f);
      });

      it('records truthfully whether CI arms it', () => {
        // ★ Iterates git's own listing of the tree, NOT ripgrep: rg skips dot-directories
        // without --hidden. Re-measured on this tree — `rg -l SCORM_CLOUD_KEY` finds 7 files and
        // `rg -l --hidden` finds 8, and the ONE it misses is
        // `.github/workflows/lrs-adapter-conformance.yml`. `RUN_PUBLIC_RELAY` gives the same
        // 7-vs-8 with `public-relay-interop.yml` as the miss. Those two workflows are the only
        // things arming anything in this registry, so a scan blind to `.github` would have
        // "confirmed" armedInCi: [] for every entry — including the one CI runs nightly.
        const workflows = TRACKED.filter(f => f.startsWith('.github/'));
        expect(workflows.length).toBeGreaterThan(0);
        const measured = workflows.filter(f => ext.armedBy.some(n => setsVar(read(f), n)));
        expect(measured.slice().sort()).toEqual(ext.armedInCi.slice().sort());
      });
    });
  }
});

describe('the registry names every shared live external, by rule rather than by memory', () => {
  // ★★ THE TEST THAT WOULD HAVE CAUGHT RUN_PUBLIC_RELAY. The previous header claimed "the three
  // live things" and nothing could contradict it; the fourth was a third-party Nostr relay that
  // CI arms unconditionally. A list is complete only if something rejects the next addition.
  const claimed = new Set(SHARED_LIVE_EXTERNALS.flatMap(e => [...e.armedBy, ...e.offSwitch, ...e.retargetedBy]));
  const excused = new Set(SHARED_BUT_NOT_LIVE.map(e => e.name));
  const throughCode = new Set(SHARED_ONLY_THROUGH_IMPORTED_CODE.map(e => e.name));

  it('accounts for every environment variable two or more collected modules read', () => {
    const shared = [...ENV_READERS.entries()].filter(([, fs]) => fs.length >= 2).map(([n]) => n);
    expect(shared.length).toBeGreaterThan(5);
    const unaccounted = shared
      .filter(n => !claimed.has(n) && !excused.has(n) && !throughCode.has(n));
    expect(
      unaccounted,
      'Read by two or more collected modules and accounted for nowhere. If it addresses '
      + 'something outside this process and the test tree reaches it, it is a fifth entry in '
      + 'SHARED_LIVE_EXTERNALS; if two suites read it themselves and it addresses nothing, say '
      + 'why in SHARED_BUT_NOT_LIVE; if it is shared only because two suites import one '
      + 'production module that reads it, it belongs in SHARED_ONLY_THROUGH_IMPORTED_CODE with '
      + 'its read site.',
    ).toEqual([]);
  });

  it('keeps the excuses and the entries disjoint, and every excuse earning its place', () => {
    for (const e of SHARED_BUT_NOT_LIVE) {
      expect(claimed.has(e.name)).toBe(false);
      expect(e.why.length).toBeGreaterThan(40);
      // An excuse for a name nothing reads twice is dead weight that will outlive its reason.
      expect(ENV_READERS.get(e.name)?.length ?? 0).toBeGreaterThanOrEqual(2);
    }
  });

  it('accounts through imported code only for names the test tree does not share', () => {
    // ★★ THE RULE THAT KEEPS THE NEW LIST FROM BECOMING A SECOND EXCUSE BOX. Its entries are
    // allowed to say one thing: "two or more modules read this only because they import one
    // production file that reads it". Both halves are measured — shared through the closure,
    // and NOT shared within the test tree. The moment a second suite reads one of these names
    // itself, the entry stops applying and this reds, which forces the decision the registry's
    // completeness rule exists to force rather than letting an old line stand.
    //
    // DRIVEN: deleting the RELAY_PGSL_TABLE entry fails the completeness rule above with
    // `expected [ 'RELAY_PGSL_TABLE' ] to deeply equal []`, so the list is load-bearing rather
    // than documentation of a scan that would pass without it.
    for (const e of SHARED_ONLY_THROUGH_IMPORTED_CODE) {
      expect(claimed.has(e.name), `${e.name} is already claimed by an entry`).toBe(false);
      expect(excused.has(e.name), `${e.name} is also in SHARED_BUT_NOT_LIVE`).toBe(false);
      expect(e.why.length).toBeGreaterThan(40);
      const readers = ENV_READERS.get(e.name) ?? [];
      expect(readers.length, `${e.name} is not read by two collected modules at all`)
        .toBeGreaterThanOrEqual(2);
      const inTests = TEST_TREE_ENV_READERS.get(e.name) ?? [];
      expect(
        inTests.length,
        `${e.name} is now read in the test tree by ${inTests.join(', ')}. This list only `
        + 'accounts for names shared through imported production code; if two suites read it '
        + 'themselves it is an entry in SHARED_LIVE_EXTERNALS or a line in SHARED_BUT_NOT_LIVE.',
      ).toBeLessThan(2);
    }
  });

  it('names a read site that exists, is outside the test tree, and really reads it', () => {
    // Both directions, the same discipline as every other list here: an entry pointing at a
    // file that has stopped reading the name is red rather than inherited. DRIVEN by repointing
    // FOXXI_WALLET_SEED's read site at `course-identity.ts`, a real file that reads two other
    // names: red, naming both the file and the name it no longer reads.
    for (const e of SHARED_ONLY_THROUGH_IMPORTED_CODE) {
      expect(TRACKED, `${e.readIn} is not a file git lists`).toContain(e.readIn);
      expect(inTestTree(e.readIn), `${e.readIn} is in the test tree`).toBe(false);
      expect(
        [...envNamesFile(e.readIn)],
        `${e.readIn} no longer reads ${e.name} — the entry is describing something else`,
      ).toContain(e.name);
    }
  });

  it('measures the dormancy the two live-addressing names rest on', () => {
    // ★★ THE ONE CLAIM IN THAT LIST THAT IS NOT ABOUT A CONSTANT. FOXXI_TENANT_POD_URL and
    // FOXXI_AUTHORITATIVE_SOURCE name a real pod that pod-snapshot-publisher writes to with
    // globalThis.fetch; RELAY_PGSL_PG_CONNSTR names a real PostgreSQL that engagement-store
    // opens. Each dial is guarded on the value being present, so what makes them dormant is
    // that NOTHING SUPPLIES ONE — and that is a fact about this tree, re-measured here over
    // every scannable file and every workflow rather than restated from the entry's prose.
    //
    // DRIVEN: one file added under `applications/_shared/tests/` doing
    // `process.env["RELAY_PGSL_PG_CONNSTR"] = "postgres://…"` reds this, naming the file and
    // the variable. The file was untracked, which is the case `--others --exclude-standard` in
    // `scannableFiles` exists for — armed on a branch before anything is committed.
    const LIVE_ADDRESSING = ['FOXXI_TENANT_POD_URL', 'FOXXI_AUTHORITATIVE_SOURCE', 'RELAY_PGSL_PG_CONNSTR'];
    for (const n of LIVE_ADDRESSING) {
      expect(
        SHARED_ONLY_THROUGH_IMPORTED_CODE.map(e => e.name),
        `${n} left SHARED_ONLY_THROUGH_IMPORTED_CODE; this guard is describing something else`,
      ).toContain(n);
    }
    // A positive control first, on a file that really does set a variable this way. Without it
    // an empty scanner would "prove" dormancy for everything — the exact vacuous pass this
    // file exists to refuse.
    expect(
      setsEnvName(read('tests/cors-allowlist.test.ts'), 'RELAY_CORS_ALLOWLIST'),
      'tests/cors-allowlist.test.ts no longer sets RELAY_CORS_ALLOWLIST in a way this scanner '
      + 'recognises. Point the control at another file that really sets one — without a '
      + 'positive control the dormancy result below is worth nothing.',
    ).toBe(true);
    expect(setsEnvName("expect(process.env.RELAY_CORS_ALLOWLIST).toBe('x');", 'RELAY_CORS_ALLOWLIST'))
      .toBe(false);

    const armed: string[] = [];
    let scanned = 0;
    for (const f of TRACKED) {
      if (!/\.(?:ts|mts|cts|js|mjs|cjs)$/.test(f)) continue;
      scanned += 1;
      const text = read(f);
      // The substring test first: `codeOf` walks a file character by character, and running it
      // over every source file in the tree — 4.8 MB of them, measured — for three names almost
      // none of them contain would be the slowest thing here by a wide margin.
      for (const n of LIVE_ADDRESSING) {
        if (text.includes(n) && setsEnvName(text, n)) armed.push(`${f} sets ${n}`);
      }
    }
    expect(scanned, 'the whole-tree scan matched no source files at all').toBeGreaterThan(500);
    for (const f of TRACKED.filter(x => x.startsWith('.github/'))) {
      for (const n of LIVE_ADDRESSING) if (setsVar(read(f), n)) armed.push(`${f} sets ${n}`);
    }
    expect(
      armed,
      'Something now supplies a live address that SHARED_ONLY_THROUGH_IMPORTED_CODE records as '
      + 'never supplied. GOOD NEWS if deliberate — but a collected module can now write to that '
      + 'pod or that database, which makes it a fifth entry in SHARED_LIVE_EXTERNALS, not a '
      + 'line in that list. Never relax this.',
    ).toEqual([]);
  });

  it('holds the single-module externals at one module each', () => {
    // These ARE live and external — a real Postgres, a real FoundationDB — and are absent only
    // because one module each reaches them. That is a measurement, so it is measured: a second
    // reader means the registry needs a fifth entry, and this is where that is noticed.
    for (const e of LIVE_BUT_NOT_SHARED) {
      const readers = ENV_READERS.get(e.name) ?? [];
      expect(readers, `${e.name} (${e.what}) is now read by ${readers.length} modules`).toHaveLength(1);
      expect(claimed.has(e.name)).toBe(false);
    }
  });

  it('finds no collected module passing a non-loopback literal address to a dial', () => {
    // The other half of completeness. The rule above sees externals reached through an
    // environment variable; this sees one wired in as a literal, reachable with no switch at
    // all.
    //
    // ★★ IT READS THE CALL, NOT THE LINE, AND THE LINE VERSION WAS FALSE IN THE ONE DIRECTION
    // THAT MATTERS. What this replaced tested `DIALS` and `URLRE` against the SAME LINE, so
    //
    //     await fetch(
    //       'https://someone-elses-service.example.net/x',
    //     );
    //
    // — one line break — was invisible, while the registry's header stated flatly that "no
    // collected module dials a non-loopback literal address at all". Driven both ways below and
    // in `dialRegions`' own non-vacuity test.
    //
    // Scope is the whole difficulty. "No module CONTAINS a non-loopback literal URL" is
    // unusable: measured on 843fc4fa, 170 of the 329 collected modules carry one, across 80
    // distinct hosts — allowlist fixtures, SSRF cases, xAPI verb IRIs, JSON-LD contexts. So the
    // region scanned is the call's ARGUMENTS, matched by parenthesis over `views().shape`.
    const flagged: string[] = [];
    for (const f of COLLECTED) {
      for (const r of dialRegions(read(f))) {
        for (const host of literalHosts(r.text)) flagged.push(`${f}:${r.line} dials ${host}`);
      }
    }
    expect(
      flagged,
      'A collected module hands a literal public address to a dial. If it reaches something '
      + 'live that a second module also reaches, it is a fifth entry in SHARED_LIVE_EXTERNALS; '
      + 'if it reaches something live that only it reaches, it belongs in LIVE_BUT_NOT_SHARED.',
    ).toEqual([]);
  });

  it('actually finds the calls it is scanning, and sees one split across lines', () => {
    // ★ THE NON-VACUITY ANCHOR, and it is the whole reason to trust the empty result above. A
    // scanner that found ZERO call sites would report exactly the same clean census, and that
    // is not a hypothetical failure — it is what the quote-only scanner did to three of these
    // by desynchronising on a character class.
    let regions = 0;
    const unclosed: string[] = [];
    for (const f of COLLECTED) {
      for (const r of dialRegions(read(f))) {
        regions += 1;
        if (!r.closed) unclosed.push(`${f}:${r.line}`);
      }
    }
    expect(regions).toBeGreaterThan(80);
    // ★ AND THE SCANNER STILL UNDERSTANDS EVERY FILE IT READ. An unclosed region means no
    // matching parenthesis was found, which is what a desynchronised scan looks like from the
    // outside — 113 regions all closed on 843fc4fa, against 3 unclosed the moment regex
    // tracking is removed from `views()`.
    expect(unclosed, 'a dial region ran to end-of-file: views() lost its place in these files')
      .toEqual([]);

    // And the defect this test exists for, on a sample rather than by argument: the same call,
    // written across three lines, must still be seen. The old same-line scan returns [] here.
    const split = [
      'async function go() {',
      '  const r = await fetch(',
      "    'https://someone-elses-service.net/ingest',",
      "    { method: 'POST' },",
      '  );',
      '  return r;',
      '}',
    ].join('\n');
    const seen = dialRegions(split).flatMap(r => literalHosts(r.text));
    expect(seen).toEqual(['someone-elses-service.net']);
    expect(split.split('\n').filter(l => /\bfetch\s*\(/.test(l) && /https?:\/\//.test(l))).toEqual([]);

    // The discards are discards, not an empty matcher: loopback, a bare label and the reserved
    // namespaces all pass through the same region scan and come back with nothing.
    expect(dialRegions("fetch('http://127.0.0.1:9/x');").flatMap(r => literalHosts(r.text))).toEqual([]);
    expect(dialRegions("fetch('http://gate.example.com/x');").flatMap(r => literalHosts(r.text))).toEqual([]);
    expect(dialRegions("fetch('http://css-internal/x');").flatMap(r => literalHosts(r.text))).toEqual([]);
    // A URL in a comment above a dial is not an argument to it.
    expect(dialRegions("// see https://docs.example.net/x\nfetch(url);").flatMap(r => literalHosts(r.text))).toEqual([]);
  });
});

describe('the census sees the idioms this repo actually writes', () => {
  // ★★ THE ROUTE THAT DEFEATED THE FIRST CENSUS, NOW A TEST. Both fingerprints were written as
  // /from\s+'[^']*real-pod-gate\.js'/ — single quotes, `from` only. DRIVEN both ways on the real
  // tree: with agent-collective's tier8 specifier rewritten to double quotes, the old regex
  // returns false against that file's text and the one built below returns true, and the whole
  // census stayed green through the rewrite. `await import(...)` is the idiom THIS file uses.
  // These are the samples; the production fingerprints come from the same two functions.
  const fp = helperImport('real-pod-gate');
  const cases: readonly [string, string][] = [
    ['single quotes', "import { openRealPod } from '../../_shared/tests/real-pod-gate.js';"],
    ['double quotes', 'import { openRealPod } from "../../_shared/tests/real-pod-gate.js";'],
    ['backtick specifier', 'const g = await import(\x60./real-pod-gate.js\x60);'],
    ['dynamic import', "const g = await import('./real-pod-gate.js');"],
    ['dynamic import, double', 'const g = await import("./real-pod-gate.js");'],
    ['require', "const g = require('../../_shared/tests/real-pod-gate.js');"],
    ['re-export', "export { openRealPod } from '../../_shared/tests/real-pod-gate.js';"],
  ];
  for (const [name, sample] of cases) {
    it(`matches a ${name} import of the gate`, () => expect(fp.test(sample)).toBe(true));
  }

  it('does not match a module whose name merely resembles the gate', () => {
    expect(fp.test("import x from './not-real-pod-gateway.js';")).toBe(false);
    expect(fp.test("import x from './real-pod-gate.ts';")).toBe(false);
  });

  it('distinguishes a READ of an env var from a mention of its name', () => {
    const re = envRead('SCORM_CLOUD_KEY');
    expect(re.test("const k = process.env['SCORM_CLOUD_KEY'];")).toBe(true);
    expect(re.test('const k = process.env["SCORM_CLOUD_KEY"];')).toBe(true);
    expect(re.test('const k = process.env.SCORM_CLOUD_KEY;')).toBe(true);
    // What made the SCORM fingerprint narrow in the first place: a workflow audit carries the
    // literal name and dials nothing.
    expect(re.test("expect(wf).toMatch(/SCORM_CLOUD_KEY/);")).toBe(false);
    expect(re.test('// SCORM_CLOUD_KEY is set from a repository secret')).toBe(false);
    // A prefix is not the name.
    expect(envRead('SCORM_CLOUD_KEY').test('process.env.SCORM_CLOUD_KEY_OLD')).toBe(false);
  });

  it('sees a DESTRUCTURED read, which is how a sixth pod suite got past the whole census', () => {
    // ★★ THE ROUTE A REVIEWER WALKED THROUGH. `const { INTEREGO_POD_WRITE_SECRET } =
    // process.env;` is the ordinary idiom for taking several names at once, and the two
    // property-access branches see nothing in it. The reviewer wrote a full sixth pod suite
    // that read the real write credential that way and PUT to the live shared container; the
    // pod census reported five consumers and stayed green. No module the census scans
    // destructures `process.env` — measured on 843fc4fa, the only occurrences under the
    // collected roots are the samples in the string literals just below, in a file the census
    // excludes from itself — so the hole was not findable by scanning; it had to be walked
    // through.
    const re = envRead('INTEREGO_POD_WRITE_SECRET');
    expect(re.test('const { INTEREGO_POD_WRITE_SECRET } = process.env;')).toBe(true);
    expect(re.test('const { FOXXI_POD_WRITE_SECRET, INTEREGO_POD_WRITE_SECRET } = process.env;')).toBe(true);
    expect(re.test('const {\n  INTEREGO_POD_WRITE_SECRET,\n} = process.env;')).toBe(true);
    expect(re.test('const { INTEREGO_POD_WRITE_SECRET: secret } = process.env;')).toBe(true);
    expect(re.test("const { INTEREGO_POD_WRITE_SECRET = '' } = process.env;")).toBe(true);
    // And it is still a READ of THIS name, not of a lookalike or of some other object.
    expect(re.test('const { INTEREGO_POD_WRITE_SECRET_OLD } = process.env;')).toBe(false);
    expect(re.test('const { INTEREGO_POD_WRITE_SECRET } = someOtherObject;')).toBe(false);
    expect(re.test('// INTEREGO_POD_WRITE_SECRET is destructured elsewhere')).toBe(false);
  });

  it('collects destructured names into the completeness census too', () => {
    // The fingerprints and the "every shared name is accounted for" rule are two independent
    // scans over the same tree. Widening only the first would have left a name read by two
    // suites that both destructure unregistered AND unnoticed — the same defect one door along.
    expect([...envNamesIn('const { A_ONE, B_TWO: local } = process.env;')].sort())
      .toEqual(['A_ONE', 'B_TWO']);
    expect([...envNamesIn("const { C_THREE = 'x' } = process.env;")]).toEqual(['C_THREE']);
    expect([...envNamesIn('const { ...rest } = process.env;')]).toEqual([]);
    // The three spellings compose rather than replacing one another.
    expect([...envNamesIn("process.env.D_FOUR; process.env['E_FIVE']; const { F_SIX } = process.env;")].sort())
      .toEqual(['D_FOUR', 'E_FIVE', 'F_SIX']);
  });
});

describe('the exemption list is load-bearing', () => {
  // ★ IT WAS DEAD CODE, AND ITS JUSTIFICATION WAS FALSE. Emptying the old `CENSUS_EXEMPT`
  // changed nothing, and the reason is visible in the old fingerprints rather than needing a
  // run: they were `/from\s+'[^']*real-pod-gate\.js'/`, and the only route that file had into
  // the gate was `await import('./real-pod-gate.js')`, which has no `from`. The exemption
  // excused something that was never being counted.
  //
  // ★★ NOW IT IS LOAD-BEARING, AND THAT HALF IS DRIVEN, NOT ARGUED. Emptying
  // IMPORTS_BUT_NEVER_DIALS on this tree fails THREE censuses — pod (6 vs 5), lrsql (4 vs 3)
  // and scorm-cloud (3 vs 2) — because this file imports the gate, asserts on `localhost:8080`
  // in the closure-resolution test above, and carries `process.env['SCORM_CLOUD_KEY']` in the
  // sample proving `envRead` tells a read from a mention. Both directions are held: an
  // entry that has stopped matching anything is red, and an entry the registry also calls a
  // consumer is red.
  it('excuses only modules a fingerprint really catches', () => {
    for (const f of IMPORTS_BUT_NEVER_DIALS) {
      expect(COLLECTED, `${f} is exempted but is not a collected module`).toContain(f);
      const hit = SHARED_LIVE_EXTERNALS.some(e => e.fingerprints.some(re => closureHas(f, re)));
      expect(hit, `${f} is exempted from a census that would not have caught it anyway`).toBe(true);
    }
  });

  it('never excuses a module the registry also calls a consumer', () => {
    for (const e of SHARED_LIVE_EXTERNALS) {
      for (const f of e.touchedBy) expect(IMPORTS_BUT_NEVER_DIALS).not.toContain(f);
    }
  });
});

describe('the switches the registry advertises are switches every consumer reads', () => {
  // ★ A CONTROL NOBODY READS IS WORSE THAN NO CONTROL: an operator who sets it believes the
  // resource is off. Every name this registry advertises must be an actual `process.env` READ
  // in the code each consumer of that external executes.
  //
  // ★★ THE PREVIOUS VERSION OF THIS TEST ASKED THE QUESTION OF ONE ENTRY OUT OF FOUR. It built
  // one string out of `real-pod-gate.ts` and `pod-target.ts` and checked POD's seven names
  // against it, so lrsql, scorm-cloud and public-relay had no such check at all — driven by the
  // reviewer, replacing `lrsql-gate.ts`'s off switch with a literal `false` went undetected.
  //
  // ★★ AND THE OBVIOUS GENERALISATION REINTRODUCES THE SAME BLINDNESS ONE LEVEL UP. "The name
  // is read SOMEWHERE among this entry's consumers" keeps `SKIP_LRSQL_TESTS` accounted for by
  // lrs-adapter's tier8, which reads it directly, while tier3 and tier3b stop honouring it
  // entirely. So the rule is PER CONSUMER, over each module's own text UNIONED with the helpers
  // it imports — which is what makes the gate count for the suites that reach it through
  // `lrsql-gate.ts` without naming the variable themselves.
  //
  // The consequence is that a genuine asymmetry cannot be averaged away: it has to be written
  // into `switchExceptions` with a reason, and the first one that had to be written turned out
  // to record a real gap in CI's fail-closed guarantee rather than a formality.
  //
  // ★ WHY AN ENV READ AND NOT `toContain(name)`. A name appearing only in PROSE satisfies
  // `toContain` — demonstrated on the previous version by deleting the
  // `process.env['AZURE_CSS_BASE']` read from pod-target.ts, which left it green. Comment lines
  // are dropped and the match is a read, in all three spellings including destructuring.
  for (const ext of SHARED_LIVE_EXTERNALS) {
    const advertised = [
      ...ext.armedBy.map(n => ['armedBy', n] as const),
      ...ext.offSwitch.map(n => ['offSwitch', n] as const),
      ...ext.retargetedBy.map(n => ['retargetedBy', n] as const),
    ];
    for (const [kind, name] of advertised) {
      it(`${ext.id}: ${name} (${kind}) is read by every consumer that is not excused`, () => {
        const excused = ext.switchExceptions.filter(x => x.name === name).map(x => x.module);
        const missing = ext.touchedBy
          .filter(f => !excused.includes(f))
          .filter(f => !envNamesOf(f).has(name));
        expect(
          missing,
          `${name} is advertised by the registry for ${ext.id}, but ${missing.join(', ')} `
          + 'never READS it — itself or through any helper it imports. Either the switch has '
          + 'stopped working for that suite, or the asymmetry is deliberate and belongs in '
          + `${ext.id}'s switchExceptions with a reason.`,
        ).toEqual([]);
      });
    }

    it(`${ext.id}: every switch exception is real and still needed`, () => {
      // Both directions, the same discipline as IMPORTS_BUT_NEVER_DIALS. An exception naming a
      // module that DOES read the name is an excuse that has outlived its reason, and it is
      // exactly the place the next false record would land.
      for (const x of ext.switchExceptions) {
        expect(ext.touchedBy, `${x.module} is excused but is not a consumer of ${ext.id}`)
          .toContain(x.module);
        expect([...ext.armedBy, ...ext.offSwitch, ...ext.retargetedBy])
          .toContain(x.name);
        expect(
          envNamesOf(x.module).has(x.name),
          `${x.module} now reads ${x.name}. Delete the exception rather than leaving an excuse `
          + 'in place for something that is no longer true.',
        ).toBe(false);
        expect(x.why.length).toBeGreaterThan(60);
      }
    });
  }

  it('reads the deciding modules as code, not as prose', () => {
    // The anchor that makes every assertion above non-vacuous: a scanner that returned '' would
    // turn each of them into a silent failure to find. Checked on the pod's two deciding
    // helpers, since those are the ones the census reaches only through an import chain.
    const code = ['applications/_shared/tests/real-pod-gate.ts', 'applications/_shared/tests/pod-target.ts']
      .map(f => codeOf(read(f))).join('\n');
    expect(code).toContain('export function podWriteHeaders');
    expect(code).toContain('export async function openRealPod');
    expect(envNamesOf('applications/_shared/tests/tier2-azure-css.test.ts').size).toBeGreaterThan(5);
    // And `views()` does what it says on samples, both directions.
    expect(codeOf("// process.env['NOPE']\nconst a = 1;")).not.toContain('NOPE');
    expect(codeOf("/* process.env['NOPE'] */ const a = 1;")).not.toContain('NOPE');
    expect(codeOf("const u = 'https://gate.example/x'; // trailing")).toContain('https://gate.example/x');
    expect(codeOf("const k = process.env['KEEP'];")).toContain('KEEP');
  });

  it('does not lose its place on a regex literal holding an unpaired quote', () => {
    // ★ THE REGRESSION GUARD FOR THE DEFECT THAT MOTIVATED ALL OF THIS, driven on THIS file
    // rather than a sample — `ENV_READ_ANY` above is the real character class that broke the
    // quote-only scanner, after which every comment survived as "code".
    //
    // ★★ BOTH PROBES ARE ASSEMBLED AT RUN TIME, AND THAT IS THE TEST WORKING RATHER THAN A
    // flourish. `codeOf` KEEPS string literals, so a probe written as one literal is present in
    // the file it is searching: the negative assertion fails against its own text and the
    // positive one passes against its own text. Written the obvious way this test failed for
    // that reason on the first run — a check that passes (or fails) for two possible reasons is
    // evidence for neither, and here the second reason was the assertion looking at itself.
    const inAComment = ['WORSE', 'THAN', 'NO', 'CONTROL'].join(' ');
    const inCode = 'function ' + 'dropComment' + 'Lines';
    const self = codeOf(read('applications/_shared/tests/shared-live-externals.test.ts'));
    expect(read('applications/_shared/tests/shared-live-externals.test.ts')).toContain(inAComment);
    expect(self, 'the scanner desynchronised: prose after ENV_READ_ANY survived as code')
      .not.toContain(inAComment);
    // Non-vacuity: real code from beyond that same point is still there.
    expect(self).toContain(inCode);
  });

  it('has an off switch on the pod at all', () => {
    // Its absence is what made the skip a side effect of a missing credential rather than a
    // decision anyone could state.
    expect(POD.offSwitch.length).toBeGreaterThan(0);
  });
});

describe('CI runs the pod suites as permanent skips', () => {
  // ★ MEASURED FROM THE TREE, NOT RESTATED FROM THE REGISTRY. The previous test under this name
  // asserted `expect(POD.armedInCi).toEqual([])` — a constant compared with itself, which could
  // not have failed for anything CI did. The claim has two halves and both are measured here:
  // nothing arms the pod, and there IS a step that would run all 22 bodies if something did.
  const WHOLE_TREE = '.github/workflows/bridge-typecheck.yml';

  it('has a workflow step that runs the whole tree with no arguments', () => {
    const lines = stripYamlComments(read(WHOLE_TREE)).split('\n');
    const bare = lines.filter(l => /^\s*(?:-\s*)?run:\s*npx vitest run\s*$/.test(l));
    expect(
      bare.length,
      `${WHOLE_TREE} no longer contains a bare \`run: npx vitest run\`. If the whole-tree step `
      + 'moved, point this at its new home; if it was deleted, the five pod suites are no '
      + 'longer collected on every pull request and this registry is describing something else.',
    ).toBe(1);
  });

  it('arms nothing that would make those suites run there', () => {
    for (const f of TRACKED.filter(x => x.startsWith('.github/'))) {
      for (const name of POD.armedBy) {
        expect(
          setsVar(read(f), name),
          `${f} sets ${name}. GOOD NEWS if deliberate — CI is arming the pod. Update `
          + "POD.armedInCi and the prose in shared-live-externals.ts; never relax this.",
        ).toBe(false);
      }
    }
  });
});

/**
 * The ARGUMENTS of every `beforeAll(` a module really contains, parenthesis-matched over
 * `views().shape`.
 *
 * ★★ THIS REPLACES A REGEX THAT PROVED ALMOST NOTHING. The assertion was
 *
 *     expect(text).toMatch(/beforeAll\([^)]*(?:.|\n)*?openRealPod\(\)/)
 *
 * and `(?:.|\n)*?` spans the WHOLE FILE. It therefore said only that the eleven characters
 * `beforeAll(` appear somewhere — anywhere — before the six characters `openRealPod()`, with no
 * containment of any kind between them. A suite whose header comment mentioned `beforeAll(` and
 * which then called `openRealPod()` at module scope, in a plain `it()`, or not at all in a way
 * the gate could see, satisfied it. The property the test names — "opens the gate in
 * `beforeAll`" — was never being checked, and it is the property that makes a thrown gate fail
 * the whole file instead of one body.
 *
 * Heads come from `shape`, so `beforeAll(` in a comment or a string is not one; the arguments
 * come from `code`, so the call inside them is readable. Nothing is returned empty: a module
 * with no real `beforeAll(` and a run of unbalanced parentheses both THROW, because a silent
 * empty result is the failure this whole file is about.
 */
function beforeAllArguments(file: string): string[] {
  const src = read(file);
  const { code, shape } = views(src);
  const out: string[] = [];
  const HEAD = 'beforeAll(';
  for (let at = shape.indexOf(HEAD); at >= 0; at = shape.indexOf(HEAD, at + 1)) {
    const open = at + HEAD.length - 1;
    let depth = 0;
    let closed = -1;
    for (let i = open; i < shape.length; i += 1) {
      if (shape[i] === '(') depth += 1;
      else if (shape[i] === ')') {
        depth -= 1;
        if (depth === 0) { closed = i; break; }
      }
    }
    if (closed < 0) throw new Error(`${file}: unbalanced parentheses after a beforeAll(`);
    out.push(code.slice(open + 1, closed));
  }
  if (out.length === 0) throw new Error(`${file}: no beforeAll( outside comments and strings`);
  return out;
}

/**
 * The body of the `it(...)` that carries `expect(DECLARED_SKIPS…)`, by brace-matching.
 *
 * Not a parser, and it does not need to be: the five bodies contain template literals whose
 * `${…}` braces are balanced and no brace inside a plain string. The caller asserts the result
 * still contains the assertion and is shorter than the file, so a mis-match is red rather than
 * quietly empty.
 */
function preconditionBody(text: string): string {
  const at = text.indexOf('expect(DECLARED_SKIPS');
  if (at < 0) throw new Error('no DECLARED_SKIPS assertion in this suite');
  const itAt = text.lastIndexOf('it(', at);
  const open = text.indexOf('{', text.indexOf('=>', itAt));
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const body = text.slice(open, i + 1);
        if (!body.includes('expect(DECLARED_SKIPS')) throw new Error('brace match lost the assertion');
        if (body.length >= text.length) throw new Error('brace match returned the whole file');
        return body;
      }
    }
  }
  throw new Error('unbalanced braces while extracting the precondition body');
}

/** Word-boundary probes for the ordering guard, named so the guard reads as its own rule. */
const RETURN_STMT = /\breturn\b/;
const IF_HEAD = /\bif\s*\(/;
const MENTIONS_POD = /\bpod\b/;

describe('every pod suite still routes through the gate', () => {
  // A gate is not a deletion: these keep the five suites going through openRealPod() rather
  // than deciding for themselves.
  //
  // ★ WHAT THESE ARE AND ARE NOT, because the version they replace claimed more than it could
  // see. Both are TEXT checks over each suite's own bytes, and the previous one was only
  // `toContain('openRealPod')` + `toContain('DECLARED_SKIPS')` — satisfied by a file that
  // mentions both and evaluates neither, which is exactly what lrs-adapter's tier8 was.
  //
  // The first below sees ROUTING: the gate is imported, called inside a `beforeAll`, and
  // `pod-target` is not imported around it. The second sees the ONE ordering property that is
  // decidable from text — that no `return` reaches the pod assertion under a condition about
  // something else. Between them they would have caught the tier8 defect.
  //
  // What neither can see is whether the assertion is REACHED at run time in general: a
  // `describe.skipIf`, a thrown helper, a body that never runs. The evidence for that is the
  // run itself, and it is the reason the header records the five suites' summary — after the
  // fix all five print a pod line where four did before.
  for (const f of POD.touchedBy) {
    it(`${f} opens the gate in beforeAll and does not bypass it`, () => {
      const text = read(f);
      expect(helperImport('real-pod-gate').test(text)).toBe(true);
      // CONTAINMENT, not adjacency — see `beforeAllArguments`, which replaced a regex whose
      // `(?:.|\n)*?` spanned the whole file and so asserted only that the word `beforeAll`
      // appeared somewhere above the word `openRealPod`, comments included.
      const inBeforeAll = beforeAllArguments(f);
      expect(
        inBeforeAll.some(args => args.includes('openRealPod()')),
        `${f} calls openRealPod() somewhere, but not inside a beforeAll(...) callback. That is `
        + 'load-bearing: a gate that throws only fails the whole file when it throws in '
        + 'beforeAll, and outside one the throw reds a single body while the rest go green.',
      ).toBe(true);
      expect(text).toContain('DECLARED_SKIPS');
      // Importing pod-target directly is the documented bypass: it hands a suite `probePod()`,
      // whose `{ usable: false }` collapses a declared opt-out and a vanished pod into one
      // green skip. That is the exact state openRealPod() exists to make impossible.
      expect(helperImport('pod-target').test(text)).toBe(false);
    });

    it(`${f} cannot return past its own pod assertion for an unrelated reason`, () => {
      // ★★ THE ONE STRUCTURAL THING TEXT *CAN* SEE ABOUT ORDER, and it is exactly the defect
      // that got past the previous `toContain('DECLARED_SKIPS')`. In lrs-adapter's tier8 the
      // precondition bailed out inside `if (!lrsUp) { …; return; }` — a condition about the LRS
      // — before ever reaching the pod assertion, so on the normal run that assertion never
      // executed. The rule: every `return` on the way to `expect(DECLARED_SKIPS…)` must be
      // guarded by a condition that mentions `pod`. `if (pod.ok) return;` passes and is what
      // the other four suites do; `if (!lrsUp) … return;` does not, because the two
      // dependencies are separate values and one must never disarm the other's check.
      //
      // Comments are stripped FIRST, and that is not tidiness: four of the five suites carry
      // the phrase "every probePod() return path" in a comment above the guard, so the raw text
      // reports an unconditional return in every one of them. A scan that reads prose as code
      // is the same mistake as a scan that reads prose as a variable read, one paragraph up.
      const body = codeOf(preconditionBody(read(f)));
      // ★ THE ANCHOR, and it is not ceremony: `views()` is stateful and CAN lose its place (see
      // `dropCommentLines`). If it ate the assertion, `indexOf` returns -1, `upTo` becomes ''
      // and this test finds no returns and passes — vacuous, in a file whose whole subject is
      // vacuous passes.
      expect(body, `${f}: comment stripping lost the DECLARED_SKIPS assertion`)
        .toContain('expect(DECLARED_SKIPS');
      const upTo = body.slice(0, body.indexOf('expect(DECLARED_SKIPS'));
      const lines = upTo.split('\n');
      lines.forEach((line, i) => {
        if (!RETURN_STMT.test(line)) return;
        const guard = IF_HEAD.test(line) ? line : lines.slice(0, i).reverse().find(l => IF_HEAD.test(l));
        const named = guard === undefined ? '(none — an unconditional return)' : guard.trim();
        expect(
          guard !== undefined && MENTIONS_POD.test(guard),
          `${f}: the return on line ${i + 1} of the precondition body is reached without a `
          + 'condition that mentions `pod`, so the DECLARED_SKIPS assertion below it can be '
          + `skipped for a reason that has nothing to do with the pod. Guard: ${named}`,
        ).toBe(true);
      });
    });
  }
});

describe('the pod gate, composed with the real pod-target', () => {
  // Named rather than indexed off the registry arrays: a reordered array would silently
  // repoint these at the wrong variable, so each is checked against the registry instead.
  const CREDENTIAL = 'INTEREGO_POD_WRITE_SECRET';
  const RETARGET_HOST = 'INTEREGO_POD_BASE';
  it('uses variables the registry actually records', () => {
    expect(POD.armedBy).toContain(CREDENTIAL);
    expect(POD.retargetedBy).toContain(RETARGET_HOST);
  });

  // Every name the gate consults, stubbed in every case, so an ambient credential cannot
  // change an outcome. `undefined` DELETES rather than blanks.
  const OFF = {
    ...Object.fromEntries(POD.armedBy.map(n => [n, undefined])),
    ...Object.fromEntries(POD.offSwitch.map(n => [n, undefined])),
    ...Object.fromEntries(POD.retargetedBy.map(n => [n, undefined])),
  } as Record<string, string | undefined>;

  async function gateWith(env: Record<string, string | undefined>) {
    for (const [k, v] of Object.entries({ ...OFF, ...env })) vi.stubEnv(k, v);
    vi.resetModules();
    return import('./real-pod-gate.js');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('skips, naming the host and the variable, when no credential is configured', async () => {
    const { openRealPod } = await gateWith({});
    const gate = await openRealPod();
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.declaredSkip).toBe('INTEREGO_POD_WRITE_SECRET unset');

    // The gate's terse verdict is paired with probePod()'s prose reason, which is the thing a
    // human actually reads on stderr — it must carry BOTH the variable to set and the host it
    // would be set against. The reason it replaced named an unreachable host that had been
    // deliberately deleted: true, and useless, because nothing a maintainer could do would
    // make it reachable.
    const { probePod, POD_HOST } = await import('./pod-target.js');
    const reason = (await probePod()).reason;
    expect(reason).toContain(CREDENTIAL);
    expect(reason).toContain(POD_HOST);
  });

  for (const off of POD.offSwitch) {
    // ★ THE BRANCH THAT HAD NEVER BEEN EVALUATED. Until this ran, the skip was only ever
    // observed on a tree with no credential, so "we skipped" was equally explained by the off
    // switch working and by the credential being absent. Two possible reasons is evidence for
    // neither. Here the credential IS present and the pod is pointed at a refusing address, so
    // nothing but the off switch can produce a declared skip — reaching probePod() at all
    // would THROW rather than skip.
    //
    // ★★ AND EVERY SPELLING, BECAUSE THE CONTRACT IS NOW SPELLINGS AND NOT A LITERAL. This is
    // the defect: the switch was advertised by NAME everywhere and compared against '1', so
    // `SKIP_POD_TESTS=true` with a credential set fell through and threw. Each of these cases
    // fails on the old code.
    for (const spelling of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
      it(`honours ${off}=${JSON.stringify(spelling)} as a HARD off switch even with a credential set`, async () => {
        const { openRealPod } = await gateWith({
          [off]: spelling,
          [CREDENTIAL]: 'not-a-real-secret',
          [RETARGET_HOST]: 'http://127.0.0.1:9',
        });
        const gate = await openRealPod();
        expect(gate.ok).toBe(false);
        if (gate.ok) return;
        expect(gate.declaredSkip).toBe('SKIP_POD_TESTS/SKIP_AZURE_TESTS declared');
      });
    }

    for (const spelling of ['0', 'false', 'no', 'off', '']) {
      it(`treats ${off}=${JSON.stringify(spelling)} as declining the skip, not requesting it`, async () => {
        // The other direction, and it is not symmetry for its own sake: `''` is what a workflow
        // writes for an unset secret, and reading that as "skip" would silently empty the five
        // suites on a runner that meant to arm them.
        const { openRealPod } = await gateWith({
          [off]: spelling,
          [CREDENTIAL]: 'not-a-real-secret',
          [RETARGET_HOST]: 'http://127.0.0.1:9',
        });
        await expect(openRealPod()).rejects.toThrow(/Refusing to skip/);
      }, 20_000);
    }

    it(`refuses to guess at ${off}=ture`, async () => {
      // A typo must be louder than a silent false. Silent-false is precisely how a switch that
      // nobody reads gets believed in — the operator sets it, sees green, and concludes it
      // worked. The message names the spellings it would have accepted.
      const { openRealPod } = await gateWith({ [off]: 'ture', [CREDENTIAL]: 'not-a-real-secret' });
      await expect(openRealPod()).rejects.toThrow(/not a value this gate understands/);
    });
  }

  it('attributes the skip to the off switch, not the missing credential, when both apply', async () => {
    // ★ ADDED BECAUSE A MUTANT SURVIVED. Moving the off-switch check BELOW the credential check
    // in real-pod-gate.ts left every other case here green: with a credential set both orders
    // agree, and with none set the tests above only ever asked about the credential. The
    // difference shows only when BOTH apply, and it is not cosmetic — reporting "credential
    // unset" to an operator who explicitly turned these off tells them to go configure a
    // secret they deliberately declined to use. That is the same class as the skip reason this
    // area started from: accurate about something, and pointing at the wrong thing to fix.
    const { openRealPod } = await gateWith({ [POD.offSwitch[0]!]: '1' });
    const gate = await openRealPod();
    expect(gate.ok).toBe(false);
    if (gate.ok) return;
    expect(gate.declaredSkip).toBe('SKIP_POD_TESTS/SKIP_AZURE_TESTS declared');
  });

  it('REFUSES to skip when a credential is set and the pod is not there', async () => {
    // The other half of the same property, and the reason the off switch has to exist at all:
    // with a credential configured, somebody meant these round-trips to run, so an absent pod
    // is a failure. 127.0.0.1:9 is the discard port — this provokes the throw locally and
    // sends no packet off the machine.
    const { openRealPod } = await gateWith({
      [CREDENTIAL]: 'not-a-real-secret',
      [RETARGET_HOST]: 'http://127.0.0.1:9',
    });
    await expect(openRealPod()).rejects.toThrow(/Refusing to skip/);
  }, 20_000);

  it('accepts the second credential spelling as arming, not just the first', async () => {
    // pod-target accepts INTEREGO_POD_WRITE_SECRET or FOXXI_POD_WRITE_SECRET, and the gate
    // detects the credential through podWriteHeaders() rather than re-reading one name, so
    // that the two files cannot disagree about what is configured. Asserted, because "the gate
    // says unset while the suite below it wrote successfully" is the shape this area is made of.
    const { openRealPod } = await gateWith({
      FOXXI_POD_WRITE_SECRET: 'not-a-real-secret',
      [RETARGET_HOST]: 'http://127.0.0.1:9',
    });
    await expect(openRealPod()).rejects.toThrow(/Refusing to skip/);
  }, 20_000);
});

describe('the pool config points at the registry', () => {
  it('names shared-live-externals.ts inside vitest.config.ts', () => {
    // ★ WHERE THE NEXT READER IS STANDING. The question "can we drop singleFork?" is asked
    // while looking at `poolOptions` and nowhere else, and the answer turns entirely on a
    // helper two directories away that no grep over `*.test.ts` reaches. This keeps the
    // pointer alive: delete it and the reason for the pool setting becomes invisible again.
    //
    // The previous version of this comment said vitest.config.ts "points here from inside the
    // poolOptions block" while no such pointer existed anywhere in the file. It does now.
    const cfg = read('vitest.config.ts');
    // ★ THE POSITION IS THE POINT, so it is checked as a position and not as presence. The
    // first version of this asserted `indexOf(path) > indexOf('poolOptions')`, which passed —
    // and passed for the wrong reason, because the prose above the block says the word
    // `poolOptions` too. A check with two possible reasons is evidence for neither. What has to
    // be true is that the pointer sits in the comment ATTACHED to the declaration, which is the
    // only text a reader of the pool setting has in front of them.
    const decl = cfg.indexOf('poolOptions: {');
    const attachedComment = cfg.slice(cfg.indexOf('reporters:'), decl);
    expect(decl).toBeGreaterThan(0);
    expect(
      attachedComment,
      'vitest.config.ts must name the registry in the comment attached to `poolOptions`, not '
      + 'merely somewhere in the file — the question this answers is asked while looking at '
      + 'that declaration.',
    ).toContain('applications/_shared/tests/shared-live-externals.ts');
  });
});
