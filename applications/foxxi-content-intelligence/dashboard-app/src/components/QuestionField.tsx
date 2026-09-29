/**
 * One question of a step, answered in the form that fits it: options to pick, true or false, items
 * to put in order, prompts to match, words to write. What is put is a draft (learn/answers.ts),
 * made into the reply the bridge grades when the step is sent.
 */
import React from 'react';
import { Pill } from './common.js';
import { letter, matchTo, move, pick, type Draft, type LearnerQuestion } from '../learn/answers.js';

const choiceRow: React.CSSProperties = {
  display: 'flex', gap: 10, alignItems: 'flex-start', padding: '8px 10px', borderRadius: 4,
  border: '1px solid var(--border)', background: 'var(--panel)', cursor: 'pointer', fontSize: 15,
};
const fieldInput: React.CSSProperties = {
  width: '100%', padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 4,
  background: 'var(--panel)', color: 'var(--text)', fontSize: 15,
};

export function QuestionField({ name, q, draft, onChange, disabled, problem, feedback }: {
  /** Unique on the page, so each question's radio buttons are their own group. */
  name: string;
  q: LearnerQuestion;
  draft: Draft;
  onChange: (d: Draft) => void;
  disabled?: boolean;
  /** Why the bridge would not take this reply, when it was sent and refused. */
  problem?: string | null;
  /** How it went, once graded: right, not right, or recorded without a grade. */
  feedback?: { correct: boolean | null; explanation?: string };
}) {
  const input = q.input;
  return (
    <fieldset disabled={disabled} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '12px 14px', margin: '0 0 12px', background: 'var(--panel-2)' }}>
      <legend style={{ padding: '0 6px', fontSize: 16, fontWeight: 600 }}>
        {q.index + 1}. {q.question}
      </legend>
      <div style={{ marginBottom: 8 }}>
        {q.graded ? <Pill>graded</Pill> : <Pill title="What you put is recorded with your record; nothing grades it.">not graded</Pill>}
        {draft.kind === 'pick' && draft.many && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-dim)' }}>Pick every one that applies.</span>}
        {input?.type === 'text' && input.caseSensitive && <span style={{ marginLeft: 8, fontSize: 12, color: 'var(--text-dim)' }}>Letter case counts.</span>}
      </div>

      {draft.kind === 'pick' && (
        <div role={draft.many ? 'group' : 'radiogroup'} style={{ display: 'grid', gap: 6 }}>
          {(input?.options ?? []).map((option, i) => (
            <label key={i} style={choiceRow}>
              <input type={draft.many ? 'checkbox' : 'radio'} name={name} checked={draft.picked.includes(i)} onChange={() => onChange(pick(draft, i))} />
              <span><span className="mono" style={{ color: 'var(--text-dim)', marginRight: 6 }}>{letter(i)}</span>{option}</span>
            </label>
          ))}
        </div>
      )}

      {draft.kind === 'truth' && (
        <div role="radiogroup" style={{ display: 'flex', gap: 8 }}>
          {[true, false].map(value => (
            <label key={String(value)} style={choiceRow}>
              <input type="radio" name={name} checked={draft.value === value} onChange={() => onChange({ ...draft, value })} />
              <span>{value ? 'True' : 'False'}</span>
            </label>
          ))}
        </div>
      )}

      {draft.kind === 'order' && (
        <ol style={{ margin: 0, paddingLeft: 22, display: 'grid', gap: 6 }}>
          {draft.order.map((item, at) => (
            <li key={item} style={{ ...choiceRow, cursor: 'default', display: 'list-item' }}>
              <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', width: '100%' }}>
                <span style={{ flex: 1 }}>{input?.items?.[item]}</span>
                <button type="button" aria-label={`Move "${input?.items?.[item] ?? ''}" up`} disabled={disabled || at === 0} onClick={() => onChange(move(draft, at, at - 1))}>↑</button>
                <button type="button" aria-label={`Move "${input?.items?.[item] ?? ''}" down`} disabled={disabled || at === draft.order.length - 1} onClick={() => onChange(move(draft, at, at + 1))}>↓</button>
              </span>
            </li>
          ))}
        </ol>
      )}

      {draft.kind === 'match' && (
        <div style={{ display: 'grid', gap: 6 }}>
          {(input?.items ?? []).map((prompt, i) => (
            <label key={i} style={{ ...choiceRow, cursor: 'default', alignItems: 'center' }}>
              <span style={{ flex: 1 }}>{prompt}</span>
              <select value={draft.matched[i] ?? ''} onChange={e => onChange(matchTo(draft, i, e.target.value === '' ? null : Number(e.target.value)))}
                style={{ ...fieldInput, width: 'auto', minWidth: 180 }}>
                <option value="">Choose…</option>
                {(input?.targets ?? []).map((target, t) => <option key={t} value={t}>{target}</option>)}
              </select>
            </label>
          ))}
        </div>
      )}

      {draft.kind === 'text' && (draft.long
        ? <textarea value={draft.text} rows={5} maxLength={4000} aria-label={q.question} onChange={e => onChange({ ...draft, text: e.target.value })} style={{ ...fieldInput, fontFamily: 'inherit' }} />
        : <input value={draft.text} maxLength={250} inputMode={draft.numeric ? 'decimal' : 'text'} aria-label={q.question} onChange={e => onChange({ ...draft, text: e.target.value })} style={fieldInput} />)}

      {problem && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13, marginTop: 8 }}>{problem}</div>}
      {feedback && (
        <div style={{ marginTop: 10, padding: '8px 10px', borderRadius: 4, borderLeft: `3px solid ${feedback.correct === true ? 'var(--good)' : feedback.correct === false ? 'var(--bad)' : 'var(--border-strong)'}`, background: 'var(--panel)' }}>
          <strong style={{ color: feedback.correct === true ? 'var(--good)' : feedback.correct === false ? 'var(--bad)' : 'var(--text)' }}>
            {feedback.correct === true ? 'Right.' : feedback.correct === false ? 'Not right.' : 'Recorded.'}
          </strong>
          {feedback.explanation && <span> {feedback.explanation}</span>}
        </div>
      )}
    </fieldset>
  );
}
