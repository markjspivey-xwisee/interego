/**
 * Write a fragment: one piece of teaching or support, the unit every composition is built from
 * (foxxi.content_fragment). Its kind says what form it takes, not when to use it: resolution
 * decides that for each learner. Its body is Markdown, which a person reads rendered and an agent
 * reads as it is; the preview here is the engine's own rendering.
 *
 * The fragment is named by its content: the bridge answers with its IRI, which goes on the
 * author's shelf to compose from. An unsent draft is kept in this browser, per identity.
 */
import React, { useEffect, useState } from 'react';
import { Button, Card, Pill } from './common.js';
import { QuestionEditor, fieldStyle } from './QuestionEditor.js';
import { useAffordance } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';
import { signerAsks, signerFor } from '../auth/signer.js';
import { postSigned } from '../auth/signed-request.js';
import { courseMarkdownHtml } from '../../../src/course-markdown.js';
import {
  COGNITIVE_LEVELS, FRAGMENT_KIND_LIST, fragmentPayload, missingFromFragment, moved, newFragment, newQuestion, policyOf,
  type FragmentDraft, type KindName, type Level,
} from '../author/draft.js';
import type { ShelfItem } from '../author/shelf.js';

const draftKey = (identity: string) => `foxxi:fragment-draft:${identity}`;
function readDraft(identity: string): FragmentDraft | null {
  try {
    const d = JSON.parse(localStorage.getItem(draftKey(identity)) ?? 'null') as FragmentDraft | null;
    return d && typeof d === 'object' && typeof d.body === 'string' && Array.isArray(d.questions) ? { ...newFragment(), ...d } : null;
  } catch { return null; }
}

