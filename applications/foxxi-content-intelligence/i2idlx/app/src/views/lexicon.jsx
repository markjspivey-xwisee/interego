// Lexicon: an instant, faceted list beside the entry. Filters survive reloads (per viewer).
import { C, KINDS, COLLECTIONS, SOURCES, RIGHTS, reuseClass, kindById, fieldById, typeById, curatedById, enactByConcept, mapsByConcept, byId, degree } from "../data.js";
import { search, snippet } from "../search.js";
import { Icon } from "../icons.jsx";
import { PopButton, useUI } from "../ui.jsx";
import { HL } from "../text.jsx";
import { Entry } from "./entry.jsx";
import { cx, go, useStored, isTyping, useDrive } from "../util.js";
import { useCaps } from "../caps.js";

const { useState, useEffect, useMemo, useRef } = React;

const FACETS = [
  { key: "k", o: "derived", label: "Kind", opts: () => KINDS.map((k) => ({ v: k.id, l: k.label, dot: k.id })), test: (c, v) => c.k === v },
  { key: "f", o: "i2idl", label: "Field", opts: () => COLLECTIONS.field.map((f) => ({ v: f.id, l: f.label })), test: (c, v) => c.f.includes(v) },
  { key: "t", o: "i2idl", label: "Type", opts: () => COLLECTIONS.type.map((t) => ({ v: t.id, l: t.label, dot: t.kind })), test: (c, v) => c.t === v },
  { key: "cu", o: "i2idl", label: "Collection", opts: () => COLLECTIONS.curated.map((t) => ({ v: t.id, l: t.label })), test: (c, v) => c.cu.includes(v) },
  { key: "s", o: "i2idl", label: "Source", opts: () => SOURCES.map((s, i) => ({ v: s.id, l: s.label, i })), test: (c, v) => c.ev.some((e) => SOURCES[e.s].id === v) },
  { key: "rc", o: "derived", label: "Reuse", opts: () => Object.entries(RIGHTS).map(([v, r]) => ({ v, l: r.label })), test: (c, v) => reuseClass(c) === v },
  {
    key: "x", o: "x", label: "Layer", opts: () => [
      { v: "enacted", l: "Has capability links" }, { v: "mapped", l: "Has crosswalks" }, { v: "synth", l: "Synthesized definition" },
      { v: "starred", l: "Starred by me" }, { v: "isolated", l: "No related links" },
    ],
    test: (c, v, ctx) => v === "enacted" ? enactByConcept.has(c.id) : v === "mapped" ? mapsByConcept.has(c.id) : v === "synth" ? c.pv === "s"
      : v === "starred" ? ctx.stars.includes(c.id) : v === "isolated" ? c.r.length === 0 : true,
  },
];

export function parseFilter(s) {
  // "f.learning-engineering" → {f: ["learning-engineering"]}
  if (!s) return null;
  const m = s.match(/^([a-z]+)\.(.+)$/);
  if (!m || !FACETS.some((f) => f.key === m[1])) return null;
  return { [m[1]]: [m[2]] };
}

