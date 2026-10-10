// The orchestration scenario: a fictional organization's learning inventory, the team of agents that
// onboards it into I2IDL-X's semantic layer, and the workflow they follow. Data only — the tools are in
// world.js, the live and recorded runs in engine.js.

export const ORG = {
  name: "Kestrel Point Clinical Academy",
  short: "Kestrel Point",
  note: "A fictional hospital training academy, invented for this walkthrough.",
  ns: "https://example.org/kestrel-point/",
  slug: "kestrel-point-learning-context",
  goal: "Bring the academy's learning inventory into I2IDL-X's semantic layer: classify every resource with the I2IDL concept it is an instance of, check the result for contradictions, crosswalk the academy's credential for the registry it publishes to, give new staff an onboarding glossary, and stage the whole thing as a context graph on the academy's own pod. Nothing leaves the sandbox without a human's approval.",
};

// The inventory as the academy exported it from its systems. sourceTypes are typings its own registry
// already carries (peer classes); everything else is free text.
export const RECORDS = [
  { id: "lrs-prod", title: "Statement store (production)", source: "Infrastructure registry", sourceTypes: ["tla:TransactionalLRS"],
    description: "The academy's xAPI 2.0 learning record store. Simulators, courses and the mobile app send statements to it; the analytics team queries it." },
  { id: "sepsis-sim", title: "Sepsis recognition simulation", source: "LMS catalog", sourceTypes: [],
    description: "A high-fidelity manikin scenario — scenario file, patient script and monitor settings — run as instructor-facilitated sessions with a structured debrief and a formative skills checklist." },
  { id: "med-safety-check", title: "Medication-safety knowledge check", source: "LMS catalog", sourceTypes: [],
    description: "A twelve-item quiz taken midway through the medication module. Scores feed coaching conversations, not grades." },
  { id: "preceptorship", title: "New-graduate preceptorship", source: "Nursing education plan", sourceTypes: [],
    description: "Each newly graduated nurse is paired with an experienced preceptor for twelve weeks of guided practice and weekly reflection." },
  { id: "insulin-micro", title: "Insulin dosing microlearning", source: "Mobile app", sourceTypes: [],
    description: "Five-minute lessons on insulin dosing, delivered to phones before shifts and spaced over two weeks." },
  { id: "bls-badge", title: "Basic life support skills badge", source: "Credential platform", sourceTypes: [],
    description: "An Open Badges 3.0 credential issued when a learner passes the BLS skills check. The academy also lists it in a credential registry that uses CTDL." },
  { id: "nurse-transcript", title: "Nurse learning transcript", source: "HR integration", sourceTypes: [],
    description: "The per-person record of completions, scores and credentials that the academy shares with HR for role readiness." },
  { id: "ed-team", title: "Clinical education team", source: "Org chart", sourceTypes: [],
    description: "The nurse educators and learning engineers who design, run and evaluate the academy's programmes." },
  { id: "readiness-dash", title: "Unit readiness dashboard", source: "Analytics", sourceTypes: [],
    description: "Shows each unit manager which staff are current on required training. Built on the statement store." },
  { id: "competency-framework", title: "Clinical competency framework v3", source: "Nursing education plan", sourceTypes: [],
    description: "The academy's structured set of clinical competencies and proficiency levels, used to plan training and judge role readiness." },
];

// The team. Colors come from the workbench's validated categorical palette, so each has a dark-theme
// step; names, initials and glyphs carry identity too, never color alone.
export const AGENTS = [
  { id: "conductor", name: "Conductor", color: "var(--k-actor)", icon: "route",
    charter: "You orchestrate the team: you plan the work, hand each step to the right specialist, validate the result and ask the human before anything is published. You are accountable to the human." },
  { id: "scout", name: "Scout", color: "var(--k-notion)", icon: "globe",
    charter: "You navigate hypermedia. You read the I2IDL-X HyprCat catalog and inspect the controls (ports and stored queries) the team will follow, so the others act only through affordances the catalog advertises, with the inputs and defaults it declares." },
  { id: "lexicographer", name: "Lexicographer", color: "var(--k-standard)", icon: "book",
    charter: "You know the I2IDL Digital Learning Glossary. You classify each record with i2x:isClassifiedBy: the I2IDL concept the thing IS AN INSTANCE OF (never what it is merely about). You read a concept's definition before you use it, and you say when the glossary has no fitting concept." },
  { id: "ontologist", name: "Ontologist", color: "var(--k-system)", icon: "tree",
    charter: "You own the semantic layer. You run the classifier that types classified data in BFO 2020 (with IAO and CCO), gist, DOLCE-UltraLite, gUFO, PROV-O, schema.org and peer vocabularies, and you catch contradictions: a thing classified into two referent categories that an upper ontology makes disjoint." },
  { id: "crosswalker", name: "Crosswalker", color: "var(--k-enactable)", icon: "link",
    charter: "You connect I2IDL concepts to the peer vocabularies other systems speak (CTDL, CTDL-ASN, IEEE LER, Open Badges, ESCO, schema.org). You check what crosswalks already exist and propose a SKOS mapping only to a term you can confirm exists." },
  { id: "standards", name: "Standards reviewer", color: "var(--k-normative)", icon: "shield",
    charter: "You review crosswalk proposals for semantic correctness: both definitions, the direction and strength of the SKOS predicate, and what a ratified mapping would make a reasoner conclude." },
  { id: "practice", name: "Practice reviewer", color: "var(--k-domain)", icon: "users",
    charter: "You review crosswalk proposals from practice: whether the mapping matches how the organization actually issues, uses and reports the thing, and whether it would mislead the people and systems downstream." },
  { id: "curator", name: "Curator", color: "var(--k-framework)", icon: "pack",
    charter: "You turn the team's work into something people use: an onboarding glossary (a pack) of the concepts the organization's inventory relies on, in a sensible teaching order, each with a one-line note on why it matters here." },
];
export const agentById = new Map(AGENTS.map((a) => [a.id, a]));

