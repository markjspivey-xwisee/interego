// Interpretant — the app shell: top bar, routing, keyboard, theme, overlays and shared context.
import { META, C, ITEMS, byId } from "./data.js";
import { CapsProvider, useCaps, consensus } from "./caps.js";
import { Icon, Mark } from "./icons.jsx";
import { UI, useToasts, useHoverCards, Modal, Avatar } from "./ui.jsx";
import { Palette } from "./palette.jsx";
import { Home } from "./views/home.jsx";
import { Lexicon, parseFilter } from "./views/lexicon.jsx";
import { MapView } from "./views/map.jsx";
import { Compare } from "./views/compare.jsx";
import { Review } from "./views/review.jsx";
import { Packs } from "./views/packs.jsx";
import { Insights } from "./views/insights.jsx";
import { Agents } from "./views/agents.jsx";
import { Ask, useAskEngine } from "./views/ask.jsx";
import { ForI2IDL } from "./views/fori2idl.jsx";
import { Annotate } from "./views/annotate.jsx";
import { Semantic } from "./views/semantic.jsx";
import { LensToggle, LayersModal } from "./origin.jsx";
import { useRoute, go, isTyping, useStored, cx } from "./util.js";

const { useState, useEffect, useMemo, useCallback, useRef } = React;

const NAV = [
  { v: "lexicon", l: "Lexicon", h: "browse", icon: "book" },
  { v: "map", l: "Map", h: "whole", icon: "globe" },
  { v: "compare", l: "Compare", h: "cmp", icon: "compare" },
  { v: "annotate", l: "Annotate", h: "annotate", icon: "edit" },
  { v: "review", l: "Review", h: "review", icon: "review" },
  { v: "packs", l: "Packs", h: "packs", icon: "pack" },
  { v: "insights", l: "Insights", h: "insights", icon: "insights" },
  { v: "semantic", l: "Semantics", h: "semantic", icon: "tree" },
  { v: "agents", l: "Agents", h: "agents", icon: "agent" },
  { v: "ask", l: "Ask", h: "ask", icon: "sparkle" },
];

function useTheme() {
  const [theme, setTheme] = useStored("theme", "system");
  useEffect(() => {
    const el = document.documentElement;
    if (theme === "system") el.removeAttribute("data-theme");
    else el.setAttribute("data-theme", theme);
  }, [theme]);
  return [theme, setTheme];
}

function Shell() {
  const route = useRoute();
  const caps = useCaps();
  const [toast, toastView] = useToasts();
  const [hover, hoverView] = useHoverCards();
  const [theme, setTheme] = useTheme();
  const [pal, setPal] = useState(false);
  const [help, setHelp] = useState(false);
  const [layers, setLayers] = useState(null);
  const [lens, setLens] = useStored("lens", "x");
  const engine = useAskEngine();
  const gPending = useRef(0);

  const ask = useMemo(() => (engine.available ? {
    open: (prompt, ids = []) => {
      engine.setCtx(ids);
      go("ask");
      if (prompt) setTimeout(() => engine.send(prompt, ids), 30);
    },
  } : null), [engine.available, engine.send]);
  const ui = useMemo(() => ({ toast, hover, palette: { open: () => setPal(true) }, ask, lens, setLens, layers: { open: (focus) => setLayers({ focus: focus || null }) } }), [toast, hover, ask, lens]);

  useEffect(() => {
    const k = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setPal(true); return; }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "/") { e.preventDefault(); setPal(true); return; }
      if (e.key === "?") { e.preventDefault(); setHelp(true); return; }
      if (e.key === "g") { gPending.current = Date.now(); return; }
      if (Date.now() - gPending.current < 900) {
        const to = { h: "home", l: "browse", m: "whole", c: "cmp", n: "annotate", r: "review", p: "packs", i: "insights", s: "semantic", a: "agents", k: "ask", o: "for-i2idl" }[e.key];
        gPending.current = 0;
        if (to) { e.preventDefault(); go(to); }
      }
    };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, []);
  useEffect(() => { hover.now(); }, [route]);

  const needVotes = useMemo(() => ITEMS.filter((i) => consensus(caps.tallies.get(i.key), caps.policy.quorum) === "proposed").length, [caps.tallies, caps.policy]);
  const current = route.view === "lexicon" ? route.id : null;
  useEffect(() => {
    const c = current && byId.get(current);
    document.title = c ? `${c.l} · Interpretant` : "Interpretant Glossary Workbench";
  }, [current]);

  const nav = (
    <nav className="nav" aria-label="Views">
      {NAV.filter((n) => n.v !== "ask" || engine.available).map((n) => (
        <a key={n.v} href={"#" + n.h} aria-current={route.view === n.v ? "page" : undefined}>
          <Icon name={n.icon} />{n.l}{n.v === "review" && needVotes ? <span className="count" title={`${needVotes} items have no votes yet`}>{needVotes}</span> : null}
          {n.v === "packs" && caps.ws.packs.length ? <span className="count">{caps.ws.packs.length}</span> : null}
        </a>
      ))}
    </nav>
  );
  const nextTheme = { system: "light", light: "dark", dark: "system" }[theme];
  return (
    <UI.Provider value={ui}>
      <div className={"app lens-" + lens}>
        <header className="topbar">
          <a className="brand" href="#home" aria-label="Interpretant home">
            <Mark className="mark" />
            <span><span className="name">Interpretant</span><span className="sub">I2IDL glossary · Interego · Foxxi</span></span>
          </a>
          <button className="searchbtn" onClick={() => setPal(true)} aria-label="Search terms"><Icon name="search" /><span className="ph">Search {C.length} terms…</span><kbd>/</kbd></button>
          {nav}
          <div className="tools">
            <LensToggle lens={lens} setLens={(v) => { setLens(v); toast(v === "i2idl" ? "Showing only what I2IDL publishes" : "Showing I2IDL with the I2IDL-X layers", { icon: "layers" }); }} />
            <a className={cx("btn sm fori2idl", route.view === "fori2idl" && "on")} href="#for-i2idl" title="What I2IDL-X does with I2IDL's linked data, mapped to I2IDL's own roadmap"><Icon name="flag" /><span>For I2IDL</span></a>
            <button className="btn ghost icon" onClick={() => setTheme(nextTheme)} title={`Theme: ${theme} (switch to ${nextTheme})`} aria-label="Switch theme">
              <Icon name={theme === "dark" ? "moon" : theme === "light" ? "sun" : "monitor"} />
            </button>
            <button className="btn ghost icon" onClick={() => setHelp(true)} title="Shortcuts and about" aria-label="Help"><Icon name="help" /></button>
            {caps.me ? <span title={caps.me.name || "You"}><Avatar p={caps.me} size={26} /></span> : null}
          </div>
        </header>
        <div className="navbar2">{nav}</div>
        <main className="view" id="main">
          {route.view === "home" ? <Home />
            : route.view === "lexicon" ? <Lexicon route={route} />
              : route.view === "map" ? <MapView route={route} />
                : route.view === "compare" ? <Compare route={route} />
                  : route.view === "review" ? <Review route={route} />
                    : route.view === "packs" ? <Packs route={route} />
                      : route.view === "insights" ? <Insights route={route} />
                        : route.view === "agents" ? <Agents route={route} />
                          : route.view === "ask" ? <Ask engine={engine} />
                            : route.view === "fori2idl" ? <ForI2IDL />
                              : route.view === "annotate" ? <Annotate />
                                : route.view === "semantic" ? <Semantic route={route} />
                                : <Home />}
        </main>
      </div>
      {pal ? <Palette onClose={() => setPal(false)} ask={ask} current={current} setTheme={setTheme} /> : null}
      {help ? <Help onClose={() => setHelp(false)} /> : null}
      {layers ? <LayersModal focus={layers.focus} onClose={() => setLayers(null)} /> : null}
      {hoverView}
      {toastView}
    </UI.Provider>
  );
}

