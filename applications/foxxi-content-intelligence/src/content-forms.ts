/**
 * Foxxi content forms — rendering content in whatever text form the
 * situation calls for.
 *
 * The content is text — but text takes many forms, and the right one is
 * a composition choice, like the channel or the paradigm cell. The same
 * `ContentUnit` renders as:
 *
 *   · plain        — unformatted text; length-bounded channels (SMS).
 *   · markdown     — portable structured text; documents, chat, an
 *                    agent's structured ingestion.
 *   · html         — static styled hypertext: a rendered page with
 *                    working links.
 *   · interactive  — dynamic hypermedia: a self-contained HTML artifact
 *                    with behaviour — collapsible sections, an inline
 *                    self-check for assessment items. No server, no
 *                    dependencies; it just runs.
 *
 * `chooseForm()` picks the form that fits the situation (the channel's
 * ceiling, the content kind, the audience); a caller may also name a
 * form explicitly. No media is generated — every form is text.
 *
 * Layer: L3 vertical. Pure rendering; no L1/L2/L3 ontology change.
 */

import type { ContentUnit, DeliveryChannel } from './content-channels.js';

/** A text form content can take — least to most capable. */
export type ContentForm = 'plain' | 'markdown' | 'html' | 'interactive';

/** Every text form, for validation of caller-supplied values. */
export const CONTENT_FORMS: readonly ContentForm[] = ['plain', 'markdown', 'html', 'interactive'];

export interface FormRendering {
  form: ContentForm;
  /** IANA media type — text/plain, text/markdown, or text/html. */
  mediaType: string;
  /** The rendered body. */
  body: string;
  /** True iff the body is a self-contained interactive artifact. */
  interactive: boolean;
}

const MEDIA_TYPE: Record<ContentForm, string> = {
  plain: 'text/plain',
  markdown: 'text/markdown',
  html: 'text/html',
  interactive: 'text/html',
};

/**
 * Pick the form that fits the situation. The channel sets the ceiling
 * (an SMS cannot carry hypermedia); within that, the content kind and
 * the audience decide how rich to be.
 */
export function chooseForm(situation: {
  channel?: DeliveryChannel;
  kind?: ContentUnit['kind'];
  audience?: 'human' | 'agent';
}): ContentForm {
  // An agent ingests structured text and composes it — not rendered
  // hypermedia. Markdown carries the structure without the chrome.
  if (situation.audience === 'agent') return 'markdown';
  // Channel ceilings.
  if (situation.channel === 'sms') return 'plain';
  if (situation.channel === 'chat') return 'markdown';
  if (situation.channel === 'email') return 'html';
  // A document (or no channel) — as rich as the content kind calls for.
  if (situation.kind === 'job-aid' || situation.kind === 'assessment' || situation.kind === 'lesson') {
    return 'interactive';
  }
  return 'markdown';
}

/** Render a content unit in a given text form. */
export function renderInForm(unit: ContentUnit, form: ContentForm): FormRendering {
  const body =
    form === 'plain' ? renderPlain(unit)
    : form === 'markdown' ? renderMarkdown(unit)
    : form === 'html' ? renderHtml(unit)
    : renderInteractive(unit);
  return { form, mediaType: MEDIA_TYPE[form], body, interactive: form === 'interactive' };
}

// ── helpers ─────────────────────────────────────────────────────────

function htmlEsc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Split an assessment-item block ("question ::: answer") if it is one. */
function asAssessment(text: string): { question: string; answer: string } | null {
  const i = text.indexOf(':::');
  if (i < 0) return null;
  return { question: text.slice(0, i).trim(), answer: text.slice(i + 3).trim() };
}

// ── plain ───────────────────────────────────────────────────────────

function renderPlain(u: ContentUnit): string {
  const lines: string[] = [u.title];
  if (u.competency) lines.push(`(${u.competency})`);
  lines.push('');
  for (const b of u.blocks) {
    const a = asAssessment(b.text);
    lines.push(a ? a.question : b.text);
  }
  if (u.link) lines.push('', u.link);
  return lines.join('\n').trim() + '\n';
}

// ── markdown ────────────────────────────────────────────────────────

