/**
 * Play a composition, step by step, as the signed-in learner.
 *
 * The bridge resolves the composition from the learner's own record, grades each step and keeps it
 * in their record (foxxi.content_launch, foxxi.content_next). This page shows what it was given and
 * sends back what the learner put, signed as them. An agent plays the same composition through the
 * same two affordances, with no page at all.
 *
 * Nothing is launched until the learner asks: a launch starts a play and is signed, and with a
 * wallet extension a signature is a prompt, which should follow a click rather than a page load.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Card, Pill } from './common.js';
import { QuestionField } from './QuestionField.js';
import { useAffordance, useHypermedia } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';
import { signerAsks, signerFor } from '../auth/signer.js';
import { AffordanceRefusal, postSigned } from '../auth/signed-request.js';
// The engine's own renderer: it escapes every character an author wrote and builds only its own
// elements (links and images only for http(s) URLs), so a fragment's body is rendered here from its
// Markdown, never from HTML the page was sent.
import { courseMarkdownHtml } from '../../../src/course-markdown.js';
import { draftFor, problemWith, repliesFor, type Draft } from '../learn/answers.js';
import { bridgeBaseOf } from '../learn/bridge.js';
import { compositionIriOn } from '../learn/composition-ref.js';
import {
  competencyLabel, nothingToPlayBecause, scoreLine, wayInLabel,
  type CompositionView, type Graded, type Launched, type ResolutionNotes, type Stepped, type StepView,
} from '../learn/play.js';
import { readRecents, recentsKey, remember } from '../learn/recents.js';

type Phase =
  | { at: 'intro' }
  | { at: 'starting' }
  | { at: 'playing'; sessionId: string; title: string; step: StepView; drafts: Draft[]; sending: boolean; problems: Record<number, string>; error?: string }
  | { at: 'feedback'; sessionId: string; title: string; answered: StepView; drafts: Draft[]; graded: Graded; next: Stepped }
  | { at: 'done'; title: string; summary: { steps: number; graded: { correct: number; total: number } } }
  | { at: 'nothing'; notes: ResolutionNotes }
  | { at: 'ended'; why: string };

function rememberOpened(identity: string, hash: string, title: string | undefined): void {
  try {
    const key = recentsKey(identity);
    localStorage.setItem(key, JSON.stringify(remember(readRecents(localStorage.getItem(key)), { hash, at: new Date().toISOString(), ...(title ? { title } : {}) })));
  } catch { /* a browser that keeps nothing still plays */ }
}

