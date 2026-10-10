// One dictionary entry, in two zones that never mix: the I2IDL record exactly as I2IDL publishes it,
// and what I2IDL-X layers on top (derived reading aids, history, proposals, live capabilities, team use).
import {
  META, byId, kindById, typeById, fieldById, curatedById, SOURCES, ACTIONS, roleById, methodById, RELEASES, C,
  enactByConcept, mapsByConcept, inhByConcept, capsByConcept, suggByConcept, iriOf, controlsFor,
  directSources, reuseClass, RIGHTS, systemLabel, INTERROGATIVES, provenanceLine, collectionLabel,
} from "../data.js";
import { useCaps, useProfiles } from "../caps.js";
import { Icon } from "../icons.jsx";
import {
  ConceptChip, KindBadge, ModalChip, RightsBadge, MethodTag, CopyBtn, CodeBlock, PopButton, Modal, Avatar,
  Meter, useUI,
} from "../ui.jsx";
import { Hypertext } from "../text.jsx";
import { VoteBar, Voters, upstreamIssue } from "../governance.jsx";
import { Origin, ZoneHead } from "../origin.jsx";
import {
  citeText, citeMarkdown, citeBibtex, quoteWithAttribution, newPack, addToPack, usageStatement, usageActCall,
  ADL_VERBS, actQuery, pretty, alignmentTurtle,
} from "../lib.js";
import { cx, go, ago, plural, copyText, store, fmtDate } from "../util.js";
import { catById, classesOf, columnOf, labelOf, bridgesOf, COLUMNS, ancestors } from "../semantic.js";
import { Term } from "./semantic.jsx";
import { consensus } from "../caps.js";

const { useState, useEffect, useMemo } = React;

/** What I2IDL-X adds to one entry, counted (for the collapsed bar and the zone head). */
export function additionsOf(c) {
  const en = (enactByConcept.get(c.id) || []).length, ms = (mapsByConcept.get(c.id) || []).length;
  const inh = (inhByConcept.get(c.id) || []).length, caps = (capsByConcept.get(c.id) || []).length;
  const sugg = (suggByConcept.get(c.id) || []).length;
  const links = (c.md || []).length + (c.mx || []).length;
  const hist = (c.h || []).length;
  const parts = [["provenance line", null, 1], ["kind", null, 1], ["in-text link", "in-text links", links], ["unlinked mention", "unlinked mentions", sugg],
    ["release of history", "releases of history", hist], ["enactment", "enactments", en + inh], ["role capability", "role capabilities", caps],
    ["crosswalk", "crosswalks", ms], ["reference", "references", (c.spec || []).length + (c.exm || []).length],
    ["referent category", null, c.rc ? 1 : 0]];
  return parts.filter(([, , n]) => n).map(([one, many, n]) => [many ? `${n} ${n === 1 ? one : many}` : one, n]);
}

export function Entry({ id, onBack, query }) {
  const c = byId.get(id);
  const { lens, setLens } = useUI();
  useEffect(() => {
    // recents are a per-viewer convenience: browser storage only
    const r = (store.get("recents", []) || []).filter((x) => x !== id);
    store.set("recents", [id, ...r].slice(0, 24));
  }, [id]);
  if (!c) return <div className="entry"><div className="note"><Icon name="warn" />No concept “{id}” in release {META.release}.</div></div>;
  const linked = new Set([...c.r, ...c.b, ...c.n]);
  const x = lens !== "i2idl";
  return (
    <article className="entry" aria-labelledby="hw">
      <EntryHead c={c} onBack={onBack} />
      <div className={cx("entry-body", !x && "solo")}>
        <div className="ed zone z-i2idl">
          <ZoneHead o="i2idl" title="I2IDL record"
            sub={<>As published at <a href={iriOf(c.id)} target="_blank" rel="noopener">id.i2idl.org/concepts/{c.id}</a> in {META.release}. Nothing here is changed.</>} />
          <section className="definition" aria-label="Definition">
            <p className="def">{x ? <Hypertext text={c.d} spans={c.md} linked={linked} query={query} /> : <Hypertext text={c.d} query={query} />}</p>
            <DefMeta c={c} x={x} />
          </section>
          <section className="explain" aria-label="Editorial explanation">
            <div className="subh"><h3>Editorial note</h3><span className="meta">I2IDL's explanation</span></div>
            <p>{x ? <Hypertext text={c.x} spans={c.mx} linked={linked} query={query} /> : <Hypertext text={c.x} query={query} />}</p>
          </section>
          <Relations c={c} />
          <Evidence c={c} />
          {x && ((c.md || []).length || (c.mx || []).length) ? <p className="tiny muted hxnote"><Origin o="derived" quiet>links in the text</Origin> Underlined terms are links I2IDL-X found in I2IDL's wording; dashed ones name a concept I2IDL doesn't relate to this one. Switch to <b>I2IDL only</b> for the plain text.</p> : null}
        </div>
        {x ? (
          <aside className="layers zone z-x" aria-label="What I2IDL-X adds">
            <XHead c={c} />
            <ReadingAids c={c} />
            <Classifies c={c} />
            <History c={c} />
            <Pragmatic c={c} />
            <Crosswalks c={c} />
            <Reference c={c} />
            <Usage c={c} />
            <ForAgents c={c} />
          </aside>
        ) : (
          <aside className="xcollapsed" aria-label="Hidden layers">
            <div className="row"><Icon name="layers" /><b className="grow">I2IDL-X layers hidden</b></div>
            <p className="small muted">On this entry I2IDL-X adds {additionsOf(c).map(([l], i) => <span key={l}>{i ? ", " : ""}{l}</span>)}.</p>
            <button className="btn sm" onClick={() => setLens("x")}><Icon name="eye" />Show I2IDL-X</button>
          </aside>
        )}
      </div>
    </article>
  );
}

