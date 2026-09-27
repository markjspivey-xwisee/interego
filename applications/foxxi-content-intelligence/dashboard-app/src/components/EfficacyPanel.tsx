/**
 * A composition's page, for its author: how it resolves for them, where else it can be taken, and
 * what it has learned.
 *
 * What it has learned, position by position: how learners at each level did after meeting each
 * alternative, and which one it leans to for them now (GET <composition>/efficacy). For its author,
 * deciding what to keep, revise or add. Unsigned: it names no learner, and a cell too small to be
 * read as one learner's result says only that it is too small.
 */
import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button, Card, Pill } from './common.js';
import { useAffordance, useHypermedia } from '../hypermedia.js';
import type { FoxxiSession } from '../auth/session.js';
import { signerAsks, signerFor } from '../auth/signer.js';
import { postSigned } from '../auth/signed-request.js';
import { exportLinks, resolutionLine, stepLine, type ResolutionView } from '../author/resolution.js';
import { bridgeBaseOf } from '../learn/bridge.js';
import { compositionIriOn } from '../learn/composition-ref.js';
import { competencyLabel } from '../learn/play.js';
import { cellLine, hasOutcomes, leaningLine, type CompositionEfficacy } from '../author/efficacy.js';

type Read = { at: 'loading' } | { at: 'read'; view: CompositionEfficacy } | { at: 'absent' } | { at: 'failed'; why: string };

export function EfficacyPanel({ session }: { session: FoxxiSession }) {
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
      <ResolveCard session={session} iri={compositionIriOn(base, hash)} />
      <ExportCard base={base} hash={hash} />
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

/**
 * How it resolves for the author, as a person or as an agent (foxxi.content_resolve): what a launch
 * does first, without starting a play or recording anything.
 */
function ResolveCard({ session, iri }: { session: FoxxiSession; iri: string }) {
  const resolve = useAffordance('foxxi.content_resolve');
  const asks = signerAsks(session);
  const [kind, setKind] = useState<'human' | 'agent'>('human');
  const [result, setResult] = useState<ResolutionView | null>(null);
  const [state, setState] = useState<'idle' | 'resolving' | 'failed'>('idle');
  const [error, setError] = useState('');

  async function run(): Promise<void> {
    if (!resolve) return;
    setState('resolving');
    try { setResult(await postSigned<ResolutionView>(resolve.href, signerFor(session), { composition: iri, learner_kind: kind })); setState('idle'); }
    catch (e) { setError((e as Error).message); setState('failed'); }
  }

  if (!resolve) return null;
  return (
    <Card title="How it resolves for you">
      <div style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 10 }}>
        What you would be shown at each position, from your own record, and why: resolved as a launch resolves it, with no play started and nothing recorded.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10 }}>
        <label style={{ display: 'flex', gap: 6, alignItems: 'center', fontSize: 14 }}>
          as
          <select value={kind} onChange={e => { setKind(e.target.value as 'human' | 'agent'); setResult(null); }} style={{ padding: '4px 8px', border: '1px solid var(--border)', borderRadius: 4, background: 'var(--panel)', color: 'var(--text)' }}>
            <option value="human">a person</option><option value="agent">an agent</option>
          </select>
        </label>
        <Button small primary disabled={state === 'resolving'} onClick={() => { void run(); }}>{state === 'resolving' ? (asks ? 'Approve in your wallet…' : 'Resolving…') : result ? 'Resolve again' : 'Resolve it for me'}</Button>
      </div>
      {state === 'failed' && <div role="alert" style={{ color: 'var(--bad)', fontSize: 13 }}>{error}</div>}
      {result && (
        <div style={{ display: 'grid', gap: 8 }}>
          <div><strong>{resolutionLine(result)}</strong> <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>for {result.learnerKind === 'agent' ? 'an agent' : 'a person'}</span></div>
          <ol style={{ margin: 0, paddingLeft: 22 }}>
            {result.steps.map((s, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                <div>{stepLine(s)} <Pill title={s.competency}>{competencyLabel(s.competency)}</Pill></div>
                <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{s.chosenBecause}</div>
              </li>
            ))}
          </ol>
          {result.skipped.map((n, i) => <div key={`s${i}`} style={{ fontSize: 13 }}>Skipped at {competencyLabel(n.competency)}: {n.because}</div>)}
          {result.unmet.map((n, i) => <div key={`u${i}`} style={{ fontSize: 13, color: 'var(--warn)' }}>Nothing could fill {competencyLabel(n.competency)}: {n.because}</div>)}
          {!!result.missing?.length && <div style={{ fontSize: 13, color: 'var(--warn)' }}>{result.missing.length} of its pieces could not be reached on this bridge.</div>}
          {!!result.admittedBy?.length && <div style={{ fontSize: 13 }}>Limited by what you keep at {result.admittedBy.map(a => competencyLabel(a.competency)).join(', ')}.</div>}
          <details><summary style={{ cursor: 'pointer', fontSize: 13 }}>Every decision, in words</summary>
            <ul style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-dim)' }}>{result.trace.map((t, i) => <li key={i}>{t}</li>)}</ul>
          </details>
        </div>
      )}
    </Card>
  );
}

/** Where it can be taken: the bridge's own cmi5 course structure and SCORM 2004 package for it. */
function ExportCard({ base, hash }: { base: string; hash: string }) {
  const links = exportLinks(base, hash);
  return (
    <Card title="Take it elsewhere">
      <div style={{ fontSize: 14, color: 'var(--text-dim)', marginBottom: 10 }}>
        Any LMS that imports cmi5 or SCORM 2004 can take it as one unit, played by this bridge's player. A learner that LMS names is one this
        bridge cannot verify, so their play resolves as for anyone new to it, and adds nothing to what has worked here; the LMS keeps their record.
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <a href={links.cmi5} download>cmi5 course structure (cmi5.xml)</a>
        <a href={links.scorm} download>SCORM 2004 package (scorm.zip)</a>
      </div>
    </Card>
  );
}
