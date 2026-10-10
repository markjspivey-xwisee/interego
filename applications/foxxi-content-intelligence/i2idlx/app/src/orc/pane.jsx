// The workbench beside an orchestrated run: the same views the viewer uses, in their own frame and route,
// over the run's sandbox (its proposals, votes and packs, never the team's shared data), driven by the
// agents' tool calls. A cursor in the acting agent's color shows where each call lands.
import { ITEMS, byId, PORTS, QUERIES } from "../data.js";
import { CapsContext, useCaps } from "../caps.js";
import { catById } from "../semantic.js";
import { Icon } from "../icons.jsx";
import { Avatar } from "../ui.jsx";
import { ViewFor } from "../views/router.jsx";
import { parseHash, StoreScope, makeScope, Drive, setRouteTarget, cx } from "../util.js";
import { tallyOf, ratifiedBridges, QUORUM } from "./world.js";
import { agentById } from "./scenario.js";

const { useState, useEffect, useMemo, useRef, useCallback } = React;
const wait = (ms) => new Promise((f) => setTimeout(f, ms));

const SANDBOX_USER = {
  profiles: async (ids) => Object.fromEntries([].concat(ids).map((id) => {
    const a = agentById.get(id);
    return [id, a ? { id, name: a.name, color: a.color, avatarUrl: "" } : { id, name: "You (sandbox)", color: "var(--accent)", avatarUrl: "" }];
  })),
  me: async () => ({ id: "viewer", name: "You (sandbox)" }), id: async () => "viewer",
  can: async () => true, isOwner: async () => false, canEdit: async () => false,
};

function useSandboxCaps(world, version, bump) {
  const real = useCaps();
  return useMemo(() => {
    const items = [...world.items, ...ITEMS];
    const ws = { packs: world.packs, stars: [], recents: [] };
    return {
      resolved: true, db: null, user: SANDBOX_USER, sample: null, tools: false, downloads: real.downloads, save: real.save,
      me: { id: "viewer", name: "You (sandbox)", color: "var(--accent)" }, myId: "viewer",
      signedIn: true, writable: true, canWrite: true, isOwner: false, canEdit: false, dbError: null,
      items, itemByKey: new Map(items.map((i) => [i.key, i])), ballots: world.ballots,
      myBallot: world.ballots.get("viewer") || { v: {} }, tallies: new Map(items.map((i) => [i.key, tallyOf(world, i.key)])),
      vote: async (key, choice, note) => {
        const doc = world.ballots.get("viewer") || { v: {} };
        if (!choice) delete doc.v[key];
        else doc.v[key] = { vote: choice, note: (note || "").slice(0, 600), at: Date.now() };
        world.ballots.set("viewer", doc);
        bump();
      },
      policy: { quorum: QUORUM }, savePolicy: async () => {},
      allNotes: [], addNote: async () => { throw { code: "read_only" }; }, deleteNote: async () => {},
      usageByConcept: new Map(), setUse: async () => { throw { code: "read_only" }; },
      ws, wsSource: "sandbox", updateWs: (fn) => { const next = fn(ws); if (next && next.packs) world.packs = next.packs; bump(); },
    };
  }, [world, version, real.downloads, real.save, bump]);
}

const VIEW_NAME = { home: "Home", lexicon: "Lexicon", map: "Map", compare: "Compare", review: "Review", packs: "Packs", insights: "Insights",
  agents: "Agent console", semantic: "Semantics", fori2idl: "For I2IDL", annotate: "Annotate", ask: "Ask", orchestrate: "Orchestrate" };
