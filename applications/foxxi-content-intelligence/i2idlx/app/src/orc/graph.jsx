// The context graph the team builds: the organization's records, the I2IDL concepts that classify them,
// the referent categories those bring (and so the upper-ontology classes), and the peer classes crosswalk
// bridges reach. Recomputed from the sandbox with the same classifier the agents run.
import { byId } from "../data.js";
import { catById, bridgesOf, labelOf, columnOf, COLUMNS } from "../semantic.js";
import { cx } from "../util.js";
import { runClassifier, liveRecords, iriOfRecord, ratifiedBridges } from "./world.js";

const { useMemo, useRef, useLayoutEffect, useState, useEffect } = React;
const COLUMN_LABEL = Object.fromEntries(COLUMNS.map((c) => [c.id, c.label]));
const SHORT = { bfo: "BFO · IAO", cco: "CCO", gist: "gist", dul: "DUL", gufo: "gUFO", prov: "PROV-O", schema: "schema.org", peer: "peers" };

function model(world) {
  const out = runClassifier(world);
  const res = new Map(out.resources.map((r) => [r.iri, r]));
  const ratified = ratifiedBridges(world);
  const recs = [], concepts = new Map(), cats = new Map(), peers = new Map(), edges = [];
  for (const r of liveRecords(world)) {
    const x = res.get(iriOfRecord(r.id));
    const clashing = new Set(x ? x.clashes.flatMap((c) => [c.a, c.b]) : []);
    recs.push({ id: r.id, label: r.title, status: r.status, gap: world.gaps.has(r.id), clash: clashing.size > 0, split: !!r.from });
    for (const b of x ? x.by : []) {
      concepts.set(b.c, { id: b.c, label: byId.get(b.c).l, k: byId.get(b.c).k, cat: byId.get(b.c).rc });
      edges.push({ a: "r:" + r.id, b: "c:" + b.c, kind: clashing.has(b.c) ? "clash" : b.how === "bridge" ? "inferred" : "stated" });
    }
    for (const t of r.sourceTypes) {
      peers.set(t, { t, label: labelOf(t), kind: "source" });
      edges.push({ a: "r:" + r.id, b: "p:" + t, kind: "source" });
    }
  }
  for (const c of concepts.values()) {
    const cat = catById.get(c.cat);
    cats.set(cat.id, { id: cat.id, label: cat.label });
    edges.push({ a: "c:" + c.id, b: "k:" + cat.id, kind: "category" });
    for (const b of bridgesOf(c.id).filter((x) => x.k === "exact" || x.k === "broad")) {
      if (!peers.has(b.t)) peers.set(b.t, { t: b.t, label: labelOf(b.t), kind: "bridge" });
      edges.push({ a: "c:" + c.id, b: "p:" + b.t, kind: "bridge" });
    }
    for (const b of ratified.filter((x) => x.c === c.id && (x.k === "exact" || x.k === "broad"))) {
      peers.set(b.t, { t: b.t, label: labelOf(b.t), kind: "ratified" });
      edges.push({ a: "c:" + c.id, b: "p:" + b.t, kind: "ratified" });
    }
  }
  const byOnt = {};
  for (const r of out.resources) for (const x of r.classes) {
    const col = columnOf(x.t) === "foxxi" ? "peer" : columnOf(x.t);
    if (!COLUMN_LABEL[col]) continue;
    byOnt[col] = (byOnt[col] || 0) + 1;
  }
  return { recs, concepts: [...concepts.values()], cats: [...cats.values()], peers: [...peers.values()], edges, typings: out.typings, clashes: out.clashes, byOnt };
}

