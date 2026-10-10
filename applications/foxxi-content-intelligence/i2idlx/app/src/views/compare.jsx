// Compare two or three terms side by side, with how they relate.
import { byId, kindById, typeById, fieldById, curatedById, SOURCES, ACTIONS, roleById, enactByConcept, mapsByConcept, shortestPaths, relationBetween, directSources } from "../data.js";
import { Icon } from "../icons.jsx";
import { ConceptChip, RightsBadge, useUI } from "../ui.jsx";
import { ConceptPicker } from "../picker.jsx";
import { Hypertext } from "../text.jsx";
import { go } from "../util.js";

import { OriginStrip } from "../origin.jsx";
const { useMemo } = React;

export function Compare({ route }) {
  const ids = (route.ids || []).filter((id) => byId.has(id)).slice(0, 3);
  const cs = ids.map((id) => byId.get(id));
  const { ask } = useUI();
  const set = (next) => go("cmp-" + next.filter(Boolean).join("~"));
  const suggestions = useMemo(() => {
    if (cs.length !== 1) return [];
    return cs[0].r.slice(0, 6);
  }, [ids.join("~")]);
  const n = Math.max(cs.length, 1);
  const shared = (key) => {
    if (cs.length < 2) return new Set();
    const sets = cs.map((c) => new Set(c[key]));
    return new Set([...sets[0]].filter((x) => sets.every((s) => s.has(x))));
  };
  const sharedRel = shared("r");
  const sharedFields = shared("f");
  return (
    <div className="page cmp">
      <div className="stack" style={{ gap: 6 }}>
        <h1 className="h-display" style={{ fontSize: 26 }}>Compare</h1>
        <p className="muted">Up to three terms side by side: definitions, evidence, links and what enacts each.</p>
        <OriginStrip items={[["i2idl", "definitions, evidence, relations"], ["derived", "kind, provenance"], ["proposed", "enactments"]]} />
      </div>
      <div className="qparams" style={{ maxWidth: 900 }}>
        {[0, 1, 2].map((i) => (
          <label className="field" key={i}><span>{["First", "Second", "Third (optional)"][i]}</span>
            <div className="row">
              <div className="grow"><ConceptPicker value={ids[i]} exclude={ids} onPick={(x) => { const next = [...ids]; next[i] = x; set(next); }} placeholder="Pick a term…" /></div>
              {ids[i] ? <button className="btn ghost sm icon" onClick={() => set(ids.filter((_, j) => j !== i))} aria-label="Remove"><Icon name="x" /></button> : null}
            </div>
          </label>
        ))}
      </div>
      {suggestions.length ? (
        <div className="row wrap"><span className="small muted">Compare with a related term:</span>{suggestions.map((x) => <button key={x} className="chip" onClick={() => set([ids[0], x])}><span className={"dot kd-" + byId.get(x).k} />{byId.get(x).l}</button>)}</div>
      ) : null}
      {cs.length >= 2 ? <RelationBanner cs={cs} sharedRel={sharedRel} sharedFields={sharedFields} /> : null}
      {cs.length >= 2 && ask ? (
        <div className="row wrap">
          <button className="btn sm" onClick={() => ask.open(`Contrast ${cs.map((c) => `“${c.l}”`).join(" and ")}: where do they overlap, where do they differ, and when should a course designer use each? Cite the glossary.`, cs.map((c) => c.id))}><Icon name="sparkle" />Ask Claude to contrast them</button>
        </div>
      ) : null}
      {cs.length ? (
        <div className="cmp-grid" style={{ "--n": n }}>
          <Row label="" cs={cs} render={(c) => (
            <div className="cmp-head stack" style={{ gap: 4 }}>
              <div className="row small muted"><span className={"dot kd-" + c.k} />{kindById.get(c.k).label} · {typeById.get(c.t).label}</div>
              <h3><a href={"#c-" + c.id} style={{ color: "inherit", textDecoration: "none" }}>{c.l}</a></h3>
              {c.a.length ? <div className="small muted">also {c.a.join(", ")}</div> : null}
            </div>
          )} />
          <Row label="Definition" cs={cs} render={(c) => <p className="serif"><Hypertext text={c.d} spans={c.md} /></p>} />
          <Row label="Editorial note" cs={cs} render={(c) => <p className="serif" style={{ fontSize: 15, color: "var(--ink-2)" }}>{c.x}</p>} />
          <Row label="Fields" cs={cs} render={(c) => <div className="chips">{c.f.map((f) => <span key={f} className={"chip" + (sharedFields.has(f) ? " accent" : "")}>{fieldById.get(f).label}</span>)}</div>} />
          <Row label="Broader / narrower" cs={cs} render={(c) => (c.b.length || c.n.length ? <div className="chips">{c.b.map((x) => <ConceptChip key={x} id={x}>↑ {byId.get(x).l}</ConceptChip>)}{c.n.map((x) => <ConceptChip key={x} id={x}>↓ {byId.get(x).l}</ConceptChip>)}</div> : <span className="muted small">—</span>)} />
          <Row label="Related" cs={cs} render={(c) => (c.r.length ? <div className="chips">{c.r.map((x) => <ConceptChip key={x} id={x} shared={sharedRel.has(x)} />)}</div> : <span className="muted small">—</span>)} />
          <Row label="Grounded in" cs={cs} render={(c) => (
            <div className="stack" style={{ gap: 4 }}>
              {directSources(c).map((s) => <div key={s.id} className="row small"><b>{s.label}</b><RightsBadge rc={s.rc} /></div>)}
              {!directSources(c).length ? <span className="muted small">Synthesized from supporting sources</span> : null}
              <span className="tiny muted">{c.ev.length} evidence records</span>
            </div>
          )} />
          <Row label="Enacted by" cs={cs} render={(c) => {
            const en = enactByConcept.get(c.id) || [];
            return en.length ? <div className="stack" style={{ gap: 4 }}>{en.map((e) => <div key={e.id} className="small"><span className="muted">{roleById.get(e.r).by}</span> <b>{ACTIONS[e.a] ? ACTIONS[e.a].t : e.a}</b></div>)}</div> : <span className="muted small">—</span>;
          }} />
          <Row label="Crosswalks" cs={cs} render={(c) => {
            const ms = mapsByConcept.get(c.id) || [];
            return ms.length ? <div className="stack" style={{ gap: 4 }}>{ms.map((m) => <div key={m.id} className="small"><code>{m.p}</code> {m.ol || m.o.split(/[#/]/).pop()} <span className="muted">· {m.v}</span></div>)}</div> : <span className="muted small">—</span>;
          }} />
        </div>
      ) : <div className="empty"><Icon name="compare" /><div><b>Pick terms to compare.</b></div></div>}
    </div>
  );
}

function Row({ label, cs, render }) {
  return (
    <div className="cmp-row">
      <div className="rl">{label}</div>
      {cs.map((c) => <div key={c.id}>{render(c)}</div>)}
    </div>
  );
}

function RelationBanner({ cs, sharedRel, sharedFields }) {
  const [a, b] = cs;
  const rel = relationBetween(a.id, b.id);
  const paths = rel ? [] : shortestPaths(a.id, b.id, 1);
  let what;
  if (rel === "related") what = <><b>{a.l}</b> and <b>{b.l}</b> are related in I2IDL.</>;
  else if (rel === "narrower") what = <><b>{a.l}</b> is narrower than <b>{b.l}</b>.</>;
  else if (rel === "broader") what = <><b>{a.l}</b> is broader than <b>{b.l}</b>.</>;
  else if (paths.length) what = <>No direct link; <b>{a.l}</b> reaches <b>{b.l}</b> in {paths[0].length - 1} steps via {paths[0].slice(1, -1).map((id, i) => <span key={id}>{i ? ", " : ""}<a href={"#c-" + id}>{byId.get(id).l}</a></span>)}.</>;
  else what = <>No route links them in this release.</>;
  return (
    <div className="relation-banner">
      <Icon name="route" /><span className="grow">{what}{cs.length === 2 ? "" : " (first two terms)"}</span>
      {sharedRel.size ? <span>{sharedRel.size} shared related term{sharedRel.size > 1 ? "s" : ""}</span> : null}
      {sharedFields.size ? <span>shared field{sharedFields.size > 1 ? "s" : ""}: {[...sharedFields].map((f) => fieldById.get(f).label).join(", ")}</span> : null}
      <a className="btn sm" href={`#path-${a.id}~${b.id}`}>Show path</a>
    </div>
  );
}
