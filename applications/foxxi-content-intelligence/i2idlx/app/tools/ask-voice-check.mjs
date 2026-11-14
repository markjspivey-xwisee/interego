// Ask's voice, checked in node: the actual hook (src/voice.jsx) bundled the way the page is, with
// the shared module resolved from applications/_shared/voice/, a minimal hook harness and fake
// speech objects. No browser, no microphone and no synthesizer are involved; real audio is not
// exercised by this check and cannot be.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const app = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(app, '../../../..');
const result = await build({
  entryPoints: [resolve(app, 'src/voice.jsx')], bundle: true, write: false, format: 'esm', metafile: true,
  jsxFactory: 'React.createElement', jsxFragment: 'React.Fragment', target: 'es2020', logLevel: 'warning',
  plugins: [{ name: 'fixture-glossary', setup(api) {
    api.onResolve({ filter: /(?:^|\/)data\.js$/ }, () => ({ path: 'data.js', namespace: 'fixture' }));
    api.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export const byId = new Map([["record-store", { l: "learning record store" }]]);', loader: 'js' }));
  } }],
});
// One implementation: the page's bundle takes the shared file itself, not a copy kept beside it.
const inputs = Object.keys(result.metafile.inputs).map(file => relative(repo, resolve(file)).replaceAll('\\', '/'));
assert.ok(inputs.includes('applications/_shared/voice/voice.js'), 'the bundle does not include the shared voice module: ' + inputs.join(', '));
assert.deepEqual(inputs.filter(file => /voice\.js$/.test(file)), ['applications/_shared/voice/voice.js']);

// ── fake speech objects ──
const recognizers = [], spoken = [];
let cancels = 0;
class Recognition {
  constructor() { recognizers.push(this); }
  start() { this.started = true; }
  stop() { this.onend?.(); }
  abort() { this.onerror?.({ error: 'aborted' }); this.onend?.(); }
  hear(transcript, isFinal) { this.onresult?.({ resultIndex: 0, results: [Object.assign([{ transcript, confidence: 1 }], { isFinal })] }); }
}
class Utterance { constructor(text) { this.text = text; } }
const install = (present) => {
  globalThis.webkitSpeechRecognition = present ? Recognition : undefined;
  globalThis.speechSynthesis = present ? { speak: u => spoken.push(u), cancel: () => { cancels++; }, getVoices: () => [] } : undefined;
  globalThis.SpeechSynthesisUtterance = present ? Utterance : undefined;
};

// ── minimal hook harness ──
// The bundle reads the hooks off the global once, when it loads, so the global delegates to
// whichever harness is rendering.
let hooks = null;
globalThis.React = Object.fromEntries(['useState', 'useRef', 'useEffect', 'useCallback'].map(name => [name, (...args) => hooks[name](...args)]));
function harness(useHook) {
  const values = [], refs = [], effects = [], callbacks = [];
  let cursor = 0, refCursor = 0, effectCursor = 0, callbackCursor = 0, props, out, dirty = false;
  const changed = (before, next) => !before || !next || before.length !== next.length || before.some((value, i) => !Object.is(value, next[i]));
  const mine = {
    useState: initial => { const n = cursor++; if (!(n in values)) values[n] = typeof initial === 'function' ? initial() : initial;
      return [values[n], next => { const value = typeof next === 'function' ? next(values[n]) : next; if (!Object.is(value, values[n])) { values[n] = value; dirty = true; } }]; },
    useRef: value => { const n = refCursor++; return refs[n] || (refs[n] = { current: value }); },
    useEffect: (fn, deps) => { const n = effectCursor++; if (!effects[n] || changed(effects[n].deps, deps)) effects[n] = { deps, run: fn, cleanup: effects[n]?.cleanup, due: true }; },
    useCallback: (fn, deps) => { const n = callbackCursor++; if (!callbacks[n] || changed(callbacks[n].deps, deps)) callbacks[n] = { deps, fn }; return callbacks[n].fn; },
  };
  const render = (next = props) => {
    props = next;
    for (let round = 0; round < 10; round++) {
      dirty = false; cursor = refCursor = effectCursor = callbackCursor = 0; hooks = mine;
      out = useHook(props);
      for (const effect of effects) if (effect.due) { effect.due = false; effect.cleanup?.(); effect.cleanup = effect.run(); }
      if (!dirty) return out;
    }
    throw new Error('the hook did not settle');
  };
  return { render, get out() { return render(); }, unmount: () => effects.forEach(effect => effect.cleanup?.()) };
}

// Each load is a fresh module, so it sees the speech objects installed at that moment.
const scratch = await mkdtemp(join(tmpdir(), 'ask-voice-check-'));
let loads = 0;
const load = async () => {
  const file = join(scratch, 'voice-' + (loads++) + '.mjs');
  await writeFile(file, result.outputFiles[0].text);
  return import(pathToFileURL(file).href);
};

