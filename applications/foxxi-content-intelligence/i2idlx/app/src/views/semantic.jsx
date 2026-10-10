// Semantic layer: what I2IDL's concepts classify, lined up with BFO 2020 (IAO, CCO), gist, DOLCE-UltraLite, gUFO,
// PROV-O, schema.org and the learning-industry vocabularies — with an inference playground that types pasted data
// the way the catalog's q-classify does, and the build's reasoning record. The concepts are I2IDL's; what they
// classify and every alignment is I2IDL-X · proposed (published Hypothetical); the reasoning record is derived.
import { META, C, byId, PORTS, QUERIES, CONCEPT_NS, typeById } from "../data.js";
import {
  SEM, CATS, catById, COLUMNS, chain, ancestors, childrenOf, conceptsIn, classesOf, labelOf, columnOf, vocabOf, expand,
  disjointWith, disjointness, bridgesOf, classify, snippetFor,
} from "../semantic.js";
import { useCaps } from "../caps.js";
import { Icon } from "../icons.jsx";
import { ConceptChip, CopyBtn, CodeBlock, Seg, useUI } from "../ui.jsx";
import { Origin, OriginStrip } from "../origin.jsx";
import { plural, go, cx, useStored, useDebounced, copyText } from "../util.js";
import { pretty } from "../lib.js";

const { useState, useMemo, useEffect, useRef } = React;

const TABS = [
  { v: "", l: "Categories", icon: "layers" },
  { v: "play", l: "Playground", icon: "bolt" },
  { v: "records", l: "Records & platforms", icon: "book" },
  { v: "reasoning", l: "Reasoning", icon: "check" },
  { v: "agents", l: "For agents", icon: "agent" },
];
const GROUPS = [...new Set(CATS.map((c) => c.group))];
const R = SEM.reasoning;
const N_PAIRS = R.disjointCheck.pairs;
const N_DISJOINT = Object.keys(SEM.disjoint).length;
const UPPER_COLS = COLUMNS.filter((c) => c.id !== "peer");

/** A class from another vocabulary: its publisher's label, the CURIE and vocabulary on hover, a link to its IRI. */
export function Term({ t, dim, why, tag }) {
  const v = vocabOf(t);
  const title = `${t}${v ? " · " + v.title : ""}${why ? "\n" + why : ""}`;
  const href = t.startsWith("i2x:") ? META.iri.ontology : expand(t);
  return (
    <a className={cx("term", dim && "dim", "tc-" + columnOf(t))} href={href} target="_blank" rel="noopener" title={title}>
      {tag ? <span className="tv">{vocabTag(t)}</span> : null}{labelOf(t)}
    </a>
  );
}
/** Columns that hold terms from several vocabularies: each chip there names its own. */
const MIXED = new Set(["schema", "peer", "foxxi"]);
/** Terms whose label another term in the same list shares (schema:Organization and org:Organization): they get a vocabulary tag. */
export function sameLabel(ts) {
  const n = new Map();
  for (const t of ts) n.set(labelOf(t), (n.get(labelOf(t)) || 0) + 1);
  return new Set(ts.filter((t) => n.get(labelOf(t)) > 1));
}
/** Which vocabulary a term is from, in a word (BFO and IAO share the OBO prefix). */
export function vocabTag(t) {
  if (t.startsWith("obo:BFO_")) return "BFO";
  if (t.startsWith("obo:IAO_")) return "IAO";
  if (t.startsWith("i2x:")) return "I2IDL-X";
  const v = vocabOf(t);
  return v ? v.short : t.split(":")[0];
}

const ModeBadge = ({ mode }) => (mode === "subject" ? <span className="tag" title="Its concepts are subjects: link to them with dct:subject. Nothing is typed from them.">subject only</span>
  : mode === "none" ? <span className="tag" title="Its concepts have no single upper-ontology category, so nothing is typed from them.">no single category</span> : null);

