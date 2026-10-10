// For the I2IDL team: what their linked data makes possible, laid against their own roadmap.
// Credits what I2IDL built first, then shows each of its next priorities running on its data today.
import { C, META, MAPPINGS, ENACTMENTS, SUGGESTIONS, RELEASES, PORTS, QUERIES, SOURCES, byId, kindPhrase, provenanceLine, controlsFor, iriOf } from "../data.js";
import { useCaps, consensus, CONSENSUS_LABEL } from "../caps.js";
import { Icon } from "../icons.jsx";
import { ConceptChip, CopyBtn, Modal, useUI } from "../ui.jsx";
import { Origin } from "../origin.jsx";
import { QUERIES as QS, bind, runLocal } from "../queries.js";
import { liveGet } from "../lib.js";
import { editorialPacket } from "../packet.js";
import { plural, fmtDate, copyText } from "../util.js";

const { useState, useMemo } = React;

const PRED_ORDER = ["exactMatch", "closeMatch", "narrowMatch", "broadMatch", "relatedMatch"];

export function ForI2IDL() {
  const { tallies, policy, save, downloads } = useCaps();
  const { toast } = useUI();
  const [preview, setPreview] = useState(false);
  const up = META.upstream;
  const prio = (n) => up.priorities.find((x) => x.n === n) || { title: "", anchor: "" };
  const unesco = MAPPINGS.filter((m) => m.v === "UNESCO Thesaurus");
  const grounded = C.filter((c) => c.pv === "g").length;
  const packet = () => editorialPacket({ status: (key) => CONSENSUS_LABEL[consensus(tallies.get(key), policy.quorum)] || "proposed" });
  const download = async () => {
    const name = `i2idl-${META.release}-editorial-packet.md`;
    try { await save(name, packet()); toast("Saved " + name, { icon: "download" }); }
    catch { (await copyText(packet())) ? toast("Downloads aren't available here — copied the Markdown instead", { icon: "copy" }) : toast("Couldn't save or copy", { icon: "warn" }); }
  };
  const appUrl = window.__APP_URL__ ? window.__APP_URL__ + "#for-i2idl" : null;

  return (
    <div className="page fi">
      <header className="fi-hero">
        <div className="eyebrow">For the I2IDL team</div>
        <h1 className="h-display">You made the glossary linked data. <em>Here is what that makes possible.</em></h1>
        <p className="lede">Stable IRIs at <code>id.i2idl.org</code>, first-class definitions, evidence classified <i>direct</i> or <i>supporting</i>, sources that keep their own rights, editorially reviewed SKOS relations and a SPARQL service with published limits. That first step is the hard one, and it is why everything below works without a copy of your data or a change to it.</p>
        <div className="row wrap">
          <button className="btn primary" onClick={download}><Icon name="download" />Editorial packet (Markdown)</button>
          <button className="btn" onClick={() => setPreview(true)}><Icon name="eye" />Preview it</button>
          {appUrl ? <CopyBtn text={appUrl} label="Copy link to this page" icon="link" /> : null}
        </div>
      </header>

      <section className="fi-credit" aria-label="What I2IDL has built">
        <div className="stats">
          {[["Concepts", C.length], ["Evidence records", META.counts.evidence], ["Sources", META.counts.sources],
            ["Related pairs", META.counts.related], ["Broader pairs", META.counts.broader], ["Collections", 31], ["Releases", RELEASES.length]]
            .map(([l, v]) => <div className="stat" key={l}><span className="l">{l}</span><span className="v">{v.toLocaleString()}</span></div>)}
        </div>
        <div className="phases">
          {up.phases.map((ph) => (
            <div key={ph.n} className="phase">
              <span className="pn">Phase {ph.n}</span>
              <b>{ph.title}</b>
              <span className={"pst " + (/^Complete/.test(ph.status) ? "done" : "active")}>{ph.status}</span>
            </div>
          ))}
        </div>
        <p className="tiny muted">From <a href={up.readme} target="_blank" rel="noopener">your README at {META.commit.slice(0, 7)}</a>. Every figure on this page is recomputed from {META.release} at build time.</p>
      </section>

      <section className="stack" style={{ gap: 14 }}>
        <div className="sec-h"><h2>Your next priorities, running on your data today</h2><span className="meta">Your four “next development priorities”, in your words, each with something you can open</span></div>

        <Priority n={1} title={prio(1).title} anchor={prio(1).anchor} o="proposed"
          lead={<>{unesco.length} crosswalks to the <b>UNESCO Thesaurus</b> drawn from citations your editors already made: each I2IDL concept below cites the UNESCO preferred term as <i>direct</i> evidence, so the target is yours; I2IDL-X only proposes the predicate. Plus {MAPPINGS.length - unesco.length} to xAPI, xAPI Profiles, IEEE LER, ADL TLA, schema.org and W3C VC.</>}>
          <UnescoTable rows={unesco} />
          <div className="small muted">Predicates: {PRED_ORDER.map((p) => [p, unesco.filter((m) => m.p === p).length]).filter(([, n]) => n).map(([p, n]) => `${n} ${p}`).join(" · ")}. All are proposals: a <code>skos:*Match</code> triple appears only after ratification, internal relations and external mappings stay distinct (the shapes reject any crosswalk that points back into <code>id.i2idl.org</code>), and {META.unesco.groups.filter((g) => g.only).length} concepts that cite only a UNESCO microthesaurus group get a modeling note instead of a mapping.</div>
          <div className="row wrap">
            <a className="btn sm primary" href="#review-method.evidence-cited"><Icon name="review" />Review the {unesco.length}</a>
            <a className="btn sm" href={META.iri.mappings} target="_blank" rel="noopener"><Icon name="external" />The proposals graph</a>
          </div>
        </Priority>

        <Priority n={2} title={prio(2).title} anchor={prio(2).anchor} o="interego"
          lead={<>Your three example routes, answered today as projections of your canonical graph: stored queries against your own SPARQL service and your own content negotiation. No second source of truth, no new server.</>}>
          <ApiRoutes routes={up.routes} />
          <div className="small muted">For agents, the same projections are a HyprCat catalog on Interego: {PORTS.length} controls, {QUERIES.length} stored queries and your published limits as data, pointing at <code>id.i2idl.org</code>.</div>
          <div className="row wrap"><a className="btn sm" href="#agents"><Icon name="agent" />Agent console</a><a className="btn sm" href={META.iri.catalog} target="_blank" rel="noopener"><Icon name="external" />The catalog graph</a></div>
        </Priority>

        <Priority n={3} title={prio(3).title} anchor={prio(3).anchor} o="derived"
          lead={<>Your two lines, word for word, on every entry here, computed from your own evidence relations: <b>{grounded}</b> “{up.provenance[0]}” and <b>{C.length - grounded}</b> “{up.provenance[1]}”.</>}>
          <ProvenanceCards />
          <div className="small muted">The same rule is published as SHACL in <code>i2idlx-rules</code>, so any SHACL engine reproduces it over the next release.</div>
        </Priority>

        <Priority n={4} title={prio(4).title} anchor={prio(4).anchor} o="derived"
          lead={<>Every change since {META.changes.baseline} as PROV: {META.changes.releaseChanges} release changes (each <code>prov:used</code> the previous release and <code>prov:generated</code> the next), {META.changes.events} typed change events, {META.changes.facts.toLocaleString()} fact-level changes. It reconciles exactly with {META.release}.</>}>
          <ChangeLog />
          <div className="small muted">Every event type your README lists has a kind, refined where the history shows a difference: evidence that received its first relation is <i>classified</i>, not <i>reclassified</i>. Each entry here shows its own history.</div>
          <div className="row wrap">
            <a className="btn sm" href={META.iri.changes} target="_blank" rel="noopener"><Icon name="external" />The change history graph</a>
            <a className="btn sm" href="#c-learning-record-store-lrs"><Icon name="history" />A term's history</a>
            <a className="btn sm ghost" href="#insights-releases"><Icon name="insights" />Release charts</a>
          </div>
        </Priority>
      </section>

      <section className="stack" style={{ gap: 14 }}>
        <div className="sec-h"><h2>Beyond the roadmap</h2><span className="meta">What else your graph supports once it can be read, linked and acted on</span></div>
        <div className="tiles">
          <Tile icon="link" o="derived" title="Definitions as hypertext" href="#insights" body={<>{META.counts.links} links found in your own wording, and {SUGGESTIONS.length} places where an entry names a concept it doesn't relate to: a ready worklist for editors.</>} />
          <Tile icon="bolt" o="proposed" title="Concepts that act" href="#agents" body={<>{ENACTMENTS.length} links from your concepts to live capabilities — an LRS to Foxxi's <code>discover-lrs</code>, A/B testing to an experiment designer — each Hypothetical until reviewed.</>} />
          <Tile icon="review" o="team" title="Review with a paper trail" href="#review" body={<>Votes compose under Interego's ratification algebra. A ratified crosswalk becomes a prefilled issue in your repository; your editors still decide.</>} />
          <Tile icon="pack" o="i2idl" title="Packs that carry your attribution" href="#packs" body={<>Handouts, Markdown, CSV, JSON-LD and flashcards export with I2IDL's CC BY attribution and each source's own terms, warning before non-commercial material leaves.</>} />
          <Tile icon="edit" o="derived" title="Annotate any text" href="#annotate" body={<>Paste a syllabus or a spec: every I2IDL term in it is found, linked to its IRI, and can be tagged on xAPI statements as Foxxi <code>conceptIds</code>.</>} />
          <Tile icon="agent" o="interego" title="Agents that cite your IRIs" href="#ask" body={<>Agents follow the catalog's controls within your published limits; Ask Claude answers from your release and cites terms as links to their entries.</>} />
          <Tile icon="tree" o="proposed" title="A classification scheme for the industry's data" href="#semantic" body={<>Each of your concepts says what kind of thing it names. Data an LRS vendor, a university or a badge issuer links to your IRIs is then typed in BFO 2020, gist, DOLCE-UltraLite, gUFO, PROV-O, schema.org, CTDL, ESCO and Open Badges, and a contradiction — a quiz that is also a teacher — is caught.</>} />
        </div>
      </section>

      <section className="stack" style={{ gap: 12 }}>
        <div className="sec-h"><h2>How I2IDL-X stays out of your way</h2></div>
        <ul className="principles">
          <li><b>Your IRIs stay canonical.</b> Nothing is minted under <code>id.i2idl.org</code>; the I2IDL-X graphs live on Interego and point at your IRIs. Your README asks that “{lastSentence(up.principle)}” — I2IDL-X depends on exactly that.</li>
          <li><b>Your record is untouched.</b> This page embeds {META.release} as published. The <b>I2IDL only</b> lens in the top bar shows it with every layer hidden, and every addition is labelled with where it comes from.</li>
          <li><b>Claims you haven't made stay Hypothetical.</b> Crosswalks and capability links are proposals until reviewers ratify them, and even then they reach you as a suggestion, never an edit.</li>
          <li><b>Rights travel with the words.</b> Every evidence record keeps its source's terms; exports carry I2IDL's attribution and each source's rights.</li>
          <li><b>Lightweight, like your architecture.</b> No new server and no copy of record: a projection of your JSON-LD and your SPARQL service, rebuilt and re-checked against each release.</li>
        </ul>
      </section>

      <section className="fi-take card pad stack" style={{ gap: 10 }}>
        <div className="row"><Icon name="download" /><b className="grow">Take it with you</b></div>
        <p className="small">The editorial packet gathers everything above for your editors: the {unesco.length} UNESCO candidates with both texts side by side, the other {MAPPINGS.length - unesco.length} crosswalk candidates, the provenance counts, the change log, the {SUGGESTIONS.length} unlinked mentions as a checklist, and the health checks. One Markdown file; forward it, or turn lines into issues.</p>
        <div className="row wrap">
          <button className="btn sm primary" onClick={download}><Icon name="download" />Download</button>
          <button className="btn sm" onClick={() => setPreview(true)}><Icon name="eye" />Preview</button>
          <CopyBtn text={packet} label="Copy Markdown" small />
        </div>
        <p className="tiny muted">Independent work by Mark Spivey (Foxxi Mediums Inc.), built with Claude. Not affiliated with or endorsed by I2IDL. I2IDL-original material: {META.license.holder}, {META.license.name}.</p>
      </section>
      {preview ? <PacketPreview text={packet()} onClose={() => setPreview(false)} onDownload={download} /> : null}
    </div>
  );
}

const lastSentence = (s) => { const parts = s.split(/(?<=\.)\s+/); return parts[parts.length - 1].replace(/\.$/, ""); };

function Priority({ n, title, anchor, o, lead, children }) {
  return (
    <article className="prio">
      <div className="prio-h">
        <span className="prio-n">{n}</span>
        <div className="grow"><h3>{title}</h3><a className="tiny muted" href={META.upstream.readme + "#" + anchor} target="_blank" rel="noopener">your README, next priority {n}</a></div>
        <Origin o={o} quiet />
      </div>
      <p className="prio-lead">{lead}</p>
      <div className="stack" style={{ gap: 10 }}>{children}</div>
    </article>
  );
}

function UnescoTable({ rows }) {
  return (
    <div className="tablewrap"><table className="tbl">
      <thead><tr><th>I2IDL concept</th><th>Proposed</th><th>UNESCO Thesaurus term</th><th className="n">Confidence</th></tr></thead>
      <tbody>{rows.map((m) => (
        <tr key={m.id}>
          <td><ConceptChip id={m.c} /></td>
          <td><code>skos:{m.p}</code></td>
          <td><a href={m.pg} target="_blank" rel="noopener" title={m.o}>{m.ol}</a>{m.od ? <div className="tiny muted ellipsis" style={{ maxWidth: 360 }} title={m.od}>{m.od}</div> : null}</td>
          <td className="n">{m.cf.toFixed(2)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function ApiRoutes({ routes }) {
  const [open, setOpen] = useState(null);
  const rows = useMemo(() => routes.map((r) => {
    const q = r.match(/\?q=([^&]+)/);
    const id = r.split("/").pop().split("?")[0];
    if (q) {
      const sq = QS.find((x) => x.name === "concept-search");
      return { route: r, how: "stored query concept-search on your SPARQL service", url: liveGet(bind(sq, { text: decodeURIComponent(q[1]) })), local: runLocal("concept-search", { text: decodeURIComponent(q[1]) }) };
    }
    if (r.startsWith("/api/related/")) {
      const c = byId.get(id);
      return { route: r, how: "stored query concept-neighborhood (CONSTRUCT)", url: c ? controlsFor(c).find((x) => x.id === "neighborhood").u : null, local: runLocal("concept-neighborhood", { concept: id }) };
    }
    const c = byId.get(id);
    return { route: r, how: "your own content negotiation", url: c ? iriOf(c.id) + ".jsonld" : null, local: c ? { head: ["concept", "label"], rows: [[c.id, c.l]], concept: true } : null };
  }), [routes]);
  return (
    <div className="routes">
      {rows.map((r, i) => (
        <div key={r.route} className="route">
          <div className="row wrap" style={{ gap: 8 }}>
            <code className="rt">{r.route}</code><Icon name="arrowRight" size={14} /><span className="small muted grow">{r.how}</span>
            {r.url ? <a className="btn sm" href={r.url} target="_blank" rel="noopener"><Icon name="external" />Live</a> : null}
            <button className="btn sm ghost" onClick={() => setOpen(open === i ? null : i)} aria-expanded={open === i}>{open === i ? "Hide" : "Try here"}</button>
          </div>
          {open === i && r.local ? (
            <div className="chips" style={{ marginTop: 8 }}>
              {r.local.rows.slice(0, 12).map((row, k) => (r.local.head[0] === "predicate" ? (row[1] ? <ConceptChip key={k} id={row[1]} /> : null) : <ConceptChip key={k} id={row[0]} />))}
              {r.local.rows.length > 12 ? <span className="small muted">+{r.local.rows.length - 12} more</span> : null}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ProvenanceCards() {
  const pick = (pv, prefer) => byId.get(prefer) && byId.get(prefer).pv === pv ? byId.get(prefer) : C.find((c) => c.pv === pv && c.d.length < 220);
  const cards = [pick("g", "data-privacy"), pick("s", "learning-engineering")].filter(Boolean);
  return (
    <div className="pcards">
      {cards.map((c) => (
        <a key={c.id} className="pcard" href={"#c-" + c.id}>
          <div className="pt">{c.l}</div>
          <div className="pd">{c.d.length > 200 ? c.d.slice(0, 200).replace(/\s+\S*$/, "") + "…" : c.d}</div>
          <div className={"provline " + c.pv}><span>Definition provenance: <b>{provenanceLine(c)}</b></span></div>
        </a>
      ))}
    </div>
  );
}

function ChangeLog() {
  const rows = RELEASES.filter((r) => r.nch).reverse();
  return (
    <ol className="clog">
      {rows.map((r) => (
        <li key={r.v}>
          <div className="cv"><b>{r.v}</b><span className="tiny muted">{fmtDate(r.at)}</span></div>
          <div className="cd">{Object.entries(r.ch).map(([k, n]) => { const [num, ...rest] = kindPhrase(k, n).split(" "); return <span key={k} className="cchg"><b>{num}</b> {rest.join(" ")}</span>; })}</div>
        </li>
      ))}
      <li className="base"><div className="cv"><b>{META.changes.baseline}</b><span className="tiny muted">{fmtDate(META.changes.baselineDate)}</span></div><div className="cd">First public release: {META.changes.baselineCounts.concepts} concepts, {META.changes.baselineCounts.evidence} evidence records, {META.changes.baselineCounts.collections} collections</div></li>
    </ol>
  );
}

function Tile({ icon, o, title, body, href }) {
  return (
    <a className="tile fitile" href={href}>
      <Origin o={o} quiet />
      <div className="row"><Icon name={icon} /><b className="grow">{title}</b></div>
      <p className="small">{body}</p>
    </a>
  );
}

function PacketPreview({ text, onClose, onDownload }) {
  return (
    <Modal title="Editorial packet" onClose={onClose} wide footer={<><CopyBtn text={text} label="Copy Markdown" /><button className="btn primary" onClick={onDownload}><Icon name="download" />Download</button></>}>
      <pre className="packet">{text}</pre>
    </Modal>
  );
}
