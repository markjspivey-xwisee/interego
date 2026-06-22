/**
 * Convergence — Interego and the W3C: Context Graphs, Holons, DataBooks.
 *
 * For each of the three contemporaneous W3C efforts, demonstrate the LIVE Interego
 * primitive that corresponds to it — all on the renamed Interego Protocol (iep:):
 *   - Holons (W3C Holon CG): a real holon is an iep:ContextDescriptor — a WHOLE
 *     that is also a PART of a content-addressed hypergraph holarchy.
 *   - DataBooks (Cagle): a Markdown DataBook ingests into a holon + round-trips to
 *     a SKILL.md (markdown-carrier-of-semantics). BYOK: an LLM authors one.
 *   - Context Graphs (Itelman CG): interrogating a holon yields per-interrogative
 *     resolution state + safe-stop — the gap is emergent, not declared.
 * Honest crosswalks + deltas throughout. Real signed calls; key (optional) stays
 * in this tab.
 */
import React, { useState } from 'react';
import {
  mintHolon, dereferenceDescriptor, interrogateHolon, ingestDataBook, emitSkill,
  authorDataBook, fetchProtocolExcerpt, skillToAffordance, runTwoAgentConvergence,
  SAMPLE_DATABOOK, SAMPLE_SKILL_MD, PAGES_NS,
  type MintedHolon, type InterrogativeAnswer, type DataBookIngest, type SkillAffordance,
  type MAEvent, type TwoAgentResult,
} from '../demo/convergence.js';
import { BRIDGE_URL } from '../bridge-client.js';

const mono = "'JetBrains Mono', monospace";
const serif = "'EB Garamond', serif";
const card: React.CSSProperties = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, padding: 16 };
const lbl: React.CSSProperties = { fontFamily: mono, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.07em', color: 'var(--text-dim)' };
const codeS: React.CSSProperties = { fontFamily: mono, fontSize: 12, background: '#f3f3f1', padding: '1px 5px', borderRadius: 3 };
const btn: React.CSSProperties = { background: 'var(--accent)', color: 'var(--panel)', border: 'none', padding: '10px 18px', borderRadius: 6, fontFamily: mono, fontSize: 12.5, letterSpacing: '0.04em', textTransform: 'uppercase', cursor: 'pointer' };
const pill: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 999, padding: '5px 12px', fontSize: 12, cursor: 'pointer', background: 'transparent' };
const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', color: 'var(--accent)', cursor: 'pointer', padding: 0, fontSize: 13 };
const codeBox: React.CSSProperties = { fontSize: 10.5, lineHeight: 1.45, background: '#0f1115', color: '#cdd6e0', padding: 10, borderRadius: 5, overflow: 'auto', maxHeight: 280, margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' };

function Crosswalk({ rows }: { rows: Array<[string, string]> }) {
  return (
    <div style={{ marginTop: 10 }}>
      <div style={lbl}>crosswalk</div>
      <div style={{ border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden', marginTop: 4 }}>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 18px 1fr', gap: 6, padding: '6px 10px', borderBottom: i < rows.length - 1 ? '1px solid #f0f0ee' : 'none', fontSize: 12, alignItems: 'center' }}>
            <span style={{ color: 'var(--text-dim)' }}>{r[0]}</span>
            <span style={{ color: 'var(--accent)', textAlign: 'center' }}>⇄</span>
            <span><strong>{r[1]}</strong></span>
          </div>
        ))}
      </div>
    </div>
  );
}
function Delta({ children }: { children: React.ReactNode }) {
  return <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-dim)', lineHeight: 1.5, borderLeft: '3px solid #b45309', paddingLeft: 8 }}><strong style={{ color: '#b45309' }}>Honest delta —</strong> {children}</div>;
}