function EntryHead({ c, onBack }) {
  const { ws, updateWs } = useCaps();
  const { toast, ask, lens } = useUI();
  const starred = ws.stars.includes(c.id);
  const field = fieldById.get(c.pf);
  const type = typeById.get(c.t);
  const toggleStar = () => {
    updateWs((w) => ({ stars: starred ? w.stars.filter((x) => x !== c.id) : [c.id, ...w.stars] }));
    toast(starred ? "Removed from starred" : "Starred", { icon: "star" });
  };
  return (
    <header className="entry-head">
      <div className="crumbs">
        {onBack ? <button className="btn ghost sm backlink" onClick={onBack}><Icon name="left" />All terms</button> : null}
        <a href={"#browse-f." + field.id}>{field.label}</a><span>·</span><a href={"#browse-t." + type.id}>{type.label}</a>
      </div>
      <h1 className="headword" id="hw">{c.l}</h1>
      {c.a.length ? <div className="alts">also {c.a.map((a, i) => <span key={a}>{i ? ", " : ""}<i>{a}</i></span>)}</div> : null}
      <div className="badges">
        <a className="chip" href={"#browse-t." + type.id} title="I2IDL type collection">{type.label}</a>
        {c.f.map((f) => <a key={f} className={cx("chip", f === c.pf ? "" : "soft")} href={"#browse-f." + f} title={f === c.pf ? "Primary field (I2IDL)" : "Also in this field (I2IDL)"}>{fieldById.get(f).label}</a>)}
        {c.cu.map((cu) => <a key={cu} className="chip accent" href={"#browse-cu." + cu} title={curatedById.get(cu).desc}><Icon name="book" size={12} />{curatedById.get(cu).label}</a>)}
        {lens !== "i2idl" ? <span className="badge-x" title="Agentic kind, derived by I2IDL-X from I2IDL's type"><span className="tiny muted">kind</span><KindBadge k={c.k} /></span> : null}
      </div>
      <div className="entry-actions">
        <button className={cx("btn sm", starred && "on")} onClick={toggleStar} aria-pressed={starred}><Icon name="star" filled={starred} />{starred ? "Starred" : "Star"}</button>
        <AddToPack ids={[c.id]} />
        <a className="btn sm" href={"#cmp-" + c.id}><Icon name="compare" />Compare</a>
        <a className="btn sm" href={"#map-" + c.id}><Icon name="graph" />Neighborhood</a>
        <CiteButton c={c} />
        {ask ? <button className="btn sm" onClick={() => ask.open(`Explain “${c.l}” for someone new to the field, then say how it differs from its closest related terms.`, [c.id])}><Icon name="sparkle" />Ask Claude</button> : null}
        <ShareButton c={c} />
        <a className="btn sm ghost" href={META.human + "#" + c.id} target="_blank" rel="noopener"><Icon name="external" />Open on i2idl.org</a>
      </div>
    </header>
  );
}

function ShareButton({ c }) {
  const { toast } = useUI();
  const url = window.__APP_URL__ ? window.__APP_URL__ + "#c-" + c.id : iriOf(c.id);
  return <button className="btn sm ghost" onClick={async () => { (await copyText(url)) ? toast(window.__APP_URL__ ? "Link to this entry copied" : "Concept IRI copied", { icon: "link" }) : toast("Couldn't reach the clipboard", { icon: "warn" }); }}><Icon name="link" />Copy link</button>;
}

function CiteButton({ c }) {
  const rows = [
    ["Citation", citeText(c)],
    ["Markdown", citeMarkdown(c)],
    ["Quote with attribution", quoteWithAttribution(c)],
    ["BibTeX", citeBibtex(c)],
    ["IRI", iriOf(c.id)],
  ];
  return (
    <PopButton small icon="quote" label="Cite">
      {() => (
        <div style={{ width: 340 }}>
          <div className="pop-h">Cite this entry</div>
          {rows.map(([k, v]) => (
            <div key={k} style={{ padding: "6px 8px", display: "grid", gap: 4 }}>
              <div className="row"><b className="small grow">{k}</b><CopyBtn text={v} small /></div>
              <div className="small muted" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 90, overflow: "hidden" }}>{v}</div>
            </div>
          ))}
        </div>
      )}
    </PopButton>
  );
}

export function AddToPack({ ids, label = "Add to pack", small = true }) {
  const { ws, updateWs } = useCaps();
  const { toast } = useUI();
  const [name, setName] = useState("");
  const add = (pid, close) => {
    const p = ws.packs.find((x) => x.id === pid);
    updateWs((w) => ({ packs: w.packs.map((x) => (x.id === pid ? addToPack(x, ids) : x)) }));
    toast(`Added to “${p.name}”`, { icon: "pack", action: { label: "Open", run: () => go("packs-" + pid) } });
    close();
  };
  const create = (close) => {
    const p = newPack(name.trim() || "New pack", ids);
    updateWs((w) => ({ packs: [p, ...w.packs] }));
    setName("");
    toast(`Created “${p.name}”`, { icon: "pack", action: { label: "Open", run: () => go("packs-" + p.id) } });
    close();
  };
  return (
    <PopButton small={small} icon="pack" label={label}>
      {(close) => (
        <div style={{ width: 280 }}>
          {ws.packs.length ? <div className="pop-h">Your packs</div> : null}
          {ws.packs.map((p) => {
            const has = ids.every((id) => p.items.some((i) => i.id === id));
            return <button key={p.id} className="opt" onClick={() => add(p.id, close)} disabled={has}><Icon name={has ? "check" : "pack"} />{p.name}<span className="n">{p.items.length}</span></button>;
          })}
          <div className="pop-h">New pack</div>
          <div className="row" style={{ padding: "2px 6px 6px" }}>
            <input className="input sm" placeholder="e.g. Intro to xAPI — week 2" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") create(close); }} />
            <button className="btn sm primary" onClick={() => create(close)}>Create</button>
          </div>
        </div>
      )}
    </PopButton>
  );
}

