/**
 * The shared voice module, in node, against fake speech objects. No browser and no audio: what
 * is tested is the logic a page relies on (sentences, cumulative answers, label matching, the
 * state machine, the gesture rule). Real microphone audio and a real synthesizer are not
 * exercised here and cannot be.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VOICE_BROWSER_MODULE } from '../voice/index.js';

interface VoiceError { code: string; message: string }
interface Voice {
  supported: { input: boolean; output: boolean };
  usesRemoteRecognition: boolean | null;
  notice: string;
  state: string;
  listeningRequested: boolean;
  handsFree: boolean;
  startListening(options?: { handsFree?: boolean }): boolean;
  stopListening(): void;
  speak(text: string): number;
  speakDelta(text: string): number;
  finishDelta(): number;
  skipDelta(text: string): void;
  resetDelta(): void;
  stop(): void;
  dispose(): void;
}
interface Option { id: string; label: string; aliases?: string[] }
interface VoiceModule {
  VOICE_STATES: readonly string[];
  REMOTE_RECOGNITION_NOTICE: string;
  splitSentences(text: string, options?: { final?: boolean }): { sentences: string[]; consumed: number; rest: string };
  chunkForSpeech(sentence: string, max?: number): string[];
  createDeltaTracker(): { push(text: string): { sentences: string[]; restarted: boolean }; finish(): string[]; skip(text: string): void; reset(): void };
  plainForSpeech(text: string): string;
  pickVoice(voices: unknown[], lang: string): { name: string } | null;
  normalizeSpoken(text: string): string;
  matchSpoken(heard: string, options: Option[]): { match: Option | null; heard: string; ambiguous: Option[] };
  detectVoiceSupport(env: Record<string, unknown>): { input: boolean; output: boolean };
  recognitionIsRemote(env: Record<string, unknown>): boolean | null;
  createVoice(config: Record<string, unknown>): Voice;
}

const here = dirname(fileURLToPath(import.meta.url));
const voice = await import(/* @vite-ignore */ pathToFileURL(VOICE_BROWSER_MODULE).href) as VoiceModule;

/** A recognizer that does what the test tells it to, the way a browser would. */
class FakeRecognition {
  static made: FakeRecognition[] = [];
  static get last(): FakeRecognition { return FakeRecognition.made[FakeRecognition.made.length - 1]!; }
  lang = ''; interimResults = false; continuous = false; maxAlternatives = 0;
  started = false; stopped = false; aborted = false;
  onstart: (() => void) | null = null;
  onresult: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onend: (() => void) | null = null;
  constructor() { FakeRecognition.made.push(this); }
  start(): void { this.started = true; }
  stop(): void { this.stopped = true; this.onend?.(); }
  abort(): void { this.aborted = true; this.onerror?.({ error: 'aborted' }); this.onend?.(); }
  open(): void { this.onstart?.(); }
  hear(transcript: string, isFinal: boolean): void {
    this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript, confidence: 0.9 }], { isFinal })] });
  }
  fail(error: string): void { this.onerror?.({ error }); this.onend?.(); }
  end(): void { this.onend?.(); }
}

class FakeUtterance {
  lang = ''; voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(readonly text: string) {}
}

function fakeSynthesis(voices: unknown[] = []) {
  const spoken: FakeUtterance[] = [];
  let cancels = 0;
  return {
    spoken,
    get cancels() { return cancels; },
    speak(utterance: FakeUtterance) { spoken.push(utterance); },
    cancel() { cancels++; },
    getVoices: () => voices,
    /** The synthesizer finished the utterance it was given last. */
    finish() { spoken[spoken.length - 1]!.onend?.(); },
    said: () => spoken.map(u => u.text),
  };
}

