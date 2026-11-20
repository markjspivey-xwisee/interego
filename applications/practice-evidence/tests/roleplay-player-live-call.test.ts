/**
 * A live call in the role-play player: the learner speaks freely and a speech model answers.
 *
 * The player's two scripts are run whole, as the page runs them, at a launch URL that says
 * `call=live`. What stands in for the browser is a document that keeps elements by id, a `fetch`
 * that is the LMS, its learning record and the files beside the page, a microphone that hands over
 * one track, and a peer connection that makes an offer and keeps the data channel the page opens.
 * The speech service is the test itself: it puts events on that channel in the shapes OpenAI's
 * Realtime reference gives them (read 2026-11-19). Nothing of the player is stubbed.
 *
 * What the learning record then holds is given to `readLaunchedCall`, the function the bridge's
 * import runs on a registration.
 *
 * Not checked here: a real browser, a real microphone, WebRTC, the speech service, the LMS's own
 * route (`tests/a-unit-asks-the-lms-for-a-live-call.test.ts` in Foxxi), or audio of any kind.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readLaunchedCall, VERB_INITIALIZED, VERB_LAUNCHED, VERB_SCORED, VERB_TERMINATED, type LaunchVocabulary, type ReadLaunchedInput } from '../src/launched-import.js';
import type { ScenarioSpec } from '../src/practice.js';

const DIR = new URL('../../../docs/applications/practice-evidence/roleplay-player/', import.meta.url);
const read = (name: string): string => readFileSync(new URL(name, DIR), 'utf8');
const PAGE = read('index.html');
const SCRIPTS = [...PAGE.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const SECTIONS = [...PAGE.matchAll(/<section id="([a-z-]+)"/g)].map((m) => m[1]!);
/** Every element the page's markup starts hidden, whichever way round its tag gives the id and the class. */
const HIDDEN = [...PAGE.matchAll(/<[a-z]+\b[^>]*>/g)].map((m) => m[0]).filter((t) => /\bclass="[^"]*\bhide\b/.test(t)).map((t) => /\bid="([a-z-]+)"/.exec(t)?.[1]).filter((id): id is string => id !== undefined);

interface Scenario {
  turnLimit: number; assessmentUse: string; rubricRef: string; resultAfterReview: boolean;
  practiceEvidenceScenario: { iri: string; version: number };
  rubric: { criteria: { id: string; levels: { id: string; value: number }[] }[] };
  ui: { liveCall: { dataChannel: string; maxMinutes: number } };
  xapi: { verbs: Record<string, string>; extensions: Record<string, string> };
}
const scenario = JSON.parse(read('scenarios/double-charged-subscription.json')) as Scenario;

type St = Record<string, unknown> & { id: string; verb: { id: string }; timestamp: string; object: { id: string; definition?: { name?: Record<string, string>; extensions?: Record<string, unknown> } }; result?: { response?: string; score?: unknown }; context: { registration?: string; platform?: string; extensions: Record<string, unknown> } };
const LMS = 'https://lms.example', LRS = `${LMS}/xapi`, PLAYER = 'https://player.example/roleplay-player/index.html';
const AU = `${LMS}/courses/refund-call/au/1`;
const REG = '6f1c2f6e-3b1a-4c53-9d2e-0a4b7c9d1e2f', SESSION = 'b7e1a9c4-52d3-4f60-8a17-3c5d9e0f1a2b', LATER_SESSION = 'c8f2bad5-63e4-4a71-9b28-4d6eaf1a2b3c';
const SESSION_EXT = 'https://w3id.org/xapi/cmi5/context/extensions/sessionid';
const ACTOR = { objectType: 'Agent', account: { homePage: 'https://id.example', name: 'https://id.example/users/learner-1/profile#me' } };
const TOKEN = 'ZmljdGlvbmFsOmNyZWRlbnRpYWw';
const OFFER = 'v=0\r\no=- 4611731400430051336 2 IN IP4 127.0.0.1\r\ns=-\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n';
const ANSWER = 'v=0\r\no=- 1 2 IN IP4 0.0.0.0\r\ns=-\r\n';

interface CallAsk { authorization: string | undefined; body: Record<string, unknown> }