export function ContextGraph({ world, version, onShow }) {
  const m = useMemo(() => model(world), [world, version]);
  const box = useRef(null);
  const [paths, setPaths] = useState([]);
  const [size, setSize] = useState(0);
  useEffect(() => {
    if (!box.current || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(() => setSize(box.current ? box.current.clientWidth : 0));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const b = el.getBoundingClientRect();
    const pos = new Map();
    for (const n of el.querySelectorAll("[data-node]")) {
      const r = n.getBoundingClientRect();
      pos.set(n.getAttribute("data-node"), { l: r.left - b.left, r: r.right - b.left, y: r.top - b.top + r.height / 2 });
    }
    setPaths(m.edges.map((e, i) => {
      const a = pos.get(e.a), z = pos.get(e.b);
      if (!a || !z) return null;
      const x1 = a.r, x2 = z.l, dx = Math.max(24, (x2 - x1) * 0.45);
      return { i, kind: e.kind, d: `M${x1},${a.y} C${x1 + dx},${a.y} ${x2 - dx},${z.y} ${x2},${z.y}` };
    }).filter(Boolean));
  }, [m, size]);

  if (!m.recs.some((r) => r.status !== "unclassified")) {
    return <div className="empty"><b>Nothing classified yet</b><div className="small">As the Lexicographer classifies the inventory, its records, the I2IDL concepts and what they bring appear here.</div></div>;
  }
  const total = Object.values(m.byOnt).reduce((a, b) => a + b, 0) || 1;
  return (
    <div className="orc-graph">
      <div className="og-stats small">
        <b>{m.typings}</b> typings · {m.clashes ? <b className="bad">{m.clashes} contradiction{m.clashes === 1 ? "" : "s"}</b> : "no contradictions"} · {m.recs.filter((r) => r.gap).length} gap{m.recs.filter((r) => r.gap).length === 1 ? "" : "s"}
      </div>
      <div className="og-canvas" ref={box}>
        <svg className="og-edges" aria-hidden="true">{paths.map((p) => <path key={p.i} d={p.d} className={"oe " + p.kind} />)}</svg>
        <div className="og-col">
          <div className="og-h">{m.recs.length} records</div>
          {m.recs.map((r) => (
            <div key={r.id} data-node={"r:" + r.id} className={cx("og-n rec", r.clash && "clash", r.gap && "gap", r.status === "unclassified" && "un", r.split && "split")} title={r.gap ? "No fitting I2IDL concept: flagged for I2IDL's editors" : r.label}>
              <span className="ellipsis">{r.label}</span>
            </div>
          ))}
        </div>
        <div className="og-col">
          <div className="og-h">{m.concepts.length} I2IDL concepts</div>
          {m.concepts.map((c) => (
            <button key={c.id} type="button" data-node={"c:" + c.id} className="og-n con" onClick={() => onShow && onShow("#c-" + c.id)} title={`${c.label} — show it in the workbench`}>
              <span className={"dot kd-" + c.k} /><span className="ellipsis">{c.label}</span>
            </button>
          ))}
        </div>
        <div className="og-col">
          <div className="og-h">{m.cats.length} categories · {m.peers.length} peer classes</div>
          {m.cats.map((k) => (
            <button key={k.id} type="button" data-node={"k:" + k.id} className="og-n cat" onClick={() => onShow && onShow("#semantic-cat." + k.id)} title={`${k.label} — its classes in every ontology`}>
              <span className="ellipsis">{k.label}</span>
            </button>
          ))}
          {m.peers.map((p) => (
            <div key={p.t} data-node={"p:" + p.t} className={cx("og-n peer", p.kind)} title={p.kind === "source" ? `${p.t}: the organization's own typing` : p.kind === "ratified" ? `${p.t}: a crosswalk ratified in this run (sandbox)` : `${p.t}: a published crosswalk bridge (Hypothetical)`}>
              <code className="ellipsis">{p.t}</code>
            </div>
          ))}
        </div>
      </div>
      <div className="og-onts" aria-label="Typings by ontology">
        {COLUMNS.map((c) => m.byOnt[c.id] ? (
          <span key={c.id} className="og-ont" style={{ flexGrow: m.byOnt[c.id] / total }} title={`${c.label}: ${m.byOnt[c.id]} typings`}>
            <span>{SHORT[c.id] || c.label}</span><b className="num">{m.byOnt[c.id]}</b>
          </span>
        ) : null)}
      </div>
      <div className="og-legend tiny muted">
        <span><i className="oe-k stated" />classified by</span><span><i className="oe-k inferred" />inferred through a bridge</span>
        <span><i className="oe-k clash" />contradiction</span><span><i className="oe-k bridge" />published crosswalk (Hypothetical)</span>
        <span><i className="oe-k ratified" />ratified in this run</span>
      </div>
    </div>
  );
}
