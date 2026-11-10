/**
 * The shared chat-agent helpers (applications/_shared/chat-agent/chat-agent.js).
 *
 * Practice Evidence and Work Redesign serve /ui/app.js as `chatAgentJs() + '\n' + <their app.js>`,
 * so this one file has to be valid in both ways that text is run:
 *   - as a CLASSIC script: every jsdom harness evaluates /ui/app.js that way, and a top-level
 *     `import` or `export` there is a SyntaxError that takes every UI test down with it;
 *   - as an ES MODULE: browsers load it with type="module", where a top-level name the app also
 *     declares is an early error that no classic-script test can see.
 * Both are run here for real, against an app body that declares every name the shared file uses
 * internally. Then each helper is tested on its own.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { chatAgentJs } from '../chat-agent/index.js';
import { signedActPayload } from '../../../deploy/mcp-relay/signed-act.js';

const JS = readFileSync(new URL('../chat-agent/chat-agent.js', import.meta.url), 'utf8');

/**
 * The rule for an act tool that shows no sign_payload option, word for word as a prompt carries it: what to
 * do with a plain step, with a signed step, and with both, said in one sentence that names each once.
 */
const NO_OPTION = 'If your act tool has no sign_payload option, ';
const PLAIN_RULE = 'leave sign_payload out of a plain step\'s call (do not sign it or wrap it)';
const SIGNED_RULE = 'do a signed step in two calls: call the connector\'s sign_request tool '
  + 'with payload as its only argument, set to the step\'s payload, then call act with the same descriptor_url and action_iri and with payload set to exactly '
  + 'the _signature and _signed_payload it returned, unchanged';
const FALLBACK = {
  plain: `${NO_OPTION}${PLAIN_RULE}.`,
  signed: `${NO_OPTION}${SIGNED_RULE}.`,
  both: `${NO_OPTION}${PLAIN_RULE}, and ${SIGNED_RULE}.`,
} as const;
/** How many times `part` occurs in `text`. */
const timesIn = (text: string, part: string): number => text.split(part).length - 1;
const EXPORTS = ['actPrompt', 'agentAppName', 'extractJsonObject', 'nonceRule', 'requestAsText'];

type Extracted = { readonly ok: true; readonly value: Record<string, unknown> } | { readonly ok: false; readonly why: string };
interface ChatAgent {
  actPrompt(spec: unknown): string;
  requestAsText(request: unknown, options?: unknown): string;
  extractJsonObject(text: unknown): Extracted;
  agentAppName(agentId: unknown, ownPrefix?: string, ownName?: string): string;
  readonly nonceRule: string;
}

/** The helpers, evaluated in this realm (so TypeError and plain objects compare as usual). */
const A = new Function(`${JS}\nreturn InteregoChatAgent;`)() as ChatAgent;

/** The nonce checks of the two sites that consume this file, read from their source so a change there is seen here. */
function nonceRegexIn(path: string): RegExp {
  const src = readFileSync(new URL(path, import.meta.url), 'utf8');
  const m = /const NONCE = \/(.+)\/;/.exec(src);
  if (!m?.[1]) throw new Error(`no NONCE regex in ${path}`);
  return new RegExp(m[1]);
}
const SITE_NONCES = [
  nonceRegexIn('../../practice-evidence/src/records.ts'),
  nonceRegexIn('../../work-redesign/src/records.ts'),
];

