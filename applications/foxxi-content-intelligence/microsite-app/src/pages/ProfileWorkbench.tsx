import React, { useEffect, useRef, useState } from 'react';
import { BRIDGE_URL } from '../bridge-client.js';

const SERVER = BRIDGE_URL + '/xapi/profiles';
type JsonObject = Record<string, unknown>;
type Mode = 'statement' | 'sequence';
interface Version {
  id: string;
  version: string;
  current: boolean;
  prefLabel?: Record<string, string>;
}
interface StatementExample { id: string; statement: JsonObject }
interface SequenceExample { id: string; statements: Array<string | JsonObject> }
interface Published {
  document: { concepts?: JsonObject[]; templates?: JsonObject[]; patterns?: JsonObject[] };
  examples: { statements: StatementExample[]; sequences: SequenceExample[] };
}
interface Offer { offeredBy?: string; affordance: string; title?: string }
interface Result {
  status: 'matched' | 'refused' | 'incomplete' | 'unavailable';
  notes: string[];
  offers: Offer[];
}

function record(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function messages(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}
function label(version: Version) {
  return version.prefLabel?.en ?? Object.values(version.prefLabel ?? {})[0] ?? version.id;
}
function profileUrl(path: string, iri: string) {
  return SERVER + path + '?' + new URLSearchParams({ iri });
}
async function read<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, credentials: 'omit', headers: { Accept: 'application/json, application/ld+json' } });
  if (!response.ok) throw new Error('The profile server returned HTTP ' + response.status + '.');
  return await response.json() as T;
}
async function check(path: string, body: JsonObject, signal: AbortSignal) {
  const response = await fetch(SERVER + path, { method: 'POST', credentials: 'omit', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const json: unknown = response.status === 204 ? undefined : await response.json().catch(() => undefined);
  return { status: response.status, json: record(json) ? json : {} };
}

function materialize(example: SequenceExample, statements: StatementExample[]) {
  const byId = new Map(statements.map(item => [item.id, item.statement]));
  const sequence = example.statements.map(item => typeof item === 'string' ? byId.get(item) : item);
  if (sequence.some(item => !item)) throw new Error('This published sequence names an example that is unavailable.');
  return sequence;
}

const statuses: Record<Result['status'], string> = {
  matched: 'Matched the selected version',
  refused: 'The selected version refused the input',
  incomplete: 'The server could only evaluate part of the input',
  unavailable: 'The check could not complete',
};
const panel: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 8, padding: '16px 18px', minWidth: 0, background: 'var(--panel)' };
const button: React.CSSProperties = { padding: '8px 13px', borderRadius: 4, border: '1px solid var(--border)', color: 'var(--text)', background: 'var(--panel)', cursor: 'pointer' };
const monospaced: React.CSSProperties = { fontFamily: "'JetBrains Mono', monospace", overflowWrap: 'anywhere', fontSize: 12 };
const quiet: React.CSSProperties = { fontSize: 14, lineHeight: 1.5, color: 'var(--text-dim)' };

export function ProfileWorkbench() {
  const [versions, setVersions] = useState<Version[]>([]);
  const [version, setVersion] = useState('');
  const [published, setPublished] = useState<Published>();
  const [error, setError] = useState('');
  const [mode, setMode] = useState<Mode>('statement');
  const [exampleId, setExampleId] = useState('');
  const [input, setInput] = useState('');
  const [result, setResult] = useState<Result>();
  const [running, setRunning] = useState(false);
  const activeCheck = useRef<AbortController>();
  const selected = versions.find(item => item.version === version);

  function resetCheck() {
    activeCheck.current?.abort();
    activeCheck.current = undefined;
    setRunning(false);
    setResult(undefined);
  }

  useEffect(() => {
    const request = new AbortController();
    void read<{ profiles: Version[] }>(SERVER, request.signal).then(data => {
      if (request.signal.aborted) return;
      setVersions(data.profiles);
      const deepLink = new URLSearchParams(location.search).get('version');
      setVersion((data.profiles.find(item => item.version === deepLink) ?? data.profiles.find(item => item.current) ?? data.profiles[0])?.version ?? '');
    }).catch((e: Error) => { if (!request.signal.aborted) setError(e.message); });
    return () => request.abort();
  }, []);

  useEffect(() => {
    if (!version) return;
    const request = new AbortController();
    void Promise.all([
      read<Published['document']>(profileUrl('/profile', version), request.signal),
      read<{ examples: Published['examples'] }>(profileUrl('/examples', version), request.signal)
        .then(response => response.examples)
        .catch(() => ({ statements: [], sequences: [] })),
    ]).then(([document, examples]) => {
      if (request.signal.aborted) return;
      setPublished({ document, examples });
      const first = examples.statements[0];
      if (first) { setExampleId(first.id); setInput(JSON.stringify(first.statement, null, 2)); }
    }).catch((e: Error) => { if (!request.signal.aborted) setError(e.message); });
    return () => { request.abort(); activeCheck.current?.abort(); };
  }, [version]);

  function chooseVersion(value: string) {
    if (value === version) return;
    resetCheck();
    setError('');
    setPublished(undefined);
    setMode('statement');
    setExampleId('');
    setInput('');
    setVersion(value);
    const url = new URL(location.href);
    url.searchParams.set('version', value);
    history.replaceState({}, '', url);
  }

  function chooseExample(id: string, kind: Mode) {
    resetCheck();
    setMode(kind);
    setExampleId(id);
    const samples = published?.examples;
    try {
      const named = kind === 'statement' ? samples?.statements.find(item => item.id === id)?.statement
        : samples?.sequences.find(item => item.id === id);
      const value = named && kind === 'sequence' ? materialize(named as SequenceExample, samples!.statements) : named;
      setInput(value ? JSON.stringify(value, null, 2) : '');
    } catch (e) {
      setInput('');
      setResult({ status: 'unavailable', notes: [(e as Error).message], offers: [] });
    }
  }

  async function validate() {
    resetCheck();
    let parsed: unknown;
    try {
      parsed = JSON.parse(input);
      if (mode === 'statement' ? !record(parsed) : !Array.isArray(parsed) || !parsed.every(record)) {
        throw new Error(mode === 'statement' ? 'Enter one statement as a JSON object.' : 'Enter a JSON array of statements.');
      }
    } catch (e) {
      setResult({ status: 'refused', notes: [(e as Error).message], offers: [] });
      return;
    }
    const operation = new AbortController();
    activeCheck.current = operation;
    setRunning(true);
    try {
      const checked = mode === 'statement'
        ? await check('/validate_templates', { profile: version, statement: parsed, report: true }, operation.signal)
        : await check('/validate_patterns', { profile: version, statements: parsed, report: true }, operation.signal);
      const notChecked = messages(checked.json.notChecked);
      const verdict = checked.json.outcome;
      if (checked.status === 204) {
        if (!operation.signal.aborted) setResult({ status: 'incomplete',
          notes: ['The bridge accepted the standard request. This deployment did not return a validation report.'], offers: [] });
        return;
      }
      if (checked.status === 200 && checked.json.profileVersion === version && (verdict === 'matched' || verdict === 'incomplete')) {
        const notes = [...notChecked, ...messages(checked.json.templates).map(template => 'Template: ' + template)];
        if (typeof checked.json.pattern === 'string') notes.push('Pattern: ' + checked.json.pattern);
        let offers: Offer[] = [];
        if (mode === 'statement' && verdict === 'matched') {
          const controls = await check('/controls', { profile: version, statement: parsed }, operation.signal);
          const controlsVersion = controls.json.profileVersion;
          if (controls.status === 200 && controlsVersion === version && Array.isArray(controls.json.controls)) {
            offers = controls.json.controls.flatMap(item => record(item) && typeof item.affordance === 'string'
              ? [{ affordance: item.affordance, offeredBy: typeof item.offeredBy === 'string' ? item.offeredBy : undefined,
                title: typeof item.title === 'string' ? item.title : undefined }] : []);
            if (Array.isArray(controls.json.unresolved) && controls.json.unresolved.length) notes.push('Some profile offers could not be resolved on this bridge.');
          } else notes.push('Follow-up actions could not be resolved.');
        }
        if (!operation.signal.aborted) setResult({ status: verdict, notes, offers });
      } else if (!operation.signal.aborted) {
        const detail = [...messages(checked.json.comments), ...notChecked];
        if (typeof checked.json.error === 'string' && !detail.includes(checked.json.error)) detail.push(checked.json.error);
        setResult({ status: checked.status === 400 ? 'refused' : 'unavailable',
          notes: detail.length ? detail : ['The profile server returned HTTP ' + checked.status + '.'], offers: [] });
      }
    } catch (e) {
      if (!operation.signal.aborted) setResult({ status: 'unavailable', notes: [(e as Error).message], offers: [] });
    } finally {
      if (activeCheck.current === operation) setRunning(false);
    }
  }

  const samples = mode === 'statement' ? published?.examples.statements : published?.examples.sequences;
  return <section style={{ maxWidth: 1120, margin: '0 auto', padding: '28px 24px 52px' }}>
    <h1 style={{ fontFamily: "'EB Garamond', serif", fontSize: 40, margin: '0 0 6px' }}>xAPI Profile Workbench</h1>
    <p style={quiet}>Try a published statement or sequence against the profile version that defines it.</p>
    <label style={{ display: 'grid', gap: 5, maxWidth: 640 }}>
      Profile version
      <select style={{ ...button, maxWidth: '100%' }} value={version} onChange={event => chooseVersion(event.target.value)}>
        {!versions.length && <option value="">No versions loaded</option>}
        {versions.map(item => <option key={item.version} value={item.version}>{label(item)} · {item.version.split('/').slice(-2).join('/')} · {item.current ? 'Current' : 'Historical'}</option>)}
      </select>
    </label>
    {error && <p role="alert">{error}</p>}
    {selected && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 345px), 1fr))', gap: 16, marginTop: 18 }}>
      <section style={panel}>
        <h2 style={{ margin: '0 0 10px' }}>Published rules</h2>
        <p style={monospaced}>{version}</p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
          <a href={profileUrl('/profile', version)}>Profile JSON-LD</a>
          <a href={profileUrl('/examples', version)}>Published examples</a>
          <a href={SERVER}>Server discovery</a>
        </div>
        {published ? ([
          ['Concepts', published.document.concepts ?? []],
          ['Statement templates', published.document.templates ?? []],
          ['Patterns', published.document.patterns ?? []],
        ] as const).map(([title, terms]) => <details key={title} style={{ marginBottom: 10 }}>
          <summary>{title} ({terms.length})</summary>
          <ul>{terms.map((term, index) => <li key={String(term.id ?? index)} style={{ ...monospaced, margin: '8px 0' }}>
            {String(term.id ?? '')}{term.deprecated === true ? ' · Deprecated' : ''}
          </li>)}</ul>
        </details>) : !error && <p role="status">Loading the published version…</p>}
      </section>
      <section style={panel}>
        <h2 style={{ margin: '0 0 10px' }}>Test this version</h2>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
          <label>Check <select style={button} value={mode} onChange={event => {
            const kind = event.target.value as Mode;
            chooseExample('', kind);
          }}><option value="statement">Statement template</option><option value="sequence">Sequence pattern</option></select></label>
          <label>Example <select style={button} value={exampleId} onChange={event => chooseExample(event.target.value, mode)}>
            <option value="">Enter JSON</option>
            {samples?.map(sample => <option key={sample.id} value={sample.id}>{sample.id}</option>)}
          </select></label>
        </div>
        <label style={{ display: 'grid', gap: 5 }}>JSON
          <textarea spellCheck={false} rows={12} value={input} onChange={event => {
            setInput(event.target.value);
            setExampleId('');
            resetCheck();
          }} style={{ ...monospaced, width: '100%', boxSizing: 'border-box', padding: 8, resize: 'vertical', color: 'var(--text)', background: 'var(--bg)', border: '1px solid var(--border)' }} />
        </label>
        <p style={quiet}>Use public or synthetic examples. Checking sends the JSON to the Foxxi bridge.</p>
        <button type="button" style={button} disabled={running || !input.trim()} onClick={() => void validate()}>{running ? 'Checking…' : 'Check against this version'}</button>
        {result && <div aria-live="polite" style={{ marginTop: 16 }}>
          <strong>{statuses[result.status]}</strong>
          {result.notes.length > 0 && <ul>{result.notes.map((note, index) => <li key={index}>{note}</li>)}</ul>}
          {result.offers.length > 0 && <>
            <h3>Actions offered by this profile</h3>
            <ul>{result.offers.map((offer, index) => <li key={offer.affordance + index}>
              {offer.title ?? offer.affordance}{offer.offeredBy && <div style={monospaced}>{offer.offeredBy}</div>}
            </li>)}</ul>
            <p style={quiet}>Each action checks the caller’s permission when invoked.</p>
          </>}
        </div>}
      </section>
    </div>}
  </section>;
}
