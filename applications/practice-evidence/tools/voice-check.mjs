/**
 * Optional check, run by hand: a whole practice in the role-play player BY VOICE.
 *
 *   node applications/practice-evidence/tools/voice-check.mjs [player-url] [picks]
 *
 * Each reply is read from the page, spoken by the Windows speech engine into a WAV file, played
 * into an audio track inside the page, and that track is handed to Chrome's speech recogniser.
 * From there on the page's own code runs: what it heard, the reply it matched, the learner's
 * "Use the highlighted reply", the score. Exits 1 when a spoken reply did not match the reply
 * that was spoken, or the practice did not reach its score.
 *
 * It opens the player with no launch, so the player is in preview mode and saves nothing.
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
import { join } from 'node:path';
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'https://markjspivey-xwisee.github.io/interego/applications/practice-evidence/roleplay-player/index.html';
/** The reply to speak at each step, by position. The default is the sample scenario's best path. */
const picks = (process.argv[3] ?? '1,1,2,0,1').split(',').map(Number);
if (process.platform !== 'win32') { process.stderr.write('voice-check needs Windows: it speaks with System.Speech.\n'); process.exit(2); }

const work = mkdtempSync(join(tmpdir(), 'pev-voice-'));
/** Speaks `text` into a WAV file and returns it as base64. The text goes by file, never by command line. */
function speak(text, n) {
  const txt = join(work, `say${n}.txt`), wav = join(work, `say${n}.wav`);
  writeFileSync(txt, text, 'utf8');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', [
    'Add-Type -AssemblyName System.Speech',
    '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
    '$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)',
    `$s.SetOutputToWaveFile('${wav}', $f)`,
    `$s.Speak((Get-Content -Raw -Encoding UTF8 '${txt}'))`,
    '$s.Dispose()',
  ].join('; ')]);
  return readFileSync(wav).toString('base64');
}

const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'] });
const steps = [];
/** The results screen, once the practice has reached it: its score as shown, and its opening text. */
let results = null;
try {
  const page = await (await browser.newContext()).newPage();
  await page.goto(url);
  await page.waitForSelector('#go');
  await page.waitForTimeout(2500);
  const chip = await page.evaluate(() => document.getElementById('chip')?.textContent ?? '');
  if (!/preview/i.test(chip)) throw new Error(`the player is not in preview mode (it says "${chip}"): this check must not write to a learning record`);
  await page.click('#go'); await page.click('#agree'); await page.click('#consentyes');
  await page.waitForSelector('.choice');
  await page.evaluate(() => {
    window.__sr = [];
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error('this browser has no SpeechRecognition');
    const start = SR.prototype.start;
    SR.prototype.start = function () {
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

  for (let n = 0; n < picks.length; n++) {
    const choices = await page.evaluate(() => Array.from(document.querySelectorAll('.choice')).map((el) => el.innerText.replace(/^[A-Z]\s*\n/, '').trim()));
    const spoke = choices[picks[n]];
    if (spoke === undefined) throw new Error(`step ${n + 1} has no reply ${picks[n]} (it has ${choices.length})`);
    await page.evaluate((b64) => window.__say(b64), speak(spoke, n + 1));
    await page.evaluate(() => { window.__sr.length = 0; });
    await page.click('#mic');
    for (let i = 0; i < 30 && (await page.evaluate(() => window.__sr.length)) === 0; i++) await page.waitForTimeout(800);
    await page.waitForTimeout(400);
    const got = await page.evaluate(() => ({
      events: window.__sr.join(','),
      heard: (document.querySelector('#heard div') || document.getElementById('heard')).textContent,
      matched: Array.from(document.querySelectorAll('.choice')).findIndex((el) => el.classList.contains('match')),
      canUse: !!document.querySelector('#heard button'),
    }));
    steps.push({ step: n + 1, spoke, heard: got.heard, wanted: picks[n], matched: got.matched, recogniser: got.events });
    if (!got.canUse) break;
    await page.click('#heard button');
    await page.waitForTimeout(3500);
  }
  // Only the results screen counts as finished. The call screen also says "Step 2 of 5", so a
  // practice left part way (fewer picks than the scenario has steps) is not read as one that ended.
  results = await page.evaluate(() => {
    const el = document.getElementById('s-results');
    if (!el || el.classList.contains('hide')) return null;
    const text = el.innerText.replace(/\s+/g, ' ').trim(), m = /(\d+)\s*of\s*(\d+)/.exec(text);
    return { score: m ? Number(m[1]) : null, outOf: m ? Number(m[2]) : null, text: text.slice(0, 240) };
  });
} finally {
  await browser.close();
  rmSync(work, { recursive: true, force: true });
}

const ok = steps.length === picks.length && steps.every((s) => s.matched === s.wanted) && results !== null && results.score !== null;
process.stdout.write(JSON.stringify({ url, checkedAt: new Date().toISOString(), result: ok ? 'every spoken reply matched, and the practice reached its score' : results === null ? 'FAILED: the practice did not reach its results screen' : 'FAILED', steps, results }, null, 1) + '\n');
process.exit(ok ? 0 : 1);