export function Convergence({ onHome }: { onHome: () => void }) {
  const [apiKey, setApiKey] = useState('');
  return (
    <div style={{ maxWidth: 1040, margin: '0 auto', padding: '28px 24px 80px' }}>
      <button onClick={onHome} style={linkBtn}>← home</button>
      <h1 style={{ fontFamily: serif, fontSize: 34, margin: '10px 0 6px' }}>Interego &amp; the W3C: Context Graphs, Holons, DataBooks</h1>
      <p style={{ color: 'var(--text-dim)', fontSize: 16, maxWidth: 840, lineHeight: 1.5 }}>
        Two contemporaneous W3C <strong>Community Groups</strong> — the <strong>Holon</strong> CG (Kurt Cagle) and the
        <strong> Context Graphs</strong> CG (proposed by Ron Itelman) — plus Cagle’s <strong>DataBook</strong> spec (a Holon-CG
        deliverable, currently on his Substack) explore ideas Interego independently arrived at and runs as a live substrate.
        These are <strong>independent, near-contemporaneous</strong> lines of work — no precedence is claimed in either
        direction (the W3C Context Graphs CG was proposed before this repo’s first commit; see the provenance note). The first
        three panels map a concept to the <strong>live Interego primitive</strong> that corresponds to it, on the renamed
        <strong> Interego Protocol</strong> (<code style={codeS}>iep:</code>, formerly <code style={codeS}>cg:</code>); a fourth
        runs the strict <code style={codeS}>SKILL.md ⇄ iep:Affordance</code> translator the DataBook panel references. The
        fifth is the point of all of it: <strong>two real LLM agents</strong> reasoning over the live substrate — sharing one
        holarchy, surfacing the gap between them in their own words, and teaching each other (transfer verified, not asserted).
        Real signed calls to <code style={codeS}>{BRIDGE_URL.replace(/^https?:\/\//, '')}</code>. Panels 1–4 run <strong>key-less</strong>
        (deterministic protocol operations); the LLM-driven steps — authoring a DataBook (panel 2) and the two-agent panel
        (panel 5) — need your <strong>Anthropic key</strong> (it stays in this tab). See <a href="https://markjspivey-xwisee.github.io/interego/NAME-PROVENANCE.md" target="_blank" rel="noreferrer" style={linkBtn}>the name-provenance note</a> for the honest lineage.
      </p>

      <div style={{ ...card, marginTop: 18 }}>
        <div style={lbl}>Anthropic key — required for the LLM-driven steps (panel 2 “✨ Author a DataBook” + panel 5 “two real LLM agents”); sent only to api.anthropic.com from this tab. Panels 1, 3, 4 run with no key.</div>
        <input type="password" value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder="sk-ant-… (needed for the two-agent panel + DataBook authoring; panels 1/3/4 run key-less)"
          autoComplete="off" spellCheck={false} data-1p-ignore data-lpignore="true"
          style={{ width: '100%', marginTop: 5, padding: '9px 11px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 13, boxSizing: 'border-box' }} />
      </div>

      <HolonPanel />
      <DataBookPanel apiKey={apiKey} />
      <ContextGapPanel />
      <AffordancePanel />
      <MultiAgentPanel apiKey={apiKey} />

      <p style={{ fontSize: 11.5, color: 'var(--text-dim)', marginTop: 16, lineHeight: 1.5 }}>
        Sources: <a href="https://github.com/w3c-cg/holon/blob/main/README.md" target="_blank" rel="noreferrer" style={linkBtn}>W3C Holon CG</a> ·
        {' '}<a href="https://ontologist.substack.com/p/databooks-markdown-as-semantic-infrastructure" target="_blank" rel="noreferrer" style={linkBtn}>DataBooks</a> ·
        {' '}<a href="https://www.w3.org/community/context-graph/2026/02/24/call-for-participation-in-context-graphs-community-group/" target="_blank" rel="noreferrer" style={linkBtn}>W3C Context Graphs CG</a> ·
        {' '}<a href={`${PAGES_NS}/iep.ttl`} target="_blank" rel="noreferrer" style={linkBtn}>iep: ontology</a>
      </p>
    </div>
  );
}

// ── Panel 1: Holons ────────────────────────────────────────────────────────
function HolonPanel() {
  const [h, setH] = useState<MintedHolon | null>(null);
  const [ttl, setTtl] = useState<string | null>(null);
  const [proto, setProto] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true); setErr(null); setTtl(null);
    try {
      const minted = await mintHolon('A holon, minted live for the convergence demo');
      setH(minted);
      if (!proto) setProto(await fetchProtocolExcerpt());
      if (minted.descriptorUrl) { const d = await dereferenceDescriptor(minted.descriptorUrl); if (d.ok) setTtl(d.turtle ?? null); }
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  const levels = h?.stats?.levels ?? {};
  const maxCount = Math.max(1, ...Object.values(levels).map(Number));

  return (
    <div style={{ ...card, marginTop: 18 }}>
      <div style={{ fontFamily: serif, fontSize: 22 }}>1 · Holons <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>— W3C Holon CG ⇄ iep: holons + hypergraph holarchy</span></div>
      <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, margin: '6px 0' }}>
        The W3C Holon CG models every node as a <em>holon</em> (Koestler: a whole that is also a part of a holarchy),
        grounded in RDF&nbsp;1.2 + SHACL. In Interego, <strong>every descriptor is already a holon</strong>:
        an <code style={codeS}>iep:ContextDescriptor</code> (a whole) whose terms are <strong>shared, content-addressed atoms</strong>
        in the PGSL lattice — so it is simultaneously a part of a larger <strong>hypergraph</strong> holarchy (not just a tree).
      </p>
      <button onClick={run} disabled={busy} style={{ ...btn, opacity: busy ? 0.5 : 1 }}>{busy ? 'minting…' : 'Mint a holon (live, no key)'}</button>
      {err && <div style={{ color: '#c1432a', fontFamily: mono, fontSize: 12, marginTop: 8 }}>⚠ {err}</div>}
      {h && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12.5 }}><strong>the whole:</strong> <code style={{ ...codeS, fontSize: 11 }}>{h.holonUri}</code></div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 8 }}>
            <div>
              <div style={lbl}>the holarchy — lattice levels (whole ▸ parts ▸ parts…)</div>
              <div style={{ marginTop: 6 }}>
                {Object.keys(levels).sort((a, b) => Number(a) - Number(b)).map(k => (
                  <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '2px 0', fontSize: 11, fontFamily: mono }}>
                    <span style={{ width: 48, color: 'var(--text-dim)' }}>L{k}</span>
                    <div style={{ height: 12, width: `${(Number(levels[k]) / maxCount) * 100}%`, minWidth: 8, background: 'var(--accent)', borderRadius: 2 }} />
                    <span style={{ color: 'var(--text-dim)' }}>{levels[k]}</span>
                  </div>
                ))}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 4 }}>
                {h.stats?.atoms} atoms / {h.stats?.fragments} fragments · maxLevel {h.stats?.maxLevel} · <strong>{h.reusedNodes}</strong> atom(s) shared with a sibling holon in this lattice (the hypergraph — one atom in many wholes) + {h.newNodes} new
                {h.siblingHolonUri && <> · sibling <code style={{ ...codeS, fontSize: 10 }}>{String(h.siblingHolonUri).slice(0, 28)}…</code></>}
              </div>
            </div>
            <div>
              <div style={lbl}>the protocol it conforms to (iep:, post-rename)</div>
              {proto ? <pre style={{ ...codeBox, maxHeight: 150, marginTop: 4 }}>{proto}</pre> : <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>—</div>}
            </div>
          </div>
          {ttl
            ? <div style={{ marginTop: 8 }}><div style={lbl}>dereferenced descriptor (the whole, as iep: Turtle)</div><pre style={{ ...codeBox, marginTop: 4 }}>{ttl.split('\n').slice(0, 22).join('\n')}</pre></div>
            : h.descriptorUrl ? <div style={{ marginTop: 6, fontSize: 12 }}>↳ <a href={h.descriptorUrl} target="_blank" rel="noreferrer" style={linkBtn}>dereference the descriptor ↗</a> (iep: Turtle on the pod)</div> : null}
        </div>
      )}
      <Crosswalk rows={[
        ['holon:Holon (whole + part)', 'iep:Holon (an iep:ContextDescriptor is a kind of holon)'],
        ['holarchy (nested tree)', 'content-addressed hypergraph (one atom shared by many wholes)'],
        ['holon:boundary SHACL shape', 'iep: SHACL boundary + composition operators'],
        ['RDF 1.2 / TriG / SHACL grounding', 'same — plus dereferenceable HATEOAS'],
      ]} />
      <Delta>Interego generalizes the holarchy from a <em>tree</em> to a <em>hypergraph</em> (atoms are reused across wholes) and ships a bounded-lattice composition algebra; the W3C Holon CG has multi-vendor standards governance + a community-owned namespace that a single project cannot self-generate.</Delta>
    </div>
  );
}

