/**
 * The course an LTI launch opens: the pages a person reads and answers in, the JSON a client
 * without a browser reads instead, and the AGS Score the Tool posts back to the platform when the
 * attempt ends. The SCORM engine does the grading (bridge/server.ts, advanceScormPlay); this only
 * shows its work and carries the result.
 */

import { courseMarkdownHtml } from './course-markdown.js';
import type { ScormAnswerInput } from './scorm-assessment.js';

/** A question as a learner may see it: what to choose from, never a verifier or an explanation. */
export interface LearnerQuestion {
  readonly index: number;
  readonly question: string;
  /** The xAPI interaction type (fill-in, numeric, choice, true-false, sequencing, matching, likert, long-fill-in). */
  readonly type?: string;
  readonly input?: Readonly<ScormAnswerInput>;
  /** Whether an answer is graded; a likert or long-fill-in is not. */
  readonly graded?: boolean;
}

/** A SCO as a learner may see it: never the answers. `body` is Markdown; `bodyHtml` is its safe rendering. */
export interface ScoView {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly bodyHtml?: string;
  readonly assessment?: ReadonlyArray<LearnerQuestion>;
}

/** How the SCO just submitted was graded. `correct` is null for a question nothing grades. */
export interface GradedView {
  readonly score: number;
  readonly correct: number;
  readonly total: number;
  readonly passed: boolean;
  readonly detail: ReadonlyArray<{ readonly question: string; readonly your: string; readonly correct: boolean | null; readonly explanation?: string }>;
}

/** Where the grade went: the platform's gradebook, or why it did not get there. Not a refusal: the attempt itself is done. */
export interface GradePassback {
  readonly posted: boolean;
  readonly status?: number;
  readonly lineItem?: string;
  readonly scoreGiven?: number;
  readonly scoreMaximum?: number;
  readonly why?: string;
}

export interface PlayOutcome {
  readonly completed: boolean;
  readonly passed: boolean;
  readonly score: number;
  readonly recordedStatements: number;
  readonly gradebook: GradePassback;
}

function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}


const STYLE = `:root{color-scheme:light dark;--fg:#1a1a2e;--muted:#5b6070;--line:#dde;--accent:#1a73e8;--bg:#fff;--card:#f7f8fb;--ok:#137333;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8f0;--muted:#a0a4b8;--line:#3a3d4a;--accent:#8ab4f8;--bg:#15161c;--card:#1d1f27;--ok:#81c995;--bad:#f28b82}}
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:680px;margin:0 auto;padding:1.5rem 1rem 3rem;color:var(--fg);background:var(--bg);line-height:1.55}
.crumb{color:var(--muted);font-size:.85rem;margin:0}h1{font-size:1.35rem;margin:.35rem 0 1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.9rem 1rem;margin:1rem 0}
ol.q{padding-left:1.2rem}ol.q li{margin:.9rem 0}label span{display:block;margin-bottom:.35rem}
input,textarea{width:100%;font:inherit;padding:.55rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
textarea{min-height:7rem}input[type=radio],input[type=checkbox]{width:auto}select{font:inherit;padding:.35rem;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);max-width:100%}
.opt{display:flex;gap:.5rem;align-items:baseline;margin:.25rem 0}.opt span{display:inline;margin:0}
.body img{max-width:100%;height:auto}.body table{border-collapse:collapse}.body th,.body td{border:1px solid var(--line);padding:.3rem .6rem}
.body pre{background:var(--card);padding:.7rem;border-radius:8px;overflow:auto}.body blockquote{border-left:4px solid var(--line);margin:.8rem 0;padding:.1rem .9rem;color:var(--muted)}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:.65rem 1.3rem;font:inherit;cursor:pointer;margin-top:.5rem}
.ok{color:var(--ok)}.bad{color:var(--bad)}.muted{color:var(--muted)}ul.graded{padding-left:1.1rem}`;

