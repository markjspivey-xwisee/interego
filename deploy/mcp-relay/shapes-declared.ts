/**
 * Whether the document a publish named as its shapes graph WAS one — and what to do when it
 * was not.
 *
 * ── ★★ THE DEFECT: A CONFIRMATION THAT CONFIRMED SOMETHING ADJACENT ──────────
 *
 * Reported from outside the fleet, and re-measured here before being believed. Validating a
 * graph against a shapes graph that declares no shapes conforms — correctly, per SHACL §1.5,
 * because nothing is violated when nothing constrains. The defect was never the verdict. It
 * was that the answer could not be told apart from a real one. Measured on `@interego/core`'s
 * engine, one data graph (an `ieh:AgentTurn` missing its required `ieh:turnOutcome`) against
 * four documents:
 *
 *     docs/ns/harness-shapes.ttl   conforms=false  results=1   ← the real shapes
 *     docs/ns/harness.ttl          conforms=true   results=0   ← the ONTOLOGY, 0 shapes
 *     a descriptor document        conforms=true   results=0
 *     "# nothing\n"                conforms=true   results=0
 *
 * The last three are byte-identical to a clean pass. A caller who named the wrong document
 * was told `published: true` and had no way, anywhere in the response, to learn that their
 * contract had not run. A failure would have sent them back to look; this did not.
 *
 * ★ AND THE API'S OWN SHAPE STEERS CALLERS INTO IT. `publish_context` returns `descriptorUrl`
 * and `graphUrl`, and both HyperMarkdown projections — `note-view.ts` and the `/ns/` renderer
 * in `server.ts` — label the DESCRIPTOR "Signed descriptor (authority)" with
 * `type="text/turtle"`, while the graph is the plainly-named "Turtle" link beside it. The
 * URL that reads as authoritative, typed Turtle, and comes back first is precisely the one
 * that holds a six-facet descriptor and zero shapes. Naming it as `conforms_to_shapes` is the
 * obvious mistake, and before this module it was an undetectable one.
 *
 * ── ★★ WHY THE REFUSAL IS SPLIT BY SOURCE AND NOT APPLIED TO BOTH ────────────
 *
 * The gate runs shapes from two places, and they are not the same kind of claim.
 *
 * CALLER-SUPPLIED (`conforms_to_shapes` on the wire) is an instruction: "validate this
 * against these". A document that declares no shapes cannot satisfy it, the caller is present
 * and holds the fix, and a 422 costs them one corrected IRI. REFUSED.
 *
 * CONTAINER-DECLARED (`iep:conformsTo` / `dct:conformsTo` scraped off a pod's own
 * `.well-known/container-shape` or manifest) is a PROFILE ASSERTION, and in this system that
 * routinely names something that is not a shapes graph at all. RE-MEASURED — the first
 * version of this sentence quoted 21, and that figure had never been run: with
 * `validateAgainstShape` over every `.ttl` in `docs/ns/`, reading `shapesDeclared`, it is
 * 23 of 33 — `abac`, `adl-tla-proficiency`, `alignment`, `amta`, `cg`, `cgh`, `code`, `cts`,
 * `demo`, `eu-ai-act`, `harness`, `hela`, `hypragent`, `hyprcat`, `interego`, `nist-rmf`,
 * `olke`, `passport`, `pgsl-lexicon`, `registry`, `sat`, `soc2`, `wks`. They are ontologies
 * and profiles, and every one is a plausible `dct:conformsTo` target. This repo's own
 * writer emits `<> dct:conformsTo <…/ns/iep#SignedAuthorship>` — a CLASS IRI. Refusing here
 * would 422 every publish to such a pod, and the repair is a pod write that the 422 has just
 * locked out: the same one-way lockout `packages/workspace-client/src/documents.ts` documents
 * for an unparseable workspace shape. NOT refused — reported, loudly, in the response.
 *
 * ── ★ WHY `applied === 0` IS NOT A REFUSAL ON EITHER SIDE ────────────────────
 *
 * "No shape selected a focus node" is the ORDINARY case, not a fault: a contract targeting
 * twenty classes, run against a graph carrying none of them, applies nothing and conforms.
 * Measured on the same turn record: `wsp-shapes.ttl` (20 shapes) applied 0,
 * `iep-shapes.ttl` (86 shapes) applied 0. Refusing that is an outage across the fleet, and
 * ALARMING on it every time is the same mistake one step quieter — a warning that fires on
 * nearly every publish stops being read, which puts the silence back with extra steps.
 *
 * So it is a REPORT, and only on the side where it is not ordinary: a CALLER-supplied shape
 * that applied nothing was named for THIS graph, in this call, and touched none of it. See
 * `summarizeConformance` for why that case had to be reported separately at all — the
 * zero-DECLARED check does not reach a document whose `owl:imports` bring shapes in, and
 * `runConformanceGate` merges those before validating.
 *
 * ★ "STRUCTURALLY CANNOT REACH IT" IS WHAT THIS USED TO SAY, AND IT WAS FALSE. The import
 * resolver followed only the first object of an object list, so the very document cited as
 * the example — `…/ns/harness` — arrived declaring ZERO and WAS refused. The sentence made
 * the outage look impossible, which is how it survived a review. It is now a claim about a
 * document that really does import shapes, not about anything structural: a caller-named
 * document with no imports and no shapes of its own is still refused, and should be.
 * A container's contract applying nothing stays in the per-shape numbers and raises no voice.
 *
 * ── WHY A MODULE ─────────────────────────────────────────────────────────────
 *
 * `server.ts` starts an HTTP listener on import, so a decision written there cannot be
 * executed by any unit test, and a live run exercises the honest path and nothing else — the
 * same reason `shape-body.ts`, `supersession-frontier.ts` and `authorship-content-binding.ts`
 * were extracted. "Which caller gets refused" is exactly the decision that must be executable.
 */