export function Semantic({ route }) {
  const sec = route.section || "";
  const catId = sec.startsWith("cat.") ? sec.slice(4) : null;
  const tryId = sec.startsWith("try.") ? sec.slice(4) : null;
  const tab = catId ? "" : tryId ? "play" : TABS.some((t) => t.v === sec) ? sec : "";
  const nDef = C.filter((c) => c.rb === "d").length;
  return (
    <div className="page sem">
      <header className="stack" style={{ gap: 10 }}>
        <div className="eyebrow row" style={{ gap: 8 }}>Semantic layer <Origin o="proposed" quiet /></div>
        <h1 className="h-display" style={{ fontSize: 30 }}>A term names a kind of thing. <em>Here is which kind, in every ontology.</em></h1>
        <p className="lede">An I2IDL concept is a term. The things it classifies — your LRS deployment, a quiz session, a teacher, a badge — are typed in BFO 2020 (with IAO and CCO), gist, DOLCE-UltraLite, gUFO, PROV-O, schema.org and the learning-industry vocabularies, from one link: <code>i2x:isClassifiedBy</code>. Every concept has one of {CATS.length} referent categories; {C.length - nDef} follow I2IDL's own type, {nDef} are decided by the definition, each with its reason.</p>
        <div className="stats">
          {[["Referent categories", CATS.length], ["Aligned terms", R.terms], ["Vocabularies", Object.keys(R.byVocabulary).length],
            ["Crosswalk bridges", SEM.bridges.length], ["Disjoint category pairs", `${N_DISJOINT}/${N_PAIRS}`], ["OWL 2 RL inferences", (R.owlrl.closed - R.owlrl.input).toLocaleString()]]
            .map(([l, v]) => <div className="stat" key={l}><span className="l">{l}</span><span className="v">{typeof v === "number" ? v.toLocaleString() : v}</span></div>)}
        </div>
        <OriginStrip items={[["i2idl", "the concepts"], ["proposed", "what they classify, the alignments"], ["derived", "the reasoning record"]]} />
        <div><Seg label="Section" value={tab} onChange={(v) => go("semantic" + (v ? "-" + v : ""))} options={TABS} /></div>
      </header>
      <div className="sem-body">
        {tab === "" ? <Categories catId={catId} />
          : tab === "play" ? <Playground tryId={tryId} />
            : tab === "records" ? <Records />
              : tab === "reasoning" ? <Reasoning />
                : <ForAgents />}
      </div>
    </div>
  );
}

// ── Categories: the alignment matrix and one category's detail ─────────────────────────────────────

function Categories({ catId }) {
  const ref = useRef(null);
  useEffect(() => { if (catId && ref.current) ref.current.scrollIntoView({ block: "start", behavior: "smooth" }); }, [catId]);
  return (
    <div className="stack" style={{ gap: 18 }}>
      {catId && catById.has(catId) ? <div ref={ref} style={{ scrollMarginTop: 12 }}><CategoryDetail id={catId} /></div> : null}
      <section className="stack" style={{ gap: 8 }}>
        <div className="sec-h"><h2>Alignment matrix</h2><span className="meta">Bold: the category's own alignments; plain: inherited from its parent category. Click a category for its concepts, reasons and clashes.</span></div>
        <div className="tablewrap">
          <table className="tbl matrix">
            <thead><tr><th>Category</th><th className="n">Concepts</th>{UPPER_COLS.map((c) => <th key={c.id}>{c.label}</th>)}<th>Peers · publish as</th></tr></thead>
            <tbody>
              {GROUPS.map((g) => [
                <tr key={g} className="grp"><td colSpan={UPPER_COLS.length + 3}>{g}</td></tr>,
                ...CATS.filter((c) => c.group === g).map((c) => <MatrixRow key={c.id} c={c} on={c.id === catId} />),
              ])}
            </tbody>
          </table>
        </div>
        <p className="tiny muted">Labels are each publisher's own, read from pinned snapshots of their files (see Reasoning). Hover a term for its CURIE; click it for its IRI.</p>
      </section>
    </div>
  );
}

