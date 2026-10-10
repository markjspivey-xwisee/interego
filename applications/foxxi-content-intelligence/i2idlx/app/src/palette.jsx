// Command palette: terms first, then places, filters and actions. Opens with / or ⌘K.
import { C, KINDS, COLLECTIONS, byId, kindById, fieldById } from "./data.js";
import { search, snippet } from "./search.js";
import { Icon } from "./icons.jsx";
import { HL } from "./text.jsx";
import { go, store } from "./util.js";

const { useState, useEffect, useRef, useMemo } = React;

const VIEWS = [
  { l: "Home", h: "home", icon: "home" }, { l: "Lexicon", h: "browse", icon: "book" }, { l: "Map", h: "whole", icon: "globe" },
  { l: "Compare", h: "cmp", icon: "compare" }, { l: "Review queue", h: "review", icon: "review" }, { l: "Packs", h: "packs", icon: "pack" },
  { l: "Insights", h: "insights", icon: "insights" }, { l: "Agent console", h: "agents", icon: "agent" }, { l: "Ask Claude", h: "ask", icon: "sparkle" },
  { l: "Path between two terms", h: "path-~", icon: "route" },
];

export function Palette({ onClose, ask, current, setTheme }) {
  const [q, setQ] = useState("");
  const [i, setI] = useState(0);
  const inp = useRef(null);
  const list = useRef(null);
  useEffect(() => { inp.current && inp.current.focus(); }, []);
  const items = useMemo(() => {
    const out = [];
    const t = q.trim().toLowerCase();
    if (!t) {
      const rec = (store.get("recents", []) || []).filter((id) => byId.has(id)).slice(0, 6);
      for (const id of rec) out.push({ g: "Recent", t: byId.get(id).l, d: byId.get(id).d, dot: byId.get(id).k, run: () => go("c-" + id) });
      for (const v of VIEWS) out.push({ g: "Go to", t: v.l, icon: v.icon, run: () => go(v.h) });
      return out;
    }
    for (const r of search(q, 8)) out.push({ g: "Terms", t: r.c.l, d: snippet(r.why === "note" ? r.c.x : r.c.d, q, 110), dot: r.c.k, k: kindById.get(r.c.k).label, run: () => go("c-" + r.c.id) });
    if (ask) out.push({ g: "Ask", t: `Ask Claude: “${q.trim()}”`, icon: "sparkle", run: () => ask.open(q.trim(), current ? [current] : []) });
    for (const f of COLLECTIONS.field) if (f.label.toLowerCase().includes(t)) out.push({ g: "Filter", t: "Field: " + f.label, icon: "filter", k: String(f.n), run: () => go("browse-f." + f.id) });
    for (const f of COLLECTIONS.type) if (f.label.toLowerCase().includes(t)) out.push({ g: "Filter", t: "Type: " + f.label, icon: "filter", k: String(f.n), run: () => go("browse-t." + f.id) });
    for (const f of COLLECTIONS.curated) if (f.label.toLowerCase().includes(t)) out.push({ g: "Filter", t: "Collection: " + f.label, icon: "book", k: String(f.n), run: () => go("browse-cu." + f.id) });
    for (const k of KINDS) if (k.label.toLowerCase().includes(t)) out.push({ g: "Filter", t: "Kind: " + k.label, dot: k.id, run: () => go("browse-k." + k.id) });
    for (const v of VIEWS) if (v.l.toLowerCase().includes(t)) out.push({ g: "Go to", t: v.l, icon: v.icon, run: () => go(v.h) });
    if ("dark light theme".includes(t) && t.length > 2) {
      out.push({ g: "Settings", t: "Theme: dark", icon: "moon", run: () => setTheme("dark") });
      out.push({ g: "Settings", t: "Theme: light", icon: "sun", run: () => setTheme("light") });
      out.push({ g: "Settings", t: "Theme: match system", icon: "monitor", run: () => setTheme("system") });
    }
    return out;
  }, [q]);
  useEffect(() => setI(0), [q]);
  useEffect(() => {
    const el = list.current && list.current.querySelector('[aria-selected="true"]');
    if (el) el.scrollIntoView({ block: "nearest" });
  }, [i]);
  const run = (it) => { onClose(); setTimeout(it.run, 0); };
  let lastG = null;
  return (
    <div className="scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal palette" role="dialog" aria-modal="true" aria-label="Search">
        <div className="pin">
          <Icon name="search" size={18} />
          <input ref={inp} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search 397 terms, fields, places…" aria-label="Search"
            role="combobox" aria-expanded="true" aria-controls="pal-list"
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setI((x) => Math.min(items.length - 1, x + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
              if (e.key === "Enter" && items[i]) { e.preventDefault(); run(items[i]); }
              if (e.key === "Escape") onClose();
            }} />
          <kbd>Esc</kbd>
        </div>
        <div className="results" ref={list} id="pal-list" role="listbox">
          {items.map((it, k) => {
            const head = it.g !== lastG ? (lastG = it.g) : null;
            return (
              <React.Fragment key={k}>
                {head ? <div className="grp">{head}</div> : null}
                <button className="res" role="option" aria-selected={k === i} onMouseMove={() => setI(k)} onClick={() => run(it)}>
                  {it.dot ? <span className={"dot kd-" + it.dot} /> : <Icon name={it.icon || "right"} />}
                  <span className="t">{it.g === "Terms" ? <HL text={it.t} q={q} /> : it.t}</span>
                  <span className="k">{it.k || ""}</span>
                  {it.d ? <span className="d">{it.g === "Terms" ? <HL text={it.d} q={q} /> : it.d}</span> : null}
                </button>
              </React.Fragment>
            );
          })}
          {!items.length ? <div className="empty small">No matches.</div> : null}
        </div>
        <div className="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>Enter</kbd> open</span><span><kbd>/</kbd> or <kbd>⌘K</kbd> anywhere</span></div>
      </div>
    </div>
  );
}