/**
 * Every IRI object of `predicate` in a Turtle document — INCLUDING the ones after a comma.
 *
 * ── ★★ THE DEFECT: A PARSER THAT ANSWERED A NARROWER QUESTION THAN IT WAS ASKED ──
 *
 * `runConformanceGate` resolved `owl:imports` with `/owl:imports\s+<([^>]+)>/g`. A GLOBAL
 * regex reads as "collect every import"; what it actually collects is ONE object per
 * OCCURRENCE OF THE PREDICATE, and Turtle writes a repeated predicate as an object LIST:
 *
 *     owl:imports <http://www.w3.org/ns/prov-o> ,
 *                 <…/ns/pgsl#> ,
 *                 <…/ns/iep#> ;
 *
 * Everything after the first comma was dropped in silence. `docs/ns/harness.ttl:66` is
 * written exactly that way — and so are ten of its siblings (alignment, code, cts,
 * hypragent, hyprcat, interego, passport, registry, sat, wks) — so a caller naming
 * `…/ns/harness` as its shapes graph merged prov-o ALONE, which is `http:`, which the
 * egress guard refuses on scheme, which is non-fatal. The merged body was harness.ttl by
 * itself, declaring ZERO shapes, and the zero-declared refusal below fired on it.
 *
 * MEASURED, driven against the real `server.ts` with a fixture pod serving harness.ttl
 * byte for byte (the imports left pointing at the live github.io IRIs):
 *
 *     before  422 iep:shapeDeclaresNoShapes, zero pod writes
 *     after   published: true, conformance.unenforced why='targets-nothing-here',
 *             declared=41, applied=0
 *
 * `packages/workspace-client/src/turnrecord.ts:177` and the deployed
 * `applications/shared-workspace` channel artifact both name that IRI, so the refusal was
 * an outage for our own writers on the next deploy of this sha.
 *
 * ★ AND THE SAME REGEX SHAPE WAS THE CONTAINER SCAN. `fetchContainerShapes` read
 * `iep:conformsTo` / `dct:conformsTo` / `iep:declares-shape` the same way, so a pod
 * declaring three container shapes in one object list had two of them never fetched and
 * never run, while the response still said the gate had passed. That is this module's own
 * defect class one layer earlier — an answer to a question adjacent to the one asked —
 * which is why the repair is one scanner both callers share rather than two regexes.
 *
 * ── WHAT THIS PARSES, AND WHAT IT DELIBERATELY DOES NOT ──────────────────────
 *
 * A scanner, not an RDF parser, with the bound stated rather than implied:
 *
 *   · comments and string literals are SKIPPED, so `# owl:imports <http://elsewhere>` in a
 *     comment is no longer a fetch target — the old regex followed it, and every target
 *     here becomes a network request the relay makes;
 *   · the predicate must stand as its own token, so `iep:conformsToShape` is not
 *     `iep:conformsTo` and `owl:importsFrom` is not `owl:imports`;
 *   · only `<IRI>` objects are collected, and the list STOPS at the first object that is
 *     not one. Guessing what a prefixed name or a literal denotes is how a parser starts
 *     inventing IRIs, and an invented IRI here is an invented fetch.
 *
 * It does NOT resolve prefixes: a document spelling the predicate as
 * `<http://www.w3.org/2002/07/owl#imports>`, or binding `owl:` elsewhere, is not followed.
 * No document in this repo does either. Saying so is the point — claiming coverage nobody
 * measured is the debt this round is paying down.
 */
