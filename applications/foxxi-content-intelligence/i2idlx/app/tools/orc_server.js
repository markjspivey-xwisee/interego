// Recording harness for an orchestrated run: the workbench's own sandbox and tools (src/orc/world.js),
// served over HTTP on localhost so agents outside the page can act through exactly the tools the page
// offers. Every call is executed against the same deterministic world and logged as a trace the page
// replays. tools/record_orchestra.py bundles it with esbuild (platform node) and starts it; not part of the page.
//
//   node build/orc-server.cjs <data.json> <port> <trace-out.json>
//
// POST /call {agent, step, tool, input, note?}   run one tool (the step's tools only); note = one line
//                                                 the agent says first, shown in the transcript
// POST /say  {agent, step, text, handoff?}       an agent's message (handoff: its report for the Conductor)
// POST /step {step, status}                      running | done | skipped
// POST /gate {decision}                          approved | declined (the person recording decides)
// GET  /trace                                    the trace so far (also written to trace-out.json)
import http from "node:http";
import fs from "node:fs";
import { createWorld, callTool, worldTurtle, decideGate } from "../src/orc/world.js";
import { STEPS, stepById, agentById } from "../src/orc/scenario.js";

const PORT = Number(process.argv[3] || 7811);
const OUT = process.argv[4] || "orc-trace.json";
const world = createWorld();
let t0 = Date.now();
let events = [];
let nCall = 0;
// --resume: rebuild the sandbox from an existing trace by re-running its calls (the tools are deterministic).
if (process.argv.includes("--resume") && fs.existsSync(OUT)) {
  const prev = JSON.parse(fs.readFileSync(OUT, "utf8"));
  t0 = Date.parse(prev.recordedAt);
  events = prev.events;
  for (const e of events) {
    if (e.k === "call") { nCall++; callTool(world, e.tool, e.input, e.agent, stepById.get(e.step).tools); }
    if (e.k === "decision") decideGate(world, e.decision);
  }
}

const push = (e) => {
  events.push({ ...e, t: Date.now() - t0 });
  fs.writeFileSync(OUT, JSON.stringify(trace(), null, 1));
};
const trace = () => ({ v: 1, recordedAt: new Date(t0).toISOString(), durationMs: Date.now() - t0, events });

function body(req) {
  return new Promise((ok, bad) => {
    let s = "";
    req.on("data", (d) => { s += d; });
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
  });
}
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj, null, 1)); };

http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/trace") return send(res, 200, trace());
    if (req.method === "GET" && req.url === "/turtle") { res.writeHead(200, { "content-type": "text/turtle" }); return res.end(worldTurtle(world)); }
    if (req.method !== "POST") return send(res, 404, { error: "not found" });
    const b = await body(req);
    if (req.url === "/gate") {
      if (!world.gate || world.gate.status !== "pending" || !["approved", "declined"].includes(b.decision)) return send(res, 400, { error: "no pending gate, or decision is not approved/declined" });
      decideGate(world, b.decision);
      push({ k: "decision", decision: b.decision });
      return send(res, 200, { ok: true });
    }
    if (req.url === "/step") {
      if (!stepById.has(b.step) || !["running", "done", "skipped"].includes(b.status)) return send(res, 400, { error: "unknown step or status" });
      push({ k: "step", step: b.step, status: b.status });
      return send(res, 200, { ok: true });
    }
    if (!agentById.has(b.agent) || !stepById.has(b.step)) return send(res, 400, { error: `unknown agent or step; agents: ${[...agentById.keys()].join(", ")}; steps: ${STEPS.map((s) => s.id).join(", ")}` });
    if (stepById.get(b.step).agent !== b.agent) return send(res, 400, { error: `step ${b.step} belongs to ${stepById.get(b.step).agent}` });
    if (req.url === "/say") {
      const text = String(b.text || "").trim();
      if (!text) return send(res, 400, { error: "empty text" });
      push({ k: "say", agent: b.agent, step: b.step, text, ...(b.handoff ? { handoff: true } : {}) });
      return send(res, 200, { ok: true });
    }
    if (req.url === "/call") {
      const step = stepById.get(b.step);
      if (b.note && String(b.note).trim()) push({ k: "say", agent: b.agent, step: b.step, text: String(b.note).trim() });
      const id = "c" + (++nCall);
      push({ k: "call", id, agent: b.agent, step: b.step, tool: String(b.tool), input: b.input || {} });
      const out = callTool(world, String(b.tool), b.input || {}, b.agent, step.tools);
      push({ k: "result", id, ok: out.ok, ...(out.ok ? { result: out.result } : { error: out.error }), summary: out.summary });
      return send(res, 200, out.ok ? { ok: true, result: out.result } : { ok: false, error: out.error });
    }
    return send(res, 404, { error: "not found" });
  } catch (e) {
    return send(res, 500, { error: String((e && e.message) || e) });
  }
}).listen(PORT, "127.0.0.1", () => process.stdout.write(`orchestra harness on http://127.0.0.1:${PORT}, writing ${OUT}${events.length ? ` (resumed: ${events.length} events, ${nCall} calls)` : ""}\n`));
