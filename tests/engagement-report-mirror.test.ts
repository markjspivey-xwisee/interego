/**
 * The engagement docs' one falsifiable claim about live pod state, and the hand-mirrored
 * HTML that silently outlives any correction to it.
 *
 * WHY (1) — the mirror. ENGAGEMENT-REPORT.html does not paraphrase the report: it embeds
 * ENGAGEMENT-REPORT.md verbatim in `<script id="md-source" type="text/markdown">` and renders
 * it client-side with marked. Nothing generates one from the other, so a correction applied
 * to the .md alone leaves the PUBLISHED page asserting the retracted claim — which is exactly
 * how `rec-76593c72…` came to be named as a live cleartext leak in three places while the
 * open-item list named two. The only sanctioned divergence is inside fenced blocks, where
 * mermaid labels are stripped of the arrows, ellipses and apostrophes its parser rejects;
 * everything outside fences is compared byte for byte.
 *
 * WHY (2) — the claim. Both docs asserted, present tense, that a pre-redaction record "still
 * carries the full narrative in cleartext" on johnny's pod, under a note saying the heartbeat
 * had been stood down — i.e. an unattended confidentiality exposure. Reproduced 2026-08-04
 * against the live fleet: GET https://gate.interego.xwisee.com/u-pk-00181cd5dbee/ returns
 * {"name":"NotFoundHttpError",...,"statusCode":404,"errorCode":"H404"} while /foxxi/ and
 * /eth-8f3b8e939600/ return 200 through the same gate, and the Azure hosts the engagement ran
 * on (…livelysky-8b81abb0.eastus.azurecontainerapps.io, ENGAGEMENT-REPORT.md §14) resolve in
 * DNS but accept no connection. The pod went with the retired substrate. CI cannot re-run that
 * probe — it is another party's pod on a fleet that no longer exists, and the suite must not
 * depend on the network — so what is pinned here is the retracted WORDING: it must not return
 * by copy-paste, and the record must keep being mentioned (deleting the trail is not a fix
 * either).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name: string): string => readFileSync(resolve(REPO, name), 'utf8');

const MD = read('ENGAGEMENT-REPORT.md');
const HTML = read('ENGAGEMENT-REPORT.html');
const DOGFOOD = read('REFLEXIVE-DOGFOOD.md');

const DOCS: ReadonlyArray<readonly [string, string]> = [
  ['ENGAGEMENT-REPORT.md', MD],
  ['ENGAGEMENT-REPORT.html', HTML],
  ['REFLEXIVE-DOGFOOD.md', DOGFOOD],
];

/**
 * The markdown the published page actually renders. Throws rather than returning '' — an
 * empty extraction would make every comparison below pass vacuously, which is the one way
 * this whole gate could go inert without anything turning red.
 */
function embeddedSource(html: string): string {
  const m = /<script id="md-source" type="text\/markdown">\n([\s\S]*?)\n<\/script>/.exec(html);
  if (!m) throw new Error('ENGAGEMENT-REPORT.html no longer embeds an md-source block');
  return m[1]!;
}

/** Lines outside ``` fences. Mermaid labels inside fences are deliberately sanitized. */
function prose(markdown: string): string {
  let inFence = false;
  const out: string[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
    if (!inFence) out.push(line);
  }
  return out.join('\n').trim();
}

describe('ENGAGEMENT-REPORT.html mirrors ENGAGEMENT-REPORT.md', () => {
  it('compares something real, not an empty extraction', () => {
    expect(prose(MD).length).toBeGreaterThan(5000);
    expect(prose(MD)).toContain('## 13. Open items');
    expect(prose(embeddedSource(HTML))).toContain('## 13. Open items');
  });

  it('embeds the same prose outside fenced blocks', () => {
    expect(prose(embeddedSource(HTML))).toBe(prose(MD));
  });
});

describe('the pre-fix cleartext record is recorded as closed, not as live', () => {
  const RETRACTED = [
    'still carries the full narrative in cleartext',
    're-emit + void the pre-fix cleartext record',
  ];
  for (const [name, text] of DOCS) {
    for (const claim of RETRACTED) {
      it(`${name} does not re-assert: "${claim}"`, () => {
        expect(
          text.includes(claim),
          `${name} asserts a live cleartext record on a pod that answers 404 — see this file's header`,
        ).toBe(false);
      });
    }
  }

  const CLOSURE = /(closed by decommission|retired|never migrated|no longer reachable)/i;
  it('keeps mentioning the record, and frames every mention as closed', () => {
    for (const [name, text] of DOCS) {
      let i = text.indexOf('rec-76593c72');
      expect(i, `${name} dropped the record entirely — the trail must survive the correction`).toBeGreaterThan(-1);
      while (i !== -1) {
        const window = text.slice(Math.max(0, i - 600), i + 600);
        expect(CLOSURE.test(window), `${name} @${i}: ${window}`).toBe(true);
        i = text.indexOf('rec-76593c72', i + 1);
      }
    }
  });
});