export function FragmentEditor({ session, onAuthored }: { session: FoxxiSession; onAuthored: (item: ShelfItem) => void }) {
  const affordance = useAffordance('foxxi.content_fragment');
  const [draft, setDraft] = useState<FragmentDraft>(() => readDraft(session.webId) ?? newFragment());
  const [preview, setPreview] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<ShelfItem | null>(null);
  const missing = missingFromFragment(draft);
  const policy = policyOf(draft.kind);
  const kind = FRAGMENT_KIND_LIST.find(k => k.kind === draft.kind);

  useEffect(() => {
    try { localStorage.setItem(draftKey(session.webId), JSON.stringify(draft)); } catch { /* a browser that keeps nothing still writes */ }
  }, [draft, session.webId]);

  const set = (patch: Partial<FragmentDraft>) => { setDraft(d => ({ ...d, ...patch })); setError(null); };

  async function send(): Promise<void> {
    if (!affordance) return;
    setSending(true); setError(null);
    try {
      const r = await postSigned<{ '@id': string }>(affordance.href, signerFor(session), { fragment: fragmentPayload(draft) });
      const item: ShelfItem = { iri: r['@id'], type: 'fragment', kind: draft.kind, level: draft.level, at: new Date().toISOString(), ...(draft.title.trim() ? { title: draft.title.trim() } : {}) };
      onAuthored(item);
      setMade(item);
      setDraft(newFragment());
    } catch (e) { setError((e as Error).message); }
    finally { setSending(false); }
  }

  if (!affordance) return <Card title="Write a fragment"><div style={{ color: 'var(--text-dim)' }}>This bridge takes no fragments (no foxxi.content_fragment).</div></Card>;

  return (
    <Card title="Write a fragment">
      {made && (
        <div role="status" style={{ padding: '8px 10px', border: '1px solid var(--good)', borderRadius: 4, marginBottom: 12 }}>
          Made <strong>{made.title ?? `a ${made.kind} fragment`}</strong>, now on your shelf. <code style={{ fontSize: 11, wordBreak: 'break-all' }}>{made.iri}</code>
        </div>
      )}
      <div style={{ display: 'grid', gap: 10 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ display: 'grid', gap: 4, flex: 2, minWidth: 220 }}>
            <span className="label">Its form</span>
            <select value={draft.kind} onChange={e => set({ kind: e.target.value as KindName })} style={fieldStyle}>
              {FRAGMENT_KIND_LIST.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 160 }}>
            <span className="label">Pitched at</span>
            <select value={draft.level} onChange={e => set({ level: e.target.value as Level })} style={fieldStyle}>
              {COGNITIVE_LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
            </select>
          </label>
        </div>
        {kind && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{kind.definition}{policy === 'required' ? ' It needs at least one graded question.' : policy === 'ungraded-only' ? ' Its questions are recorded, never graded.' : ''}</div>}
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="label">Competencies it develops, one per line: a slug such as refund-authority, or an IRI</span>
          <textarea rows={2} value={draft.competencies} onChange={e => set({ competencies: e.target.value })} style={fieldStyle} />
        </label>
        <label style={{ display: 'grid', gap: 4 }}>
          <span className="label">Title (optional)</span>
          <input value={draft.title} onChange={e => set({ title: e.target.value })} style={fieldStyle} />
        </label>
        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="label" style={{ flex: 1 }}>Body, in Markdown</span>
            <Button small onClick={() => setPreview(p => !p)}>{preview ? 'Edit' : 'Preview'}</Button>
          </div>
          {preview
            ? <div className="fx-prose" style={{ border: '1px solid var(--border)', borderRadius: 4, padding: '8px 12px', minHeight: 120 }} dangerouslySetInnerHTML={{ __html: courseMarkdownHtml(draft.body) }} />
            : <textarea rows={10} value={draft.body} onChange={e => set({ body: e.target.value })} style={{ ...fieldStyle, fontFamily: "'JetBrains Mono', Consolas, monospace", fontSize: 13 }} />}
        </div>
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>Who it is for, what it suits, its language</summary>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 8 }}>
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 160 }}>
              <span className="label">For</span>
              <select value={draft.audience} onChange={e => set({ audience: e.target.value as FragmentDraft['audience'] })} style={fieldStyle}>
                <option value="">anyone</option><option value="human">people only</option><option value="agent">agents only</option>
              </select>
            </label>
            <label style={{ display: 'grid', gap: 4, flex: 2, minWidth: 200 }}>
              <span className="label">Suits (tags, comma-separated)</span>
              <input value={draft.suits} onChange={e => set({ suits: e.target.value })} style={fieldStyle} />
            </label>
            <label style={{ display: 'grid', gap: 4, flex: 1, minWidth: 120 }}>
              <span className="label">Language (e.g. en, pt-BR)</span>
              <input value={draft.language} onChange={e => set({ language: e.target.value })} style={fieldStyle} />
            </label>
          </div>
        </details>

        <div>
          <div className="label" style={{ marginBottom: 6 }}>Questions {policy === 'optional' ? '(optional)' : ''}</div>
          {draft.questions.map((q, i) => (
            <QuestionEditor key={i} index={i} count={draft.questions.length} draft={q}
              onChange={d => set({ questions: draft.questions.map((x, k) => (k === i ? d : x)) })}
              onRemove={() => set({ questions: draft.questions.filter((_, k) => k !== i) })}
              onMove={to => set({ questions: moved(draft.questions, i, to) })} />
          ))}
          <Button small onClick={() => set({ questions: [...draft.questions, newQuestion(policy === 'ungraded-only' ? 'likert' : 'choice')] })}>Add a question</Button>
        </div>

        {missing.length > 0 && <ul style={{ margin: 0, color: 'var(--warn)', fontSize: 13 }}>{missing.map((m, i) => <li key={i}>{m}</li>)}</ul>}
        {error && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <Button primary disabled={sending || missing.length > 0} onClick={() => { void send(); }}>{sending ? (signerAsks(session) ? 'Approve in your wallet…' : 'Sending…') : 'Make this fragment'}</Button>
          <Pill>{draft.kind}</Pill><Pill>{draft.level}</Pill>
          <span style={{ flex: 1 }} />
          <Button small onClick={() => { setDraft(newFragment()); setMade(null); }}>Start over</Button>
        </div>
      </div>
    </Card>
  );
}