/** The LMS and its learning record, the page's own files, and nothing else. */
class Lms {
  readonly held: St[] = [];
  readonly asked: string[] = [];
  readonly calls: CallAsk[] = [];
  session = SESSION;
  /** What the LMS answers a unit that asks for a call. */
  call: () => { status: number; body: unknown } = () => ({ status: 200, body: this.placed() });
  constructor() {
    this.held.push({
      id: '00000000-0000-4000-8000-000000000001', version: '2.0.0', timestamp: new Date(Date.now() - 5000).toISOString(), actor: ACTOR,
      verb: { id: VERB_LAUNCHED }, object: { id: AU },
      context: { registration: REG, extensions: { [SESSION_EXT]: SESSION, 'https://w3id.org/xapi/cmi5/context/extensions/launchmode': 'Normal' } },
    });
  }
  placed(over: Record<string, unknown> = {}): unknown {
    return {
      kind: 'cmi5-live-call', registration: REG, sessionId: this.session,
      call: { provider: 'scripted', model: 'a-model', voice: 'a-voice', transcriptionModel: 'a-transcriber', answerSdp: ANSWER, dataChannel: scenario.ui.liveCall.dataChannel, counterpartName: 'Dana Reyes', firstLine: 'Hi. I was charged twice.', language: 'en-US', turnLimit: scenario.turnLimit, promptTemplateHash: 'abc', ...over },
      disclosure: 'The other person is an AI speech model.', note: '',
    };
  }
  readonly fetch = async (input: unknown, init?: { method?: string; body?: string; headers?: Record<string, string> }): Promise<Response> => {
    const u = new URL(String(input)), json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    this.asked.push(`${init?.method ?? 'GET'} ${u.origin}${u.pathname}`);
    if (u.href.startsWith('https://player.example/roleplay-player/')) return new Response(read(u.pathname.replace('/roleplay-player/', '')), { status: 200 });
    if (u.origin !== LMS) return new Response('', { status: 404 });
    if (u.pathname === '/cmi5/fetch/once') return json({ 'auth-token': TOKEN });
    if (u.pathname === '/xapi/activities/state') return json({ contextTemplate: { extensions: { [SESSION_EXT]: this.session }, contextActivities: { grouping: [{ objectType: 'Activity', id: `${LMS}/courses/refund-call` }] } }, launchMode: 'Normal', launchParameters: '' });
    if (u.pathname === '/cmi5/reviewed') return json({ error: 'registration_not_under_review' }, 409);
    if (u.pathname === '/cmi5/live-call' && init?.method === 'POST') {
      this.calls.push({ authorization: init.headers?.['Authorization'], body: JSON.parse(String(init.body)) as Record<string, unknown> });
      const a = this.call();
      return json(a.body, a.status);
    }
    if (u.pathname === '/xapi/statements' && init?.method === 'POST') {
      const st = JSON.parse(String(init.body)) as St, same = this.held.find((h) => h.id === st.id);
      if (same) return new Response('', { status: JSON.stringify(same) === JSON.stringify(st) ? 204 : 409 });
      this.held.push(st);
      return json([st.id]);
    }
    if (u.pathname === '/xapi/statements') {
      const id = u.searchParams.get('statementId');
      if (id) { const h = this.held.find((x) => x.id === id); return h ? json(h) : new Response('', { status: 404 }); }
      return json({ statements: this.held.slice().reverse(), more: '' });
    }
    return new Response('', { status: 404 });
  };
  verbs(): string[] { return this.held.map((s) => s.verb.id.split('/').pop()!); }
  turns(): { line: unknown; response: string | undefined; n: string }[] {
    return this.held.filter((s) => s.verb.id === VOCAB.turnVerb).map((s) => ({ n: s.object.id.split('/').pop()!, line: s.object.definition!.extensions![VOCAB.counterpartLineExt], response: s.result!.response }));
  }
}

