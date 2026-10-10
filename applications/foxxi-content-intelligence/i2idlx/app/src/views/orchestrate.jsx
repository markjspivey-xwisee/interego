// Orchestrate: a team of Claude agents onboards a (fictional) organization's learning inventory into
// I2IDL-X's semantic layer. Left: the team, the plan as swimlanes, and the transcript of messages, handoffs
// and tool calls. Right: the workbench itself, driven by those calls. Watch a recorded run, or run the
// team live on your own Claude account; either way everything happens in a sandbox in this page.
import { META, PORTS, RUN } from "../data.js";
import { Icon } from "../icons.jsx";
import { Avatar, CodeBlock, CopyBtn, Modal, Seg, useUI } from "../ui.jsx";
import { MiniMarkdown } from "../text.jsx";
import { useCaps } from "../caps.js";
import { pretty } from "../lib.js";
import { cx, useStored, useMedia, plural } from "../util.js";
import { useOrchestra } from "../orc/engine.js";
import { WorkbenchPane } from "../orc/pane.jsx";
import { ContextGraph } from "../orc/graph.jsx";
import { provTurtle } from "../orc/prov.js";
import { ORG, RECORDS, AGENTS, STEPS, STEP_COL, N_COLS, STEP_SHORT, stepById, agentById } from "../orc/scenario.js";

const { useState, useRef, useEffect, useMemo } = React;
const STATUS_LABEL = { running: "working", done: "done", skipped: "not needed", pending: "waiting" };

export function Orchestrate() {
  const orc = useOrchestra(RUN);
  const [tab, setTab] = useStored("orc.tab", "log");
  const narrow = useMedia("(max-width: 1023px)");
  const [half, setHalf] = useState("agents");
  const [liveOpen, setLiveOpen] = useState(false);
  const gate = orc.world.gate && orc.world.gate.status === "pending";
  useEffect(() => { if (gate && narrow) setHalf("agents"); }, [gate, narrow]);
  const announce = useMemo(() => {
    const s = [...orc.log].reverse().find((x) => x.type === "step");
    if (!s) return "";
    const st = stepById.get(s.step);
    return `${agentById.get(st.agent).name}: ${st.title} — ${STATUS_LABEL[s.status] || s.status}`;
  }, [orc.log]);
  return (
    <div className="orc">
      <Header orc={orc} onLive={() => setLiveOpen(true)} />
      {narrow ? (
        <div className="orc-halves"><Seg label="Show" value={half} onChange={setHalf} options={[{ v: "agents", l: "Agents", icon: "users" }, { v: "workbench", l: "Workbench", icon: "monitor" }]} /></div>
      ) : null}
      <div className={cx("orc-split", narrow && "narrow", "show-" + half)}>
        <section className="orc-left" aria-label="The agents">
          <Lanes orc={orc} />
          <div className="orc-tabs">
            <Seg label="Panel" value={tab} onChange={setTab} options={[
              { v: "log", l: "Transcript" }, { v: "graph", l: "Context graph" },
              { v: "calls", l: orc.world.staged.length ? `Staged calls · ${orc.world.staged.length}` : "Staged calls" }, { v: "prov", l: "Provenance" }]} />
          </div>
          <div className="orc-body">
            {tab === "graph" ? <ContextGraph world={orc.world} version={orc.version} onShow={(h) => { orc.presenter.show(h); if (narrow) setHalf("workbench"); }} />
              : tab === "calls" ? <Staged orc={orc} />
                : tab === "prov" ? <Provenance orc={orc} />
                  : <Transcript orc={orc} onLive={() => setLiveOpen(true)} onTab={setTab} />}
          </div>
        </section>
        <section className="orc-right" aria-label="The workbench, driven by the agents"><WorkbenchPane orc={orc} /></section>
      </div>
      <div className="sr" aria-live="polite">{announce}</div>
      {liveOpen ? <LiveModal orc={orc} onClose={() => setLiveOpen(false)} /> : null}
    </div>
  );
}

