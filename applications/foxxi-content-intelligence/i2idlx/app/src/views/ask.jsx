// Ask Claude, grounded in the glossary: Claude reads the release through page tools (search, look up,
// paths, capabilities, team notes) and cites every term as [[concept-id]]. Runs on the viewer's own account.
import { C, META, byId, kindById, typeById, fieldById, SOURCES, ACTIONS, roleById, enactByConcept, mapsByConcept, inhByConcept, shortestPaths, relationBetween, conceptsByAction, systemLabel, COLLECTIONS } from "../data.js";
import { search } from "../search.js";
import { useCaps } from "../caps.js";
import { Icon } from "../icons.jsx";
import { useUI, Seg } from "../ui.jsx";
import { MiniMarkdown } from "../text.jsx";
import { useStored } from "../util.js";

const { useState, useRef, useEffect, useCallback } = React;

const INDEX = C.map((c) => `${c.id}: ${c.l}`).join("\n");
const short = (s, n) => (s && s.length > n ? s.slice(0, n).replace(/\s+\S*$/, "") + "…" : s);

function brief(c) {
  return { id: c.id, label: c.l, kind: kindById.get(c.k).label, field: fieldById.get(c.pf).label, definition: short(c.d, 320) };
}
function full(c, notes) {
  return {
    id: c.id, label: c.l, alsoKnownAs: c.a, definition: c.d, editorialNote: c.x, type: typeById.get(c.t).label, agenticKind: kindById.get(c.k).label,
    fields: c.f.map((f) => fieldById.get(f).label), provenance: c.pv === "g" ? "source-grounded" : "synthesized",
    broader: c.b.map((x) => ({ id: x, label: byId.get(x).l })), narrower: c.n.map((x) => ({ id: x, label: byId.get(x).l })),
    related: c.r.map((x) => ({ id: x, label: byId.get(x).l })),
    evidence: c.ev.map((e) => ({ source: SOURCES[e.s].label, relation: e.r === "d" ? "direct" : "supporting", citation: e.c, rights: SOURCES[e.s].rights })),
    capabilityLinks_hypothetical: (enactByConcept.get(c.id) || []).map((e) => ({ role: roleById.get(e.r).by, action: ACTIONS[e.a] ? ACTIONS[e.a].t : e.a, system: systemLabel(ACTIONS[e.a] && ACTIONS[e.a].sys), confidence: e.cf, rationale: e.w })),
    inheritedCapabilities: (inhByConcept.get(c.id) || []).map((e) => ({ action: ACTIONS[e.a] ? ACTIONS[e.a].t : e.a, via: e.via })),
    crosswalks_hypothetical: (mapsByConcept.get(c.id) || []).map((m) => ({ predicate: "skos:" + m.p, target: m.ol || m.o, vocabulary: m.v, confidence: m.cf })),
    teamNotes: notes,
  };
}

const RULES = (ctx) => `You are the glossary assistant inside Interpretant, a workbench for the ${META.scheme.title} (release ${META.release}, ${C.length} approved concepts), decorated with I2IDL-X: Interego and Foxxi capability links ("enactments") and crosswalks to other vocabularies.

How to answer:
- Ground every statement about a term in the glossary. Look terms up with the tools before you define, compare or recommend them; quote or closely paraphrase I2IDL's definitions and never invent one.
- Cite each glossary term you discuss inline as [[concept-id]] using ids from the tools or the index below, e.g. [[learning-record-store-lrs]]. The page turns these into links.
- I2IDL definitions, editorial notes and relations are asserted by I2IDL. I2IDL-X capability links and crosswalks are AI-drafted and Hypothetical until reviewers ratify them; say so when you rely on them.
- If the glossary has no entry for something, say so plainly, then answer from general knowledge and label it as such.
- Write for a practitioner: short paragraphs or bullets, no preamble, no sign-off.
${ctx ? `\nThe person is looking at: ${ctx}.` : ""}

Index of all ${C.length} terms (id: label):
${INDEX}`;

function retrieval(question, ctxIds) {
  // used when this viewer can't run page tools: put the likely-relevant entries in the prompt
  const ids = new Set(ctxIds);
  for (const r of search(question, 10)) ids.add(r.c.id);
  for (const w of question.split(/[^A-Za-z0-9-]+/).filter((x) => x.length > 3)) for (const r of search(w, 2)) ids.add(r.c.id);
  const pick = [...ids].slice(0, 14).map((id) => full(byId.get(id), undefined));
  return `\n\nRelevant glossary entries (JSON):\n${JSON.stringify(pick)}`;
}