const SOURCE = ts.createSourceFile('chat-agent.js', JS, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

/** Every name the file declares at any depth, except the one it publishes. */
function declaredInside(): string[] {
  const names = new Set<string>();
  const visit = (n: ts.Node): void => {
    if ((ts.isFunctionDeclaration(n) || ts.isVariableDeclaration(n)) && n.name && ts.isIdentifier(n.name)) names.add(n.name.text);
    ts.forEachChild(n, visit);
  };
  visit(SOURCE);
  names.delete('InteregoChatAgent');
  return [...names].sort();
}

function runModule(text: string): { status: number | null; stdout: string; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'chat-agent-'));
  try {
    const file = join(dir, 'app.mjs');
    writeFileSync(file, text);
    const r = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 30_000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('chat-agent.js: one global, valid as a classic script and as a module', () => {
  it('declares exactly one top-level name, a const InteregoChatAgent, and nothing else', () => {
    expect(SOURCE.statements).toHaveLength(1);
    const st = SOURCE.statements[0];
    if (!st || !ts.isVariableStatement(st)) throw new Error('the only statement is not a variable statement');
    expect(st.declarationList.flags & ts.NodeFlags.Const).toBe(ts.NodeFlags.Const);
    expect(st.declarationList.declarations.map((d) => d.name.getText(SOURCE))).toEqual(['InteregoChatAgent']);
    // The helpers it is built from stay inside the IIFE.
    expect(declaredInside()).toEqual(expect.arrayContaining(['actPrompt', 'requestAsText', 'extractJsonObject', 'agentAppName', 'NONCE_RULE']));
  });

  it('publishes a frozen object with exactly the five helpers', () => {
    expect(Object.keys(A).sort()).toEqual(EXPORTS);
    expect(Object.isFrozen(A)).toBe(true);
    for (const k of ['actPrompt', 'requestAsText', 'extractJsonObject', 'agentAppName'] as const) expect(typeof A[k]).toBe('function');
    expect(typeof A.nonceRule).toBe('string');
  });

  it('has no import or export, no DOM, no network, no markup writing, no address and no vertical name', () => {
    expect(JS).not.toMatch(/^\s*(import|export)\b/m);
    expect(JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setAttribute\(/);
    expect(JS).not.toMatch(/import\(|<script/);
    expect(JS).not.toMatch(/\b(document|window|navigator|globalThis|localStorage|sessionStorage)\s*\./);
    expect(JS).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|EventSource|importScripts|sendBeacon)\s*\(/);
    expect(JS).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.-]+/);   // the e-mail pattern the sites' own tests ban
    expect(JS).not.toMatch(/practice.evidence|work.redesign|\bpev\b|\bwrd\b|urn:iep/i);
    expect(JS).not.toMatch(/\b(gpt-\d|o\d-|claude-\d|sonnet|opus|haiku|gemini-\d)/i);   // no model names
    // The sites' own app.js scans ban these in what they serve, which now starts with this file.
    for (const banned of ["setAttribute('style'", 'setAttribute("style"', '.innerHTML', '.outerHTML', 'eval(', 'new Function']) {
      expect(JS.includes(banned), banned).toBe(false);
    }
  });

  it('chatAgentJs() is the file, read once', () => {
    expect(chatAgentJs()).toBe(JS);
    expect(chatAgentJs()).toBe(chatAgentJs());
  });

  it('as a classic script, served ahead of an app, it adds nothing to window and the app sees InteregoChatAgent', () => {
    const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
    const w = dom.window;
    const before = new Set(Object.getOwnPropertyNames(w));
    const app = [
      // An app may keep its own helper with a name the shared file uses internally.
      "function actPrompt() { return 'the app'; }",
      "function agentWords(id) { return id ? InteregoChatAgent.agentAppName(id, 'site-', 'the web app') : 'Interego'; }",
      'window.__probe = { type: typeof InteregoChatAgent, keys: Object.keys(InteregoChatAgent).sort(), frozen: Object.isFrozen(InteregoChatAgent),',
      "  own: actPrompt(), shared: typeof InteregoChatAgent.actPrompt, who: agentWords('did:web:id.example:agents:chatgpt-u-pk-1') };",
    ].join('\n');
    w.eval(`${chatAgentJs()}\n${app}`);
    const added = Object.getOwnPropertyNames(w).filter((n) => !before.has(n)).sort();
    expect(added).toEqual(['__probe', 'actPrompt', 'agentWords']);   // the app's own names only
    const probe = (w as unknown as { __probe: Record<string, unknown> }).__probe;
    expect(JSON.parse(JSON.stringify(probe))).toEqual({
      type: 'object', keys: EXPORTS, frozen: true, own: 'the app', shared: 'function', who: 'ChatGPT',
    });
    // A const in evaluated text is scoped to that evaluation: why the sites concatenate rather than
    // evaluate the shared file separately.
    expect(w.eval('typeof InteregoChatAgent')).toBe('undefined');
    dom.window.close();
  });

  it('as a classic <script>, its one name is a global lexical binding, not a property, and its helpers stay hidden', () => {
    const ctx = vm.createContext({});
    const ownNames = (): string[] => Object.getOwnPropertyNames(vm.runInContext('globalThis', ctx)).sort();
    const before = ownNames();
    new vm.Script(JS, { filename: 'chat-agent.js' }).runInContext(ctx);
    expect(vm.runInContext('typeof InteregoChatAgent', ctx)).toBe('object');
    expect(ownNames()).toEqual(before);
    for (const n of declaredInside()) expect(vm.runInContext(`typeof ${n}`, ctx), n).toBe('undefined');
  });

  it('as an ES module, ahead of an app body that declares every name it uses inside, it loads and works', () => {
    const inside = declaredInside().filter((n) => !(n in globalThis));
    expect(inside.length).toBeGreaterThan(10);
    const body = [
      ...inside.map((n) => `function ${n}() { return 'app'; }`),
      'const appState = { mode: "demo" };',
      'process.stdout.write(JSON.stringify({',
      '  type: typeof InteregoChatAgent, keys: Object.keys(InteregoChatAgent).sort(), frozen: Object.isFrozen(InteregoChatAgent),',
      '  own: actPrompt(), mode: appState.mode,',
      "  who: InteregoChatAgent.agentAppName('did:web:id.example:agents:claude-code-u-pk-1'),",
      "  json: InteregoChatAgent.extractJsonObject('ok: {\"a\": 1}'),",
      '}));',
    ].join('\n');
    const r = runModule(`${chatAgentJs()}\n${body}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      type: 'object', keys: EXPORTS, frozen: true, own: 'app', mode: 'demo', who: 'Claude', json: { ok: true, value: { a: 1 } },
    });
  });

  it('the module check bites: an app that declares InteregoChatAgent again fails to load', () => {
    const r = runModule(`${chatAgentJs()}\nfunction InteregoChatAgent() {}\n`);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/SyntaxError/);
    expect(r.stderr).toMatch(/InteregoChatAgent/);
  });
});

/** The payload JSON of every step in a prompt, in order. */
function payloadsOf(prompt: string): Record<string, unknown>[] {
  return [...prompt.matchAll(/^ {3}payload: (\{.*\})$/gm)].map((m) => JSON.parse(m[1] ?? '{}') as Record<string, unknown>);
}

function random16(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  // randomInt is uniform over the alphabet; a byte taken modulo 62 is not.
  return Array.from({ length: 16 }, () => alphabet[randomInt(alphabet.length)]).join('');
}

/** A nonce made the way the prompt tells an assistant to make one. */
function nonceFrom(template: unknown, turn: number): string {
  return String(template).replace('<turn number, or 0>', String(turn)).replace('<16 new random letters or digits>', random16());
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(o);
  }
  return o;
}

describe('actPrompt', () => {
  const affordancesUrl = 'https://site.example/affordances';
  const podUrl = 'https://pod.example/alex/';
  const plainPayload = deepFreeze({ brief: '<the brief, as I typed it>' });
  const signedPayload = deepFreeze({ v: 1, action: 'https://site.example/ns/action/save-lines', pod_url: podUrl, nonce: 'abc', turnIndex: 3 });
  const prompt = A.actPrompt({
    intro: "Let's rehearse a conversation.",
    affordancesUrl, podUrl,
    steps: [
      { say: 'Read the brief.', actionIri: 'urn:example:action:read-brief', signed: false, payload: plainPayload },
      { say: 'Save both lines.', actionIri: 'urn:example:action:save-lines', signed: true, payload: signedPayload },
    ],
    rules: ['Never change my words.', '   ', 'Use the nextTurnIndex each result returns.'],
    outro: 'Wait for my first line.',
  });

  it('starts with the intro, ends with the outro, and states the act call shape once', () => {
    expect(prompt.startsWith("Let's rehearse a conversation.\n\n")).toBe(true);
    expect(prompt.endsWith('\n\nWait for my first line.')).toBe(true);
    expect(prompt).toContain('call the act tool of the Interego connector with');
    expect(prompt).toContain(`- descriptor_url: "${affordancesUrl}"`);
    expect(prompt).toContain('- action_iri: the action the step names, exactly as written');
    expect(prompt).toContain('- sign_payload: true or false, exactly as the step says');
    expect(prompt).toContain(`My storage address (pod_url): "${podUrl}"`);
    // The nonce rule's example is made from this prompt's own first signed step, never another name,
    // and that step has a turn (its payload carries turnIndex), so the example has a turn number.
    expect(prompt).toContain('Every signed payload carries a nonce: nonce = the step name, the turn number (or 0), then 16 random letters or digits');
    expect(prompt).toContain('For example save-lines-4-q8Xr2mVp7LkA9dTz, but make up new random letters for every call.');
    expect(prompt).not.toContain('read-items');
  });

  it('says per step whether it is plain (arguments at top level, no nonce) or signed', () => {
    expect(prompt).toContain([
      '1. Read the brief.',
      '   action_iri: "urn:example:action:read-brief"',
      '   sign_payload: false (plain: nothing is signed, and the arguments go at the top level of payload)',
      '   payload: {"brief":"<the brief, as I typed it>"}',
    ].join('\n'));
    expect(prompt).toContain([
      '2. Save both lines.',
      '   action_iri: "urn:example:action:save-lines"',
      '   sign_payload: true (signed: the connector signs this payload as me)',
    ].join('\n'));
    const [plain, signed] = payloadsOf(prompt);
    expect(plain).toEqual({ brief: '<the brief, as I typed it>' });
    // The action is the step's exact urn whatever the template said, and the nonce is the composed one, in place.
    expect(Object.keys(signed ?? {})).toEqual(['v', 'action', 'pod_url', 'nonce', 'turnIndex']);
    expect(signed).toEqual({
      v: 1, action: 'urn:example:action:save-lines', pod_url: podUrl,
      nonce: 'save-lines-<turn number, or 0>-<16 new random letters or digits>', turnIndex: 3,
    });
    expect(prompt).toContain('   payload.action is exactly this urn: "urn:example:action:save-lines", not a web address.');
    expect(prompt.match(/payload\.action is exactly/g)).toHaveLength(1);   // only the step whose payload names an action
    // The caller's templates are not changed.
    expect(signedPayload.nonce).toBe('abc');
    expect(signedPayload.action).toBe('https://site.example/ns/action/save-lines');
  });

  it("lists the app's rules in order, drops blank ones, and ends with the refusal rule", () => {
    expect(prompt).toContain([
      'Rules:',
      '- Never change my words.',
      '- Use the nextTurnIndex each result returns.',
      '- Unless a rule above says otherwise: if a call is refused because a field or its format is wrong, '
        + 'fix it once from the refusal message and try again. For any other refusal, tell me what it said in plain words and stop.',
    ].join('\n'));
  });

  it('serves as plain workspace details with no steps, and leaves out what is not given', () => {
    const details = A.actPrompt({ affordancesUrl, rules: ['Sign every step except the plain ones.'] });
    expect(details).not.toContain('Steps:');
    expect(details).not.toContain('pod_url):');
    expect(details.startsWith('How to do each step:')).toBe(true);
    expect(details).toContain('- Sign every step except the plain ones.');
  });

  it('says what to do where the act tool has no sign_payload option, once, in the call shape, for a plain and a signed step alike', () => {
    const how = prompt.slice(0, prompt.indexOf('\n\nSteps:'));
    // This prompt has a plain step and a signed one: one sentence covers both, and says each part once.
    expect(how).toContain(`\n${FALLBACK.both}`);
    expect([timesIn(prompt, FALLBACK.both), timesIn(prompt, PLAIN_RULE), timesIn(prompt, SIGNED_RULE), timesIn(prompt, 'sign_request'), timesIn(prompt, NO_OPTION)]).toEqual([1, 1, 1, 1, 1]);
    // The old closing sentence said the plain part a second time, after the two-call way.
    expect(prompt).not.toContain('A plain step is the same act call');
    // After the nonce rule: the payload it signs is the step's whole payload, nonce included.
    expect(how.indexOf(FALLBACK.both)).toBeGreaterThan(how.indexOf('Every signed payload carries a nonce'));
  });

  it('says to leave sign_payload out wherever a plain step can come up, and the two-call way wherever a signed one can, never one where it has no step', () => {
    const plainStep = { say: 'Read the brief.', actionIri: 'urn:example:action:read-brief', signed: false, payload: { brief: 'x' } };
    const signedStep = { say: 'Save both lines.', actionIri: 'urn:example:action:save-lines', signed: true, payload: { v: 1 } };
    const which = (p: string): string => {
      const found = (Object.keys(FALLBACK) as (keyof typeof FALLBACK)[]).filter((k) => p.includes(FALLBACK[k]));
      expect(found.length, p).toBeLessThanOrEqual(1);
      expect(timesIn(p, NO_OPTION), p).toBe(found.length);
      return found[0] ?? 'none';
    };
    // Every step plain: a host whose act tool has no sign_payload is told to leave it out, though each step and the
    // call shape say "sign_payload: false". Nothing about sign_request: there is nothing to sign.
    const onlyPlain = A.actPrompt({ affordancesUrl, steps: [plainStep, { ...plainStep, actionIri: 'urn:example:action:list-items' }], rules: ['Never change my words.'] });
    expect(which(onlyPlain)).toBe('plain');
    expect(onlyPlain).not.toContain('sign_request');
    expect(onlyPlain).not.toContain('two calls');
    expect(onlyPlain).toContain('   sign_payload: false (plain: nothing is signed, and the arguments go at the top level of payload)');
    // Every step signed: the two-call way, and nothing about leaving sign_payload out, which with no plain step to
    // apply it to could only be read as leaving it off a signed one.
    const onlySigned = A.actPrompt({ affordancesUrl, steps: [signedStep, { ...signedStep, actionIri: 'urn:example:action:end' }], rules: ['Show me my levels in plain words.'] });
    expect(which(onlySigned)).toBe('signed');
    expect(onlySigned).not.toContain(PLAIN_RULE);
    expect(onlySigned).not.toContain('leave sign_payload out');
    // A plain step and a signed one: both, in one sentence, each part once.
    const mixed = A.actPrompt({ affordancesUrl, steps: [plainStep, signedStep] });
    expect(which(mixed)).toBe('both');
    expect([timesIn(mixed, PLAIN_RULE), timesIn(mixed, SIGNED_RULE), timesIn(mixed, 'sign_request')]).toEqual([1, 1, 1]);
    // A rule can bring up the kind of step no step is: then the prompt says what to do with it too.
    expect([
      // Only plain steps, but a rule that speaks of signing.
      A.actPrompt({ affordancesUrl, steps: [plainStep], rules: ['Sign every step (sign_payload true) you add yourself.'] }),
      A.actPrompt({ affordancesUrl, steps: [plainStep], rules: ['Every signed payload has "v": 1.'] }),
      // Only signed steps, but a rule that names a plain one.
      A.actPrompt({ affordancesUrl, steps: [signedStep], rules: ['Listing the items is a plain step.'] }),
      A.actPrompt({ affordancesUrl, steps: [signedStep], rules: ['Use sign_payload false to list the items.'] }),
      // No steps at all (workspace details): the assistant chooses the actions, and any may be signed or plain.
      A.actPrompt({ affordancesUrl }),
      A.actPrompt({ affordancesUrl, podUrl, rules: ['Never assess my own practice.'] }),
    ].map(which)).toEqual(['both', 'both', 'both', 'both', 'both', 'both']);
    // "signs off" is not about signing a payload, and "in plain words" is not about a plain step.
    expect(which(A.actPrompt({ affordancesUrl, steps: [plainStep], rules: ['A reviewer signs off after me.'] }))).toBe('plain');
    expect(which(A.actPrompt({ affordancesUrl, steps: [signedStep], rules: ['Tell me in plain words.'] }))).toBe('signed');
  });

  // With one stub signer for both ways, this shows only that the pair passes through unchanged. Whether
  // the relay's sign_request, called alone through its dispatcher, signs the same fields as act's
  // composition is the relay's own test: deploy/mcp-relay/tests/sign-request-alone-signs-what-act-signs.test.ts.
  it("the two calls send what act's sign_payload: true sends: sign_request's two fields, unchanged, as the payload", async () => {
    const payload = { v: 1, action: 'urn:example:action:save-lines', pod_url: podUrl, nonce: 'save-lines-4-q8Xr2mVp7LkA9dTz', turnIndex: 4 };
    const signs: Record<string, unknown>[] = [];
    // The connector's sign_request, as the relay answers it: the envelope and fields beside it that act must not pass on.
    const signRequest = async (args: Record<string, unknown>): Promise<string> => {
      signs.push(args);
      return JSON.stringify({ _signature: '0xsig', _signed_payload: JSON.stringify({ ...(args['payload'] as object), agent_id: 'did:web:id.example:agents:chatgpt-u-pk-1' }), signed_as: 'did:web:id.example:agents:chatgpt-u-pk-1', hint: 'x' });
    };
    const descriptorUrl = affordancesUrl;
    // sign_payload: true, as the relay composes it.
    const composed = await signedActPayload({ descriptor_url: descriptorUrl, action_iri: payload.action, sign_payload: true }, payload, signRequest);
    // The two calls the prompt describes: sign_request with payload as its only argument, then
    // act's payload set to exactly the _signature and _signed_payload it returned.
    const returned = JSON.parse(await signRequest({ payload })) as Record<string, unknown>;
    const byHand = { _signature: returned['_signature'], _signed_payload: returned['_signed_payload'] };
    expect(byHand).toEqual(composed);
    expect(signs).toEqual([{ payload }, { payload }]);
    // A payload already signed is refused by sign_payload: true, so the two ways are never mixed on one call.
    await expect(signedActPayload({ descriptor_url: descriptorUrl, action_iri: payload.action, sign_payload: true }, byHand, signRequest)).rejects.toThrow(/already signed/);
  });

  it('a non-urn action is stated exactly, without calling it a urn', () => {
    const iri = 'https://site.example/ns/action/save-lines';
    const p = A.actPrompt({ affordancesUrl, steps: [{ say: 'Save.', actionIri: iri, signed: true, payload: { action: 'x' } }] });
    expect(p).toContain(`   payload.action is exactly "${iri}".`);
    expect(p).not.toContain('this urn');
  });

  it('refuses a malformed spec with a TypeError: that is a bug in the calling app', () => {
    expect(() => A.actPrompt({})).toThrow(TypeError);
    expect(() => A.actPrompt(null)).toThrow(/affordancesUrl/);
    expect(() => A.actPrompt({ affordancesUrl, steps: 'one' })).toThrow(/steps must be an array/);
    expect(() => A.actPrompt({ affordancesUrl, rules: 'one' })).toThrow(/rules must be an array/);
    expect(() => A.actPrompt({ affordancesUrl, steps: [null] })).toThrow(/step 1 must be an object/);
    expect(() => A.actPrompt({ affordancesUrl, steps: [{ say: 'x' }] })).toThrow(/step 1 needs an actionIri/);
    expect(() => A.actPrompt({ affordancesUrl, steps: [{ actionIri: 'urn:example:action:a', payload: [] }] })).toThrow(/payload must be a JSON object/);
    expect(() => A.actPrompt({ affordancesUrl, podUrl, podOwner: 'team' })).toThrow(/podOwner must be/);
  });

  // A shared workspace's storage is not the person's own: a chat told it is would offer it as theirs.
  it("says whose storage pod_url is: the person's own by default, or the workspace's", () => {
    const mine = A.actPrompt({ affordancesUrl, podUrl });
    expect(mine).toContain(`My storage address (pod_url): "${podUrl}"`);
    expect(A.actPrompt({ affordancesUrl, podUrl, podOwner: 'me' })).toBe(mine);
    const shared = A.actPrompt({ affordancesUrl, podUrl, podOwner: 'workspace' });
    expect(shared).toContain(`This workspace's storage address (pod_url), the same for everyone in it and not my own: "${podUrl}"`);
    expect(shared).not.toContain('My storage address');
    // Only that line differs.
    expect(shared.replace(/^This workspace's storage address.*$/m, 'X')).toBe(mine.replace(/^My storage address.*$/m, 'X'));
    // With no podUrl there is no line to word either way.
    expect(A.actPrompt({ affordancesUrl, podOwner: 'workspace' })).not.toMatch(/storage address/);
  });
});

/** Action IRIs of every shape a step name is made from: hyphens, slashes, a trailing slash, odd characters, a fragment, too long, none at all. */
const NONCE_IRIS = [
  'urn:example:action:a',
  'urn:example:action:draft-something-long-packet',
  'https://relay.example/ns/x/action/demo/counterpart-packet',
  'https://relay.example/ns/x/action/demo/counterpart-packet/',
  'urn:example:action:Record Turns!!',
  'urn:example:action#fragment-step',
  `urn:example:action:${'very-long-step-name-'.repeat(8)}`,
  'urn:example:---',
];

/** The example nonce a prompt shows, when it shows one made from a step name. */
const exampleNonceIn = (prompt: string): string | null => /For example ([A-Za-z0-9-]+), but make up/.exec(prompt)?.[1] ?? null;

describe('the nonce rule', () => {
  it('composes step name, turn number and 16 random letters or digits with "-", never reused', () => {
    expect(A.nonceRule).toContain('nonce = the step name, the turn number (or 0), then 16 random letters or digits, joined by "-", never reused');
    expect(A.nonceRule).toContain('make up new random letters for every call');
    // Published on its own, it names no step at all: the example is said in words.
    expect(exampleNonceIn(A.nonceRule)).toBeNull();
    expect(A.nonceRule).toContain("at turn 4 a step's nonce is that step's own name, then 4, then 16 letters or digits such as q8Xr2mVp7LkA9dTz");
  });

  it("a prompt's example nonce is made from its own first signed step, and passes both sites' checks", () => {
    const affordancesUrl = 'https://s.example/affordances';
    // A step with no turn (its payload has no turnIndex) is shown at turn 0, as the rule says
    // ("the turn number, or 0"), so an assistant copying the example never copies a turn it lacks.
    const p = A.actPrompt({ affordancesUrl, steps: [
      { actionIri: 'urn:example:action:read-brief', signed: false },
      { actionIri: 'urn:example:action:save-lines', signed: true },
      { actionIri: 'urn:example:action:end-talk', signed: true },
    ] });
    expect(exampleNonceIn(p)).toBe('save-lines-0-q8Xr2mVp7LkA9dTz');
    for (const payload of [{ v: 1, action: 'x' }, { turn: 3 }]) {
      expect(exampleNonceIn(A.actPrompt({ affordancesUrl, steps: [{ actionIri: 'urn:example:action:judge-packet', signed: true, payload }] }))).toBe('judge-packet-0-q8Xr2mVp7LkA9dTz');
    }
    // A step whose payload carries a turnIndex (any value, a placeholder included) is shown at a turn number.
    for (const turnIndex of ['<T, a number>', 0, 7]) {
      expect(exampleNonceIn(A.actPrompt({ affordancesUrl, steps: [
        { actionIri: 'urn:example:action:read-brief', signed: false, payload: { turnIndex: 1 } },
        { actionIri: 'urn:example:action:save-lines', signed: true, payload: { v: 1, turnIndex } },
      ] }))).toBe('save-lines-4-q8Xr2mVp7LkA9dTz');
    }
    for (const actionIri of NONCE_IRIS) {
      const example = exampleNonceIn(A.actPrompt({ affordancesUrl, steps: [{ actionIri, signed: true }] })) ?? '';
      expect(example, actionIri).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?-\d+-[A-Za-z0-9]{16}$/);
      for (const re of SITE_NONCES) expect(example, actionIri).toMatch(re);
    }
    // No signed step, or no step at all (workspace details): the rule in words, naming no step.
    for (const q of [A.actPrompt({ affordancesUrl, steps: [{ actionIri: 'urn:example:action:read-brief', signed: false }] }), A.actPrompt({ affordancesUrl })]) {
      expect(q).toContain(`Every signed payload carries a nonce: ${A.nonceRule}`);
      expect(exampleNonceIn(q)).toBeNull();
    }
  });

  it('read both sites\' nonce checks', () => {
    expect(SITE_NONCES.map(String)).toEqual(['/^[A-Za-z0-9_-]{16,128}$/', '/^[A-Za-z0-9_-]{16,64}$/']);
  });

  it('every nonce made from a step\'s template passes both sites\' checks, whatever the step name or turn', () => {
    for (const actionIri of NONCE_IRIS) {
      const [payload] = payloadsOf(A.actPrompt({ affordancesUrl: 'https://s.example/affordances', steps: [{ actionIri, signed: true }] }));
      const template = String(payload?.nonce);
      const step = template.slice(0, template.indexOf('-<turn number'));
      expect(step, actionIri).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,30}[A-Za-z0-9])?$/);
      for (const turn of [0, 1, 37, 999_999]) {
        const nonce = nonceFrom(template, turn);
        for (const re of SITE_NONCES) expect(nonce, `${actionIri} turn ${turn}`).toMatch(re);
      }
    }
  });

  it('derives the step name from the action: last segment, letters, digits and "-", at most 32', () => {
    const stepOf = (actionIri: string): string => {
      const t = String(payloadsOf(A.actPrompt({ affordancesUrl: 'https://s.example/a', steps: [{ actionIri, signed: true }] }))[0]?.nonce);
      return t.slice(0, t.indexOf('-<turn number'));
    };
    expect(stepOf('urn:example:action:save-lines')).toBe('save-lines');
    expect(stepOf('https://relay.example/ns/action/demo/counterpart-packet/')).toBe('counterpart-packet');
    expect(stepOf('urn:example:action:Record Turns!!')).toBe('Record-Turns');
    expect(stepOf('urn:example:action#fragment-step')).toBe('fragment-step');
    expect(stepOf(`urn:example:${'a'.repeat(80)}`)).toBe('a'.repeat(32));
    expect(stepOf('urn:example:---')).toBe('step');
  });
});