function where(route, world) {
  const v = VIEW_NAME[route.view] || "Workbench";
  if (route.view === "lexicon") return [v, route.id && byId.get(route.id) ? byId.get(route.id).l : route.filter ? "browse" : "search"];
  if (route.view === "semantic") {
    const s = route.section || "";
    return [v, s.startsWith("cat.") ? (catById.get(s.slice(4)) || {}).label : s === "play" ? "Playground" : s || "Categories"];
  }
  if (route.view === "agents") {
    const c = route.section && (PORTS.find((p) => p.id === route.section) || QUERIES.find((q) => q.id === route.section));
    return [v, c ? c.label : "HyprCat catalog"];
  }
  if (route.view === "review") return [v, route.key || "queue"];
  if (route.view === "packs") { const p = world.packs.find((x) => x.id === route.id); return [v, p ? p.name : null]; }
  return [v, null];
}

export function WorkbenchPane({ orc }) {
  const { world, version, presenter, bump, speed } = orc;
  const [route, setRoute] = useState(() => parseHash("#agents"));
  const [actor, setActor] = useState(null);
  const [follow, setFollow] = useState(true);
  const [cursor, setCursor] = useState(null);
  const frame = useRef(null);
  const scroller = useRef(null);
  const lastRoute = useRef("#agents");
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const followRef = useRef(follow);
  followRef.current = follow;
  const scope = useMemo(() => makeScope({ "lex.q": "", "lex.filters": {}, "lex.sort": "az", "rv.type": "all", "rv.status": "open", "rv.mine": false, "rv.sort": "conf", "rv.method": "all" }), []);
  const caps = useSandboxCaps(world, version, bump);
  const bridges = useMemo(() => ratifiedBridges(world), [world, version]);
  const drive = useMemo(() => ({ embedded: true, bridges }), [bridges]);

  const navigate = useCallback((h) => {
    setRoute(parseHash(h));
    if (scroller.current) scroller.current.scrollTop = 0;
  }, []);

  // A new run follows the agents again; a link the viewer opens from the transcript shows here and stops following.
  useEffect(() => { setFollow(true); setCursor(null); }, [orc.runId]);
  useEffect(() => presenter.setNavigator((h) => { setFollow(false); navigate(h); }), [presenter, navigate]);

  // While the viewer works inside the frame, the views' own links and go() calls route the frame.
  useEffect(() => {
    const claim = (e) => setRouteTarget(frame.current && frame.current.contains(e.target) ? navigate : null);
    document.addEventListener("pointerdown", claim, true);
    document.addEventListener("focusin", claim, true);
    return () => { document.removeEventListener("pointerdown", claim, true); document.removeEventListener("focusin", claim, true); setRouteTarget(null); };
  }, [navigate]);
  const onClickCapture = (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest("a[href]");
    if (!a || a.target === "_blank") return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) { e.preventDefault(); navigate(href); }
  };
  // Scrolling or clicking in the frame during a run means the viewer is exploring: stop following.
  const takeOver = () => { if (orc.state === "running" || orc.state === "paused") setFollow(false); };

  const find = (sel) => {
    for (const s of [].concat(sel)) {
      try { const el = frame.current && frame.current.querySelector(".orc-wb-scroll " + s); if (el) return el; } catch { /* not a selector here */ }
    }
    return null;
  };
  const moveCursor = (el, agent, click) => {
    if (!frame.current) return;
    const b = frame.current.getBoundingClientRect(), r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    const x = Math.max(6, Math.min(b.width - 30, r.left - b.left + Math.min(r.width * 0.5, 90)));
    const y = Math.max(40, Math.min(b.height - 30, r.top - b.top + Math.min(r.height * 0.5, 22)));
    setCursor((c) => ({ x, y, agent, clicks: (c ? c.clicks : 0) + (click ? 1 : 0), click }));
  };

  // Play the agents' presentation steps: navigate, type, point and click — at the run's speed.
  useEffect(() => presenter.attach(async ({ steps, agent }, backlog) => {
    const k = (ms) => ms / Math.max(0.25, speedRef.current) / (backlog > 2 ? 2.5 : 1);
    setActor(agent);
    for (const s of steps) {
      if (s.set) { scope.set(s.set, s.value); continue; }
      if (s.gate) continue;
      if (s.route) {
        lastRoute.current = "#" + s.route;
        if (followRef.current) { navigate("#" + s.route); await wait(k(460)); }
        continue;
      }
      if (!followRef.current) continue;
      if (s.type) {
        const input = find(".lex-search input");
        if (input) moveCursor(input, agent, false);
        for (let i = 1; i <= s.text.length; i++) { scope.set(s.type, s.text.slice(0, i)); await wait(k(30)); }
        await wait(k(300));
        continue;
      }
      if (s.focus) {
        const el = find(s.focus);
        if (!el) continue;
        if (el.tagName === "DETAILS" && s.click) el.open = true;
        el.scrollIntoView({ block: "center", behavior: speedRef.current > 2 ? "auto" : "smooth" });
        await wait(k(420));
        moveCursor(el, agent, !!s.click);
        el.classList.add("orc-hit");
        setTimeout(() => el.classList.remove("orc-hit"), 1700);
        await wait(k(s.click ? 900 : 700));
      }
    }
  }), [presenter, navigate, scope]);

  const [view, detail] = where(route, world);
  const a = actor && agentById.get(actor);
  const working = orc.state === "running" || orc.state === "paused";
  const gate = world.gate && world.gate.status === "pending" ? world.gate : null;
  const ca = cursor && agentById.get(cursor.agent);
  return (
    <div className="orc-wb" ref={frame} style={a ? { "--ac": a.color } : undefined}>
      <div className="orc-wb-bar">
        <span className="orc-dots" aria-hidden="true"><i /><i /><i /></span>
        <span className="orc-loc"><Icon name="monitor" size={14} /><b>{view}</b>{detail ? <span className="ellipsis">› {detail}</span> : null}</span>
        {a && working ? <span className="orc-actor"><Avatar p={{ name: a.name, color: a.color }} size={18} />{a.name}</span> : null}
        <span className="spacer" />
        {working || orc.state === "gate" ? (follow ? <span className="tiny muted nowrap">Following the agents</span>
          : <button className="btn sm" onClick={() => { setFollow(true); navigate(lastRoute.current); }}><Icon name="eye" />Follow the agents</button>) : <span className="tiny muted nowrap">Sandbox · explore freely</span>}
      </div>
      <div className="orc-wb-scroll view" ref={scroller} onClickCapture={onClickCapture} onWheel={takeOver} onPointerDown={takeOver}>
        <StoreScope.Provider value={scope}>
          <Drive.Provider value={drive}>
            <CapsContext.Provider value={caps}>
              <ViewFor route={route} />
            </CapsContext.Provider>
          </Drive.Provider>
        </StoreScope.Provider>
      </div>
      {cursor && ca ? (
        <div className={cx("orc-cursor", !follow && "away")} style={{ transform: `translate(${cursor.x}px, ${cursor.y}px)`, "--ac": ca.color }} aria-hidden="true">
          <svg viewBox="0 0 24 24" width="22" height="22"><path d="M4 2.5l15 8.6-6.6 1.6 3.8 7.3-2.6 1.3-3.8-7.3L4 18.6z" /></svg>
          <span className="orc-tag">{ca.name}</span>
          {cursor.clicks ? <span key={cursor.clicks} className="orc-ripple" /> : null}
        </div>
      ) : null}
      {gate ? (
        <div className="orc-gatebar" role="alert">
          <Icon name="shield" />
          <span className="grow"><b>The Conductor asks you to approve {gate.calls.length} staged call{gate.calls.length === 1 ? "" : "s"}.</b> <span className="muted">Nothing is sent from this page.</span></span>
          <button className="btn sm" onClick={() => orc.decide("declined")}>Decline</button>
          <button className="btn sm primary" onClick={() => orc.decide("approved")}><Icon name="check" />Approve</button>
        </div>
      ) : null}
    </div>
  );
}