function MatrixRow({ c, on }) {
  const cls = classesOf(c.id);
  const depth = ancestors(c.id).length;
  const n = conceptsIn(c.id).length;
  return (
    <tr className={cx(on && "on")}>
      <td className="cat" style={{ paddingLeft: 10 + depth * 14 }}>
        <a href={"#semantic-cat." + c.id}>{c.label}</a> <ModeBadge mode={c.mode} />
      </td>
      <td className="n">{n}</td>
      {UPPER_COLS.map((col) => {
        const list = cls.filter((x) => columnOf(x.t) === col.id);
        const amb = sameLabel(list.map((x) => x.t));
        return (
          <td key={col.id} className="cell">
            {list.map((x) => <Term key={x.t} t={x.t} dim={x.k !== c.id} tag={MIXED.has(col.id) || amb.has(x.t)} />)}
          </td>
        );
      })}
      <td className="cell">
        {cls.filter((x) => ["peer", "foxxi"].includes(columnOf(x.t))).map((x) => <Term key={x.t} t={x.t} dim={x.k !== c.id} tag />)}
        {c.ex.map((t) => <Term key={"ex" + t} t={t} dim tag why="Publish descriptions as this class (an export target, not a typing)" />)}
      </td>
    </tr>
  );
}

function CategoryDetail({ id }) {
  const c = catById.get(id);
  const cls = classesOf(id);
  const concepts = conceptsIn(id).sort((a, b) => a.l.localeCompare(b.l));
  const kids = childrenOf(id);
  const dis = disjointWith(id);
  const [showDis, setShowDis] = useState(false);
  return (
    <section className="card pad stack catd" aria-label={c.label}>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="crumbs small muted">{[...ancestors(id)].reverse().map((a) => <span key={a}><a href={"#semantic-cat." + a}>{catById.get(a).label}</a> › </span>)}</div>
        <span className="spacer" />
        <Origin o="proposed" quiet />
        <a className="btn ghost sm icon" href="#semantic" title="Close" aria-label="Close"><Icon name="x" /></a>
      </div>
      <h2 className="h-display" style={{ fontSize: 24 }}>{c.label} <ModeBadge mode={c.mode} /></h2>
      <p className="serif" style={{ fontSize: 16 }}>{c.def}</p>
      <dl className="kv">
        <dt>OWL class</dt><dd><code>{c.cls}</code>{c.abstract ? <span className="tiny muted"> · used through its sub-categories</span> : null}</dd>
        {kids.length ? <><dt>Narrower</dt><dd className="chips">{kids.map((k) => <a key={k} className="chip" href={"#semantic-cat." + k}>{catById.get(k).label}</a>)}</dd></> : null}
        <dt>Why these alignments</dt><dd className="small">{c.why}</dd>
      </dl>
      <div className="tablewrap">
        <table className="tbl">
          <thead><tr><th>Ontology</th><th>Its referents are</th></tr></thead>
          <tbody>
            {COLUMNS.map((col) => {
              const list = cls.filter((x) => columnOf(x.t) === col.id || (col.id === "peer" && columnOf(x.t) === "foxxi"));
              return list.length ? (
                <tr key={col.id}><td className="nowrap">{col.label}</td>
                  <td className="chips">{list.map((x) => <span key={x.t} className="row" style={{ gap: 4 }}><Term t={x.t} dim={x.k !== id} tag={MIXED.has(col.id) || sameLabel(list.map((y) => y.t)).has(x.t)} />{x.k && x.k !== id ? <span className="tiny muted">via {catById.get(x.k).label}</span> : null}</span>)}</td></tr>
              ) : null;
            })}
            <tr><td className="nowrap">I2IDL-X</td><td className="chips">{cls.filter((x) => columnOf(x.t) === "i2x").map((x) => <code key={x.t} className="tiny">{x.t}</code>)}</td></tr>
          </tbody>
        </table>
      </div>
      {c.role ? <p className="small muted">BFO 2020: a person in a role is also typed <i>bearer of some role</i>, for reasoners that use it.</p> : null}
      {c.cc.length ? <p className="small">The concepts themselves — the terms, not what they classify — are typed {c.cc.map((t, i) => <span key={t}>{i ? ", " : ""}<Term t={t} tag /></span>)}.</p> : null}
      {c.ex.length ? <p className="small">Publish descriptions of them as {c.ex.map((t, i) => <span key={t}>{i ? ", " : ""}<Term t={t} tag /></span>)} — export targets, not typings.</p> : null}
      <div className="stack" style={{ gap: 6 }}>
        <div className="row wrap"><b className="small grow">Can never also be ({dis.length} categories)</b>
          {dis.length ? <button className="btn ghost sm" onClick={() => setShowDis(!showDis)} aria-expanded={showDis}><Icon name={showDis ? "up" : "down"} />{showDis ? "Hide" : "Show"}</button> : null}</div>
        {!dis.length ? <p className="small muted">No upper ontology makes this category disjoint from another.</p> : showDis ? (
          <div className="chips">{dis.map((d) => <a key={d.id} className="chip" href={"#semantic-cat." + d.id} title={Object.entries(d.why).map(([o, [a, b]]) => `${o}: ${labelOf(a)} ⟂ ${labelOf(b)}`).join("\n")}>{catById.get(d.id).label}<span className="tiny muted">{Object.keys(d.why).join(" · ")}</span></a>)}</div>
        ) : <p className="small muted">A thing classified by a concept here and by one in {dis.slice(0, 3).map((d) => catById.get(d.id).label.toLowerCase()).join(", ")}{dis.length > 3 ? "…" : ""} is a contradiction in at least one upper ontology. The playground flags it.</p>}
      </div>
      <div className="stack" style={{ gap: 6 }}>
        <b className="small">{plural(concepts.length, "I2IDL concept")} classify {c.label.toLowerCase()}</b>
        <div className="chips">{concepts.map((x) => <ConceptChip key={x.id} id={x.id} title={(x.rb === "t" ? "From I2IDL's type. " : "From the definition. ") + (x.rw || "")} className={x.rb === "d" ? "bydef" : ""} />)}</div>
        <p className="tiny muted">Dashed: placed here by the definition rather than I2IDL's type (hover for the reason).</p>
      </div>
      {concepts.length ? <div className="row wrap"><a className="btn sm primary" href={"#semantic-try." + concepts[0].id}><Icon name="bolt" />Try {concepts[0].l} in the playground</a></div> : null}
    </section>
  );
}

