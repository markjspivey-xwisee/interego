// Agent console: the HyprCat catalog on Interego, the published graphs, stored queries you can try here
// and run live, and the Foxxi / Interego capability directory with what each action enacts.
import { META, PORTS, ACTIONS, byId, conceptsByAction, roleById, systemLabel, COLLECTIONS } from "../data.js";
import { Icon } from "../icons.jsx";
import { ConceptChip, CodeBlock, CopyBtn, MethodTag, ModalChip, Seg, useUI } from "../ui.jsx";
import { ConceptPicker } from "../picker.jsx";
import { QUERIES, bind, runLocal, defaults, COLLECTION_OPTIONS, PARAM_KIND } from "../queries.js";
import { actQuery, curlQuery, liveGet, pretty } from "../lib.js";
import { cx, plural, useStored, go } from "../util.js";

import { OriginStrip } from "../origin.jsx";
import { curieOf } from "../semantic.js";
const { useState, useMemo, useEffect } = React;

const SEMANTIC_PORTS = new Set(["port-vocabulary", "port-alignments", "port-referents"]);
const GROUP_OF = (p) => (p.routed ? "Human-routed" : SEMANTIC_PORTS.has(p.id) ? "Semantic layer (graphs on Interego)" : p.action.includes("/action/foxxi/") ? "Foxxi capabilities" : p.tpl ? "Per-concept templates" : !p.ro ? "Governed writes through Interego" : "Reads on the live glossary");
const GROUPS = ["Reads on the live glossary", "Semantic layer (graphs on Interego)", "Per-concept templates", "Governed writes through Interego", "Foxxi capabilities", "Human-routed"];

export function Agents({ route }) {
  const section = route.section || "";
  useEffect(() => {
    if (!section) return;
    const id = section.startsWith("act.") ? "act-" + section.slice(4) : section;
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) { if (el.tagName === "DETAILS") el.open = true; el.scrollIntoView({ block: "start", behavior: "smooth" }); }
    }, 60);
  }, [section]);
  return (
    <div className="page ag">
      <header className="stack" style={{ gap: 10 }}>
        <div className="eyebrow">Agent console · HyprCat on Interego</div>
        <h1 className="h-display" style={{ fontSize: 30 }}>One IRI, the whole glossary</h1>
        <p className="lede">The glossary is a <code>hyprcat:FederatedDataProduct</code>: an agent reads one catalog and finds every port, template, stored query, limit and governed write — then follows them with Interego's <code>act</code>, or over plain HTTP.</p>
        <div className="row wrap" style={{ gap: 8 }}>
          <code className="iri" style={{ fontSize: 13 }}>{META.iri.catalog}</code><CopyBtn text={META.iri.catalog} small label="Copy" />
          <a className="btn sm" href={META.iri.catalog + "?format=markdown"} target="_blank" rel="noopener"><Icon name="external" />HyperMarkdown</a>
          <a className="btn sm" href={META.iri.catalog + "?format=turtle"} target="_blank" rel="noopener">Turtle</a>
        </div>
        <OriginStrip items={[["interego", "catalog, graphs, act"], ["i2idl", "your endpoint and dumps"], ["foxxi", "capabilities"], ["proposed", "enactments"]]} />
        <QuickStart />
      </header>
      <Graphs />
      <Ports />
      <Queries />
      <Directory route={route} />
      <Limits />
      <Brief />
    </div>
  );
}