export function iriObjectsOf(turtle: string, predicate: string): string[] {
  const out: string[] = [];
  const n = turtle.length;
  let i = 0;
  while (i < n) {
    const ch = turtle[i]!;
    if (ch === '#') { i = endOfLine(turtle, i); continue; }
    if (ch === '"' || ch === "'") { i = endOfLiteral(turtle, i); continue; }
    // Subject and object IRIs are skipped wholesale so a `#` inside one — every term IRI
    // in this repo carries one — is never mistaken for the start of a comment.
    if (ch === '<') { i = endOfIriRef(turtle, i); continue; }
    if (turtle.startsWith(predicate, i)
      && !isNameChar(turtle[i - 1]) && !isNameChar(turtle[i + predicate.length])) {
      i = collectObjectList(turtle, i + predicate.length, out);
      continue;
    }
    i += 1;
  }
  return out;
}

/**
 * Characters that can continue a Turtle prefixed name.
 *
 * ★ THE LEADING HALF OF THE BOUNDARY IS THE LOAD-BEARING ONE, and it is worth saying which,
 * because the obvious answer is wrong. Without it, a document binding a prefix that ENDS in
 * our token — `myowl:imports <x> .` — is read as `owl:imports <x>` and the relay fetches `x`.
 * That is a caller-influenced document choosing a target for the relay's own egress.
 *
 * ★ THE TRAILING HALF IS DEFENCE IN DEPTH AND CANNOT CURRENTLY BE MADE TO FAIL. The reflex
 * example — `iep:conformsToShape <urn:iep:shape:…>`, which descriptors in this repo really do
 * carry — is already refused one function down: `collectObjectList` starts a list only on
 * `<`, and after a longer prefixed name the next character is part of that name, never `<`.
 * It is kept because that is a property of the OTHER function, and a scanner that depends on
 * a neighbour staying strict should say so out loud rather than look independently safe.
 */
const NAME_CHAR = /[A-Za-z0-9_:.%-]/;
function isNameChar(c: string | undefined): boolean {
  return c !== undefined && NAME_CHAR.test(c);
}

function endOfLine(s: string, i: number): number {
  const nl = s.indexOf('\n', i);
  return nl < 0 ? s.length : nl + 1;
}

function endOfIriRef(s: string, i: number): number {
  const close = s.indexOf('>', i + 1);
  return close < 0 ? s.length : close + 1;
}

function endOfLiteral(s: string, i: number): number {
  const q = s[i]!;
  const long = q + q + q;
  if (s.startsWith(long, i)) {
    const end = s.indexOf(long, i + 3);
    return end < 0 ? s.length : end + 3;
  }
  let j = i + 1;
  while (j < s.length) {
    const c = s[j]!;
    if (c === '\\') { j += 2; continue; }
    if (c === q) return j + 1;
    // ★ A SHORT LITERAL CANNOT SPAN A LINE, and bailing at the newline is the difference
    // between one stray apostrophe costing one import and costing every import below it.
    if (c === '\n') return j;
    j += 1;
  }
  return s.length;
}

/** Whitespace and comments between two objects — the only things allowed to sit there. */
function skipInsignificant(s: string, i: number): number {
  let j = i;
  for (;;) {
    while (j < s.length && /\s/.test(s[j]!)) j += 1;
    if (s[j] === '#') { j = endOfLine(s, j); continue; }
    return j;
  }
}

/**
 * `<a> , <b> , <c>` — returns the index just past the last object it accepted.
 *
 * ★ A LITERAL IN THE MIDDLE IS STEPPED OVER, NOT TREATED AS THE END. `dct:conformsTo "a
 * profile name" , <the-shapes-graph>` is legal and not far-fetched, and stopping at the
 * literal would drop the IRI after it — which is the same silent under-read as reading only
 * the first object, arrived at from the other side. A literal has a delimiter this scanner
 * can find, so skipping it costs nothing and invents nothing.
 *
 * ★ ANYTHING ELSE — a prefixed name, a blank node, a number — STOPS the list. Those have no
 * delimiter short of real parsing, and the failure mode of guessing is an IRI the relay then
 * FETCHES. Under-reading a form nothing in this repo uses is the safer of the two mistakes,
 * and it is stated here rather than left to be discovered.
 */