export function Lexicon({ route }) {
  const { ws } = useCaps();
  const drive = useDrive();
  const { hover, lens } = useUI();
  const FACETS_NOW = lens === "i2idl" ? FACETS.filter((f) => f.o === "i2idl") : FACETS;
  const [q, setQ] = useStored("lex.q", "");
  const [filters, setFilters] = useStored("lex.filters", {});
  const [sort, setSort] = useStored("lex.sort", "az");
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const sel = route.id || null;

  // A #browse-<facet>.<value> link replaces the filters with that one facet.
  useEffect(() => {
    const f = parseFilter(route.filter);
    if (f) { setFilters(f); setQ(""); }
  }, [route.filter]);

  const ctx = { stars: ws.stars };
  const results = useMemo(() => {
    let base = q.trim() ? search(q, 400) : C.map((c) => ({ c, score: 0, why: "label" }));
    for (const f of FACETS_NOW) {
      const vals = filters[f.key];
      if (vals && vals.length) base = base.filter((r) => vals.some((v) => f.test(r.c, v, ctx)));
    }
    if (!q.trim()) {
      if (sort === "connected") base = [...base].sort((a, b) => degree(b.c) - degree(a.c) || a.c.l.localeCompare(b.c.l));
      else base = [...base].sort((a, b) => a.c.l.localeCompare(b.c.l, undefined, { sensitivity: "base" }));
    }
    return base;
  }, [q, filters, sort, ws.stars, lens]);

  const counts = (f) => {
    // counts for a facet's options under the other active filters and the query
    let base = q.trim() ? search(q, 400).map((r) => r.c) : C;
    for (const g of FACETS_NOW) {
      if (g.key === f.key) continue;
      const vals = filters[g.key];
      if (vals && vals.length) base = base.filter((c) => vals.some((v) => g.test(c, v, ctx)));
    }
    const m = new Map();
    for (const o of f.opts()) m.set(o.v, base.filter((c) => f.test(c, o.v, ctx)).length);
    return m;
  };

  const ids = results.map((r) => r.c.id);
  const pos = sel ? ids.indexOf(sel) : -1;
  useEffect(() => {
    if (drive && drive.embedded) return undefined;
    const k = (e) => {
      if (isTyping(e) && e.target !== inputRef.current) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowDown" || (e.key === "j" && !isTyping(e))) { e.preventDefault(); const n = ids[Math.min(ids.length - 1, pos + 1)]; if (n) go("c-" + n); }
      if (e.key === "ArrowUp" || (e.key === "k" && !isTyping(e))) { e.preventDefault(); const n = ids[Math.max(0, pos - 1)]; if (n) go("c-" + n); }
      if (e.key === "Enter" && e.target === inputRef.current && ids[0] && pos === -1) go("c-" + ids[0]);
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [ids.join("|"), pos, drive]);
  useEffect(() => {
    if (!sel || !listRef.current) return;
    const el = listRef.current.querySelector(`[data-id="${sel}"]`);
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const active = FACETS_NOW.flatMap((f) => (filters[f.key] || []).map((v) => ({ f, v, o: f.opts().find((o) => o.v === v) }))).filter((x) => x.o);
  const toggle = (key, v) => setFilters((old) => {
    const cur = new Set(old[key] || []);
    cur.has(v) ? cur.delete(v) : cur.add(v);
    return { ...old, [key]: [...cur] };
  });

  let lastLetter = null;
  return (
    <div className={cx("lex", sel && "has-sel")}>
      <div className="lex-side">
        <div className="lex-search">
          <div className="row" style={{ position: "relative" }}>
            <Icon name="search" className="muted" />
            <input ref={inputRef} className="input" style={{ border: 0, boxShadow: "none", padding: 0, height: 30 }} value={q}
              onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${C.length} terms…`} aria-label="Filter terms" />
            {q ? <button className="btn ghost sm icon" onClick={() => setQ("")} aria-label="Clear"><Icon name="x" /></button> : null}
          </div>
        </div>
        <div className="lex-filters">
          {FACETS_NOW.map((f) => (
            <PopButton key={f.key} small label={f.label + ((filters[f.key] || []).length ? ` · ${(filters[f.key] || []).length}` : "")} className={cx((filters[f.key] || []).length ? "on" : "", f.o !== "i2idl" && "xfacet")}
              title={f.o === "i2idl" ? `${f.label} — I2IDL's own classification` : `${f.label} — added by I2IDL-X`}>
              {() => {
                const n = counts(f);
                return (
                  <div style={{ minWidth: 240 }}>
                    <div className="pop-h row"><span className="grow">{f.label}</span><span className={"tiny ofrom o-" + (f.o === "x" ? "derived" : f.o)}>{f.o === "i2idl" ? "I2IDL" : f.o === "derived" ? "I2IDL-X · derived" : "I2IDL-X"}</span></div>
                    {f.opts().map((o) => (
                      <label key={o.v} className="opt" style={{ cursor: "pointer" }}>
                        <input type="checkbox" checked={(filters[f.key] || []).includes(o.v)} onChange={() => toggle(f.key, o.v)} style={{ accentColor: "var(--accent)" }} />
                        {o.dot ? <span className={"dot kd-" + o.dot} /> : null}<span className="grow">{o.l}</span><span className="n">{n.get(o.v)}</span>
                      </label>
                    ))}
                  </div>
                );
              }}
            </PopButton>
          ))}
          {active.length ? <button className="btn ghost sm" onClick={() => setFilters({})}>Clear</button> : null}
        </div>
        <div className="lex-list" ref={listRef} onScroll={hover.now}>
          <div className="lex-count">
            <span className="grow">{results.length === C.length ? `${C.length} terms` : `${results.length} of ${C.length}`}</span>
            {!q.trim() ? (
              <select className="select" style={{ height: 24, width: "auto", fontSize: 12, padding: "0 6px" }} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
                <option value="az">A–Z</option><option value="connected">Most connected</option>
              </select>
            ) : <span>by relevance</span>}
          </div>
          {active.length ? <div className="row wrap" style={{ padding: "0 8px 6px", gap: 4 }}>{active.map(({ f, v, o }) => (
            <button key={f.key + v} className="chip" onClick={() => toggle(f.key, v)} title={`Remove ${f.label} filter`}>{o.dot ? <span className={"dot kd-" + o.dot} /> : null}{o.l}<Icon name="x" size={12} /></button>
          ))}</div> : null}
          {results.map(({ c, why }) => {
            const letter = !q.trim() && sort === "az" ? c.l[0].toUpperCase().replace(/[^A-Z]/, "#") : null;
            const head = letter && letter !== lastLetter ? (lastLetter = letter) : null;
            return (
              <React.Fragment key={c.id}>
                {head ? <div className="letter">{head}</div> : null}
                <button className="li" data-id={c.id} aria-current={sel === c.id} onClick={() => go("c-" + c.id)}>
                  <span className={"dot kd-" + c.k} title={kindById.get(c.k).label} />
                  <span className="t"><HL text={c.l} q={q} /></span>
                  <span className="s">
                    {q.trim() && why === "alt" ? <span className="why">also “{c.a.find((a) => a.toLowerCase().includes(q.trim().toLowerCase().split(" ")[0])) || c.a[0]}” · </span> : null}
                    {q.trim() && (why === "definition" || why === "note" || why === "fuzzy") ? <HL text={snippet(why === "note" ? c.x : c.d, q, 90)} q={q} /> : fieldById.get(c.pf).label}
                  </span>
                </button>
              </React.Fragment>
            );
          })}
          {!results.length ? <div className="empty"><Icon name="search" /><div><b>No terms match.</b></div><div className="small">Try fewer words, or <a href="#ask">ask Claude</a> — it searches definitions too.</div></div> : null}
        </div>
      </div>
      <div className="lex-main" onScroll={hover.now}>
        {sel ? <Entry id={sel} query={q.trim() ? q : ""} onBack={() => go("browse")} /> : <LexiconIntro n={results.length} />}
      </div>
    </div>
  );
}

function LexiconIntro({ n }) {
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="stack">
        <div className="eyebrow">Lexicon</div>
        <h1 className="h-display" style={{ fontSize: 30 }}>Pick a term</h1>
        <p className="lede">{n} terms match your filters. Arrow keys or <kbd>j</kbd>/<kbd>k</kbd> step through them; <kbd>/</kbd> searches everything.</p>
        <div className="note"><Icon name="layers" /><span>Every entry has two zones. On the left, <b>the I2IDL record</b> exactly as I2IDL publishes it: definition, note, relations, evidence. On the right, <b>what I2IDL-X layers on top</b>, each section labelled with where it comes from: reading aids and history derived from I2IDL's own data, capability links and crosswalks proposed for review, your team's use, and the controls an agent follows. Switch the lens to <b>I2IDL only</b> to hide the layers.</span></div>
      </div>
    </div>
  );
}