describe('requestAsText', () => {
  const conversation = {
    system: 'You are Maya, a supplier. Stay in character.',
    messages: [
      { role: 'user', content: '(The practice conversation starts. Say your first line.)' },
      { role: 'assistant', content: 'Thanks for making time.' },
      { role: 'user', content: 'Happy to. (pause) Shall we talk dates?' },
      { role: 'assistant', content: 'Fine.' },
      { role: 'user', content: '(nods)' },
    ],
    maxTokens: 300,
  };

  it('renders a conversation with the opener as a stage direction, never as my line', () => {
    const t = A.requestAsText(conversation, { meLabel: 'Me', themLabel: 'Maya', replyRule: "Reply with only Maya's next line, nothing else." });
    expect(t).toBe([
      'Instructions for you:\nYou are Maya, a supplier. Stay in character.',
      [
        'The conversation so far:',
        '(Stage direction: The practice conversation starts. Say your first line.)',
        'Maya: Thanks for making time.',
        'Me: Happy to. (pause) Shall we talk dates?',
        'Maya: Fine.',
        'Me: (nods)',   // only the FIRST message can be a stage direction
      ].join('\n'),
      "Reply with only Maya's next line, nothing else.",
    ].join('\n\n'));
    expect(t).not.toContain('Me: (The practice');
  });

  it('a first line that is not one parenthesis is the person\'s own line', () => {
    const t = A.requestAsText({ system: 's', messages: [{ role: 'user', content: '(sighs) Fine. (pause)' }, { role: 'assistant', content: 'Go on.' }] });
    expect(t).toContain('\nMe: (sighs) Fine. (pause)\nThe other person: Go on.');
  });

  it('renders {system, user} as one request, and so a lone user message', () => {
    const expected = 'Instructions for you:\nJudge the session.\n\nThe request:\nHere is the transcript.\n\nReply with only the JSON object.';
    expect(A.requestAsText({ system: 'Judge the session.', user: 'Here is the transcript.' }, { replyRule: 'Reply with only the JSON object.' })).toBe(expected);
    expect(A.requestAsText({ system: 'Judge the session.', messages: [{ role: 'user', content: 'Here is the transcript.' }] }, { replyRule: 'Reply with only the JSON object.' })).toBe(expected);
    expect(A.requestAsText({ user: 'Only a request.' })).toBe('The request:\nOnly a request.');
  });

  it('defaults the labels, reads text blocks, and labels any other role as a note', () => {
    const t = A.requestAsText({
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: 'Hello ' }, { type: 'text', text: 'there.' }] },
        { role: 'user', content: 'Hi.' },
        { role: 'system', content: 'Time is up soon.' },
      ],
    });
    expect(t).toBe('The conversation so far:\nThe other person: Hello there.\nMe: Hi.\n(system: Time is up soon.)');
  });

  it('refuses a request with nothing to render', () => {
    expect(() => A.requestAsText(null)).toThrow(TypeError);
    expect(() => A.requestAsText({ system: 'only instructions' })).toThrow(/neither messages nor user/);
    expect(() => A.requestAsText({ system: 's', messages: [] })).toThrow(/neither messages nor user/);
    expect(() => A.requestAsText({ messages: ['a line', { role: 'user', content: 'b' }] })).toThrow(/message 1 is not an object/);
  });
});

