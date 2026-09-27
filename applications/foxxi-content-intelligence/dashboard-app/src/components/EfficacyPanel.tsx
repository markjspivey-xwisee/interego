/**
 * What a composition has learned, position by position: how learners at each level did after
 * meeting each alternative, and which one it leans to for them now (GET <composition>/efficacy).
 * For its author, deciding what to keep, revise or add. Unsigned: it names no learner, and a cell
 * too small to be read as one learner's result says only that it is too small.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, Pill } from './common.js';
import { useHypermedia } from '../hypermedia.js';
import { bridgeBaseOf } from '../learn/bridge.js';
import { compositionIriOn } from '../learn/composition-ref.js';
import { competencyLabel } from '../learn/play.js';
import { cellLine, hasOutcomes, leaningLine, type CompositionEfficacy } from '../author/efficacy.js';

type Read = { at: 'loading' } | { at: 'read'; view: CompositionEfficacy } | { at: 'absent' } | { at: 'failed'; why: string };

export function EfficacyPanel() {
  const { hash = '' } = useParams();
  const navigate = useNavigate();
  const { entry, error: entryError } = useHypermedia();
  const base = bridgeBaseOf(entry);
  const [read, setRead] = useState<Read>({ at: 'loading' });

  useEffect(() => {
    if (!base || !/^[0-9a-f]{64}$/.test(hash)) return;
    let cancel = false;
    setRead({ at: 'loading' });
    fetch(`${compositionIriOn(base, hash)}/efficacy`, { headers: { Accept: 'application/json' } })
      .then(async r => {
        if (cancel) return;
        if (r.status === 404) { setRead({ at: 'absent' }); return; }
        const body = await r.json().catch(() => ({})) as CompositionEfficacy & { error?: string };
        if (!r.ok) { setRead({ at: 'failed', why: body.error ?? `HTTP ${r.status}` }); return; }
        setRead({ at: 'read', view: body });
      })
      .catch(e => { if (!cancel) setRead({ at: 'failed', why: (e as Error).message }); });
    return () => { cancel = true; };
  }, [base, hash]);

  const go = (to: string) => (e: React.MouseEvent) => { e.preventDefault(); navigate(to); };
  const links = (
    <span style={{ fontSize: 13 }}>
      <a href={`/learn/${hash}`} onClick={go(`/learn/${hash}`)}>Play it</a>{' · '}<a href="/author" onClick={go('/author')}>← Author</a>
    </span>
  );

  if (!/^[0-9a-f]{64}$/.test(hash)) return <Card title="Not a composition"><div>This link names no composition.</div></Card>;
  if (entryError) return <Card title="The bridge could not be reached"><div style={{ color: 'var(--text-dim)' }}>{entryError}</div></Card>;
  if (read.at === 'loading') return <Card title="What it has learned" right={links}><div style={{ color: 'var(--text-dim)' }}>Reading…</div></Card>;
  if (read.at === 'absent') return <Card title="What it has learned" right={links}><div style={{ color: 'var(--bad)' }}>This bridge holds no composition with this hash.</div></Card>;
  if (read.at === 'failed') return <Card title="What it has learned" right={links}><div role="alert" style={{ color: 'var(--bad)' }}>{read.why}</div></Card>;

  const view = read.view;
  const titles = new Map(view.positions.flatMap(p => p.alternatives.map(a => [a.iri, a.title ?? `${a.kind ?? (a.composition ? 'composition' : 'fragment')} ${a.iri.slice(-8)}`] as const)));
  const nameOf = (iri: string) => titles.get(iri) ?? iri;
  return (
    <div style={{ display: 'grid', gap: 14 }}>
      <Card title={`What “${view.title}” has learned`} right={links}>
        <div style={{ fontSize: 14, color: 'var(--text-dim)' }}>
          A cell is shown once {view.policy.publishAt} learners' outcomes are in it, and counts as established at {view.policy.assertAt}.
          {' '}Its leanings assume {view.leaningAssumes}.
        </div>
        {!hasOutcomes(view) && <div style={{ marginTop: 10 }}>Nothing has been learned here yet: no learner has reached a check after meeting its alternatives.</div>}
      </Card>
      {view.positions.map(p => (
        <Card key={p.position} title={`Position ${p.position + 1}`} right={<Pill title={p.competency}>{competencyLabel(p.competency)}</Pill>}>
          <div style={{ display: 'grid', gap: 8 }}>
            {p.alternatives.map(a => (
              <div key={a.iri} style={{ padding: '8px 10px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel-2)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
                  <strong>{nameOf(a.iri)}</strong>
                  {a.kind && <Pill>{a.kind}</Pill>}
                  {a.composition && <Pill>composition</Pill>}
                </div>
                {a.cells.length === 0
                  ? <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>No outcomes yet.</div>
                  : <ul style={{ margin: 0, fontSize: 13 }}>{a.cells.map(c => <li key={c.level}>{cellLine(c)}</li>)}</ul>}
              </div>
            ))}
            {p.leansTo.length > 0 && (
              <div>
                <div className="label" style={{ margin: '4px 0' }}>What it leans to now</div>
                <ul style={{ margin: 0, fontSize: 14 }}>{p.leansTo.map((l, i) => <li key={i}>{leaningLine(l, nameOf)}</li>)}</ul>
              </div>
            )}
          </div>
        </Card>
      ))}
      <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>An agent reads the same view at <code>{`${compositionIriOn(base, hash)}/efficacy`}</code>.</div>
    </div>
  );
}