/** An element as far as the page uses one. */
class El {
  children: El[] = []; onclick: (() => unknown) | null = null; className = ''; style: Record<string, string> = {}; disabled = false; srcObject: unknown = null;
  readonly offsetWidth = 0;
  private text = '';
  private readonly classes = new Set<string>();
  readonly classList = {
    add: (c: string): void => { this.classes.add(c); }, remove: (c: string): void => { this.classes.delete(c); },
    toggle: (c: string, on?: boolean): void => { if (on ?? !this.classes.has(c)) this.classes.add(c); else this.classes.delete(c); },
    contains: (c: string): boolean => this.classes.has(c),
  };
  get textContent(): string { return this.text; }
  set textContent(v: string) { this.text = String(v); this.children = []; }
  get innerHTML(): string { return ''; }
  set innerHTML(_v: string) { this.text = ''; this.children = []; }
  appendChild(e: El): El { this.children.push(e); return e; }
  setAttribute(): void { /* drawing only */ }
  querySelector(): El { return new El(); }
  querySelectorAll(): El[] { return [new El(), new El()]; }
  get hidden(): boolean { return this.classes.has('hide'); }
}

/** The data channel the page opens: what it sent, and the handlers it set. */
class Channel {
  readonly sent: Record<string, unknown>[] = []; closed = false;
  onmessage: ((e: { data: string }) => void) | null = null; onopen: (() => void) | null = null; onclose: (() => void) | null = null;
  constructor(readonly label: string) {}
  send(s: string): void { this.sent.push(JSON.parse(s) as Record<string, unknown>); }
  close(): void { this.closed = true; }
}
class Track { stopped = false; stop(): void { this.stopped = true; } }
/** A browser's peer connection as far as the page uses one. */
class Peer {
  connectionState = 'new'; closed = false; channel: Channel | null = null; remote: { type: string; sdp: string } | null = null;
  readonly tracks: unknown[] = [];
  ontrack: ((e: { streams: unknown[] }) => void) | null = null; onconnectionstatechange: (() => void) | null = null;
  addTrack(t: unknown): void { this.tracks.push(t); }
  createDataChannel(label: string): Channel { this.channel = new Channel(label); return this.channel; }
  async createOffer(): Promise<{ type: string; sdp: string }> { return { type: 'offer', sdp: OFFER }; }
  async setLocalDescription(): Promise<void> { /* the offer is the one above */ }
  async setRemoteDescription(d: { type: string; sdp: string }): Promise<void> { this.remote = d; }
  close(): void { this.closed = true; }
}