function setup(over: Record<string, unknown> = {}, config: Record<string, unknown> = {}) {
  FakeRecognition.made = [];
  const synth = fakeSynthesis();
  const timers: Array<() => void> = [];
  const events = { states: [] as string[], errors: [] as VoiceError[], interim: [] as string[], final: [] as string[] };
  const env = {
    SpeechRecognition: FakeRecognition, speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance,
    userActivation: { isActive: true }, userAgent: 'Mozilla/5.0 Chrome/140.0', userAgentBrands: undefined, language: 'en-GB',
    setTimeout: (run: () => void) => { timers.push(run); return timers.length; }, clearTimeout: (id: number) => { timers[id - 1] = () => undefined; },
    ...over,
  };
  const instance = voice.createVoice({
    env,
    onState: (state: string) => events.states.push(state),
    onError: (error: VoiceError) => events.errors.push(error),
    onInterim: (text: string) => events.interim.push(text),
    onFinal: (text: string) => events.final.push(text),
    ...config,
  });
  const runTimers = () => { for (const run of timers.splice(0)) run(); };
  return { instance, synth, events, env, runTimers };
}

describe('sentences', () => {
  it('ends a sentence at a terminator followed by space, and keeps the unfinished tail', () => {
    expect(voice.splitSentences('One. Two! Three? Four')).toEqual({ sentences: ['One.', 'Two!', 'Three?'], consumed: 16, rest: ' Four' });
    expect(voice.splitSentences('Done.').sentences).toEqual([]);
    expect(voice.splitSentences('Done.', { final: true }).sentences).toEqual(['Done.']);
  });

  it('does not break a number, an initial, a list numeral or a common abbreviation', () => {
    expect(voice.splitSentences('It rose 3.5 points. Next', {}).sentences).toEqual(['It rose 3.5 points.']);
    expect(voice.splitSentences('Use a store, e.g. a ledger. Then stop. ').sentences).toEqual(['Use a store, e.g. a ledger.', 'Then stop.']);
    expect(voice.splitSentences('1. First item\n2. Second item\n').sentences).toEqual(['1. First item', '2. Second item']);
    expect(voice.splitSentences('Ask J. Okafor about it. Now ').sentences).toEqual(['Ask J. Okafor about it.']);
  });

  it('breaks at a line, at a closing quote after the terminator, and at a full-width terminator', () => {
    expect(voice.splitSentences('A heading\nShe said "go." Then left. ').sentences).toEqual(['A heading', 'She said "go."', 'Then left.']);
    expect(voice.splitSentences('こんにちは。元気').sentences).toEqual(['こんにちは。']);
  });

  it('cuts a long sentence at a comma or a space, never mid-word', () => {
    const long = `${'word '.repeat(30)}and so, ${'more '.repeat(30)}end`;
    const chunks = voice.chunkForSpeech(long, 120);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.length <= 121)).toBe(true);
    expect(chunks.join(' ')).toBe(long);
    expect(voice.chunkForSpeech('short')).toEqual(['short']);
  });

  it('removes the marks a synthesizer would read out', () => {
    expect(voice.plainForSpeech('## A **bold** `claim`, see [the note](https://example.test/x) and https://example.test/y')).toBe('A bold claim, see the note and');
  });
});

describe('a cumulative answer', () => {
  it('hands out each sentence once, when it is complete', () => {
    const tracker = voice.createDeltaTracker();
    expect(tracker.push('The orchard').sentences).toEqual([]);
    expect(tracker.push('The orchard is dry. Water').sentences).toEqual(['The orchard is dry.']);
    expect(tracker.push('The orchard is dry. Water').sentences).toEqual([]);
    expect(tracker.push('The orchard is dry. Water it at dawn. Then').sentences).toEqual(['Water it at dawn.']);
    expect(tracker.finish()).toEqual(['Then']);
    expect(tracker.finish()).toEqual([]);
  });

  it('starts again when the text is a different answer, including before anything was handed out', () => {
    const tracker = voice.createDeltaTracker();
    tracker.push('First answer. And');
    expect(tracker.push('Second answer. More')).toEqual({ sentences: ['Second answer.'], restarted: true });
    const early = voice.createDeltaTracker();
    early.push('Hel');
    expect(early.push('Other text. ')).toEqual({ sentences: ['Other text.'], restarted: true });
    // The same answer, trimmed by its sender at the end, is not a new one.
    const trimmed = voice.createDeltaTracker();
    trimmed.push('Nearly done ');
    expect(trimmed.push('Nearly done').restarted).toBe(false);
  });
});

