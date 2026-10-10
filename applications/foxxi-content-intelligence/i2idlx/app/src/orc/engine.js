// The orchestration engine. Two ways to run the same workflow over the same sandbox and tools:
//   recorded — replays a real run (every role a separate Claude agent), re-executing each tool call so the
//              workbench shows it happen; results are checked against the recording as they replay.
//   live     — runs the team on the viewer's own Claude account through the sample capability: each step
//              is one call whose tools are this page's functions (world.js).
// Both feed one transcript, one step map and one presentation queue the workbench pane plays.
/* global React */
import { META, C } from "../data.js";
import { useCaps } from "../caps.js";
import { useStored } from "../util.js";
import { createWorld, callTool, decideGate, TOOLS } from "./world.js";
import { ORG, RECORDS, AGENTS, STEPS, stepById, agentById } from "./scenario.js";

const { useState, useRef, useCallback, useMemo, useEffect } = React;
const CANCEL = { cancelled: true };
const MAX_PARALLEL = 2;

/** A queue of workbench presentation steps (navigate, type, point, click) that the pane plays in order. */
export function makePresenter() {
  let proc = null;
  let nav = null;
  const q = [];
  let busy = false;
  const waiters = [];
  const settle = () => { if (!q.length && !busy) waiters.splice(0).forEach((f) => f()); };
  const kick = async () => {
    if (busy || !proc) return settle();
    busy = true;
    while (q.length && proc) {
      const item = q.shift();
      try { await proc(item, q.length); } catch { /* a missing element never stops the run */ }
    }
    busy = false;
    settle();
  };
  return {
    push(steps, agent) { if (steps && steps.length) { q.push({ steps, agent }); kick(); } },
    drained() { return !proc || (!q.length && !busy) ? Promise.resolve() : new Promise((f) => waiters.push(f)); },
    attach(fn) { proc = fn; kick(); return () => { if (proc === fn) proc = null; q.length = 0; busy = false; waiters.splice(0).forEach((f) => f()); }; },
    clear() { q.length = 0; },
    setNavigator(fn) { nav = fn; return () => { if (nav === fn) nav = null; }; },
    show(hash) { if (nav) nav(hash); },
  };
}

