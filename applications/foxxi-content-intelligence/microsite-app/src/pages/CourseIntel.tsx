/**
 * Course Intelligence — parse a SCORM package, fingerprint WHICH authoring tool
 * produced it, compose it into a PGSL knowledge-graph (the authoritative source of
 * truth), then chat with agents about it:
 *   - the course reasons self-recursively ABOUT itself from its own graph;
 *   - the enrolled agent converses with the AUTHORING agent about the content;
 *   - the enrolled agent converses with the PERFORMANCE MANAGER / ASSESSOR about
 *     the content in the context of performance;
 *   - the human asks too.
 *
 * Composition: the upload is unzipped in-browser (fflate); analysis + grounding run
 * on the bridge via /agent/course/analyze + /agent/course/ask (which compose the
 * existing parseManifest + fingerprint + composeIntoSharedLattice + askAgenticRag).
 * The self-recursive step routes the interrogatives over the course holon via the
 * existing /agent/lattice/:label/interrogate. BYOK key stays in your browser.
 */
import React, { useState } from 'react';
import { unzipSync, strFromU8 } from 'fflate';
import { bridgeRest, BRIDGE_URL } from '../bridge-client.js';
import { GOLF_SAMPLE } from '../data/golf-sample.generated.js';
import { getDemoState } from '../demo/demo-session.js';

/** The course Agent A authored in the most recent Agents demo run (read from the
 *  shared demo-session store) — so Course IQ can analyze it, not just the sample. */
function lastAuthoredCourse(): { courseId: string; authorDid?: string; title?: string } | null {
  try {
    const st = getDemoState();
    const ev = [...st.events].reverse().find(e => e.kind === 'scorm' && (e.data as any)?.courseId && /author/i.test(e.title));
    if (!ev) return null;
    const d = ev.data as any;
    return { courseId: String(d.courseId), authorDid: d.authoredBy ?? st.agents?.A?.did, title: d.title };
  } catch { return null; }
}

const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16, boxShadow: 'var(--shadow)' };
const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
const pill: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '5px 13px', fontSize: 12, cursor: 'pointer', background: 'transparent' };
const btn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '9px 18px', borderRadius: 6, fontFamily: mono, fontSize: 12, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };

interface Fingerprint {
  tool: string; toolId: string; vendor: string; confidence: number; version?: string;
  standard: { standard: string; standardId: string; schema?: string; schemaversion?: string };
  candidates: Array<{ toolId: string; tool: string; score: number; confidence: number; signals: Array<{ signal: string; weight: number; source: string }> }>;
  signals: Array<{ signal: string; points: string; weight: number; source: string }>;
  summary: string;
}
interface CourseKg { label: string; holonUri?: string; descriptorUrl?: string; agentDid: string; reusedNodes?: number; newNodes?: number; stats?: { atoms?: number; fragments?: number } }
interface AgenticCourse { courseId: string; title: string; concepts: Array<{ id: string; label: string }>; slides: Array<{ id: string; title: string }>; }
interface Analysis { fingerprint: Fingerprint; structure: { courseId: string; courseTitle: string; activityCount: number; topics: string[]; fileCount: number; items: Array<{ id: string; title: string }> }; course: AgenticCourse; courseKg: CourseKg }

type Role = 'meta' | 'author' | 'performance-manager' | 'assessor' | 'learner';
const ROLES: Array<{ id: Role; label: string; blurb: string }> = [
  { id: 'author', label: 'Authoring agent', blurb: 'Ask the agent that authored the course why the content is structured as it is.' },
  { id: 'performance-manager', label: 'Performance manager', blurb: 'Discuss the learner’s activity in the context of this course.' },
  { id: 'assessor', label: 'Assessor / evaluator', blurb: 'Relate demonstrated performance to the course’s claimed outcomes.' },
  { id: 'learner', label: 'Ask as the learner', blurb: 'You (or the enrolled agent) ask about the content directly.' },
];
const DEFAULT_ACTIVITY = 'Completed the Etiquette and Playing topics; scored 60% on the Handicapping assessment; spent little time on Scoring.';

interface Turn { who: 'you' | 'agent'; role: Role; text: string; cited?: string[]; grounded?: boolean; fallback?: boolean; keyless?: boolean }

