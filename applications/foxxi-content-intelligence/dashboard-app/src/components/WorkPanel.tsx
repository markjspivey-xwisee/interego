/**
 * Work: a performer records units of their own production work, and keeps, or not, what a failed
 * unit's work implies about the content that would help.
 *
 * Recording is foxxi.record_performance_signed, signed as the performer, into their own record. A
 * failed unit sent with how it went is answered, unasked, with an offer: the regime the work reads
 * as, the plan for it, and the forms of content that plan admits at the competency. Keeping it is
 * foxxi.content_admit; what is kept is listed with foxxi.content_admissions and withdrawn the same
 * way. Nothing is kept from an offer unless the performer keeps it. An agent does all of this with
 * the same affordances.
 */
import React, { useEffect, useState } from 'react';
import { Button, Card, Pill } from './common.js';
import { fieldStyle } from './QuestionEditor.js';
import { useAffordance } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';
import { signerAsks, signerFor } from '../auth/signer.js';
import { postSigned } from '../auth/signed-request.js';
import { competencyLabel } from '../learn/play.js';
import { moved } from '../author/draft.js';
import {
  AGENT_RECORD_IS_PUBLIC, CERTAINTIES, GRAINS, afterRecording, answerableFailure, doneBy, missingFromWork, newStep, newWork, workPayload,
  type Certainty, type Grain, type StepDraft, type WorkDraft,
} from '../work/record.js';
import { keepArgs, keptLine, kindsLine, withdrawArgs, type KeptAdmission, type Recorded, type WorkOffer } from '../work/offer.js';

const small: React.CSSProperties = { fontSize: 13, color: 'var(--text-dim)' };