export function CompositionPlayer({ session }: { session: FoxxiSession }) {
  const { hash = '' } = useParams();
  const navigate = useNavigate();
  const { entry, error: entryError } = useHypermedia();
  const base = bridgeBaseOf(entry);
  const launch = useAffordance('foxxi.content_launch');
  const next = useAffordance('foxxi.content_next');
  const asks = signerAsks(session);
  const [composition, setComposition] = useState<CompositionView | null>(null);
  const [lookup, setLookup] = useState<'loading' | 'found' | 'absent' | 'unreachable'>('loading');
  const [phase, setPhase] = useState<Phase>({ at: 'intro' });

  // The composition as its IRI dereferences: unsigned, and read again only when the hash changes.
  useEffect(() => {
    if (!base || !/^[0-9a-f]{64}$/.test(hash)) return;
    let cancel = false;
    setLookup('loading');
    fetch(compositionIriOn(base, hash), { headers: { Accept: 'application/json' } })
      .then(async r => {
        if (cancel) return;
        if (r.status === 404) { setLookup('absent'); return; }
        if (!r.ok) { setLookup('unreachable'); return; }
        setComposition(await r.json() as CompositionView);
        setLookup('found');
      })
      .catch(() => { if (!cancel) setLookup('unreachable'); });
    return () => { cancel = true; };
  }, [base, hash]);

  if (!/^[0-9a-f]{64}$/.test(hash)) {
    return <Card title="Not a composition"><div>This link names no composition. <a href="/learn">Back to Learn</a></div></Card>;
  }
  if (entryError) return <Card title="The bridge could not be reached"><div style={{ color: 'var(--text-dim)' }}>{entryError}</div></Card>;
  if (!entry) return <Card title="Connecting to the bridge…"><div style={{ color: 'var(--text-dim)' }}>…</div></Card>;
  if (!launch || !next) {
    return <Card title="This bridge does not play compositions yet"><div style={{ color: 'var(--text-dim)' }}>It offers no foxxi.content_launch or foxxi.content_next.</div></Card>;
  }

  const signer = signerFor(session);
  const title = phase.at === 'playing' || phase.at === 'feedback' || phase.at === 'done' ? phase.title : composition?.title;

  async function start(): Promise<void> {
    setPhase({ at: 'starting' });
    try {
      const r = await postSigned<Launched>(launch!.href, signer, { composition: compositionIriOn(base, hash) });
      if (r.done) { setPhase({ at: 'nothing', notes: r }); return; }
      rememberOpened(session.webId, hash, r.title);
      setPhase({ at: 'playing', sessionId: r.sessionId, title: r.title, step: r.step, drafts: (r.step.fragment.questions ?? []).map(draftFor), sending: false, problems: {} });
    } catch (e) {
      setPhase({ at: 'ended', why: e instanceof AffordanceRefusal && e.status === 404 ? 'This bridge holds no such composition.' : (e as Error).message });
    }
  }

  function show(r: Stepped, sessionId: string, playTitle: string): void {
    if (r.done || !r.step) { setPhase({ at: 'done', title: playTitle, summary: r.summary ?? { steps: 0, graded: { correct: 0, total: 0 } } }); return; }
    setPhase({ at: 'playing', sessionId, title: playTitle, step: r.step, drafts: (r.step.fragment.questions ?? []).map(draftFor), sending: false, problems: {} });
  }

  async function send(p: Extract<Phase, { at: 'playing' }>): Promise<void> {
    const questions = p.step.fragment.questions ?? [];
    const problems: Record<number, string> = {};
    questions.forEach((q, i) => { const problem = problemWith(q, p.drafts[i] ?? draftFor(q)); if (problem) problems[i] = problem; });
    if (Object.keys(problems).length) { setPhase({ ...p, problems }); return; }
    setPhase({ ...p, sending: true, problems: {}, error: undefined });
    try {
      const r = await postSigned<Stepped>(next!.href, signer, { session_id: p.sessionId, ...(questions.length ? { answers: repliesFor(questions, p.drafts) } : {}) });
      if (r.graded) { setPhase({ at: 'feedback', sessionId: p.sessionId, title: p.title, answered: p.step, drafts: p.drafts, graded: r.graded, next: r }); return; }
      show(r, p.sessionId, p.title);
    } catch (e) {
      if (e instanceof AffordanceRefusal && e.status === 422) {
        const listed = (e.body as { validationErrors?: Array<{ index: number; message: string }> }).validationErrors ?? [];
        const byQuestion: Record<number, string> = {};
        for (const v of listed) if (v.index >= 0) byQuestion[v.index] = v.message;
        setPhase({ ...p, sending: false, problems: byQuestion, error: listed.some(v => v.index < 0) ? e.message : undefined });
        return;
      }
      if (e instanceof AffordanceRefusal && e.status === 404) {
        setPhase({ at: 'ended', why: 'This play has ended: a play is kept for three hours, and not past a restart of the bridge. Start it again.' });
        return;
      }
      // Anything else leaves the step where it was: sending again sends the same answers, and the bridge keeps a step once.
      setPhase({ ...p, sending: false, error: (e as Error).message });
    }
  }

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card title={title ?? 'A composition'} right={<a href="/learn" onClick={ev => { ev.preventDefault(); navigate('/learn'); }}>← Learn</a>}>
        {phase.at === 'intro' && (
          <div>
            {lookup === 'loading' && <div style={{ color: 'var(--text-dim)' }}>Reading the composition…</div>}
            {lookup === 'absent' && <div style={{ color: 'var(--bad)' }}>This bridge holds no composition with this hash. It may live on another bridge.</div>}
            {lookup === 'unreachable' && <div style={{ color: 'var(--warn)' }}>The composition could not be read just now; starting may still work.</div>}
            {composition && (
              <div style={{ color: 'var(--text-dim)', marginBottom: 12 }}>
                Develops <strong style={{ color: 'var(--text)' }}>{competencyLabel(composition.competency)}</strong>, in {composition.positions.length} position{composition.positions.length === 1 ? '' : 's'}.
                What you are shown is chosen for you from your own record: a position you have already shown may be skipped, and each is pitched at your level.
              </div>
            )}
            <Button primary disabled={lookup === 'absent'} onClick={() => { void start(); }}>Start</Button>
            {asks && <div style={{ color: 'var(--text-dim)', fontSize: 12, marginTop: 8 }}>Your wallet will ask you to approve starting, and each step you send.</div>}
          </div>
        )}
        {phase.at === 'starting' && <div style={{ color: 'var(--text-dim)' }}>{asks ? 'Approve the request in your wallet…' : 'Resolving it for you…'}</div>}
        {phase.at === 'ended' && (
          <div>
            <div style={{ color: 'var(--bad)', marginBottom: 10 }}>{phase.why}</div>
            <Button onClick={() => setPhase({ at: 'intro' })}>Back</Button>
          </div>
        )}
        {phase.at === 'nothing' && (
          <div>
            <div style={{ marginBottom: 8 }}>There is nothing here to play for you.</div>
            <ul style={{ margin: '0 0 10px', color: 'var(--text-dim)' }}>{nothingToPlayBecause(phase.notes).map((s, i) => <li key={i}>{s}</li>)}</ul>
            <Button onClick={() => navigate('/learn')}>Back to Learn</Button>
          </div>
        )}
        {phase.at === 'done' && (
          <div>
            <div style={{ fontSize: 20, marginBottom: 6 }}>Finished.</div>
            <div style={{ color: 'var(--text-dim)', marginBottom: 12 }}>
              {phase.summary.steps} step{phase.summary.steps === 1 ? '' : 's'} · {scoreLine(phase.summary.graded)}. It is kept in your own record.
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <Button onClick={() => setPhase({ at: 'intro' })}>Play again</Button>
              <Button onClick={() => navigate('/learn')}>Back to Learn</Button>
            </div>
          </div>
        )}
      </Card>

      {phase.at === 'playing' && (
        <StepCard step={phase.step}>
          {(phase.step.fragment.questions ?? []).map((q, i) => (
            <QuestionField key={`${phase.sessionId}:${phase.step.step}:${i}`} name={`${phase.sessionId}-${phase.step.step}-${i}`} q={q}
              draft={phase.drafts[i] ?? draftFor(q)} disabled={phase.sending} problem={phase.problems[i] ?? null}
              onChange={d => setPhase({ ...phase, drafts: phase.drafts.map((x, j) => (j === i ? d : x)), problems: { ...phase.problems, [i]: '' } })} />
          ))}
          {phase.error && <div role="alert" style={{ color: 'var(--bad)', marginBottom: 10 }}>{phase.error}</div>}
          <Button primary disabled={phase.sending} onClick={() => { void send(phase); }}>
            {phase.sending ? (asks ? 'Approve in your wallet…' : 'Sending…') : (phase.step.fragment.questions?.length ? 'Send my answers' : 'Continue')}
          </Button>
        </StepCard>
      )}

      {phase.at === 'feedback' && (
        <StepCard step={phase.answered}>
          {(phase.answered.fragment.questions ?? []).map((q, i) => (
            <QuestionField key={`${phase.sessionId}:${phase.answered.step}:${i}:graded`} name={`${phase.sessionId}-${phase.answered.step}-${i}-graded`} q={q}
              draft={phase.drafts[i] ?? draftFor(q)} disabled onChange={() => undefined} feedback={phase.graded.detail[i]} />
          ))}
          <div style={{ marginBottom: 10 }}><strong>{scoreLine(phase.graded)}.</strong>{' '}
            {phase.graded.correct < phase.graded.total && phase.next.step?.wayIn === 'teaching' && <span>What comes next is another way into it.</span>}
          </div>
          <Button primary onClick={() => show(phase.next, phase.sessionId, phase.title)}>{phase.next.done ? 'Finish' : 'Next'}</Button>
        </StepCard>
      )}

      <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        An agent plays this composition the same way: <code>foxxi.content_launch</code>, then <code>foxxi.content_next</code> with its answers, signed as itself.
      </div>
    </div>
  );
}

function StepCard({ step, children }: { step: StepView; children: React.ReactNode }) {
  const label = wayInLabel(step.wayIn);
  const f = step.fragment;
  return (
    <Card title={f.title ?? `${f.kind} fragment`} right={<span className="label">Step {step.step} of {step.of}</span>}>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 }}>
        {label && <Pill tone="accent" title="A check was missed, so the play brought this in before going on.">{label}</Pill>}
        <Pill>{f.kind}</Pill>
        <Pill>{f.level}</Pill>
        <Pill tone="neutral" title={step.competency}>{competencyLabel(step.competency)}</Pill>
      </div>
      <details style={{ marginBottom: 12, color: 'var(--text-dim)', fontSize: 13 }}>
        <summary style={{ cursor: 'pointer' }}>Why this, for you</summary>
        <div style={{ marginTop: 6 }}>{step.chosenBecause}</div>
      </details>
      <div className="fx-prose" lang={f.language} dangerouslySetInnerHTML={{ __html: courseMarkdownHtml(f.body) }} />
      <div style={{ marginTop: 14 }}>{children}</div>
    </Card>
  );
}
