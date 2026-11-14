// Voice in and voice out for a page, on what the browser already has. An ES module with no build
// step and no dependency: a bridge serves this file as it is and a page imports it, or a bundler
// imports it straight from this folder.
//
// Speech in is the browser's SpeechRecognition (prefixed in Chromium and Safari, absent in
// Firefox). Speech out is speechSynthesis. This module calls no model, makes no network request
// of its own, and never opens the microphone except inside a call the page makes from a person's
// own gesture. What the BROWSER does with the audio is not ours to promise, so the notice below
// says it, and every page that shows a microphone control shows that notice beside it.
//
// Everything that is logic (sentence splitting, tracking a cumulative answer, matching what was
// heard against labels, the state machine) takes its speech objects as arguments, so it runs in
// node against fakes. See ../tests/voice.test.ts.

/** Every value `state` can take. */
export const VOICE_STATES = Object.freeze(['idle', 'listening', 'speaking', 'denied', 'unsupported', 'error']);

/** The sentence a page shows next to its microphone control. */
export const REMOTE_RECOGNITION_NOTICE = 'Speech recognition is done by your browser, not by this page. '
  + 'Chrome and most Chromium browsers send the audio of what you say to the browser vendor\'s speech service to be transcribed, '
  + 'and other browsers may do the same. This page sends no audio anywhere itself.';

/** What a person is told for each failure. A page may show `error.message` as it is. */
const MESSAGES = Object.freeze({
  'unsupported-input': 'This browser has no speech recognition.',
  'unsupported-output': 'This browser cannot read text aloud.',
  'needs-gesture': 'The microphone starts only when you press the control yourself.',
  denied: 'The microphone is blocked for this page. Allow it in the browser\'s site settings and try again.',
  'no-speech': 'Nothing was heard.',
  'no-microphone': 'No microphone was found.',
  network: 'The browser could not reach its speech service.',
  language: 'The browser cannot recognize speech in this language.',
  'hands-free-ended': 'Hands-free listening stopped after a long silence.',
  'recognition-failed': 'Speech recognition stopped unexpectedly.',
  'speech-blocked': 'The browser refused to read aloud. Press the control again.',
  'speech-failed': 'Reading aloud failed.',
});

const ABBREVIATIONS = new Set(['e.g', 'i.e', 'vs', 'mr', 'mrs', 'ms', 'dr', 'st', 'fig', 'cf']);
const TERMINATORS = '.!?…';
const WIDE_TERMINATORS = '。！？';
const CLOSERS = '"\')]”’';
const isSpace = ch => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ';