function QuickStart() {
  const [tab, setTab] = useStored("ag.qs", "mcp");
  const search = QUERIES.find((q) => q.name === "concept-search");
  const sparql = bind(search, { text: "record store" });
  const code = tab === "mcp"
    ? `// 1. Read the catalog (any Interego client)\nresolve_linked_data ${pretty({ iri: META.iri.catalog, format: "markdown" })}\n\n// 2. Query the glossary through the catalog's POST port\nact ${pretty(actQuery(sparql))}\n\n// 3. Follow a Foxxi capability from an enactment\nact ${pretty({ descriptor_url: META.foxxiManifest, action_iri: META.actionRoot + "foxxi/discover-lrs", payload: {} })}`
    : tab === "http" ? `curl -H 'Accept: text/turtle' ${META.iri.catalog}\n\n${curlQuery(sparql)}\n\ncurl -H 'Accept: text/turtle' https://id.i2idl.org/concepts/learning-record-store-lrs.ttl`
      : sparql;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <Seg label="Quick start" value={tab} onChange={setTab} options={[{ v: "mcp", l: "Interego (MCP)" }, { v: "http", l: "Plain HTTP" }, { v: "sparql", l: "SPARQL" }]} />
      <CodeBlock title={tab === "mcp" ? "Three calls" : tab === "http" ? "curl" : "Find concepts by label"} code={code} />
    </div>
  );
}