function Header({ orc, onLive }) {
  const { state } = orc;
  const active = state === "running" || state === "paused" || state === "gate";
  const idle = !active;
  return (
    <header className="orc-head">
      <div className="orc-title">
        <div className="eyebrow">Orchestrate · eight Claude agents, one workbench</div>
        <h1 className="h-display">{ORG.name} joins the semantic layer <span className="tag" title={ORG.note}>fictional</span></h1>
      </div>
      <div className="orc-ctl">
        {idle ? (
          <button className="btn primary" onClick={() => orc.start("recorded")} disabled={!orc.trace}>
            <Icon name="play" filled />{state === "done" && orc.mode === "recorded" ? "Watch again" : "Watch the recorded run"}
          </button>
        ) : null}
        {idle ? <button className="btn" onClick={onLive}><Icon name="sparkle" />Run it live</button> : null}
        {state === "running" && orc.mode === "recorded" ? <button className="btn" onClick={orc.pause}><Icon name="pause" />Pause</button> : null}
        {state === "paused" ? <button className="btn primary" onClick={orc.resume}><Icon name="play" filled />Resume</button> : null}
        {state === "paused" ? <button className="btn" onClick={orc.next} title="Play the next message or tool call, then pause"><Icon name="next" filled />Step</button> : null}
        {active ? <button className="btn ghost" onClick={orc.stop}><Icon name="stop" />Stop</button> : null}
        <Seg label="Speed" value={orc.speed} onChange={orc.setSpeed} options={[{ v: 1, l: "1×" }, { v: 2, l: "2×" }, { v: 4, l: "4×" }]} />
      </div>
      <div className={cx("orc-progress", active && "on")} aria-hidden="true"><span style={{ width: Math.round(orc.progress * 100) + "%" }} /></div>
    </header>
  );
}