// ── Panel 2: DataBooks ─────────────────────────────────────────────────────
function DataBookPanel({ apiKey }: { apiKey: string }) {
  const [md, setMd] = useState(SAMPLE_DATABOOK);
  const [ing, setIng] = useState<DataBookIngest | null>(null);
  const [skill, setSkill] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'author' | 'ingest' | 'emit'>('');
  const [err, setErr] = useState<string | null>(null);
  const [desc, setDesc] = useState('How an agent verifies a peer’s competency before trusting it.');

  async function author() {
    if (!apiKey.trim()) { setErr('add an Anthropic key at the top of the page to author with an LLM (or edit the sample directly)'); return; }
    setBusy('author'); setErr(null);
    const r = await authorDataBook(apiKey.trim(), desc.trim());
    setBusy('');
    if (r.ok && r.markdown) { setMd(r.markdown); setIng(null); setSkill(null); } else setErr(r.error ?? 'author failed');
  }
  async function ingest() {
    setBusy('ingest'); setErr(null); setSkill(null);
    const r = await ingestDataBook(md); setBusy('');
    if (r.ok) setIng(r); else setErr(r.error ?? 'ingest failed');
  }
  async function emit() {
    if (!ing?.course) return;
    setBusy('emit'); setErr(null);
    const r = await emitSkill(ing.course, ing.holonUri); setBusy('');
    if (r.ok) setSkill(r.skillMd ?? ''); else setErr(r.error ?? 'emit failed');
  }

  return (
    <div style={{ ...card, marginTop: 14 }}>
      <div style={{ fontFamily: serif, fontSize: 22 }}>2 · DataBooks <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>— Cagle’s DataBook ⇄ a Markdown capability ingested as a holon</span></div>
      <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, margin: '6px 0' }}>
        A DataBook is Markdown + YAML frontmatter + fenced Turtle/SHACL — a self-describing knowledge artifact. The same
        move — <strong>Markdown as a carrier of machine semantics</strong> — runs live here: a DataBook-shaped Markdown is
        <strong> ingested into the lattice as a holon</strong> (a <code style={codeS}>foxxi:CourseKnowledgeGraph</code> you can
        interrogate, chat with, and credential) and round-tripped back to a distilled <code style={codeS}>SKILL.md</code>.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
        <input value={desc} onChange={e => setDesc(e.target.value)} placeholder="describe a capability…" style={{ flex: '1 1 300px', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 12 }} />
        <button onClick={author} disabled={busy === 'author'} style={{ ...pill, borderColor: 'var(--accent)', color: 'var(--accent)' }}>{busy === 'author' ? 'authoring…' : '✨ Author a DataBook (BYOK)'}</button>
      </div>
      <textarea value={md} onChange={e => setMd(e.target.value)} rows={9} style={{ width: '100%', padding: 9, borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 11.5, boxSizing: 'border-box' }} />
      <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
        <button onClick={ingest} disabled={busy === 'ingest' || !md.trim()} style={{ ...btn, opacity: busy === 'ingest' ? 0.5 : 1 }}>{busy === 'ingest' ? 'ingesting…' : 'Ingest as a holon (no key)'}</button>
        {ing?.ok && <button onClick={emit} disabled={busy === 'emit'} style={{ ...pill, borderColor: 'var(--accent)', color: 'var(--accent)' }}>{busy === 'emit' ? 'emitting…' : 'Round-trip → emit SKILL.md'}</button>}
      </div>
      {err && <div style={{ color: '#c1432a', fontFamily: mono, fontSize: 12, marginTop: 8 }}>⚠ {err}</div>}
      {ing?.ok && (ing.holonUri
        ? <div style={{ marginTop: 8, fontSize: 12.5 }}>✓ ingested into a holon <code style={{ ...codeS, fontSize: 11 }}>{ing.holonUri.slice(0, 40)}{ing.holonUri.length > 40 ? '…' : ''}</code> · {ing.concepts} concept(s){ing.descriptorUrl && <> · <a href={ing.descriptorUrl} target="_blank" rel="noreferrer" style={linkBtn}>descriptor ↗</a></>}</div>
        : <div style={{ marginTop: 8, fontSize: 12.5, color: '#b45309' }}>✓ parsed into a course-KG ({ing.concepts} concept(s)) — holon persistence requires the tenant pod (not configured on this read)</div>)}
      {skill && <div style={{ marginTop: 8 }}><div style={lbl}>round-tripped SKILL.md (markdown-carrier-of-semantics)</div><pre style={{ ...codeBox, marginTop: 4, maxHeight: 200 }}>{skill}</pre></div>}
      <Crosswalk rows={[
        ['DataBook (md + frontmatter + fenced turtle)', 'Markdown capability → foxxi:CourseKnowledgeGraph holon'],
        ['frontmatter (name/description)', 'holon metadata + course id'],
        ['fenced turtle / shacl blocks', 'carried verbatim in the holon’s section content (not parsed to atoms on this path)'],
        ['a DataBook is a holon', 'the ingested artifact is an iep: holon in the lattice'],
      ]} />
      <Delta>Two honest caveats. (1) This panel uses Foxxi’s <em>course</em> bridge (a richer, interrogable holon) — the strict <code style={codeS}>SKILL.md → iep:Affordance</code> descriptor translator (typed <code style={codeS}>iep:Affordance</code> + <code style={codeS}>hydra:Operation</code> + <code style={codeS}>dcat:Distribution</code>) lives in <code style={codeS}>@interego/skills</code> and is not what this live call invokes — <strong>panel 4 below runs that strict translator directly</strong>. (2) A DataBook <em>executes its embedded logic inline</em> (a CLI runs the fenced SPARQL); Interego deliberately does <strong>not</strong> — it references content-addressed reducers + kernel verbs <em>by</em> the descriptor, so every step is replayable. The carrier idea is shared; the execution locus differs.</Delta>
    </div>
  );
}