interface Opened {
  el(id: string): El; showing(): string[]; win: Record<string, unknown>; peers: Peer[]; mics: Track[];
  settle(until: () => boolean): Promise<void>;
  /** The speech service puts an event on the call's data channel. */
  hear(ev: Record<string, unknown>): void;
  peer(): Peer;
}
/** One load of the page at a launch URL that asks for a live call. */
function open(lms: Lms, o: { webrtc?: boolean; mic?: 'refused'; call?: string | null; launched?: boolean } = {}): Opened {
  const els = new Map<string, El>();
  const el = (id: string): El => { let e = els.get(id); if (!e) { e = new El(); els.set(id, e); } return e; };
  for (const id of HIDDEN) el(id).classList.add('hide');
  const document = { title: '', getElementById: el, createElement: (): El => new El(), querySelectorAll: (q: string): El[] => (q === 'section' ? SECTIONS.map(el) : []) };
  const launch: Record<string, string> = o.launched === false ? {} : { endpoint: LRS, fetch: `${LMS}/cmi5/fetch/once`, actor: JSON.stringify(ACTOR), activityId: AU, registration: REG };
  const href = `${PLAYER}?${new URLSearchParams({ ...launch, ...(o.call === null ? {} : { call: o.call ?? 'live' }) }).toString()}`;
  const location = { href, search: new URL(href).search };
  const peers: Peer[] = [], mics: Track[] = [];
  const window: Record<string, unknown> = { scrollTo: () => {}, localStorage: undefined, sessionStorage: undefined };
  if (o.webrtc !== false) {
    window['RTCPeerConnection'] = class extends Peer { constructor() { super(); peers.push(this); } };
    window['navigator'] = { mediaDevices: { getUserMedia: async (): Promise<unknown> => {
      if (o.mic === 'refused') throw Object.assign(new Error('denied'), { name: 'NotAllowedError' });
      const t = new Track(); mics.push(t); return { getTracks: () => [t] };
    } } };
  }
  // A timer the page waits on runs as it would, and does not keep the test run alive after it.
  const timeout = (f: () => void, ms?: number): unknown => { const t = setTimeout(f, ms); t.unref(); return t; };
  for (const script of SCRIPTS) {
    new Function('window', 'document', 'location', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', script)(window, document, location, lms.fetch, () => 0, () => {}, timeout);
  }
  const showing = (): string[] => SECTIONS.filter((id) => !el(id).hidden);
  const peer = (): Peer => peers[peers.length - 1]!;
  return {
    el, showing, win: window, peers, mics, peer,
    hear: (ev) => { peer().channel!.onmessage!({ data: JSON.stringify(ev) }); },
    settle: async (until) => { for (let i = 0; i < 1200 && !until(); i++) await new Promise((r) => setTimeout(r, 5)); if (!until()) throw new Error(`the page did not get there; showing ${showing().join(',')}; chip "${el('chip').textContent}"; status "${el('lstatus').textContent}"; ${el('loadmsg').textContent}`); },
  };
}
/** The learner agrees, and the page gets as far as holding the speech service's answer. */
async function placeCall(lms: Lms, o: Parameters<typeof open>[1] = {}): Promise<Opened> {
  const page = open(lms, o);
  await page.settle(() => page.showing().includes('s-welcome') && page.el('chip').textContent === 'Tracked' && count(lms, VERB_INITIALIZED) === 1);
  page.el('go').onclick!(); page.el('agree').onclick!(); void page.el('consentyes').onclick!();
  await page.settle(() => page.peers.length > 0 && page.peer().remote !== null);
  page.peer().channel!.onopen!();
  return page;
}

// The speech service's events, in the shapes its reference gives them.
const customer = (page: Opened, id: string, text: string): void => {
  page.hear({ type: 'conversation.item.added', item: { id, type: 'message', role: 'assistant' } });
  const half = Math.ceil(text.length / 2);
  page.hear({ type: 'response.output_audio_transcript.delta', item_id: id, delta: text.slice(0, half) });
  page.hear({ type: 'response.output_audio_transcript.delta', item_id: id, delta: text.slice(half) });
  page.hear({ type: 'response.output_audio_transcript.done', item_id: id, transcript: text });
  page.hear({ type: 'response.done', response: { status: 'completed', output: [{ id }] } });
};
const spoke = (page: Opened, id: string): void => {
  page.hear({ type: 'input_audio_buffer.speech_started', item_id: id });
  page.hear({ type: 'input_audio_buffer.speech_stopped', item_id: id });
  page.hear({ type: 'input_audio_buffer.committed', item_id: id });
};
const heard = (page: Opened, id: string, transcript: string): void => { page.hear({ type: 'conversation.item.input_audio_transcription.completed', item_id: id, transcript }); };

const VOCAB: LaunchVocabulary = {
  turnVerb: scenario.xapi.verbs['turn']!, counterpartLineExt: scenario.xapi.extensions['counterpartLine']!,
  criterionKeyExt: scenario.xapi.extensions['criterionKey']!, rubricExt: scenario.xapi.extensions['rubric']!,
};
const INPUT: ReadLaunchedInput = {
  registration: REG, endpoint: LRS, vocabulary: VOCAB, rubricHash: 'not-named-by-this-unit', scenarioVersionRef: scenario.rubricRef,
  spec: { turnLimit: scenario.turnLimit, assessmentUse: scenario.assessmentUse, rubric: { criteria: scenario.rubric.criteria.map((c) => ({ id: c.id, levels: c.levels.map((l) => ({ id: l.id, value: l.value })) })), passRule: null } } as unknown as ScenarioSpec,
};
const count = (lms: Lms, verb: string): number => lms.held.filter((s) => s.verb.id === verb).length;

describe('a live call in the role-play player', () => {
  it('asks the LMS for the call with the session credential and its own offer, and is handed no credential', async () => {
    expect(SCRIPTS).toHaveLength(2);
    expect(scenario.resultAfterReview).toBe(true);
    expect(HIDDEN).toEqual(expect.arrayContaining([...SECTIONS.filter((id) => id !== 's-loading'), 'livesteps', 'lretry', 'rvretry']));
    const lms = new Lms();
    const page = await placeCall(lms);

    expect(lms.calls).toHaveLength(1);
    expect(lms.calls[0]!.authorization).toBe(`Bearer ${TOKEN}`);
    expect(lms.calls[0]!.body).toEqual({ scenarioIri: scenario.practiceEvidenceScenario.iri, scenarioVersion: scenario.practiceEvidenceScenario.version, sdpOffer: OFFER });
    // The microphone is on the connection, the channel is the one the scenario names, and the answer is the service's.
    const pc = page.peer();
    expect(pc.tracks).toEqual(page.mics);
    expect(pc.channel!.label).toBe(scenario.ui.liveCall.dataChannel);
    expect(pc.remote).toEqual({ type: 'answer', sdp: ANSWER });
    // Once the channel is open the other person is asked to speak first, and nothing else is sent on it.
    expect(pc.channel!.sent).toEqual([{ type: 'response.create' }]);
    expect(page.showing()).toEqual(['s-live']);
    expect(page.el('lname').textContent).toBe('Dana Reyes');
    expect(page.el('ldisclosure').textContent).toContain('The other person is an AI speech model.');
    // So far the record holds the start of the visit and the learner's agreement, which says what kind of call it is.
    expect(lms.verbs()).toEqual(['launched', 'initialized', 'consented']);
    expect(lms.held[2]!.result!.response).toContain('AI speech model');
    expect(lms.held[2]!.object.definition!.name!['en-US']).toContain('no audio saved');
    void page.el('lend').onclick!();
    await page.settle(() => count(lms, VERB_TERMINATED) === 1);
  });

  it('writes each exchange as text once it can no longer change, scores nothing, and is read by the import as one unscored conversation', async () => {
    const lms = new Lms();
    const page = await placeCall(lms);

    customer(page, 'a1', 'Hi. I just checked my card and Brightline charged me twice.');
    // The learner answers. The other person starts replying before the transcriber has written the answer down.
    spoke(page, 'u1');
    page.hear({ type: 'conversation.item.added', item: { id: 'u1', type: 'message', role: 'user' } });
    page.hear({ type: 'conversation.item.added', item: { id: 'a2', type: 'message', role: 'assistant' } });
    page.hear({ type: 'response.output_audio_transcript.delta', item_id: 'a2', delta: 'Okay, ' });
    await new Promise((r) => setTimeout(r, 30));
    expect(count(lms, VOCAB.turnVerb)).toBe(0);
    page.hear({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'u1', delta: "I'm sorry about" });
    heard(page, 'u1', " I'm sorry about that, I can see both charges.\n");
    await page.settle(() => count(lms, VOCAB.turnVerb) === 1);
    page.hear({ type: 'response.output_audio_transcript.done', item_id: 'a2', transcript: 'Okay, so when do I get my money back?' });
    page.hear({ type: 'response.done', response: { status: 'completed' } });

    // An answer the transcriber failed on is still an exchange, and says so.
    spoke(page, 'u2');
    page.hear({ type: 'conversation.item.input_audio_transcription.failed', item_id: 'u2', error: { code: 'audio_unintelligible' } });
    customer(page, 'a3', 'Sorry, what was that?');
    await page.settle(() => count(lms, VOCAB.turnVerb) === 2);

    // A noise the transcriber heard nothing in is no exchange: the line before it carries over.
    spoke(page, 'u3');
    heard(page, 'u3', '  ');
    customer(page, 'a4', 'Are you still there?');
    // Two things said in a row are one answer.
    spoke(page, 'u4'); heard(page, 'u4', 'Yes, I am.');
    spoke(page, 'u5'); heard(page, 'u5', 'The refund is started today and posts in five to seven business days.');
    await new Promise((r) => setTimeout(r, 30));
    // Nothing has followed it yet, so it is not written.
    expect(count(lms, VOCAB.turnVerb)).toBe(2);
    // The other person replies, and is cut off: there is no transcript event for the line, only the end of the response.
    page.hear({ type: 'response.output_audio_transcript.delta', item_id: 'a5', delta: 'Fine, thank' });
    await page.settle(() => count(lms, VOCAB.turnVerb) === 3);
    page.hear({ type: 'response.done', response: { status: 'cancelled' } });
    // The learner speaks over it and hangs up while that is still being written down.
    spoke(page, 'u6');
    void page.el('lend').onclick!();
    await new Promise((r) => setTimeout(r, 150));
    expect(count(lms, VERB_TERMINATED)).toBe(0);
    expect(page.mics.every((t) => t.stopped)).toBe(true);
    heard(page, 'u6', 'Thanks for calling.');
    await page.settle(() => count(lms, VERB_TERMINATED) === 1);

    expect(lms.turns()).toEqual([
      { n: '1', line: 'Hi. I just checked my card and Brightline charged me twice.', response: "I'm sorry about that, I can see both charges." },
      { n: '2', line: 'Okay, so when do I get my money back?', response: '[not transcribed]' },
      { n: '3', line: 'Sorry, what was that? Are you still there?', response: 'Yes, I am. The refund is started today and posts in five to seven business days.' },
      { n: '4', line: 'Fine, thank', response: 'Thanks for calling.' },
    ]);
    // No score and no result: those are a judge's and a reviewer's.
    expect(lms.verbs()).toEqual(['launched', 'initialized', 'consented', 'took-turn', 'took-turn', 'took-turn', 'took-turn', 'terminated']);
    expect(count(lms, VERB_SCORED)).toBe(0);
    expect(lms.held.every((s) => s.result?.score === undefined)).toBe(true);
    expect(lms.held.filter((s) => s.verb.id === VOCAB.turnVerb).every((s) => String(s.context.platform).includes('(live call)'))).toBe(true);
    // The call is over: the connection and its channel are closed, and the page says what was saved and what was not.
    expect([page.peer().closed, page.peer().channel!.closed]).toEqual([true, true]);
    expect(page.showing()).toEqual(['s-reviewed']);
    expect(page.el('rvtitle').textContent).toBe('Your call is saved');
    expect(page.el('rvmsg').textContent).toContain('Your 4 exchanges with Dana Reyes are saved as text. Nothing was scored.');
    expect(page.el('chip').textContent).toBe('Saved');
    expect(page.win['__rolePlayLive']).toEqual({ placed: true, exchanges: 4, why: 'ended', errors: [] });

    const got = readLaunchedCall(lms.held, INPUT);
    if (!('call' in got)) throw new Error(`the import refused it: ${got.problems.join(' | ')}`);
    expect(got.call.turns.map((t) => t.speaker)).toEqual(Array.from({ length: 8 }, (_, i) => (i % 2 === 0 ? 'counterpart' : 'learner')));
    expect(got.call.turns.filter((t) => t.speaker === 'learner').map((t) => t.text)).toEqual(lms.turns().map((t) => t.response));
    expect(got.call.scores).toEqual([]);
    expect(lms.held.every((s, i) => i === 0 || Date.parse(s.timestamp) >= Date.parse(lms.held[i - 1]!.timestamp))).toBe(true);
  });

  it('ends the call by itself after the last exchange the scenario allows, and writes no more than that', async () => {
    const lms = new Lms();
    lms.call = () => ({ status: 200, body: lms.placed({ turnLimit: 2 }) });
    const page = await placeCall(lms);
    // The learner speaks before the other person has: the exchange says so in place of a line.
    spoke(page, 'u1'); heard(page, 'u1', 'Hello, Brightline support.');
    customer(page, 'a1', 'Hi, I was charged twice.');
    spoke(page, 'u2'); heard(page, 'u2', 'I can refund the duplicate today.');
    page.hear({ type: 'conversation.item.added', item: { id: 'a2', type: 'message', role: 'assistant' } });
    await page.settle(() => count(lms, VOCAB.turnVerb) === 2);
    // The second exchange is the last. The other person is left to finish what they are saying.
    expect(count(lms, VERB_TERMINATED)).toBe(0);
    expect(page.el('lstatus').textContent).toContain('That was the last exchange');
    // Anything said meanwhile is not a third exchange.
    spoke(page, 'u3'); heard(page, 'u3', 'One more thing.');
    page.hear({ type: 'response.output_audio_transcript.done', item_id: 'a2', transcript: 'Great, thank you.' });
    page.hear({ type: 'response.done', response: { status: 'completed' } });
    await page.settle(() => count(lms, VERB_TERMINATED) === 1);
    expect(lms.turns()).toEqual([
      { n: '1', line: '[nothing said yet]', response: 'Hello, Brightline support.' },
      { n: '2', line: 'Hi, I was charged twice.', response: 'I can refund the duplicate today.' },
    ]);
    expect(page.el('rvmsg').textContent).toContain("The call ended at this scenario's limit of 2 exchanges.");
    expect(page.win['__rolePlayLive']).toMatchObject({ exchanges: 2, why: 'limit' });
    expect(readLaunchedCall(lms.held, INPUT)).toHaveProperty('call');
  });

  it('says why when no call could be placed, records nothing of one, and can be tried again in the same visit', async () => {
    const lms = new Lms();
    lms.call = () => ({ status: 429, body: { error: 'too_many_calls', retryAfterSeconds: 600 } });
    const page = open(lms);
    await page.settle(() => page.el('chip').textContent === 'Tracked' && count(lms, VERB_INITIALIZED) === 1);
    page.el('go').onclick!(); page.el('agree').onclick!(); void page.el('consentyes').onclick!();
    await page.settle(() => !page.el('lretry').hidden);
    expect(page.el('lstatus').textContent).toBe('The call could not be placed: too many calls have been placed for this course in the last hour.');
    expect(page.el('chip').textContent).toBe('No call');
    // The microphone is let go, the connection closed, and the visit left open.
    expect([page.mics.every((t) => t.stopped), page.peers.every((p) => p.closed), page.el('lend').hidden]).toEqual([true, true, true]);
    expect(lms.verbs()).toEqual(['launched', 'initialized', 'consented']);

    // An answer with no session description, and a service on a channel the page did not open, are no call either.
    lms.call = () => ({ status: 200, body: { kind: 'cmi5-live-call', call: { dataChannel: scenario.ui.liveCall.dataChannel } } });
    void page.el('lretry').onclick!();
    await page.settle(() => lms.calls.length === 2 && !page.el('lretry').hidden);
    expect(page.el('lstatus').textContent).toBe('The call could not be placed: the LMS answered 200.');
    lms.call = () => ({ status: 200, body: lms.placed({ dataChannel: 'another-channel' }) });
    void page.el('lretry').onclick!();
    await page.settle(() => lms.calls.length === 3 && !page.el('lretry').hidden);
    expect(page.el('lstatus').textContent).toContain('a channel this scenario does not name');
    expect(page.peers.every((p) => p.remote === null)).toBe(true);

    // Tried again once the LMS will place one: a call, with no second agreement asked or recorded.
    lms.call = () => ({ status: 200, body: lms.placed() });
    void page.el('lretry').onclick!();
    await page.settle(() => page.peer().remote !== null);
    page.peer().channel!.onopen!();
    expect([page.el('lend').hidden, page.el('lretry').hidden]).toEqual([false, true]);
    expect(lms.verbs()).toEqual(['launched', 'initialized', 'consented']);
    void page.el('lend').onclick!();
    await page.settle(() => count(lms, VERB_TERMINATED) === 1);
    // Nothing was said, so nothing is there to review, and the page says so.
    expect(page.el('rvtitle').textContent).toBe('Nothing was saved');
    expect(readLaunchedCall(lms.held, INPUT)).toHaveProperty('problems');
  });

  it('asks the LMS for nothing when the microphone is refused', async () => {
    const lms = new Lms();
    const page = open(lms, { mic: 'refused' });
    await page.settle(() => page.el('chip').textContent === 'Tracked' && count(lms, VERB_INITIALIZED) === 1);
    page.el('go').onclick!(); page.el('agree').onclick!(); void page.el('consentyes').onclick!();
    await page.settle(() => !page.el('lretry').hidden);
    expect(page.el('lstatus').textContent).toBe('The call could not be placed: the microphone could not be used (NotAllowedError).');
    expect([lms.calls.length, page.peers.length]).toEqual([0, 0]);
  });

  it('ends the call where the connection drops, keeping what was written', async () => {
    const lms = new Lms();
    const page = await placeCall(lms);
    customer(page, 'a1', 'Hi, I was charged twice.');
    spoke(page, 'u1'); heard(page, 'u1', 'Let me look at that.');
    customer(page, 'a2', 'Thanks.');
    spoke(page, 'u2');
    await page.settle(() => count(lms, VOCAB.turnVerb) === 1);
    page.peer().channel!.onclose!();
    await page.settle(() => count(lms, VERB_TERMINATED) === 1);
    expect(lms.turns()).toHaveLength(1);
    expect(page.el('rvmsg').textContent).toContain('The connection dropped, so the call ended there. Your 1 exchange with Dana Reyes is saved as text.');
    // An event that arrives after the call is over changes nothing.
    const before = lms.held.length;
    heard(page, 'u2', 'Late words.');
    await new Promise((r) => setTimeout(r, 30));
    expect(lms.held).toHaveLength(before);
  });

  it('places no second call for a registration that holds one: after the page was closed mid-call, and in a later visit', async () => {
    const lms = new Lms();
    const first = await placeCall(lms);
    customer(first, 'a1', 'Hi, I was charged twice.');
    spoke(first, 'u1'); heard(first, 'u1', 'Let me look at that.');
    customer(first, 'a2', 'Thanks.');
    await first.settle(() => count(lms, VOCAB.turnVerb) === 1);
    // The page is closed. The course is opened again and the LMS continues the session.
    const again = open(lms);
    await again.settle(() => count(lms, VERB_TERMINATED) === 1);
    expect(again.showing()).toEqual(['s-reviewed']);
    expect(again.el('rvmsg').textContent).toContain('Your call ended when its page was closed. The 1 exchange written up to then is saved. One course holds one call');
    expect([lms.calls.length, again.peers.length, count(lms, VERB_INITIALIZED)]).toEqual([1, 0, 1]);
    expect(readLaunchedCall(lms.held, INPUT)).toHaveProperty('call');

    // A later visit is a new session. It is opened and closed, and no call is placed in it.
    lms.session = LATER_SESSION;
    const later = open(lms);
    await later.settle(() => count(lms, VERB_TERMINATED) === 2);
    expect(later.el('rvmsg').textContent).toContain('This course already holds a call from an earlier visit.');
    expect([lms.calls.length, later.peers.length, count(lms, VOCAB.turnVerb)]).toEqual([1, 0, 1]);
    expect(later.win['__rolePlayLive']).toEqual({ placed: false, why: 'call-in-another-session' });
  });

  it('offers no call where one cannot be placed: a browser without WebRTC, and a page opened without a course', async () => {
    const lms = new Lms();
    const old = open(lms, { webrtc: false });
    await old.settle(() => old.el('chip').textContent === 'Tracked' && count(lms, VERB_INITIALIZED) === 1);
    expect(old.el('go').disabled).toBe(true);
    expect(old.el('voicenote').textContent).toContain("This browser can't place a live call");
    old.el('go').onclick!();
    expect(old.showing()).toEqual(['s-welcome']);

    const preview = open(new Lms(), { launched: false });
    await preview.settle(() => preview.el('chip').textContent === 'Preview, not saved');
    expect(preview.el('go').disabled).toBe(true);
    expect(preview.el('voicenote').textContent).toContain('A live call is placed through a course.');
  });

  it('leaves the scripted practice as it was when the launch does not ask for a live call', async () => {
    const lms = new Lms();
    const page = open(lms, { call: null });
    await page.settle(() => page.showing().includes('s-welcome') && page.el('chip').textContent === 'Tracked' && count(lms, VERB_INITIALIZED) === 1);
    expect([page.el('personas').hidden, page.el('steps').hidden, page.el('livesteps').hidden, page.el('go').disabled]).toEqual([false, false, true, false]);
    page.el('go').onclick!(); page.el('agree').onclick!(); await page.el('consentyes').onclick!();
    expect(page.showing()).toEqual(['s-call']);
    expect([lms.calls.length, page.peers.length]).toEqual([0, 0]);
    // And for a live call the scripted screens are the ones put away.
    const live = open(new Lms());
    await live.settle(() => live.el('chip').textContent === 'Tracked');
    expect([live.el('personas').hidden, live.el('steps').hidden, live.el('livesteps').hidden]).toEqual([true, true, false]);
    expect(live.el('go').textContent).toBe('Start the call');
  });
});