function DefMeta({ c, x }) {
  const nd = c.ev.filter((e) => e.r === "d").length, ns = c.ev.length - nd;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div className="def-meta">
        <ModalChip status="Asserted" title="I2IDL's approved definition: published as fact.">I2IDL · {c.ds}</ModalChip>
        <span>Definition {c.dq} · {c.dl}</span>
        <span>{plural(nd, "direct evidence record")}{ns ? `, ${ns} supporting` : ""}</span>
      </div>
      {x ? (
        <div className={"provline " + c.pv} title="Computed from the evidence relations below. The wording is I2IDL's own, from its roadmap (next priority 3).">
          <Origin o="derived" quiet>computed</Origin>
          <span>Definition provenance: <b>{provenanceLine(c)}</b></span>
        </div>
      ) : null}
    </div>
  );
}

function Relations({ c }) {
  const rows = [["Broader", c.b], ["Narrower", c.n], ["Related", c.r]].filter(([, l]) => l.length);
  return (
    <section aria-label="Relations">
      <div className="subh"><h3>Relations</h3><span className="meta">I2IDL's editorial links · {plural(c.r.length + c.b.length + c.n.length, "link")}</span>
        <span className="spacer" /><a className="btn ghost sm" href={"#map-" + c.id}><Icon name="graph" />See them mapped</a></div>
      <div className="rels">
        {rows.length ? rows.map(([lab, list]) => (
          <div className="relrow" key={lab}><div className="lab">{lab}</div><div className="chips">{list.map((x) => <ConceptChip key={x} id={x} />)}</div></div>
        )) : <div className="muted small">No editorial links in this release.</div>}
      </div>
    </section>
  );
}

