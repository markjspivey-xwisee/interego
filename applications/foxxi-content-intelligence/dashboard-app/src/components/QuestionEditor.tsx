/**
 * One question as an author writes it: the words, then what fits its kind (the options and which
 * are right, the items in their right order, the pairs that match, the answer and what else to
 * accept), and an explanation a learner sees once they have answered. The bridge salts and hashes
 * the answer; nothing here does.
 */
import React from 'react';
import { Button, Pill } from './common.js';
import { QUESTION_TYPES, isGraded, missingFrom, moved, newQuestion, withoutOption, type QuestionDraft, type QuestionType } from '../author/draft.js';

export const fieldStyle: React.CSSProperties = {
  width: '100%', padding: '7px 10px', border: '1px solid var(--border)', borderRadius: 4,
  background: 'var(--panel)', color: 'var(--text)', fontSize: 14, fontFamily: 'inherit',
};
const small: React.CSSProperties = { fontSize: 12, color: 'var(--text-dim)' };

/** A list of short texts: each editable, removable and movable, and one more to add. */
export function ListField({ label, values, onChange, onRemove, min = 0, marks, onMark, markLabel, ordered }: {
  label: string;
  values: string[];
  onChange: (v: string[]) => void;
  /** Remove the entry at `i` some other way than dropping it from the list (a choice's marks move with it). */
  onRemove?: (i: number) => void;
  min?: number;
  /** Which entries are marked (a choice's right options), and how to mark one. */
  marks?: number[];
  onMark?: (i: number) => void;
  markLabel?: string;
  ordered?: boolean;
}) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div className="label">{label}</div>
      {values.map((v, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className="mono" style={{ ...small, width: 18 }}>{ordered ? `${i + 1}.` : String.fromCharCode(65 + i)}</span>
          <input value={v} aria-label={`${label} ${i + 1}`} onChange={e => onChange(values.map((x, k) => (k === i ? e.target.value : x)))} style={fieldStyle} />
          {onMark && (
            <label style={{ ...small, display: 'flex', gap: 4, alignItems: 'center', whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={!!marks?.includes(i)} onChange={() => onMark(i)} />{markLabel ?? 'right'}
            </label>
          )}
          {ordered && <>
            <button type="button" aria-label={`Move ${label.toLowerCase()} ${i + 1} up`} disabled={i === 0} onClick={() => onChange(moved(values, i, i - 1))}>↑</button>
            <button type="button" aria-label={`Move ${label.toLowerCase()} ${i + 1} down`} disabled={i === values.length - 1} onClick={() => onChange(moved(values, i, i + 1))}>↓</button>
          </>}
          <button type="button" aria-label={`Remove ${label.toLowerCase()} ${i + 1}`} disabled={values.length <= min} onClick={() => (onRemove ? onRemove(i) : onChange(values.filter((_, k) => k !== i)))}>✕</button>
        </div>
      ))}
      <div><Button small onClick={() => onChange([...values, ''])}>Add</Button></div>
    </div>
  );
}

