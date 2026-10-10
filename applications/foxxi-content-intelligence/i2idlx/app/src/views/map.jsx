// The map: the whole glossary as a territory (fields are regions, laid out once at build time),
// a focused neighborhood, and the path between any two terms.
import { C, KINDS, LAYOUT, COLLECTIONS, byId, kindById, fieldById, degree, ADJ, shortestPaths, relationBetween } from "../data.js";
import { Icon } from "../icons.jsx";
import { ConceptChip, Seg, useUI } from "../ui.jsx";
import { ConceptPicker } from "../picker.jsx";
import { useWidth } from "../charts.jsx";
import { cx, go, useStored } from "../util.js";

import { OriginStrip } from "../origin.jsx";
const { useState, useEffect, useMemo, useRef, useCallback } = React;

export function MapView({ route }) {
  const mode = route.mode || "whole";
  const setMode = (m) => {
    if (m === "whole") go("whole" + (route.id ? "-" + route.id : ""));
    else if (m === "neighborhood") go("map-" + (route.id || route.a || "learning-engineering"));
    else go("path-" + (route.id || route.a || "") + "~" + (route.b || ""));
  };
  return (
    <div className="mapv">
      <div className="mapbar">
        <Seg label="Map mode" value={mode} onChange={setMode} options={[
          { v: "whole", l: "Whole glossary", icon: "globe" }, { v: "neighborhood", l: "Neighborhood", icon: "graph" }, { v: "path", l: "Path", icon: "route" },
        ]} />
        <span className="spacer" />
        <span className="mapstrip"><OriginStrip items={[["i2idl", "relations and fields"], ["derived", "layout and kinds"]]} /></span>
        {mode !== "path" ? <div style={{ width: "min(320px, 100%)" }}><ConceptPicker small placeholder="Find on the map…" onPick={(id) => go((mode === "whole" ? "whole-" : "map-") + id)} /></div> : null}
      </div>
      {mode === "whole" ? <WholeMap focus={route.id} /> : mode === "neighborhood" ? <Neighborhood id={route.id} /> : <PathView a={route.a} b={route.b} />}
    </div>
  );
}

// ── Whole glossary ────────────────────────────────────────────────────────────────────────────────
const EDGES = (() => {
  const out = [];
  for (const c of C) {
    for (const r of c.r) if (c.id < r) out.push({ a: c.id, b: r, t: "r", x: c.pf !== byId.get(r).pf });
    for (const b of c.b) out.push({ a: c.id, b, t: "b", x: c.pf !== byId.get(b).pf });
  }
  return out;
})();
const radius = (c) => 3.2 + Math.sqrt(degree(c)) * 1.25;
const BY_DEGREE = [...C].sort((a, b) => degree(b) - degree(a));