describe('matching what was heard against labels', () => {
  const options: Option[] = [
    { id: 'mission', label: 'Send Wren on a mission', aliases: ['send the agent on a mission', 'mission'] },
    { id: 'tools', label: 'Missing tools' },
    { id: 'feedback', label: 'Missing feedback' },
    { id: 'deploy', label: 'Deploy and measure', aliases: ['deploy'] },
  ];
  const id = (heard: string) => voice.matchSpoken(heard, options).match?.id ?? null;

  it('takes an exact label or alias, whatever the case and punctuation', () => {
    expect(id('Deploy.')).toBe('deploy');
    expect(id('send the agent on a mission')).toBe('mission');
    expect(id('MISSING TOOLS!')).toBe('tools');
  });

  it('takes a label said inside a longer phrase, and the words of one label alone', () => {
    expect(id('please choose missing feedback now')).toBe('feedback');
    expect(id('okay deploy')).toBe('deploy');
    expect(id('the tools')).toBe('tools');
  });

  it('does nothing when two labels fit or none does, and says what was heard', () => {
    const tied = voice.matchSpoken('missing', options);
    expect(tied.match).toBeNull();
    expect(tied.ambiguous.map(option => option.id)).toEqual(['tools', 'feedback']);
    expect(voice.matchSpoken('Open the pod bay doors', options)).toEqual({ match: null, heard: 'open the pod bay doors', ambiguous: [] });
    expect(voice.matchSpoken('  ', options).match).toBeNull();
  });
});