// The workflow. after = dependencies; a conditional step runs only when an earlier one asks for it.
export const STEPS = [
  { id: "plan", agent: "conductor", title: "Plan the onboarding", after: [], tools: ["get_records"],
    task: "Read the brief and the inventory, then write the plan the team will follow: what each specialist does, in what order, and what you will check before asking the human to approve." },
  { id: "discover", agent: "scout", title: "Discover the catalog's controls", after: ["plan"], tools: ["read_catalog", "inspect_control"],
    task: "Read the catalog. Then inspect the controls the team needs: the classifier (q-classify), publishing classified data (port-publish-classified), proposing a crosswalk (port-propose-mapping) and voting on one (port-ratify). Report each control's inputs, defaults and what the relay checks, so the others follow them correctly." },
  { id: "classify", agent: "lexicographer", title: "Classify the inventory", after: ["discover"], tools: ["get_records", "search_glossary", "read_concepts", "classify_records", "flag_gap"],
    task: "Classify every record in the inventory with the I2IDL concept or concepts it is an instance of. Search, read the candidates' definitions, then classify all records in one call. Where no concept fits, flag a gap with the nearest concepts instead of forcing one." },
  { id: "check", agent: "ontologist", title: "Infer types, catch contradictions", after: ["classify"], tools: ["run_classifier", "explain_category", "read_concepts", "request_fix"],
    task: "Run the classifier over the classified inventory. Report what it infers. For each contradiction, explain it from the referent categories involved and request a fix from the Lexicographer that says what the record should become." },
  { id: "fix", agent: "lexicographer", title: "Resolve the fix requests", after: ["check"], conditional: true, tools: ["get_records", "search_glossary", "read_concepts", "split_record", "reclassify_record", "flag_gap"],
    task: "Resolve each open fix request: split a record into the separate things it describes, or reclassify it; where no concept fits a part, flag the gap rather than force one." },
  { id: "recheck", agent: "ontologist", title: "Confirm the fix", after: ["fix"], conditional: true, tools: ["run_classifier", "explain_category"],
    task: "Run the classifier again and confirm that no contradiction remains." },
  { id: "crosswalk", agent: "crosswalker", title: "Crosswalk the credential", after: ["classify"], tools: ["list_classified", "find_crosswalks", "check_peer_term", "read_concepts", "propose_mapping"],
    task: "The academy also lists its badge in a credential registry that uses CTDL. Find the badge's concept, check the crosswalks it already has, and if the registry's class is missing propose one SKOS mapping — only to a term the peer index confirms." },
  { id: "review-standards", agent: "standards", title: "Review the crosswalk's semantics", after: ["crosswalk"], tools: ["read_proposal", "read_concepts", "cast_vote"],
    task: "Review the crosswalk proposal against both definitions and the SKOS predicate's meaning, and vote for, against or abstain, with a one-sentence reason." },
  { id: "review-practice", agent: "practice", title: "Review the crosswalk in practice", after: ["crosswalk"], tools: ["read_proposal", "read_concepts", "cast_vote"],
    task: "Review the crosswalk proposal against how the academy issues, lists and reports the badge, and vote for, against or abstain, with a one-sentence reason." },
  { id: "pack", agent: "curator", title: "Build the onboarding glossary", after: ["recheck", "review-standards", "review-practice"], tools: ["list_classified", "read_concepts", "create_pack", "suggest_additions", "add_to_pack"],
    task: "Build the onboarding glossary for new staff from the concepts the inventory uses: a teaching order, and a one-line note on each saying why it matters at the academy. Add at most a few suggested terms, only if they help." },
  { id: "stage", agent: "conductor", title: "Validate, stage, ask", after: ["pack"], tools: ["validate_publication", "stage_publication", "request_approval"],
    task: "Validate the context graph. If it is ready, stage the governed write that publishes it to the academy's pod, then ask the human to approve everything staged." },
  { id: "close", agent: "conductor", title: "Report to the human", after: ["stage"], tools: ["run_summary"],
    task: "Report the outcome to the human in a few sentences: what was classified and inferred, what was caught and fixed, what was proposed and decided, what is staged, and what the human decided." },
];
export const stepById = new Map(STEPS.map((s) => [s.id, s]));
export const STEP_SHORT = { plan: "Plan", discover: "Discover", classify: "Classify", check: "Check", fix: "Fix", recheck: "Re-check",
  crosswalk: "Crosswalk", "review-standards": "Review", "review-practice": "Review", pack: "Pack", stage: "Stage", close: "Report" };

// Swimlane columns: a step's column is one more than the furthest step it depends on.
export const STEP_COL = (() => {
  const col = new Map();
  const of = (id) => {
    if (col.has(id)) return col.get(id);
    const s = stepById.get(id);
    const c = s.after.length ? Math.max(...s.after.map(of)) + 1 : 0;
    col.set(id, c);
    return c;
  };
  for (const s of STEPS) of(s.id);
  return col;
})();
export const N_COLS = Math.max(...STEP_COL.values()) + 1;