export function useAskEngine() {
  const caps = useCaps();
  const [turns, setTurns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState("");
  const [ctx, setCtx] = useState([]);
  const [tier, setTier] = useStored("ask.tier", "default");
  const ctl = useRef(null);
  const sample = caps.sample;

  const tools = useCallback((trace) => [
    {
      name: "search_glossary",
      description: "Search the glossary's labels, alternate labels and definitions. Returns up to `limit` (default 8) matches as {id, label, kind, field, definition}.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } }, required: ["query"] },
      execute: ({ query, limit }) => { trace("Searched “" + String(query).slice(0, 40) + "”"); return search(String(query || ""), Math.min(15, Number(limit) || 8)).map((r) => brief(r.c)); },
    },
    {
      name: "get_concept",
      description: "Full entry for one concept id: definition, editorial note, type, kind, fields, broader/narrower/related, evidence with rights, Hypothetical capability links and crosswalks, and the team's notes.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      execute: ({ id }) => {
        const c = byId.get(String(id));
        if (!c) throw new Error(`No concept with id "${id}". Search first.`);
        trace("Read " + c.l);
        const notes = caps.allNotes.filter((n) => n.c === c.id).slice(-8).map((n) => n.text.slice(0, 400));
        return full(c, notes);
      },
    },
    {
      name: "find_path",
      description: "Shortest routes between two concept ids through I2IDL's related/broader/narrower links. Returns up to 3 paths as lists of {id, label, relationToNext}.",
      inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
      execute: ({ from, to }) => {
        const a = byId.get(String(from)), b = byId.get(String(to));
        if (!a || !b) throw new Error("Unknown id; search first.");
        trace(`Traced ${a.l} → ${b.l}`);
        return shortestPaths(a.id, b.id, 3).map((p) => p.map((id, i) => ({ id, label: byId.get(id).l, relationToNext: i < p.length - 1 ? relationBetween(id, p[i + 1]) : null })));
      },
    },
    {
      name: "list_concepts",
      description: "List concepts in a field, type, agentic kind or curated collection (give one of field, type, kind, collection as its label or id). Returns {id, label}.",
      inputSchema: { type: "object", properties: { field: { type: "string" }, type: { type: "string" }, kind: { type: "string" }, collection: { type: "string" } } },
      execute: (a) => {
        const m = (list, v) => list.find((x) => x.id === v || x.label.toLowerCase() === String(v).toLowerCase());
        let out = C;
        if (a.field) { const f = m(COLLECTIONS.field, a.field); out = f ? out.filter((c) => c.f.includes(f.id)) : []; }
        if (a.type) { const t = m(COLLECTIONS.type, a.type); out = t ? out.filter((c) => c.t === t.id) : []; }
        if (a.kind) { const k = String(a.kind).toLowerCase(); out = out.filter((c) => c.k === k || kindById.get(c.k).label.toLowerCase() === k); }
        if (a.collection) { const cu = m(COLLECTIONS.curated, a.collection); out = cu ? out.filter((c) => c.cu.includes(cu.id)) : []; }
        trace("Listed " + out.length + " terms");
        return out.slice(0, 120).map((c) => ({ id: c.id, label: c.l }));
      },
    },
    {
      name: "find_capabilities",
      description: "Search the Foxxi bridge and Interego relay actions (the capability directory). Returns {action, title, system, readOnly, description, enactsConcepts}. Use it to suggest what could enact a concept.",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
      execute: ({ query }) => {
        const q = String(query || "").toLowerCase().split(/\s+/).filter(Boolean);
        trace("Searched capabilities “" + String(query).slice(0, 30) + "”");
        return Object.entries(ACTIONS).map(([iri, a]) => ({ iri, a, s: q.filter((w) => ((a.t || "") + " " + a.n + " " + (a.d || "")).toLowerCase().includes(w)).length }))
          .filter((x) => x.s).sort((x, y) => y.s - x.s).slice(0, 10)
          .map(({ iri, a }) => ({ action: a.n, title: a.t, system: systemLabel(a.sys), readOnly: a.ro, description: short(a.d, 260), enactsConcepts: (conceptsByAction.get(iri) || []).map((e) => e.c) }));
      },
    },
  ], [caps.allNotes]);

  const send = useCallback(async (text, ids = ctx) => {
    const q = (text || "").trim();
    if (!q || !sample || busy) return;
    const ctxLabel = ids.map((id) => byId.get(id)).filter(Boolean).map((c) => `${c.l} [[${c.id}]]`).join(", ");
    const history = turns.filter((t) => !t.error && t.content).slice(-8).map((t) => ({ role: t.role, content: t.content }));
    const userTurn = { role: "user", content: q };
    const bot = { role: "assistant", content: "", trace: [], pending: true };
    setTurns((t) => [...t, userTurn, bot]);
    setDraft("");
    setBusy(true);
    ctl.current = new AbortController();
    const trace = (s) => setTurns((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, trace: [...(x.trace || []), s] } : x)));
    let useTools = caps.tools;
    let maxTools = 5;
    try { const l = await sample.limits(); useTools = !!(l && l.tools); maxTools = (l && l.tools && l.tools.maxCount) || 5; } catch { /* keep default */ }
    const lead = RULES(ctxLabel) + (useTools ? "" : retrieval(q, ids));
    const input = [{ role: "user", content: lead }, ...history, userTurn];
    try {
      const opts = { signal: ctl.current.signal, modelTier: tier, onText: ({ text: t }) => setTurns((all) => all.map((x, i) => (i === all.length - 1 ? { ...x, content: t, pending: false } : x))) };
      if (useTools) opts.tools = tools(trace).slice(0, maxTools); else opts.cache = false;
      const res = await sample(input, opts);
      setTurns((all) => all.map((x, i) => (i === all.length - 1 ? { ...x, content: res.text, pending: false, truncated: res.truncated } : x)));
    } catch (e) {
      const code = e && e.code;
      const msg = code === "cancelled" ? null
        : code === "not_granted" || code === "sampling_disabled" || code === "not_declared" || code === "capability_disabled" ? "Claude isn't available on this page for your account."
        : code === "rate_limited" ? "Too many requests right now. Try again in a little while."
        : code === "session_expired" ? "Your session expired. Sign in again to keep asking."
        : code === "prompt_too_large" ? "That conversation got too long. Start a new one."
        : "Something went wrong reaching Claude. Try again.";
      setTurns((all) => all.map((x, i) => (i === all.length - 1 ? { ...x, content: (e && e.text) || x.content, pending: false, error: msg, stopped: code === "cancelled" } : x)));
    } finally {
      setBusy(false);
    }
  }, [sample, busy, turns, ctx, tier, tools, caps.tools]);

  const stop = () => ctl.current && ctl.current.abort();
  const reset = () => { stop(); setTurns([]); setCtx([]); };
  return { available: !!sample, turns, busy, draft, setDraft, ctx, setCtx, send, stop, reset, tier, setTier };
}

