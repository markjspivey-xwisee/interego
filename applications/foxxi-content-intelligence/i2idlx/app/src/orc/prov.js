// The run as provenance: every agent a prov:SoftwareAgent acting for the person who ran it, every step an
// ieh:AgentTurn, every tool call an ieh:AgentAction that used the catalog control it followed — Interego's
// harness vocabulary, so the run itself can be published as a context graph next to what it produced.
import { META } from "../data.js";
import { ORG, AGENTS, stepById } from "./scenario.js";
import { TOOLS, worldTurtle } from "./world.js";

const lit = (s) => JSON.stringify(String(s));

// The original trace names its release in its own recording note; do not infer a source commit.
export function recordedReleaseOf(trace) {
  return /\bagainst I2IDL (v\d+\.\d+\.\d+)\b/.exec(trace && trace.note || "")?.[1] || null;
}

export function provTurtle({ log, world, mode, recordedAt, recordedRelease }) {
  const stamp = (recordedAt || new Date().toISOString()).replace(/[^0-9]/g, "").slice(0, 14);
  const run = `urn:interpretant:run:${mode}-${stamp}${mode === "recorded" ? "-on-" + encodeURIComponent(META.commit) : ""}`;
  const who = "urn:interpretant:person";
  const out = [
    "@prefix prov: <http://www.w3.org/ns/prov#> .",
    "@prefix ieh:  <https://markjspivey-xwisee.github.io/interego/ns/harness#> .",
    "@prefix dct:  <http://purl.org/dc/terms/> .",
    "@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .",
    "@prefix owl:  <http://www.w3.org/2002/07/owl#> .",
    `@prefix cat:  <${META.iri.catalog}#> .`,
    "",
    `<${run}> a prov:Activity ;`,
    `    rdfs:label ${lit(`Orchestrated onboarding of ${ORG.name} (fictional) into I2IDL-X`)}@en ;`,
    `    dct:description ${lit(mode === "live" ? "Run live in Interpretant on the viewer's connected model account." : `Deterministic re-execution against I2IDL ${META.release} of the original Claude transcript recorded against I2IDL ${recordedRelease || "(release not supplied)"}. Historical messages and tool inputs are retained; current tool results may differ. No new model calls were made in recorded mode.`)}@en ;`,
    `    prov:used <${META.iri.catalog}>, <${run}/source> .`,
    `<${run}/source> a prov:Entity ; owl:versionInfo ${lit(META.release)} ; dct:identifier ${lit(META.commit)} ; dct:source <${META.repo}> .`,
    `<${who}> a prov:Agent ; rdfs:label "The person who ran or watched this run"@en .`,
  ];
  if (mode === "recorded") {
    out.push(`<${run}> prov:wasDerivedFrom <${run}/recording> .`);
    out.push(`<${run}/recording> a prov:Entity ; rdfs:label "Original Claude transcript"@en${recordedRelease ? ` ; owl:versionInfo ${lit(recordedRelease)}` : ""}${recordedAt ? ` ; dct:identifier ${lit(recordedAt)}` : ""} .`);
  }
  for (const a of AGENTS) out.push(`<urn:interpretant:agent:${a.id}> a prov:SoftwareAgent ; rdfs:label ${lit(a.name)}@en ; prov:actedOnBehalfOf <${who}> .`);
  const turns = new Set();
  let n = 0;
  for (const x of log) {
    if (x.type === "step" && x.status !== "skipped" && !turns.has(x.step)) {
      turns.add(x.step);
      const s = stepById.get(x.step);
      out.push(`<${run}/turn/${x.step}> a ieh:AgentTurn ; rdfs:label ${lit(s.title)}@en ;\n    prov:wasAssociatedWith <urn:interpretant:agent:${s.agent}> ; ieh:answeredFor <${who}> ; dct:isPartOf <${run}> .`);
    }
    if (x.type === "call" && x.status !== "running") {
      n++;
      const via = TOOLS[x.tool] && TOOLS[x.tool].via;
      out.push(`<${run}/action/${n}> a ieh:AgentAction ; dct:title ${lit(x.tool)} ;\n    prov:wasAssociatedWith <urn:interpretant:agent:${x.agent}> ; prov:wasInformedBy <${run}/turn/${x.step}> ;\n    ieh:toolArgs ${lit(JSON.stringify(x.input || {}))} ; ieh:outcome ${lit(x.status === "ok" ? "success" : "failure")}${via ? ` ;\n    prov:used cat:${via}` : ""} .`);
    }
    if (x.type === "decision") out.push(`<${run}/decision> a prov:Activity ; rdfs:label ${lit(x.decision === "approved" ? "Approved the staged calls" : "Declined the staged calls")}@en ;\n    prov:wasAssociatedWith <${who}> ; dct:isPartOf <${run}> .`);
  }
  return `# The run as provenance (Interego harness vocabulary).\n${out.join("\n")}\n\n# What the run produced: the organization's context graph.\n${worldTurtle(world).replace(/^#.*\n/, "")}`;
}