const TEAM = AGENTS.map((a) => a.name).join(", ");
function promptFor(step, handoffs, w) {
  const a = agentById.get(step.agent);
  const plan = handoffs.find((h) => h.step === "plan");
  const others = handoffs.filter((h) => h.step !== "plan").slice(-8);
  const fixes = step.id === "fix" ? w.fixes.filter((f) => f.status === "open").map((f) => `- ${f.id} on ${f.record}: ${f.problem} Suggested: ${f.suggestion}`) : [];
  const items = step.id.startsWith("review-") ? w.items.map((i) => `- ${i.key}`) : [];
  const ending = step.id === "plan" ? "End with the plan: one short line per step, naming who does it. No preamble."
    : step.id === "close" ? "End with your report to the human: four to six plain sentences. No preamble, no sign-off."
      : "End with your handoff for the Conductor: two to four plain sentences — what you did, what you found, what the next agent must know. No preamble, no sign-off.";
  return `You are the ${a.name} on a team of eight AI agents (${TEAM}) working inside Interpretant, a workbench for the ${META.scheme.title} (release ${META.release}, ${C.length} concepts) decorated with I2IDL-X, a semantic layer published on Interego. A human is watching the workbench beside this conversation; your tools act on it.

${a.charter}

The brief, from ${ORG.name} (a fictional organization): ${ORG.goal}

The inventory (get_records gives the details):
${RECORDS.map((r) => `- ${r.id}: ${r.title}`).join("\n")}
${plan ? `\nThe Conductor's plan:\n${plan.text}\n` : ""}${others.length ? `\nHandoffs so far:\n${others.map((h) => `- ${agentById.get(h.agent).name}: ${h.text}`).join("\n")}\n` : ""}${fixes.length ? `\nOpen fix requests:\n${fixes.join("\n")}\n` : ""}${items.length ? `\nProposals under review:\n${items.join("\n")}\n` : ""}
Your step: ${step.title}. ${step.task}

How to work:
- Act only through your tools. Use few rounds: put many items in one call, and make independent calls in the same round.
- Before each round of tool calls, write one short line saying what you are about to do; the human reads it. Keep your reasoning to yourself.
- Ground everything in what the tools return; never invent concept ids, terms or results.
- ${ending}`;
}

const LIVE_ERRORS = {
  not_granted: "Claude isn't allowed on this page for your account, so the live run stopped.",
  sampling_disabled: "Claude isn't available for your account, so the live run stopped.",
  not_declared: "This page can no longer ask Claude.", capability_disabled: "Claude isn't available in this view.",
  tools_unavailable: "This view can't give Claude page tools, so a live run isn't possible here. The recorded run works everywhere.",
  rate_limited: "Too many Claude requests right now. Wait a little, then resume.",
  session_expired: "Your session expired. Sign in again, then resume.",
  prompt_too_large: "A step grew too large for one request.",
  refused: "Claude declined a step.", empty_completion: "A step came back empty.",
};

export function useOrchestra(trace) {
  const caps = useCaps();
  const world = useRef(createWorld());
  const [version, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const [log, setLog] = useState([]);
  const [steps, setSteps] = useState({});
  const [state, setState] = useState("idle"); // idle | running | paused | gate | done | error | stopped
  const [mode, setMode] = useState("recorded");
  const [message, setMessage] = useState(null);
  const [progress, setProgress] = useState(0);
  const [runId, setRunId] = useState(0);
  const [speed, setSpeed] = useStored("orc.speed", 1);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const presenter = useMemo(makePresenter, []);
  const run = useRef(null);
  const seq = useRef(0);
  const [live, setLive] = useState({ available: false, reason: "Checking whether Claude can run here…" });

  // Can this view run a live team? Needs the sample capability with page tools.
  useEffect(() => {
    if (!caps.resolved) return;
    if (!caps.sample) { setLive({ available: false, reason: "Open this page in claude.ai, signed in, to run the team live on your own Claude account." }); return; }
    let on = true;
    caps.sample.limits().then((l) => {
      if (!on) return;
      setLive(l && l.tools ? { available: true, maxTools: l.tools.maxCount || 5 } : { available: false, reason: "This view can't give Claude page tools, so only the recorded run is available here." });
    }).catch(() => on && setLive({ available: false, reason: "Claude isn't available in this view." }));
    return () => { on = false; };
  }, [caps.resolved, caps.sample]);

  const nid = () => "e" + ++seq.current;
  const add = useCallback((item) => setLog((l) => [...l, item]), []);
  const patch = useCallback((id, fn) => setLog((l) => l.map((x) => (x.id === id ? { ...x, ...fn(x) } : x))), []);
  const setStep = useCallback((id, status) => {
    setSteps((s) => ({ ...s, [id]: status }));
    setLog((l) => (l.some((x) => x.type === "step" && x.step === id)
      ? l.map((x) => (x.type === "step" && x.step === id ? { ...x, status } : x))
      : [...l, { id: "s-" + id, type: "step", step: id, status }]));
  }, []);

  const sleep = (r, ms) => new Promise((f, bad) => {
    const t = setTimeout(() => (r.cancelled ? bad(CANCEL) : f()), ms / Math.max(0.25, speedRef.current));
    r.timers.add(t);
  });
  const checkpoint = async (r) => {
    if (r.cancelled) throw CANCEL;
    while (r.paused) {
      await new Promise((f) => { r.resume = f; });
      if (r.cancelled) throw CANCEL;
    }
  };
  const waitGate = (r) => {
    const g = world.current.gate;
    if (g && g.status !== "pending") return Promise.resolve(g.status); // decided while the workbench caught up
    return new Promise((f) => { r.gate = f; setState("gate"); });
  };

  const reset = useCallback(() => {
    world.current = createWorld();
    presenter.clear();
    setLog([]);
    setSteps({});
    setMessage(null);
    setProgress(0);
    bump();
  }, [presenter, bump]);

  const cancel = useCallback(() => {
    const r = run.current;
    if (!r) return;
    r.cancelled = true;
    r.timers.forEach(clearTimeout);
    if (r.resume) r.resume();
    if (r.gate) r.gate("cancelled");
    if (r.ctl) r.ctl.abort();
    run.current = null;
  }, []);
  useEffect(() => cancel, [cancel]);

  // ── Recorded ──────────────────────────────────────────────────────────────────────────────────────
  const typeOut = async (r, ev) => {
    const id = nid();
    add({ id, type: "say", agent: ev.agent, step: ev.step, text: "", handoff: !!ev.handoff, streaming: true });
    const full = ev.text;
    let shown = 0;
    while (shown < full.length) {
      await checkpoint(r);
      await new Promise((f) => setTimeout(f, 40));
      shown = Math.min(full.length, shown + Math.max(1, Math.round(4.4 * speedRef.current)));
      patch(id, () => ({ text: full.slice(0, shown) }));
    }
    patch(id, () => ({ streaming: false }));
    await sleep(r, 260);
  };

  const gateHere = async (r) => {
    const g = world.current.gate;
    if (!g) return;
    if (g.status === "pending") {
      await presenter.drained();
      const d = await waitGate(r);
      if (d === "cancelled") throw CANCEL;
      setState("running");
    }
    if (g.status === "declined") r.declined = true;
  };

  const replay = async (r) => {
    const evs = trace.events;
    const recorded = new Map(evs.filter((e) => e.k === "result").map((e) => [e.id, e]));
    for (; r.i < evs.length; r.i++) {
      await checkpoint(r);
      const ev = evs[r.i];
      setProgress(r.i / evs.length);
      if (r.declined && ev.step === "close") continue;
      if (ev.k === "step") {
        setStep(ev.step, ev.status);
        await sleep(r, ev.status === "running" ? 420 : 200);
      } else if (ev.k === "say") {
        await typeOut(r, ev);
        if (--r.budget <= 0) { r.paused = true; setState("paused"); }
      } else if (ev.k === "call") {
        const id = nid();
        const step = stepById.get(ev.step);
        add({ id, type: "call", agent: ev.agent, step: ev.step, tool: ev.tool, input: ev.input, via: TOOLS[ev.tool] && TOOLS[ev.tool].via, status: "running" });
        await sleep(r, 420);
        const out = callTool(world.current, ev.tool, ev.input, ev.agent, step.tools);
        const rec = recorded.get(ev.id);
        const drift = !!rec && JSON.stringify(rec.ok ? rec.result : rec.error) !== JSON.stringify(out.ok ? out.result : out.error);
        patch(id, () => ({ status: out.ok ? "ok" : "error", summary: out.summary, result: out.result, error: out.error, drift }));
        bump();
        presenter.push(out.ui, ev.agent);
        await presenter.drained();
        await sleep(r, 160);
        if (--r.budget <= 0) { r.paused = true; setState("paused"); }
      } else if (ev.k === "decision") {
        // where the person recording decided, the viewer decides (unless they already did from the gate card)
        await gateHere(r);
      }
    }
    await gateHere(r); // a recording that ends at its gate
    if (r.declined) {
      setStep("close", "skipped");
      add({ id: nid(), type: "note", tone: "muted", text: "You declined, so nothing staged leaves the sandbox. The recorded run's closing report assumed approval and is not shown." });
    }
  };

  // ── Live ──────────────────────────────────────────────────────────────────────────────────────────
  const liveStep = async (r, step, handoffs, tier, maxTools) => {
    setStep(step.id, "running");
    const names = step.tools.slice(0, maxTools);
    let consumed = 0, textNow = "", cur = null;
    const closeSegment = () => {
      const seg = textNow.slice(consumed).trim();
      consumed = textNow.length;
      if (cur) { patch(cur, () => ({ text: seg, streaming: false })); cur = null; }
      else if (seg) add({ id: nid(), type: "say", agent: step.agent, step: step.id, text: seg });
    };
    const tools = names.map((name) => ({
      name, description: TOOLS[name].description, ...(TOOLS[name].inputSchema ? { inputSchema: TOOLS[name].inputSchema } : {}),
      execute: async (input) => {
        if (r.cancelled) throw new Error("The run was stopped.");
        closeSegment();
        const id = nid();
        add({ id, type: "call", agent: step.agent, step: step.id, tool: name, input, via: TOOLS[name].via, status: "running" });
        const out = callTool(world.current, name, input, step.agent, names);
        patch(id, () => ({ status: out.ok ? "ok" : "error", summary: out.summary, result: out.result, error: out.error }));
        bump();
        presenter.push(out.ui, step.agent);
        if (!out.ok) throw new Error(out.error);
        return out.result;
      },
    }));
    const onText = ({ text }) => {
      textNow = text;
      const seg = text.slice(consumed).replace(/^\s+/, "");
      if (!seg) return;
      if (!cur) { cur = nid(); add({ id: cur, type: "say", agent: step.agent, step: step.id, text: seg, streaming: true }); }
      else patch(cur, () => ({ text: seg }));
    };
    const res = await caps.sample(promptFor(step, handoffs, world.current), { tools, modelTier: tier, signal: r.ctl.signal, onText });
    textNow = res.text;
    const last = res.text.slice(consumed).trim();
    if (cur) patch(cur, () => ({ text: last || "(no message)", streaming: false, handoff: true }));
    else add({ id: nid(), type: "say", agent: step.agent, step: step.id, text: last || "(no message)", handoff: true });
    handoffs.push({ agent: step.agent, step: step.id, text: last.slice(-1600) });
    if (res.truncated) add({ id: nid(), type: "note", tone: "warn", text: `${agentById.get(step.agent).name}'s turn was cut short.` });
    setStep(step.id, "done");
  };

  const runLiveTeam = async (r, tier, maxTools) => {
    const handoffs = [];
    const status = new Map(STEPS.map((s) => [s.id, "pending"]));
    const settled = (id) => ["done", "skipped"].includes(status.get(id));
    const active = new Map();
    for (;;) {
      await checkpoint(r);
      for (const s of STEPS) {
        if (!s.conditional || status.get(s.id) !== "pending" || !s.after.every(settled)) continue;
        const need = s.id === "fix" ? world.current.fixes.some((f) => f.status === "open") : status.get("fix") === "done";
        if (!need) { status.set(s.id, "skipped"); setStep(s.id, "skipped"); }
      }
      const ready = STEPS.filter((s) => status.get(s.id) === "pending" && s.after.every(settled));
      for (const s of ready.slice(0, Math.max(0, MAX_PARALLEL - active.size))) {
        status.set(s.id, "running");
        const p = liveStep(r, s, handoffs, tier, maxTools).then(() => { status.set(s.id, "done"); active.delete(s.id); });
        p.catch(() => {}); // the race below reports the first failure; later ones are the abort it causes
        active.set(s.id, p);
      }
      setProgress([...status.values()].filter((x) => x === "done" || x === "skipped").length / STEPS.length);
      if (!active.size) break;
      await Promise.race(active.values());
      if (world.current.gate && !active.size && !r.gateDone) {
        r.gateDone = true;
        await presenter.drained();
        const d = await waitGate(r);
        if (d === "cancelled") throw CANCEL;
        setState("running");
        if (d === "declined") {
          status.set("close", "skipped");
          setStep("close", "skipped");
          add({ id: nid(), type: "note", tone: "muted", text: "You declined, so nothing staged leaves the sandbox." });
        }
      }
    }
  };

  // ── Controls ──────────────────────────────────────────────────────────────────────────────────────
  const start = async (which, opts = {}) => {
    cancel();
    reset();
    const r = { cancelled: false, paused: false, resume: null, gate: null, timers: new Set(), i: 0, budget: Infinity, declined: false, ctl: new AbortController() };
    run.current = r;
    setMode(which);
    setRunId((n) => n + 1);
    setState("running");
    try {
      if (which === "recorded") {
        add({ id: nid(), type: "note", tone: "muted", text: `Recorded run, ${new Date(trace.recordedAt).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })}: each role was a separate Claude agent acting through these tools. The page re-runs every call as it replays, so the workbench shows each one happen.` });
        await replay(r);
      } else {
        add({ id: nid(), type: "note", tone: "muted", text: `Live run on your Claude account (${opts.tier === "quick" ? "fast" : "thorough"}): one Claude call per step, each with only that step's tools. Nothing leaves the sandbox without your approval.` });
        await runLiveTeam(r, opts.tier || "quick", live.maxTools || 5);
      }
      if (run.current === r) { setProgress(1); setState("done"); run.current = null; }
    } catch (e) {
      if (e === CANCEL || (e && e.code === "cancelled")) return;
      if (run.current !== r) return;
      r.ctl.abort();
      const text = (e && e.code && LIVE_ERRORS[e.code]) || (e && e.code ? "Something went wrong reaching Claude. Try again later." : String((e && e.message) || e));
      setMessage(text);
      add({ id: nid(), type: "note", tone: "warn", text });
      setState("error");
      run.current = null;
    }
  };

  const pause = useCallback(() => { const r = run.current; if (r && !r.paused) { r.paused = true; setState("paused"); } }, []);
  const resume = useCallback(() => {
    const r = run.current;
    if (!r) return;
    r.paused = false;
    r.budget = Infinity;
    setState("running");
    if (r.resume) { const f = r.resume; r.resume = null; f(); }
  }, []);
  const next = useCallback(() => {
    const r = run.current;
    if (!r || !r.paused) return;
    r.budget = 1;
    r.paused = false;
    setState("running");
    if (r.resume) { const f = r.resume; r.resume = null; f(); }
  }, []);
  const stop = useCallback(() => { cancel(); setState("stopped"); }, [cancel]);
  const decide = useCallback((decision) => {
    const r = run.current;
    decideGate(world.current, decision);
    bump();
    add({ id: nid(), type: "decision", decision });
    if (r && r.gate) { const f = r.gate; r.gate = null; f(decision); }
  }, [bump, add]);

  return {
    world: world.current, version, bump, log, steps, state, mode, message, progress, runId, speed, setSpeed, live, presenter, trace,
    start, pause, resume, next, stop, decide,
  };
}