const STARTERS = [
  "What's the difference between formative evaluation and formative assessment?",
  "Draft a 10-term glossary for an intro course on xAPI, in teaching order.",
  "Which Foxxi capabilities could operationalize mastery learning?",
  "Explain learning engineering to a new instructional designer.",
  "How is a learning record store connected to competency-based learning?",
];

export function Ask({ engine }) {
  const { turns, busy, draft, setDraft, send, stop, reset, ctx, setCtx, available, tier, setTier } = engine;
  const log = useRef(null);
  const box = useRef(null);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [turns]);
  useEffect(() => { if (box.current) box.current.focus(); }, []);
  if (!available) {
    return (
      <div className="page" style={{ maxWidth: 720 }}>
        <div className="empty"><Icon name="sparkle" /><div><b>Ask Claude isn't available here</b></div>
          <div className="small">Open this page in claude.ai while signed in to ask questions grounded in the glossary. Everything else works without it.</div></div>
      </div>
    );
  }
  return (
    <div className="ask">
      <div className="ask-log" ref={log}>
        {!turns.length ? (
          <div className="stack" style={{ gap: 14, paddingTop: 20 }}>
            <div className="eyebrow">Ask Claude · grounded in {META.release}</div>
            <h1 className="serif" style={{ fontSize: 34, fontWeight: 600, lineHeight: 1.1 }}>Ask the glossary anything.</h1>
            <p className="lede">Claude looks terms up in the release as it answers and cites every term it uses. Capability links and crosswalks are flagged as hypotheses. Answers run on your own Claude account.</p>
            <div className="suggests">{STARTERS.map((s) => <button key={s} className="chip" onClick={() => send(s, [])}>{s}</button>)}</div>
          </div>
        ) : turns.map((t, i) => (
          <div key={i} className={"msg " + (t.role === "user" ? "user" : "bot")}>
            {t.role === "user" ? <div className="bubble">{t.content}</div> : (
              <>
                {t.trace && t.trace.length ? <div className="trace">{t.trace.map((x, j) => <span key={j}><Icon name="search" size={11} />{x}</span>)}</div> : null}
                <div className="bubble">{t.pending && !t.content ? <span className="thinking"><i /><i /><i /> Thinking…</span> : <MiniMarkdown text={t.content} />}</div>
                {t.truncated ? <div className="tiny muted">Cut short — ask for less at a time.</div> : null}
                {t.stopped ? <div className="tiny muted">Stopped.</div> : null}
                {t.error ? <div className="note warn"><Icon name="warn" /><span className="small">{t.error}</span></div> : null}
              </>
            )}
          </div>
        ))}
      </div>
      <div className="ask-in">
        {ctx.length ? <div className="row wrap small"><span className="muted">About:</span>{ctx.map((id) => byId.get(id) ? <span key={id} className="chip"><span className={"dot kd-" + byId.get(id).k} />{byId.get(id).l}</span> : null)}<button className="btn ghost sm" onClick={() => setCtx([])}>Clear</button></div> : null}
        <div className="box">
          <textarea ref={box} rows={1} value={draft} placeholder="Ask about any term, compare terms, or plan a course glossary…" onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(draft); } }} aria-label="Ask Claude" />
          {busy ? <button className="btn" onClick={stop}><Icon name="stop" />Stop</button> : <button className="btn primary" onClick={() => send(draft)} disabled={!draft.trim()}><Icon name="arrowRight" />Ask</button>}
        </div>
        <div className="row wrap tiny muted">
          <Seg label="Speed" value={tier} onChange={setTier} options={[{ v: "quick", l: "Fast" }, { v: "default", l: "Thorough" }]} />
          <span className="grow">Uses your Claude account. Answers can be wrong; check the cited entries.</span>
          {turns.length ? <button className="btn ghost sm" onClick={reset}>New conversation</button> : null}
        </div>
      </div>
    </div>
  );
}