function collectObjectList(s: string, from: number, out: string[]): number {
  let i = from;
  for (;;) {
    i = skipInsignificant(s, i);
    if (s[i] === '"' || s[i] === "'") {
      i = skipInsignificant(s, endOfLiteral(s, i));
      if (s[i] !== ',') return i;
      i += 1;
      continue;
    }
    if (s[i] !== '<') return i;
    const close = s.indexOf('>', i + 1);
    if (close < 0) return s.length;
    out.push(s.slice(i + 1, close));
    i = close + 1;
    i = skipInsignificant(s, i);
    if (s[i] !== ',') return i;
    i += 1;
  }
}

/**
 * Where the gate learned about a shape.
 *
 * ★ LOAD-BEARING, NOT BOOKKEEPING. It is the whole of the refuse/report split above: the same
 * zero-shape document is a caller error on one side and a pod-owner's profile assertion on
 * the other, and collapsing the two either 422-locks pods or lets the caller's mistake through.
 */
export type ShapeSource = 'caller' | 'container';

/** What one resolved shape actually constrained, alongside where it came from. */
export interface ShapeCoverage {
  readonly shapeIri: string;
  readonly source: ShapeSource;
  /** `ShaclReport.shapesDeclared` — shapes compiled from the document, before matching. */
  readonly declared: number;
  /** `ShaclReport.shapesApplied` — how many of them selected a focus node in THIS graph. */
  readonly applied: number;
}

/** One SHACL-style result body: the machine-readable constraint plus its sentence. */
export interface EmptyShapesViolation {
  readonly constraintComponent: string;
  readonly message: string;
}

/**
 * Namespace for gate-emitted constraint components — the same one `shape-body.ts` uses, and
 * re-stated rather than imported for the reason recorded on `PUBLIC_SHAPE_NS` there: it must
 * end at the `#` so the local name is LITERAL in the source, or `tools/ontology-lint.mjs`
 * cannot see the term and CI stops checking that it is declared.
 *
 * Imported from `shape-body.js` would have been fine for correctness and wrong for the lint,
 * which scans template emissions over a namespace constant per file.
 */
const PUBLIC_SHAPE_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

/**
 * Does this shape's zero declaration REFUSE the publish?
 *
 * ★ THERE IS DELIBERATELY NO OPT-IN ARGUMENT. The obvious next knob is
 * `allow_empty_shapes: true`, and it would be a switch that turns the gate off, reachable by
 * the same caller whose mis-declaration it exists to catch — while doing nothing for the case
 * that genuinely needs relief, which is the container-declared one, where the caller is not
 * the declarer and has no knob to set. The source split gives that relief structurally, so
 * the knob would buy nothing and cost the guarantee.
 *
 * A first publish that names no shapes at all never reaches here: `runConformanceGate`
 * returns early on an empty shape list, so bootstrap — publishing the shape contract itself
 * before anything can cite it — is untouched.
 */
export function refusesEmptyShapesGraph(c: ShapeCoverage): boolean {
  return c.source === 'caller' && c.declared === 0;
}

/**
 * The 422 body for a caller-named document that is not a shapes graph.
 *
 * ★ IT NAMES THE LIKELY CAUSE, because the cause is nearly always one of two documents the
 * API handed the caller a moment earlier. A refusal that says only "no shapes" sends someone
 * to check whether their shapes file is broken; this one sends them to check WHICH URL they
 * passed, which is where the mistake actually is.
 *
 * ★ AND THE ONLY ABSOLUTE URL IN IT IS THE CALLER'S OWN INPUT. This sentence used to read
 * "carries the caller's own input and nothing else — no host, no address, no pod path", which
 * is false as written and was found false by RUNNING it: a shape IRI is a host and a pod path,
 * so the emitted message really reads `Declared shape http://127.0.0.1:56375/lens-shapes/
 * descriptor was fetched and parsed, but…`. The honest claim is the narrower one — the message
 * adds no URL the caller did not send: not the relay's CSS origin, not the pod's internal host,
 * and not the URL the fetch LANDED at after `rel=alternate` following, which is the one that
 * would actually leak something. §3 of `tests/shapes-declared-not-silent.test.ts` asserts
 * exactly that, so the sentence and the assertion are now the same claim rather than two
 * claims that happened to sit next to each other.
 */
export function emptyShapesGraphViolation(shapeIri: string): EmptyShapesViolation {
  return {
    constraintComponent: `${PUBLIC_SHAPE_NS}shapeDeclaresNoShapes`,
    message: `Declared shape ${shapeIri} was fetched and parsed, but it declares NO SHACL `
      + 'shapes, so validating against it would have conformed without checking anything. '
      + 'The publish was refused rather than reporting a pass nothing was tested for. This is '
      + 'usually an ontology IRI, a profile IRI, or a `descriptorUrl` named where a shapes '
      + 'graph belongs — a descriptor holds facets, not shapes, and an ontology often keeps '
      + 'its shapes in a separate `-shapes` document.',
  };
}