export function WorkPanel({ session }: { session: FoxxiSession }) {
  const record = useAffordance('foxxi.record_performance_signed');
  const admit = useAffordance('foxxi.content_admit');
  const admissions = useAffordance('foxxi.content_admissions');
  const asks = signerAsks(session);
  const [draft, setDraft] = useState<WorkDraft>(() => newWork('human'));
  const [keptOffer, setKeptOffer] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<Recorded | null>(null);
  const [kept, setKept] = useState<KeptAdmission[] | null>(null);
  const [keptState, setKeptState] = useState<'idle' | 'reading' | 'failed'>('idle');
  const [keptError, setKeptError] = useState('');
  const [keeping, setKeeping] = useState(false);
  const missing = missingFromWork(draft);
  const set = (patch: Partial<WorkDraft>) => { setDraft(d => ({ ...d, ...patch })); setError(null); };
  const step = (i: number, patch: Partial<StepDraft>) => set({ steps: draft.steps.map((s, k) => (k === i ? { ...s, ...patch } : s)) });

  async function readKept(href: string): Promise<void> {
    setKeptState('reading');
    try { setKept((await postSigned<{ standing: KeptAdmission[] }>(href, signerFor(session), {})).standing ?? []); setKeptState('idle'); }
    catch (e) { setKeptError((e as Error).message); setKeptState('failed'); }
  }
  const keptHref = admissions?.href;
  useEffect(() => { if (keptHref && !asks) void readKept(keptHref); }, [keptHref, asks, session.webId]);

  async function send(): Promise<void> {
    if (!record) return;
    setSending(true); setError(null);
    try {
      setRecorded(await postSigned<Recorded>(record.href, signerFor(session), workPayload(draft)));
      setKeptOffer(false);
      setDraft(afterRecording);
    } catch (e) { setError((e as Error).message); }
    finally { setSending(false); }
  }

  /** Keep an offer, or withdraw what is kept at a competency: one signed call, the list updated from its answer. */
  async function change(args: Record<string, unknown>): Promise<boolean> {
    if (!admit) return false;
    setKeeping(true); setKeptError('');
    try {
      const r = await postSigned<{ kept: KeptAdmission }>(admit.href, signerFor(session), args);
      setKept(list => [r.kept, ...(list ?? []).filter(k => k.competency !== r.kept.competency)]);
      return true;
    } catch (e) { setKeptError((e as Error).message); return false; }
    finally { setKeeping(false); }
  }

  if (!record) return <Card title="Record your work"><div style={small}>This bridge records no work (no foxxi.record_performance_signed).</div></Card>;

  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card title="Record a unit of your work">
        <div style={{ ...small, marginBottom: 10 }}>
          Kept in your own record, signed as you. A unit that failed, sent with how it went, is answered with what your work
          at that competency implies about the content that would help: yours to keep, or not.
        </div>
        <div style={{ display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span className="label">What the work was</span>
            <input value={draft.taskName} placeholder="Refund a disputed $600 order" onChange={e => set({ taskName: e.target.value })} style={fieldStyle} />
          </label>
          <div role="radiogroup" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <span className="label">It</span>
            {(['succeeded', 'failed'] as const).map(o => (
              <label key={o} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="radio" name="work-outcome" checked={draft.outcome === o} onChange={() => set({ outcome: o })} />{o}
              </label>
            ))}
          </div>
          <div role="radiogroup" aria-label="Done by" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <span className="label">Done by</span>
            {([['human', 'a person'], ['agent', 'an agent']] as const).map(([k, label]) => (
              <label key={k} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="radio" name="work-done-by" checked={draft.forKind === k} onChange={() => { setDraft(d => doneBy(d, k)); setError(null); }} />{label}
              </label>
            ))}
          </div>
          {draft.forKind === 'agent' && (
            <div role="note" style={{ border: '1px solid var(--warn)', borderRadius: 6, padding: '8px 10px', fontSize: 13, display: 'grid', gap: 6 }}>
              <div>{AGENT_RECORD_IS_PUBLIC}</div>
              <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input type="checkbox" checked={draft.publicAsAgent} onChange={e => set({ publicAsAgent: e.target.checked })} />
                I understand, and it is an agent&apos;s work
              </label>
            </div>
          )}
          <details>
            <summary style={{ cursor: 'pointer', fontSize: 13 }}>Its kind, the artifact, quality and duration</summary>
            <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
              <label style={{ display: 'grid', gap: 4 }}>
                <span className="label">Kind of work, an IRI (units of one kind count toward one competency; left out, the work's name is used)</span>
                <input value={draft.activityType} placeholder="https://your.example/work/refunds" onChange={e => set({ activityType: e.target.value })} style={fieldStyle} />
              </label>
              <label style={{ display: 'grid', gap: 4 }}>
                <span className="label">What it produced, as a URL the bridge can fetch (optional; without one the claim is recorded as unbound)</span>
                <input value={draft.taskId} onChange={e => set({ taskId: e.target.value })} style={fieldStyle} />
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                <label style={{ display: 'grid', gap: 4, flex: 1 }}>
                  <span className="label">Quality, -1 to 1</span>
                  <input inputMode="decimal" value={draft.quality} onChange={e => set({ quality: e.target.value })} style={fieldStyle} />
                </label>
                <label style={{ display: 'grid', gap: 4, flex: 1 }}>
                  <span className="label">Duration, e.g. PT25M</span>
                  <input value={draft.duration} onChange={e => set({ duration: e.target.value })} style={fieldStyle} />
                </label>
              </div>
            </div>
          </details>

          <div>
            <div className="label" style={{ marginBottom: 6 }}>How it went, step by step {draft.outcome === 'failed' ? '(what a failure is answered from)' : '(optional)'}</div>
            {draft.steps.map((s, i) => (
              <fieldset key={i} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 10px', margin: '0 0 8px', background: 'var(--panel-2)', display: 'grid', gap: 6 }}>
                <legend style={{ padding: '0 6px', fontWeight: 600 }}>Step {i + 1}</legend>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input aria-label={`Step ${i + 1}: what was done`} value={s.did} placeholder="checked" onChange={e => step(i, { did: e.target.value })} style={{ ...fieldStyle, flex: 1 }} />
                  <input aria-label={`Step ${i + 1}: on what`} value={s.onWhat} placeholder="the refund limit" onChange={e => step(i, { onWhat: e.target.value })} style={{ ...fieldStyle, flex: 2 }} />
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  <select aria-label={`Step ${i + 1}: how sure`} value={s.certainty} onChange={e => step(i, { certainty: e.target.value as Certainty })} style={{ ...fieldStyle, width: 'auto' }}>
                    {CERTAINTIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                  <select aria-label={`Step ${i + 1}: how much of the work`} value={s.grain} onChange={e => step(i, { grain: e.target.value as Grain })} style={{ ...fieldStyle, width: 'auto' }}>
                    {GRAINS.map(g => <option key={g.value} value={g.value}>{g.label}</option>)}
                  </select>
                  <select aria-label={`Step ${i + 1}: how it turned out`} value={s.outcome} onChange={e => step(i, { outcome: e.target.value as StepDraft['outcome'] })} style={{ ...fieldStyle, width: 'auto' }}>
                    <option value="">turned out: unsaid</option><option value="worked">it worked</option><option value="failed">it did not work</option>
                  </select>
                  {i > 0 && (
                    <select aria-label={`Step ${i + 1}: revises`} value={s.revises ?? ''} onChange={e => step(i, { revises: e.target.value === '' ? null : Number(e.target.value) })} style={{ ...fieldStyle, width: 'auto' }}>
                      <option value="">revises no earlier step</option>
                      {draft.steps.slice(0, i).map((_, k) => <option key={k} value={k}>revises step {k + 1}</option>)}
                    </select>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input aria-label={`Step ${i + 1}: note`} value={s.note} placeholder="a note (optional)" onChange={e => step(i, { note: e.target.value })} style={{ ...fieldStyle, flex: 1 }} />
                  <button type="button" aria-label={`Move step ${i + 1} up`} disabled={i === 0} onClick={() => set({ steps: moved(draft.steps, i, i - 1).map(x => ({ ...x, revises: null })) })}>↑</button>
                  <button type="button" aria-label={`Move step ${i + 1} down`} disabled={i === draft.steps.length - 1} onClick={() => set({ steps: moved(draft.steps, i, i + 1).map(x => ({ ...x, revises: null })) })}>↓</button>
                  <button type="button" aria-label={`Remove step ${i + 1}`} onClick={() => set({ steps: draft.steps.filter((_, k) => k !== i).map(x => ({ ...x, revises: null })) })}>✕</button>
                </div>
              </fieldset>
            ))}
            <Button small onClick={() => set({ steps: [...draft.steps, newStep()] })}>Add a step</Button>
            {draft.outcome === 'failed' && !answerableFailure(draft) && (
              <div style={{ ...small, marginTop: 6 }}>Without how it went, a failure is recorded but cannot be answered: its regime is read from the steps.</div>
            )}
          </div>

          {missing.length > 0 && <ul style={{ margin: 0, color: 'var(--warn)', fontSize: 13 }}>{missing.map((m, i) => <li key={i}>{m}</li>)}</ul>}
          {error && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</div>}
          <div>
            <Button primary disabled={sending || missing.length > 0} onClick={() => { void send(); }}>{sending ? (asks ? 'Approve in your wallet…' : 'Recording…') : 'Record it'}</Button>
          </div>
        </div>
      </Card>

      {recorded && (
        <Card title={recorded.success ? 'Recorded' : 'Recorded, and answered'}>
          <div style={{ ...small, marginBottom: 8 }}>
            <strong style={{ color: 'var(--text)' }}>{recorded.taskName}</strong> is in your record{recorded.success ? ', as succeeded' : ', as failed'}.
          </div>
          {recorded.recordVisibility && <div role="note" style={{ fontSize: 13, color: recorded.recordVisibility.publiclyReadable ? 'var(--warn)' : 'var(--text-dim)', marginBottom: 8 }}>{recorded.recordVisibility.note}</div>}
          {recorded.samePrincipalAlsoHolds && <div style={{ ...small, marginBottom: 8 }}>{recorded.samePrincipalAlsoHolds.note}</div>}
          {recorded.offer && <OfferCard offer={recorded.offer} canKeep={!!admit && !keptOffer} keeping={keeping} asks={asks}
            onKeep={() => { void change(keepArgs(recorded.offer!)).then(ok => setKeptOffer(ok)); }} />}
          {keptOffer && <div style={small}>Kept. It is listed under what you keep.</div>}
          {recorded.offerWithheld && <div style={small}>Nothing is offered: {recorded.offerWithheld}.</div>}
        </Card>
      )}

      <Card title="What you keep" right={admissions && keptState !== 'reading' ? <Button small onClick={() => { void readKept(admissions.href); }}>{kept ? 'Read again' : 'Read it'}</Button> : undefined}>
        <div style={{ ...small, marginBottom: 8 }}>
          At each competency, the forms of content you let in, and why. Resolution reads it whenever it resolves a composition for you,
          until you replace it or withdraw it.
        </div>
        {!admissions && <div style={small}>This bridge lists nothing kept (no foxxi.content_admissions).</div>}
        {admissions && !kept && keptState === 'idle' && asks && <div style={small}>Reading what you keep is signed as you: your wallet will ask you to approve it.</div>}
        {keptState === 'reading' && <div style={small}>Reading…</div>}
        {keptState === 'failed' && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>{keptError}</div>}
        {keptState !== 'failed' && keptError && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>{keptError}</div>}
        {kept && kept.length === 0 && <div style={small}>You keep nothing yet.</div>}
        {kept?.map(k => (
          <div key={k.competency} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel-2)', marginBottom: 6 }}>
            <Pill title={k.competency}>{competencyLabel(k.competency)}</Pill>
            <span style={{ flex: 1, minWidth: 200 }}>
              {keptLine(k)}{k.admission && <span style={small}>, because {k.admission.because}</span>}
              {k.regime && <span style={small}> ({k.regime})</span>}
            </span>
            <span style={{ ...small, fontSize: 12 }}>{new Date(k.at).toLocaleString()}</span>
            {k.admission && admit && <Button small danger disabled={keeping} onClick={() => { void change(withdrawArgs(k.competency)); }}>Withdraw</Button>}
          </div>
        ))}
      </Card>

      <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
        An agent records its work and keeps what it implies the same way: <code>foxxi.record_performance_signed</code>, <code>foxxi.content_admit</code>, <code>foxxi.content_admissions</code>.
      </div>
    </div>
  );
}

function OfferCard({ offer, canKeep, keeping, asks, onKeep }: { offer: WorkOffer; canKeep: boolean; keeping: boolean; asks: boolean; onKeep: () => void }) {
  return (
    <div style={{ border: '1px solid var(--accent)', borderRadius: 6, padding: '10px 12px', display: 'grid', gap: 6 }}>
      <div><strong>What your work at {competencyLabel(offer.competency)} implies</strong></div>
      {offer.situation && <div style={small}>{offer.situation.observed}.</div>}
      {offer.diagnosis && <div>It reads as <Pill tone="accent">{offer.diagnosis.regime}</Pill> work{offer.diagnosis.regimeSource ? <span style={small}> ({offer.diagnosis.regimeSource})</span> : null}.</div>}
      {offer.plan && <div style={small}>The plan: {offer.plan.summary}</div>}
      <div>So the content that would help is <strong>{kindsLine(offer.kinds)}</strong>, because {offer.because}</div>
      {canKeep && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Button primary disabled={keeping} onClick={onKeep}>{keeping ? (asks ? 'Approve in your wallet…' : 'Keeping…') : 'Keep this'}</Button>
          <span style={small}>Kept, it narrows what you are shown at this competency until you withdraw it.</span>
        </div>
      )}
    </div>
  );
}