// ── Panel 3: Context gaps ──────────────────────────────────────────────────
const STATUS_STYLE: Record<string, { bg: string; fg: string; what: string }> = {
  full: { bg: 'rgba(46,160,67,0.14)', fg: '#2e9c4a', what: 'resolved' },
  partial: { bg: 'rgba(217,119,6,0.14)', fg: '#b45309', what: 'partial' },
  pointer: { bg: 'rgba(37,99,235,0.14)', fg: '#2563eb', what: 'resolvable via the lattice' },
  absent: { bg: 'rgba(107,114,128,0.14)', fg: '#6b7280', what: 'facet absent on this descriptor' },
};
function ContextGapPanel() {
  const [answers, setAnswers] = useState<InterrogativeAnswer[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true); setErr(null); setAnswers(null);
    try {
      const h = await mintHolon('A holon to interrogate for context gaps');
      if (!h.holonUri) { setErr('no holon to interrogate'); return; }
      const r = await interrogateHolon(h.label, h.holonUri, h.did);
      if (r.error) setErr(r.error); else setAnswers(r.answers);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  }
  const gaps = (answers ?? []).filter(a => a.status === 'absent');
  const resolved = (answers ?? []).filter(a => a.status === 'full' || a.status === 'partial');
  const viaLattice = (answers ?? []).filter(a => a.status === 'pointer');

  return (
    <div style={{ ...card, marginTop: 14 }}>
      <div style={{ fontFamily: serif, fontSize: 22 }}>3 · Context gaps <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>— W3C Context Graphs CG ⇄ usage-based semiotic reconciliation</span></div>
      <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, margin: '6px 0' }}>
        The W3C Context Graphs CG is <em>developing a model</em> for the context gap — a resolution state + safe-stopping
        when context is missing. In Interego the resolution state is <strong>emergent, not declared</strong>: interrogating a
        holon routes the eleven canonical interrogatives over its real bytes and returns a per-interrogative status. An
        <code style={codeS}>absent</code> answer means the answering facet is not on this descriptor — the honest
        <strong> precondition</strong> a safe-stop keys on. Interego ships abstain/escalate as runtime-eval outcomes, but the
        gap-detection predicate that would <em>trigger</em> them from interrogation is not yet wired (see the provenance note §6).
        What the router never does is fabricate an answer it cannot ground.
      </p>
      <button onClick={run} disabled={busy} style={{ ...btn, opacity: busy ? 0.5 : 1 }}>{busy ? 'interrogating…' : 'Interrogate a holon (live, no key)'}</button>
      {err && <div style={{ color: '#c1432a', fontFamily: mono, fontSize: 12, marginTop: 8 }}>⚠ {err}</div>}
      {answers && answers.length === 0 && <div style={{ marginTop: 10, fontSize: 12.5, color: '#b45309' }}>The interrogation returned no answers — the holon may have been evicted from the resident lattice. Mint + interrogate again.</div>}
      {answers && answers.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12.5, marginBottom: 6 }}><strong>{resolved.length}</strong> resolved · <strong>{viaLattice.length}</strong> resolvable via the lattice · <strong>{gaps.length}</strong> absent (answering facet not on this descriptor) — the router reports state honestly and never fabricates</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px,1fr))', gap: 8 }}>
            {answers.map(a => {
              const st = STATUS_STYLE[a.status] ?? STATUS_STYLE.absent;
              return (
                <div key={a.interrogative} style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '7px 9px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <strong style={{ fontSize: 13 }}>{a.interrogative}</strong>
                    <span style={{ marginLeft: 'auto', fontFamily: mono, fontSize: 9, padding: '1px 6px', borderRadius: 3, background: st.bg, color: st.fg }}>{st.what}</span>
                  </div>
                  {a.values && Object.keys(a.values).length > 0 && <div style={{ fontFamily: mono, fontSize: 10, color: 'var(--text)', marginTop: 3, wordBreak: 'break-word' }}>{Object.entries(a.values).slice(0, 2).map(([k, v]) => <div key={k}><span style={{ color: 'var(--text-dim)' }}>{k}:</span> {String(v).slice(0, 44)}</div>)}</div>}
                  {a.caveat && <div style={{ fontSize: 10.5, color: 'var(--text-dim)', marginTop: 3, lineHeight: 1.4 }}>↳ {a.caveat.slice(0, 90)}</div>}
                </div>
              );
            })}
          </div>
        </div>
      )}
      <Crosswalk rows={[
        ['context gap (missing prerequisite)', 'an absent interrogative (answering facet not on the descriptor)'],
        ['resolution state', 'per-interrogative status: full / partial / pointer / absent'],
        ['safe stopping', 'abstain / escalate exist as runtime-eval outcomes (the gap→trigger is not yet wired)'],
        ['mismatch-category vocabulary', 'emergent usage pattern (not a declared taxonomy)'],
      ]} />
      <Delta>The CG names + is standardizing the problem; Interego treats it implicitly via usage-based semiotics — meaning is use, so categories of mismatch <em>crystallize from usage</em> rather than being authored up front. The piece Interego does <strong>not</strong> yet ship is the gap-detection predicate that would turn an absent interrogative into an abstain/escalate; it can carry the CG’s artifacts once defined, and would conform to a published CG vocabulary.</Delta>
    </div>
  );
}

