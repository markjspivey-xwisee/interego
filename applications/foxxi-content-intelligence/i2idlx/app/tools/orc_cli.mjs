#!/usr/bin/env node
// The command line an agent uses to act in a recorded orchestration run (see orc_server.js).
//
//   orc call <tool> [<json> | -] [--note "one line you say first"]   input as an argument, from stdin (-), or none
//   orc say "<text>" [--handoff]                                      a message; --handoff marks your report
//
// ORC_AGENT and ORC_STEP say who is acting in which step; ORC_PORT is the harness port (default 7811).
import process from "node:process";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v; };
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const agent = process.env.ORC_AGENT, step = process.env.ORC_STEP, port = process.env.ORC_PORT || "7811";
if (!agent || !step) { process.stderr.write("Set ORC_AGENT and ORC_STEP.\n"); process.exit(2); }

const post = async (path, obj) => {
  const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });
  return r.json();
};
const readStdin = () => new Promise((ok) => { let s = ""; process.stdin.on("data", (d) => { s += d; }); process.stdin.on("end", () => ok(s)); });

const cmd = args.shift();
if (cmd === "call") {
  const note = flag("--note");
  const tool = args.shift();
  const src = args.shift();
  let input = {};
  try { input = src === "-" ? JSON.parse((await readStdin()) || "{}") : src ? JSON.parse(src) : {}; }
  catch (e) { process.stderr.write(`Input is not JSON: ${e.message}\n`); process.exit(2); }
  const out = await post("/call", { agent, step, tool, input, ...(note ? { note } : {}) });
  process.stdout.write(JSON.stringify(out.ok ? out.result : { error: out.error }, null, 1) + "\n");
  process.exit(out.ok ? 0 : 1);
} else if (cmd === "say") {
  const handoff = has("--handoff");
  const out = await post("/say", { agent, step, text: args.join(" "), ...(handoff ? { handoff: true } : {}) });
  process.stdout.write(out.ok ? "said\n" : JSON.stringify(out) + "\n");
  process.exit(out.ok ? 0 : 1);
} else {
  process.stderr.write("usage: orc call <tool> [<json> | -] [--note \"…\"] | orc say \"<text>\" [--handoff]\n");
  process.exit(2);
}