/** True when the period at `at` ends an abbreviation, an initial or a list numeral, not a sentence. */
function periodIsInternal(text, start, at) {
  let from = at;
  while (from > start && !isSpace(text[from - 1])) from--;
  const word = text.slice(from, at).replace(/^[("'“‘[]+/, '');
  if (!word) return false;
  if (/^\d+$/.test(word) || /^\p{L}$/u.test(word)) return true;
  return ABBREVIATIONS.has(word.toLowerCase().replace(/\.$/, ''));
}

/**
 * Split text into whole sentences.
 *
 * A sentence ends at `.`, `!`, `?` or an ellipsis followed by white space, at a full-width
 * terminator, or at a line break. Text after the last such boundary is `rest`: it may still be
 * growing, so it is returned as a sentence only when `final` is true. `consumed` is how many
 * characters of `text` the returned sentences cover.
 */
export function splitSentences(text, { final = false } = {}) {
  const source = String(text ?? '');
  const sentences = [];
  let start = 0;
  let consumed = 0;
  const take = end => {
    const sentence = source.slice(start, end).trim();
    if (sentence) sentences.push(sentence);
    start = end;
    consumed = end;
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\n') { take(i + 1); continue; }
    if (WIDE_TERMINATORS.includes(ch)) { take(i + 1); continue; }
    if (!TERMINATORS.includes(ch)) continue;
    let end = i + 1;
    while (end < source.length && TERMINATORS.includes(source[end])) end++;
    const single = end === i + 1 && ch === '.';
    while (end < source.length && CLOSERS.includes(source[end])) end++;
    // The end of the text is not a boundary yet: "3." may become "3.5", "e.g." may go on.
    if (end >= source.length || !isSpace(source[end])) { i = end - 1; continue; }
    if (single && periodIsInternal(source, start, i)) { i = end - 1; continue; }
    take(end);
    i = end - 1;
  }
  if (final) take(source.length);
  return { sentences, consumed, rest: source.slice(consumed) };
}

/** Cut one long sentence at commas or spaces so no single utterance runs past `max` characters. */
export function chunkForSpeech(sentence, max = 220) {
  const chunks = [];
  let rest = String(sentence ?? '').trim();
  while (rest.length > max) {
    const window = rest.slice(0, max + 1);
    let cut = Math.max(window.lastIndexOf(', '), window.lastIndexOf('; '), window.lastIndexOf(': '));
    cut = cut > max / 3 ? cut + 1 : window.lastIndexOf(' ');
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * Follow an answer that arrives as cumulative text and hand out each sentence once, when it is
 * complete. Text that does not continue what was already handed out is a new answer.
 */
export function createDeltaTracker() {
  let seen = '';
  let last = '';
  return {
    /** Sentences newly completed by this cumulative text, and whether it began a new answer. */
    push(cumulative) {
      const text = String(cumulative ?? '');
      // What was handed out must still be how the text begins. Before anything was handed out,
      // the text must still be the one being followed, grown or trimmed.
      const continues = text.startsWith(seen) && (seen.length > 0 || !last || text.startsWith(last) || last.startsWith(text));
      const restarted = !continues;
      if (restarted) seen = '';
      const { sentences, consumed } = splitSentences(text.slice(seen.length));
      seen = text.slice(0, seen.length + consumed);
      last = text;
      return { sentences, restarted };
    },
    /** The answer is over: whatever is left, complete or not. */
    finish() {
      const { sentences } = splitSentences(last.slice(seen.length), { final: true });
      seen = last;
      return sentences;
    },
    /** Treat this text as already said. */
    skip(cumulative) { last = String(cumulative ?? ''); seen = last; },
    reset() { seen = ''; last = ''; },
    get started() { return last.length > 0; },
  };
}

/** Markdown marks and bare links removed, so a synthesizer does not read punctuation aloud. */
export function plainForSpeech(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_`~#|]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const primary = lang => String(lang || '').toLowerCase().split(/[-_]/)[0];

/**
 * The voice to use for a language: the browser's default voice when it speaks that language,
 * then an on-device voice for the exact locale, then any voice for the locale, then any voice for
 * the language. Null leaves the choice to the browser.
 */
export function pickVoice(voices, lang) {
  const list = Array.from(voices || []).filter(voice => voice && typeof voice.lang === 'string');
  const want = String(lang || '').toLowerCase().replace('_', '-');
  const exact = list.filter(voice => voice.lang.toLowerCase().replace('_', '-') === want);
  const family = list.filter(voice => primary(voice.lang) === primary(want));
  return exact.find(voice => voice.default) || family.find(voice => voice.default)
    || exact.find(voice => voice.localService) || exact[0] || family.find(voice => voice.localService) || family[0] || null;
}

const STOP_WORDS = new Set(['a', 'an', 'the', 'please', 'to', 'on', 'of', 'and', 'for', 'my', 'now', 'then', 'ok', 'okay', 'um', 'uh']);

/** Lower case, no accents, no punctuation, single spaces. */
export function normalizeSpoken(text) {
  return String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * Match what was heard against the labels on screen. No model and no guessing.
 *
 * `options` is a list of `{ id, label, aliases? }`. The rules, in order, each needing exactly
 * one option to satisfy it:
 *   1. what was heard is a phrase of the option, exactly;
 *   2. what was heard contains a phrase of the option as whole words (the longest phrase wins);
 *   3. every word heard, small words aside, is a word of the option's phrases.
 * Anything else is no match. `ambiguous` lists the options a tied rule could not choose between.
 */
export function matchSpoken(heard, options) {
  const said = normalizeSpoken(heard);
  const none = (ambiguous = []) => ({ match: null, heard: said, ambiguous });
  if (!said) return none();
  const entries = Array.from(options || []).map(option => ({
    option,
    phrases: [option.label, ...(option.aliases || [])].map(normalizeSpoken).filter(Boolean),
  })).filter(entry => entry.phrases.length);
  const only = found => (found.length === 1 ? { match: found[0].option, heard: said, ambiguous: [] } : null);

  const exact = entries.filter(entry => entry.phrases.includes(said));
  if (exact.length) return only(exact) || none(exact.map(entry => entry.option));

  const padded = ` ${said} `;
  const contained = entries.map(entry => ({
    entry,
    length: Math.max(0, ...entry.phrases.filter(phrase => padded.includes(` ${phrase} `)).map(phrase => phrase.length)),
  })).filter(row => row.length > 0);
  if (contained.length) {
    const longest = Math.max(...contained.map(row => row.length));
    const best = contained.filter(row => row.length === longest).map(row => row.entry);
    return only(best) || none(best.map(entry => entry.option));
  }

  const words = said.split(' ').filter(word => !STOP_WORDS.has(word));
  if (!words.length) return none();
  const covered = entries.filter(entry => {
    const known = new Set(entry.phrases.flatMap(phrase => phrase.split(' ')));
    return words.every(word => known.has(word));
  });
  return only(covered) || none(covered.map(entry => entry.option));
}

/** The speech objects of the browser this runs in. Every one may be missing. */
function browserEnvironment() {
  const g = globalThis;
  return {
    SpeechRecognition: g.SpeechRecognition || g.webkitSpeechRecognition,
    speechSynthesis: g.speechSynthesis,
    SpeechSynthesisUtterance: g.SpeechSynthesisUtterance,
    userActivation: g.navigator?.userActivation,
    userAgent: g.navigator?.userAgent || '',
    userAgentBrands: g.navigator?.userAgentData?.brands,
    language: g.navigator?.language,
    setTimeout: (run, ms) => g.setTimeout(run, ms),
    clearTimeout: id => g.clearTimeout(id),
  };
}

/** Which halves this browser has. A page hides the control for a half that is false. */
export function detectVoiceSupport(env = browserEnvironment()) {
  return Object.freeze({
    input: typeof env.SpeechRecognition === 'function',
    output: Boolean(env.speechSynthesis) && typeof env.speechSynthesis.speak === 'function' && typeof env.SpeechSynthesisUtterance === 'function',
  });
}

/**
 * Best effort: does this browser's recognizer send audio to a remote service?
 *   true  it is a Chromium browser, whose built-in recognizer does;
 *   null  it has a recognizer and we cannot tell, so assume it may;
 *   false it has no recognizer, so nothing is sent.
 * It never claims that recognition is local.
 */
export function recognitionIsRemote(env = browserEnvironment()) {
  if (typeof env.SpeechRecognition !== 'function') return false;
  const brands = Array.isArray(env.userAgentBrands) ? env.userAgentBrands : null;
  const chromium = brands
    ? brands.some(entry => /chromium|chrome|edge/i.test(String(entry?.brand || '')))
    : /\b(Chrome|Chromium|Edg)\//.test(String(env.userAgent || ''));
  return chromium ? true : null;
}

const RECOGNITION_ERRORS = Object.freeze({
  'not-allowed': 'denied',
  'service-not-allowed': 'denied',
  'no-speech': 'no-speech',
  'audio-capture': 'no-microphone',
  network: 'network',
  'language-not-supported': 'language',
  aborted: null,
});

/**
 * One instance drives one page's voice.
 *
 * config.lang        BCP 47 tag for both halves; defaults to the browser's language, then en-US
 * config.onInterim   (text) => void, words still being recognized
 * config.onFinal     (text, { confidence }) => void, a finished utterance
 * config.onState     (state, previous) => void, called on every change
 * config.onError     ({ code, message }) => void; see README.md for the codes
 * config.prepare     (sentence) => string, applied to each sentence before it is spoken
 *                    (default: plainForSpeech). An empty result is not spoken.
 * config.maxSilentRounds  hands-free stops after this many rounds with nothing heard (default 3)
 * config.env         the speech objects, for tests; defaults to the browser's
 */
export function createVoice(config = {}) {
  const env = { ...browserEnvironment(), ...(config.env || {}) };
  const supported = detectVoiceSupport(env);
  const remote = recognitionIsRemote(env);
  const prepare = typeof config.prepare === 'function' ? config.prepare : plainForSpeech;
  const maxSilentRounds = Number.isInteger(config.maxSilentRounds) && config.maxSilentRounds > 0 ? config.maxSilentRounds : 3;
  const tracker = createDeltaTracker();
  let lang = config.lang || env.language || 'en-US';

  let state = supported.input || supported.output ? 'idle' : 'unsupported';
  let sticky = null;          // 'denied' | 'error': stays until the next attempt to listen
  let recognizer = null;      // the live SpeechRecognition, from start() until its end event
  let open = false;           // the browser said the microphone is open
  let wanted = false;         // the person asked to listen and has not stopped
  let handsFree = false;
  let silentRounds = 0;
  let pausedForSpeech = false;
  let restartTimer = null;
  const queue = [];           // sentences waiting to be spoken
  let utterance = null;       // the one being spoken
  let generation = 0;         // bumped by stop(), so a cancelled utterance's events are ignored
  let halted = false;         // stop() silenced the rest of the answer being followed
  let disposed = false;

  const call = (fn, ...args) => { if (typeof fn === 'function' && !disposed) { try { fn(...args); } catch { /* a page's callback must not break the voice */ } } };
  const report = code => call(config.onError, { code, message: MESSAGES[code] || MESSAGES['recognition-failed'] });
  const update = () => {
    const next = !supported.input && !supported.output ? 'unsupported'
      : open ? 'listening'
        : utterance || queue.length ? 'speaking'
          : sticky || 'idle';
    if (next === state) return;
    const previous = state;
    state = next;
    call(config.onState, next, previous);
  };

  function startRecognizer() {
    if (recognizer || disposed) return Boolean(recognizer);
    const rec = new env.SpeechRecognition();
    rec.lang = lang;
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    let failure;              // undefined: no error event; null: an abort; otherwise our code
    let heard = false;
    rec.onstart = () => { if (recognizer === rec) { open = true; update(); } };
    rec.onresult = event => {
      if (recognizer !== rec) return;
      const results = event?.results || [];
      for (let i = event?.resultIndex || 0; i < results.length; i++) {
        const result = results[i];
        const text = String(result?.[0]?.transcript ?? '').trim();
        if (!text) continue;
        if (result.isFinal) { heard = true; call(config.onFinal, text, { confidence: result[0].confidence }); } else call(config.onInterim, text);
      }
    };
    rec.onerror = event => {
      if (recognizer !== rec) return;
      const name = String(event?.error || '');
      failure = name in RECOGNITION_ERRORS ? RECOGNITION_ERRORS[name] : 'recognition-failed';
    };
    rec.onend = () => {
      if (recognizer !== rec) return;
      recognizer = null;
      open = false;
      if (pausedForSpeech) { update(); pump(); return; }
      if (heard) silentRounds = 0;
      // An end with nothing heard, no error and no stop from us is silence too (Safari ends this way).
      const code = failure === undefined && !heard && wanted ? 'no-speech' : failure;
      if (code === 'denied') { sticky = 'denied'; wanted = false; report('denied'); }
      else if (code === 'no-speech') {
        silentRounds++;
        if (!handsFree) { wanted = false; report('no-speech'); }
        else if (silentRounds >= maxSilentRounds) { wanted = false; report('hands-free-ended'); }
      } else if (code) { sticky = 'error'; wanted = false; report(code); }
      if (!handsFree) wanted = false;
      if (wanted) restartTimer = env.setTimeout(() => { restartTimer = null; if (wanted && !pausedForSpeech) startRecognizer(); }, 250);
      update();
      pump();
    };
    recognizer = rec;
    try { rec.start(); } catch {
      recognizer = null; wanted = false; sticky = 'error';
      report('recognition-failed');
      update();
      return false;
    }
    return true;
  }

  function endRecognizer(discard) {
    if (restartTimer !== null) { env.clearTimeout(restartTimer); restartTimer = null; }
    if (!recognizer) return;
    try { if (discard) recognizer.abort(); else recognizer.stop(); } catch { /* already ended */ }
  }

  /** Speak the next queued sentence, unless the microphone has the floor. */
  function pump() {
    if (!supported.output || utterance || disposed) return;
    if (!queue.length) {
      if (pausedForSpeech) { pausedForSpeech = false; if (wanted) startRecognizer(); }
      update();
      return;
    }
    if (recognizer) {
      // Hands-free yields to the answer, so the recognizer does not transcribe the page's own
      // voice, and resumes after it. A single utterance is finished first.
      if (handsFree && !pausedForSpeech) { pausedForSpeech = true; endRecognizer(true); }
      update();
      return;
    }
    const text = queue.shift();
    const spoken = new env.SpeechSynthesisUtterance(text);
    spoken.lang = lang;
    const voice = pickVoice(typeof env.speechSynthesis.getVoices === 'function' ? env.speechSynthesis.getVoices() : [], lang);
    if (voice) spoken.voice = voice;
    const mine = generation;
    const done = failure => {
      if (mine !== generation || utterance !== spoken) return;
      utterance = null;
      if (failure === 'not-allowed') { queue.length = 0; report('speech-blocked'); }
      else if (failure && failure !== 'interrupted' && failure !== 'canceled') report('speech-failed');
      pump();
    };
    spoken.onend = () => done();
    spoken.onerror = event => done(String(event?.error || 'unknown'));
    utterance = spoken;
    try { env.speechSynthesis.speak(spoken); } catch {
      utterance = null; queue.length = 0;
      report('speech-failed');
    }
    update();
  }

  function enqueue(sentences) {
    if (!supported.output) return 0;
    let added = 0;
    for (const sentence of sentences) {
      for (const chunk of chunkForSpeech(prepare(sentence))) { queue.push(chunk); added++; }
    }
    if (added) pump();
    return added;
  }

  function silence() {
    generation++;
    queue.length = 0;
    utterance = null;
    if (supported.output) { try { env.speechSynthesis.cancel(); } catch { /* nothing was speaking */ } }
    halted = tracker.started;
  }

  return {
    supported,
    /** true, or null when it cannot be told, or false when there is no recognizer. See recognitionIsRemote. */
    usesRemoteRecognition: remote,
    notice: REMOTE_RECOGNITION_NOTICE,
    get state() { return state; },
    get lang() { return lang; },
    setLang(next) { if (next) lang = String(next); },
    /** True from the moment listening was asked for until it ends, including the permission prompt. */
    get listeningRequested() { return wanted; },
    get handsFree() { return wanted && handsFree; },

    /**
     * Open the microphone. Call it from a click or key handler and nowhere else: where the
     * browser reports user activation, a call without one is refused (`needs-gesture`).
     * Starting to listen stops anything being read aloud.
     */
    startListening(options = {}) {
      if (disposed) return false;
      if (!supported.input) { report('unsupported-input'); return false; }
      if (env.userActivation && env.userActivation.isActive === false) { report('needs-gesture'); return false; }
      pausedForSpeech = false;
      silence();
      sticky = null;
      wanted = true;
      handsFree = options.handsFree === true;
      silentRounds = 0;
      const started = startRecognizer();
      update();
      return started;
    },
    /** Stop listening. What was already heard is still delivered. */
    stopListening() {
      wanted = false;
      pausedForSpeech = false;
      endRecognizer(false);
      update();
    },

    /** Read text aloud, a sentence at a time. Returns how many utterances were queued. */
    speak(text) {
      if (disposed) return 0;
      if (!supported.output) { report('unsupported-output'); return 0; }
      return enqueue(splitSentences(text, { final: true }).sentences);
    },
    /**
     * Follow an answer that arrives as cumulative text: each call speaks only the sentences the
     * new text completed. After stop() the rest of that answer stays silent; the next answer
     * (text that does not continue it) is spoken again.
     */
    speakDelta(cumulativeText) {
      if (disposed || !supported.output) return 0;
      const { sentences, restarted } = tracker.push(cumulativeText);
      if (restarted) halted = false;
      return halted ? 0 : enqueue(sentences);
    },
    /** The answer followed by speakDelta is complete: speak what is left of it. */
    finishDelta() {
      if (disposed || !supported.output) return 0;
      const sentences = tracker.finish();
      return halted ? 0 : enqueue(sentences);
    },
    /** Mark text as already said, so speakDelta starts after it. */
    skipDelta(cumulativeText) { tracker.skip(cumulativeText); },
    /** A new answer is about to arrive: forget the one being followed. */
    resetDelta() { tracker.reset(); halted = false; },
    /** Stop reading aloud and drop what was queued. Hands-free listening, if paused for it, resumes. */
    stop() {
      silence();
      pump();
      update();
    },
    /** Release everything. The instance does nothing afterwards. */
    dispose() {
      wanted = false;
      pausedForSpeech = false;
      endRecognizer(true);
      recognizer = null;
      open = false;
      silence();
      tracker.reset();
      disposed = true;
    },
  };
}