// ── Playground ─────────────────────────────────────────────────────────────────────────────────────

function Playground({ tryId }) {
  const [text, setText] = useStored("sem.play", SEM.example);
  useEffect(() => { if (tryId && byId.has(tryId)) setText(snippetFor(tryId)); }, [tryId]);
  const slow = useDebounced(text, 250);
  const out = useMemo(() => classify(slow), [slow]);
  const { save } = useCaps();
  const { toast } = useUI();
  const download = async () => {
    try { await save("i2idlx-inferred.ttl", out.turtle); toast("Saved i2idlx-inferred.ttl", { icon: "download" }); }
    catch { (await copyText(out.turtle)) ? toast("Downloads aren't available here — copied the Turtle instead", { icon: "copy" }) : toast("Couldn't save or copy", { icon: "warn" }); }
  };
  return (
    <div className="play">
      <section className="stack" style={{ gap: 8 }}>
        <div className="sec-h"><h3>Your data (Turtle)</h3><span className="meta">Runs in your browser; nothing is sent anywhere</span></div>
        <div className="row wrap">
          <button className="btn sm" onClick={() => setText(SEM.example)}>Sample organization</button>
          <button className="btn sm" onClick={() => setText(SEM.clash)}>A category clash</button>
          {tryId && byId.has(tryId) ? <button className="btn sm" onClick={() => setText(snippetFor(tryId))}>{byId.get(tryId).l}</button> : null}
        </div>
        <textarea className="textarea mono play-in" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} aria-label="Turtle to classify" />
        <p className="tiny muted">Link each thing to the I2IDL concept it is an instance of with <code>i2x:isClassifiedBy</code>, or type it with a peer class a crosswalk bridges (<code>xapi:Statement</code>, <code>tla:TransactionalLRS</code>…). For aboutness use <code>dct:subject</code>.</p>
      </section>
      <section className="stack" style={{ gap: 10 }} aria-live="polite">
        {out.error ? <div className="note warn"><Icon name="warn" /><span><b>Not Turtle yet.</b> {out.error}</span></div> : (
          <>
            <div className="row wrap">
              <b className="grow">{plural(out.resources.length, "resource")} · {plural(out.typings, "typing")} · {out.clashes ? <span className="bad">{plural(out.clashes, "clash", "clashes")}</span> : "no clashes"}</b>
              {out.turtle ? <><CopyBtn small text={out.turtle} label="Copy inferred Turtle" /><button className="btn sm" onClick={download}><Icon name="download" />.ttl</button></> : null}
            </div>
            {!out.resources.length ? <p className="small muted">Nothing here is classified by an I2IDL concept yet.</p> : null}
            {out.resources.map((r) => <ResourceCard key={r.iri} r={r} />)}
            {out.resources.length ? <p className="tiny muted">The same conclusions as the catalog's <a href="#semantic-agents">q-classify</a>, which the build checks against an OWL 2 RL reasoner; clashes come from the category disjointness table, confirmed pair by pair the same way. All of it rests on proposals: Hypothetical.</p> : null}
          </>
        )}
      </section>
    </div>
  );
}