describe('what the browser has', () => {
  it('reports each half on its own, and neither when the objects are absent', () => {
    expect(voice.detectVoiceSupport({})).toEqual({ input: false, output: false });
    expect(voice.detectVoiceSupport({ speechSynthesis: fakeSynthesis(), SpeechSynthesisUtterance: FakeUtterance })).toEqual({ input: false, output: true });
    expect(voice.detectVoiceSupport({ SpeechRecognition: FakeRecognition })).toEqual({ input: true, output: false });
  });

  it('a page with neither half is unsupported, listens to nothing and speaks nothing', () => {
    const { instance, events } = setup({ SpeechRecognition: undefined, speechSynthesis: undefined, SpeechSynthesisUtterance: undefined });
    expect(instance.state).toBe('unsupported');
    expect(instance.startListening()).toBe(false);
    expect(instance.speak('Anything.')).toBe(0);
    expect(events.errors.map(error => error.code)).toEqual(['unsupported-input', 'unsupported-output']);
    expect(FakeRecognition.made).toHaveLength(0);
  });

  it('says a Chromium recognizer is remote, another one unknown, and never that one is local', () => {
    expect(voice.recognitionIsRemote({ SpeechRecognition: FakeRecognition, userAgent: 'Mozilla/5.0 Chrome/140.0 Safari/537.36' })).toBe(true);
    expect(voice.recognitionIsRemote({ SpeechRecognition: FakeRecognition, userAgentBrands: [{ brand: 'Chromium', version: '140' }] })).toBe(true);
    expect(voice.recognitionIsRemote({ SpeechRecognition: FakeRecognition, userAgent: 'Mozilla/5.0 Version/18.0 Safari/605.1.15' })).toBeNull();
    expect(voice.recognitionIsRemote({ userAgent: 'Mozilla/5.0 Firefox/140.0' })).toBe(false);
    expect(voice.REMOTE_RECOGNITION_NOTICE).toMatch(/send the audio of what you say to the browser vendor's speech service/);
    expect(setup().instance.notice).toBe(voice.REMOTE_RECOGNITION_NOTICE);
  });

  it('picks the default voice of the language, then a local one for the locale, else leaves it to the browser', () => {
    const voices = [
      { name: 'fr', lang: 'fr-FR', default: true, localService: true },
      { name: 'us-remote', lang: 'en-US', default: false, localService: false },
      { name: 'gb-local', lang: 'en-GB', default: false, localService: true },
      { name: 'gb-remote', lang: 'en_GB', default: false, localService: false },
    ];
    expect(voice.pickVoice(voices, 'en-GB')?.name).toBe('gb-local');
    expect(voice.pickVoice(voices, 'fr-CA')?.name).toBe('fr');
    expect(voice.pickVoice(voices, 'en-AU')?.name).toBe('gb-local');
    expect(voice.pickVoice(voices, 'de-DE')).toBeNull();
  });
});

describe('speech in', () => {
  it('opens the microphone only when asked, reports interim and final words, and returns to idle', () => {
    const { instance, events } = setup();
    expect(FakeRecognition.made).toHaveLength(0);
    expect(instance.state).toBe('idle');
    expect(instance.startListening()).toBe(true);
    const rec = FakeRecognition.last;
    expect([rec.started, rec.lang, rec.interimResults, rec.continuous]).toEqual([true, 'en-GB', true, false]);
    // Not listening until the browser says the microphone is open: the permission prompt is not listening.
    expect(instance.state).toBe('idle');
    expect(instance.listeningRequested).toBe(true);
    rec.open();
    expect(instance.state).toBe('listening');
    rec.hear('send the', false);
    rec.hear('send the agent on a mission', true);
    rec.end();
    expect(events.interim).toEqual(['send the']);
    expect(events.final).toEqual(['send the agent on a mission']);
    expect(events.states).toEqual(['listening', 'idle']);
    expect(events.errors).toEqual([]);
    expect(FakeRecognition.made).toHaveLength(1);
  });

  it('refuses to start without a user gesture where the browser reports one', () => {
    const { instance, events } = setup({ userActivation: { isActive: false } });
    expect(instance.startListening()).toBe(false);
    expect(FakeRecognition.made).toHaveLength(0);
    expect(events.errors.map(error => error.code)).toEqual(['needs-gesture']);
    expect(instance.state).toBe('idle');
  });

  it('tells a blocked microphone from silence from a missing microphone', () => {
    const denied = setup();
    denied.instance.startListening();
    FakeRecognition.last.fail('not-allowed');
    expect(denied.instance.state).toBe('denied');
    expect(denied.events.errors.map(error => error.code)).toEqual(['denied']);

    const silent = setup();
    silent.instance.startListening();
    FakeRecognition.last.open();
    FakeRecognition.last.fail('no-speech');
    expect(silent.instance.state).toBe('idle');
    expect(silent.events.errors.map(error => error.code)).toEqual(['no-speech']);

    const none = setup();
    none.instance.startListening();
    FakeRecognition.last.fail('audio-capture');
    expect(none.instance.state).toBe('error');
    expect(none.events.errors.map(error => error.code)).toEqual(['no-microphone']);
    // The next attempt clears it.
    none.instance.startListening();
    FakeRecognition.last.open();
    expect(none.instance.state).toBe('listening');
  });

  it('a recognizer that ends by itself having heard nothing is silence; one the person stopped is not', () => {
    const quiet = setup();
    quiet.instance.startListening();
    FakeRecognition.last.open();
    FakeRecognition.last.end();
    expect(quiet.events.errors.map(error => error.code)).toEqual(['no-speech']);

    const stopped = setup();
    stopped.instance.startListening();
    FakeRecognition.last.open();
    stopped.instance.stopListening();
    expect(FakeRecognition.last.stopped).toBe(true);
    expect(stopped.events.errors).toEqual([]);
    expect(stopped.instance.state).toBe('idle');
  });

  it('hands-free listens again after each utterance, and stops itself after three silent rounds', () => {
    const { instance, events, runTimers } = setup();
    instance.startListening({ handsFree: true });
    FakeRecognition.last.open();
    FakeRecognition.last.hear('first', true);
    FakeRecognition.last.end();
    expect(FakeRecognition.made).toHaveLength(1);
    runTimers();
    expect(FakeRecognition.made).toHaveLength(2);
    expect(instance.handsFree).toBe(true);
    for (let round = 0; round < 3; round++) {
      FakeRecognition.last.open();
      FakeRecognition.last.fail('no-speech');
      runTimers();
    }
    expect(events.final).toEqual(['first']);
    expect(events.errors.map(error => error.code)).toEqual(['hands-free-ended']);
    expect(FakeRecognition.made).toHaveLength(4);
    expect(instance.listeningRequested).toBe(false);
    expect(instance.state).toBe('idle');
  });

  it('stopping hands-free cancels the restart that was pending', () => {
    const { instance, runTimers } = setup();
    instance.startListening({ handsFree: true });
    FakeRecognition.last.open();
    FakeRecognition.last.hear('one', true);
    FakeRecognition.last.end();
    instance.stopListening();
    runTimers();
    expect(FakeRecognition.made).toHaveLength(1);
  });
});

describe('speech out', () => {
  it('speaks a sentence at a time, in order, each only after the one before it ended', () => {
    const { instance, synth, events } = setup();
    expect(instance.speak('The score moved. The cause was a missing tool.')).toBe(2);
    expect(synth.said()).toEqual(['The score moved.']);
    expect(synth.spoken[0]!.lang).toBe('en-GB');
    expect(instance.state).toBe('speaking');
    synth.finish();
    expect(synth.said()).toEqual(['The score moved.', 'The cause was a missing tool.']);
    synth.finish();
    expect(instance.state).toBe('idle');
    expect(events.states).toEqual(['speaking', 'idle']);
  });

  it('follows a cumulative answer and speaks only what each step completed', () => {
    const { instance, synth } = setup();
    expect(instance.speakDelta('The orchard')).toBe(0);
    expect(instance.speakDelta('The orchard is **dry**. Water')).toBe(1);
    expect(instance.speakDelta('The orchard is **dry**. Water')).toBe(0);
    synth.finish();
    expect(instance.speakDelta('The orchard is **dry**. Water it at dawn')).toBe(0);
    expect(instance.finishDelta()).toBe(1);
    synth.finish();
    expect(synth.said()).toEqual(['The orchard is dry.', 'Water it at dawn']);
  });

  it('stop cancels, drops the queue, and keeps the rest of that answer silent until the next one', () => {
    const { instance, synth } = setup();
    instance.speakDelta('One. Two. Three. Four');
    expect(synth.said()).toEqual(['One.']);
    instance.stop();
    expect(synth.cancels).toBe(1);
    expect(instance.state).toBe('idle');
    // The cancelled utterance's own end event changes nothing.
    synth.spoken[0]!.onend?.();
    expect(synth.said()).toEqual(['One.']);
    expect(instance.speakDelta('One. Two. Three. Four. Five. ')).toBe(0);
    expect(instance.finishDelta()).toBe(0);
    expect(instance.speakDelta('A new answer. ')).toBe(1);
    expect(synth.said()).toEqual(['One.', 'A new answer.']);
  });

  it('text marked as already said is skipped', () => {
    const { instance, synth } = setup();
    instance.skipDelta('Old answer. Still old.');
    expect(instance.speakDelta('Old answer. Still old.')).toBe(0);
    expect(instance.finishDelta()).toBe(0);
    expect(synth.said()).toEqual([]);
  });

  it('a browser that refuses to speak is reported once and the queue is dropped', () => {
    const { instance, synth, events } = setup();
    instance.speak('One. Two. Three.');
    synth.spoken[0]!.onerror?.({ error: 'not-allowed' });
    expect(events.errors.map(error => error.code)).toEqual(['speech-blocked']);
    expect(synth.said()).toEqual(['One.']);
    expect(instance.state).toBe('idle');
  });

  it('uses the page\'s own preparation of each sentence, and skips what it empties', () => {
    const { instance, synth } = setup({}, { prepare: (sentence: string) => sentence.replace(/\[\[[^\]]+\]\]/g, '').trim() });
    instance.speak('See the record store [[lrs]]. [[only-a-mark]]');
    synth.finish();
    expect(synth.said()).toEqual(['See the record store .']);
  });
});