export function QuestionEditor({ index, draft, onChange, onRemove, onMove, count }: {
  index: number;
  draft: QuestionDraft;
  onChange: (d: QuestionDraft) => void;
  onRemove: () => void;
  onMove: (to: number) => void;
  count: number;
}) {
  const missing = missingFrom(draft);
  const explanation = 'explanation' in draft && (
    <label style={{ display: 'grid', gap: 4 }}>
      <span className="label">Explanation, shown once it is answered (optional)</span>
      <textarea rows={2} value={draft.explanation} onChange={e => onChange({ ...draft, explanation: e.target.value } as QuestionDraft)} style={fieldStyle} />
    </label>
  );
  return (
    <fieldset style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '10px 12px', margin: '0 0 10px', background: 'var(--panel-2)', display: 'grid', gap: 8 }}>
      <legend style={{ padding: '0 6px', fontWeight: 600 }}>Question {index + 1}</legend>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <select aria-label={`Question ${index + 1} kind`} value={draft.type}
          onChange={e => onChange({ ...newQuestion(e.target.value as QuestionType), question: draft.question } as QuestionDraft)} style={{ ...fieldStyle, width: 'auto' }}>
          {QUESTION_TYPES.map(t => <option key={t.type} value={t.type}>{t.label}</option>)}
        </select>
        {isGraded(draft) ? <Pill>graded</Pill> : <Pill>not graded</Pill>}
        <span style={{ flex: 1 }} />
        <button type="button" aria-label={`Move question ${index + 1} up`} disabled={index === 0} onClick={() => onMove(index - 1)}>↑</button>
        <button type="button" aria-label={`Move question ${index + 1} down`} disabled={index === count - 1} onClick={() => onMove(index + 1)}>↓</button>
        <Button small danger onClick={onRemove}>Remove</Button>
      </div>
      <label style={{ display: 'grid', gap: 4 }}>
        <span className="label">The question</span>
        <input value={draft.question} onChange={e => onChange({ ...draft, question: e.target.value })} style={fieldStyle} />
      </label>

      {draft.type === 'choice' && (
        <ListField label="Options" values={draft.options} min={2} marks={draft.right}
          onChange={options => onChange({ ...draft, options })} onRemove={i => onChange(withoutOption(draft, i))}
          onMark={i => onChange({ ...draft, right: draft.right.includes(i) ? draft.right.filter(r => r !== i) : [...draft.right, i] })} />
      )}
      {draft.type === 'choice' && <div style={small}>Mark every right option; with more than one, a learner must pick them all.</div>}
      {draft.type === 'true-false' && (
        <div role="radiogroup" style={{ display: 'flex', gap: 12 }}>
          {[true, false].map(v => (
            <label key={String(v)} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="radio" name={`q${index}-truth`} checked={draft.answer === v} onChange={() => onChange({ ...draft, answer: v })} />{v ? 'True' : 'False'}
            </label>
          ))}
        </div>
      )}
      {draft.type === 'sequencing' && (
        <ListField label="Items, in their right order" values={draft.items} min={2} ordered onChange={items => onChange({ ...draft, items })} />
      )}
      {draft.type === 'matching' && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div className="label">Pairs: each prompt, and what it matches</div>
          {draft.pairs.map(([prompt, answer], i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input aria-label={`Prompt ${i + 1}`} value={prompt} onChange={e => onChange({ ...draft, pairs: draft.pairs.map((p, k) => (k === i ? [e.target.value, p[1]] : p)) })} style={fieldStyle} />
              <span style={small}>→</span>
              <input aria-label={`Match for prompt ${i + 1}`} value={answer} onChange={e => onChange({ ...draft, pairs: draft.pairs.map((p, k) => (k === i ? [p[0], e.target.value] : p)) })} style={fieldStyle} />
              <button type="button" aria-label={`Remove pair ${i + 1}`} disabled={draft.pairs.length <= 2} onClick={() => onChange({ ...draft, pairs: draft.pairs.filter((_, k) => k !== i) })}>✕</button>
            </div>
          ))}
          <div><Button small onClick={() => onChange({ ...draft, pairs: [...draft.pairs, ['', '']] })}>Add a pair</Button></div>
          <ListField label="Other answers offered, that match nothing (optional)" values={draft.distractors} onChange={distractors => onChange({ ...draft, distractors })} />
        </div>
      )}
      {draft.type === 'fill-in' && <>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="label">The answer</span>
          <input value={draft.answer} onChange={e => onChange({ ...draft, answer: e.target.value })} style={fieldStyle} />
        </label>
        <ListField label="Other answers to accept (optional)" values={draft.accept} onChange={accept => onChange({ ...draft, accept })} />
      </>}
      {draft.type === 'numeric' && (
        <div style={{ display: 'flex', gap: 8 }}>
          {(['answer', 'min', 'max'] as const).map(k => (
            <label key={k} style={{ display: 'grid', gap: 4, flex: 1 }}>
              <span className="label">{k === 'answer' ? 'The answer' : k === 'min' ? 'At least (optional)' : 'At most (optional)'}</span>
              <input inputMode="decimal" value={draft[k]} onChange={e => onChange({ ...draft, [k]: e.target.value })} style={fieldStyle} />
            </label>
          ))}
        </div>
      )}
      {draft.type === 'likert' && (
        <ListField label="The scale, lowest first (empty: disagree to agree, five points)" values={draft.scale} onChange={scale => onChange({ ...draft, scale })} />
      )}
      {explanation}
      {missing && <div style={{ ...small, color: 'var(--warn)' }}>{missing}</div>}
    </fieldset>
  );
}