function WholeMap({ focus }) {
  const svgRef = useRef(null);
  const gRef = useRef(null);
  const zoomRef = useRef(null);
  const [k, setK] = useState(1);
  const [s, setS] = useState(0.6); // screen px per layout unit at zoom 1 (viewBox fitted with "meet")
  const [hoverId, setHoverId] = useState(null);
  const [sel, setSel] = useState(focus || null);
  const [hidden, setHidden] = useStored("map.hiddenKinds", []);
  const [field, setField] = useStored("map.field", "");
  const [showRelated, setShowRelated] = useStored("map.related", true);
  const { hover } = useUI();

  useEffect(() => {
    const svg = d3.select(svgRef.current);
    const zoom = d3.zoom().scaleExtent([0.5, 8]).on("zoom", (e) => {
      gRef.current.setAttribute("transform", e.transform.toString());
      const bucket = Math.round(e.transform.k * 4) / 4;
      setK((old) => (old === bucket ? old : bucket));
      hover.now();
    });
    svg.call(zoom).on("dblclick.zoom", null);
    zoomRef.current = zoom;
    const ro = new ResizeObserver(() => {
      const r = svgRef.current.getBoundingClientRect();
      if (r.width && r.height) setS(Math.min(r.width / LAYOUT.w, r.height / LAYOUT.h));
    });
    ro.observe(svgRef.current);
    return () => { svg.on(".zoom", null); ro.disconnect(); };
  }, []);

  const centerOn = useCallback((id, scale = 2.4) => {
    const p = LAYOUT.xy[id];
    if (!p || !svgRef.current) return;
    const { width, height } = svgRef.current.getBoundingClientRect();
    const vb = fitBox(width, height);
    // convert layout coords to the svg's user space (viewBox = layout box)
    const t = d3.zoomIdentity.translate(vb.cx - p[0] * scale, vb.cy - p[1] * scale).scale(scale);
    d3.select(svgRef.current).transition().duration(600).call(zoomRef.current.transform, t);
  }, []);
  useEffect(() => { if (focus) { setSel(focus); setTimeout(() => centerOn(focus), 50); } }, [focus]);

  const nb = useMemo(() => {
    const id = hoverId || sel;
    if (!id) return null;
    return new Set([id, ...ADJ.get(id).map(([x]) => x)]);
  }, [hoverId, sel]);
  const fieldSet = field ? new Set(C.filter((c) => c.f.includes(field)).map((c) => c.id)) : null;
  const hiddenSet = new Set(hidden);
  const visible = (c) => !hiddenSet.has(c.k);
  const z = (s * k) / 0.6; // effective zoom relative to a ~1000px-wide map
  const labelCut = z < 0.8 ? 8 : z < 1.2 ? 16 : z < 1.8 ? 32 : z < 2.6 ? 70 : z < 4 ? 150 : 400;
  const px = (n) => n / (s * k); // screen pixels → layout units at the current zoom
  const rad = (c) => radius(c) / (s * Math.sqrt(k));
  const labeled = new Set(BY_DEGREE.slice(0, labelCut).map((c) => c.id));
  const selC = sel ? byId.get(sel) : null;

  return (
    <div className="mapwrap">
      <svg ref={svgRef} viewBox={`0 0 ${LAYOUT.w} ${LAYOUT.h}`} preserveAspectRatio="xMidYMid meet" role="img"
        aria-label={`Map of ${C.length} terms in ${COLLECTIONS.field.length} fields`} onClick={(e) => { if (e.target === svgRef.current) setSel(null); }}>
        <g ref={gRef} style={{ "--k": k }}>
          {LAYOUT.regions.map((r) => (
            <text key={r.f} className="region" x={r.x} y={r.y} textAnchor="middle" style={{ fontSize: Math.max(10, Math.min(19, 30 * s)) / (s * Math.sqrt(k)) }}
              opacity={field && field !== r.f ? 0.05 : undefined}>{fieldById.get(r.f).label}</text>
          ))}
          {EDGES.map((e, i) => {
            if (e.t === "r" && !showRelated) return null;
            const A = byId.get(e.a), B = byId.get(e.b);
            if (!visible(A) || !visible(B)) return null;
            const pa = LAYOUT.xy[e.a], pb = LAYOUT.xy[e.b];
            const on = nb && (e.a === (hoverId || sel) || e.b === (hoverId || sel));
            const dim = (nb && !on) || (fieldSet && !(fieldSet.has(e.a) && fieldSet.has(e.b)));
            return <line key={i} className={cx("edge", e.t === "b" && "b", e.x && !on && "x", on && "on", dim && "dim")} x1={pa[0]} y1={pa[1]} x2={pb[0]} y2={pb[1]} vectorEffect="non-scaling-stroke" />;
          })}
          {C.map((c) => {
            if (!visible(c)) return null;
            const p = LAYOUT.xy[c.id];
            const dim = (nb && !nb.has(c.id)) || (fieldSet && !fieldSet.has(c.id));
            return (
              <circle key={c.id} className={cx("node", "kd-" + c.k, dim && "dim", sel === c.id && "sel")} cx={p[0]} cy={p[1]} r={rad(c)}
                style={{ fill: `var(--k-${c.k})` }} vectorEffect="non-scaling-stroke"
                onMouseEnter={(e) => { setHoverId(c.id); hover.show(c.id, e.currentTarget); }} onMouseLeave={() => { setHoverId(null); hover.hide(); }}
                onClick={(e) => { e.stopPropagation(); setSel(c.id); }} onDoubleClick={() => go("c-" + c.id)}
                tabIndex={0} role="button" aria-label={c.l} onKeyDown={(e) => { if (e.key === "Enter") setSel(c.id); }} />
            );
          })}
          {placeLabels({ visible, labeled, hoverId, sel, nb, k, px, rad }).map(({ c, x, y, big }) => {
            const dim = (nb && !nb.has(c.id)) || (fieldSet && !fieldSet.has(c.id));
            return <text key={c.id} className={cx("nlabel", big && "big", dim && "dim")} x={x} y={y}
              textAnchor="middle" style={{ fontSize: px(big ? 13 : 11), strokeWidth: px(3) }}>{c.l.length > 34 ? c.l.slice(0, 32) + "…" : c.l}</text>;
          })}
        </g>
      </svg>
      <div className="maplegend" role="group" aria-label="Kinds (click to hide or show)">
        {KINDS.map((kd) => (
          <button key={kd.id} aria-pressed={!hiddenSet.has(kd.id)} onClick={() => setHidden((h) => (h.includes(kd.id) ? h.filter((x) => x !== kd.id) : [...h, kd.id]))} title={kd.def}>
            <span className={"dot kd-" + kd.id} />{kd.label}
          </button>
        ))}
        <select className="select" style={{ height: 24, width: "auto", fontSize: 12, padding: "0 6px" }} value={field} onChange={(e) => setField(e.target.value)} aria-label="Highlight a field">
          <option value="">All fields</option>
          {COLLECTIONS.field.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
        </select>
        <label className="check tiny" style={{ padding: "0 6px" }}><input type="checkbox" checked={showRelated} onChange={(e) => setShowRelated(e.target.checked)} />related links</label>
      </div>
      <div className="zoomctl no-print">
        <button className="btn icon" onClick={() => d3.select(svgRef.current).transition().call(zoomRef.current.scaleBy, 1.5)} aria-label="Zoom in"><Icon name="plus" /></button>
        <button className="btn icon" onClick={() => d3.select(svgRef.current).transition().call(zoomRef.current.scaleBy, 1 / 1.5)} aria-label="Zoom out"><Icon name="minus" /></button>
        <button className="btn icon" onClick={() => d3.select(svgRef.current).transition().call(zoomRef.current.transform, d3.zoomIdentity)} aria-label="Reset view"><Icon name="refresh" /></button>
      </div>
      {selC ? <MapSide c={selC} onClose={() => setSel(null)} /> : null}
    </div>
  );
}

/** Greedy label placement: selected and hovered first, then by degree; skip any label that would overlap. */
function placeLabels({ visible, labeled, hoverId, sel, nb, k, px, rad }) {
  const want = [];
  const push = (c, big) => { if (c && visible(c) && !want.some((w) => w.c.id === c.id)) want.push({ c, big }); };
  push(sel && byId.get(sel), true);
  push(hoverId && byId.get(hoverId), true);
  if (nb && k >= 1.5) for (const id of nb) push(byId.get(id), false);
  for (const c of BY_DEGREE) if (labeled.has(c.id)) push(c, false);
  const boxes = [], out = [];
  for (const { c, big } of want) {
    const p = LAYOUT.xy[c.id];
    const label = c.l.length > 34 ? 33 : c.l.length;
    const w = px(label * (big ? 7.4 : 6.3) + 6), h = px(big ? 16 : 14);
    const x = p[0], y = p[1] - rad(c) - px(5);
    const b = { l: x - w / 2, r: x + w / 2, t: y - h, b: y + px(3) };
    const forced = big;
    if (!forced && boxes.some((o) => !(b.r < o.l || b.l > o.r || b.b < o.t || b.t > o.b))) continue;
    boxes.push(b);
    out.push({ c, x, y, big });
  }
  return out;
}

function fitBox(width, height) {
  // user-space center of the viewBox as it is fitted (xMidYMid meet)
  return { cx: LAYOUT.w / 2, cy: LAYOUT.h / 2 };
}

function MapSide({ c, onClose }) {
  return (
    <div className="mapside">
      <div className="row"><span className={"dot kd-" + c.k} /><span className="small muted grow">{kindById.get(c.k).label} · {fieldById.get(c.pf).label}</span>
        <button className="btn ghost sm icon" onClick={onClose} aria-label="Close"><Icon name="x" /></button></div>
      <h3>{c.l}</h3>
      <p>{c.d}</p>
      {c.r.length || c.b.length || c.n.length ? <div className="chips">{[...c.b, ...c.n, ...c.r].slice(0, 12).map((x) => <ConceptChip key={x} id={x} />)}</div> : null}
      <div className="row wrap">
        <a className="btn sm primary" href={"#c-" + c.id}>Open entry</a>
        <a className="btn sm" href={"#map-" + c.id}><Icon name="graph" />Neighborhood</a>
        <a className="btn sm" href={"#path-" + c.id + "~"}><Icon name="route" />Path from here</a>
      </div>
    </div>
  );
}

// ── Neighborhood (radial, deterministic) ─────────────────────────────────────────────────────────
function Neighborhood({ id }) {
  const c = byId.get(id);
  const [depth, setDepth] = useStored("map.depth", 1);
  const { hover } = useUI();
  const layout = useMemo(() => (c ? radial(c, depth) : null), [id, depth]);
  const [wrapRef, wrapW] = useWidth(200);
  if (!c) return <div className="page"><div className="note"><Icon name="info" />Pick a term to see its neighborhood.</div></div>;
  const { nodes, edges, box } = layout;
  const narrow = wrapW < 620;
  const groups = [["Broader", c.b], ["Narrower", c.n], ["Related", c.r]].filter(([, l]) => l.length);
  return (
    <div className="nb">
      <div className="mapwrap" ref={wrapRef}>
        <svg viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`} role="img" aria-label={`Neighborhood of ${c.l}`} style={{ cursor: "default" }}>
          {edges.map((e, i) => {
            const a = nodes.get(e.a), b = nodes.get(e.b);
            return <line key={i} className={cx("edge", e.t !== "r" && "b")} x1={a.x} y1={a.y} x2={b.x} y2={b.y} strokeWidth={e.t !== "r" ? 2 : 1.3} style={{ opacity: e.d === 2 ? 0.5 : 1 }} />;
          })}
          {[...nodes.values()].map((n) => {
            const nc = byId.get(n.id);
            const center = n.id === c.id;
            const r = center ? 16 : n.d === 1 ? 9 : 6;
            const cos = Math.cos(n.t || 0), sin = Math.sin(n.t || 0);
            const side = center ? "middle" : cos > 0.28 ? "start" : cos < -0.28 ? "end" : "middle";
            const max = side === "middle" ? 22 : 32;
            const lx = center ? 0 : side === "middle" ? 0 : cos * (r + 6);
            const ly = center ? r + 20 : side === "middle" ? (sin < 0 ? -(r + 8) - (n.stagger ? 15 : 0) : r + 16 + (n.stagger ? 15 : 0)) : sin * (r + 6) + 4;
            return (
              <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: "pointer" }} tabIndex={0} role="link" aria-label={nc.l}
                onClick={() => go(center ? "c-" + n.id : "map-" + n.id)} onKeyDown={(e) => { if (e.key === "Enter") go(center ? "c-" + n.id : "map-" + n.id); }}
                onMouseEnter={(e) => hover.show(n.id, e.currentTarget)} onMouseLeave={hover.hide}>
                <circle r={r} className="node" style={{ fill: `var(--k-${nc.k})`, opacity: n.d === 2 ? 0.75 : 1 }} />
                {!narrow || center ? (
                  <text className={cx("nlabel", center && "big")} x={lx} y={ly} textAnchor={side} style={{ fontSize: narrow ? 30 : center ? 17 : n.d === 1 ? 13 : 11 }}>
                    {nc.l.length > max ? nc.l.slice(0, max - 2) + "…" : nc.l}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
        <div className="maplegend">
          <Seg label="Depth" value={depth} onChange={setDepth} options={[{ v: 1, l: "1 step" }, { v: 2, l: "2 steps" }]} />
          <span className="small muted" style={{ alignSelf: "center", padding: "0 6px" }}>{narrow ? "Tap a dot to move there." : "Thick lines: broader / narrower."}</span>
        </div>
      </div>
      <aside className="nbside">
        <div className="row"><span className={"dot kd-" + c.k} /><span className="small muted grow">{kindById.get(c.k).label} · {fieldById.get(c.pf).label}</span></div>
        <h3>{c.l}</h3>
        <p>{c.d}</p>
        <div className="row wrap">
          <a className="btn sm primary" href={"#c-" + c.id}>Open entry</a>
          <a className="btn sm" href={"#whole-" + c.id}><Icon name="globe" />On the map</a>
          <a className="btn sm" href={"#path-" + c.id + "~"}><Icon name="route" />Path from here</a>
        </div>
        {groups.map(([lab, list]) => (
          <div key={lab} className="stack" style={{ gap: 6 }}>
            <div className="eyebrow">{lab} · {list.length}</div>
            <div className="chips">{list.map((x) => <a key={x} className="cchip" href={"#map-" + x}><span className={"dot kd-" + byId.get(x).k} /><span className="lbl">{byId.get(x).l}</span></a>)}</div>
          </div>
        ))}
        <p className="tiny muted">Click any term to move the neighborhood there; click the center to open its entry.</p>
      </aside>
    </div>
  );
}

function radial(c, depth) {
  const nodes = new Map([[c.id, { id: c.id, x: 0, y: 0, d: 0, t: 0 }]]);
  const edges = [];
  const rel = c.r.map((x) => [x, "r"]);
  const half = Math.ceil(rel.length / 2);
  // broader centered on top, then related down the right, narrower at the bottom, related up the left
  const ring = [...c.b.map((x) => [x, "b"]), ...rel.slice(0, half), ...c.n.map((x) => [x, "n"]), ...rel.slice(half)];
  const N = Math.max(ring.length, 1);
  const step = (2 * Math.PI) / N;
  const R1 = Math.max(190, N * 27);
  const t0 = -Math.PI / 2 - ((c.b.length ? c.b.length : 1) - 1) * step / 2;
  let lastMiddle = -9;
  ring.forEach(([x, r], i) => {
    const t = t0 + i * step;
    const mid = Math.abs(Math.cos(t)) <= 0.28;
    const stagger = mid && i - lastMiddle === 1;
    if (mid) lastMiddle = stagger ? -9 : i;
    nodes.set(x, { id: x, x: R1 * Math.cos(t), y: R1 * Math.sin(t), d: 1, rel: r, t, stagger });
    edges.push({ a: c.id, b: x, t: r, d: 1 });
  });
  if (depth >= 2) {
    const R2 = R1 + 190;
    for (const [x] of ring) {
      const parent = nodes.get(x);
      const kids = ADJ.get(x).filter(([y]) => !nodes.has(y)).slice(0, 5);
      const spread = Math.min(step * 0.9, 0.11 * (kids.length - 1));
      kids.forEach(([y, r], i) => {
        const t = parent.t - spread / 2 + (kids.length > 1 ? (spread * i) / (kids.length - 1) : 0);
        nodes.set(y, { id: y, x: R2 * Math.cos(t), y: R2 * Math.sin(t), d: 2, rel: r, t });
        edges.push({ a: x, b: y, t: r, d: 2 });
      });
    }
  }
  // links among the shown neighbors
  const seen = new Set(edges.map((e) => [e.a, e.b].sort().join("|")));
  for (const n of nodes.values()) for (const [y, r] of ADJ.get(n.id)) {
    const k = [n.id, y].sort().join("|");
    if (nodes.has(y) && !seen.has(k)) { seen.add(k); edges.push({ a: n.id, b: y, t: r, d: 2 }); }
  }
  const xs = [...nodes.values()].map((n) => n.x), ys = [...nodes.values()].map((n) => n.y);
  const padX = 230, padY = 70;
  const box = { x: Math.min(...xs) - padX, y: Math.min(...ys) - padY, w: Math.max(...xs) - Math.min(...xs) + 2 * padX, h: Math.max(...ys) - Math.min(...ys) + 2 * padY };
  if (box.w < 640) { box.x -= (640 - box.w) / 2; box.w = 640; }
  if (box.h < 460) { box.y -= (460 - box.h) / 2; box.h = 460; }
  return { nodes, edges, box };
}

// ── Path between two terms ───────────────────────────────────────────────────────────────────────
function PathView({ a, b }) {
  const A = a && byId.get(a), B = b && byId.get(b);
  const paths = useMemo(() => (A && B ? shortestPaths(A.id, B.id, 4) : []), [a, b]);
  const set = (x, y) => go("path-" + (x || "") + "~" + (y || ""));
  return (
    <div className="view" style={{ overflow: "auto" }}>
      <div className="page stack" style={{ gap: 18 }}>
        <div className="stack" style={{ gap: 6 }}>
          <h1 className="h-display" style={{ fontSize: 26 }}>How are two terms connected?</h1>
          <p className="muted">Shortest routes through I2IDL's editorial links (related, broader, narrower).</p>
        </div>
        <div className="qparams" style={{ maxWidth: 720 }}>
          <label className="field"><span>From</span><ConceptPicker value={a} onPick={(x) => set(x, b)} placeholder="First term…" /></label>
          <label className="field"><span>To</span><ConceptPicker value={b} onPick={(y) => set(a, y)} placeholder="Second term…" /></label>
        </div>
        {A && B ? (
          paths.length ? (
            <div className="stack">
              <div className="note"><Icon name="route" /><span><b>{A.l}</b> reaches <b>{B.l}</b> in {paths[0].length - 1} step{paths[0].length > 2 ? "s" : ""}{paths.length > 1 ? `; ${paths.length === 4 ? "at least " : ""}${paths.length} equally short routes` : ""}.</span></div>
              {paths.map((p, i) => (
                <div className="route" key={i}>
                <div className="eyebrow">Route {i + 1}</div>
                <div className="path">
                  {p.map((id, j) => {
                    const c = byId.get(id);
                    const rel = j < p.length - 1 ? relationBetween(id, p[j + 1]) : null;
                    return (
                      <React.Fragment key={id}>
                        <a className="pstep" href={"#c-" + id} style={{ textDecoration: "none", color: "inherit" }}>
                          <div className="row small muted"><span className={"dot kd-" + c.k} />{kindById.get(c.k).label}</div>
                          <h4>{c.l}</h4><p>{c.d}</p>
                        </a>
                        {rel ? <div className="plink"><span>{rel === "related" ? "related to" : rel === "narrower" ? "narrower than" : "broader than"}</span><Icon name="arrowRight" /></div> : null}
                      </React.Fragment>
                    );
                  })}
                </div>
                </div>
              ))}
              <div className="row wrap"><a className="btn sm" href={`#cmp-${A.id}~${B.id}`}><Icon name="compare" />Compare side by side</a></div>
            </div>
          ) : <div className="note"><Icon name="info" />No route links these two terms in this release.</div>
        ) : <div className="muted small">Pick two terms.</div>}
      </div>
    </div>
  );
}
