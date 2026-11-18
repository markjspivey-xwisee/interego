/**
 * Optional check, run by hand: a whole practice in the role-play player BY VOICE.
 *
 *   node applications/practice-evidence/tools/voice-check.mjs [player-url] [picks]
 *   node applications/practice-evidence/tools/voice-check.mjs --cases <dir> [player-url]
 *
 * Each reply is read from the page, spoken by the Windows speech engine into a WAV file, played
 * into an audio track inside the page, and that track is handed to Chrome's speech recogniser.
 * From there on the page's own code runs: what it heard, the reply it matched, the learner's
 * "Use the highlighted reply", the score. Exits 1 when a spoken reply did not match the reply
 * that was spoken, or the practice did not reach its score.
 *
 * It opens the player with no launch, so the player is in preview mode and saves nothing.
 *
 * With --cases it does not run a practice. <dir> holds cases.json and any WAV files it names:
 *   { "path": [1,1,2,0,1], "cases": [ { "name", "step": 1, "expect": 1 | null, "wav": "a.wav" | "say": "text" | "ssml": "<break time='900ms'/>text" } ] }
 * For each case the preview is loaded afresh, the replies in `path` are tapped up to `step`
 * (1-based), and the audio is played to the recogniser: a WAV as given, or `say`/`ssml` spoken
 * here. It records every result the recogniser gave with whether it was final, any error, the
 * reply the page highlighted and whether it offered "Use the highlighted reply". It never presses
 * that button. Exits 1 when a highlight differs from `expect` (null: no reply highlighted).
 *
 * What this does NOT exercise: the microphone. Chrome's `--use-file-for-fake-audio-capture`
 * feeds getUserMedia and does not reach SpeechRecognition (it answers `no-speech`), so the check
 * replaces `SpeechRecognition.prototype.start` with one that passes an audio track. Capture from
 * a real device, and the permission prompt, are still only checked by a person.
 *
 * Needs: Windows (System.Speech), Google Chrome installed, a network connection (Chrome's
 * recogniser is a web service: the synthesized audio is sent to it), and `playwright`, which
 * this workspace has through applications/foxxi-content-intelligence. Not run in CI.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const DEFAULT_URL = 'https://markjspivey-xwisee.github.io/interego/applications/practice-evidence/roleplay-player/index.html';
const casesAt = process.argv[2] === '--cases' ? process.argv[3] : null;
if (process.argv[2] === '--cases' && !casesAt) { process.stderr.write('--cases needs the directory that holds cases.json\n'); process.exit(2); }
const url = (casesAt ? process.argv[4] : process.argv[2]) ?? DEFAULT_URL;
/** The reply to speak at each step, by position. The default is the sample scenario's best path. */
const picks = ((casesAt ? null : process.argv[3]) ?? '1,1,2,0,1').split(',').map(Number);
if (process.platform !== 'win32') { process.stderr.write('voice-check needs Windows: it speaks with System.Speech.\n'); process.exit(2); }

const work = mkdtempSync(join(tmpdir(), 'pev-voice-'));
/** Speaks `text` (or, with `ssml`, the inside of a <speak> element) into a WAV file and returns it as base64. The text goes by file, never by command line. */
function speak(text, n, ssml = false) {
  const txt = join(work, `say${n}.txt`), wav = join(work, `say${n}.wav`);
  writeFileSync(txt, ssml ? `<speak version="1.0" xml:lang="en-US">${text}</speak>` : text, 'utf8');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    `$s.SetOutputToWaveFile('${wav}', $f)`,
    `$s.${ssml ? 'SpeakSsml' : 'Speak'}((Get-Content -Raw -Encoding UTF8 '${txt}'))`,
    '$s.Dispose()',
  ].join('; ')]);
  return readFileSync(wav).toString('base64');
}