function page(title: string, crumb: string, inner: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${htmlEscape(title)}</title><style>${STYLE}</style></head><body>
<p class="crumb">${htmlEscape(crumb)}</p>
${inner}
</body></html>`;
}

function gradedCard(graded: GradedView | undefined): string {
  if (!graded) return '';
  const rows = graded.detail.map((d) => {
    const verdict = d.correct === null ? 'Recorded' : d.correct ? 'Right' : 'Not right';
    const why = d.explanation ? `<br><span class="muted">${htmlEscape(d.explanation)}</span>` : '';
    return `<li class="${d.correct === null ? '' : d.correct ? 'ok' : 'bad'}">${verdict}: ${htmlEscape(d.question)} <span class="muted">(you answered ${htmlEscape(d.your)})</span>${why}</li>`;
  }).join('');
  const headline = graded.total ? `Last section: ${graded.correct} of ${graded.total} right.` : 'Last section: recorded. Nothing in it is graded.';
  return `<div class="card"><b>${headline}</b><ul class="graded">${rows}</ul></div>`;
}

const letter = (i: number): string => String.fromCharCode(65 + i);

/** The control a question's type calls for. Every name is answer_<index>, or answer_<index>_<row> for a row of selects. */
function questionControl(q: LearnerQuestion): string {
  const input = q.input;
  const name = `answer_${q.index}`;
  const type = input?.type ?? 'text';
  if (type === 'choice' || type === 'likert' || type === 'true-false') {
    const labels = type === 'true-false' ? ['True', 'False'] : (input?.options ?? []);
    const many = type === 'choice' && !!input?.multiple;
    const boxes = labels.map((label, k) => {
      const value = type === 'true-false' ? (k === 0 ? 'true' : 'false') : letter(k);
      const shown = type === 'true-false' ? label : `${letter(k)}. ${label}`;
      return `<label class="opt"><input type="${many ? 'checkbox' : 'radio'}" name="${name}" value="${value}"${many ? '' : ' required'}><span>${htmlEscape(shown)}</span></label>`;
    }).join('');
    const hint = many ? 'Choose every option that applies.' : type === 'likert' ? 'Choose one. This is not graded.' : 'Choose one.';
    return `<fieldset style="border:0;padding:0;margin:0"><legend>${htmlEscape(q.question)}</legend><p class="muted">${hint}</p>${boxes}</fieldset>`;
  }
  if (type === 'sequencing' || type === 'matching') {
    const choices = (type === 'sequencing' ? input?.items : input?.targets) ?? [];
    const rows = type === 'sequencing' ? choices.map((_, k) => `Position ${k + 1}`) : (input?.items ?? []);
    const options = `<option value="">Choose…</option>${choices.map((c, k) => `<option value="${letter(k)}">${htmlEscape(`${letter(k)}. ${c}`)}</option>`).join('')}`;
    const selects = rows.map((row, k) => `<label class="opt"><span>${htmlEscape(row)}</span><select name="${name}_${k}" required>${options}</select></label>`).join('');
    const hint = type === 'sequencing' ? 'Put the items in order: choose the first, then the second, and so on, each once.' : 'Match each prompt to one answer.';
    return `<fieldset style="border:0;padding:0;margin:0"><legend>${htmlEscape(q.question)}</legend><p class="muted">${hint}</p>${selects}</fieldset>`;
  }
  if (type === 'long-fill-in') {
    return `<label><span>${htmlEscape(q.question)}</span><textarea name="${name}" maxlength="4000" required></textarea></label><p class="muted">Not graded.</p>`;
  }
  const numeric = type === 'integer' || type === 'number';
  const attrs = numeric
    ? ` type="number" inputmode="decimal"${type === 'integer' ? ' step="1"' : ' step="any"'}${input?.min !== undefined ? ` min="${input.min}"` : ''}${input?.max !== undefined ? ` max="${input.max}"` : ''}`
    : ' type="text" autocomplete="off"';
  return `<label><span>${htmlEscape(q.question)}</span><input name="${name}"${attrs} required></label>`;
}

/** The SCO to read and, when it is assessed, answer. The form posts back to the page it is on. */
export function renderScoPage(args: { courseTitle: string; sco: ScoView; graded?: GradedView; error?: string }): string {
  const { sco } = args;
  const questions = sco.assessment?.length ? `<ol class="q">${sco.assessment.map((q) => `<li>${questionControl(q)}</li>`).join('')}</ol>` : '';
  const inner = `${gradedCard(args.graded)}
<h1>${htmlEscape(sco.title)}</h1>
${args.error ? `<div class="card bad" role="alert">${htmlEscape(args.error)}</div>` : ''}
<div class="body">${courseMarkdownHtml(sco.body)}</div>
<form method="POST">${questions}<button type="submit">${sco.assessment?.length ? 'Submit answers' : 'Continue'}</button></form>`;
  return page(`${sco.title} · ${args.courseTitle}`, `${args.courseTitle} · launched from your LMS over LTI 1.3`, inner);
}

/** The end of the attempt: the engine's outcome and what happened to the grade. */
export function renderOutcomePage(args: { courseTitle: string; outcome: PlayOutcome; graded?: GradedView; retry?: boolean }): string {
  const { outcome } = args;
  const pct = Math.round(outcome.score * 100);
  const gb = outcome.gradebook;
  const grade = gb.posted
    ? `<p class="ok">Your LMS has the grade: ${gb.scoreGiven ?? pct} of ${gb.scoreMaximum ?? 100}, posted to its gradebook over LTI Assignment and Grade Services.</p>`
    : `<p class="bad">The grade did not reach your LMS: ${htmlEscape(gb.why ?? 'no gradebook was offered for this launch')}.</p>`;
  const inner = `${gradedCard(args.graded)}
<h1>${outcome.passed ? 'Passed' : 'Not passed yet'}: ${pct}%</h1>
${grade}
<p>The attempt is in your learner record: ${outcome.recordedStatements} statement${outcome.recordedStatements === 1 ? '' : 's'}, graded by the SCORM engine.</p>
${args.retry ? '<form method="POST"><button type="submit">Send the grade again</button></form>' : '<p class="muted">You can close this window.</p>'}`;
  return page(`${outcome.passed ? 'Passed' : 'Not passed'} · ${args.courseTitle}`, `${args.courseTitle} · launched from your LMS over LTI 1.3`, inner);
}

/** A page for a launch that has ended or never was. */
export function renderGonePage(message: string): string {
  return page('Launch ended', 'Foxxi', `<h1>This launch has ended</h1><p>${htmlEscape(message)}</p>`);
}

/**
 * The answers in a submission, in question order: a JSON body's `answers`, or the page's form
 * fields `answer_0` onward. Given the questions, a form's fields are put back into one reply
 * each: the ticked boxes of a multiple choice joined by commas, a row of selects (ordering,
 * matching) joined in row order, empty while any of them is unchosen. Checking them is the
 * engine's job.
 */
export function answersFrom(body: unknown, questions: number | ReadonlyArray<LearnerQuestion>): unknown {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.answers)) return b.answers;
  if (typeof questions === 'number') return questions === 0 ? undefined : Array.from({ length: questions }, (_, i) => b[`answer_${i}`]);
  if (questions.length === 0) return undefined;
  return questions.map((q) => {
    const type = q.input?.type;
    if (type === 'sequencing' || type === 'matching') {
      const rows = (q.input?.items ?? []).length;
      const parts = Array.from({ length: rows }, (_, k) => b[`answer_${q.index}_${k}`]);
      return parts.every((p) => typeof p === 'string' && p) ? parts.join(', ') : '';
    }
    const value = b[`answer_${q.index}`];
    return Array.isArray(value) ? value.filter((v) => typeof v === 'string').join(', ') : value;
  });
}

/** The AGS Score for an ended attempt (AGS 2.0 §3.4): 0 to 100, completed and fully graded. */
export function agsScore(userId: string, outcome: { passed: boolean; score: number }, at: Date): Record<string, unknown> {
  const scaled = Math.max(0, Math.min(1, outcome.score));
  return {
    userId,
    scoreGiven: Math.round(scaled * 1000) / 10,
    scoreMaximum: 100,
    activityProgress: 'Completed',
    gradingProgress: 'FullyGraded',
    timestamp: at.toISOString(),
    comment: outcome.passed ? 'Passed' : 'Not passed',
  };
}