const shortIri = (iri) => (iri.startsWith("_:") ? iri : iri.replace(/^https?:\/\/(www\.)?/, "").replace(/^example\.org\//, "ex:"));

function ResourceCard({ r }) {
  const [open, setOpen] = useState(false);
  const byCol = COLUMNS.map((col) => [col, r.classes.filter((x) => columnOf(x.t) === col.id || (col.id === "peer" && columnOf(x.t) === "foxxi"))]).filter(([, l]) => l.length);
  const own = r.classes.filter((x) => columnOf(x.t) === "i2x");
  return (
    <article className={cx("card pad stack rescard", r.clashes.length && "clash")} style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 8 }}>
        <b className="grow">{r.label || shortIri(r.iri)}</b>
        {r.label ? <code className="tiny muted">{shortIri(r.iri)}</code> : null}
      </div>
      <div className="chips">
        {r.by.map((b) => (
          <span key={b.c} className="row" style={{ gap: 4 }}>
            <ConceptChip id={b.c} />
            {b.how === "bridge" ? <span className="tiny muted" title={`Crosswalk proposal ${b.m} (${b.k}Match), made an OWL bridge in i2idlx-alignments`}>via <code>{b.t}</code></span> : null}
            <a className="tag" href={"#semantic-cat." + byId.get(b.c).rc} title="Referent category">{catById.get(byId.get(b.c).rc).label}</a>
          </span>
        ))}
      </div>
      {r.clashes.map((x, i) => (
        <div key={i} className="note bad"><Icon name="warn" /><span><b>Contradiction.</b> Nothing can be both {catById.get(x.ca).label.toLowerCase()} (<i>{byId.get(x.a).l}</i>) and {catById.get(x.cb).label.toLowerCase()} (<i>{byId.get(x.b).l}</i>): {Object.entries(x.why).map(([o, [a, b]], j) => <span key={o}>{j ? "; " : ""}{o} makes <Term t={a} /> and <Term t={b} /> disjoint</span>)}.</span></div>
      ))}
      {r.problems.map((p, i) => <div key={"p" + i} className="note warn"><Icon name="warn" /><span>{p.text}</span></div>)}
      {r.notes.map((n, i) => <div key={"n" + i} className="note"><Icon name="info" /><span>{n.text}</span></div>)}
      {byCol.length ? (
        <div className="kv rk">
          {byCol.map(([col, list]) => [
            <dt key={col.id + "t"}>{col.label}</dt>,
            <dd key={col.id + "d"} className="chips">{(() => {
              const amb = sameLabel(list.map((x) => x.t));
              return list.map((x) => <Term key={x.t} t={x.t} why={whyText(x)} tag={MIXED.has(col.id) || amb.has(x.t)} />);
            })()}</dd>,
          ])}
        </div>
      ) : null}
      <button className="btn ghost sm" onClick={() => setOpen(!open)} aria-expanded={open} style={{ justifySelf: "start" }}><Icon name={open ? "up" : "down"} />Why</button>
      {open ? (
        <ul className="small whylist">
          {r.by.map((b) => {
            const c = byId.get(b.c);
            const cat = catById.get(c.rc);
            return (
              <li key={b.c}>
                {b.how === "bridge" ? <>Typed <code>{b.t}</code>, which crosswalk proposal <code>{b.m}</code> ({b.k}Match) ties to <b>{c.l}</b>; so it is classified by it. </> : <>Classified by <b>{c.l}</b>. </>}
                Its referent category is <b>{cat.label}</b> ({c.rb === "t" ? `from I2IDL's type “${typeById.get(c.t).label}”` : "from its definition"}: {c.rw}) — {chain(cat.id).length > 1 ? <>a kind of {ancestors(cat.id).map((a) => catById.get(a).label.toLowerCase()).join(", then ")}, </> : null}
                class <code>{cat.cls}</code>, aligned to {classesOf(cat.id).filter((x) => columnOf(x.t) !== "i2x").length} classes in i2idlx-alignments.
                {bridgesOf(b.c).filter((x) => x.k === "broad" || x.k === "exact").map((x) => <span key={x.t}> Crosswalk {x.m} ({x.k}Match) adds <code>{x.t}</code>.</span>)}
              </li>
            );
          })}
          <li className="muted">I2IDL-X's own classes: {own.map((x) => x.t).join(", ")}.</li>
        </ul>
      ) : null}
    </article>
  );
}

