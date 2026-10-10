// Replays a recorded orchestrated run against a fresh sandbox and compares every tool result with the
// recording. Run by tools/check_orchestra.py:  node build/orc-check.cjs <data.json> <run.json>
import fs from "node:fs";
import { createWorld, callTool, decideGate } from "../src/orc/world.js";
import { stepById } from "../src/orc/scenario.js";

const trace = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const w = createWorld();
const results = new Map(trace.events.filter((e) => e.k === "result").map((e) => [e.id, e]));
const report = { calls: 0, matched: 0, mismatches: [], wrongAgent: [], wrongTool: [], errors: 0, steps: {} };
for (const e of trace.events) {
  if (e.k === "step") report.steps[e.step] = e.status;
  if (e.k === "decision") decideGate(w, e.decision);
  if (e.k !== "call") continue;
  report.calls++;
  const st = stepById.get(e.step);
  if (!st || st.agent !== e.agent) report.wrongAgent.push(e.id);
  if (!st || !st.tools.includes(e.tool)) report.wrongTool.push(e.id);
  const out = callTool(w, e.tool, e.input, e.agent, st ? st.tools : null);
  const rec = results.get(e.id);
  const same = !!rec && rec.ok === out.ok && JSON.stringify(rec.ok ? rec.result : rec.error) === JSON.stringify(out.ok ? out.result : out.error);
  if (same) report.matched++;
  else report.mismatches.push({ id: e.id, tool: e.tool });
  if (!out.ok) report.errors++;
}
report.agents = [...new Set(trace.events.filter((e) => e.agent).map((e) => e.agent))];
report.final = { gate: w.gate ? w.gate.status : null, staged: w.staged.length, approved: w.staged.filter((s) => s.status === "approved").length, packs: w.packs.length, items: w.items.length };
report.calls_staged = w.staged.map((s) => ({ id: s.id, port: s.port, call: s.call }));
process.stdout.write(JSON.stringify(report));