export function CourseIntel({ onHome }: { onHome: () => void }) {
  const [manifestXml, setManifestXml] = useState('');
  const [fileList, setFileList] = useState<string[]>([]);
  const [fileText, setFileText] = useState<Record<string, string>>({});
  const [sourceNote, setSourceNote] = useState('');
  const [analyzing, setAnalyzing] = useState(false);
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const [apiKey, setApiKey] = useState('');
  const [role, setRole] = useState<Role>('author');
  const [question, setQuestion] = useState('');
  const [activity, setActivity] = useState(DEFAULT_ACTIVITY);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [asking, setAsking] = useState(false);

  const [meta, setMeta] = useState<{ answers?: any[]; selfDescription?: string; cited?: string[]; keyless?: boolean } | null>(null);
  const [metaBusy, setMetaBusy] = useState(false);
  const authored = lastAuthoredCourse(); // re-read each render (cheap) so it appears after an Agents run

  // course ↔ skills.md round-trip
  const [showIngest, setShowIngest] = useState(false);
  const [skillInput, setSkillInput] = useState('');
  const [emittedSkill, setEmittedSkill] = useState<string | null>(null);
  const [emitBusy, setEmitBusy] = useState(false);

  async function ingestSkill() {
    if (!skillInput.trim() || analyzing) return;
    setAnalyzing(true); setErr(null); setAnalysis(null); setMeta(null); setTurns([]); setEmittedSkill(null);
    setSourceNote('Ingested an agent skill (skills.md)');
    const { status, json } = await bridgeRest('/agent/course/analyze-skill', { skillMd: skillInput });
    setAnalyzing(false);
    if (status !== 200 || json.ok === false) { setErr(String(json.error ?? `HTTP ${status}`)); return; }
    setManifestXml(''); setShowIngest(false); setAnalysis(json as unknown as Analysis);
  }

  async function emitSkill() {
    if (!analysis || emitBusy) return;
    setEmitBusy(true); setEmittedSkill(null);
    const { json } = await bridgeRest('/agent/course/skill', { course: analysis.course, tool: analysis.fingerprint.tool, holonUri: analysis.courseKg.holonUri });
    setEmitBusy(false);
    if (json.ok) setEmittedSkill(String(json.skillMd)); else setErr(String(json.error ?? 'skill emit failed'));
  }

  function downloadSkill() {
    if (!emittedSkill) return;
    const blob = new Blob([emittedSkill], { type: 'text/markdown' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
    a.download = `${analysis?.course.courseId || 'skill'}.SKILL.md`; a.click(); URL.revokeObjectURL(a.href);
  }

  async function analyzeAuthored() {
    if (!authored || analyzing) return;
    setAnalyzing(true); setErr(null); setAnalysis(null); setMeta(null); setTurns([]);
    setSourceNote(`Agent-authored: ${authored.title ?? authored.courseId} (from your Agents run)`);
    const { status, json } = await bridgeRest('/agent/course/analyze-authored', { courseId: authored.courseId, author_did: authored.authorDid });
    setAnalyzing(false);
    if (status !== 200 || json.ok === false) { setErr(String(json.error ?? `HTTP ${status}`)); return; }
    setManifestXml('');
    setAnalysis(json as unknown as Analysis);
  }

  function loadSample() {
    setManifestXml(GOLF_SAMPLE.manifestXml);
    setFileText(GOLF_SAMPLE.fileText as Record<string, string>);
    setFileList(Object.keys(GOLF_SAMPLE.fileText));
    setSourceNote('Sample: Rustici “Golf Explained” (SCORM 2004) — real manifest + real page text.');
    setAnalysis(null); setMeta(null); setTurns([]); setErr(null);
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) return;
    setErr(null); setAnalysis(null); setMeta(null); setTurns([]);
    try {
      const buf = new Uint8Array(await f.arrayBuffer());
      const entries = unzipSync(buf);
      const paths = Object.keys(entries);
      const manKey = paths.find(p => /(^|\/)imsmanifest\.xml$/i.test(p))
        ?? paths.find(p => /(^|\/)(cmi5|tincan)\.xml$/i.test(p));
      if (!manKey) throw new Error('no imsmanifest.xml / cmi5.xml / tincan.xml found in the package');
      const base = manKey.includes('/') ? manKey.slice(0, manKey.lastIndexOf('/') + 1) : '';
      const rel = (p: string) => (base && p.startsWith(base) ? p.slice(base.length) : p);
      const man = strFromU8(entries[manKey]);
      const list: string[] = [];
      const text: Record<string, string> = {};
      let textBudget = 220_000; // cap extracted text to keep the request sane
      for (const p of paths) {
        if (p.endsWith('/')) continue;
        const r = rel(p);
        list.push(r);
        if (/\.html?$/i.test(p) && !/(shared|common|lib)\//i.test(r) && textBudget > 0) {
          try {
            const t = strFromU8(entries[p]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
            if (t.length > 40) { const slice = t.slice(0, 1200); text[r] = slice; textBudget -= slice.length; }
          } catch { /* skip */ }
        }
      }
      setManifestXml(man); setFileList(list); setFileText(text);
      setSourceNote(`Uploaded ${f.name} — ${list.length} files, ${Object.keys(text).length} pages of text extracted in your browser.`);
    } catch (e) {
      setErr(`unzip/parse failed: ${(e as Error).message}`);
    }
  }

  async function analyze() {
    if (!manifestXml) { setErr('Load the sample or upload a package first.'); return; }
    setAnalyzing(true); setErr(null); setAnalysis(null); setMeta(null); setTurns([]);
    const { status, json } = await bridgeRest('/agent/course/analyze', { manifestXml, fileList, fileText });
    setAnalyzing(false);
    if (status !== 200 || json.ok === false) { setErr(String(json.error ?? `HTTP ${status}`)); return; }
    setAnalysis(json as unknown as Analysis);
  }

  async function runMeta() {
    if (!analysis) return;
    setMetaBusy(true);
    const out: { answers?: any[]; selfDescription?: string; cited?: string[]; keyless?: boolean } = {};
    // 1) interrogatives over the course holon (the course reasoning about ITSELF)
    const kg = analysis.courseKg;
    if (kg.holonUri) {
      try {
        const url = `${BRIDGE_URL}/agent/lattice/${kg.label}/interrogate?uri=${encodeURIComponent(kg.holonUri)}&agent_did=${encodeURIComponent(kg.agentDid)}`;
        const r = await fetch(url); const j = await r.json();
        if (j.ok && Array.isArray(j.answers)) out.answers = j.answers;
      } catch { /* ignore */ }
    }
    // 2) a grounded self-description from the course's own graph
    const { json } = await bridgeRest('/agent/course/ask', {
      course: analysis.course, role: 'meta',
      question: 'What is this course, what does it teach, and how is it structured? Answer strictly from your own knowledge-graph.',
      ...(apiKey.trim() ? { llm_api_key: apiKey.trim() } : {}),
    });
    out.selfDescription = String((json.synthesizedAnswer as string) ?? '') || undefined;
    out.keyless = !apiKey.trim();
    out.cited = ((json.retrieval as any)?.citedSlides ?? []).map((s: any) => s.slideTitle);
    setMeta(out); setMetaBusy(false);
  }

  async function ask() {
    if (!analysis || !question.trim() || asking) return;
    const q = question.trim();
    setTurns(t => [...t, { who: 'you', role, text: q }]);
    setQuestion(''); setAsking(true);
    const body: Record<string, unknown> = { course: analysis.course, question: q, role };
    if (role === 'performance-manager' || role === 'assessor') body.learnerActivity = activity;
    if (apiKey.trim()) body.llm_api_key = apiKey.trim();
    const { json } = await bridgeRest('/agent/course/ask', body);
    setAsking(false);
    const cited = ((json.retrieval as any)?.citedSlides ?? []).map((s: any) => `${s.slideTitle}`);
    const answer = String((json.synthesizedAnswer as string) ?? '') || scaffoldFrom(json);
    const grounded = !!json.grounded; // honest: true only on a real graph hit (bridge gates on retrievalKind)
    setTurns(t => [...t, { who: 'agent', role, text: answer, cited, grounded, fallback: !grounded && cited.length > 0, keyless: !apiKey.trim() }]);
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>Course intelligence</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 800, lineHeight: 1.5 }}>
        Drop in a SCORM package. Foxxi tells you <strong>which authoring tool produced it</strong>, composes the course
        into a <strong>PGSL knowledge-graph</strong> (the authoritative source of truth), and then lets agents reason about it:
        the course reasons about <em>itself</em> from its own graph, the enrolled agent talks to the authoring agent, and to
        the performance manager / assessor about the content in the context of performance. Answers are grounded in the
        course graph — and honestly flagged when a question falls outside it. <strong>Bring your own Anthropic key</strong> for synthesis (used only in your browser) — or go key-less and get the cited scaffold.
      </p>

      {/* BYOK — at the top so you know up front what's optional; only the chat
          synthesis uses it. Without a key you get the honest cited scaffold. */}
      <div style={{ ...card, marginTop: 18 }}>
        <div style={lbl}>Anthropic key (optional — only the chat synthesis uses it; key never sent to our servers, runs in your browser)</div>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-… (optional — leave blank for the cited retrieval scaffold)"
          autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
          style={{ width: '100%', marginTop: 5, padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13, boxSizing: 'border-box' }} />
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-dim)' }}>Without a key you get the honest cited retrieval scaffold (the course-graph nodes that answer the question); with a key the agent synthesizes a grounded answer over them.</div>
      </div>

      {/* Source */}
      <div style={{ ...card, marginTop: 18 }}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <button onClick={loadSample} style={pill}>Try the sample (Golf Explained)</button>
          {authored && <button onClick={analyzeAuthored} disabled={analyzing} style={{ ...pill, borderColor: 'var(--accent)', color: 'var(--accent)' }}>
            Analyze the agent-authored course ▸
          </button>}
          <label style={{ ...pill, display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            Upload SCORM .zip
            <input type="file" accept=".zip,.scorm" onChange={onUpload} style={{ display: 'none' }} />
          </label>
          <button onClick={() => setShowIngest(s => !s)} style={pill}>Ingest a skills.md</button>
          <button onClick={analyze} disabled={!manifestXml || analyzing} style={{ ...btn, opacity: !manifestXml || analyzing ? 0.5 : 1 }}>
            {analyzing ? 'Analyzing…' : 'Analyze package'}
          </button>
          {sourceNote && <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{sourceNote}</span>}
        </div>
        {showIngest && (
          <div style={{ marginTop: 10 }}>
            <div style={lbl}>paste an agent skill (SKILL.md — frontmatter + ## sections) to ingest it as a course</div>
            <textarea value={skillInput} onChange={e => setSkillInput(e.target.value)} rows={6}
              placeholder={'---\nname: extend-a-standard\ndescription: How to extend a standard.\n---\n## Discover guidance\n...'}
              style={{ width: '100%', marginTop: 5, padding: 9, borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 12 }} />
            <button onClick={ingestSkill} disabled={!skillInput.trim() || analyzing} style={{ ...btn, marginTop: 6, opacity: !skillInput.trim() || analyzing ? 0.5 : 1 }}>
              {analyzing ? 'Ingesting…' : 'Ingest as course ▸'}
            </button>
          </div>
        )}
        <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim)' }}>
          The .zip is unzipped <strong>in your browser</strong>; we send the manifest + file list + extracted page text to the bridge to fingerprint + build the graph.
        </div>
      </div>

      {err && <div style={{ ...card, borderLeft: '3px solid var(--bad, #c1432a)', marginTop: 14, fontFamily: mono, fontSize: 12 }}>⚠ {err}</div>}

      {analysis && (
        <>
          {/* Fingerprint + KG */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 16 }}>
            <FingerprintCard fp={analysis.fingerprint} />
            <KgCard kg={analysis.courseKg} structure={analysis.structure} course={analysis.course} />
          </div>

          {/* Round-trip: project this course as an agent skill (skills.md) */}
          <div style={{ ...card, marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>Project as an agent skill</div>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>the same capability, distilled into a <code style={codeS}>skills.md</code> an agent can load — provenance points back to this course holon</span>
              <button onClick={emitSkill} disabled={emitBusy} style={{ ...pill, marginLeft: 'auto', borderColor: 'var(--accent)', color: 'var(--accent)', opacity: emitBusy ? 0.5 : 1 }}>
                {emitBusy ? 'projecting…' : 'Emit skills.md'}
              </button>
            </div>
            {emittedSkill && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
                  <button onClick={() => navigator.clipboard?.writeText(emittedSkill)} style={pill}>Copy</button>
                  <button onClick={downloadSkill} style={pill}>Download .SKILL.md</button>
                </div>
                <pre style={{ fontSize: 11, lineHeight: 1.5, background: '#0f1115', color: '#cdd6e0', padding: 12, borderRadius: 6, overflow: 'auto', maxHeight: 360, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{emittedSkill}</pre>
              </div>
            )}
          </div>

          {/* Self-recursive meta */}
          <div style={{ ...card, marginTop: 14 }}>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>The course reasons about itself</div>
              <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>self-recursive / meta — using the course knowledge-graph as ground truth</span>
              <button onClick={runMeta} disabled={metaBusy} style={{ ...pill, marginLeft: 'auto', borderColor: 'var(--accent)', color: 'var(--accent)', opacity: metaBusy ? 0.5 : 1 }}>
                {metaBusy ? 'reasoning…' : 'Reflect on the course'}
              </button>
            </div>
            {meta && (
              <div style={{ marginTop: 10 }}>
                {meta.answers && meta.answers.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))', gap: 8, marginBottom: 10 }}>
                    {meta.answers.filter((a: any) => ['Who', 'What', 'When', 'WhatKind', 'Whether'].includes(a.interrogative)).map((a: any) => (
                      <div key={a.interrogative} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px' }}>
                        <div style={{ fontSize: 12, fontWeight: 600 }}>{a.interrogative} <span style={{ fontFamily: mono, fontSize: 9.5, color: 'var(--text-dim)' }}>· {a.status}</span></div>
                        <div style={{ fontFamily: mono, fontSize: 10.5, color: 'var(--text)', wordBreak: 'break-word', marginTop: 2 }}>
                          {a.values ? Object.entries(a.values).map(([k, v]) => <div key={k}><span style={{ color: 'var(--text-dim)' }}>{k}:</span> {fmt(v)}</div>) : (a.nextStep ? `→ ${a.nextStep.tool}` : '—')}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {meta.selfDescription
                  ? <div style={{ fontSize: 14, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{meta.selfDescription}</div>
                  : <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>{meta.keyless ? 'Key-less: the course retrieved its own grounding (cited below). Add a key for a synthesized self-description.' : 'No synthesis returned.'}</div>}
                {meta.cited && meta.cited.length > 0 && <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-dim)' }}>grounded in: {meta.cited.slice(0, 6).join(' · ')}</div>}
              </div>
            )}
          </div>

          {/* The Living Curriculum — the course proposes its own successor */}
          <LivingCurriculum analysis={analysis} />

          {/* Conversations */}
          <div style={{ ...card, marginTop: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>Talk about the course</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
              {ROLES.map(r => (
                <button key={r.id} onClick={() => setRole(r.id)} style={{ ...pill, background: role === r.id ? 'var(--accent)' : 'transparent', color: role === r.id ? 'var(--panel)' : 'var(--text)', borderColor: role === r.id ? 'var(--accent)' : 'var(--border)' }}>{r.label}</button>
              ))}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-dim)', marginBottom: 8 }}>{ROLES.find(r => r.id === role)?.blurb}</div>
            {(role === 'performance-manager' || role === 'assessor') && (
              <div style={{ marginBottom: 8 }}>
                <div style={lbl}>learner activity (editable — the performance context)</div>
                <textarea value={activity} onChange={e => setActivity(e.target.value)} rows={2}
                  style={{ width: '100%', padding: 8, borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 12 }} />
              </div>
            )}
            <div style={{ minHeight: 60, marginBottom: 8 }}>
              {turns.length === 0 && <div style={{ fontSize: 13, color: 'var(--text-dim)' }}>Ask something like “Why does Handicapping come before Scoring?” or “Given my activity, what should I review?”</div>}
              {turns.map((t, i) => (
                <div key={i} style={{ margin: '8px 0', padding: '8px 11px', borderRadius: 8, background: t.who === 'you' ? '#eef2ff' : 'var(--panel-2, #faf9f7)', border: '1px solid var(--border)' }}>
                  <div style={{ ...lbl, marginBottom: 3 }}>{t.who === 'you' ? 'you' : ROLES.find(r => r.id === t.role)?.label ?? t.role}{t.who === 'agent' && t.keyless ? ' · key-less scaffold' : ''}</div>
                  <div style={{ fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{t.text}</div>
                  {t.who === 'agent' && t.cited && t.cited.length > 0 && <div style={{ marginTop: 5, fontSize: 11, color: t.fallback ? '#b45309' : 'var(--text-dim)' }}>{t.grounded ? '✓ grounded · ' : (t.fallback ? '⚠ no concept matched — course intro shown as fallback · ' : '')}cited: {t.cited.slice(0, 6).join(' · ')}</div>}
                </div>
              ))}
              {asking && <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>thinking…</div>}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={question} onChange={e => setQuestion(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') ask(); }}
                placeholder="ask the course…" style={{ flex: 1, padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13 }} />
              <button onClick={ask} disabled={asking || !question.trim()} style={{ ...btn, opacity: asking || !question.trim() ? 0.5 : 1 }}>Ask</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── The Living Curriculum: the course runs each concept through the work-regime
// engine and proposes a versioned successor (iep:supersedes). The performance
// signals are illustrative + editable (the performance CONTEXT) — the reasoning
// and the successor holon are real. Refuses the universal content-gap frame.
interface ConceptSignal { id: string; label: string; completion: number | null; fieldSuccess: number | null; frequency: string }
const REC_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  keep: { bg: 'rgba(46,160,67,0.12)', fg: '#2e9c4a', label: 'keep' },
  'revise-instruction': { bg: 'rgba(217,119,6,0.14)', fg: '#b45309', label: 'revise instruction' },
  'demote-add-job-aid': { bg: 'rgba(124,58,237,0.12)', fg: '#7c3aed', label: 'demote · add job aid' },
  'instrument-first': { bg: 'rgba(37,99,235,0.12)', fg: '#2563eb', label: 'instrument first' },
};
function LivingCurriculum({ analysis }: { analysis: Analysis }) {
  // Seed an illustrative-but-story-telling signal set: a high-completion/low-field
  // concept (looks like a content gap, isn't), a genuinely weak one, and unmeasured ones.
  const [signals, setSignals] = useState<ConceptSignal[]>(() => analysis.course.concepts.slice(0, 8).map((c, i) => ({
    id: c.id, label: c.label,
    completion: i === 0 ? 0.91 : i === 1 ? 0.40 : i === 2 ? 0.88 : null,
    fieldSuccess: i === 0 ? 0.44 : i === 1 ? 0.40 : i === 2 ? 0.83 : null,
    // i===1 is a continuously-performed skill gap → the engine warrants instruction;
    // i===0 (high completion, low field) → a job aid, not a content rewrite.
    frequency: i === 1 ? 'continuous' : 'occasional',
  })));
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function propose() {
    setBusy(true); setErr(null); setRes(null);
    const concept_signals = signals.filter(s => s.completion != null || s.fieldSuccess != null)
      .map(s => ({ id: s.id, label: s.label, completion: s.completion ?? undefined, fieldSuccess: s.fieldSuccess ?? undefined, frequency: s.frequency }));
    const { status, json } = await bridgeRest('/agent/course/propose-successor', {
      course: analysis.course, holonUri: analysis.courseKg.holonUri, label: analysis.courseKg.label, concept_signals,
    });
    setBusy(false);
    if (status !== 200 || json.ok === false) { setErr(String(json.error ?? `HTTP ${status}`)); return; }
    setRes(json);
  }
  function setSig(id: string, key: 'completion' | 'fieldSuccess', v: string) {
    const n = v.trim() === '' ? null : Math.max(0, Math.min(1, Number(v)));
    setSignals(s => s.map(x => x.id === id ? { ...x, [key]: Number.isNaN(n as number) ? null : n } : x));
  }

  return (
    <div style={{ ...card, marginTop: 14 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>The living curriculum — the course proposes its own successor</div>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>each concept routed through the work-regime engine; emits a <code style={codeS}>iep:supersedes</code> successor holon</span>
        <button onClick={propose} disabled={busy} style={{ ...pill, marginLeft: 'auto', borderColor: 'var(--accent)', color: 'var(--accent)', opacity: busy ? 0.5 : 1 }}>
          {busy ? 'reasoning…' : 'Propose a successor'}
        </button>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.5, margin: '6px 0 8px' }}>
        Set each concept&rsquo;s <strong>completion</strong> vs <strong>field success</strong> (the performance context — illustrative
        until wired to your LRS). The engine <strong>refuses the reflexive &ldquo;content gap&rdquo;</strong>: a concept completed at 0.91
        but succeeding in the field at 0.44 is an environment / incentive cause, not a lesson to rewrite. Blank = no signal → the
        engine refuses to claim a regime and says <em>instrument first</em>.
      </p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px,1fr))', gap: 8, marginBottom: 8 }}>
        {signals.map(s => (
          <div key={s.id} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px' }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.label}</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <label style={{ fontSize: 10.5, color: 'var(--text-dim)', flex: 1 }}>compl.
                <input value={s.completion ?? ''} onChange={e => setSig(s.id, 'completion', e.target.value)} placeholder="—" style={miniInp} /></label>
              <label style={{ fontSize: 10.5, color: 'var(--text-dim)', flex: 1 }}>field
                <input value={s.fieldSuccess ?? ''} onChange={e => setSig(s.id, 'fieldSuccess', e.target.value)} placeholder="—" style={miniInp} /></label>
            </div>
          </div>
        ))}
      </div>
      {err && <div style={{ fontFamily: mono, fontSize: 12, color: '#c1432a' }}>⚠ {err}</div>}
      {res && (
        <div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '4px 0 10px' }}>
            {Object.entries(res.summary ?? {}).map(([k, v]) => (
              <span key={k} style={{ ...pill, cursor: 'default', background: (REC_STYLE[k === 'keep' ? 'keep' : k === 'revise' ? 'revise-instruction' : k === 'jobaid' ? 'demote-add-job-aid' : 'instrument-first']?.bg), fontSize: 11 }}>
                {String(v)} {k}
              </span>
            ))}
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {(res.concepts ?? []).map((p: any, i: number) => {
              const st = REC_STYLE[p.recommendation] ?? REC_STYLE['instrument-first'];
              return (
                <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '9px 11px', borderLeft: `4px solid ${st.fg}` }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                    <strong style={{ fontSize: 13 }}>{p.concept.label}</strong>
                    <span style={{ fontFamily: mono, fontSize: 9.5, padding: '1px 7px', borderRadius: 3, background: st.bg, color: st.fg }}>{st.label}</span>
                    {p.regime && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>regime: <strong>{p.regime}</strong></span>}
                    {p.cause && <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>· cause: {p.cause}</span>}
                    {p.signal && <span style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 10, color: 'var(--text-dim)' }}>compl {p.signal.completion} / field {p.signal.fieldSuccess}</span>}
                  </div>
                  <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5, marginTop: 4 }}>{p.rationale}</div>
                </div>
              );
            })}
          </div>
          {res.successor?.holonUri && (
            <div style={{ marginTop: 10, padding: '9px 11px', background: '#faf9f7', border: '1px solid var(--accent)', borderRadius: 6, fontSize: 12.5 }}>
              ↳ emitted a <strong>iep:supersedes successor holon</strong> <code style={codeS}>{String(res.successor.holonUri).slice(0, 40)}…</code>
              {res.successor.descriptorUrl && <> · <a href={res.successor.descriptorUrl} target="_blank" rel="noreferrer" style={linkBtn}>dereference it ↗</a></>}
              {analysis.courseKg.descriptorUrl && <> · <a href={analysis.courseKg.descriptorUrl} target="_blank" rel="noreferrer" style={linkBtn}>the original ↗</a></>}
              <div style={{ color: 'var(--text-dim)', marginTop: 3 }}>a first-class, dereferenceable, versioned revision composed into the PGSL lattice — not a doc diff.</div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
const miniInp: React.CSSProperties = { width: '100%', padding: '4px 6px', borderRadius: 4, border: '1px solid var(--border)', fontFamily: mono, fontSize: 11, boxSizing: 'border-box', marginTop: 2 };

function FingerprintCard({ fp }: { fp: Fingerprint }) {
  const detected = fp.toolId !== 'hand-authored';
  const pct = Math.round(fp.confidence * 100);
  return (
    <div style={card}>
      <div style={lbl}>authoring tool</div>
      <div style={{ fontFamily: serif, fontSize: 24, margin: '2px 0 2px', color: detected ? 'var(--text)' : '#b45309' }}>
        {fp.tool}{fp.version ? ` ${fp.version}` : ''}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{detected ? `${fp.vendor} · ${pct}% confidence` : 'no tool signature present'} · {fp.standard.standard}</div>
      {detected && (
        <div style={{ height: 6, background: 'var(--border)', borderRadius: 3, margin: '8px 0', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: 'var(--accent)' }} />
        </div>
      )}
      <div style={{ fontSize: 12.5, color: 'var(--text)', lineHeight: 1.5, margin: '6px 0' }}>{fp.summary}</div>
      {fp.signals.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={lbl}>signals that fired</div>
          {fp.signals.slice(0, 8).map((s, i) => (
            <div key={i} style={{ fontFamily: mono, fontSize: 10.5, color: 'var(--text-dim)', lineHeight: 1.5 }}>
              · {s.signal} <span style={{ opacity: 0.7 }}>({s.source}, w{s.weight})</span>
            </div>
          ))}
        </div>
      )}
      {fp.candidates.length > 1 && (
        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-dim)' }}>
          other candidates: {fp.candidates.slice(1, 4).map(c => `${c.tool} ${Math.round(c.confidence * 100)}%`).join(' · ')}
        </div>
      )}
    </div>
  );
}

function KgCard({ kg, structure, course }: { kg: CourseKg; structure: Analysis['structure']; course: AgenticCourse }) {
  return (
    <div style={card}>
      <div style={lbl}>course knowledge-graph (authoritative source of truth)</div>
      <div style={{ fontFamily: serif, fontSize: 22, margin: '2px 0 4px' }}>{structure.courseTitle}</div>
      <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>
        {course.concepts.length} concepts · {course.slides.length} slides · {structure.fileCount} files · {structure.activityCount} activities
        {kg.stats ? <> · lattice <span style={codeS}>{kg.stats.atoms} atoms / {kg.stats.fragments} fragments</span></> : null}
      </div>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', margin: '8px 0' }}>
        {course.concepts.slice(0, 12).map(c => <span key={c.id} style={{ ...pill, cursor: 'default', padding: '3px 9px', fontSize: 11 }}>{c.label}</span>)}
      </div>
      {kg.holonUri
        ? <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>
            holon <span style={codeS}>{kg.holonUri.slice(0, 40)}…</span>
            {kg.descriptorUrl && <> · <a href={kg.descriptorUrl} target="_blank" rel="noreferrer" style={linkBtn}>descriptor on the pod ↗</a></>}
          </div>
        : <div style={{ fontSize: 11, color: 'var(--text-dim)' }}>(KG composed in-memory; holon persistence requires the tenant pod)</div>}
    </div>
  );
}

function fmt(v: unknown): string {
  if (v == null) return '—';
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length > 60 ? s.slice(0, 60) + '…' : s;
}
/** Build a readable scaffold from a key-less retrieval result (cited slide excerpts). */
function scaffoldFrom(json: Record<string, unknown>): string {
  const cs = ((json.retrieval as any)?.citedSlides ?? []) as Array<{ slideTitle: string; transcriptCombined: string }>;
  if (cs.length === 0) return 'No course content matched that question (the course graph has no grounding for it).';
  return 'From the course knowledge-graph (synthesize from these cited excerpts):\n\n' +
    cs.slice(0, 4).map(s => `• ${s.slideTitle}\n  ${(s.transcriptCombined || '').slice(0, 240)}`).join('\n\n');
}