function Evidence({ c }) {
  const ev = [...c.ev].sort((a, b) => (a.r === b.r ? 0 : a.r === "d" ? -1 : 1));
  return (
    <section aria-label="Evidence">
      <div className="subh"><h3>Evidence</h3><span className="meta">{plural(ev.filter((e) => e.r === "d").length, "direct record")}, {ev.filter((e) => e.r === "s").length} supporting · with each source's own rights</span></div>
      <div className="evlist">
        {ev.map((e, i) => {
          const s = SOURCES[e.s];
          const page = e.pp ? `p. ${e.pp}` : e.p ? `PDF p. ${e.p}` : null;
          return (
            <div className="ev" key={i}>
              <div className={"rel " + e.r}>{e.r === "d" ? "Direct" : "Supporting"}</div>
              <div style={{ minWidth: 0 }}>
                <div className="src" title={s.title}>{s.label}</div>
                {e.c ? <div className="cite">{e.c}</div> : null}
                <div className="evm">
                  {page ? <span>{page}</span> : null}
                  {e.h ? <span>via {e.h}</span> : null}
                  <RightsBadge rc={s.rc} text={s.rights} />
                  {e.u ? <a href={e.u} target="_blank" rel="noopener"><Icon name="external" size={12} /> Open source</a> : null}
                </div>
              </div>
              {e.an || e.ad ? <div className="notice">{[e.an, e.ad].filter(Boolean).join(" ")}</div> : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ── The I2IDL-X zone ─────────────────────────────────────────────────────────────────────────────

function XHead({ c }) {
  const adds = additionsOf(c);
  return (
    <div className="zone-head o-x">
      <div className="zt"><span className="origin o-x static"><Icon name="layers" size={11} /><span>I2IDL-X</span></span><h2>Layered on top</h2></div>
      <div className="zs">Derived from, or proposed about, the record on the left; it never changes it. Each section says where it comes from.</div>
      <div className="zr tiny muted">{adds.map(([l]) => l).join(" · ")}</div>
    </div>
  );
}

function LayerHead({ icon, title, o, extra }) {
  return <div className="lh"><Icon name={icon} /><h3 className="grow">{title}</h3>{extra}{[].concat(o).map((x) => <Origin key={x} o={x} quiet />)}</div>;
}

function ReadingAids({ c }) {
  const sugg = suggByConcept.get(c.id) || [];
  const rc = reuseClass(c);
  const direct = directSources(c);
  const [q, setQ] = useState(false);
  return (
    <section className="layer" aria-label="Reading aids">
      <LayerHead icon="layers" title="Reading aids" o="derived" />
      <div className="lb">
        <div className="kv2">
          <span className="k">Kind</span>
          <span><KindBadge k={c.k} /> <span className="tiny muted">from I2IDL's type “{typeById.get(c.t).label}”</span></span>
          <span className="k">Reuse</span>
          <span><RightsBadge rc={rc} text={RIGHTS[rc].label} /> <span className="tiny muted">{direct.length ? "strictest rights among " + direct.map((s) => s.label).join(", ") : "no direct source"}</span></span>
        </div>
        {sugg.length ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="eyebrow" title="Concepts named in this entry's text that I2IDL does not relate to it — candidates for I2IDL's editors.">Named here, not related by I2IDL</div>
            <div className="chips">{sugg.map((s) => <ConceptChip key={s.b} id={s.b} title="Named in this entry but not linked by I2IDL" className="sugg" />)}</div>
          </div>
        ) : null}
        <button className="btn ghost sm" onClick={() => setQ(!q)} aria-expanded={q}><Icon name={q ? "up" : "down"} />Eight questions this entry answers</button>
        {q ? <Interrogatives c={c} /> : null}
      </div>
    </section>
  );
}

/** What the concept classifies: its referent category and the classes those things join in every ontology. */
function Classifies({ c }) {
  const cat = catById.get(c.rc);
  if (!cat) return null;
  const cls = classesOf(cat.id).filter((x) => columnOf(x.t) !== "i2x");
  const rows = COLUMNS.map((col) => [col, cls.filter((x) => columnOf(x.t) === col.id || (col.id === "peer" && columnOf(x.t) === "foxxi"))]).filter(([, l]) => l.length);
  const br = bridgesOf(c.id);
  return (
    <section className="layer" aria-label="What it classifies">
      <LayerHead icon="tree" title="What it classifies" o="proposed" />
      <div className="lb">
        <div className="kv2">
          <span className="k">Category</span>
          <span><a href={"#semantic-cat." + cat.id}><b>{cat.label}</b></a>{ancestors(cat.id).length ? <span className="tiny muted"> · a kind of {ancestors(cat.id).map((a) => catById.get(a).label.toLowerCase()).join(", ")}</span> : null}<div className="tiny muted">{c.rb === "t" ? `From I2IDL's type “${typeById.get(c.t).label}”` : "From the definition"}</div></span>
        </div>
        <p className="small serif">{c.rw}</p>
        {cat.mode === "subject" ? <p className="small muted">A field: work is <i>about</i> it (<code>dct:subject</code>), never an instance of it, so nothing is typed from it.</p>
          : cat.mode === "none" ? <p className="small muted">Its instances have no single upper-ontology category, so I2IDL-X types nothing from it.</p> : (
            <div className="stack" style={{ gap: 4 }}>
              <div className="eyebrow">Anything it classifies is</div>
              <dl className="kv rk">{rows.map(([col, list]) => [<dt key={col.id + "t"}>{col.label}</dt>, <dd key={col.id + "d"} className="chips">{list.map((x) => <Term key={x.t} t={x.t} dim={x.k !== cat.id} />)}</dd>])}</dl>
            </div>
          )}
        {cat.cc.length ? <p className="small">The concept itself is {cat.cc.map((t, i) => <span key={t}>{i ? " and " : ""}<Term t={t} tag /></span>)}.</p> : null}
        {br.length ? <p className="small">{br.map((b) => <span key={b.t} className="block">{b.k === "broad" ? <>Anything it classifies is also <Term t={b.t} /></> : b.k === "exact" ? <>Same class as <Term t={b.t} />: either one classifies the other's instances</> : <>Anything typed <Term t={b.t} /> is classified by it</>} <span className="tiny muted">(crosswalk {b.m}, {b.k}Match)</span></span>)}</p> : null}
        <div className="row wrap"><a className="btn sm" href={"#semantic-try." + c.id}><Icon name="bolt" />Try it on your data</a><a className="btn ghost sm" href={"#semantic-cat." + cat.id}>All {cat.label.toLowerCase()} concepts</a></div>
      </div>
      <div className="lfoot">Proposed in <a href={META.iri.referents} target="_blank" rel="noopener"><code>i2idlx-referents</code></a> and <a href={META.iri.alignments} target="_blank" rel="noopener"><code>i2idlx-alignments</code></a> (Hypothetical). Link a thing to this concept with <code>i2x:isClassifiedBy</code> and any OWL reasoner types it this way.</div>
    </section>
  );
}

function Interrogatives({ c }) {
  const en = enactByConcept.get(c.id) || [];
  const how = en.filter((e) => e.r !== "measures" && e.r !== "enforces");
  const much = en.filter((e) => e.r === "measures");
  const whether = en.filter((e) => e.r === "enforces");
  const act = (l) => l.map((e) => (ACTIONS[e.a] ? ACTIONS[e.a].t : e.a)).join("; ");
  const answers = {
    What: c.d.length > 110 ? c.d.slice(0, 110).replace(/\s+\S*$/, "") + "…" : c.d,
    Why: c.x.length > 110 ? c.x.slice(0, 110).replace(/\s+\S*$/, "") + "…" : c.x,
    WhatKind: `${typeById.get(c.t).label} → ${kindById.get(c.k).label}`,
    Where: c.f.map((f) => fieldById.get(f).label).join(", "),
    Whose: [...new Set(c.ev.map((e) => SOURCES[e.s].label))].join(", "),
    How: how.length ? act(how) : "—",
    HowMuch: much.length ? act(much) : "—",
    Whether: whether.length ? act(whether) : "—",
  };
  return (
    <div className="qgrid one">
      {INTERROGATIVES.map((q) => (
        <div className="q" key={q.q}>
          <div className="qh"><b>{q.q.replace(/([a-z])([A-Z])/g, "$1 $2")}?</b><span className="mono tiny" title={q.prop}>{q.label}</span></div>
          <div className="qa">{answers[q.q]}</div>
        </div>
      ))}
      <div className="tiny muted">Interego's interrogatives, each answered by one property: I2IDL's for What, Why, Where and Whose; I2IDL-X's for the rest.</div>
    </div>
  );
}

const SHOW = 6;
function Partners({ ids }) {
  const [all, setAll] = useState(false);
  const list = all ? ids : ids.slice(0, SHOW);
  return <div className="chips hchips">{list.map((i) => <ConceptChip key={i} id={C[i].id} />)}{ids.length > SHOW && !all ? <button className="btn ghost sm" onClick={() => setAll(true)}>+{ids.length - SHOW}</button> : null}</div>;
}

/** One release's changes to this concept, in words. */
function HistoryRow({ ri, rec }) {
  const r = RELEASES[ri];
  const items = [];
  if (rec.add) items.push(<span key="add"><b>Added</b> to the glossary</span>);
  if (rec.rem) items.push(<span key="rem"><b>Removed</b></span>);
  for (const [k, lab] of [["r+", "related"], ["b+", "broader"], ["n+", "narrower"]]) {
    if (rec[k]) items.push(<div key={k}>+{rec[k].length} {lab}<Partners ids={rec[k]} /></div>);
  }
  for (const [k, lab] of [["r-", "related"], ["b-", "broader"], ["n-", "narrower"]]) {
    if (rec[k]) items.push(<div key={k}>−{rec[k].length} {lab}<Partners ids={rec[k]} /></div>);
  }
  if (rec["m+"]) items.push(<span key="m+">joined {rec["m+"].map((p, i) => <span key={p}>{i ? ", " : ""}<a href={"#browse-" + ({ field: "f", type: "t", curated: "cu" }[p.split("/")[0]]) + "." + p.split("/")[1]}>{collectionLabel(p)}</a></span>)}</span>);
  if (rec["m-"]) items.push(<span key="m-">left {rec["m-"].map((p) => collectionLabel(p)).join(", ")}</span>);
  if (rec.ec) items.push(<span key="ec">evidence classified: {Object.entries(rec.ec).map(([v, n]) => `${n} ${v}`).join(", ")}</span>);
  if (rec.er) items.push(<span key="er">evidence reclassified: {rec.er.map(([a, b, s], i) => <span key={i}>{i ? "; " : ""}{a} → <b>{b}</b>{s != null ? ` (${SOURCES[s].label})` : ""}</span>)}</span>);
  if (rec["e+"]) items.push(<span key="e+">+{plural(rec["e+"], "evidence record")}</span>);
  if (rec["e-"]) items.push(<span key="e-">−{plural(rec["e-"], "evidence record")}</span>);
  if (rec["al+"]) items.push(<span key="al+">alternate label {rec["al+"].map((a) => `“${a}”`).join(", ")} added</span>);
  if (rec["al-"]) items.push(<span key="al-">alternate label {rec["al-"].map((a) => `“${a}”`).join(", ")} removed</span>);
  for (const [k, [a, b]] of Object.entries(rec.s || {})) items.push(<span key={k}><b>{k.replace(/-/g, " ")}</b>{typeof a === "string" && a.length < 90 ? <>: “{a}” → “{b}”</> : null}</span>);
  return (
    <li className={cx("hrow", rec.add && "added")}>
      <div className="hv"><b>{r.v}</b><span className="tiny muted">{fmtDate(r.at)}</span></div>
      <div className="hi">{items.map((x, i) => <div key={i}>{x}</div>)}</div>
    </li>
  );
}

function History({ c }) {
  const rows = [...(c.h || [])].reverse();
  const first = RELEASES[0];
  return (
    <section className="layer" aria-label="History">
      <LayerHead icon="history" title="History" o="derived" />
      <div className="lb">
        <ol className="hist">
          {rows.map(([ri, rec]) => <HistoryRow key={ri} ri={ri} rec={rec} />)}
          {c.h0 ? <li className="hrow base"><div className="hv"><b>{first.v}</b><span className="tiny muted">{fmtDate(first.at)}</span></div><div className="hi"><div>In the first public release</div></div></li> : null}
        </ol>
      </div>
      <div className="lfoot">From I2IDL's public git history, as PROV events in <a href={META.iri.changes} target="_blank" rel="noopener"><code>i2idlx-changes</code></a> (I2IDL's roadmap, priority 4). Releases with no change to this term are omitted.</div>
    </section>
  );
}

function Reference({ c }) {
  if (!c.spec && !c.exm) return null;
  return (
    <section className="layer" aria-label="Reference links">
      <LayerHead icon="book" title="Reference" o="added" />
      <div className="lb">
        <div className="chips">
          {(c.spec || []).map((u) => <a key={u} className="chip" href={u} target="_blank" rel="noopener" title={u}><Icon name="book" size={12} />Specification</a>)}
          {(c.exm || []).map((u) => <a key={u} className="chip" href={u} target="_blank" rel="noopener" title={"Exemplified by " + u}><Icon name="external" size={12} />Live example</a>)}
        </div>
      </div>
      <div className="lfoot">Asserted in the I2IDL-X catalog; I2IDL's record doesn't carry these links.</div>
    </section>
  );
}

const SysOrigin = ({ sys }) => (sys === "relay" ? <Origin o="interego" quiet>Interego relay</Origin> : sys ? <Origin o="foxxi" quiet>{systemLabel(sys)}</Origin> : null);

function ActionTitle({ iri }) {
  const a = ACTIONS[iri];
  if (!a) return <code className="iri">{iri}</code>;
  return <a href={"#agents-act." + a.sys + "." + a.n} title={a.d || a.t}>{a.t || a.n}</a>;
}

function Pragmatic({ c }) {
  const en = enactByConcept.get(c.id) || [];
  const inh = inhByConcept.get(c.id) || [];
  const caps = capsByConcept.get(c.id) || [];
  const { ask } = useUI();
  return (
    <section className="layer" aria-label="Pragmatic interpretant">
      <LayerHead icon="bolt" title="What enacts it" o={["proposed"]} />
      <div className="lb">
        {en.length ? en.map((e) => <EnactmentCard key={e.id} e={e} />) : null}
        {inh.length ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="eyebrow">Inherited from broader concepts</div>
            {inh.map((x) => (
              <div className="cap" key={x.a}>
                <div className="verb">via <ConceptChip id={x.via} /></div>
                <div className="act"><ActionTitle iri={x.a} /></div>
                <div className="capm"><SysOrigin sys={ACTIONS[x.a] && ACTIONS[x.a].sys} /><span>Derived by the OWL property chain over <code>skos:broaderTransitive</code></span></div>
              </div>
            ))}
          </div>
        ) : null}
        {caps.length ? (
          <div className="stack" style={{ gap: 6 }}>
            <div className="eyebrow">As an agent role · {caps.length} capabilities</div>
            <div className="chips">{caps.map((x) => <a key={x.a} className="chip" href={"#agents-act." + ACTIONS[x.a].sys + "." + ACTIONS[x.a].n} title={x.note}><Icon name="agent" size={12} />{ACTIONS[x.a].lb || ACTIONS[x.a].n}</a>)}</div>
            {caps.every((x) => x.note.startsWith("derived")) ? <div className="tiny muted">Derived from the role tags in Foxxi's own manifest.</div> : null}
          </div>
        ) : null}
        {!en.length && !inh.length && !caps.length ? (
          <div className="stack" style={{ gap: 8 }}>
            <div className="muted small">No capability links yet. {kindById.get(c.k).label} concepts are {c.k === "notion" ? "resolved, explained and tagged in usage rather than enacted directly." : "candidates for one."}</div>
            {ask ? <button className="btn sm" onClick={() => ask.open(`Which Foxxi or Interego actions could enact “${c.l}”? Use the capability directory. Say which enactment role fits (operationalizes, realizes, implements, measures, records, credentials, enforces, explains) and why; mark every suggestion as a hypothesis for review.`, [c.id])}><Icon name="sparkle" />Suggest capability links</button> : null}
          </div>
        ) : null}
      </div>
      {en.length ? <div className="lfoot">Links from this I2IDL concept to live actions, published <b>Hypothetical</b> in <code>i2idlx-enactments</code>. The actions are Foxxi's and Interego's own; vote to ratify the links.</div> : null}
    </section>
  );
}

function EnactmentCard({ e }) {
  const a = ACTIONS[e.a];
  const role = roleById.get(e.r);
  const key = "e." + e.id;
  const { tallies, policy } = useCaps();
  const s = consensus(tallies.get(key), policy.quorum);
  return (
    <div className={cx("cap", s === "ratified" && "ratified", s === "rejected" && "rejected")}>
      <div className="verb" title={role.def}>{role.by}</div>
      <div className="act"><ActionTitle iri={e.a} /></div>
      <div className="why">{e.w}</div>
      <div className="capm">
        <SysOrigin sys={a && a.sys} />
        {a ? <MethodTag m={a.m} /> : null}
        {a && a.ro === false ? <span className="tag" title="Changes state">write</span> : null}
        <span className="row" style={{ gap: 6 }} title={"Drafting confidence " + e.cf.toFixed(2)}><Meter v={e.cf} />{e.cf.toFixed(2)}</span>
        <span>{methodById.get(e.m).label}</span>
      </div>
      <VoteBar itemKey={key} compact />
      <Voters itemKey={key} />
    </div>
  );
}

function Crosswalks({ c }) {
  const ms = mapsByConcept.get(c.id) || [];
  const { tallies, policy } = useCaps();
  if (!ms.length) return null;
  return (
    <section className="layer" aria-label="Crosswalk proposals">
      <LayerHead icon="link" title="Crosswalks" o="proposed" extra={<span className="by">{plural(ms.length, "proposal")}</span>} />
      <div className="lb">
        {ms.map((m) => {
          const key = "m." + m.id;
          const s = consensus(tallies.get(key), policy.quorum);
          return (
            <div key={m.id} className={cx("cap", s === "ratified" && "ratified", s === "rejected" && "rejected")}>
              <div className="verb"><code>skos:{m.p}</code> · {m.v}{m.ci ? <span className="cited" title={"I2IDL's own definition cites this term as direct evidence (" + m.ci.replace("https://id.i2idl.org/definitions/", "") + ")."}><Icon name="check" size={11} />cited by I2IDL</span> : null}</div>
              <div className="act"><a href={m.pg || m.o} target="_blank" rel="noopener" title={m.o}>{m.ol || m.o.split(/[#/]/).pop()}</a></div>
              {m.od ? <div className="why" style={{ fontFamily: "var(--font-serif)", fontSize: 14 }}>{m.on ? <span className="tiny muted" style={{ fontFamily: "var(--font-ui)" }}>{m.v} {m.on}: </span> : null}“{m.od.length > 180 ? m.od.slice(0, 180) + "…" : m.od}”</div> : null}
              {m.oa && m.oa.length ? <div className="tiny muted">Also: {m.oa.slice(0, 5).join(", ")}</div> : null}
              <div className="why">{m.w}</div>
              <div className="capm"><span className="row" style={{ gap: 6 }}><Meter v={m.cf} />{m.cf.toFixed(2)}</span><span>{methodById.get(m.m).label}</span></div>
              <VoteBar itemKey={key} compact />
              <Voters itemKey={key} />
              {s === "ratified" ? <a className="btn sm" href={upstreamIssue({ key, type: "mapping", rec: m, c: m.c, iri: META.iri.mappings + "#" + m.id }, tallies.get(key))} target="_blank" rel="noopener"><Icon name="flag" />Suggest to I2IDL editors</a> : null}
            </div>
          );
        })}
      </div>
      <div className="lfoot">A <code>skos:{"{exact|close|…}"}Match</code> triple exists only after ratification.{ms.some((m) => m.v === "UNESCO Thesaurus") ? <> UNESCO Thesaurus terms: © UNESCO, <a href="https://creativecommons.org/licenses/by-sa/3.0/igo/" target="_blank" rel="noopener">CC BY-SA 3.0 IGO</a>.</> : null}</div>
    </section>
  );
}

function Usage({ c }) {
  const { usageByConcept, setUse, myId, writable, signedIn, allNotes, addNote, deleteNote, resolved } = useCaps();
  const { toast } = useUI();
  const users = usageByConcept.get(c.id) || [];
  const notes = allNotes.filter((n) => n.c === c.id);
  const ps = useProfiles([...users.map((u) => u.u), ...notes.map((n) => n.u)]);
  const mine = users.find((u) => u.u === myId);
  const [ctx, setCtx] = useState("");
  const [text, setText] = useState("");
  const [xapi, setXapi] = useState(false);
  const why = !resolved ? "" : !signedIn ? "Sign in to claude.ai to add notes and usage." : !writable ? "View-only access: you can read the team's notes." : "";
  const doUse = async (close) => {
    try { await setUse(c.id, ctx.trim()); setCtx(""); close(); toast("Marked as in use", { icon: "check" }); }
    catch { toast(why || "That didn't save. Try again.", { icon: "warn" }); }
  };
  const post = async () => {
    if (!text.trim()) return;
    try { await addNote(c.id, text.trim()); setText(""); }
    catch { toast(why || "That note didn't save. Try again.", { icon: "warn" }); }
  };
  return (
    <section className="layer" aria-label="Usage interpretant">
      <LayerHead icon="users" title="In use" o="team" />
      <div className="lb">
        <div className="row wrap">
          {users.length ? <span className="avatars">{users.slice(0, 6).map((u) => <Avatar key={u.u} p={ps[u.u]} />)}</span> : null}
          <span className="small">{users.length ? `${plural(users.length, "collaborator")} ${users.length === 1 ? "uses" : "use"} this term` : "Nobody here has marked it yet."}</span>
          <span className="spacer" />
          {mine ? (
            <button className="btn sm on" onClick={async () => { try { await setUse(c.id, null); } catch { toast(why, { icon: "warn" }); } }}><Icon name="check" />I use this</button>
          ) : writable ? (
            <PopButton small icon="plus" label="I use this" align="right">
              {(close) => (
                <div style={{ width: 280, padding: 6, display: "grid", gap: 8 }}>
                  <label className="field"><span>Where? (a course, program or project)</span>
                    <input className="input sm" value={ctx} onChange={(e) => setCtx(e.target.value)} maxLength={140} placeholder="e.g. LE 101 · week 3" onKeyDown={(e) => { if (e.key === "Enter") doUse(close); }} autoFocus /></label>
                  <button className="btn sm primary" onClick={() => doUse(close)}>Save</button>
                </div>
              )}
            </PopButton>
          ) : null}
        </div>
        {users.filter((u) => u.ctx).length ? (
          <ul style={{ listStyle: "none", display: "grid", gap: 4 }}>
            {users.filter((u) => u.ctx).map((u) => <li key={u.u} className="small"><b>{u.ctx}</b> <span className="muted">— {(ps[u.u] && ps[u.u].name) || "Someone"}</span></li>)}
          </ul>
        ) : null}
        <div className="divider" style={{ margin: "4px 0" }} />
        <div className="notes">
          {notes.map((n) => (
            <div className="noteitem" key={n.id}>
              <Avatar p={ps[n.u]} size={24} />
              <div>
                <div className="nh"><b>{(ps[n.u] && ps[n.u].name) || "Someone"}</b><span>{ago(n.at)}</span>
                  {n.u === myId && writable ? <button className="btn ghost sm icon" title="Delete note" onClick={() => deleteNote(n.id).catch(() => toast("Couldn't delete", { icon: "warn" }))}><Icon name="trash" /></button> : null}</div>
                <div className="nt">{n.text}</div>
              </div>
            </div>
          ))}
          {writable ? (
            <div className="stack" style={{ gap: 6 }}>
              <textarea className="textarea" rows={2} value={text} onChange={(e) => setText(e.target.value)} maxLength={2000}
                placeholder="Add a note for the team: how you teach it, where it's ambiguous, a better example…" onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post(); }} />
              <div className="row"><span className="tiny muted grow">Visible to everyone with access to this page.</span><button className="btn sm primary" onClick={post} disabled={!text.trim()}>Post note</button></div>
            </div>
          ) : notes.length ? null : <div className="tiny muted">{why || "No notes yet."}</div>}
        </div>
      </div>
      <div className="lfoot row"><span className="grow">Usage also accrues from xAPI statements tagged with this IRI through <Origin o="foxxi" quiet />.</span><button className="btn sm" onClick={() => setXapi(true)}><Icon name="code" />xAPI</button></div>
      {xapi ? <XapiModal ids={[c.id]} onClose={() => setXapi(false)} /> : null}
    </section>
  );
}

export function XapiModal({ ids, onClose }) {
  const [verb, setVerb] = useState("experienced");
  const [act, setAct] = useState("");
  const [name, setName] = useState("");
  const stmt = useMemo(() => usageStatement({ ids, verb, activityId: act.trim() || undefined, activityName: name.trim() || undefined }), [ids, verb, act, name]);
  return (
    <Modal title="Record usage through Foxxi (xAPI)" onClose={onClose} wide>
      <div className="stack">
        <p className="small muted">Tag any xAPI statement with I2IDL IRIs in Foxxi's existing <code>conceptIds</code> context extension; each one becomes a usage interpretant of every concept it names. Foxxi's signed write needs your agent's identity, so an agent sends it with <code>act</code> and <code>sign_payload</code>; the relay signs with your session.</p>
        <div className="qparams">
          <label className="field"><span>Verb (ADL)</span><select className="select" value={verb} onChange={(e) => setVerb(e.target.value)}>{ADL_VERBS.map((v) => <option key={v}>{v}</option>)}</select></label>
          <label className="field"><span>Activity IRI</span><input className="input" value={act} onChange={(e) => setAct(e.target.value)} placeholder="urn:example:your-course/activity" /></label>
          <label className="field"><span>Activity name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Your activity" /></label>
        </div>
        <CodeBlock title="xAPI statement" code={pretty(stmt)} />
        <CodeBlock title="Interego act call (agent)" code={pretty(usageActCall(stmt))} />
        <div className="note"><Icon name="info" /><span><code>actor.account.name</code> must be your authenticated DID; Foxxi rejects statements on anyone else's behalf. Foxxi's live LRS reports an in-memory backend, so persist statements you need to keep.</span></div>
      </div>
    </Modal>
  );
}

function ForAgents({ c }) {
  const ctl = controlsFor(c);
  const [align, setAlign] = useState(false);
  const neighborhood = ctl.find((x) => x.id === "neighborhood");
  return (
    <section className="layer" aria-label="For agents">
      <LayerHead icon="agent" title="For agents" o="interego" extra={<span className="by">HyprCat controls</span>} />
      <div className="lb">
        <div className="row"><code className="iri grow">{iriOf(c.id)}</code><CopyBtn text={iriOf(c.id)} small title="Copy IRI" /></div>
        <div className="stack" style={{ gap: 6 }}>
          {ctl.map((x) => (
            <div className="ctl" key={x.id}>
              <div className="row" style={{ minWidth: 0 }}><MethodTag m={x.m} /><span className="ct ellipsis">{x.title}</span></div>
              <div className="row" style={{ gap: 4 }}>
                <CopyBtn text={x.u} small title="Copy target" />
                <a className="btn sm icon" href={x.u} target="_blank" rel="noopener" title="Open"><Icon name="external" /></a>
              </div>
              <div className="cu" title={x.u}>{x.mt} · {x.u}</div>
            </div>
          ))}
        </div>
        <details>
          <summary className="small" style={{ cursor: "pointer", fontWeight: 600 }}>Through Interego (MCP)</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <p className="tiny muted">The catalog IRI is the descriptor; the POST port takes the query text as a plain string.</p>
            <CodeBlock title="act · neighborhood" code={pretty(actQuery(neighborhood.query))} />
          </div>
        </details>
        <div className="row wrap">
          <button className="btn sm" onClick={() => setAlign(true)}><Icon name="pin" />Align a course concept</button>
          <a className="btn sm ghost" href="#agents">Catalog <Icon name="right" /></a>
        </div>
      </div>
      {align ? <AlignModal c={c} onClose={() => setAlign(false)} /> : null}
    </section>
  );
}

function AlignModal({ c, onClose }) {
  const [course, setCourse] = useState("");
  const [pred, setPred] = useState("closeMatch");
  const ttl = alignmentTurtle({ courseConcept: course.trim(), id: c.id, predicate: pred });
  const call = { graph_iri: `urn:graph:interpretant:alignment:${c.id}`, graph_content: ttl, modal_status: "Hypothetical", conforms_to_shapes: [META.shapes] };
  return (
    <Modal title={`Align a Foxxi course concept to “${c.l}”`} onClose={onClose} wide>
      <div className="stack">
        <p className="small muted">Once course concept-graph nodes are aligned to I2IDL, Foxxi's coverage query reads against one shared reference space across courses and tenants. Find course nodes with Foxxi's <code>explore-concept-map</code>; publish through <code>port-align-course-concept</code> (the relay validates against the I2IDL-X shapes first).</p>
        <div className="qparams">
          <label className="field"><span>Course concept IRI</span><input className="input" value={course} onChange={(e) => setCourse(e.target.value)} placeholder="urn:foxxi:course:…/concept/…" /></label>
          <label className="field"><span>Predicate</span><select className="select" value={pred} onChange={(e) => setPred(e.target.value)}>{["exactMatch", "closeMatch", "relatedMatch", "broadMatch", "narrowMatch"].map((p) => <option key={p}>{p}</option>)}</select></label>
        </div>
        <CodeBlock title="i2x:CourseConceptAlignment (Turtle)" code={ttl} />
        <CodeBlock title="publish_context arguments" code={pretty(call)} />
      </div>
    </Modal>
  );
}
