// Review governance: votes under Interego's ratification algebra (Asserted = for, Counterfactual = against,
// Hypothetical = abstain), the workbench's consensus policy, and exports that close the loop on Interego.
import { META, ITEMS, itemByKey, byId, ACTIONS, roleById, PORTS } from "./data.js";
import { useCaps, useProfiles, consensus, CONSENSUS_LABEL } from "./caps.js";
import { Icon } from "./icons.jsx";
import { Avatar, useUI } from "./ui.jsx";
import { cx, ago, ttlStr } from "./util.js";

const { useState } = React;

export const VOTE = {
  for: { label: "For", modal: "Asserted", iep: "iep:Asserted", icon: "check" },
  against: { label: "Against", modal: "Counterfactual", iep: "iep:Counterfactual", icon: "x" },
  abstain: { label: "Abstain", modal: "Hypothetical", iep: "iep:Hypothetical", icon: "minus" },
};

export function ConsensusChip({ itemKey }) {
  const { tallies, policy } = useCaps();
  const t = tallies.get(itemKey);
  const s = consensus(t, policy.quorum);
  const cls = s === "ratified" ? "asserted" : s === "rejected" ? "counterfactual" : "hypothetical";
  const title = s === "proposed" ? "Published Hypothetical; nobody here has voted yet."
    : `${t.for.length} for · ${t.against.length} against · ${t.abstain.length} abstain (quorum ${policy.quorum})`;
  return <span className={"chip " + cls} title={title}>{CONSENSUS_LABEL[s]}</span>;
}

export function VoteBar({ itemKey, compact }) {
  const { tallies, myBallot, vote, writable, signedIn, resolved } = useCaps();
  const { toast } = useUI();
  const t = tallies.get(itemKey);
  const mine = myBallot.v[itemKey];
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState(mine ? mine.note || "" : "");
  const why = !resolved ? "Loading…" : !signedIn ? "Sign in to claude.ai to vote." : !writable ? "Your access to this page is view-only; ask the owner for Contributor access to vote." : "";
  const cast = async (choice) => {
    const next = mine && mine.vote === choice ? null : choice;
    try {
      await vote(itemKey, next, next ? note : "");
      if (next) toast(`Voted ${VOTE[next].label.toLowerCase()} (${VOTE[next].modal})`, { icon: VOTE[next].icon });
    } catch (e) {
      toast(e && e.code === "read_only" ? why : "That vote didn't save. Try again in a moment.", { icon: "warn" });
    }
  };
  const saveNote = async () => {
    if (!mine) return setNoteOpen(false);
    try { await vote(itemKey, mine.vote, note); setNoteOpen(false); toast("Note saved with your vote", { icon: "check" }); }
    catch { toast("That note didn't save. Try again in a moment.", { icon: "warn" }); }
  };
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="votebar" title={why || undefined}>
        {Object.entries(VOTE).map(([k, v]) => (
          <button key={k} type="button" className={"vb " + k} aria-pressed={!!mine && mine.vote === k} disabled={!writable}
            onClick={() => cast(k)} title={`${v.label}: publishes as ${v.modal}`}>
            <Icon name={v.icon} size={13} />{v.label}<span className="num" style={{ opacity: .75 }}>{t[k].length || ""}</span>
          </button>
        ))}
        <ConsensusChip itemKey={itemKey} />
        {mine && writable ? <button type="button" className="btn ghost sm" onClick={() => setNoteOpen((o) => !o)}><Icon name="edit" />{mine.note ? "Edit note" : "Add a reason"}</button> : null}
      </div>
      {noteOpen ? (
        <div className="row" style={{ alignItems: "stretch" }}>
          <input className="input sm" value={note} maxLength={600} onChange={(e) => setNote(e.target.value)} placeholder="Why? (shared with the team)"
            onKeyDown={(e) => { if (e.key === "Enter") saveNote(); }} autoFocus />
          <button className="btn sm primary" onClick={saveNote}>Save</button>
        </div>
      ) : null}
      {!writable && resolved ? <div className="tiny muted">{why}</div> : null}
    </div>
  );
}

