/**
 * Compose: a title, the competency it develops, and positions, each with the alternatives that can
 * fill it (foxxi.content_compose). Resolution picks among a position's alternatives for each
 * learner (admission, audience, their level, then what has worked for learners like them), so the
 * author offers ways in rather than one path. The order within a position is the tie-break.
 *
 * Alternatives come from the author's shelf, or by IRI from anywhere; the bridge refuses a
 * composition whose alternatives it cannot reach, and says which.
 */
import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button, Card, Pill } from './common.js';
import { fieldStyle } from './QuestionEditor.js';
import { useAffordance } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';
import { signerAsks, signerFor } from '../auth/signer.js';
import { AffordanceRefusal, postSigned } from '../auth/signed-request.js';
import { compositionPayload, contentKindOf, missingFromComposition, newComposition, offer, type CompositionDraft } from '../author/compose.js';
import { moved } from '../author/draft.js';
import type { ShelfItem } from '../author/shelf.js';
import { hashOfComposition } from '../learn/composition-ref.js';

export function CompositionEditor({ session, shelf, onComposed }: { session: FoxxiSession; shelf: ShelfItem[]; onComposed: (item: ShelfItem) => void }) {
  const navigate = useNavigate();
  const affordance = useAffordance('foxxi.content_compose');
  const [draft, setDraft] = useState<CompositionDraft>(newComposition());
  const [pasted, setPasted] = useState<Record<number, string>>({});
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<{ message: string; unknown?: string[] } | null>(null);
  const [made, setMade] = useState<ShelfItem | null>(null);
  const missing = missingFromComposition(draft);
  const nameOf = (iri: string) => shelf.find(s => s.iri === iri)?.title ?? iri.replace(/^.*\/ns\/foxxi\//, '').slice(0, 24) + '…';
  const set = (d: CompositionDraft) => { setDraft(d); setError(null); };
  const position = (i: number, patch: Partial<CompositionDraft['positions'][number]>) =>
    set({ ...draft, positions: draft.positions.map((p, k) => (k === i ? { ...p, ...patch } : p)) });

  async function send(): Promise<void> {
    if (!affordance) return;
    setSending(true); setError(null);
    try {
      const r = await postSigned<{ '@id': string }>(affordance.href, signerFor(session), { composition: compositionPayload(draft) });
      const item: ShelfItem = { iri: r['@id'], type: 'composition', title: draft.title.trim(), at: new Date().toISOString() };
      onComposed(item);
      setMade(item);
      setDraft(newComposition());
      setPasted({});
    } catch (e) {
      const unknown = e instanceof AffordanceRefusal ? (e.body as { unknown?: string[] }).unknown : undefined;
      setError({ message: (e as Error).message, ...(unknown ? { unknown } : {}) });
    } finally { setSending(false); }
  }

  if (!affordance) return <Card title="Compose"><div style={{ color: 'var(--text-dim)' }}>This bridge composes nothing (no foxxi.content_compose).</div></Card>;
  const madeHash = made ? hashOfComposition(made.iri) : undefined;

  return (
    <Card title="Compose">
      {made && madeHash && (
        <div role="status" style={{ padding: '8px 10px', border: '1px solid var(--good)', borderRadius: 4, marginBottom: 12 }}>
          Composed <strong>{made.title}</strong>, now on your shelf.{' '}
          <a href={`/learn/${madeHash}`} onClick={e => { e.preventDefault(); navigate(`/learn/${madeHash}`); }}>Play it</a>{' · '}
          <a href={`/author/${madeHash}`} onClick={e => { e.preventDefault(); navigate(`/author/${madeHash}`); }}>What it has learned</a>
        </div>
      )}
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 4, flex: 2, minWidth: 220 }}>
            <span className="label">Title</span>
            <input value={draft.title} onChange={e => set({ ...draft, title: e.target.value })} style={fieldStyle} />
          </label>
          <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 200 }}>
            <span className="label">The competency it develops</span>
            <input value={draft.competency} placeholder="refund-authority, or an IRI" onChange={e => set({ ...draft, competency: e.target.value })} style={fieldStyle} />
          </label>
        </div>

        {draft.positions.map((p, i) => (
          <fieldset key={i} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', margin: 0, background: 'var(--panel-2)', display: 'grid', gap: 8 }}>
            <legend style={{ padding: '0 6px', fontWeight: 600 }}>Position {i + 1}</legend>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input aria-label={`Position ${i + 1} competency`} value={p.competency} placeholder="its competency: the composition's own, unless you name another"
                onChange={e => position(i, { competency: e.target.value })} style={fieldStyle} />
              <button type="button" aria-label={`Move position ${i + 1} up`} disabled={i === 0} onClick={() => set({ ...draft, positions: moved(draft.positions, i, i - 1) })}>↑</button>
              <button type="button" aria-label={`Move position ${i + 1} down`} disabled={i === draft.positions.length - 1} onClick={() => set({ ...draft, positions: moved(draft.positions, i, i + 1) })}>↓</button>
              <Button small danger disabled={draft.positions.length <= 1} onClick={() => set({ ...draft, positions: draft.positions.filter((_, k) => k !== i) })}>Remove</Button>
            </div>
            <div className="label">Ways in, in your order of preference</div>
            {p.alternatives.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>None yet: add a fragment or a composition below.</div>}
            {p.alternatives.map((a, k) => (
              <div key={a} style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
                <span className="mono" style={{ width: 18, fontSize: 12, color: 'var(--text-dim)' }}>{k + 1}.</span>
                <Pill>{contentKindOf(a) ?? '?'}</Pill>
                <span style={{ flex: 1 }} title={a}>{nameOf(a)}</span>
                <button type="button" aria-label={`Move ${nameOf(a)} up`} disabled={k === 0} onClick={() => position(i, { alternatives: moved(p.alternatives, k, k - 1) })}>↑</button>
                <button type="button" aria-label={`Move ${nameOf(a)} down`} disabled={k === p.alternatives.length - 1} onClick={() => position(i, { alternatives: moved(p.alternatives, k, k + 1) })}>↓</button>
                <button type="button" aria-label={`Remove ${nameOf(a)}`} onClick={() => position(i, { alternatives: p.alternatives.filter(x => x !== a) })}>✕</button>
              </div>
            ))}
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <select aria-label={`Add to position ${i + 1} from your shelf`} value="" onChange={e => { if (e.target.value) set(offer(draft, i, e.target.value)); }} style={{ ...fieldStyle, width: 'auto', flex: 1, minWidth: 200 }}>
                <option value="">Add from your shelf…</option>
                {shelf.map(s => <option key={s.iri} value={s.iri}>{s.type === 'composition' ? '◆ ' : ''}{s.title ?? s.iri}{s.kind ? ` (${s.kind}${s.level ? `, ${s.level}` : ''})` : ''}</option>)}
              </select>
              <input aria-label={`Paste an IRI into position ${i + 1}`} value={pasted[i] ?? ''} placeholder="or paste a fragment's or composition's IRI"
                onChange={e => setPasted({ ...pasted, [i]: e.target.value })} style={{ ...fieldStyle, flex: 2, minWidth: 220 }} />
              <Button small disabled={!contentKindOf(pasted[i] ?? '')} onClick={() => { set(offer(draft, i, pasted[i] ?? '')); setPasted({ ...pasted, [i]: '' }); }}>Add</Button>
            </div>
          </fieldset>
        ))}
        <div><Button small onClick={() => set({ ...draft, positions: [...draft.positions, { competency: '', alternatives: [] }] })}>Add a position</Button></div>

        {missing.length > 0 && <ul style={{ margin: 0, color: 'var(--warn)', fontSize: 13 }}>{missing.map((m, i) => <li key={i}>{m}</li>)}</ul>}
        {error && (
          <div role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>
            {error.message}
            {error.unknown && <ul style={{ margin: '4px 0 0' }}>{error.unknown.map(u => <li key={u}><code>{u}</code></li>)}</ul>}
          </div>
        )}
        <div>
          <Button primary disabled={sending || missing.length > 0} onClick={() => { void send(); }}>{sending ? (signerAsks(session) ? 'Approve in your wallet…' : 'Sending…') : 'Compose it'}</Button>
        </div>
      </div>
    </Card>
  );
}
