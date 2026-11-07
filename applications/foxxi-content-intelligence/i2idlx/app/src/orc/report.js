// A factual receipt of the sandbox's actual results, not another model response.
export function workflowReport(summary) {
  if (!summary || !["approved", "declined"].includes(summary.humanDecision)) {
    throw new Error("A human decision is required before the workflow can report completion.");
  }
  for (const name of ["records", "gaps", "proposals", "packs", "staged"]) {
    if (!Array.isArray(summary[name])) throw new Error("The workflow summary is incomplete.");
  }
  for (const name of ["typings", "recordsWithContradictions", "fixesApplied"]) {
    if (!Number.isSafeInteger(summary[name]) || summary[name] < 0) throw new Error("The workflow summary is incomplete.");
  }
  const count = (n, singular, plural = singular + "s") => `${n} ${n === 1 ? singular : plural}`;
  const classified = summary.records.filter(record => record.status === "classified").length;
  const calls = Object.fromEntries(["approved", "declined", "staged"].map(status => [status, summary.staged.filter(call => call.status === status).length]));
  return [
    `You ${summary.humanDecision} the staged calls in this sandbox.`,
    `${classified} of ${summary.records.length} records are classified; ${count(summary.gaps.length, "glossary gap")} flagged locally.`,
    `${count(summary.typings, "inferred type assignment")} recorded; ${count(summary.recordsWithContradictions, "record")} had contradictions and ${count(summary.fixesApplied, "fix", "fixes")} ${summary.fixesApplied === 1 ? "was" : "were"} applied.`,
    `${count(summary.proposals.length, "crosswalk proposal")} and ${count(summary.packs.length, "glossary pack")} were created.`,
    `Staged-call status: ${calls.approved} approved, ${calls.declined} declined, ${calls.staged} still staged.`,
    "No staged call was sent or published from this page.",
  ].join(" ");
}