// ── Team and plan: one lane per agent, one block per step, columns by dependency ──────────────────────
function Lanes({ orc }) {
  const status = (s) => orc.steps[s.id] || "pending";
  const agentState = (a) => {
    const mine = STEPS.filter((s) => s.agent === a.id);
    if (mine.some((s) => status(s) === "running")) return "working";
    if (a.id === "conductor" && orc.state === "gate") return "asking you";
    if (mine.every((s) => ["done", "skipped"].includes(status(s)))) return "done";
    return mine.some((s) => status(s) === "done") ? "between steps" : "waiting";
  };
  return (
    <div className="orc-lanes" style={{ "--cols": N_COLS }} role="table" aria-label="The team and the plan">
      {AGENTS.map((a) => {
        const st = agentState(a);
        return (
          <div className="orc-lane" key={a.id} style={{ "--ac": a.color }} role="row">
            <div className={cx("orc-who", st === "working" && "on")} role="rowheader" title={a.charter}>
              <Avatar p={{ name: a.name, color: a.color }} size={20} />
              <span className="nm ellipsis">{a.name}</span>
              {st === "working" || st === "asking you" ? <span className={"st " + st.replace(/\s/g, "-")}>{st}</span> : null}
            </div>
            <div className="orc-track" role="cell">
              {STEPS.filter((s) => s.agent === a.id).map((s) => (
                <span key={s.id} className={cx("orc-blk", status(s))} style={{ gridColumn: STEP_COL.get(s.id) + 1 }} title={`${s.title} — ${STATUS_LABEL[status(s)]}${s.conditional ? " (only if needed)" : ""}`}>
                  {STEP_SHORT[s.id]}
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Transcript ───────────────────────────────────────────────────────────────────────────────────────
function Transcript({ orc, onLive, onTab }) {
  const box = useRef(null);
  const stick = useRef(true);
  useEffect(() => { const el = box.current; if (el && stick.current) el.scrollTop = el.scrollHeight; }, [orc.log, orc.state]);
  const onScroll = () => { const el = box.current; if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90; };
  const onClickCapture = (e) => {
    const a = e.target.closest && e.target.closest("a[href^='#']");
    if (a) { e.preventDefault(); orc.presenter.show(a.getAttribute("href")); }
  };
  if (!orc.log.length) return <Intro orc={orc} onLive={onLive} />;
  const gate = orc.world.gate && orc.world.gate.status === "pending";
  return (
    <div className="orc-log" ref={box} onScroll={onScroll} onClickCapture={onClickCapture}>
      {orc.log.map((x) => <LogItem key={x.id} x={x} settled={!!x.step && ["done", "skipped"].includes(orc.steps[x.step])} />)}
      {gate ? <GateCard orc={orc} onTab={onTab} /> : null}
      {orc.state === "done" ? <Done orc={orc} onTab={onTab} /> : null}
      {orc.state === "error" && orc.message ? <div className="note warn"><Icon name="warn" /><span className="small">{orc.message}</span></div> : null}
    </div>
  );
}

const LogItem = React.memo(function LogItem({ x, settled }) {
  const [open, setOpen] = useState(false);
  if (x.type === "step") {
    const s = stepById.get(x.step), a = agentById.get(s.agent);
    return (
      <div className={cx("orc-stephead", x.status)} style={{ "--ac": a.color }} id={"orc-step-" + x.step}>
        <Avatar p={{ name: a.name, color: a.color }} size={22} />
        <span className="who">{a.name}</span>
        <span className="t">{s.title}</span>
        <span className="st">{STATUS_LABEL[x.status] || x.status}</span>
      </div>
    );
  }
  if (x.type === "say") {
    const a = agentById.get(x.agent);
    const long = settled && !x.streaming && x.text.length > 420 && !(x.agent === "conductor" && x.step === "close");
    return (
      <div className={cx("orc-say", x.handoff && "handoff", x.agent === "conductor" && "lead", long && !open && "folded")} style={{ "--ac": a.color }}>
        {x.handoff ? <div className="hk tiny">{x.agent === "conductor" ? (x.step === "plan" ? "The plan" : x.step === "close" ? "Report to you" : "Conductor") : "Handoff to the Conductor"}</div> : null}
        <div className="txt">{x.text ? <MiniMarkdown text={x.text} /> : null}{x.streaming ? <span className="caret" aria-hidden="true" /> : null}</div>
        {long ? <button type="button" className="btn ghost sm more" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Less" : "Read all"}</button> : null}
      </div>
    );
  }
  if (x.type === "call") {
    const a = agentById.get(x.agent);
    return (
      <div className={cx("orc-call", x.status)} style={{ "--ac": a.color }}>
        <button type="button" className="oc-row" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className="oc-dot" aria-hidden="true" />
          <code className="oc-tool">{x.tool}</code>
          {x.via ? <span className="oc-via" title="Follows this control of the I2IDL-X catalog">{x.via}</span> : null}
          <span className="oc-sum ellipsis">{x.status === "running" ? "…" : x.status === "error" ? x.error : x.summary}</span>
          {x.drift ? <span className="tag warn" title="Re-run here, this call's result differs from the recording">differs</span> : null}
          <Icon name={open ? "up" : "down"} size={12} />
        </button>
        {open ? (
          <div className="oc-io">
            <CodeBlock title="Input" code={pretty(x.input || {})} />
            {x.status !== "running" ? <CodeBlock title={x.status === "error" ? "Error" : "Result"} code={x.status === "error" ? x.error : pretty(x.result)} /> : null}
          </div>
        ) : null}
      </div>
    );
  }
  if (x.type === "decision") return <div className={cx("orc-decision", x.decision)}><Icon name={x.decision === "approved" ? "check" : "x"} />You {x.decision} the staged calls.</div>;
  return <div className={cx("orc-note", x.tone)}>{x.text}</div>;
});

function Intro({ orc, onLive }) {
  return (
    <div className="orc-intro">
      <h2 className="h-display">A team of agents, working the workbench in front of you</h2>
      <p>{ORG.name}, a fictional hospital training academy, wants its learning inventory in I2IDL-X's semantic layer. The <b>Conductor</b> plans and hands the work to specialists. They act only through the controls the I2IDL-X catalog advertises and through this workbench's own tools, and the workbench beside them shows each call as it lands.</p>
      <ol className="orc-steps">
        {STEPS.map((s) => {
          const a = agentById.get(s.agent);
          return <li key={s.id} style={{ "--ac": a.color }}><Avatar p={{ name: a.name, color: a.color }} size={18} /><b>{a.name}</b><span>{s.title}{s.conditional ? <span className="tiny muted"> · if needed</span> : null}</span></li>;
        })}
      </ol>
      <p className="small muted">The inventory: {RECORDS.length} records from the academy's LMS, registry, credential platform and org chart. Some are harder than they look: one describes two kinds of thing at once, one has no concept in the glossary, and one is also published to a registry that speaks another vocabulary.</p>
      <div className="row wrap">
        <button className="btn primary" onClick={() => orc.start("recorded")} disabled={!orc.trace}><Icon name="play" filled />Watch the recorded run</button>
        <button className="btn" onClick={onLive}><Icon name="sparkle" />Run it live with Claude</button>
      </div>
      <p className="tiny muted">Everything happens in a sandbox in this page. The agents' proposals, votes and pack never reach the team's shared review queue, and the writes to Interego are only staged; you approve or decline them, and nothing is sent from this page.</p>
    </div>
  );
}

function GateCard({ orc, onTab }) {
  const g = orc.world.gate;
  const calls = orc.world.staged.filter((s) => g.calls.includes(s.id));
  return (
    <div className="orc-gate" role="group" aria-label="Approval">
      <div className="row"><Icon name="shield" /><b className="grow">The Conductor asks for your approval</b></div>
      {g.summary ? <div className="small"><MiniMarkdown text={g.summary} /></div> : null}
      <ul className="orc-calls">
        {calls.map((s) => <li key={s.id}><code>{s.port}</code><span>{s.title}</span><span className="tiny muted">{s.call.modal_status}{s.call.visibility ? " · " + s.call.visibility : ""}</span></li>)}
      </ul>
      <div className="row wrap">
        <button className="btn sm ghost" onClick={() => onTab("calls")}>Inspect the calls</button>
        <span className="spacer" />
        <button className="btn sm" onClick={() => orc.decide("declined")}>Decline</button>
        <button className="btn sm primary" onClick={() => orc.decide("approved")}><Icon name="check" />Approve</button>
      </div>
      <p className="tiny muted">Approving marks the calls ready for your own Interego agent to send; this page sends nothing.</p>
    </div>
  );
}

function Done({ orc, onTab }) {
  const w = orc.world;
  const items = w.items.length;
  return (
    <div className="orc-done">
      <div className="row"><Icon name="check" /><b className="grow">Run complete</b></div>
      <p className="small">{w.clashesSeen ? `${plural(w.clashesSeen, "record")} with a contradiction caught` : "No contradiction reached the graph"}; {plural(w.fixes.length, "fix request")}, {w.fixes.filter((f) => f.status === "done").length} resolved; {plural(w.gaps.size, "glossary gap")} flagged for I2IDL's editors; {plural(items, "crosswalk proposal")} reviewed; {plural(w.packs.length, "pack")} built; {plural(w.staged.length, "governed write")} staged{w.gate ? ` and ${w.gate.status}` : ""}.</p>
      <div className="row wrap">
        <button className="btn sm" onClick={() => onTab("graph")}><Icon name="graph" />Context graph</button>
        <button className="btn sm" onClick={() => onTab("calls")}><Icon name="upload" />Staged calls</button>
        <button className="btn sm" onClick={() => onTab("prov")}><Icon name="history" />The run as provenance</button>
      </div>
    </div>
  );
}

// ── Staged calls and provenance ───────────────────────────────────────────────────────────────────────
const portLabel = (id) => (PORTS.find((p) => p.id === id) || { label: id }).label;
function Staged({ orc }) {
  const w = orc.world;
  const { save, downloads } = useCaps();
  const { toast } = useUI();
  const all = w.staged.map((s) => ({ port: s.port, status: s.status, ...s.call }));
  if (!w.staged.length) return <div className="empty"><Icon name="upload" /><b>Nothing staged yet</b><div className="small">Governed writes — a crosswalk proposal, votes, the context graph — appear here as the exact publish_context calls the catalog's ports declare, with the I2IDL-X shapes the relay checks them against.</div></div>;
  const dl = async () => {
    try { await save("kestrel-point-staged-calls.json", pretty(all)); toast("Saved the staged calls", { icon: "download" }); }
    catch (e) { if (e && e.code !== "declined") toast("Saving isn't available here; use Copy.", { icon: "warn" }); }
  };
  const gate = w.gate && w.gate.status === "pending";
  return (
    <div className="orc-staged">
      <div className="row wrap">
        <p className="small grow">Each is the call an Interego agent sends to <code>publish_context</code> for that port. Replace <code>&lt;your-owner&gt;</code> with your pod.</p>
        <CopyBtn small text={() => pretty(all)} label="Copy all" />
        {downloads ? <button className="btn sm" onClick={dl}><Icon name="download" />JSON</button> : null}
      </div>
      {gate ? <div className="row"><span className="grow small"><b>Awaiting your decision.</b></span><button className="btn sm" onClick={() => orc.decide("declined")}>Decline</button><button className="btn sm primary" onClick={() => orc.decide("approved")}><Icon name="check" />Approve</button></div> : null}
      {w.staged.map((s) => {
        const a = agentById.get(s.by);
        return (
          <details key={s.id} className="orc-staged-call">
            <summary>
              <span className={"chip " + (s.status === "approved" ? "asserted" : s.status === "declined" ? "counterfactual" : "hypothetical")}>{s.status}</span>
              <b className="ellipsis">{s.title}</b>
              <span className="tiny muted ellipsis">{portLabel(s.port)} · {a ? a.name : s.by}</span>
            </summary>
            <CodeBlock title={`publish_context · ${s.port}`} code={pretty(s.call)} />
          </details>
        );
      })}
    </div>
  );
}

function Provenance({ orc }) {
  const ttl = useMemo(() => provTurtle({ log: orc.log, world: orc.world, mode: orc.mode, recordedAt: orc.mode === "recorded" && orc.trace ? orc.trace.recordedAt : null }), [orc.log, orc.version, orc.mode]);
  const { save, downloads } = useCaps();
  const { toast } = useUI();
  const dl = async () => {
    try { await save("kestrel-point-run.ttl", ttl); toast("Saved the run", { icon: "download" }); }
    catch (e) { if (e && e.code !== "declined") toast("Saving isn't available here; use Copy.", { icon: "warn" }); }
  };
  return (
    <div className="orc-prov stack" style={{ gap: 8 }}>
      <p className="small">The run as a context graph in Interego's harness vocabulary: each agent a <code>prov:SoftwareAgent</code> acting for you, each step an <code>ieh:AgentTurn</code>, each tool call an <code>ieh:AgentAction</code> that used the catalog control it followed — followed by the organization's classified inventory it produced.</p>
      <CodeBlock title="kestrel-point-run.ttl" code={ttl} actions={downloads ? <button className="btn sm" onClick={dl}><Icon name="download" />Save</button> : null} />
    </div>
  );
}

function LiveModal({ orc, onClose }) {
  const [tier, setTier] = useStored("orc.tier", "quick");
  const ok = orc.live.available;
  return (
    <Modal title="Run the team live with Claude" onClose={onClose}>
      <div className="stack">
        <p className="small">Each step becomes one Claude call on <b>your</b> account — about a dozen calls for the whole run — and each agent gets only its step's tools: these workbench functions, acting on a sandbox in this page. Nothing is published; the writes are staged for your approval.</p>
        <Seg label="Speed" value={tier} onChange={setTier} options={[{ v: "quick", l: "Fast" }, { v: "default", l: "Thorough" }]} />
        <p className="tiny muted">{tier === "quick" ? "Fast: a quick model, about a second per round; a run takes a minute or two." : "Thorough: the everyday model thinks before each round; a run takes several minutes."} Agents can make mistakes; that is part of what the Ontologist and the reviewers are there to catch.</p>
        {!ok ? <div className="note"><Icon name="info" /><span className="small">{orc.live.reason}</span></div> : null}
        <div className="row"><span className="spacer" /><button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn primary" disabled={!ok} onClick={() => { onClose(); orc.start("live", { tier }); }}><Icon name="play" filled />Start</button></div>
      </div>
    </Modal>
  );
}