describe('extractJsonObject', () => {
  const ok = (text: string): unknown => {
    const r = A.extractJsonObject(text);
    if (!r.ok) throw new Error(`expected a JSON object, got: ${r.why}`);
    return r.value;
  };
  const why = (text: unknown): string => {
    const r = A.extractJsonObject(text);
    if (r.ok) throw new Error(`expected no object, got ${JSON.stringify(r.value)}`);
    return r.why;
  };

  it('reads a bare object, and one inside a fence with prose around it', () => {
    expect(ok('{"a":1,"b":[1,2,{"c":null}]}')).toEqual({ a: 1, b: [1, 2, { c: null }] });
    expect(ok('Here is your draft:\n\n```json\n{\n  "title": "Late delivery",\n  "turns": 6\n}\n```\n\nWant changes?')).toEqual({ title: 'Late delivery', turns: 6 });
    expect(ok('~~~\n{"a": true}\n~~~')).toEqual({ a: true });
    expect(ok('Sure: ```{"inline": 1}```')).toEqual({ inline: 1 });
  });

  it('prefers a fenced object over an earlier object in the prose', () => {
    expect(ok('Sure {} here it is:\n```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  });

  it('matches braces outside strings only, and keeps escapes', () => {
    expect(ok('{"text": "a } b { c \\" } d", "n": {"m": "}"}} trailing } prose')).toEqual({ text: 'a } b { c " } d', n: { m: '}' } });
  });

  it('skips prose braces, and balanced text that is not JSON, to reach the object', () => {
    expect(ok('Fill in {name} and {role}, then: {"name": "Ana"}')).toEqual({ name: 'Ana' });
    expect(ok('Use { to start an object. {"a": 1}')).toEqual({ a: 1 });
  });

  it('never answers with a piece of a broken or cut-off object', () => {
    expect(why('```json\n{"draft": {"title": "x"}, "tasks": [')).toMatch(/cut off/);
    expect(why('{"a": {"b": 1},}')).toMatch(/not valid JSON/);
  });

  it('says why when there is nothing to read', () => {
    expect(why('')).toMatch(/no text/);
    expect(why('   ')).toMatch(/no text/);
    expect(why(undefined)).toMatch(/no text/);
    expect(why(42)).toMatch(/no text/);
    expect(why('Sorry, I cannot draft that.')).toMatch(/no JSON object/);
    expect(why('[1, 2, 3]')).toMatch(/no JSON object/);
    expect(why('x'.repeat(2_000_001))).toMatch(/too long/);
  });

  it('stops after a bounded number of tries on text full of braces', () => {
    const r = A.extractJsonObject(`${'{x} '.repeat(200)}{"late": 1}`);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.why).toMatch(/first 64 places/);
  });
});

describe('agentAppName', () => {
  const did = (slug: string): string => `did:web:id.example:agents:${slug}`;

  it('names the app from the slug the relay made of its client name', () => {
    const table: Array<[string, string]> = [
      ['claude-u-pk-0123456789ab', 'Claude'],
      ['claude-code-vscode-u-pk-0123456789ab', 'Claude'],
      ['claude-desktop-u-eth-0123456789ab', 'Claude'],
      ['chatgpt-u-pk-0123456789ab', 'ChatGPT'],
      ['openai-codex-u-pk-0123456789ab', 'Codex'],
      ['codex-u-pk-0123456789ab', 'Codex'],
      ['openai-u-pk-0123456789ab', 'ChatGPT or another OpenAI app'],
      ['cursor-u-pk-0123456789ab', 'Cursor'],
      ['windsurf-u-pk-0123456789ab', 'another app'],
      ['mcp-client-u-pk-0123456789ab', 'another app'],
      ['claudia-u-pk-0123456789ab', 'another app'],
      ['chatgpts-helper-u-pk-0123456789ab', 'another app'],
    ];
    for (const [slug, name] of table) {
      expect(A.agentAppName(did(slug)), slug).toBe(name);
      expect(A.agentAppName(slug), `bare ${slug}`).toBe(name);
    }
    expect(A.agentAppName(did('Claude-U-PK-1'))).toBe('Claude');
  });

  it("names the site's own web app first, and anything unnamed as another app", () => {
    expect(A.agentAppName(did('site-web-u-pk-1'), 'site-web-', 'the web app')).toBe('the web app');
    expect(A.agentAppName(did('site-web-u-pk-1'), 'site-web-')).toBe('this app');
    expect(A.agentAppName(did('claude-u-pk-1'), 'site-web-', 'the web app')).toBe('Claude');
    expect(A.agentAppName('')).toBe('another app');
    expect(A.agentAppName(undefined)).toBe('another app');
    expect(A.agentAppName(did(''))).toBe('another app');
  });
});