function Graphs() {
  return (
    <section id="graphs" className="stack">
      <div className="sec-h"><h2>Published graphs</h2><span className="meta">Live on Interego at <code>/ns/{META.base.split("/ns/")[1]}/…</code>, signed and content-negotiated</span></div>
      <div className="tablewrap">
        <table className="tbl">
          <thead><tr><th>Graph</th><th>Status</th><th className="n">Triples</th><th>Formats</th><th>Descriptor</th></tr></thead>
          <tbody>
            {META.graphs.map((g) => (
              <tr key={g.key}>
                <td><b>{g.title}</b><div className="iri">{g.iri}</div></td>
                <td><ModalChip status={g.status} /></td>
                <td className="n">{g.triples.toLocaleString()}</td>
                <td className="nowrap"><a href={g.iri + "?format=turtle"} target="_blank" rel="noopener">Turtle</a> · <a href={g.iri + "?format=jsonld"} target="_blank" rel="noopener">JSON-LD</a> · <a href={g.iri + "?format=markdown"} target="_blank" rel="noopener">MD</a></td>
                <td><a href={g.descriptor} target="_blank" rel="noopener">Signed</a> <CopyBtn small text={g.hash} title={"Copy content hash " + g.hash} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Ports() {
  const groups = GROUPS.map((g) => [g, PORTS.filter((p) => GROUP_OF(p) === g)]).filter(([, l]) => l.length);
  return (
    <section id="ports" className="stack">
      <div className="sec-h"><h2>Controls</h2><span className="meta">{PORTS.length} affordances: {PORTS.filter((p) => p.u).length} followable, {PORTS.filter((p) => p.tpl).length} templates an agent expands</span></div>
      {groups.map(([g, list]) => (
        <div key={g} className="stack" style={{ gap: 6 }}>
          <div className="eyebrow">{g}</div>
          <div className="ports">{list.map((p) => <Port key={p.id} p={p} />)}</div>
        </div>
      ))}
    </section>
  );
}

function Port({ p }) {
  const example = p.tpl ? null : p.m === "GET" && p.ro && !p.expects ? `curl -H 'Accept: ${p.mt}' '${p.u}'` : null;
  const act = { descriptor_url: META.iri.catalog, action_iri: p.action, payload: p.expects && p.expects.props && p.expects.props.length ? Object.fromEntries(p.expects.props.filter((x) => x.req || x.def).map((x) => [x.n, x.def || `<${x.n}>`])) : p.id === "port-sparql-post" ? "<SPARQL query text>" : {} };
  return (
    <details className="port" id={p.id}>
      <summary>
        <MethodTag m={p.m} />
        <span className="pt">{p.label}</span>
        <span className="row" style={{ gap: 6 }}>{p.ro ? <span className="tag">read-only</span> : <span className="tag post">writes</span>}<Icon name="down" /></span>
        <span className="pu">{p.u || p.tpl}</span>
      </summary>
      <div className="pb">
        <p className="small">{p.desc || p.title}</p>
        <dl className="kv">
          <dt>Action</dt><dd><code className="iri">{p.action}</code></dd>
          {p.u ? <><dt>Target</dt><dd><code className="iri">{p.u}</code></dd></> : null}
          {p.tpl ? <><dt>Template</dt><dd><code className="iri">{p.tpl}</code> <span className="muted small">({p.vars.map((v) => `${v.v} ← ${v.p.split(/[#/]/).pop()}`).join(", ")})</span></dd></> : null}
          <dt>Media type</dt><dd><code>{p.mt}</code></dd>
          {p.via ? <><dt>Delegates to</dt><dd><code className="iri">{p.via}</code></dd></> : null}
          {p.cap ? <><dt>Requires</dt><dd><code>i2x:{p.cap}</code></dd></> : null}
        </dl>
        {p.expects ? (
          <div className="stack" style={{ gap: 4 }}>
            <b className="small">Input · {p.expects.label}</b>
            {p.expects.note ? <p className="small muted">{p.expects.note}</p> : null}
            <div className="inputs">{p.expects.props.map((x) => <div className="in" key={x.n}><code>{x.n}{x.req ? <span className="req"> *</span> : null}</code><span className="muted">{x.c || ""}{x.def ? ` Default: ${x.def}.` : ""}{x.pat ? ` Pattern: ${x.pat}.` : ""}</span></div>)}</div>
          </div>
        ) : null}
        {!p.tpl ? <CodeBlock title={p.ro ? "Through Interego (act)" : "Through Interego (act) — writes on your behalf"} code={pretty(act)} /> : null}
        {example ? <CodeBlock title="Plain HTTP" code={example} /> : null}
      </div>
    </details>
  );
}

function Queries() {
  return (
    <section id="queries" className="stack">
      <div className="sec-h"><h2>Stored queries</h2><span className="meta">Try them here on the embedded release, then run them live (30 requests a minute); the semantic-layer queries run client-side</span></div>
      <div className="stack" style={{ gap: 10 }}>{QUERIES.map((q) => <QueryCard key={q.id} q={q} />)}</div>
    </section>
  );
}

function QueryCard({ q }) {
  const [v, setV] = useState(() => defaults(q));
  const [res, setRes] = useState(null);
  const sparql = bind(q, v);
  const set = (p, x) => { setV((o) => ({ ...o, [p]: x })); setRes(null); };
  return (
    <div className="qcard" id={q.id}>
      <div className="row wrap"><b className="grow">{q.label}</b><span className="tag">{q.form}</span></div>
      <p className="small muted">{q.desc}</p>
      {q.params.length ? (
        <div className="qparams">
          {q.params.map((p) => (
            <label className="field" key={p}><span>${p}</span>
              {PARAM_KIND[p] === "concept" ? <ConceptPicker value={v[p]} onPick={(x) => set(p, x)} />
                : PARAM_KIND[p] === "collection" || PARAM_KIND[p] === "type" ? (
                  <select className="select" value={v[p]} onChange={(e) => set(p, e.target.value)}>
                    {COLLECTION_OPTIONS.filter((o) => PARAM_KIND[p] !== "type" || o.v.startsWith("type/")).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}
                  </select>
                ) : <input className="input" value={v[p]} onChange={(e) => set(p, e.target.value)} />}
            </label>
          ))}
        </div>
      ) : null}
      <CodeBlock title="SPARQL (bound)" code={sparql} />
      {q.over ? (
        <div className="row wrap">
          <button className="btn sm primary" onClick={() => setRes(runLocal(q.name, v))}><Icon name="bolt" />Try here</button>
          <span className="tag" title="i2x:runsOver: follow these ports, add your own data, run the query in any SPARQL 1.1 engine">client-side</span>
          <span className="small muted">over {q.over.map((p, i) => <span key={p}>{i ? ", " : ""}<a href={"#agents-" + p}>{p}</a></span>)} + your data</span>
          {q.name === "classify" ? <a className="btn sm" href="#semantic-play"><Icon name="tree" />Playground</a> : null}
        </div>
      ) : (
        <div className="row wrap">
          <button className="btn sm primary" onClick={() => setRes(runLocal(q.name, v))}><Icon name="bolt" />Try here</button>
          <a className="btn sm" href={liveGet(sparql)} target="_blank" rel="noopener"><Icon name="external" />Run live</a>
          <CopyBtn small label="act call" text={pretty(actQuery(sparql))} />
          <CopyBtn small label="curl" text={curlQuery(sparql)} />
        </div>
      )}
      {res ? <Result res={res} /> : null}
    </div>
  );
}

function Result({ res }) {
  if ("ask" in res) return <div className="note"><Icon name={res.ask ? "check" : "x"} /><span><b>{String(res.ask)}</b> — {res.note}</span></div>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {res.note ? <p className="small serif">{res.note}</p> : null}
      <div className="small muted">{plural(res.rows.length, "row")} from the embedded {META.release}</div>
      <div className="result">
        <table className="tbl">
          <thead><tr>{res.head.map((h) => <th key={h}>?{h}</th>)}</tr></thead>
          <tbody>{res.rows.map((r, i) => <tr key={i}>{r.map((x, j) => <td key={j}>{res.concept && (res.head[j] === "concept" || res.head[j] === "object") && byId.has(x) ? <ConceptChip id={x} /> : /^https?:\/\//.test(String(x)) && curieOf(String(x)) !== String(x) ? <code title={String(x)}>{curieOf(String(x))}</code> : String(x)}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function Directory({ route }) {
  const [q, setQ] = useState("");
  const [sys, setSys] = useStored("ag.sys", "linked");
  const all = useMemo(() => Object.entries(ACTIONS).map(([iri, a]) => ({ iri, ...a, enacts: conceptsByAction.get(iri) || [] })), []);
  const list = all.filter((a) => (sys === "linked" ? a.enacts.length : sys === "all" ? true : a.sys === sys))
    .filter((a) => !q.trim() || (a.t + " " + a.n + " " + (a.d || "")).toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b.enacts.length - a.enacts.length || (a.t || a.n).localeCompare(b.t || b.n));
  const counts = { linked: all.filter((a) => a.enacts.length).length, foxxi: all.filter((a) => a.sys === "foxxi").length, relay: all.filter((a) => a.sys === "relay").length, all: all.length };
  return (
    <section id="directory" className="stack">
      <div className="sec-h"><h2>Capability directory</h2><span className="meta">Foxxi bridge and Interego relay actions, read live from their manifests at build time</span></div>
      <div className="row wrap">
        <Seg label="Which actions" value={sys} onChange={setSys} options={[{ v: "linked", l: `Enact a term · ${counts.linked}` }, { v: "foxxi", l: `Foxxi · ${counts.foxxi}` }, { v: "relay", l: `Interego relay · ${counts.relay}` }, { v: "all", l: `All · ${counts.all}` }]} />
        <span className="spacer" />
        <input className="input" style={{ width: 240 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter actions…" />
      </div>
      <div className="actions-dir">{list.map((a) => <ActionRow key={a.iri} a={a} />)}</div>
    </section>
  );
}

function ActionRow({ a }) {
  const id = "act-" + a.sys + "." + a.n;
  const args = Object.fromEntries((a.in || []).filter((x) => x.req).map((x) => [x.n, `<${x.n}>`]));
  // relay operations are the Interego connector's own tools; bridge actions are followed with act
  const call = a.sys === "relay" ? `${a.n} ${pretty(args)}` : pretty({ descriptor_url: META.foxxiManifest, action_iri: a.iri, payload: args });
  return (
    <details className="port" id={id}>
      <summary>
        <MethodTag m={a.m} />
        <span className="pt">{a.t || a.n}</span>
        <span className="row" style={{ gap: 6 }}>{a.enacts.length ? <span className="tag post">enacts {a.enacts.length}</span> : null}<span className="tag">{systemLabel(a.sys)}</span><Icon name="down" /></span>
        <span className="pu">{a.n} · {a.u}</span>
      </summary>
      <div className="pb">
        {a.d ? <p className="small">{a.d}</p> : null}
        {a.enacts.length ? (
          <div className="stack" style={{ gap: 4 }}>
            <b className="small">Enacts</b>
            <div className="chips">{a.enacts.map((e) => <span key={e.c + e.how} className="row" style={{ gap: 4 }}><span className="tiny muted">{e.how === "role" ? "role capability of" : roleById.get(e.how).label}</span><ConceptChip id={e.c} /></span>)}</div>
          </div>
        ) : null}
        <dl className="kv">
          <dt>Action</dt><dd><code className="iri">{a.iri}</code></dd>
          <dt>Target</dt><dd><code className="iri">{a.u}</code></dd>
          {a.ro != null ? <><dt>Hints</dt><dd>{a.ro ? "read-only" : "writes"}{a.de ? " · destructive" : ""}{a.ix ? " · idempotent" : ""}{a.xr ? " · externally routed" : ""}</dd></> : null}
          {a.auth ? <><dt>Auth</dt><dd>Authorization header required</dd></> : null}
          {a.co && a.co.length ? <><dt>Applies to</dt><dd>{a.co.join(", ")}</dd></> : null}
        </dl>
        {a.in && a.in.length ? <div className="inputs">{a.in.map((x) => <div className="in" key={x.n}><code>{x.n}{x.req ? <span className="req"> *</span> : null}</code><span className="muted">{x.c || ""}</span></div>)}</div> : <div className="small muted">No input.</div>}
        <CodeBlock title={a.sys === "relay" ? "Interego tool call" : "Through Interego (act)"} code={call} />
      </div>
    </details>
  );
}

function Limits() {
  const l = META.limits;
  return (
    <section id="limits" className="stack">
      <div className="sec-h"><h2>Limits and policy</h2><span className="meta">Published by I2IDL; carried in the catalog as data and as ODRL constraints</span></div>
      <div className="stats">
        {[["Requests / minute", l.rateLimitPerMinute], ["Query length", (l.maxQueryLength || 0).toLocaleString() + " chars"], ["Result rows", (l.maxResultRows || 0).toLocaleString()], ["Timeout", (l.executionTimeoutSeconds || 0) + " s"]].map(([k, v]) => <div className="stat" key={k}><span className="l">{k}</span><span className="v" style={{ fontSize: 20 }}>{v}</span></div>)}
      </div>
      <p className="small muted">Read-only forms: {(l.supportedQueryForm || []).join(", ")}. Not allowed: {(l.disallowedFeature || []).join(", ")}. {l.comment}</p>
    </section>
  );
}

function Brief() {
  const text = `You can use the I2IDL Digital Learning Glossary (release ${META.release}, ${META.scheme.rights}) through its I2IDL-X HyprCat catalog on Interego:
${META.iri.catalog}

- Read the catalog first (resolve_linked_data with format "markdown" shows its controls). Every port carries its action IRI, target, method, media type and input shape.
- Query with act: descriptor_url = the catalog IRI, action_iri = ${PORTS.find((p) => p.id === "port-sparql-post").action}, payload = the SPARQL text as a plain string. Use the ${QUERIES.filter((q) => !q.over).length} stored queries that run against the endpoint; stay within ${META.limits.rateLimitPerMinute} requests a minute and ${META.limits.maxQueryLength} characters.
- To type data classified by I2IDL concepts in BFO 2020 (IAO, CCO), gist, DOLCE-UltraLite, gUFO, PROV-O, schema.org and peer vocabularies: follow port-vocabulary, port-alignments and port-referents, add the data, and run q-classify locally (no reasoner needed) — or load the upper ontologies' own files and use an OWL 2 RL or DL reasoner. Link with i2x:isClassifiedBy only for instance-of; use dct:subject for aboutness.
- Concept IRIs are https://id.i2idl.org/concepts/{id}; append .ttl or .jsonld to dereference one.
- I2IDL definitions are asserted; I2IDL-X enactments and crosswalks are Hypothetical until ratified. Say which is which when you cite them.
- Before relying on decorations, run q-release-check with "${META.release}".
- Writes (propose-mapping, ratify, align-course-concept, publish-classified) go through publish_context with conforms_to_shapes = ${META.shapes}; ask the person before publishing anything public.`;
  return (
    <section id="brief" className="stack">
      <div className="sec-h"><h2>Agent brief</h2><span className="meta">Paste into any agent's instructions</span></div>
      <CodeBlock title="Instructions" code={text} wrap />
    </section>
  );
}
