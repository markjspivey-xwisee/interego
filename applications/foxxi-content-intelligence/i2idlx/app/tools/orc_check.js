// Replays a recorded run against a fresh sandbox. Without a migration fixture every tool result must
// match the recording. tools/check_orchestra.py runs: node build/orc-check.cjs <data.json> <run.json> [migration.json]
import fs from "node:fs";
import { createHash } from "node:crypto";
import { META } from "../src/data.js";
import { createWorld, callTool, decideGate } from "../src/orc/world.js";
import { stepById } from "../src/orc/scenario.js";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const jsonDigest = (value) => sha256(JSON.stringify(value));
const isDigest = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const isCommit = (value) => typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
function migrationContract(fixture, traceBytes, trace, meta, pin) {
  const require = (ok, message) => { if (!ok) throw new Error("Invalid v0.0.93 replay migration fixture: " + message); };
  require(fixture?.v === 1 && Array.isArray(fixture.results), "expected fixture v1 and ordered results");
  require(trace.v === 1 && Array.isArray(trace.events), "expected the original v1 trace");
  require(fixture.historical?.release === "v0.0.86" && isDigest(fixture.historical.traceSha256) &&
    fixture.historical.traceSha256 === sha256(traceBytes), "original trace SHA-256 differs");
  const current = fixture.current;
  require(current?.release === "v0.0.93" && meta.release === current.release && pin.release === current.release, "current release differs");
  require(isCommit(current.graphRevision) && meta.commit === current.graphRevision, "current metadata graph revision differs");
  require(isCommit(current.checkoutCommit) && pin.commit === current.checkoutCommit, "source checkout commit differs");
  require(isDigest(current.graphSha256) && pin.graphSha256 === current.graphSha256, "source pin raw graph SHA-256 differs");
  require(pin.repository === meta.repo && pin.graphPath === "public/glossary.jsonld", "source repository or graph path differs");
  const calls = trace.events.filter((e) => e.k === "call");
  const resultEvents = trace.events.filter((e) => e.k === "result");
  require(calls.length === 48 && resultEvents.length === 48 && fixture.results.length === 48, "expected exactly 48 calls, original results and expectations");
  require(new Set(calls.map((e) => e.id)).size === 48 && new Set(resultEvents.map((e) => e.id)).size === 48, "duplicate original call or result ID");
  const original = new Map(resultEvents.map((e) => [e.id, e]));
  const seen = new Set();
  let changed = 0;
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i], row = fixture.results[i], recorded = original.get(call.id);
    require(row && row.id === call.id && row.tool === call.tool && !seen.has(row.id), "missing, unknown or reordered call at position " + (i + 1));
    seen.add(row.id);
    require(recorded && typeof row.ok === "boolean" && row.ok === recorded.ok, "original result status differs for " + call.id);
    require(isDigest(row.inputSha256) && row.inputSha256 === jsonDigest(call.input), "original input digest differs for " + call.id);
    require(isDigest(row.recordedSha256) && row.recordedSha256 === jsonDigest(recorded.ok ? recorded.result : recorded.error), "original result digest differs for " + call.id);
    require(isDigest(row.expectedSha256), "invalid expected result digest for " + call.id);
    if (row.recordedSha256 !== row.expectedSha256) {
      require(typeof row.changeReason === "string" && row.changeReason.trim().length > 0, "changed result lacks an explicit reason for " + call.id);
      changed++;
    } else require(row.changeReason == null, "unchanged result must retain identical recorded and expected digests for " + call.id);
  }
  require(changed === 11, "expected 11 reviewed changes and 37 identical results");
  return { rows: fixture.results, changed };
}

if (process.argv.length < 4 || process.argv.length > 5) throw new Error("Usage: orc-check.cjs <data.json> <run.json> [migration.json]");
const traceBytes = fs.readFileSync(process.argv[3]);
const trace = JSON.parse(traceBytes.toString("utf8"));
const migration = process.argv[4] ? migrationContract(
  JSON.parse(fs.readFileSync(process.argv[4], "utf8")), traceBytes, trace, META,
  JSON.parse(fs.readFileSync("../typescript/upstream-pin.json", "utf8")),
) : null;
const w = createWorld();
const results = new Map(trace.events.filter((e) => e.k === "result").map((e) => [e.id, e]));
const report = { calls: 0, matched: 0, mismatches: [], wrongAgent: [], wrongTool: [], errors: 0, steps: {} };
if (migration) report.migration = { release: "v0.0.93", boundCalls: migration.rows.length, reviewedChanges: migration.changed,
  unchanged: migration.rows.length - migration.changed, matched: 0, mismatches: [] };
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
  if (migration) {
    const row = migration.rows[report.calls - 1], actualSha256 = jsonDigest(out.ok ? out.result : out.error);
    if (out.ok === row.ok && actualSha256 === row.expectedSha256) report.migration.matched++;
    else report.migration.mismatches.push({ id: e.id, tool: e.tool, expectedOk: row.ok, actualOk: out.ok,
      expectedSha256: row.expectedSha256, actualSha256 });
  }
  if (!out.ok) report.errors++;
}
report.agents = [...new Set(trace.events.filter((e) => e.agent).map((e) => e.agent))];
report.final = { gate: w.gate ? w.gate.status : null, staged: w.staged.length, approved: w.staged.filter((s) => s.status === "approved").length, packs: w.packs.length, items: w.items.length };
report.calls_staged = w.staged.map((s) => ({ id: s.id, port: s.port, call: s.call }));
process.stdout.write(JSON.stringify(report));
