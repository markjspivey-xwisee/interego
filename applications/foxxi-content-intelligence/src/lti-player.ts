/**
 * The course an LTI launch opens: the pages a person reads and answers in, the JSON a client
 * without a browser reads instead, and the AGS Score the Tool posts back to the platform when the
 * attempt ends. The SCORM engine does the grading (bridge/server.ts, advanceScormPlay); this only
 * shows its work and carries the result.
 */

/** A SCO as a learner may see it: never the answers. */
export interface ScoView {
  readonly id: string;
  readonly title: string;
  readonly body: string;
  readonly assessment?: ReadonlyArray<{ readonly index: number; readonly question: string; readonly input?: { readonly type: 'text' | 'integer' | 'number'; readonly min?: number; readonly max?: number } }>;
}

/** How the SCO just submitted was graded. */
export interface GradedView {
  readonly score: number;
  readonly correct: number;
  readonly total: number;
  readonly passed: boolean;
  readonly detail: ReadonlyArray<{ readonly question: string; readonly your: string; readonly correct: boolean }>;
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

/** Author text as paragraphs: escaped first, so nothing in a course body is markup. */
function paragraphs(text: string): string {
  return text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
    .map((p) => `<p>${htmlEscape(p).replace(/\n/g, '<br>')}</p>`).join('\n');
}

const STYLE = `:root{color-scheme:light dark;--fg:#1a1a2e;--muted:#5b6070;--line:#dde;--accent:#1a73e8;--bg:#fff;--card:#f7f8fb;--ok:#137333;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8f0;--muted:#a0a4b8;--line:#3a3d4a;--accent:#8ab4f8;--bg:#15161c;--card:#1d1f27;--ok:#81c995;--bad:#f28b82}}
*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:680px;margin:0 auto;padding:1.5rem 1rem 3rem;color:var(--fg);background:var(--bg);line-height:1.55}
.crumb{color:var(--muted);font-size:.85rem;margin:0}h1{font-size:1.35rem;margin:.35rem 0 1rem}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:.9rem 1rem;margin:1rem 0}
ol.q{padding-left:1.2rem}ol.q li{margin:.9rem 0}label span{display:block;margin-bottom:.35rem}
input{width:100%;font:inherit;padding:.55rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
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
  const rows = graded.detail.map((d) => `<li class="${d.correct ? 'ok' : 'bad'}">${d.correct ? 'Right' : 'Not right'}: ${htmlEscape(d.question)} <span class="muted">(you answered ${htmlEscape(d.your)})</span></li>`).join('');
  return `<div class="card"><b>Last section: ${graded.correct} of ${graded.total} right.</b><ul class="graded">${rows}</ul></div>`;
}

/** The SCO to read and, when it is assessed, answer. The form posts back to the page it is on. */
export function renderScoPage(args: { courseTitle: string; sco: ScoView; graded?: GradedView; error?: string }): string {
  const { sco } = args;
  const questions = sco.assessment?.length
    ? `<ol class="q">${sco.assessment.map((q) => {
      const numeric = q.input && q.input.type !== 'text';
      const attrs = numeric
        ? ` type="number" inputmode="decimal"${q.input?.type === 'integer' ? ' step="1"' : ' step="any"'}${q.input?.min !== undefined ? ` min="${q.input.min}"` : ''}${q.input?.max !== undefined ? ` max="${q.input.max}"` : ''}`
        : ' type="text" autocomplete="off"';
      return `<li><label><span>${htmlEscape(q.question)}</span><input name="answer_${q.index}"${attrs} required></label></li>`;
    }).join('')}</ol>`
    : '';
  const inner = `${gradedCard(args.graded)}
<h1>${htmlEscape(sco.title)}</h1>
${args.error ? `<div class="card bad" role="alert">${htmlEscape(args.error)}</div>` : ''}
${paragraphs(sco.body)}
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
 * fields `answer_0` onward. Checking them is the engine's job.
 */
export function answersFrom(body: unknown, questions: number): unknown {
  if (!body || typeof body !== 'object') return undefined;
  const b = body as Record<string, unknown>;
  if (Array.isArray(b.answers)) return b.answers;
  if (questions === 0) return undefined;
  return Array.from({ length: questions }, (_, i) => b[`answer_${i}`]);
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