// ── Panel 4: the strict SKILL.md ⇄ iep:Affordance translator ────────────────
// True-to-label companion to panel 2: this runs the CORE @interego/skills bridge
// (skillBundleToDescriptor / descriptorGraphToSkillMd) live — the genuine
// agentskills.io ⇄ iep:Affordance translator, not the course KG.
function AffordancePanel() {
  const [md, setMd] = useState(SAMPLE_SKILL_MD);
  const [res, setRes] = useState<SkillAffordance | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function run() {
    setBusy(true); setErr(null); setRes(null);
    const r = await skillToAffordance(md);
    setBusy(false);
    if (r.ok) setRes(r); else setErr(r.error ?? 'translate failed');
  }

  const g = res?.graphContent ?? '';
  // Honest type-detection straight from the returned graph (no fabrication). The
  // graph serializes FULL IRIs in angle brackets (not prefixes), so match the IRI
  // suffixes the @interego/skills bridge actually emits: iep:→/ns/iep#,
  // ieh:→/ns/harness#, hydra:→/ns/hydra/core#, dcat:→/ns/dcat#.
  const types: Array<[string, boolean]> = [
    ['iep:Affordance', /iep#Affordance|\biep:Affordance\b/.test(g)],
    ['ieh:Affordance', /harness#Affordance|\bieh:Affordance\b/.test(g)],
    ['hydra:Operation', /hydra\/core#Operation|\bhydra:Operation\b/.test(g)],
    ['dcat:Distribution', /dcat#Distribution|\bdcat:Distribution\b/.test(g)],
  ];
  const roundTripped = !!res?.roundTripMd && res.roundTripMd.trim().startsWith('---');

  return (
    <div style={{ ...card, marginTop: 14 }}>
      <div style={{ fontFamily: serif, fontSize: 22 }}>4 · SKILL.md ⇄ iep:Affordance <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>— the strict <code style={codeS}>@interego/skills</code> translator (the genuine article)</span></div>
      <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, margin: '6px 0' }}>
        Panel 2 honestly disclaims that ingesting a DataBook uses the <em>course</em> bridge, not the strict
        translator. <strong>This panel runs the strict one</strong>: the core <code style={codeS}>@interego/skills</code> bridge
        (<code style={codeS}>skillBundleToDescriptor</code> / <code style={codeS}>descriptorGraphToSkillMd</code>) translates an
        agentskills.io <code style={codeS}>SKILL.md</code> into a real <code style={codeS}>iep:Affordance</code> ContextDescriptor
        graph — typed <code style={codeS}>iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution</code> — and
        round-trips it back to a SKILL.md. Pure translation: no pod write, no signing (the authoring DID rides in PROV
        provenance only).
      </p>
      <textarea value={md} onChange={e => setMd(e.target.value)} rows={9} spellCheck={false}
        style={{ width: '100%', padding: 9, borderRadius: 6, border: '1px solid var(--border)', fontFamily: mono, fontSize: 11.5, boxSizing: 'border-box' }} />
      <div style={{ marginTop: 8 }}>
        <button onClick={run} disabled={busy || !md.trim()} style={{ ...btn, opacity: busy || !md.trim() ? 0.5 : 1 }}>{busy ? 'translating…' : 'Translate → iep:Affordance (live, no key)'}</button>
      </div>
      {err && <div style={{ color: '#c1432a', fontFamily: mono, fontSize: 12, marginTop: 8 }}>⚠ {err}</div>}
      {res && (
        <div style={{ marginTop: 12 }}>
          <div style={{ fontSize: 12.5 }}><strong>skill IRI:</strong> <code style={{ ...codeS, fontSize: 11 }}>{res.skillIri}</code></div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            {types.map(([t, ok]) => (
              <span key={t} style={{ fontFamily: mono, fontSize: 10.5, padding: '3px 8px', borderRadius: 999, background: ok ? 'rgba(46,160,67,0.14)' : 'rgba(193,67,42,0.12)', color: ok ? '#2e9c4a' : '#c1432a' }}>{ok ? '✓' : '✗'} a {t}</span>
            ))}
            <span style={{ fontFamily: mono, fontSize: 10.5, padding: '3px 8px', borderRadius: 999, background: roundTripped ? 'rgba(46,160,67,0.14)' : 'rgba(217,119,6,0.14)', color: roundTripped ? '#2e9c4a' : '#b45309' }}>{roundTripped ? '✓ round-trips to SKILL.md' : '○ round-trip pending'}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginTop: 10 }}>
            <div>
              <div style={lbl}>the iep:Affordance descriptor graph (Turtle)</div>
              <pre style={{ ...codeBox, marginTop: 4 }}>{g.split('\n').slice(0, 30).join('\n')}</pre>
            </div>
            <div>
              <div style={lbl}>round-tripped back to SKILL.md</div>
              {res.roundTripMd
                ? <pre style={{ ...codeBox, marginTop: 4 }}>{res.roundTripMd}</pre>
                : <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>—</div>}
            </div>
          </div>
        </div>
      )}
      <Crosswalk rows={[
        ['agentskills.io SKILL.md', 'iep:Affordance ContextDescriptor (typed iep/ieh:Affordance + hydra:Operation + dcat:Distribution)'],
        ['frontmatter (name / description / license)', 'descriptor metadata + provenance (dct:license, prov:wasAttributedTo)'],
        ['the SKILL.md body', 'a content-addressed atom referenced by the descriptor'],
        ['SKILL.md is the portable form', 'descriptor → SKILL.md round-trip is lossless for the core fields'],
      ]} />
      <Delta>This is the strict translator the DataBook panel says it is not. Scope of this one-shot: it translates a single <code style={codeS}>SKILL.md</code> (no bundled side-files) and is pure — it does not sign or persist the descriptor (those are separate kernel verbs) and does not invoke the skill. The round-trip is lossless for the core fields; rich embedded SHACL or multi-file bundles are out of scope on this call.</Delta>
    </div>
  );
}

