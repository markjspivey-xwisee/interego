// Review: the shared queue that closes the ratification loop for I2IDL-X crosswalks and capability links.
import { ITEMS as ALL_ITEMS, META, byId, ACTIONS, roleById, methodById, systemLabel, itemByKey as ITEM_BY_KEY, METHODS } from "../data.js";
import { OriginStrip } from "../origin.jsx";
import { useCaps, consensus, CONSENSUS_LABEL } from "../caps.js";
import { Icon } from "../icons.jsx";
import { ConceptChip, Meter, MethodTag, CodeBlock, Modal, Seg, useUI } from "../ui.jsx";
import { VoteBar, Voters, GovernanceLoop, myVotes, ledgerTurtle, upstreamIssue, VOTE } from "../governance.jsx";
import { search } from "../search.js";
import { cx, go, isTyping, useStored, plural, pct, useDrive } from "../util.js";
import { pretty } from "../lib.js";

const { useState, useMemo, useEffect, useRef } = React;

export function Review({ route }) {
  const caps = useCaps();
  const drive = useDrive();
  const { tallies, policy, myBallot, writable, canEdit, savePolicy, signedIn, resolved } = caps;
  const ITEMS = caps.items || ALL_ITEMS;
  const itemByKey = caps.itemByKey || ITEM_BY_KEY;
  const { toast } = useUI();
  const [type, setType] = useStored("rv.type", "all");
  const [status, setStatus] = useStored("rv.status", "open");
  const [mineOnly, setMineOnly] = useStored("rv.mine", false);
  const [sort, setSort] = useStored("rv.sort", "conf");
  const [method, setMethod] = useStored("rv.method", "all");
  // #review-method.evidence-cited opens the queue on one drafting method (e.g. the UNESCO proposals)
  useEffect(() => {
    if (route.key && route.key.startsWith("method.")) { setMethod(route.key.slice(7)); setType("all"); setStatus("all"); }
  }, [route.key]);
  const [q, setQ] = useState("");
  const [focus, setFocus] = useState(route.key && !route.key.startsWith("method.") ? route.key : null);
  const [exp, setExp] = useState(null);
  const listRef = useRef(null);
  // #review-<key> focuses that item and brings it into view
  useEffect(() => {
    if (!route.key || route.key.startsWith("method.")) return;
    setFocus(route.key);
    const t = setTimeout(() => {
      const el = listRef.current && listRef.current.querySelector(`[data-key="${CSS.escape(route.key)}"]`);
      if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 60);
    return () => clearTimeout(t);
  }, [route.key]);

  const rows = useMemo(() => {
    const qIds = q.trim() ? new Set(search(q, 400).map((r) => r.c.id)) : null;
    let out = ITEMS.map((i) => ({ i, s: consensus(tallies.get(i.key), policy.quorum) }));
    if (type !== "all") out = out.filter((r) => r.i.type === type);
    if (method !== "all") out = out.filter((r) => r.i.rec.m === method);
    if (status === "open") out = out.filter((r) => r.i.sandbox || r.s === "proposed" || r.s === "in-review" || r.s === "contested");
    else if (status !== "all") out = out.filter((r) => r.i.sandbox || r.s === status);
    if (mineOnly) out = out.filter((r) => !myBallot.v[r.i.key]);
    if (qIds) out = out.filter((r) => qIds.has(r.i.c) || (r.i.type === "mapping" ? (r.i.rec.ol || r.i.rec.o) : (ACTIONS[r.i.rec.a] || {}).t || "").toLowerCase().includes(q.trim().toLowerCase()));
    out.sort((a, b) => (b.i.sandbox ? 1 : 0) - (a.i.sandbox ? 1 : 0) || (sort === "conf" ? b.i.rec.cf - a.i.rec.cf || a.i.key.localeCompare(b.i.key)
      : sort === "low" ? a.i.rec.cf - b.i.rec.cf || a.i.key.localeCompare(b.i.key)
      : byId.get(a.i.c).l.localeCompare(byId.get(b.i.c).l)));
    return out;
  }, [type, status, mineOnly, sort, q, tallies, policy, myBallot, method, ITEMS]);

  const stats = useMemo(() => {
    const s = { proposed: 0, "in-review": 0, contested: 0, ratified: 0, rejected: 0 };
    for (const i of ITEMS) s[consensus(tallies.get(i.key), policy.quorum)]++;
    return s;
  }, [tallies, policy, ITEMS]);
  const mine = Object.keys(myBallot.v).filter((k) => itemByKey.has(k)).length;

  // keyboard review: j/k move, f/a/x vote on the focused card (not when embedded beside an orchestrated run)
  useEffect(() => {
    if (drive && drive.embedded) return undefined;
    const keys = rows.map((r) => r.i.key);
    const h = async (e) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const at = Math.max(0, keys.indexOf(focus));
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        const n = keys[e.key === "j" ? Math.min(keys.length - 1, focus ? at + 1 : 0) : Math.max(0, at - 1)];
        setFocus(n);
        const el = listRef.current && listRef.current.querySelector(`[data-key="${n}"]`);
        if (el) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
      const choice = { f: "for", a: "against", x: "abstain" }[e.key];
      if (choice && focus && writable) {
        e.preventDefault();
        const cur = myBallot.v[focus];
        try { await caps.vote(focus, cur && cur.vote === choice ? null : choice, cur ? cur.note : ""); toast(`${VOTE[choice].label} — ${byId.get(itemByKey.get(focus).c).l}`, { icon: VOTE[choice].icon }); }
        catch { toast("That vote didn't save.", { icon: "warn" }); }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [rows, focus, writable, myBallot, drive]);

  return (
    <div className="page">
      <div className="rv">
        <aside className="rv-side rv-head">
          <div className="stack" style={{ gap: 6 }}>
            <div className="eyebrow">Review</div>
            <h1 className="h-display" style={{ fontSize: 26, lineHeight: 1.1 }}>Ratify the layer</h1>
            <p className="small muted">{ALL_ITEMS.length} I2IDL-X records published as Hypothetical: {ALL_ITEMS.filter((i) => i.type === "mapping").length} crosswalks ({META.counts.unesco} to UNESCO Thesaurus terms I2IDL's own evidence cites) and {ALL_ITEMS.filter((i) => i.type === "enactment").length} capability links. None of them is part of I2IDL's record.{ITEMS.length > ALL_ITEMS.length ? ` Plus ${ITEMS.length - ALL_ITEMS.length} proposed in this run, in the sandbox.` : ""}</p>
          </div>
          <div className="card pad stack" style={{ gap: 8 }}>
            <div className="progress" aria-label="Consensus">
              <span style={{ width: pct(stats.ratified, ITEMS.length) + "%", background: "var(--ink)" }} title={`${stats.ratified} ratified`} />
              <span style={{ width: pct(stats.rejected, ITEMS.length) + "%", background: "var(--faint)" }} title={`${stats.rejected} rejected`} />
              <span style={{ width: pct(stats["in-review"] + stats.contested, ITEMS.length) + "%", background: "var(--accent)" }} title="In review" />
            </div>
            <dl className="kv">
              <dt>Ratified here</dt><dd><b>{stats.ratified}</b></dd>
              <dt>Rejected here</dt><dd><b>{stats.rejected}</b></dd>
              <dt>In review</dt><dd>{stats["in-review"]}{stats.contested ? ` · ${stats.contested} contested` : ""}</dd>
              <dt>No votes yet</dt><dd>{stats.proposed}</dd>
              <dt>Your votes</dt><dd>{mine}</dd>
            </dl>
          </div>
        </aside>
        <aside className="rv-side rv-extra">
          <div className="card pad stack" style={{ gap: 8 }}>
            <b className="small">Policy</b>
            <p className="small muted">Ratified when at least <b>{policy.quorum}</b> reviewer{policy.quorum > 1 ? "s" : ""} vote for and “for” outnumbers “against”; rejected the other way round.</p>
            {canEdit ? (
              <label className="row small"><span className="grow">Quorum (editors)</span>
                <select className="select" style={{ width: 70, height: 28 }} value={policy.quorum} onChange={(e) => savePolicy({ quorum: Number(e.target.value) }).then(() => toast("Policy saved", { icon: "check" })).catch(() => toast("Only editors can change the policy", { icon: "warn" }))}>
                  {[1, 2, 3, 4, 5, 7, 9].map((n) => <option key={n} value={n}>{n}</option>)}
                </select></label>
            ) : null}
          </div>
          <div className="card pad stack" style={{ gap: 8 }}>
            <b className="small">Publish the outcome</b>
            <button className="btn sm" onClick={() => setExp("mine")} disabled={!mine}><Icon name="upload" />My votes → Interego</button>
            <button className="btn sm" onClick={() => setExp("ledger")}><Icon name="download" />Team ledger (Turtle)</button>
          </div>
          <details className="card pad"><summary className="small" style={{ cursor: "pointer", fontWeight: 700 }}>How the loop closes</summary><div style={{ marginTop: 10 }}><GovernanceLoop /></div></details>
          {resolved && !writable ? <div className="note"><Icon name="lock" /><span className="small">{!signedIn ? "Sign in to claude.ai to vote. You can read the queue and the team's votes." : "You have view-only access. Ask the owner for Contributor access to vote."}</span></div> : null}
          <div className="tiny muted">Keys: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>f</kbd> for · <kbd>a</kbd> against · <kbd>x</kbd> abstain</div>
        </aside>
        <div className="stack rv-list" style={{ gap: 12, minWidth: 0 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <Seg label="Type" value={type} onChange={setType} options={[{ v: "all", l: "All" }, { v: "mapping", l: "Crosswalks" }, { v: "enactment", l: "Capability links" }]} />
            <select className="select" style={{ width: "auto", height: 34 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
              <option value="open">Open</option><option value="proposed">Needs votes</option><option value="in-review">In review</option>
              <option value="contested">Contested</option><option value="ratified">Ratified here</option><option value="rejected">Rejected here</option><option value="all">All</option>
            </select>
            <select className="select" style={{ width: "auto", height: 34 }} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
              <option value="conf">Most confident first</option><option value="low">Least confident first</option><option value="az">By term</option>
            </select>
            <select className="select" style={{ width: "auto", height: 34 }} value={method} onChange={(e) => setMethod(e.target.value)} aria-label="Method">
              <option value="all">Any method</option>{METHODS.filter((m) => ITEMS.some((i) => i.rec.m === m.id)).map((m) => <option key={m.id} value={m.id}>{m.label} ({ITEMS.filter((i) => i.rec.m === m.id).length})</option>)}
            </select>
            <label className="check small"><input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />Not voted by me</label>
            <span className="spacer" />
            <input className="input" style={{ width: 220 }} placeholder="Filter by term or target…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <OriginStrip items={[["proposed", "I2IDL-X proposals"], ["team", "your team's votes"], ["interego", "ratification algebra"]]} />
          <div className="small muted">{plural(rows.length, "item")}</div>
          <div className="stack" ref={listRef} style={{ gap: 10 }}>
            {rows.map(({ i, s }) => <ReviewCard key={i.key} item={i} s={s} focused={focus === i.key} onFocus={() => setFocus(i.key)} />)}
            {!rows.length ? <div className="empty"><Icon name="check" /><div><b>Nothing here.</b></div><div className="small">Change the filters to see other items.</div></div> : null}
          </div>
        </div>
      </div>
      {exp === "mine" ? <MyVotesModal onClose={() => setExp(null)} /> : null}
      {exp === "ledger" ? <LedgerModal onClose={() => setExp(null)} /> : null}
    </div>
  );
}

function ReviewCard({ item, s, focused, onFocus }) {
  const { tallies } = useCaps();
  const agent = item.sandbox ? <span className="tag sbx" title="Proposed in this orchestrated run (sandbox)">this run</span> : null;
  const c = byId.get(item.c);
  const r = item.rec;
  const a = item.type === "enactment" ? ACTIONS[r.a] : null;
  return (
    <article className={cx("rcard", s === "ratified" && "ratified", s === "rejected" && "rejected", focused && "focus")} data-key={item.key} onClick={onFocus}>
      <div className="row wrap small">
        {agent}<span className="tag">{item.type === "mapping" ? "Crosswalk · " + r.v : "Capability · " + systemLabel(a && a.sys)}</span>
        <span className="muted">{methodById.get(r.m).label}</span>
        {r.ci ? <span className="cited" title={"I2IDL's definition cites this target as direct evidence: " + r.ci}><Icon name="check" size={11} />cited by I2IDL</span> : null}
        <span className="row" style={{ gap: 6 }} title="Drafting confidence"><Meter v={r.cf} /><span className="num">{r.cf.toFixed(2)}</span></span>
        <span className="spacer" />
        {item.sandbox ? <code className="tiny muted" title="Proposed in this run; it gets its IRI when the staged call is published">mp:{r.id}</code>
          : <a className="tiny muted" href={item.iri} target="_blank" rel="noopener" title={item.iri}><code>{item.type === "mapping" ? "mp:" : "en:"}{r.id}</code></a>}
      </div>
      <div className="rpair">
        <div className="rside">
          <div className="rs-h">I2IDL · published</div>
          <div className="rs-t"><ConceptChip id={c.id} /></div>
          <div className="rs-d">{c.d.length > 220 ? c.d.slice(0, 220).replace(/\s+\S*$/, "") + "…" : c.d}</div>
        </div>
        <div className="rpred">
          {item.type === "mapping" ? <><code>skos:{r.p}</code><span className="tiny muted">proposed</span></> : <><code>{roleById.get(r.r).by}</code><span className="tiny muted">{roleById.get(r.r).def}</span></>}
          <Icon name="arrowRight" />
        </div>
        <div className="rside">
          <div className="rs-h">{item.type === "mapping" ? r.v : systemLabel(a && a.sys)}</div>
          {item.type === "mapping" ? (
            <>
              <div className="rs-t"><a href={r.pg || r.o} target="_blank" rel="noopener" title={r.o}>{r.ol || r.o.split(/[#/]/).pop()}</a></div>
              <div className="rs-d">{r.od ? <>{r.on ? <span className="tiny muted">{r.on}: </span> : null}{r.od.length > 220 ? r.od.slice(0, 220) + "…" : r.od}</> : <span className="muted small">{item.sandbox ? "I2IDL-X's pinned term index confirms the term and its label." : r.v === "UNESCO Thesaurus" ? "UNESCO publishes no scope note for this term." : "Its vocabulary publishes no definition."}</span>}</div>
              {r.oa && r.oa.length ? <div className="tiny muted">Also: {r.oa.slice(0, 5).join(", ")}</div> : null}
            </>
          ) : (
            <>
              <div className="rs-t"><a href={"#agents-act." + a.sys + "." + a.n}>{a.t || a.n}</a></div>
              <div className="row small" style={{ gap: 6 }}><MethodTag m={a.m} /><code className="tiny ellipsis">{a.u.replace(/^https:\/\//, "")}</code></div>
              <div className="rs-d ui">{a.d ? (a.d.length > 200 ? a.d.slice(0, 200).replace(/\s+\S*$/, "") + "…" : a.d) : null}</div>
            </>
          )}
        </div>
      </div>
      <div className="small"><span className="muted">Rationale: </span>{r.w}</div>
      <VoteBar itemKey={item.key} />
      <Voters itemKey={item.key} />
      {s === "ratified" && item.type === "mapping" ? <div><a className="btn sm" href={upstreamIssue(item, tallies.get(item.key))} target="_blank" rel="noopener"><Icon name="flag" />Suggest to I2IDL editors</a></div> : null}
    </article>
  );
}

function MyVotesModal({ onClose }) {
  const { myBallot, save, downloads } = useCaps();
  const { toast } = useUI();
  const [who, setWho] = useStored("rv.reviewerIri", "");
  const votes = myVotes(myBallot, who.trim());
  const calls = votes.map((v) => v.call);
  const ttl = votes.map((v) => v.ttl).join("\n");
  const dl = async (name, data) => {
    try { await save(name, data); toast("Saved " + name, { icon: "download" }); }
    catch (e) { if (e && e.code !== "declined") toast("Saving isn't available here — use Copy instead.", { icon: "warn" }); }
  };
  return (
    <Modal title={`Publish your ${plural(votes.length, "vote")} to Interego`} onClose={onClose} wide>
      <div className="stack">
        <p className="small muted">Each vote is one <code>i2x:RatificationVote</code>, published through the catalog's <code>port-ratify</code> with <code>publish_context</code>. The modal status mirrors the vote, and the relay validates every record against the I2IDL-X shapes before it writes. Give your agent the calls below.</p>
        <label className="field"><span>Your agent or WebID IRI (prov:wasAttributedTo)</span>
          <input className="input" value={who} onChange={(e) => setWho(e.target.value)} placeholder="did:web:… or https://…/profile#me (kept in this browser)" /></label>
        <CodeBlock title={`publish_context calls (${calls.length})`} code={pretty(calls)} actions={downloads ? <button className="btn sm" onClick={() => dl("ratification-calls.json", pretty(calls))}><Icon name="download" />Save</button> : null} />
        <CodeBlock title="The votes (Turtle)" code={ttl} actions={downloads ? <button className="btn sm" onClick={() => dl("ratification-votes.ttl.txt", ttl)}><Icon name="download" />Save</button> : null} />
      </div>
    </Modal>
  );
}

function LedgerModal({ onClose }) {
  const { ballots, tallies, policy, save, downloads } = useCaps();
  const { toast } = useUI();
  const l = ledgerTurtle(ballots, tallies, policy);
  const dl = async () => {
    try { await save("i2idlx-review-ledger.ttl.txt", l.ttl); toast("Ledger saved", { icon: "download" }); }
    catch (e) { if (e && e.code !== "declined") toast("Saving isn't available here — use Copy instead.", { icon: "warn" }); }
  };
  return (
    <Modal title="Team review ledger" onClose={onClose} wide>
      <div className="stack">
        <p className="small muted">{plural(l.votes, "vote")} from {plural(l.reviewers, "reviewer")}, {plural(l.decided, "decided item")} under the current policy. Reviewers are numbered, never named. The outcome lines set <code>i2x:reviewStatus</code> on the published records; republish the enactments and mappings graphs with them and the I2IDL-X rules materialize the ratified triples.</p>
        <CodeBlock title="i2idlx-review-ledger.ttl" code={l.ttl} actions={downloads ? <button className="btn sm" onClick={dl}><Icon name="download" />Save</button> : null} />
      </div>
    </Modal>
  );
}