{ // A browser with neither half: both controls are hidden, and nothing is ever started.
  install(false);
  const { useAskVoice } = await load();
  const h = harness(useAskVoice);
  const voice = h.render({ turns: [], working: false, onInterim() {}, onQuestion() {} });
  assert.deepEqual({ ...voice.supported }, { input: false, output: false });
  h.unmount();
}

install(true);
const { useAskVoice, spokenText } = await load();
assert.equal(spokenText('A **store** [[record-store]] holds [[record-store|statements]] [[unknown-id]]'), 'A store learning record store holds statements');

{ // The microphone: nothing opens until the press; interim words fill the box; the final words are the question.
  const interim = [], asked = [];
  const h = harness(useAskVoice);
  let voice = h.render({ turns: [], working: false, onInterim: text => interim.push(text), onQuestion: text => asked.push(text) });
  assert.deepEqual({ ...voice.supported }, { input: true, output: true });
  assert.match(voice.notice, /send the audio of what you say to the browser vendor's speech service/);
  assert.equal(recognizers.length, 0, 'the microphone was opened without a press');
  voice.toggleListening();
  assert.equal(recognizers.length, 1);
  const rec = recognizers[0];
  assert.equal(rec.started, true);
  rec.onstart();
  assert.equal(h.out.listening, true);
  rec.hear('what is a', false);
  rec.hear('what is a record store', true);
  rec.onend();
  assert.deepEqual(interim, ['what is a']);
  assert.deepEqual(asked, ['what is a record store']);
  assert.equal(h.out.listening, false);
  // A blocked microphone is said, in words.
  h.out.toggleListening();
  recognizers[1].onerror({ error: 'not-allowed' }); recognizers[1].onend();
  assert.match(h.out.note, /microphone is blocked/);
  assert.equal(h.out.state, 'denied');
  h.unmount();
}

{ // Reading aloud: off until pressed; then each completed sentence of the streamed answer, once.
  spoken.length = 0; cancels = 0;
  const base = { onInterim() {}, onQuestion() {} };
  const old = [{ role: 'user', content: 'Earlier?' }, { role: 'assistant', content: 'An earlier answer. Already shown.' }];
  const h = harness(useAskVoice);
  h.render({ ...base, turns: old, working: false });
  assert.equal(spoken.length, 0, 'an answer was read without reading being turned on');
  h.out.toggleReading();
  assert.equal(h.out.reading, true);
  assert.equal(spoken.length, 0, 'turning reading on read an answer that was already on screen');
  const stream = content => [...old, { role: 'user', content: 'What is it?' }, { role: 'assistant', content, pending: false }];
  h.render({ ...base, turns: stream('A [[record-store]] keeps'), working: true });
  assert.equal(spoken.length, 0);
  h.render({ ...base, turns: stream('A [[record-store]] keeps statements. It is'), working: true });
  assert.deepEqual(spoken.map(u => u.text), ['A learning record store keeps statements.']);
  h.render({ ...base, turns: stream('A [[record-store]] keeps statements. It is'), working: true });
  assert.equal(spoken.length, 1);
  assert.equal(h.out.state, 'speaking');
  spoken[0].onend();
  h.render({ ...base, turns: stream('A [[record-store]] keeps statements. It is queried by others'), working: false });
  assert.deepEqual(spoken.map(u => u.text), ['A learning record store keeps statements.', 'It is queried by others']);
  // Stop: the synthesizer is cancelled and the rest of this answer stays silent.
  h.out.stopReading();
  assert.equal(cancels, 1);
  assert.equal(h.out.state, 'idle');
  // The same words as the next answer are a new answer, and are read.
  const again = [...stream('A [[record-store]] keeps statements. It is queried by others'), { role: 'user', content: 'Again?' }, { role: 'assistant', content: 'A [[record-store]] keeps statements. ', pending: false }];
  h.render({ ...base, turns: again, working: true });
  assert.equal(spoken.length, 3);
  // Pressing the microphone while it reads stops the reading (barge-in).
  const before = cancels;
  h.out.toggleListening();
  assert.equal(cancels, before + 1);
  assert.equal(recognizers.at(-1).started, true);
  // Turning reading off stops it; a new conversation does not strand the next answer.
  h.out.toggleReading();
  assert.equal(h.out.reading, false);
  h.out.toggleReading();
  h.render({ ...base, turns: [], working: false });
  recognizers.at(-1).onend();
  h.render({ ...base, turns: [{ role: 'user', content: 'New?' }, { role: 'assistant', content: 'A fresh answer. ', pending: false }], working: true });
  assert.equal(spoken.at(-1).text, 'A fresh answer.');
  h.unmount();
}
await rm(scratch, { recursive: true, force: true });
console.log('PASS Ask voice: shared module bundled from applications/_shared/voice, hidden without speech objects, microphone only on press, spoken question delivered, streamed answer read once per sentence, stop and barge-in');