/**
 * WHY a shape constrained nothing. Two different facts, two different repairs — and reporting
 * one word for both would be the defect this module exists to close, moved into its own
 * remedy: a caller reading "unenforced" without knowing which would learn no more than they
 * did from silence.
 *
 *   declares-no-shapes  the document is not a shapes graph at all. Fix the IRI.
 *   targets-nothing-here  it IS a shapes graph, and none of its shapes selected a node in
 *                         this graph. Either the right shapes file for a different document,
 *                         or the wrong one for this document.
 */
export type UnenforcedReason = 'declares-no-shapes' | 'targets-nothing-here';

/** One shape that ran and constrained nothing, with the reason it did not. */
export interface UnenforcedShape extends ShapeCoverage {
  readonly why: UnenforcedReason;
}

/** What the publish response says about what the gate actually enforced. */
export interface ConformanceSummary {
  /** Every shape the gate resolved and ran, with what each one constrained. */
  readonly validated: readonly ShapeCoverage[];
  /**
   * Shapes that constrained NOTHING — present only when there is at least one.
   *
   * ★ AN ARRAY THAT IS ABSENT WHEN EMPTY, NOT A COUNT THAT IS ALWAYS ZERO. A number the
   * caller must remember to compare against zero is the silence again, one field further in;
   * a key that appears only when something is wrong is one a reader meets by accident.
   */
  readonly unenforced?: readonly UnenforcedShape[];
}

/**
 * Assemble the response's conformance block.
 *
 * ── ★★ WHY `targets-nothing-here` IS REPORTED FOR THE CALLER AND NOT THE CONTAINER ──
 *
 * `applied === 0` is the ORDINARY outcome for a container-declared contract: a pod naming a
 * twenty-shape profile sees it apply to a fraction of what it stores, and flagging that on
 * every publish is a warning that fires constantly and therefore stops being read — the
 * silence again, with extra steps.
 *
 * For a CALLER-supplied shape it is not ordinary. The caller named that document for THIS
 * graph, in this call, and it touched nothing. And it is the case a zero-DECLARED check
 * cannot reach, which is not hypothetical — live in this repo:
 * `packages/workspace-client/src/turnrecord.ts:177` passes `.../ns/harness`, the ONTOLOGY,
 * whose own shapes live at `.../ns/harness-shapes`.
 *
 * ★★ DRIVEN, NOT COMPUTED — because the previous version of this paragraph was arithmetic
 * (33 shapes in iep.ttl + 8 in pgsl.ttl = 41) presented as a measurement, and the relay's
 * actual answer at the time was a 422. The numbers below come from `POST /tool/publish_context`
 * against this repo's `server.ts` running as its own process, publishing turnrecord.ts's own
 * document and naming the same IRI it names — the real one, dereferenced live, not a fixture:
 *
 *     validated:  [{ shapeIri: '…/ns/harness', source: 'caller', declared: 41, applied: 0 }]
 *     unenforced: [{ …, why: 'targets-nothing-here' }]
 *
 * The relay log shows the shape IRI and both of its imports arriving as HTML from GitHub Pages
 * and each being followed through its own `rel=alternate` to `harness.ttl`, `pgsl.ttl` and
 * `iep.ttl`; prov-o is `http:`, refused by the egress guard on scheme, and dropped as
 * non-fatal — which is why 41 and not more. `declared` is healthy; `applied` is zero; the
 * contract that file's own ★★ comment says is enforced has never run. Only this line says so.
 *
 * It is a REPORT and not a refusal because a caller legitimately reuses one shapes file across
 * several document kinds — a workspace names its 3-shape contract on grants, acceptances,
 * entries and tombstones alike, and the ones it does not target must still publish. Refusing
 * here would be an outage; saying so cannot be.
 *
 * Returns undefined when no shape ran at all, so a publish that declared nothing does not grow
 * an empty object claiming it was gated — the absence IS the honest answer there, and it
 * matches `runConformanceGate`'s own early return.
 */
export function summarizeConformance(
  coverage: readonly ShapeCoverage[],
): ConformanceSummary | undefined {
  if (coverage.length === 0) return undefined;
  const unenforced: UnenforcedShape[] = [];
  for (const c of coverage) {
    if (c.declared === 0) unenforced.push({ ...c, why: 'declares-no-shapes' });
    else if (c.source === 'caller' && c.applied === 0) {
      unenforced.push({ ...c, why: 'targets-nothing-here' });
    }
  }
  return {
    validated: coverage,
    ...(unenforced.length > 0 ? { unenforced } : {}),
  };
}