// ── Panel 5: the whole point — two REAL LLM agents over the live substrate ────
// Two Claude agents (each a self-sovereign wallet) reason with the Foxxi bridge as
// their tools: A shares context → B interrogates it + names the gap in its OWN
// words → A teaches B (bridge-verified transfer). Requires an Anthropic key.
const A_COL = '#2563eb', B_COL = '#9333ea';
function MultiAgentPanel({ apiKey }: { apiKey: string }) {
  const [events, setEvents] = useState<MAEvent[]>([]);
  const [result, setResult] = useState<TwoAgentResult | null>(null);
  const [running, setRunning] = useState(false);
  const hasKey = apiKey.trim().length > 0;

  async function run() {
    if (!hasKey || running) return;
    setRunning(true); setEvents([]); setResult(null);
    try {
      const collected: MAEvent[] = [];
      const r = await runTwoAgentConvergence(apiKey, e => { collected.push(e); setEvents([...collected]); });
      setResult(r);
    } catch (e) { setEvents(ev => [...ev, { agent: 'sys', kind: 'error', text: (e as Error).message }]); }
    finally { setRunning(false); }
  }
  const pct = (n?: number) => n == null ? '—' : `${Math.round(n * 100)}%`;
  const who = (a: MAEvent['agent']) => a === 'A' ? { c: A_COL, n: 'Agent A' } : a === 'B' ? { c: B_COL, n: 'Agent B' } : { c: 'var(--text-dim)', n: 'system' };

  return (
    <div style={{ ...card, marginTop: 14, borderLeft: '3px solid var(--accent)' }}>
      <div style={{ fontFamily: serif, fontSize: 22 }}>5 · Two real LLM agents, one shared context <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>— the whole point: agents working</span></div>
      <p style={{ fontSize: 13, color: 'var(--text)', lineHeight: 1.5, margin: '6px 0' }}>
        Panels 1–4 are deterministic protocol operations. This one is the point: <strong>two genuine Claude agents</strong> (A and B,
        each a self-sovereign wallet minted in this tab) reason over the live substrate, with the Foxxi bridge endpoints as their
        <strong> tools</strong>. The model decides every call. (1) <span style={{ color: A_COL }}>A</span> records work to establish
        shared context; (2) <span style={{ color: B_COL }}>B</span> joins the same context and <strong>interrogates A’s holon</strong>,
        then names the <strong>gap</strong> between them <em>in its own words</em>; (3) <span style={{ color: A_COL }}>A</span>
        <strong> teaches B</strong> the missing capability — and the bridge <strong>verifies</strong> the transfer, it isn’t asserted.
      </p>
      <button onClick={run} disabled={!hasKey || running} style={{ ...btn, opacity: !hasKey || running ? 0.5 : 1 }}>
        {running ? 'two agents working…' : 'Run the two agents (needs your key)'}
      </button>
      {!hasKey && <span style={{ marginLeft: 10, fontSize: 12, color: '#b45309' }}>add your Anthropic key at the top — this panel runs two real LLM agents.</span>}

      {events.length > 0 && (
        <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 6, maxHeight: 360, overflow: 'auto', padding: '8px 10px', background: 'var(--panel-2, #faf9f7)' }}>
          {events.map((e, i) => {
            const w = who(e.agent);
            if (e.kind === 'phase') return <div key={i} style={{ ...lbl, marginTop: i ? 10 : 0, color: 'var(--accent)' }}>▸ {e.text}</div>;
            if (e.kind === 'done') return <div key={i} style={{ fontSize: 12, color: '#2e9c4a', marginTop: 8 }}>✓ {e.text}</div>;
            if (e.kind === 'error') return <div key={i} style={{ fontSize: 12, color: '#c1432a', marginTop: 6 }}>⚠ {e.text}</div>;
            if (e.kind === 'artifact') return <div key={i} style={{ fontSize: 11.5, color: 'var(--text)', margin: '4px 0', paddingLeft: 8, borderLeft: '2px solid var(--accent)' }}>◆ {e.text}{e.detail ? <span style={{ color: 'var(--text-dim)' }}> · {e.detail}</span> : null}</div>;
            return (
              <div key={i} style={{ margin: '3px 0', fontSize: e.kind === 'thinking' ? 12.5 : 11, lineHeight: 1.4 }}>
                <span style={{ fontFamily: mono, fontSize: 10, color: w.c, fontWeight: 600 }}>{w.n}</span>
                {e.kind === 'thinking'
                  ? <span style={{ color: 'var(--text)' }}> {e.text}</span>
                  : e.kind === 'tool'
                    ? <span style={{ color: 'var(--text-dim)', fontFamily: mono }}> ▸ {e.text}{e.detail ? ` (${e.detail})` : ''}</span>
                    : <span style={{ color: 'var(--text-dim)', fontFamily: mono }}> {e.text}{e.detail ? ` · ${e.detail}` : ''}</span>}
              </div>
            );
          })}
        </div>
      )}

      {result && (
        <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
          <div style={{ border: '1px solid var(--border)', borderRadius: 6, padding: '8px 11px', fontSize: 12.5 }}>
            <div style={lbl}>what the two agents actually produced</div>
            <div style={{ marginTop: 5, color: result.sharedAtoms.length > 0 ? '#2e9c4a' : '#b45309' }}>
              {result.sharedAtoms.length > 0
                ? <>✓ <strong>{result.sharedAtoms.length}</strong> content-addressed atom(s) in <strong>both</strong> agents’ descriptors — one holarchy across two pods (A: {result.atomsA} atoms, B: {result.atomsB}).</>
                : <>○ no shared atom surfaced this run (content-addressed; depends on the work the agents chose).</>}
            </div>
            {result.gapTotal > 0 && <div style={{ marginTop: 5 }}>B interrogated A over {result.gapTotal} interrogatives — <strong>{result.gapAbsent}</strong> absent. {result.gapArticulation && <span style={{ color: 'var(--text-dim)' }}>B’s words: “{result.gapArticulation.slice(0, 220)}”</span>}</div>}
            {result.transferred != null && (
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6, alignItems: 'center' }}>
                <span style={{ fontFamily: mono, fontSize: 10.5, padding: '3px 8px', borderRadius: 999, background: result.transferred ? 'rgba(46,160,67,0.14)' : 'rgba(217,119,6,0.14)', color: result.transferred ? '#2e9c4a' : '#b45309' }}>{result.transferred ? '✓ taught — transfer verified' : '○ not transferred'}</span>
                {result.modalStatus && <span style={{ fontFamily: mono, fontSize: 10.5, padding: '3px 8px', borderRadius: 999, background: '#f3f3f1' }}>modal: {result.modalStatus}</span>}
                <span style={{ fontFamily: mono, fontSize: 11, color: 'var(--text-dim)' }}>signal {pct(result.beforeSignal)} → {pct(result.afterSignal)}</span>
              </div>
            )}
            {result.evidence && <div style={{ fontSize: 12, color: 'var(--text)', marginTop: 5, lineHeight: 1.45 }}>{result.evidence}</div>}
            <div style={{ fontSize: 11, color: 'var(--text-dim)', marginTop: 6 }}>
              {result.descriptorUrlA && <a href={result.descriptorUrlA} target="_blank" rel="noreferrer" style={linkBtn}>A’s descriptor ↗</a>}
              {result.descriptorUrlB && <> · <a href={result.descriptorUrlB} target="_blank" rel="noreferrer" style={linkBtn}>B’s descriptor ↗</a></>} — dereference both; the shared atom URN is literally in each.
            </div>
          </div>
        </div>
      )}

      <Crosswalk rows={[
        ['agents that reason + act (not scripts)', 'two Claude tool-use loops, model-chosen calls to the live bridge'],
        ['shared context / federated memory', 'one content-addressed atom in two agents’ holons (a holarchy across pods)'],
        ['contextual misalignment between participants', 'B’s absent interrogatives on A’s holon — the gap, named by B in its own words'],
        ['agents that build capability in each other', 'POST /agent/teach — teacher-signed, transfer verified from behaviour'],
      ]} />
      <Delta>The agents genuinely drive this — the model picks each tool call and B articulates the gap in its own words. Real + verifiable: two self-sovereign wallets, two signed performances, a shared content-addressed atom (dereference both descriptors), a live inter-agent interrogation, and a teacher-signed transfer whose verdict the bridge computes. The one illustrative part is the teach step’s before/after <em>trajectories</em> (built from the markers the teacher chose) — the signature gate + transfer-verification math are the real primitive, same as the <code style={codeS}>/emergent</code> demo. Your key calls <code style={codeS}>api.anthropic.com</code> directly from this tab; it is never sent to our servers.</Delta>
    </div>
  );
}