/** Opens the player in preview mode, as far as its first step, with the recogniser taking an audio track. */
async function openPreview(browser) {
  const page = await (await browser.newContext()).newPage();
  await page.goto(url);
  await page.waitForSelector('#go');
  await page.waitForTimeout(2500);
  const chip = await page.evaluate(() => document.getElementById('chip')?.textContent ?? '');
  if (!/preview/i.test(chip)) throw new Error(`the player is not in preview mode (it says "${chip}"): this check must not write to a learning record`);
  await page.click('#go'); await page.click('#agree'); await page.click('#consentyes');
  await page.waitForSelector('.choice');
  await page.evaluate(() => {
    window.__sr = []; window.__results = [];
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error('this browser has no SpeechRecognition');
    const start = SR.prototype.start;
    SR.prototype.start = function () {
      this.addEventListener('result', (e) => { for (let i = e.resultIndex; i < e.results.length; i++) window.__results.push({ final: e.results[i].isFinal, transcript: e.results[i][0].transcript }); });
      this.addEventListener('error', (e) => window.__sr.push('error:' + e.error));
      this.addEventListener('end', () => window.__sr.push('end'));
      return start.call(this, window.__track);
    };
    /** Plays a WAV into a fresh audio track, a moment from now, for the recogniser to be started on. */
    window.__say = async (b64) => {
      const ac = window.__ac || (window.__ac = new AudioContext());
      await ac.resume();
      const buffer = await ac.decodeAudioData(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)).buffer);
      const to = ac.createMediaStreamDestination(), from = ac.createBufferSource();
      from.buffer = buffer; from.connect(to);
      window.__track = to.stream.getAudioTracks()[0];
      from.start(ac.currentTime + 1.2);
    };
  });
  return page;
}
const replies = (page) => page.evaluate(() => Array.from(document.querySelectorAll('.choice')).map((el) => el.innerText.replace(/^[A-Z]\s*\n/, '').trim()));
/** Plays the audio to the recogniser through the page's own microphone button, and reads what the page then shows. */
async function listenTo(page, b64) {
  await page.evaluate((audio) => window.__say(audio), b64);
  await page.evaluate(() => { window.__sr.length = 0; window.__results.length = 0; });
  await page.click('#mic');
  for (let i = 0; i < 30 && !(await page.evaluate(() => window.__sr.includes('end'))); i++) await page.waitForTimeout(800);
  await page.waitForTimeout(400);
  return page.evaluate(() => ({
    events: window.__sr.join(','),
    results: window.__results.slice(),
    heard: (document.querySelector('#heard div') || document.getElementById('heard')).textContent,
    matched: Array.from(document.querySelectorAll('.choice')).findIndex((el) => el.classList.contains('match')),
    canUse: !!document.querySelector('#heard button'),
  }));
}

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
let report, ok;
try {
  if (casesAt) {
    const dir = resolve(casesAt), file = JSON.parse(readFileSync(join(dir, 'cases.json'), 'utf8'));
    const path = Array.isArray(file.path) ? file.path : [1, 1, 2, 0, 1], out = [];
    for (const [n, c] of file.cases.entries()) {
      const page = await openPreview(browser);
      try {
        // To the step the case is for, by tapping: no speech is involved in getting there.
        for (let at = 1; at < c.step; at++) { await page.locator('.choice').nth(path[at - 1]).click(); await page.waitForTimeout(3500); }
        const choices = await replies(page);
        const audio = typeof c.wav === 'string' ? readFileSync(join(dir, c.wav)).toString('base64') : speak(c.ssml ?? c.say, n + 1, typeof c.ssml === 'string');
        const got = await listenTo(page, audio);
        const finals = got.results.filter((r) => r.final).map((r) => r.transcript), interim = got.results.filter((r) => !r.final).map((r) => r.transcript);
        const matched = got.matched < 0 ? null : got.matched;
        out.push({ name: c.name, step: c.step, said: c.wav ?? c.ssml ?? c.say, final: finals, lastInterim: interim.at(-1) ?? null, interimCount: interim.length,
          recogniser: got.events, heard: got.heard, expect: c.expect, matched, matchedReply: matched === null ? null : choices[matched], confirmationOffered: got.canUse, asExpected: matched === c.expect });
      } finally { await page.context().close(); }
    }
    ok = out.length > 0 && out.every((c) => c.asExpected);
    report = { url, checkedAt: new Date().toISOString(), result: ok ? 'every case highlighted what it expected' : `FAILED: ${out.filter((c) => !c.asExpected).length} of ${out.length} case(s) highlighted something else`, cases: out };
  } else {
    const steps = [];
    const page = await openPreview(browser);
    for (let n = 0; n < picks.length; n++) {
      const choices = await replies(page);
      const spoke = choices[picks[n]];
      if (spoke === undefined) throw new Error(`step ${n + 1} has no reply ${picks[n]} (it has ${choices.length})`);
      const got = await listenTo(page, speak(spoke, n + 1));
      steps.push({ step: n + 1, spoke, heard: got.heard, wanted: picks[n], matched: got.matched, recogniser: got.events });
      if (!got.canUse) break;
      await page.click('#heard button');
      await page.waitForTimeout(3500);
    }
    // Only the results screen counts as finished. The call screen also says "Step 2 of 5", so a
    // practice left part way (fewer picks than the scenario has steps) is not read as one that ended.
    const results = await page.evaluate(() => {
      const el = document.getElementById('s-results');
      if (!el || el.classList.contains('hide')) return null;
      const text = el.innerText.replace(/\s+/g, ' ').trim(), m = /(\d+)\s*of\s*(\d+)/.exec(text);
      return { score: m ? Number(m[1]) : null, outOf: m ? Number(m[2]) : null, text: text.slice(0, 240) };
    });
    ok = steps.length === picks.length && steps.every((s) => s.matched === s.wanted) && results !== null && results.score !== null;
    report = { url, checkedAt: new Date().toISOString(), result: ok ? 'every spoken reply matched, and the practice reached its score' : results === null ? 'FAILED: the practice did not reach its results screen' : 'FAILED', steps, results };
  }
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}

process.stdout.write(JSON.stringify(report, null, 1) + '\n');
process.exit(ok ? 0 : 1);