function renderMarkdown(u: ContentUnit): string {
  const lines: string[] = [`# ${u.title}`, ''];
  if (u.competency) lines.push(`*Competency: ${u.competency}*`, '');
  for (const b of u.blocks) {
    if (b.label) lines.push(`## ${b.label}`, '');
    const a = asAssessment(b.text);
    if (a) lines.push(`**Q.** ${a.question}`, '');
    else lines.push(b.text, '');
  }
  if (u.link) lines.push('---', `Full version: ${u.link}`);
  return lines.join('\n').trim() + '\n';
}

// ── html (static hypertext) ─────────────────────────────────────────

const SHELL_STYLE =
  'body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;'
  + 'padding:24px;line-height:1.6;color:#15151f}h1{font-size:1.35rem}h2{font-size:1rem;color:#445}'
  + '.competency{font-size:12px;color:#778;margin:-6px 0 16px}'
  + '.block{border:1px solid #e3e3ee;border-radius:8px;padding:12px 16px;margin:10px 0}'
  + 'details>summary{cursor:pointer;font-weight:600;color:#1a73e8}details[open]>summary{margin-bottom:8px}'
  + 'input{padding:.4rem;border:1px solid #ccd;border-radius:5px;font-size:.95rem}'
  + 'button{background:#1a73e8;color:#fff;border:0;border-radius:6px;padding:.45rem 1rem;cursor:pointer}'
  + '.r{margin-left:8px;font-size:13px}.ok{color:#1a7f37}.no{color:#c62828}a{color:#1a73e8}';

function htmlShell(title: string, inner: string, script?: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEsc(title)}</title>`
    + `<style>${SHELL_STYLE}</style></head><body>${inner}`
    + (script ? `<script>${script}</script>` : '') + `</body></html>`;
}

function renderHtml(u: ContentUnit): string {
  const parts: string[] = [`<h1>${htmlEsc(u.title)}</h1>`];
  if (u.competency) parts.push(`<div class="competency">Competency: ${htmlEsc(u.competency)}</div>`);
  for (const b of u.blocks) {
    const a = asAssessment(b.text);
    const inner = (b.label ? `<h2>${htmlEsc(b.label)}</h2>` : '')
      + `<div>${a ? htmlEsc(a.question) : htmlEsc(b.text)}</div>`;
    parts.push(`<section class="block">${inner}</section>`);
  }
  if (u.link) parts.push(`<p><a href="${htmlEsc(u.link)}">Full version</a></p>`);
  return htmlShell(u.title, parts.join('\n'));
}

// ── interactive (dynamic hypermedia) ────────────────────────────────

function renderInteractive(u: ContentUnit): string {
  const parts: string[] = [`<h1>${htmlEsc(u.title)}</h1>`];
  if (u.competency) parts.push(`<div class="competency">Competency: ${htmlEsc(u.competency)}</div>`);
  let checkCount = 0;
  u.blocks.forEach((b, i) => {
    const a = asAssessment(b.text);
    if (a) {
      // An inline self-check — type the answer, get verified feedback.
      const id = `chk${checkCount++}`;
      parts.push(
        `<section class="block"><div>${htmlEsc(a.question)}</div>`
        + `<div style="margin-top:8px"><input id="${id}" data-a="${htmlEsc(a.answer)}" `
        + `placeholder="your answer"> <button onclick="chk('${id}')">Check</button>`
        + `<span class="r" id="${id}r"></span></div></section>`,
      );
    } else {
      // A collapsible section — the first opens by default.
      parts.push(
        `<details class="block"${i === 0 ? ' open' : ''}>`
        + `<summary>${htmlEsc(b.label ?? `Step ${i + 1}`)}</summary>`
        + `<div>${htmlEsc(b.text)}</div></details>`,
      );
    }
  });
  if (u.link) parts.push(`<p><a href="${htmlEsc(u.link)}">Full version</a></p>`);
  const script = checkCount > 0
    ? `function chk(id){var el=document.getElementById(id),r=document.getElementById(id+'r');`
      + `var ok=el.value.trim().toLowerCase()===(el.dataset.a||'').toLowerCase();`
      + `r.textContent=ok?'\\u2713 correct':'\\u2717 not quite';r.className='r '+(ok?'ok':'no');}`
    : undefined;
  return htmlShell(u.title, parts.join('\n'), script);
}
