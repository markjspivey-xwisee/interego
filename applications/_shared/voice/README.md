# voice

Non-normative shared implementation for vertical pages. It adds no vocabulary.

**What it is.** Speech in and speech out for a page, on what the browser already has:
`SpeechRecognition` for the microphone and `speechSynthesis` for reading aloud. One ES module,
`voice.js`, with no dependency and no build step. It calls no model, holds no key and makes no
network request of its own. The model work, where a page has any, is done by whatever the page
already uses (for example a chat session paired through `../agent-connection`); this module is only
the ears and the mouth.

## Adopting it

A bridge serves the file, so the page keeps `script-src 'self'`:

```ts
import { VOICE_BROWSER_MODULE } from '../../_shared/voice/index.js';
// GET /voice.js -> readFileSync(VOICE_BROWSER_MODULE), Content-Type: text/javascript
```

A page that is bundled imports the same file by its path and lets the bundler take it. Do not copy it.

```js
import { createVoice, matchSpoken } from './voice.js';

const voice = createVoice({
  onInterim: text => showDraft(text),          // words still being recognized
  onFinal: text => submit(text),               // one finished utterance
  onState: state => render(state),             // idle | listening | speaking | denied | unsupported | error
  onError: ({ code, message }) => show(message),
});
micButton.hidden = !voice.supported.input;     // no recognizer (Firefox): no dead button
readButton.hidden = !voice.supported.output;
notice.textContent = voice.notice;             // shown beside the microphone control, always
micButton.onclick = () => (voice.state === 'listening' ? voice.stopListening() : voice.startListening());
onAnswerText(cumulative => voice.speakDelta(cumulative));   // a streamed answer, sentence by sentence
onAnswerDone(() => voice.finishDelta());
stopButton.onclick = () => voice.stop();
```

## The interface

`createVoice(config)` takes `lang` (default: the browser's language), the four callbacks above,
`prepare(sentence)` (what is actually spoken for a sentence; default `plainForSpeech`, which drops
Markdown marks and bare links), `maxSilentRounds` (default 3) and `env` (the speech objects, for
tests). It returns:

| Member | What it does |
| --- | --- |
| `supported` | `{ input, output }`. A page hides the control for a half that is false. |
| `state` | One of `VOICE_STATES`. `listening` only once the browser says the microphone is open. |
| `startListening({ handsFree })` | Open the microphone for one utterance, or hands-free: listen again after each final result. Stops anything being read. |
| `stopListening()` | Stop; what was already heard is still delivered. |
| `listeningRequested`, `handsFree` | Whether listening was asked for and is still wanted (true during the permission prompt too). |
| `speak(text)` | Read text aloud, one sentence per utterance, so it starts promptly and stops promptly. |
| `speakDelta(cumulativeText)` | For an answer that arrives as cumulative text: speaks only the sentences the new text completed. |
| `finishDelta()` | The answer is complete: speak the unfinished tail. |
| `skipDelta(text)`, `resetDelta()` | Treat text as already said; forget the answer being followed. |
| `stop()` | Cancel reading and drop the queue. The rest of the answer being followed stays silent; the next answer is read. |
| `usesRemoteRecognition`, `notice` | See "The audio" below. |
| `setLang(tag)`, `dispose()` | Change language; release everything. |

Also exported, all pure: `splitSentences`, `chunkForSpeech`, `createDeltaTracker`,
`plainForSpeech`, `pickVoice(voices, lang)`, `normalizeSpoken`, `detectVoiceSupport`,
`recognitionIsRemote`, and `matchSpoken(heard, options)`.

**`matchSpoken`** is for commands without a model. `options` is `[{ id, label, aliases? }]`, built
from what is on screen. It matches when exactly one option fits: the words heard are one of its
phrases, or contain one as whole words, or are all words of its phrases. Otherwise it returns
`match: null` and, when rules tied, the `ambiguous` options. A page shows what was heard and does
nothing.

## Rules it keeps

- **The microphone never starts by itself.** `startListening()` is the only way in, and where the browser
  reports user activation a call outside a gesture is refused with `needs-gesture`. Hands-free
  restarts only within a session the person started, and ends itself after three silent rounds.
- **One at a time.** Starting to listen stops the reading (barge-in). An answer that arrives during
  a single utterance waits for it. Hands-free pauses while the page reads, so it does not
  transcribe the page's own voice, and resumes after; to interrupt a reading in hands-free, press
  the control.
- **States are what happened.** A blocked microphone is `denied`. Silence is not an error state:
  it is reported once as `no-speech` and the state returns to `idle`. A missing microphone, a
  speech service that cannot be reached and an unsupported language are `error`, each with its
  own code. `unsupported` means the browser has neither half.

Error codes: `unsupported-input`, `unsupported-output`, `needs-gesture`, `denied`, `no-speech`,
`no-microphone`, `network`, `language`, `hands-free-ended`, `recognition-failed`,
`speech-blocked` (the browser refused to speak without a gesture), `speech-failed`.

## The audio

This module sends nothing to any server: it has no `fetch`, no socket and no recorder, and a test
holds it to that. What the **browser** does is another matter and a page must say it. In Chrome and
most Chromium browsers the built-in recognizer sends the audio to the browser vendor's speech
service. `REMOTE_RECOGNITION_NOTICE` (also `voice.notice`) is the sentence to show next to the
microphone control. `usesRemoteRecognition` is best effort: `true` for a Chromium browser, `null`
when there is a recognizer and it cannot be told (assume it may), `false` when there is no
recognizer. It never claims recognition is local.

If a page is served with a `Permissions-Policy` header, it must allow `microphone=(self)`, or
recognition fails as `denied` with no prompt. A page framed by another origin needs
`allow="microphone"` on the frame, which only the framing site can give.

## Browser support, as guarded

| | Speech in | Speech out |
| --- | --- | --- |
| Chrome, Edge and other Chromium | yes (`webkitSpeechRecognition`, remote service) | yes |
| Safari | yes (prefixed) | yes; the first utterance must follow a gesture |
| Firefox | no: the control is hidden | yes |

Not exercised by any test here: real microphone audio, a real synthesizer, and any browser other
than headless Chromium with injected fakes.

## Who uses it

- `applications/coached-world/public/app.js`: read the agent's work and the outcome aloud; say a
  command, matched against the labels on screen.
- `applications/foxxi-content-intelligence/i2idlx/app/src/voice.jsx`: Ask in the I2IDL-X
  workbench. Its bundle takes this file directly; `app/tools/ask-voice-check.mjs` fails if it does not.

Tests: `applications/_shared/tests/voice.test.ts` (node, fake speech objects).