export function Voters({ itemKey }) {
  const { tallies } = useCaps();
  const t = tallies.get(itemKey);
  const ids = [...t.for, ...t.against, ...t.abstain];
  const ps = useProfiles(ids);
  if (!ids.length) return null;
  const noteOf = new Map(t.notes.map((n) => [n.u, n]));
  return (
    <div className="voters">
      {["for", "against", "abstain"].flatMap((k) => t[k].map((u) => {
        const p = ps[u] || {};
        const n = noteOf.get(u);
        return (
          <span className="voter" key={k + u} title={n ? n.note : undefined}>
            <Avatar p={p} size={20} /><span>{p.name || "Someone"}</span><span className="vv">{VOTE[k].label.toLowerCase()}</span>
            {n ? <span className="muted">“{n.note.length > 60 ? n.note.slice(0, 60) + "…" : n.note}”</span> : null}
          </span>
        );
      }))}
    </div>
  );
}

// ── Exports ──────────────────────────────────────────────────────────────────────────────────────
const PREFIXES = () => `@prefix i2x:  <${META.ns}> .
@prefix mp:   <${META.iri.mappings}#> .
@prefix en:   <${META.iri.enactments}#> .
@prefix iep:  <https://markjspivey-xwisee.github.io/interego/ns/iep#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix dct:  <http://purl.org/dc/terms/> .
@prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
`;
const qn = (item) => (item.type === "mapping" ? "mp:" : "en:") + item.rec.id;
const iso = (ts) => new Date(ts || Date.now()).toISOString().replace(/\.\d{3}Z$/, "Z");
const safeIri = (s) => /^[a-z][a-z0-9+.-]*:[^\s<>"{}|\\^`]+$/i.test(s || "") ? s : null;

/** One reviewer's votes, each as the i2x:RatificationVote cat:port-ratify publishes. */
export function myVotes(myBallot, reviewerIri) {
  const who = safeIri(reviewerIri) || "urn:interpretant:reviewer:me";
  return Object.entries(myBallot.v || {}).filter(([k]) => itemByKey.has(k)).map(([k, v]) => {
    const item = itemByKey.get(k);
    const id = `urn:interpretant:vote:${item.rec.id}:${v.at || 0}`;
    const ttl = `${PREFIXES()}
<${id}> a i2x:RatificationVote ;
    i2x:votesOn ${qn(item)} ;
    i2x:vote ${VOTE[v.vote].iep} ;
    prov:wasAttributedTo <${who}> ;
    prov:generatedAtTime "${iso(v.at)}"^^xsd:dateTime${v.note ? ` ;\n    rdfs:comment ${ttlStr(v.note)}@en` : ""} .
`;
    return {
      item, vote: v.vote, ttl,
      call: { graph_iri: id.replace("urn:interpretant:vote:", "urn:graph:interpretant:vote:"), graph_content: ttl, modal_status: VOTE[v.vote].modal,
        conforms_to_shapes: [META.shapes] },
    };
  });
}

/** The team's ledger: every vote (reviewers numbered, never named) plus the outcomes under the policy. */
export function ledgerTurtle(ballots, tallies, policy) {
  const reviewers = [...ballots.keys()].sort();
  const num = new Map(reviewers.map((u, i) => [u, i + 1]));
  const now = iso();
  let out = `# Interpretant review ledger — ${now}
# Workbench policy: an item is ratified when at least ${policy.quorum} reviewer(s) vote for and "for" outnumbers "against";
# rejected when at least ${policy.quorum} vote against and "against" outnumbers "for". Reviewers are numbered, not named.
# Votes compose under Interego's ratification algebra: iep:Asserted = for, iep:Counterfactual = against, iep:Hypothetical = abstain.
${PREFIXES()}
<urn:interpretant:ledger:${now}> a prov:Collection ;
    dct:title "Interpretant review ledger"@en ;
    dct:source <${META.iri.mappings}> , <${META.iri.enactments}> ;
    prov:generatedAtTime "${now}"^^xsd:dateTime .
`;
  const votes = [];
  for (const [u, doc] of ballots) {
    for (const [k, v] of Object.entries((doc && doc.v) || {})) {
      const item = itemByKey.get(k);
      if (!item || !VOTE[v.vote]) continue;
      votes.push({ item, u, v });
    }
  }
  votes.sort((a, b) => a.item.key.localeCompare(b.item.key) || num.get(a.u) - num.get(b.u));
  if (votes.length) out += "\n# ── Votes ──\n";
  for (const { item, u, v } of votes) {
    out += `<urn:interpretant:vote:${item.rec.id}:r${num.get(u)}> a i2x:RatificationVote ;
    i2x:votesOn ${qn(item)} ;
    i2x:vote ${VOTE[v.vote].iep} ;
    prov:wasAttributedTo <urn:interpretant:reviewer:${num.get(u)}> ;
    prov:generatedAtTime "${iso(v.at)}"^^xsd:dateTime${v.note ? ` ;\n    rdfs:comment ${ttlStr(v.note)}@en` : ""} .
`;
  }
  const decided = ITEMS.map((i) => [i, consensus(tallies.get(i.key), policy.quorum)]).filter(([, s]) => s === "ratified" || s === "rejected");
  if (decided.length) {
    out += "\n# ── Outcomes (apply to the published records, then republish; the rules materialize ratified triples) ──\n";
    for (const [i, s] of decided) out += `${qn(i)} i2x:reviewStatus i2x:status-${s} .\n`;
  }
  return { ttl: out, votes: votes.length, decided: decided.length, reviewers: reviewers.length };
}

/** RFC 6570 expansion of the catalog's upstream-review control: a prefilled issue a human submits. */
export function upstreamIssue(item, tally) {
  const port = PORTS.find((p) => p.id === "port-upstream-review");
  const c = byId.get(item.c);
  let title, body;
  if (item.type === "mapping") {
    const m = item.rec;
    title = `Mapping candidate: ${c.l} skos:${m.p} ${m.ol || m.o}`;
    body = `A crosswalk candidate for editorial consideration (proposed in I2IDL-X, ratified by its reviewers).\n\n` +
      `- I2IDL concept: ${c.l} — https://id.i2idl.org/concepts/${c.id}\n- Proposed: skos:${m.p}\n- Target: ${m.o}${m.ol ? ` (${m.ol}, ${m.v})` : ""}\n` +
      `- Rationale: ${m.w}\n- Method: ${m.m}; confidence ${m.cf.toFixed(2)}\n- Votes: ${tally.for.length} for, ${tally.against.length} against, ${tally.abstain.length} abstain\n` +
      `- Record: ${item.iri}\n\nI2IDL publishes mappings by editorial judgement; this is a candidate, not an assertion.`;
  } else {
    const e = item.rec;
    const a = ACTIONS[e.a];
    title = `Capability link candidate: ${c.l} ${roleById.get(e.r).by} ${a ? a.t : e.a}`;
    body = `- I2IDL concept: ${c.l} — https://id.i2idl.org/concepts/${c.id}\n- Link: ${roleById.get(e.r).by} ${e.a}\n- Rationale: ${e.w}\n` +
      `- Votes: ${tally.for.length} for, ${tally.against.length} against\n- Record: ${item.iri}`;
  }
  return port.tpl.replace("{?title,body}", "?title=" + encodeURIComponent(title) + "&body=" + encodeURIComponent(body));
}

export function GovernanceLoop() {
  return (
    <ol className="loop">
      <li><b>Drafted.</b> AI-drafted crosswalks and capability links are published on Interego as <i>Hypothetical</i>.</li>
      <li><b>Reviewed here.</b> For = <code>iep:Asserted</code>, against = <code>iep:Counterfactual</code>, abstain = <code>iep:Hypothetical</code>.</li>
      <li><b>Decided by policy.</b> Quorum and a majority settle each item for this team.</li>
      <li><b>Published.</b> Export the votes for <code>port-ratify</code> and the ledger of outcomes.</li>
      <li><b>Materialized.</b> Republished records with <code>status-ratified</code> fire the SHACL rules that assert the mapping triples.</li>
      <li><b>Upstream.</b> Ratified crosswalks can go to I2IDL's editors as a prefilled issue a person submits.</li>
    </ol>
  );
}