function whyText(x) {
  return x.why.map((w) => {
    const c = byId.get(w.c);
    if (w.how === "bridge") return `${c.l}: crosswalk ${w.m} (${w.k}Match)`;
    if (w.k) return `${c.l} → ${catById.get(w.k).label}${w.how === "aligned" ? " (aligned)" : ""}`;
    return `${c.l} → ${w.how === "referent" ? "classified by an I2IDL concept" : "inherited in the published graphs"}`;
  }).join("\n");
}

// ── Records and platforms ──────────────────────────────────────────────────────────────────────────

function AlignTable({ rows, peers }) {
  return (
    <div className="tablewrap">
      <table className="tbl">
        <thead><tr><th>Class</th><th>Aligned to</th>{peers ? <th>Close peers</th> : null}<th>Why</th></tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.s}>
            <td className="nowrap"><Term t={r.s} tag /><div className="tiny muted mono">{r.s}</div></td>
            <td className="chips">{r.t.map((t) => <Term key={t} t={t} tag />)}</td>
            {peers ? <td className="chips">{(r.peers || []).map((t) => <Term key={t} t={t} tag />)}</td> : null}
            <td className="small">{r.why}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function Records() {
  return (
    <div className="stack" style={{ gap: 22 }}>
      <section className="stack" style={{ gap: 8 }}>
        <div className="sec-h"><h2>What I2IDL's records are</h2><Origin o="proposed" quiet /><span className="meta">The concept, definition, evidence, source, collection and scheme records I2IDL publishes, as information entities</span></div>
        <AlignTable rows={SEM.records} />
      </section>
      <section className="stack" style={{ gap: 8 }}>
        <div className="sec-h"><h2>Classification and aboutness</h2><span className="meta">How i2x:isClassifiedBy and friends sit in the upper ontologies</span></div>
        <div className="tablewrap"><table className="tbl"><thead><tr><th>Property</th><th>Axiom</th><th>Why</th></tr></thead>
          <tbody>{SEM.props.map((p) => <tr key={p.s + p.o}><td><code>{p.s}</code></td><td className="nowrap"><code>{p.p}</code> <Term t={p.o} tag /></td><td className="small">{p.why}</td></tr>)}</tbody></table></div>
      </section>
      <section className="stack" style={{ gap: 8 }}>
        <div className="sec-h"><h2>Interego</h2><Origin o="interego" quiet /><span className="meta">Interego's own vocabularies, aligned so a context graph and its descriptors are typed alongside the glossary</span></div>
        <AlignTable rows={SEM.interego} />
      </section>
      <section className="stack" style={{ gap: 8 }}>
        <div className="sec-h"><h2>Foxxi</h2><Origin o="foxxi" quiet /><span className="meta">The IEEE LER and ADL TLA vocabularies Foxxi serves, with their closest peers</span></div>
        <AlignTable rows={SEM.foxxi} peers />
      </section>
      <section className="stack" style={{ gap: 8 }}>
        <div className="sec-h"><h2>I2IDL classifies its own services</h2><span className="meta">The scheme, endpoint and dumps, classified with I2IDL's own concepts</span></div>
        <div className="tablewrap"><table className="tbl"><thead><tr><th>Resource</th><th>Classified by</th><th>Also typed</th></tr></thead>
          <tbody>{SEM.own.map((o) => <tr key={o.iri}><td><code className="iri">{o.iri}</code><div className="tiny muted">{o.why}</div></td><td className="chips">{o.by.map((b) => <ConceptChip key={b} id={b} />)}</td><td className="chips">{o.types.map((t) => <Term key={t} t={t} tag />)}</td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
}

// ── Reasoning record ───────────────────────────────────────────────────────────────────────────────

const Ok = ({ v, yes = "yes", no = "no" }) => <span className={cx("okv", v ? "ok" : "bad")}><Icon name={v ? "check" : "x"} size={12} />{v ? yes : no}</span>;

function Reasoning() {
  const hermit = Object.entries(R.hermit || {});
  return (
    <div className="stack" style={{ gap: 22 }}>
      <section className="stack" style={{ gap: 8 }}>
        <div className="sec-h"><h2>What the build proves before anything is published</h2><Origin o="derived" quiet /></div>
        <div className="tablewrap"><table className="tbl">
          <tbody>
            <tr><td>OWL 2 RL closure over the upper ontologies, I2IDL-X, I2IDL's whole release and the sample organization</td><td className="nowrap">{R.owlrl.input.toLocaleString()} → {R.owlrl.closed.toLocaleString()} triples, {R.owlrl.seconds} s</td><td><Ok v={R.owlrl.errors === 0} yes="consistent" no="inconsistent" /></td></tr>
            {hermit.map(([g, r]) => <tr key={g}><td>HermiT (OWL 2 DL), {g} + I2IDL's release + I2IDL-X + the sample</td><td className="nowrap">{(r.sample || {}).seconds} s</td><td><Ok v={(r.sample || {}).consistent === true} yes="consistent" no={(r.sample || {}).error ? "error" : "inconsistent"} /></td></tr>)}
            <tr><td>The category clash (a formative assessment that is also a classroom teacher) is rejected</td><td>OWL 2 RL{hermit.length ? " and HermiT" : ""}: {R.clash.join(", ")}</td><td><Ok v={R.clash.length === 3} /></td></tr>
            <tr><td>Category disjointness table: {N_DISJOINT} of {N_PAIRS} pairs can never share a member; one individual per pair, OWL 2 RL rejects exactly those</td><td className="nowrap">{R.disjointCheck.seconds} s</td><td><Ok v={R.disjointCheck.agree} yes="agrees" no="differs" /></td></tr>
            <tr><td>SHACL-AF referent rules (TripleRules, no OWL) reach the same referent classes as OWL 2 RL for every explicitly classified resource</td><td className="nowrap">{R.rules.explicit} resources, {R.rules.typings} typings</td><td><Ok v={R.rules.agree} yes="agree" no="differ" /></td></tr>
            <tr><td>q-classify (plain SPARQL) concludes nothing OWL 2 RL does not, and finds every referent class it finds, for the sample organization and the I2IDL services I2IDL-X classifies</td><td className="nowrap" title={`${R.classify.sampleTypings} of the sample organization, ${R.classify.typings - R.classify.sampleTypings} of the I2IDL services i2idlx-referents classifies`}>{R.classify.sampleTypings} + {R.classify.typings - R.classify.sampleTypings} typings</td><td><Ok v={R.classify.sound && R.classify.complete} yes="sound, complete" no="differs" /></td></tr>
            <tr><td>Every aligned term exists in a pinned snapshot of its publisher's file</td><td className="nowrap">{R.terms} terms</td><td><Ok v /></td></tr>
          </tbody>
        </table></div>
      </section>
      <section className="stack" style={{ gap: 8 }}>
        <div className="sec-h"><h2>I2IDL's own records, typed</h2><span className="meta">Every record in the release lands in these classes after reasoning</span></div>
        <div className="tablewrap"><table className="tbl"><thead><tr><th>Records</th><th className="n">Count</th><th>Inferred</th></tr></thead>
          <tbody>{Object.entries(R.records).map(([k, v]) => <tr key={k}><td>{k}</td><td className="n">{v.typed}/{v.count}</td><td className="chips">{v.as.map((t) => <Term key={t} t={t} tag />)}</td></tr>)}</tbody></table></div>
        <p className="small muted">And the concepts themselves, by category: {Object.entries(R.conceptLevel).map(([t, n], i) => <span key={t}>{i ? ", " : ""}{n} <Term t={t} tag /></span>)}.</p>
      </section>
      <section className="stack" style={{ gap: 8 }}>
        <div className="sec-h"><h2>Pinned snapshots</h2><span className="meta">Referenced, not copied: each term is checked against these files; large ontologies are cut to the upward module the alignments use</span></div>
        <div className="tablewrap"><table className="tbl"><thead><tr><th>Vocabulary</th><th>Version</th><th>Licence</th><th>Kept</th><th>SHA-256</th></tr></thead>
          <tbody>{SEM.snapshots.map((s) => <tr key={s.key}><td><a href={s.url} target="_blank" rel="noopener">{s.key}</a></td><td className="small">{s.version || "—"}</td><td className="small">{s.license || "—"}</td><td className="small nowrap">{s.mode ? `${s.mode}${s.kept ? ` · ${s.kept.toLocaleString()}${s.triples ? "/" + s.triples.toLocaleString() : ""} triples` : ""}` : "—"}</td><td><code className="tiny">{(s.sha256 || "").slice(0, 12)}</code></td></tr>)}</tbody></table></div>
      </section>
    </div>
  );
}

// ── For agents ─────────────────────────────────────────────────────────────────────────────────────

function ForAgents() {
  const port = (id) => PORTS.find((p) => p.id === id);
  const qc = QUERIES.find((q) => q.name === "classify");
  const reads = ["port-vocabulary", "port-alignments", "port-referents"].map(port);
  const pub = port("port-publish-classified");
  const py = `# pip install rdflib owlrl
from rdflib import Graph
g = Graph()
for iri in ${JSON.stringify(reads.map((p) => p.u), null, 4)}:
    g.parse(iri, format="turtle")          # what the three catalog ports return
g.parse("my-org.ttl")                      # your data, with i2x:isClassifiedBy links
typed = g.query(Q_CLASSIFY).graph          # Q_CLASSIFY = the catalog's q-classify text
print(typed.serialize(format="turtle"))

# Full OWL 2 RL instead (adds the upper ontologies' own entailments and finds contradictions):
# import owlrl; g.parse(<each upper ontology's file>); owlrl.DeductiveClosure(owlrl.OWLRL_Semantics).expand(g)`;
  const act = { descriptor_url: META.iri.catalog, action_iri: pub.action, payload: Object.fromEntries(pub.expects.props.filter((x) => x.req || x.def).map((x) => [x.n, x.def || `<${x.n}>`])) };
  return (
    <div className="stack" style={{ gap: 18 }}>
      <ol className="steps">
        <li><div className="stack" style={{ gap: 8 }}>
          <p><b>Follow the catalog.</b> Three read ports carry the whole layer; each is a GET on Interego.</p>
          <div className="chips">{reads.map((p) => <a key={p.id} className="chip" href={"#agents-" + p.id}><span className="tag get">GET</span>{p.label}</a>)}</div>
          <CodeBlock title="act (any Interego client)" code={reads.map((p) => "act " + pretty({ descriptor_url: META.iri.catalog, action_iri: p.action, payload: {} })).join("\n\n")} />
        </div></li>
        <li><div className="stack" style={{ gap: 8 }}>
          <p><b>Classify your data without a reasoner.</b> <code>q-classify</code> is plain SPARQL 1.1; it runs client-side over what the three ports return plus your own data (<code>i2x:runsOver</code>).</p>
          <CodeBlock title="Python (rdflib)" code={py} />
          <CodeBlock title="q-classify" code={qc.sparql} />
        </div></li>
        <li><p><b>Or reason in full.</b> Load the upper ontologies' own files (Reasoning lists the versions the alignments were checked against) and run any OWL 2 RL engine, or a DL reasoner such as HermiT, for complete consistency checking.</p></li>
        <li><div className="stack" style={{ gap: 8 }}>
          <p><b>Publish your context graph.</b> Your resources, classified by I2IDL concepts, go to your own pod through <code>{pub.id}</code>; the relay checks them against the I2IDL-X shapes first. Any agent can then discover them and type them the same way.</p>
          <CodeBlock title="act — writes on your behalf" code={"act " + pretty(act)} />
        </div></li>
      </ol>
      <p className="small muted">Use <code>i2x:isClassifiedBy</code> only for instance-of; use <code>dct:subject</code> for aboutness. Everything this layer concludes rests on proposals published <b>Hypothetical</b>: say so when you cite it.</p>
    </div>
  );
}
