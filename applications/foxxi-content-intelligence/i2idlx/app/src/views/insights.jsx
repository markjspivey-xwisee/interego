// Insights: the glossary's shape and health, its release history, I2IDL-X coverage and team activity.
import { C, META, KINDS, COLLECTIONS, SOURCES, RELEASES, SUGGESTIONS, ITEMS, byId, kindById, fieldById, enactByConcept, mapsByConcept, reuseClass, RIGHTS, degree, kindPhrase } from "../data.js";
import { OriginStrip } from "../origin.jsx";
import { useCaps, consensus } from "../caps.js";
import { Icon } from "../icons.jsx";
import { ConceptChip, RightsBadge, useUI } from "../ui.jsx";
import { HBars, StackBar, Line, Columns, ChartCard } from "../charts.jsx";
import { go, plural, pct, fmtDate } from "../util.js";
import { health } from "../health.js";

const { useMemo, useEffect } = React;

export function Insights({ route }) {
  useEffect(() => {
    const id = route && route.section;
    if (!id) return;
    const t = setTimeout(() => { const el = document.getElementById("ins-" + id); if (el) el.scrollIntoView({ block: "start", behavior: "smooth" }); }, 60);
    return () => clearTimeout(t);
  }, [route && route.section]);
  const { tallies, policy, allNotes, usageByConcept, ballots, signedIn } = useCaps();
  const byKind = KINDS.map((k) => ({ label: k.label, value: C.filter((c) => c.k === k.id).length, color: `var(--k-${k.id})`, k: k.id }));
  const byField = COLLECTIONS.field.map((f) => ({ label: f.label, value: f.n, f: f.id })).sort((a, b) => b.value - a.value);
  const evBySource = SOURCES.map((s, i) => ({ label: s.label, value: C.reduce((a, c) => a + c.ev.filter((e) => e.s === i).length, 0), s, tip: <span><b>{s.title}</b><br />{s.rights}</span> }))
    .sort((a, b) => b.value - a.value);
  const reuse = ["open", "sharealike", "nc", "permission"].map((k, i) => ({
    label: RIGHTS[k].label, value: C.filter((c) => reuseClass(c) === k).length,
    color: ["var(--k-notion)", "var(--k-enactable)", "var(--k-system)", "var(--k-standard)"][i], ink: i >= 2 ? "#142029" : "#fff",
  }));
  const degreeHist = useMemo(() => {
    const m = new Map();
    for (const c of C) { const d = Math.min(9, c.r.length); m.set(d, (m.get(d) || 0) + 1); }
    return [...Array(10).keys()].map((d) => ({ label: d === 9 ? "9+" : String(d), value: m.get(d) || 0, tip: <span><b>{m.get(d) || 0}</b> concepts with {d === 9 ? "9 or more" : d} related link{d === 1 ? "" : "s"}</span> }));
  }, []);
  const coverage = KINDS.map((k) => {
    const cs = C.filter((c) => c.k === k.id);
    const n = cs.filter((c) => enactByConcept.has(c.id)).length;
    return { label: k.label, value: pct(n, cs.length), color: `var(--k-${k.id})`, tip: <span><b>{k.label}</b> · {n} of {cs.length} have capability links</span> };
  });
  const rel = RELEASES.map((r) => ({ x: r.v, y: r.n }));
  const relPairs = RELEASES.map((r) => ({ x: r.v, y: r.rel }));
  const changed = RELEASES.slice(1).map((r) => ({ label: r.v.replace("v0.0.", "."), value: r.nch, tip: <span><b>{r.v}</b> · {fmtDate(r.at)}<br />{r.nch ? Object.entries(r.ch).map(([k, n]) => kindPhrase(k, n)).join(", ") : "No change to the graph"}</span> }));
  const added = RELEASES.slice(1).map((r) => ({ label: r.v.replace("v0.0.", "."), value: r.add.length, tip: <span><b>{r.v}</b> · {fmtDate(r.at)}<br />{r.add.length ? `Added ${r.add.length}: ${r.add.slice(0, 6).map((id) => (byId.get(id) || { l: id }).l).join(", ")}${r.add.length > 6 ? "…" : ""}` : "No concepts added"}</span> }));

  // health checks
  const { isolated, noRelated, synth, single, asym, inv, altClash, adapted } = health();

  // team activity
  const team = useMemo(() => {
    const used = [...usageByConcept.entries()].map(([id, l]) => ({ id, n: l.length })).sort((a, b) => b.n - a.n).slice(0, 10);
    const talk = new Map();
    for (const n of allNotes) talk.set(n.c, (talk.get(n.c) || 0) + 1);
    const discussed = [...talk.entries()].map(([id, n]) => ({ id, n })).sort((a, b) => b.n - a.n).slice(0, 10);
    let votes = 0;
    for (const doc of ballots.values()) votes += Object.keys((doc && doc.v) || {}).length;
    const decided = ITEMS.filter((i) => ["ratified", "rejected"].includes(consensus(tallies.get(i.key), policy.quorum))).length;
    return { used, discussed, votes, decided, reviewers: ballots.size, notes: allNotes.length };
  }, [usageByConcept, allNotes, ballots, tallies, policy]);

  return (
    <div className="page stack" style={{ gap: 28 }}>
      <div className="stack" style={{ gap: 6 }}>
        <div className="eyebrow">Insights · {META.scheme.title} {META.release}</div>
        <div className="row wrap" style={{ alignItems: "flex-end", gap: 18 }}>
          <div><div className="hero-fig">{C.length}</div><div className="muted">approved concepts</div></div>
          <p className="lede" style={{ maxWidth: "52ch" }}>Built from commit <a href={`${META.repo}/commit/${META.commit}`} target="_blank" rel="noopener"><code>{META.commit.slice(0, 7)}</code></a> ({fmtDate(META.commitDate)}). Every number below is computed from that release and the I2IDL-X graphs published on Interego.</p>
        </div>
      </div>
      <OriginStrip items={[["i2idl", "I2IDL's release"], ["derived", "kinds, reuse, history, health checks"], ["proposed", "capability coverage"], ["team", "team activity"]]} />
      <div className="stats">
        {[["Evidence records", META.counts.evidence], ["Sources", META.counts.sources], ["Related pairs", META.counts.related], ["Broader pairs", META.counts.broader],
          ["Alternate labels", META.counts.altLabels], ["Source-grounded", `${META.counts.grounded} / ${C.length}`], ["Capability links", META.counts.enactments], ["Crosswalks", META.counts.mappings]]
          .map(([l, v]) => <div className="stat" key={l}><span className="l">{l}</span><span className="v">{typeof v === "number" ? v.toLocaleString() : v}</span></div>)}
      </div>

      <section className="stack">
        <div className="sec-h"><h2>Shape</h2></div>
        <div className="charts">
          <ChartCard title="Concepts by agentic kind" sub="Derived from I2IDL's 16 type collections by the I2IDL-X rules" table={{ head: ["Kind", "Concepts"], rows: byKind.map((r) => [r.label, r.value]) }}>
            <HBars rows={byKind} labelW={110} onPick={(r) => go("browse-k." + r.k)} />
          </ChartCard>
          <ChartCard title="Concepts by field" sub="Field-collection membership (a concept can sit in several)" table={{ head: ["Field", "Members"], rows: byField.map((r) => [r.label, r.value]) }}>
            <HBars rows={byField} labelW={190} onPick={(r) => go("browse-f." + r.f)} />
          </ChartCard>
          <ChartCard title="Evidence records by source" table={{ head: ["Source", "Records", "Rights"], rows: evBySource.map((r) => [r.label, r.value, r.s.rights]) }}>
            <HBars rows={evBySource} labelW={200} onPick={(r) => go("browse-s." + r.s.id)} />
          </ChartCard>
          <ChartCard title="Related links per concept" sub={`${noRelated.length} concepts have none; the median has ${median(C.map((c) => c.r.length))}`} table={{ head: ["Related links", "Concepts"], rows: degreeHist.map((r) => [r.label, r.value]) }}>
            <Columns rows={degreeHist} />
          </ChartCard>
        </div>
      </section>

      <section className="stack">
        <div className="sec-h"><h2>Reuse</h2><span className="meta">The most restrictive rights among the sources each definition rests on directly — information, not legal advice</span></div>
        <div className="chart">
          <StackBar parts={reuse} total={C.length} />
          <div className="small muted">Non-commercial: {SOURCES.filter((s) => s.rc === "nc").map((s) => s.label).join(", ")}. Permission or publisher terms: {SOURCES.filter((s) => s.rc === "permission").map((s) => s.label).join(", ")}. I2IDL-original text is {META.license.name}.</div>
          <div className="row wrap">{["nc", "permission", "sharealike"].map((k) => <a key={k} className="btn sm" href={"#browse-rc." + k}><RightsBadge rc={k} text={`Browse ${RIGHTS[k].label.toLowerCase()} (${reuse.find((r) => r.label === RIGHTS[k].label).value})`} /></a>)}</div>
        </div>
      </section>

      <section className="stack" id="ins-releases" style={{ scrollMarginTop: 12 }}>
        <div className="sec-h"><h2>Releases</h2><span className="meta">{RELEASES.length} versions from {RELEASES[0].v} to {RELEASES[RELEASES.length - 1].v}, derived from the upstream history</span></div>
        <div className="charts">
          <ChartCard title="Concepts per release" table={{ head: ["Release", "Concepts"], rows: RELEASES.map((r) => [r.v, r.n]) }}><Line points={rel} yLabel="concepts" /></ChartCard>
          <ChartCard title="Related pairs per release" sub="Editorial relationships arrived mid-series" table={{ head: ["Release", "Related pairs"], rows: RELEASES.map((r) => [r.v, r.rel]) }}><Line points={relPairs} color="var(--k-enactable)" yLabel="related pairs" /></ChartCard>
          <ChartCard title="Changes per release" sub={`${META.changes.facts.toLocaleString()} fact-level changes since ${META.changes.baseline}, from the change history graph`} table={{ head: ["Release", "Changes", "What changed"], rows: RELEASES.slice(1).map((r) => [r.v, r.nch, Object.entries(r.ch).map(([k, n]) => kindPhrase(k, n)).join("; ") || "—"]) }}><Columns rows={changed} /></ChartCard>
          <ChartCard title="Concepts added per release" table={{ head: ["Release", "Added"], rows: RELEASES.slice(1).map((r) => [r.v, r.add.length]) }}><Columns rows={added} /></ChartCard>
          <ChartCard title="Capability coverage by kind" sub="Share of each kind's concepts with at least one enactment">
            <HBars rows={coverage} max={100} suffix="%" labelW={110} />
          </ChartCard>
        </div>
        <details className="chk"><summary><Icon name="history" /><b className="grow">Release log</b><span className="small muted">{RELEASES.length} versions · <a href={META.iri.changes} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}>as PROV on Interego</a></span></summary>
          <div className="body"><div className="tablewrap"><table className="tbl"><thead><tr><th>Release</th><th>Date</th><th className="n">Concepts</th><th className="n">Related</th><th>Changes</th></tr></thead>
            <tbody>{[...RELEASES].reverse().map((r) => <tr key={r.v}><td><b>{r.v}</b>{r.diff ? <> · <a href={r.diff} target="_blank" rel="noopener">diff</a></> : null}</td><td className="nowrap">{fmtDate(r.at)}</td><td className="n">{r.n}</td><td className="n">{r.rel}</td>
              <td>{r.nch ? <div className="small">{Object.entries(r.ch).map(([k, n]) => kindPhrase(k, n)).join(" · ")}</div> : <span className="muted small">No change to the graph</span>}
                {r.add.length ? <div className="chips" style={{ marginTop: 4 }}>{r.add.map((id) => byId.has(id) ? <ConceptChip key={id} id={id} /> : <span key={id} className="chip soft">{id}</span>)}</div> : null}</td></tr>)}</tbody></table></div></div>
        </details>
      </section>

      <section className="stack">
        <div className="sec-h"><h2>Editorial health</h2><span className="meta">Checks an I2IDL editor would run before a release</span></div>
        <div className="checks">
          <Check ok={!asym.length} title={asym.length ? `${asym.length} one-way related links` : `All ${META.counts.related} related pairs are symmetric`} />
          <Check ok={!inv.length} title={inv.length ? `${inv.length} broader links without the inverse narrower` : `All ${META.counts.broader} broader links have their inverse narrower`} />
          <Check ok title="Every concept's definition matches its active definition record (checked at build)" />
          <Check title={`${plural(noRelated.length, "concept")} with no related links${isolated.length ? ` (${isolated.length} with no links at all)` : ""}`} ids={noRelated.map((c) => c.id)} />
          <Check title={`${plural(synth.length, "synthesized definition")} (no direct evidence)`} ids={synth.map((c) => c.id)} />
          <Check title={`${plural(single.length, "definition")} resting on a single evidence record`} ids={single.map((c) => c.id)} />
          <Check title={`${plural(altClash.length, "label")} shared by more than one concept`}>
            <div className="stack" style={{ gap: 6 }}>{altClash.map((x) => <div key={x.form} className="row wrap small"><code>{x.form}</code>{x.ids.map((id) => <ConceptChip key={id} id={id} />)}</div>)}</div>
          </Check>
          <Check title={`${plural(SUGGESTIONS.length, "unlinked mention")}: one entry names another it does not link`}>
            <p className="small muted">Candidates for editorial links. I2IDL's relationships stay I2IDL's call; take them to its editors.</p>
            <div className="stack" style={{ gap: 6 }}>{SUGGESTIONS.slice(0, 200).map((s) => {
              const a = byId.get(s.a), txt = s.in === "d" ? a.d : a.x;
              return <div key={s.a + s.b} className="row wrap small"><ConceptChip id={s.a} /><span className="muted">{s.in === "d" ? "definition" : "note"} names</span><ConceptChip id={s.b} />
                <span className="muted ellipsis" style={{ maxWidth: 380 }}>…{txt.slice(Math.max(0, s.at[0] - 40), s.at[1] + 30)}…</span></div>;
            })}</div>
          </Check>
          <Check title={`${plural(adapted.length, "definition")} carry an adaptation notice`} ids={adapted.map((c) => c.id)} />
        </div>
      </section>

      <section className="stack">
        <div className="sec-h"><h2>Team activity</h2><span className="meta">From this page's shared data</span></div>
        {!signedIn ? <div className="note"><Icon name="lock" /><span>Sign in to claude.ai to see and add your team's votes, notes and usage.</span></div> : (
          <>
            <div className="stats">
              {[["Reviewers", team.reviewers], ["Votes cast", team.votes], ["Items decided", team.decided], ["Notes", team.notes], ["Terms in use", usageByConcept.size]].map(([l, v]) => <div className="stat" key={l}><span className="l">{l}</span><span className="v">{v}</span></div>)}
            </div>
            <div className="charts">
              <ChartCard title="Most used terms" sub="Collaborators who marked a term as in use">
                {team.used.length ? <HBars rows={team.used.map((u) => ({ label: byId.get(u.id).l, value: u.n, color: `var(--k-${byId.get(u.id).k})`, id: u.id }))} labelW={200} onPick={(r) => go("c-" + r.id)} /> : <div className="small muted">Nobody has marked a term yet. Use “I use this” on any entry.</div>}
              </ChartCard>
              <ChartCard title="Most discussed terms" sub="Notes per term">
                {team.discussed.length ? <HBars rows={team.discussed.map((u) => ({ label: byId.get(u.id).l, value: u.n, color: `var(--k-${byId.get(u.id).k})`, id: u.id }))} labelW={200} onPick={(r) => go("c-" + r.id)} /> : <div className="small muted">No notes yet.</div>}
              </ChartCard>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

function Check({ ok, title, ids, children }) {
  const body = ids ? <div className="chips">{ids.map((id) => <ConceptChip key={id} id={id} />)}</div> : children;
  if (ok) return <div className="chk"><div className="row" style={{ padding: "10px 12px" }}><span className="st ok"><Icon name="check" />Pass</span><span className="grow">{title}</span></div></div>;
  return (
    <details className="chk">
      <summary><span className="st look"><Icon name="eye" />Look</span><span className="grow">{title}</span><Icon name="down" /></summary>
      <div className="body">{body}</div>
    </details>
  );
}