describe('one at a time', () => {
  it('starting to listen stops what was being read (barge-in)', () => {
    const { instance, synth } = setup();
    instance.speak('A long answer. With more. And more.');
    expect(instance.state).toBe('speaking');
    instance.startListening();
    expect(synth.cancels).toBe(1);
    FakeRecognition.last.open();
    expect(instance.state).toBe('listening');
    FakeRecognition.last.hear('deploy', true);
    FakeRecognition.last.end();
    expect(synth.said()).toEqual(['A long answer.']);
    expect(instance.state).toBe('idle');
  });

  it('an answer that arrives while a single utterance is being heard waits for it', () => {
    const { instance, synth } = setup();
    instance.startListening();
    FakeRecognition.last.open();
    instance.speak('The answer.');
    expect(synth.said()).toEqual([]);
    expect(instance.state).toBe('listening');
    FakeRecognition.last.hear('thanks', true);
    FakeRecognition.last.end();
    expect(synth.said()).toEqual(['The answer.']);
    expect(instance.state).toBe('speaking');
  });

  it('hands-free yields to the answer, so the page does not transcribe itself, and resumes after it', () => {
    const { instance, synth, events } = setup();
    instance.startListening({ handsFree: true });
    const first = FakeRecognition.last;
    first.open();
    instance.speak('The answer.');
    expect(first.aborted).toBe(true);
    expect(synth.said()).toEqual(['The answer.']);
    expect(instance.state).toBe('speaking');
    expect(FakeRecognition.made).toHaveLength(1);
    synth.finish();
    expect(FakeRecognition.made).toHaveLength(2);
    FakeRecognition.last.open();
    expect(instance.state).toBe('listening');
    expect(events.errors).toEqual([]);
  });

  it('after dispose nothing is heard, said or reported', () => {
    const { instance, synth, events } = setup();
    instance.startListening();
    const rec = FakeRecognition.last;
    rec.open();
    instance.dispose();
    expect(rec.aborted).toBe(true);
    rec.hear('late', true);
    expect(instance.startListening()).toBe(false);
    expect(instance.speak('Late.')).toBe(0);
    expect(events.final).toEqual([]);
    expect(synth.said()).toEqual([]);
  });
});

describe('the file itself', () => {
  const source = readFileSync(VOICE_BROWSER_MODULE, 'utf8');
  const code = source.split('\n').filter(line => !/^\s*(\/\/|\*|\/\*)/.test(line)).join('\n');

  it('is one dependency-free module: no import, no network call, no storage, no environment', () => {
    expect(VOICE_BROWSER_MODULE).toBe(join(here, '../voice/voice.js'));
    expect(code).not.toMatch(/^\s*import\s|\brequire\(|\bimport\(/m);
    expect(code).not.toMatch(/\bfetch\(|XMLHttpRequest|WebSocket|sendBeacon|EventSource|getUserMedia|MediaRecorder/);
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|process\.env/);
  });

  it('starts a recognizer in one place only, and names no vertical', () => {
    expect(code.match(/\.start\(\)/g)).toHaveLength(1);
    expect(code).not.toMatch(/i2idlx|foxxi|workbench|coached|cpw/i);
    expect(voice.VOICE_STATES).toEqual(['idle', 'listening', 'speaking', 'denied', 'unsupported', 'error']);
  });
});
