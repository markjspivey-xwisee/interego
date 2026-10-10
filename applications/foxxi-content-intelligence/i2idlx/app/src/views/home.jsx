// Home: one search box, the day's term, and the ways in — fields, collections, kinds, and the layers.
import { C, META, KINDS, COLLECTIONS, byId, kindById, fieldById, termOfDay, ITEMS, ENACTMENTS, MAPPINGS, ACTIONS, QUERIES, SEMANTIC } from "../data.js";
import { useCaps, consensus } from "../caps.js";
import { Icon } from "../icons.jsx";
import { ConceptChip, useUI } from "../ui.jsx";
import { Origin } from "../origin.jsx";
import { Hypertext } from "../text.jsx";
import { plural, go, store } from "../util.js";

const { useMemo } = React;

function KindBar({ ids }) {
  const counts = KINDS.map((k) => [k.id, ids.filter((id) => byId.get(id).k === k.id).length]).filter(([, n]) => n);
  const total = ids.length || 1;
  return <div className="kbar" aria-hidden="true">{counts.map(([k, n]) => <span key={k} className={"kd-" + k} style={{ width: (n / total) * 100 + "%" }} />)}</div>;
}

export function Home() {
  const { palette, ask } = useUI();
  const { ws, tallies, policy, signedIn, writable } = useCaps();
  const wotd = termOfDay();
  const recents = (store.get("recents", []) || []).filter((id) => byId.has(id)).slice(0, 8);
  const fieldMembers = useMemo(() => new Map(COLLECTIONS.field.map((f) => [f.id, C.filter((c) => c.f.includes(f.id)).map((c) => c.id)])), []);
  const review = useMemo(() => {
    let need = 0, ratified = 0;
    for (const i of ITEMS) {
      const s = consensus(tallies.get(i.key), policy.quorum);
      if (s === "ratified") ratified++;
      if (s === "proposed") need++;
    }
    return { need, ratified };
  }, [tallies, policy]);
  const nFoxxi = new Set(ENACTMENTS.filter((e) => ACTIONS[e.a] && ACTIONS[e.a].sys !== "relay").map((e) => e.a)).size;
  return (
    <div className="page">
      <div className="home-grid">
        <section className="hero">
          <div className="eyebrow">I2IDL Digital Learning Glossary · {META.release} · with I2IDL-X</div>
          <h1>Every digital-learning term, <em>with what you can do with it.</em></h1>
          <p className="lede">{C.length} approved definitions from <b>I2IDL</b>, exactly as published, with their evidence, rights and relations. Kept visibly separate on top: the <b>I2IDL-X</b> layer — provenance lines, history and reading aids derived from I2IDL's own data; capability links to Foxxi and Interego and crosswalks to UNESCO, xAPI, IEEE LER, ADL TLA and schema.org, proposed for review — and your team's votes, notes and usage.</p>
          <button className="bigsearch" onClick={() => palette.open()}><Icon name="search" size={20} /><span className="grow">Search terms, definitions, sources…</span><kbd>/</kbd></button>
          <div className="statline">
            <span><b>{C.length}</b> terms</span><span><b>{META.counts.evidence}</b> evidence records</span><span><b>{META.counts.sources}</b> sources</span>
            <span><b>{META.counts.related}</b> related pairs</span><span><b>{ENACTMENTS.length}</b> capability links</span><span><b>{MAPPINGS.length}</b> crosswalks</span>
          </div>
        </section>

        <a className="fi-banner" href="#for-i2idl">
          <Icon name="flag" />
          <span className="grow"><b>For the I2IDL team:</b> your four next priorities — crosswalks, a query layer, visible provenance, change history — running on your data today, plus an editorial packet to take away.</span>
          <span className="btn sm">Open <Icon name="arrowRight" /></span>
        </a>
        <div className="legend-row" aria-label="Layers">
          <Origin o="i2idl" /><Origin o="derived" /><Origin o="added" /><Origin o="proposed" /><Origin o="interego" /><Origin o="foxxi" /><Origin o="team" />
          <span className="tiny muted">Every element carries one of these labels. Click one to see what it covers.</span>
        </div>

        <div className="two">
          <section className="wotd" aria-label="Term of the day">
            <div className="row"><span className="eyebrow grow">Term of the day</span><span className={"dot kd-" + wotd.k} /><span className="small muted">{kindById.get(wotd.k).label} · {fieldById.get(wotd.pf).label}</span></div>
            <h3><a href={"#c-" + wotd.id} style={{ color: "inherit", textDecoration: "none" }}>{wotd.l}</a></h3>
            <p><Hypertext text={wotd.d} spans={wotd.md} linked={new Set([...wotd.r, ...wotd.b, ...wotd.n])} /></p>
            <div className="chips">{wotd.r.slice(0, 5).map((x) => <ConceptChip key={x} id={x} />)}</div>
            <div className="row wrap"><a className="btn sm" href={"#c-" + wotd.id}>Open entry <Icon name="arrowRight" /></a><a className="btn sm ghost" href={"#map-" + wotd.id}><Icon name="graph" />Neighborhood</a></div>
          </section>
          <section className="stack" aria-label="Your workspace">
            <div className="card pad stack" style={{ gap: 10 }}>
              <div className="row"><Icon name="review" /><b className="grow">Review queue</b><a className="small" href="#review">Open</a></div>
              <div className="small muted">{review.need} of {ITEMS.length} proposed capability links and crosswalks have no votes yet · {review.ratified} ratified here.{!signedIn ? " Sign in to vote." : !writable ? " View-only access." : ""}</div>
              <div className="progress" aria-hidden="true"><span style={{ width: ((ITEMS.length - review.need) / ITEMS.length) * 100 + "%", background: "var(--accent)" }} /></div>
            </div>
            <div className="card pad stack" style={{ gap: 10 }}>
              <div className="row"><Icon name="pack" /><b className="grow">Packs</b><a className="small" href="#packs">Open</a></div>
              {ws.packs.length ? ws.packs.slice(0, 3).map((p) => <a key={p.id} href={"#packs-" + p.id} className="row small" style={{ textDecoration: "none" }}><span className="grow">{p.name}</span><span className="muted">{plural(p.items.length, "term")}</span></a>)
                : <div className="small muted">Build a course glossary from any terms, with notes and attribution, and export it as a handout, CSV, JSON-LD, flashcards or xAPI tags.</div>}
            </div>
            {recents.length ? (
              <div className="card pad stack" style={{ gap: 8 }}>
                <div className="row"><Icon name="history" /><b>Recently viewed</b></div>
                <div className="chips">{recents.map((id) => <ConceptChip key={id} id={id} />)}</div>
              </div>
            ) : null}
          </section>
        </div>

        <section>
          <div className="sec-h"><h2>Fields</h2><Origin o="i2idl" quiet /><span className="meta">I2IDL's field collections · bars show I2IDL-X agentic kinds</span></div>
          <div className="tiles">
            {COLLECTIONS.field.map((f) => (
              <a key={f.id} className="tile" href={"#browse-f." + f.id}>
                <div className="tt"><span className="grow">{f.label}</span><span className="muted small">{f.n}</span></div>
                <KindBar ids={fieldMembers.get(f.id)} />
              </a>
            ))}
          </div>
        </section>

        <section>
          <div className="sec-h"><h2>Curated collections</h2><Origin o="i2idl" quiet /></div>
          <div className="tiles">
            {COLLECTIONS.curated.map((f) => (
              <a key={f.id} className="tile" href={"#browse-cu." + f.id}>
                <div className="tt"><Icon name="book" /><span className="grow">{f.label}</span><span className="muted small">{f.n}</span></div>
                <div className="td">{f.desc}</div>
              </a>
            ))}
          </div>
        </section>

        <section>
          <div className="sec-h"><h2>Agentic kinds</h2><Origin o="derived" quiet /><span className="meta">What an agent can do with a concept, derived from I2IDL's 16 types</span></div>
          <div className="tiles">
            {KINDS.map((k) => (
              <a key={k.id} className="tile" href={"#browse-k." + k.id}>
                <div className="tt"><span className={"dot kd-" + k.id} /><span className="grow">{k.label}</span><span className="muted small">{C.filter((c) => c.k === k.id).length}</span></div>
                <div className="td">{k.def.split(". ")[0]}.</div>
              </a>
            ))}
          </div>
        </section>

        <section>
          <div className="sec-h"><h2>Three ways a term means</h2><span className="meta">Peirce's interpretants, via Interego: one is I2IDL's, two are layered on top</span></div>
          <div className="layer-intro">
            <div className="li-card"><div className="lt"><span className="chip asserted">Asserted</span>Editorial<Origin o="i2idl" quiet /></div><p>I2IDL's definition, editorial note and evidence: the meaning as written, with sources and rights. Never restated or altered here.</p></div>
            <div className="li-card hyp"><div className="lt"><span className="chip hypothetical">Hypothetical</span>Pragmatic<Origin o="proposed" quiet /></div><p>What enacts it: {ENACTMENTS.length} links to {nFoxxi} Foxxi and Interego actions, plus {MAPPINGS.length} crosswalks to other vocabularies — proposed, ratified by your votes.</p></div>
            <div className="li-card"><div className="lt"><Icon name="users" />Usage<Origin o="team" quiet /></div><p>Meaning that accrues from use: who on your team uses a term and where, their notes, and xAPI statements tagged with its IRI.</p></div>
          </div>
        </section>

        <section>
          <div className="sec-h"><h2>What the terms classify</h2><Origin o="proposed" quiet /><span className="meta">Every concept names a kind of thing; your data classified by it is typed in every upper ontology</span></div>
          <div className="tiles">
            {[...new Set(SEMANTIC.categories.map((k) => k.group))].map((g) => {
              const cats = SEMANTIC.categories.filter((k) => k.group === g);
              const n = C.filter((c) => cats.some((k) => k.id === c.rc)).length;
              return (
                <a key={g} className="tile" href={"#semantic-cat." + cats[0].id}>
                  <div className="tt"><Icon name="tree" /><span className="grow">{g}</span><span className="muted small">{n}</span></div>
                  <div className="td">{cats.map((k) => k.label).join(" · ")}</div>
                </a>
              );
            })}
          </div>
          <div className="row wrap" style={{ marginTop: 10 }}>
            <a className="btn sm primary" href="#semantic-play"><Icon name="bolt" />Classify your own data</a>
            <span className="small muted">BFO 2020 · IAO · CCO · gist · DOLCE-UltraLite · gUFO · PROV-O · schema.org · CTDL · ESCO · ELM · LRMI · Open Badges · CASE · xAPI</span>
          </div>
        </section>

        <section className="card pad stack" style={{ gap: 10 }}>
          <div className="row"><Icon name="agent" /><b className="grow">Agent-ready from one IRI</b><a className="small" href="#agents">Agent console</a></div>
          <p className="small muted">Point any agent at the HyprCat catalog on Interego. It lists every port (SPARQL, dumps, per-concept templates, the semantic layer, governed writes, Foxxi capabilities), the service limits and {QUERIES.length} stored queries.</p>
          <code className="iri">{META.iri.catalog}</code>
        </section>
        <p className="tiny muted">Glossary content {META.license.holder}, {META.license.name} for I2IDL-original material; third-party source material keeps its own rights, shown on every evidence record. Interpretant is an independent workbench and is not affiliated with or endorsed by I2IDL.</p>
      </div>
    </div>
  );
}