function Help({ onClose }) {
  const keys = [["/ or ⌘K", "Search everything"], ["j / k or ↑ / ↓", "Next / previous term (Lexicon), next / previous item (Review)"],
    ["f / a / x", "Vote for / against / abstain on the focused review item"], ["g then h l m c n r p i s a k o", "Go to Home, Lexicon, Map, Compare, Annotate, Review, Packs, Insights, Semantics, Agents, Ask, For I2IDL"],
    ["?", "This panel"], ["Esc", "Close"]];
  return (
    <Modal title="Interpretant" onClose={onClose} wide>
      <div className="stack" style={{ gap: 16 }}>
        <p>A workbench for the <b>{META.scheme.title}</b> ({META.release}, commit <code>{META.commit.slice(0, 7)}</code>), decorated with <b>I2IDL-X</b>: the Interego and Foxxi layer published at <code>{META.base}</code>.</p>
        <table className="tbl"><tbody>{keys.map(([k, d]) => <tr key={k}><td className="nowrap"><kbd>{k}</kbd></td><td>{d}</td></tr>)}</tbody></table>
        <div className="stack small" style={{ gap: 6 }}>
          <b>Rights</b>
          <p className="muted">{META.scheme.rights} I2IDL-original definitions, explanations and modeling: {META.license.holder}, <a href={META.license.url} target="_blank" rel="noopener">{META.license.name}</a> (<a href={META.license.file} target="_blank" rel="noopener">DATA-LICENSE</a>). Every evidence record shows its source's own rights; exports carry the attribution for each source they use.</p>
          <b>What is shared here</b>
          <p className="muted">Votes, notes and “I use this” marks are visible to everyone with access to this page; packs, stars and recent terms are private to you. Ask Claude runs on your own Claude account.</p>
          <b>What's whose</b>
          <p className="muted">Every element carries a label: <b>I2IDL</b> for the glossary as I2IDL publishes it; <b>I2IDL-X · derived</b>, <b>· added</b> or <b>· proposed</b> for the layer on top; <b>Interego</b>, <b>Foxxi</b> or <b>Your team</b> for the rest. The <b>I2IDL only</b> lens hides every layer. Click any label for details.</p>
          <b>Independence</b>
          <p className="muted">Interpretant and I2IDL-X are independent work by Foxxi Mediums; they are not affiliated with or endorsed by I2IDL. I2IDL-X never restates or alters I2IDL's content: its enactments and crosswalks are AI-drafted and published as Hypothetical until reviewers ratify them.</p>
        </div>
      </div>
    </Modal>
  );
}

function App() {
  return <CapsProvider><Shell /></CapsProvider>;
}

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
