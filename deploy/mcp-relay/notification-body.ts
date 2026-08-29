/**
 * Whether the notification the relay is about to WRITE satisfies the contract the relay
 * PUBLISHES — and what to do when it does not.
 *
 * ── ★★ THE DEFECT: A SCHEMA THAT PERMITTED THE MESSAGE WITH NOTHING IN IT ────
 *
 * Reported from outside the fleet. An external agent sent this maintainer findings summarised
 * `P7 and P8 re-sent with FULL DETAIL`. What arrived carried `as:summary` twice and NO
 * `as:content` at all, and `notify_agent` answered `delivered: true`. It was schema-valid,
 * because the tool declares
 *
 *     content: { type: 'string', description: 'Optional longer message body.' }
 *     required: ['to', 'summary']
 *
 * so an absent body is a PERMITTED INPUT, not a lost one. `buildNotification` also spreads
 * `content` on TRUTHINESS (`...(input.content ? { content } : {})`), so `content: ""` produces
 * a document byte-identical to one that never had a body: a caller who sends an empty string
 * and a caller who sends nothing are told the same thing.
 *
 * ── ★★ WHY A PUBLISHED SHAPE AND NOT AN `if` IN server.ts ────────────────────
 *
 * This project's own principle audit named the pattern: it "reliably publishes its VOCABULARY
 * and reliably keeps its RULES in TypeScript — then writes a note describing the rule". A rule
 * described in a comment is a rule that will drift. So the rule is `iep:NotificationBodyShape`
 * in `docs/ns/iep.ttl`, the relay READS that document to enforce it, and this module is the
 * wiring — not the rule. Editing the pattern in the Turtle changes what the relay refuses;
 * editing the prose here changes nothing, which is the point.
 *
 * ── ★★ WHAT THE FIRST ATTEMPT AT THIS GOT WRONG, EACH FIXED STRUCTURALLY ─────
 *
 * A previous version of this gate was written, driven, and REFUTED (see the branch
 * `wip/dogfood-messaging-refuted`). Four of its defects are closed here by construction rather
 * than by care, and the fifth was found while re-measuring it:
 *
 *  1. ★ IT ASKED "WHICH RESULT IS MINE?" BY MATCHING `sourceShape === NOTIFICATION_BODY_SHAPE`.
 *     Measured against this engine: a violation raised by an ordinary `sh:property` reports
 *     `sourceShape` as the PROPERTY shape — a blank node, `_:_anon0` — not the node shape that
 *     carries it. So the moment the published shape grew a `sh:property`, every violation it
 *     raised went invisible and the gate silently reported a pass. Closed by
 *     {@link isolateShapeClosure}: the gate validates against a shapes graph containing ONLY
 *     this shape and what it reaches, so "mine" is not a test that can be wrong — there is
 *     nothing else in the graph to confuse it with.
 *
 *  2. ★ IT PARSED THE WHOLE 209,157-CHARACTER ONTOLOGY ON THE EVENT LOOP, PER NOTIFICATION.
 *     Re-measured on this machine, median of 9–15 runs, against `docs/ns/iep.ttl` as the
 *     shapes graph: 13 ms for an empty body, 12–18 ms up to 64 KB, 99 ms at 1 MB, 343 ms at
 *     3.9 MB — against `express.json`'s 4 mb limit and a 1.0-CPU service floor.
 *
 *     ★ ISOLATION REMOVES THE SHAPES HALF AND ONLY THE SHAPES HALF, WHICH IS A SMALLER CLAIM
 *     THAN THE ONE THAT STOOD HERE. The isolated graph is 28 triples, and against it the same
 *     runs come back at 0.38 ms empty and 0.5–1.3 ms up to 64 KB — a flat ~12–17 ms saved per
 *     call. At 1 MB it is 80 ms and at 3.9 MB 383 ms, no better than the whole ontology,
 *     because past that size the cost is parsing the DATA. So isolation is what makes an
 *     ORDINARY notification cheap, and {@link MAX_GATED_BODY_CHARS} is the only thing that
 *     bounds a large one.
 *
 *  3. ★ `about: 'no'` WAS ACCEPTED WHERE AN IRI IS REQUIRED — the projection falls back to an
 *     escaped literal for a value that cannot be an IRI, and `sh:minCount 1` was satisfied
 *     either way. Closed in the published shape with `sh:nodeKind sh:IRI`, measured below.
 *
 *  4. ★★ AND ONE THE REFUTATION DID NOT NAME, FOUND BY RE-MEASURING: the old shape used
 *     `sh:targetClass as:Note`, and `notify_agent` lets a caller choose `type`. With
 *     `type: 'Note'` the ACTIVITY is an `as:Note` too — and the body lives on its `as:object`,
 *     not on the activity — so a completely correct message carrying a real `content` was
 *     REFUSED. Driven against the branch's own published shape: `type: 'Note'` + a summary
 *     matching the pattern + `content` on the object ⇒ VIOLATES, focus node the activity.
 *     Closed by targeting `iep:NotificationBody`, a class this projection asserts on exactly
 *     one node — the notification's `as:object` — so the rule can only ever judge the body.
 *
 * ── ★ REFUSE OR REPORT, SPLIT BY WHO AUTHORED THE THING BEING REFUSED ────────
 *
 * The same split `shapes-declared.ts` draws, for the same reason.
 *
 * `notify_agent` is REFUSED. Every field of that notification came off the wire from a caller
 * who is present, holds the fix, and pays one corrected argument for it. The refusal happens
 * after `buildNotification` and before `reachFanOut`, so nothing is half-delivered: no LDN
 * write, no Discord webhook, no SMS.
 *
 * `POST /agents/:localPart/inbox` — inbound ActivityPub — is REPORTED. That document is a
 * foreign server's, authored against the AS2 specification and not against this substrate's
 * profile, and its summary is partly OURS: the route synthesises `${act.type} via ActivityPub`
 * when the remote omits one, so a refusal there could fire on the relay's own words.
 *
 * ── ★ WHY THIS IS A MODULE ──────────────────────────────────────────────────
 *
 * `server.ts` starts an HTTP listener on import, so a decision written there cannot be executed
 * by any unit test, and a live run exercises the honest path and nothing else — the same reason
 * `shape-body.ts`, `shapes-declared.ts` and `supersession-frontier.ts` were extracted. "Which
 * caller gets refused" is exactly the decision that must be executable.
 */

import { buildNotification } from './agent-mesh.js';
import {
  AS,
  escapeTurtleLiteral,
  parseTrig,
  turtleIriRef,
  type ParsedDocument,
  type ParsedSubject,
  type ParsedTerm,
} from '@interego/core';

/**
 * Namespace for the published shape — re-stated rather than imported, for the reason recorded
 * on `PUBLIC_SHAPE_NS` in `shape-body.ts` and `shapes-declared.ts`: it must end at the `#` so
 * the local name is LITERAL in this source, or `tools/ontology-lint.mjs` cannot see the term
 * and CI stops checking that `docs/ns/iep.ttl` declares it. Importing `IEP` from
 * `@interego/core` would be correct for behaviour and wrong for the lint.
 */
const PUBLIC_SHAPE_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';

/**
 * The class this projection asserts on the one node the rule judges: the notification's
 * `as:object`, which is the message body.
 *
 * ★★ THE TARGET IS POSITIONAL, NOT TYPE-BASED, AND THAT IS DEFECT 4 ABOVE CLOSED BY
 * CONSTRUCTION. `sh:targetClass as:Note` selected any `as:Note` in the graph, which on a
 * `notify_agent({ type: 'Note' })` call is the ACTIVITY as well as its object — a node that
 * never carries the body and was refused for not carrying it. Only this file marks a node with
 * this class, and it marks exactly the `as:object` of the activity it was handed, so the shape
 * cannot select anything else. It also means a THIRD party's data graph validated against
 * `docs/ns/iep.ttl` for some other reason is untouched by this rule unless it claims the class.
 */
export const NOTIFICATION_BODY_CLASS = `${PUBLIC_SHAPE_NS}NotificationBody`;

/** The shape a notification body is validated against, dereferenceable as written. */
export const NOTIFICATION_BODY_SHAPE = `${PUBLIC_SHAPE_NS}NotificationBodyShape`;

/** The document that declares it — what a refused caller should go and read. */
export const NOTIFICATION_SHAPE_DOCUMENT = 'https://markjspivey-xwisee.github.io/interego/ns/iep';

/**
 * Where the relay finds that document at runtime, resolved against the DIRECTORY OF THE
 * RUNNING MODULE — production layout first, dev fallback last.
 *
 * ★★ THE `..` IN THE FIRST ENTRY IS THE WHOLE THING, AND GETTING IT WRONG WOULD HAVE BEEN
 * SILENT. `deploy/Dockerfile.relay` compiles to `/app/dist` and runs `dist/server.js`, so the
 * module's own directory in production is `/app/dist` — while `COPY --from=build /relay-docs
 * ./relay-docs` under `WORKDIR /app` puts the document at `/app/relay-docs/ns/iep.ttl`, one
 * level UP.
 *
 * ★ AND THE LAST ENTRY IS A DEV FALLBACK THAT MUST NEVER BE THE ONLY ONE THAT RESOLVES. Repo
 * data found by walking UP from the source tree is green on a developer's machine and absent in
 * every container, and the failure here would be quiet: the gate would simply stop enforcing.
 * `tests/notification-body-shape.test.ts` asserts that `Dockerfile.relay` carries a per-file
 * COPY whose destination is exactly what the FIRST entry resolves to from `/app/dist` — so the
 * tarball case fails CI rather than production.
 */
export const NOTIFICATION_SHAPE_CANDIDATES: readonly (readonly string[])[] = [
  ['..', 'relay-docs', 'ns', 'iep.ttl'],
  ['relay-docs', 'ns', 'iep.ttl'],
  ['..', '..', 'docs', 'ns', 'iep.ttl'],
];

/**
 * The largest SLICE of one notification this gate will PROJECT AND VALIDATE, counted in
 * characters of the text the projection would emit.
 *
 * ★★ A BOUND BEFORE A PARSE, BECAUSE THE PARSE IS THE COST. Re-measured on this machine,
 * median of 9–15 runs, against the ISOLATED shapes graph — which is what actually runs:
 * 0.38 ms for an empty body, 0.48 ms at 8 KB, 1.3 ms at 64 KB, 14 ms at 256 KB, 80 ms at 1 MB,
 * 383 ms at 3.9 MB. `express.json` accepts 4 mb and the relay runs at a 1.0-CPU floor, so an
 * unbounded synchronous SHACL run over caller-supplied text is a denial-of-service surface —
 * and `POST /agents/:localPart/inbox` reaches this gate from OFF-FLEET wherever
 * `RELAY_FEDERATION_ACCEPT_UNSIGNED=1` is set, which is the deployment where it matters most.
 * (Without it that route answers 401 before the gate is reached at all.)
 *
 * 64 Ki characters is ~300x anything this repo’s own callers write.
 * Censused with the rest of them in `tests/notification-body-shape.test.ts` §2: the workspace
 * invitation Offer sends the longest `content` in the tree — 147 fixed characters plus one grant
 * IRI — and every other caller sends none at all. The bound holds the worst case at 1.3 ms.
 *
 * ★★ AND BEING OVER IT IS NOT A WAY PAST THE GATE. THAT CLAIM HAS BEEN MADE HERE ONCE BEFORE
 * AND WAS FALSE OF THE SHIPPED CODE, SO IT IS SPELLED OUT AS A MEASUREMENT. The FIRST version of
 * the bound counted ALL of a notification's text, so an empty body plus 66,000 characters in
 * `in_reply_to` answered `enforced: false`. The SECOND dropped the ACTIVITY-level fields and
 * kept the `object` subtree whole — and `buildNotification` puts `content`, `iep:about` and
 * `inReplyTo` on the OBJECT, so the same pad one field along still walked through. Driven over
 * the wire against a booted relay, signed `POST /tool/notify_agent`, claiming summary and no
 * body: `in_reply_to`, `about`, `type`, a padded `summary` and a whitespace `content` were FIVE
 * separate ways to `bodyShape.enforced: false`.
 *
 * What is bounded now is what is PARSED, in three steps, and the emptiness decision survives all
 * three:
 *
 *   1. Under the bound: the whole notification is projected and validated, as before.
 *   2. Over it: {@link reduceToConstrainedBody} keeps the `as:object` the shape targets and, on
 *      it, ONLY the keys the published shape names through `sh:path` — read off the isolated
 *      shape by {@link shapeReach}, not listed in this file. Everything else is dropped and
 *      returned in {@link Projection.blindTo}. That is size-independent: `inReplyTo`, both
 *      `type`s and every activity field go however long they are.
 *   3. Still over it: {@link boundLongValues} shortens each remaining value to a window that
 *      PROVABLY gives the shape the same answer — same match/non-match against every published
 *      `sh:pattern`, same verdict from `turtleIriRef` where `sh:nodeKind` reads it — and refuses
 *      rather than guesses when it cannot show that.
 *
 * ★★ THE RESIDUAL, STATED EXACTLY RATHER THAN WAVED AT, BECAUSE THE LAST TWO SENTENCES IN THIS
 * POSITION WERE BOTH FALSE. `unenforced` is now reachable in exactly FOUR places, and only
 * these four:
 *
 *   (a) the published shape grew a constraint from {@link LEXICALLY_SENSITIVE}, so no
 *       shortening of an over-long value can be shown to give it the same answer;
 *   (b) a published pattern's own match inside the value is longer than
 *       {@link MAX_GATED_VALUE_CHARS}, so the witness will not fit in the window;
 *   (c) the spliced window changes a pattern verdict or an IRI verdict — checked per call,
 *       never assumed;
 *   (d) the body carries so many separate values on the shape's own properties that they are
 *       over the bound even shortened, and dropping any would change what its counting
 *       constraints count.
 *
 * (a) and (b) are properties of the DOCUMENT, not of any message: they cannot be reached by
 * sending anything. §12 drives both by growing the published shape, and in both the gate
 * switches itself OFF at load rather than delivering the case it exists to catch. (d) needs
 * more than one value on `as:summary`, `as:content` or `iep:about`, and `buildNotification`
 * puts exactly one on each — §12 drives it by assembling a document no writer here can emit.
 *
 * (c) IS reachable in principle, and the direction it can err in is the one that matters. A
 * splice can only ever ADD a match, never remove one: the window is built AROUND the first
 * match of every pattern, so a witness the value has, the window has. So (c) fires only when a
 * value that did NOT match starts matching — which for `as:summary` means a summary that does
 * not claim to carry detail, i.e. a message that is not the defect. A claiming summary keeps
 * its claim through the reduction and is DECIDED. Against the shape as published it does not
 * fire at all: the two patterns are the claim alternation and `\S`, and `\S`'s window merges
 * into the head window unless the value opens with more than 545 whitespace characters — in
 * which case the head is whitespace and can contribute nothing to the alternation. §12 drives
 * a claiming summary padded at every position around the phrase and requires all of them
 * refused.
 *
 * ★ AND WHEN IT DOES REFUSE, THE ANSWER IS `unenforced` — NEVER A REFUSAL AND NEVER A PASS.
 * Refusing would break legitimate senders for the relay's own inability to look; reporting a
 * pass would be the exact lie `shapes-declared.ts` was written to stop. The caller is told the
 * check did not run, and told which of the four cases it was.
 */
export const MAX_GATED_BODY_CHARS = 65_536;

/**
 * How deep into a notification the projection walks, and the depth the size bound counts to.
 *
 * ★★ THE TWO HAVE TO BE THE SAME NUMBER, OR THE BOUND IS NOT A BOUND. `notificationTextSize`
 * already stopped at depth 8 while `projectNotification` recursed with no limit at all, so any
 * text nested deeper than 8 was projected and parsed WITHOUT being counted — the same class of
 * hole as the one above, one level along. Both read this constant now, and a node the
 * projection will not descend into is reported in {@link Projection.blindTo} rather than
 * dropped in silence.
 *
 * `buildNotification` — the writer behind both callers in this repo — nests the body exactly
 * one level under the activity, so nothing legitimate is anywhere near this.
 */
const MAX_PROJECTION_DEPTH = 8;

// ── Isolating the published shape ────────────────────────────────────────────

const SHACL_NS = 'http://www.w3.org/ns/shacl#';
const RDF_NS = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

/**
 * The predicates whose object is another SHAPE, so the closure has to follow them even when
 * the object is a named IRI rather than a blank node.
 *
 * ★ BLANK NODES ARE FOLLOWED UNCONDITIONALLY — a blank node is only ever reachable from the
 * subject that mentions it, so following one can never drag in an unrelated part of the
 * ontology. NAMED nodes are followed only through this list, which is what keeps the closure
 * from walking `sh:targetClass as:Note` into the ActivityStreams half of the document.
 *
 * ★★ `rdf:first` AND `rdf:rest` ARE HERE FOR A SPELLING THE PUBLISHED SHAPE DOES NOT CURRENTLY
 * USE, AND A MUTANT PROVED IT. Deleting BOTH from this set changes nothing about the shipped
 * closure — byte-identical isolated graph, whole suite still green — because Turtle's `( … )`
 * sugar builds the `sh:or` list out of BLANK NODES, and the unconditional bnode rule above
 * already follows every one of them.
 *
 * They are not dead, though, and the difference is which part of a list is named. `rdf:first`
 * carries a MEMBER, and a member is very often a named shape: `sh:or ( iep:A iep:B )` reaches
 * `iep:A` through it and nothing else does. `rdf:rest` carries a CELL, which Turtle sugar always
 * makes a blank node — but nothing stops a document from writing the cells out with IRIs of
 * their own.
 *
 * Both are kept and both are DRIVEN, and the two failures are not the same failure — measured,
 * in `tests/notification-body-shape.test.ts` §14, which re-spells this shape's own `sh:or` with
 * named cells and named members. Without `rdf:first` no member resolves, and this engine treats
 * an unresolvable shape reference as vacuously satisfied, so the shape accepts EVERYTHING.
 * Without `rdf:rest` the closure stops after the first cell and the engine reads the shortened
 * list without complaint, so the shape enforces FEWER alternatives than the document published
 * — quieter, and the one that would refuse legitimate traffic. Deleting either turns §14 red.
 */
const SHAPE_VALUED_PREDICATES: ReadonlySet<string> = new Set([
  `${SHACL_NS}property`,
  `${SHACL_NS}node`,
  `${SHACL_NS}not`,
  `${SHACL_NS}or`,
  `${SHACL_NS}and`,
  `${SHACL_NS}xone`,
  `${SHACL_NS}qualifiedValueShape`,
  `${RDF_NS}first`,
  `${RDF_NS}rest`,
]);

/**
 * How many subjects the closure may visit before it gives up.
 *
 * A shape that reached hundreds of subjects would mean the follow rule above had walked out of
 * the shape and into the ontology, and the honest response to that is to stop and say the gate
 * is not enforcing — not to build a huge shapes graph and validate against it every message.
 * The real closure is 12 subjects, by isolateShapeClosure's own report; this is a 40x headroom.
 */
const MAX_CLOSURE_SUBJECTS = 512;

export interface Isolation {
  /** The shape and everything it reaches, as a standalone Turtle shapes graph. */
  readonly turtle: string;
  /** How many subjects it describes — reported so a caller can see the closure is not empty. */
  readonly subjects: number;
  /** How many triples it carries. */
  readonly triples: number;
}

/** A bnode label, or null when it is not one this file is willing to re-serialize. */
function bnodeTerm(id: string): string | null {
  // Conservative subset of BLANK_NODE_LABEL. The parser's own generated labels (`_anon0`) and
  // ordinary authored ones (`b1`) both pass; anything else is refused rather than guessed at,
  // for the reason `escape.ts` records about IRIs — a label that needs escaping has no escape.
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(id)) return null;
  return `_:${id}`;
}

/**
 * A parsed literal, back as Turtle, or null when re-serializing it would change it.
 *
 * ★★ REFUSES CONTROL CHARACTERS RATHER THAN ESCAPING THEM, AND THAT IS A MEASURED CHOICE.
 * `escapeTurtleLiteral` covers backslash, quote, newline, carriage return and tab and nothing
 * else, so a literal carrying, say, a form feed would be emitted raw into a quoted string.
 * `\uXXXX` was the obvious alternative and is not reached for here: this repo has already
 * shipped a generator that wrote a control character where its own escape belonged. A shape
 * literal has no business containing one, so an unexpected one makes the slice fail and the
 * gate report itself unenforced — loudly, at load, rather than quietly at validation time.
 */
function literalTerm(value: string, datatype?: string, language?: string): string | null {
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
    if (c < 0x20 || c === 0x7f) return null;
  }
  const body = `"${escapeTurtleLiteral(value)}"`;
  if (language !== undefined && language !== '') {
    if (!/^[A-Za-z]+(-[A-Za-z0-9]+)*$/.test(language)) return null;
    return `${body}@${language}`;
  }
  if (datatype !== undefined && datatype !== '') {
    const dt = turtleIriRef(datatype);
    if (!dt) return null;
    return `${body}^^${dt}`;
  }
  return body;
}

/** One object position, back as Turtle. `null` means "this file will not re-serialize that". */
function objectTerm(term: ParsedTerm): string | null {
  switch (term.kind) {
    case 'iri': return turtleIriRef(term.iri);
    case 'bnode': return bnodeTerm(term.id);
    case 'literal': return literalTerm(term.value, term.datatype, term.language);
    // An RDF 1.2 triple term inside a shape is not something this slice knows how to carry, and
    // dropping it would quietly weaken the rule. Refuse the whole slice instead.
    default: return null;
  }
}

/**
 * Cut ONE shape and everything it reaches out of a published ontology, as a standalone shapes
 * graph.
 *
 * ★★ THIS IS THE ANSWER TO "WHICH VIOLATION IS MINE?", AND IT IS AN ANSWER THAT CANNOT BE
 * WRONG THE WAY A TEST FOR IT CAN. The refuted version asked the report — `results.find(r =>
 * r.sourceShape === NOTIFICATION_BODY_SHAPE)` — which is a claim about how the engine labels
 * results, and that claim was FALSE for every constraint hung off an ordinary `sh:property`
 * (measured: `sourceShape` comes back as the property shape's blank node, `_:_anon0`). Validate
 * against a graph that contains one shape and only one shape, and the question does not arise:
 * every result in the report was raised by it.
 *
 * ★ IT ALSO MAKES THE PER-MESSAGE COST SMALL, FOR AN ORDINARY MESSAGE. `docs/ns/iep.ttl` is
 * 209,157 characters of Turtle as shipped and the engine reparses the shapes graph on every
 * call; the closure of this one shape is 28 triples in 7,210 characters, most of which is the
 * two published prose fields the refusal quotes. Measured, median of 9–15 runs: 13 ms per call against the whole ontology
 * against 0.4–1.3 ms against the slice, for any body up to 64 KB. Past ~256 KB of data the
 * saving disappears into the data parse — see {@link MAX_GATED_BODY_CHARS}, which is what
 * bounds that.
 *
 * ★ AND IT IS BOUNDED IN WHAT IT FOLLOWS. Named nodes are followed only through
 * {@link SHAPE_VALUED_PREDICATES}, so `sh:targetClass` cannot walk the closure into the rest of
 * the ontology, and the visit count is capped.
 *
 * Everything is written with absolute IRIs and no `@prefix` line, so no prefix table has to
 * survive the round trip.
 */
export function isolateShapeClosure(shapesTurtle: string, shapeIri: string): Isolation | { readonly error: string } {
  let doc: ParsedDocument;
  try {
    doc = parseTrig(shapesTurtle);
  } catch (err) {
    return { error: `the shape document is not parseable as Turtle: ${(err as Error).message}` };
  }

  // ★ ALL BLOCKS FOR A SUBJECT, NOT THE FIRST. Turtle lets the same subject be described in
  // several places, and the parser reports each block separately. Keying a Map by subject and
  // keeping one would silently drop constraints — a shape that quietly enforces less than it
  // says is the failure mode this whole file is paying down.
  const byIri = new Map<string, ParsedSubject[]>();
  const byBnode = new Map<string, ParsedSubject[]>();
  for (const s of doc.subjects) {
    const key = typeof s.subject === 'string' ? s.subject : s.subject.bnode;
    const table = typeof s.subject === 'string' ? byIri : byBnode;
    const bucket = table.get(key);
    if (bucket) bucket.push(s);
    else table.set(key, [s]);
  }

  if (!byIri.has(shapeIri)) {
    return { error: `${shapeIri} is not described by the document` };
  }

  const lines: string[] = [];
  const seenIri = new Set<string>();
  const seenBnode = new Set<string>();
  const queue: { readonly kind: 'iri' | 'bnode'; readonly key: string }[] = [{ kind: 'iri', key: shapeIri }];
  seenIri.add(shapeIri);
  let visited = 0;
  let triples = 0;

  while (queue.length > 0) {
    const next = queue.shift()!;
    if (++visited > MAX_CLOSURE_SUBJECTS) {
      return { error: `the closure of ${shapeIri} reaches more than ${MAX_CLOSURE_SUBJECTS} subjects, which means it is no longer a shape` };
    }
    const subjectTerm = next.kind === 'iri' ? turtleIriRef(next.key) : bnodeTerm(next.key);
    if (!subjectTerm) return { error: `the closure of ${shapeIri} reaches a subject this file cannot re-serialize: ${next.key}` };
    const blocks = (next.kind === 'iri' ? byIri : byBnode).get(next.key) ?? [];
    for (const block of blocks) {
      for (const [predicate, objects] of block.properties) {
        const p = turtleIriRef(predicate);
        if (!p) return { error: `the closure of ${shapeIri} carries a predicate this file cannot re-serialize: ${predicate}` };
        for (const object of objects) {
          const o = objectTerm(object);
          if (!o) return { error: `the closure of ${shapeIri} carries an object this file cannot re-serialize under ${predicate}` };
          lines.push(`${subjectTerm} ${p} ${o} .`);
          triples++;
          if (object.kind === 'bnode') {
            if (!seenBnode.has(object.id)) { seenBnode.add(object.id); queue.push({ kind: 'bnode', key: object.id }); }
          } else if (object.kind === 'iri' && SHAPE_VALUED_PREDICATES.has(predicate)) {
            if (!seenIri.has(object.iri) && byIri.has(object.iri)) { seenIri.add(object.iri); queue.push({ kind: 'iri', key: object.iri }); }
          }
        }
      }
    }
  }

  return { turtle: `${lines.join('\n')}\n`, subjects: visited, triples };
}

// ── Projection: the AS2 document as RDF ──────────────────────────────────────

/**
 * `<IRI>` for a value this module OWNS — a namespace constant, or a term name concatenated onto
 * one. Never for anything off the wire; that goes through `turtleIriRef` at the point of use,
 * where a `null` is a decision about a caller's value rather than a broken build.
 *
 * ★ EVERY IRI THIS FILE EMITS GOES THROUGH THE SUBSTRATE'S GUARD, INCLUDING THE ONES THAT
 * CANNOT FAIL. `escape.ts` records why escaping an IRI is the wrong tool — Turtle's IRIREF
 * production has no escape for `>`, so the only correct handling is refusal — and a file that
 * writes `<` + something + `>` by hand is the shape that defect takes, whatever the something
 * happens to be today. `tools/turtle-iri-ratchet.mjs` counts that spelling across production
 * source against a budget that never rises.
 *
 * Throws rather than returning null: a namespace constant that is not a usable IRI is a bug in
 * this file, not a caller's mistake. It surfaces at IMPORT, because the predicate table below
 * is built at module load — so the relay would fail to start rather than quietly emit a graph
 * with a predicate missing from it.
 */
function iriRef(iri: string): string {
  const ref = turtleIriRef(iri);
  if (!ref) throw new Error(`notification-body: ${iri} cannot be a Turtle IRI reference`);
  return ref;
}

/**
 * The keys `buildNotification` can emit, and the predicate each becomes under the
 * ActivityStreams 2.0 `@context` the document carries.
 *
 * ★ THIS IS A SERIALIZATION, NOT A RULE. It restates the compaction the AS2 context already
 * defines; no behaviour is decided here. What IS decided here is the bound, stated rather than
 * implied: a key absent from this table is not silently dropped, it is returned in
 * {@link Projection.blindTo} so a caller can say the gate did not see it.
 *
 * ★ AND `jsonld.toRDF` WAS THE OBVIOUS REUSE AND IS NOT AVAILABLE HERE. The `jsonld` package IS
 * a relay dependency, and `amep.ts` calls `installOfflineLoader()` at mount time, which assigns
 * `jsonld.documentLoader` on the shared module binding — process-wide, for every consumer — to
 * a loader that serves the vendored AMEP context and THROWS on every other URL.
 * `https://www.w3.org/ns/activitystreams` is every other URL. Expanding a notification through
 * that library would therefore throw inside the send path, in production only, after AMEP
 * mounts. A bounded projection of our own document is the honest alternative, and its bound is
 * reportable.
 */
const AS2_PREDICATES: Readonly<Record<string, { readonly iri: string; readonly term: string; readonly kind: 'iri' | 'literal' | 'node' }>> = {
  actor: { iri: `${AS}actor`, term: iriRef(`${AS}actor`), kind: 'iri' },
  to: { iri: `${AS}to`, term: iriRef(`${AS}to`), kind: 'iri' },
  published: { iri: `${AS}published`, term: iriRef(`${AS}published`), kind: 'literal' },
  summary: { iri: `${AS}summary`, term: iriRef(`${AS}summary`), kind: 'literal' },
  content: { iri: `${AS}content`, term: iriRef(`${AS}content`), kind: 'literal' },
  inReplyTo: { iri: `${AS}inReplyTo`, term: iriRef(`${AS}inReplyTo`), kind: 'iri' },
  object: { iri: `${AS}object`, term: iriRef(`${AS}object`), kind: 'node' },
  // The one term the notification carries from this substrate's own vocabulary. Spelled with
  // the namespace constant so ontology-lint can see it, and `about` is declared in iep.ttl.
  'iep:about': { iri: `${PUBLIC_SHAPE_NS}about`, term: iriRef(`${PUBLIC_SHAPE_NS}about`), kind: 'iri' },
};

/**
 * The reverse of the table above: which `buildNotification` key emits a given predicate.
 *
 * ★ THIS IS WHAT LETS THE REDUCTION BE DRIVEN BY THE PUBLISHED SHAPE RATHER THAN BY A LIST KEPT
 * HERE. {@link shapeReach} reads the `sh:path` values out of the isolated shape and this turns
 * them into the keys a notification carries, so "which fields does the rule actually look at"
 * is answered by the document. Add an `sh:path` to the published shape and the reduction starts
 * keeping that field; nothing in this file has to be edited to follow it.
 */
const KEY_FOR_PREDICATE: ReadonlyMap<string, string> = new Map(
  Object.entries(AS2_PREDICATES).map(([key, p]) => [p.iri, key]),
);

/** Keys that are structure rather than predicates: the context IS the mapping, `id` is the
 *  subject, `type` is `rdf:type`. Listed so they are not reported as blind spots. */
const STRUCTURAL_KEYS = new Set(['@context', 'id', 'type']);

const RDF_TYPE = `${RDF_NS}type`;

export interface Projection {
  /** The notification as Turtle, ready for a SHACL data graph. */
  readonly turtle: string;
  /**
   * Every key the projection did not know how to express, as `node.key`.
   *
   * ★ AN ARRAY, NOT A DROP. A field added to `buildNotification` and forgotten here would
   * otherwise become invisible to every shape — a gate that quietly stops covering what it
   * covered yesterday, which is the defect class this whole round is paying down. Reported, so
   * the answer says what it could not see.
   */
  readonly blindTo: readonly string[];
  /** How many nodes were marked {@link NOTIFICATION_BODY_CLASS} — the shape's whole target set. */
  readonly bodies: number;
}

/**
 * How much caller text this notification carries, stopping as soon as it passes `limit`.
 *
 * ★ COUNTED BEFORE ANYTHING IS BUILT, WHICH IS THE ONLY PLACE IT HELPS. `JSON.stringify` would
 * answer the same question by first materialising the 4 MB the bound exists to avoid.
 *
 * ★★ AND IT WALKS THE DOCUMENT THE WAY {@link projectNotification} WALKS IT — same key
 * iteration, same one-level array flattening, same depth increment, same
 * {@link MAX_PROJECTION_DEPTH} cut. That symmetry is the whole correctness argument, and it was
 * not there: this counted depth per VALUE (so a node's own strings were counted one level deeper
 * than the node, and an array added a level of its own) while the projector counted depth per
 * NODE. The two disagreed from the fourth level down, and every character in the gap was
 * projected and parsed without being counted — which is a bound with a hole under it.
 *
 * Where it is not symmetric it OVER-counts, never under: an array nested inside an array is
 * counted here and reported as a blind spot by the projector. Over-counting can only send a
 * message down the reduced-projection path, which still decides.
 */
export function notificationTextSize(notif: Record<string, unknown>, limit: number): number {
  let total = 0;
  const walk = (node: Record<string, unknown>, depth: number): void => {
    for (const [key, value] of Object.entries(node)) {
      if (key === '@context') continue;   // the relay's own constant, not caller text
      total += key.length;
      for (const one of Array.isArray(value) ? value : [value]) {
        if (typeof one === 'string') { total += one.length; continue; }
        if (one !== null && typeof one === 'object' && depth + 1 <= MAX_PROJECTION_DEPTH) {
          walk(one as Record<string, unknown>, depth + 1);
        }
      }
      if (total > limit) return;
    }
  };
  walk(notif, 0);
  return total;
}

/**
 * The notification cut down to the nodes and the fields the PUBLISHED SHAPE ACTUALLY LOOKS AT.
 *
 * ★★ THIS IS WHAT STOPS {@link MAX_GATED_BODY_CHARS} FROM BEING A WAY PAST THE GATE, AND THE
 * VERSION IT REPLACES CLOSED ONE FIFTH OF THE HOLE. That one dropped the ACTIVITY-level fields
 * and kept the whole `object` subtree — but `buildNotification` puts `content`, `iep:about` AND
 * `inReplyTo` on the OBJECT, not on the activity, so padding any of them survived the reduction
 * untouched and the gate still answered `unenforced`. Driven over the wire against a booted
 * relay, `POST /tool/notify_agent` with a claiming summary and no body: a 66,000-character
 * `in_reply_to`, `about`, `type`, `summary` or whitespace `content` ALL came back
 * `bodyShape.enforced: false`. Five fields, one hole.
 *
 * What is kept now is derived from the document rather than listed here: {@link shapeReach}
 * reads the `sh:path` IRIs out of the isolated shape, {@link KEY_FOR_PREDICATE} turns them into
 * notification keys, and everything else goes. On the shape as published that keeps exactly
 * `as:summary`, `as:content` and `iep:about` on the body — so `inReplyTo`, both `type`s, and
 * every activity-level field are gone regardless of how long they are.
 *
 * ★ THE TARGET SUBTREE IS INTACT BY CONSTRUCTION. The shape targets
 * {@link NOTIFICATION_BODY_CLASS}, which {@link projectNotification} asserts on the activity's
 * `as:object` and on nothing else; this keeps that `object` in the position the projection
 * marks, so the focus node and every constrained value reachable from it are unchanged.
 *
 * ★ WHAT IS LOST IS STATED RATHER THAN ASSUMED. `omitted` is merged into
 * {@link Projection.blindTo} and reported as `notProjected`, because a shape that grew an
 * inverse path — `sh:path [ sh:inversePath as:object ]` reaching back to the activity — WOULD
 * see less here than it sees on the ordinary path.
 *
 * ★ AND THE RULE IS SIZE-INDEPENDENT ON PURPOSE. Dropping "the largest fields until it fits"
 * would make the graph the gate validated depend on how long a field happened to be, which is a
 * verdict nobody could reproduce from the message alone.
 */
export function reduceToConstrainedBody(
  notif: Record<string, unknown>,
  keptOnBody: ReadonlySet<string>,
): {
  readonly notif: Record<string, unknown>;
  readonly omitted: readonly string[];
} {
  const omitted: string[] = [];
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(notif)) {
    if (key === '@context' || key === 'id') { kept[key] = value; continue; }
    if (key !== 'object') { omitted.push(key); continue; }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      // Not a node object: the projection reports it as a blind spot on its own, and there is
      // no subtree here to cut down. Passed through unchanged so that stays its decision.
      kept[key] = value;
      continue;
    }
    const body: Record<string, unknown> = {};
    for (const [bk, bv] of Object.entries(value as Record<string, unknown>)) {
      if (bk === 'id' || keptOnBody.has(bk)) body[bk] = bv;
      else omitted.push(`object.${bk}`);
    }
    kept[key] = body;
  }
  return { notif: kept, omitted };
}

/**
 * How much of ONE value the gate will show the shape when the message is over
 * {@link MAX_GATED_BODY_CHARS}, and how much context it keeps around a pattern match.
 *
 * ★★ SHORTENING A VALUE IS ONLY SOUND IF IT PRESERVES EVERY ANSWER THE SHAPE ASKS OF IT, AND
 * THAT IS CHECKED PER CALL RATHER THAN ARGUED FOR HERE. A prefix is not sound on its own:
 * cutting a summary can remove the phrase that makes it a claiming summary, which turns a
 * refusal into a pass — the exact direction this gate must not err in. So the reduction keeps a
 * head window AND a window around the first match of EVERY `sh:pattern` the published shape
 * carries, and then {@link boundLongValues} re-tests all of those patterns against the result
 * and refuses to substitute unless the match/non-match vector is identical. When it is not — a
 * spliced window that manufactured a match, a pattern whose match is itself enormous — the
 * answer is `unenforced` with a sentence saying so, never a guess.
 */
const VALUE_HEAD_CHARS = 512;
const PATTERN_WITNESS_CONTEXT = 32;
export const MAX_GATED_VALUE_CHARS = 4_096;

/** SHACL Core constraint components whose verdict depends on a value's LENGTH or on its exact
 *  lexical form, other than `sh:pattern` — the ones a shortened value would silently change.
 *  If the published shape ever grows one, {@link boundLongValues} stops shortening rather than
 *  answering from a value the shape would have judged differently. */
const LEXICALLY_SENSITIVE: ReadonlySet<string> = new Set([
  `${SHACL_NS}minLength`, `${SHACL_NS}maxLength`, `${SHACL_NS}hasValue`, `${SHACL_NS}in`,
  `${SHACL_NS}languageIn`, `${SHACL_NS}uniqueLang`, `${SHACL_NS}equals`, `${SHACL_NS}disjoint`,
  `${SHACL_NS}lessThan`, `${SHACL_NS}lessThanOrEquals`,
]);

export interface ShapeReach {
  /** Every predicate IRI the shape constrains through `sh:path`. */
  readonly paths: ReadonlySet<string>;
  /** The notification keys those predicates are emitted from — what a reduction must keep. */
  readonly keys: ReadonlySet<string>;
  /** Every `sh:pattern` the shape publishes, compiled the way the engine compiles them: with
   *  `new RegExp(source)` and NO flags, because `sh:flags` is not implemented and is ignored. */
  readonly patterns: readonly RegExp[];
  /** Local names of any lexically sensitive constraint in the closure — see
   *  {@link LEXICALLY_SENSITIVE}. Non-empty means values must not be shortened. */
  readonly lexical: readonly string[];
}

/**
 * What the isolated shape actually asks about — read out of the shape, not restated here.
 *
 * ★ THE POINT IS THAT THE REDUCTION IS NOT A SECOND COPY OF THE RULE. The rule is
 * `iep:NotificationBodyShape` in `docs/ns/iep.ttl`; this reads which properties it constrains
 * and which patterns it matches, so a reduction can be shown to preserve its verdict instead of
 * being trusted to. It runs ONCE, over the isolated slice, at gate preparation.
 */
export function shapeReach(isolatedTurtle: string): ShapeReach | { readonly error: string } {
  let doc: ParsedDocument;
  try {
    doc = parseTrig(isolatedTurtle);
  } catch (err) {
    return { error: `the isolated shape is not parseable: ${(err as Error).message}` };
  }
  const paths = new Set<string>();
  const keys = new Set<string>();
  const patterns: RegExp[] = [];
  const lexical: string[] = [];
  for (const subject of doc.subjects) {
    for (const [predicate, objects] of subject.properties) {
      if (LEXICALLY_SENSITIVE.has(predicate)) lexical.push(predicate.slice(SHACL_NS.length));
      for (const object of objects) {
        if (predicate === `${SHACL_NS}path` && object.kind === 'iri') {
          paths.add(object.iri);
          const key = KEY_FOR_PREDICATE.get(object.iri);
          if (key) keys.add(key);
        }
        if (predicate === `${SHACL_NS}pattern` && object.kind === 'literal') {
          try { patterns.push(new RegExp(object.value)); }
          catch (err) { return { error: `sh:pattern ${JSON.stringify(object.value)} does not compile: ${(err as Error).message}` }; }
        }
      }
    }
  }
  if (paths.size === 0) {
    return { error: 'the shape constrains no sh:path at all, so there is nothing a reduction could keep' };
  }
  return { paths, keys, patterns, lexical };
}

/**
 * One over-long value, cut down to a head window plus a window around the first match of every
 * published pattern. `null` when the result would still be over {@link MAX_GATED_VALUE_CHARS}.
 *
 * The head window is what keeps an IRI's scheme and authority, so a value the projection would
 * emit as an IRI keeps being one — checked, not assumed, by the caller.
 */
function shortenPreservingWitnesses(value: string, patterns: readonly RegExp[]): string | null {
  const spans: [number, number][] = [[0, Math.min(VALUE_HEAD_CHARS, value.length)]];
  for (const re of patterns) {
    const m = re.exec(value);
    if (!m) continue;
    spans.push([
      Math.max(0, m.index - PATTERN_WITNESS_CONTEXT),
      Math.min(value.length, m.index + m[0].length + PATTERN_WITNESS_CONTEXT),
    ]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]);
    else merged.push([span[0], span[1]]);
  }
  const out = merged.map(([a, b]) => value.slice(a, b)).join('');
  return out.length <= MAX_GATED_VALUE_CHARS ? out : null;
}

/**
 * Every value over {@link MAX_GATED_VALUE_CHARS} replaced by a shortening PROVED to give the
 * shape the same answer — or a refusal to do it, naming why.
 *
 * ★★ THE VERIFICATION IS THE MECHANISM, NOT A SAFETY NET. For each replacement it re-runs every
 * `sh:pattern` the published shape carries against BOTH the original and the shortening and
 * requires the same result from each, and — for a key the projection emits as an IRI — requires
 * `turtleIriRef` to accept or refuse both alike, because `sh:nodeKind sh:IRI` is decided on
 * exactly that. Those are the only two things a SHACL Core shape can ask about a value's
 * content once {@link LEXICALLY_SENSITIVE} is known to be absent, so a shortening that passes
 * both is one the shape cannot tell from the original.
 *
 * ★ AND IT REFUSES RATHER THAN GUESSES. A shape carrying `sh:minLength`, a pattern whose own
 * match runs past the per-value bound, a splice that manufactured a match: each returns an
 * error, the gate answers `unenforced`, and the sentence says which. Answering `conforms` from
 * a value the shape would have judged differently is the failure this whole file exists to stop.
 */
export function boundLongValues(
  notif: Record<string, unknown>,
  reach: ShapeReach,
): { readonly notif: Record<string, unknown>; readonly shortened: readonly string[] } | { readonly error: string } {
  const shortened: string[] = [];
  let failure: string | null = null;

  const shorten = (path: string, key: string, value: string): string => {
    if (value.length <= MAX_GATED_VALUE_CHARS) return value;
    if (reach.lexical.length > 0) {
      failure ??= `${path}${key} is longer than ${MAX_GATED_VALUE_CHARS} characters and the shape `
        + `carries sh:${reach.lexical.join(', sh:')}, whose verdict depends on the value's exact `
        + 'length or lexical form, so no shortening of it can be shown to give the same answer';
      return value;
    }
    const candidate = shortenPreservingWitnesses(value, reach.patterns);
    if (candidate === null) {
      failure ??= `${path}${key} is longer than ${MAX_GATED_VALUE_CHARS} characters and the windows `
        + 'the published patterns match inside it are themselves longer than that, so it cannot be '
        + 'shown to the shape whole or in part';
      return value;
    }
    for (const re of reach.patterns) {
      if (re.test(value) !== re.test(candidate)) {
        failure ??= `${path}${key} could not be shortened without changing whether it matches the `
          + `published pattern ${JSON.stringify(re.source).slice(0, 80)}`;
        return value;
      }
    }
    if (AS2_PREDICATES[key]?.kind === 'iri'
      && (turtleIriRef(value) === null) !== (turtleIriRef(candidate) === null)) {
      failure ??= `${path}${key} could not be shortened without changing whether it is a usable IRI, `
        + 'which is what sh:nodeKind decides on';
      return value;
    }
    shortened.push(`${path}${key}`);
    return candidate;
  };

  const walk = (node: Record<string, unknown>, path: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) {
      if (key === '@context') { out[key] = value; continue; }
      if (typeof value === 'string') { out[key] = shorten(path, key, value); continue; }
      if (Array.isArray(value)) {
        out[key] = value.map(one => (typeof one === 'string' ? shorten(path, key, one) : one));
        continue;
      }
      if (value !== null && typeof value === 'object') {
        out[key] = walk(value as Record<string, unknown>, `${path}${key}.`);
        continue;
      }
      out[key] = value;
    }
    return out;
  };

  const reduced = walk(notif, '');
  if (failure !== null) return { error: failure };
  return { notif: reduced, shortened };
}

/**
 * Project one AS2 notification document into Turtle.
 *
 * ★ A NODE WITHOUT AN ABSOLUTE-IRI `id` BECOMES A BLANK NODE, WHICH IS WHAT IT IS. At gate time
 * the activity's `id` is still `buildNotification`'s slug — `deliverNotification` rewrites it to
 * the resource's own URL only once the target pod is known, which is after this runs — and the
 * Note that is its object never had one at all. A blank node is the faithful reading of a
 * JSON-LD node object with no `@id`; minting an IRI to fill the hole would be inventing an
 * identifier, and this substrate's identifiers all have to resolve.
 *
 * ★ EVERY INTERPOLATED VALUE GOES THROUGH THE SUBSTRATE'S OWN ESCAPERS, AND AN IRI THAT CANNOT
 * BE ONE IS EMITTED AS THE LITERAL IT ACTUALLY IS RATHER THAN DROPPED. `turtleIriRef` refuses
 * anything with a Turtle-forbidden character or no scheme — and `notify_agent`'s `to` routinely
 * IS such a value (`u-pk-…`, a bare pod id). Dropping it would make the graph claim the field
 * was absent; emitting it as a literal says a string is there and is not an address. The
 * published shape is what decides whether that is acceptable for a given predicate — for
 * `iep:about` it is not, and `sh:nodeKind sh:IRI` is where that is written down.
 *
 * ★★ AND THE `as:object` OF THE ACTIVITY — AND ONLY IT — IS MARKED {@link
 * NOTIFICATION_BODY_CLASS}. That single triple is what the published shape targets, and it is
 * the whole reason the rule cannot fire on the wrong node. Marking is positional: the activity
 * handed to this function is the notification, its `as:object` is the body, and no `type` a
 * caller chooses changes either. Nested objects deeper down are NOT marked — an `as:object`
 * inside an `as:object` is not the message body.
 */
export function projectNotification(notif: Record<string, unknown>): Projection {
  const lines: string[] = [];
  const blindTo: string[] = [];
  let anon = 0;
  let bodies = 0;
  const nodeTerm = (n: Record<string, unknown>): string =>
    turtleIriRef(n['id']) ?? `_:n${anon++}`;

  const emit = (node: Record<string, unknown>, subject: string, path: string, depth: number): void => {
    const type = node['type'];
    if (typeof type === 'string') {
      // A caller chooses `type` freely on notify_agent, so it can be a string no IRI can hold.
      const typeIri = turtleIriRef(`${AS}${type}`);
      if (typeIri) lines.push(`${subject} ${iriRef(RDF_TYPE)} ${typeIri} .`);
      else blindTo.push(`${path}type`);
    }
    for (const [key, value] of Object.entries(node)) {
      if (STRUCTURAL_KEYS.has(key)) continue;
      const p = AS2_PREDICATES[key];
      if (!p) { blindTo.push(`${path}${key}`); continue; }
      for (const one of Array.isArray(value) ? value : [value]) {
        if (one === null || one === undefined) continue;
        if (p.kind === 'node') {
          if (typeof one !== 'object') { blindTo.push(`${path}${key}`); continue; }
          // ★ THE PROJECTION STOPS WHERE THE SIZE BOUND STOPS COUNTING — see
          // MAX_PROJECTION_DEPTH. Nothing about this child is emitted, and the key is reported,
          // so the answer says the gate did not look rather than looking at what it never
          // counted.
          if (depth + 1 > MAX_PROJECTION_DEPTH) { blindTo.push(`${path}${key}`); continue; }
          const child = one as Record<string, unknown>;
          const childTerm = nodeTerm(child);
          lines.push(`${subject} ${p.term} ${childTerm} .`);
          // ★ Only the TOP-LEVEL object is the message body — see the note above.
          if (path === '' && key === 'object') {
            lines.push(`${childTerm} ${iriRef(RDF_TYPE)} ${iriRef(NOTIFICATION_BODY_CLASS)} .`);
            bodies++;
          }
          emit(child, childTerm, `${path}${key}.`, depth + 1);
          continue;
        }
        if (typeof one !== 'string') { blindTo.push(`${path}${key}`); continue; }
        const asIri = p.kind === 'iri' ? turtleIriRef(one) : null;
        lines.push(`${subject} ${p.term} ${asIri ?? `"${escapeTurtleLiteral(one)}"`} .`);
      }
    }
  };

  emit(notif, nodeTerm(notif), '', 0);
  return { turtle: `${lines.join('\n')}\n`, blindTo, bodies };
}

// ── The gate ─────────────────────────────────────────────────────────────────

/** What one SHACL run reports back — structurally `ShaclReport`, narrowed to what is read here
 *  so this module never imports the engine and stays drivable from a test with a stub. */
export interface ShaclLike {
  readonly conforms: boolean;
  /** False when the shape used a construct the validator does not implement. */
  readonly fullyChecked?: boolean;
  readonly results: readonly {
    readonly constraintComponent: string;
    readonly message?: string;
    readonly sourceShape?: string;
    readonly focusNode?: string;
    readonly severity?: string;
  }[];
}

export type Validate = (dataTurtle: string, shapeTurtle: string) => ShaclLike;

/** The refusal body, ready to be JSON-stringified back to the caller. */
export interface BodyViolation {
  readonly constraintComponent: string;
  /** The shape's OWN `sh:message` — which is where the missing properties are named, so the
   *  sentence a caller reads is the published one and not a second copy kept here. */
  readonly message: string;
  /** The `sh:NodeShape` that refused, as a dereferenceable IRI. */
  readonly shape: string;
  /** The document that declares it — the thing to go and read. */
  readonly declaredBy: string;
}

export type BodyVerdict =
  | { readonly verdict: 'conforms'; readonly conformsTo: string; readonly blindTo?: readonly string[] }
  | { readonly verdict: 'violates'; readonly violation: BodyViolation }
  /** The gate did not run. Never reported as a pass — see {@link prepareNotificationGate}. */
  | { readonly verdict: 'unenforced'; readonly why: string };

export interface NotificationGate {
  /** True only when the canaries below proved the shape actually decides. */
  readonly enforcing: boolean;
  /** Why not, when not — an operator-facing sentence, present only when `enforcing` is false. */
  readonly why?: string;
  /** The isolated shapes graph in force, for an operator who wants to see what is enforced. */
  readonly isolated?: Isolation;
  check(notif: Record<string, unknown>): BodyVerdict;
}

/**
 * What the gate must decide, and how, before it is allowed to decide anything for a caller.
 *
 * ★★ A FIXTURE TABLE, NOT THE RULE. Nothing here decides anything — this exists so the relay can
 * find out AT LOAD whether the document it just read still decides, instead of assuming it.
 * `docs/ns/iep.ttl` could arrive renamed, `sh:deactivated`, or rewritten in the one way that
 * looks like a tidy-up: lower-casing the summary pattern and adding `sh:flags "i"`. MEASURED
 * against this engine, because the mechanism is not the one the reflex expects — `sh:flags` is
 * NOT IMPLEMENTED and is IGNORED rather than fatal, so the `sh:pattern` beside it still runs
 * case-SENSITIVELY, `P7 and P8 re-sent with FULL DETAIL` then stops matching, the antecedent is
 * negated and the shape CONFORMS for the very message it exists to refuse. The engine says so
 * only in a separate `Info` result and by setting `fullyChecked: false`, neither of which a
 * refusal path reads.
 *
 * ★ EVERY ROW IS A REGRESSION SOMEBODY ALREADY SHIPPED OR NEARLY SHIPPED. Rows 3 and 4 are the
 * two defects the FIRST refuted version had; row 5 is the measured defect itself; row 7 is the
 * one the SECOND round found — a defect that got past this table precisely because the table
 * had no row carrying two summaries.
 */
const CANARIES: readonly {
  readonly what: string;
  readonly mustRefuse: boolean;
  readonly notif: Record<string, unknown>;
}[] = (() => {
  /**
   * Every row is built by the RELAY'S OWN WRITER, so no row can be a graph the writer cannot
   * emit.
   *
   * ★★ A FIXTURE SHAPED TO THE SHAPE PROVES ONLY THAT THE SHAPE MATCHES THE FIXTURE. The test
   * suite beside this file shipped a hand-shaped one — a padded `inReplyTo` on the ACTIVITY,
   * where `buildNotification` never puts it — and the row it was written to guard passed while
   * the real writer's shape walked straight through. Calling the writer is the only spelling
   * that cannot drift from it: change where `buildNotification` puts a field and these rows
   * follow, or the gate switches itself off saying so.
   */
  const from = (input: Parameters<typeof buildNotification>[0]): Record<string, unknown> =>
    buildNotification(input, 'canary');
  const base = { from: 'did:ethr:0xcanary', to: 'did:ethr:0xcanary', published: '2026-01-01T00:00:00.000Z' };
  const CLAIMS = 'P7 and P8 re-sent with FULL DETAIL';
  // 70,000 characters: comfortably past MAX_GATED_BODY_CHARS, and past it by more than any
  // single reduction step removes, so each padded row really does reach the step it is about.
  const PAD = 'x'.repeat(70_000);

  return [
    {
      what: 'an ordinary summary-only probe, which is legitimate and common on this substrate',
      mustRefuse: false,
      notif: from({ ...base, type: 'Create', summary: 'checking whether this inbox is reachable' }),
    },
    {
      what: 'a summary-only Question pointing at a signed record by iep:about, which is how this substrate carries detail it does not want forgeable',
      mustRefuse: false,
      notif: from({ ...base, type: 'Question', summary: 'a notice from a party that did not write the record', about: 'https://example.invalid/ask/1' }),
    },
    {
      // ★ THE REGRESSION THE REFUTED VERSION WOULD HAVE SHIPPED. `sh:targetClass as:Note` also
      // selected the ACTIVITY here, and the body is on its object, so this was REFUSED.
      what: 'a correct message with a real body whose caller chose type: Note, so the ACTIVITY is an as:Note too',
      mustRefuse: false,
      notif: from({ ...base, type: 'Note', summary: CLAIMS, content: 'P7: the write path is unauthenticated. P8: the token is never cleared.' }),
    },
    {
      // ★ `about` that is not an IRI. The projection emits it as the literal it is, and the shape
      // has to be the thing that refuses it — sh:nodeKind sh:IRI.
      what: 'a claiming summary whose iep:about is not an IRI at all, so nothing is actually reachable',
      mustRefuse: true,
      notif: from({ ...base, type: 'Create', summary: CLAIMS, about: 'no' }),
    },
    {
      what: 'the measured defect: a summary claiming the detail travels with it, and no detail',
      mustRefuse: true,
      notif: from({ ...base, type: 'Create', summary: CLAIMS }),
    },
    {
      what: 'the same message with a body of nothing but spaces, which is the empty-string case one character along',
      mustRefuse: true,
      notif: from({ ...base, type: 'Create', summary: CLAIMS, content: '   ' }),
    },
    {
      // ★★ THE ROW THAT WAS MISSING, AND ITS ABSENCE IS WHY THE ANTECEDENT SHIPPED WRONG. Written
      // as `sh:not [ sh:property [ sh:path as:summary ; sh:minCount 1 ; sh:pattern P ] ]` the branch
      // is satisfied by a body carrying ANY summary that does not match — so a SECOND value, the
      // empty string included, delivered the claiming message. Every other row here carries exactly
      // one summary, which is the shape of every message the table was built from, and one value is
      // the one case that spelling gets right.
      //
      // ★ AND IT IS THE ONE ROW NO WRITER IN THIS TREE CAN EMIT ANY MORE, WHICH IS WHY IT IS
      // ASSEMBLED RATHER THAN BUILT. `POST /agents/:localPart/inbox` COULD produce it: it read
      // `(act.summary ?? obj.summary) as string` off a remote document — a cast, not a check — and
      // `buildNotification` copies `summary` onto the activity AND its object, so an array arrived
      // here as two values. That route now guards with `typeof`, so this is a guard on the SHAPE's
      // spelling rather than on a reachable input, and it is kept because the shape is published
      // and a future writer is not bound by today's guards.
      what: 'a claiming summary with a SECOND summary value beside it and no body, which is one array off a remote server',
      mustRefuse: true,
      notif: (() => {
        const n = from({ ...base, type: 'Create', summary: CLAIMS });
        (n['object'] as Record<string, unknown>)['summary'] = [CLAIMS, ''];
        return n;
      })(),
    },

    // ── ★★ THE SIZE ROWS. Each is one of the five fields measured walking through the bound
    // over the wire, and each carries the same verdict its unpadded twin does. They are what
    // makes "over the bound is not past the gate" a property the RUNNING RELAY re-establishes
    // every boot, rather than a sentence in a comment. ──
    {
      what: 'the measured defect with 70,000 characters in in_reply_to, which the shape does not look at and which the writer puts on the BODY',
      mustRefuse: true,
      notif: from({ ...base, type: 'Create', summary: CLAIMS, inReplyTo: PAD }),
    },
    {
      what: 'the measured defect with a 70,000-character caller-chosen activity type, which survived the reduction that dropped the activity fields',
      mustRefuse: true,
      notif: from({ ...base, type: PAD, summary: CLAIMS }),
    },
    {
      what: 'the measured defect with a 70,000-character iep:about that is not an IRI, so nothing is reachable and the size is not a rescue',
      mustRefuse: true,
      notif: from({ ...base, type: 'Create', summary: CLAIMS, about: `no-${PAD}` }),
    },
    {
      what: 'the measured defect with 70,000 characters of padding in the CLAIMING SUMMARY itself, where a plain truncation would have lost the claim',
      mustRefuse: true,
      notif: from({ ...base, type: 'Create', summary: `${PAD} ${CLAIMS}` }),
    },
    {
      what: 'the measured defect with a body of 70,000 space characters, which is over the bound and still not a body',
      mustRefuse: true,
      notif: from({ ...base, type: 'Create', summary: CLAIMS, content: ' '.repeat(70_000) }),
    },
    {
      // ★ THE OTHER DIRECTION, AND WITHOUT IT THE FIVE ROWS ABOVE WOULD PASS FOR A GATE THAT
      // SIMPLY REFUSED EVERYTHING LARGE.
      what: 'a large but entirely legitimate message: a claiming summary and a 70,000-character body that really is there',
      mustRefuse: false,
      notif: from({ ...base, type: 'Create', summary: CLAIMS, content: PAD }),
    },
    {
      what: 'a large message carrying its detail BY REFERENCE, whose iep:about is a real IRI 70,000 characters long',
      mustRefuse: false,
      notif: from({ ...base, type: 'Create', summary: CLAIMS, about: `https://example.invalid/finding/${PAD}` }),
    },
    {
      what: 'a summary-only probe whose summary is 70,000 characters and claims nothing, which must still be delivered',
      mustRefuse: false,
      notif: from({ ...base, type: 'Announce', summary: `the channel has a new head ${PAD}` }),
    },
  ];
})();

/** Violation-severity results only. Warnings and the engine's `Info` notes about constructs it
 *  does not implement are reported elsewhere; neither is a refusal. */
function violations(report: ShaclLike): ShaclLike['results'] {
  return report.results.filter(r => (r.severity ?? 'Violation') === 'Violation');
}

/**
 * Read the published document once, prove it still decides, and return the gate.
 *
 * The canaries run HERE and not per-call: the shape is isolated once, and the table above is
 * fifteen decisions against the 7,210-character slice — seven over a few hundred bytes each, and
 * eight over documents of ~70,000 characters, which are the rows that prove the size reduction
 * still preserves this shape's verdicts. Read the 209,157-character ontology, isolate, run all
 * fifteen: 70–122 ms across five cold processes on this machine — once per process, not once per
 * notification. (Seven small rows alone were 47–62 ms; the eight large ones are what the rest
 * buys, and they buy the property that the bypass cannot reopen silently.)
 *
 * ★ A GATE THAT CANNOT ENFORCE STILL ANSWERS, AND ITS ANSWER IS `unenforced` — NEVER
 * `conforms`. A missing or broken shape document is not the caller's doing and must not refuse
 * their message (that is the report side of the split in this file's header); it is also not
 * evidence that their message is fine. Reporting a pass for a check that never ran is the exact
 * defect `shapes-declared.ts` was written to close, and it would be rebuilt here by a single
 * `if (!shapesTurtle) return { verdict: 'conforms' }`.
 */
export function prepareNotificationGate(shapesTurtle: string | null, validate: Validate): NotificationGate {
  const unenforced = (why: string): NotificationGate => ({
    enforcing: false,
    why,
    check: () => ({ verdict: 'unenforced', why }),
  });

  if (!shapesTurtle) {
    return unenforced(
      `the notification body gate is NOT enforcing: ${NOTIFICATION_SHAPE_DOCUMENT} could not be read `
      + `from any of ${NOTIFICATION_SHAPE_CANDIDATES.map(c => c.join('/')).join(' or ')}. Notifications are `
      + 'delivered unvalidated and say so. Check deploy/Dockerfile.relay still COPYs docs/ns/iep.ttl.',
    );
  }

  const isolation = isolateShapeClosure(shapesTurtle, NOTIFICATION_BODY_SHAPE);
  if ('error' in isolation) {
    return unenforced(
      `the notification body gate is NOT enforcing: ${NOTIFICATION_BODY_SHAPE} could not be isolated out of `
      + `${NOTIFICATION_SHAPE_DOCUMENT} — ${isolation.error}. Notifications are delivered unvalidated and say so.`,
    );
  }

  const reach = shapeReach(isolation.turtle);
  if ('error' in reach) {
    return unenforced(
      `the notification body gate is NOT enforcing: what ${NOTIFICATION_BODY_SHAPE} constrains could not be `
      + `read out of the slice cut from ${NOTIFICATION_SHAPE_DOCUMENT} — ${reach.error}. The gate cannot show `
      + 'an over-bound notification a reduction the shape would judge identically without knowing which '
      + 'properties it looks at, so it does not try. Notifications are delivered unvalidated and say so.',
    );
  }

  /**
   * The whole per-call decision, defined here so the canary table below runs THROUGH IT.
   *
   * ★★ THE CANARIES USED TO CALL THE VALIDATOR DIRECTLY, AND THAT IS WHY THE SIZE BYPASS COULD
   * SHIP TWICE. A table that projects each fixture and validates it measures the SHAPE and
   * nothing else — the bound, the reduction and the shortening were all downstream of it, so no
   * row could ever fail because one of them was wrong. Every row now goes through the same
   * function `notify_agent` calls, so the padded rows below are a load-time proof, in the running
   * container, that being over the bound is not a way past the gate. If a future edit reopens it,
   * the relay reports the gate as NOT ENFORCING and logs which row stopped being decided, rather
   * than quietly delivering the case it exists to catch.
   */
  const decide = (notif: Record<string, unknown>): BodyVerdict => {
      // ★★ THE BOUND COMES FIRST, BEFORE ANY PARSE, AND BEING OVER IT IS NOT A WAY PAST THE
      // GATE. See MAX_GATED_BODY_CHARS for the two earlier spellings of this that WERE a way
      // past it, and for the wire measurements that refuted each. Three steps, and the
      // emptiness decision is reachable through all three.
      let dropped: readonly string[] = [];
      let gated = notif;
      if (notificationTextSize(gated, MAX_GATED_BODY_CHARS) > MAX_GATED_BODY_CHARS) {
        // STEP 2 — keep the target node and, on it, only what the published shape asks about.
        const reduced = reduceToConstrainedBody(notif, reach.keys);
        gated = reduced.notif;
        dropped = reduced.omitted;
      }
      if (notificationTextSize(gated, MAX_GATED_BODY_CHARS) > MAX_GATED_BODY_CHARS) {
        // STEP 3 — shorten what is left to windows the shape cannot tell from the originals.
        const bounded = boundLongValues(gated, reach);
        if ('error' in bounded) {
          // ★ ONLY HERE IS THE CHECK ACTUALLY SKIPPED, AND THE SENTENCE SAYS WHICH OF THE THREE
          // REASONS IT WAS. The one it replaced — "a body this size is not the case the shape
          // exists to catch" — was false on the cheapest trigger, because the body could be
          // empty; the one after that named only the activity fields it had dropped, which was
          // false for the four other fields that reached here.
          return {
            verdict: 'unenforced',
            why: `this notification is past the ${MAX_GATED_BODY_CHARS}-character bound this gate will `
              + `parse synchronously, and it could not be reduced to something ${NOTIFICATION_BODY_SHAPE} `
              + `would judge identically: ${bounded.error}. It was delivered unvalidated.`,
          };
        }
        gated = bounded.notif;
        dropped = [...dropped, ...bounded.shortened.map(v => `${v} (shortened to a window the published patterns match identically)`)];
      }
      if (notificationTextSize(gated, MAX_GATED_BODY_CHARS) > MAX_GATED_BODY_CHARS) {
        // Every remaining value is inside MAX_GATED_VALUE_CHARS, so reaching here means the
        // BODY carries more separate values on the shape's own properties than the bound holds.
        // Dropping values would change what `sh:qualifiedMinCount` and `sh:minCount` count, so
        // there is nothing sound left to do.
        return {
          verdict: 'unenforced',
          why: `with only the properties ${NOTIFICATION_BODY_SHAPE} constrains kept and each value `
            + `shortened to ${MAX_GATED_VALUE_CHARS} characters, this notification still carries more `
            + `than ${MAX_GATED_BODY_CHARS} characters — it puts that many separate values on the `
            + 'shape’s own properties, and dropping any of them would change what its counting '
            + 'constraints count. It was delivered unvalidated.',
        };
      }
      const projection = projectNotification(gated);
      // What the shape was not shown, whether the projection could not express it or this gate
      // dropped or shortened it to stay inside the bound. One list, because a caller reading
      // `notProjected` is asking one question.
      const blindTo = dropped.length > 0 ? [...projection.blindTo, ...dropped] : projection.blindTo;
      let report: ShaclLike;
      try {
        report = validate(projection.turtle, isolation.turtle);
      } catch (err) {
        // The gate proved it decides at load, so a throw here is about THIS document, not the
        // shape. Refusing the caller for it would be blaming them for the relay's fault.
        return {
          verdict: 'unenforced',
          why: `validating this notification against ${NOTIFICATION_BODY_SHAPE} threw: ${(err as Error).message}. `
            + 'It was delivered unvalidated.',
        };
      }
      // ★ NO `sourceShape` TEST. The shapes graph holds this shape and nothing else, so a
      // Violation in this report was raised by it — which is the point of isolating it, and the
      // repair for the refuted version's blindness to its own sh:property constraints.
      const mine = violations(report)[0];
      if (mine) {
        return {
          verdict: 'violates',
          violation: {
            constraintComponent: mine.constraintComponent,
            message: mine.message ?? 'the notification body does not conform to its published shape',
            shape: NOTIFICATION_BODY_SHAPE,
            declaredBy: NOTIFICATION_SHAPE_DOCUMENT,
          },
        };
      }
      return {
        verdict: 'conforms',
        conformsTo: NOTIFICATION_BODY_SHAPE,
        ...(blindTo.length > 0 ? { blindTo } : {}),
      };
  };

  for (const canary of CANARIES) {
    let verdict: BodyVerdict;
    try {
      verdict = decide(canary.notif);
    } catch (err) {
      return unenforced(
        `the notification body gate is NOT enforcing: deciding ${NOTIFICATION_BODY_SHAPE} threw on `
        + `${canary.what} — ${(err as Error).message}. Notifications are delivered unvalidated and say so.`,
      );
    }
    const want = canary.mustRefuse ? 'violates' : 'conforms';
    if (verdict.verdict !== want) {
      return unenforced(
        `the notification body gate is NOT enforcing: ${NOTIFICATION_BODY_SHAPE}, read from `
        + `${NOTIFICATION_SHAPE_DOCUMENT}, answered ${verdict.verdict.toUpperCase()} for ${canary.what} — and it `
        + `must ${canary.mustRefuse ? 'refuse' : 'accept'} it. Either the shape is missing, deactivated or uses `
        + 'a construct this validator does not implement, or the size reduction stopped preserving its verdict. '
        + 'Enforcing it would refuse traffic that has always been correct, or wave through the case it exists to '
        + `catch, so it is switched off rather than turned on wrong. ${verdict.verdict === 'unenforced' ? verdict.why : ''}`,
      );
    }
  }

  return {
    enforcing: true,
    isolated: isolation,
    check: decide,
  };
}


/**
 * What a SUCCESSFUL answer says about the contract, so a caller learns it from a delivery rather
 * than only from a refusal.
 *
 * ★ THE SHAPE IRI IS ON THE SUCCESS PATH ON PURPOSE. A contract a caller only meets when they
 * break it is a contract most callers never read. `conformsTo` is dereferenceable, so the sender
 * of a message that went through can follow it and see what the next one must satisfy.
 *
 * ★ AND `enforced: false` IS AN ANSWER, NOT AN OMISSION. When the shape document could not be
 * read, was read and proved not to decide, or the body was past the gate's size bound, the
 * delivery still happens — but the answer says the check did not run. Reporting nothing would be
 * indistinguishable from a clean pass, which is the defect `shapes-declared.ts` exists to close,
 * rebuilt one field along.
 */
export function notificationBodyReport(verdict: BodyVerdict): Record<string, unknown> {
  if (verdict.verdict === 'conforms') {
    return {
      conformsTo: verdict.conformsTo,
      // Named for what it is: a part of the document this gate did not turn into RDF, so no
      // shape saw it. Present only when there is one.
      ...(verdict.blindTo ? { notProjected: verdict.blindTo } : {}),
    };
  }
  if (verdict.verdict === 'unenforced') return { enforced: false, why: verdict.why };
  // A refusal never reaches here — `notify_agent` returns notificationBodyRefusal instead, and
  // the ActivityPub route reports the violation under its own key. Answering with the message
  // rather than throwing keeps a future third caller from silently reporting nothing.
  return { enforced: true, conforms: false, shape: verdict.violation.shape, why: verdict.violation.message };
}

/**
 * The refusal `notify_agent` returns.
 *
 * ★ `delivered: false` IS THE FIRST FIELD BECAUSE IT IS THE ONE A SENDER READS. Everything this
 * handler learned about confirmations applies to refusals too: the answer has to be legible in
 * one line, and the line is "this was not sent, and here is the published sentence saying why".
 *
 * ★ AND IT CARRIES NO URL THE CALLER DID NOT ALREADY HAVE OR CANNOT FETCH. `shape` and
 * `declaredBy` are public, dereferenceable vocabulary IRIs; `to` is the caller's own input. Not
 * the relay's storage origin, not the pod's internal host, not the inbox path — a refusal is not
 * the place to disclose where a recipient's mail would have gone.
 */
export function notificationBodyRefusal(violation: BodyViolation, to: string): Record<string, unknown> {
  return {
    delivered: false,
    error: violation.message,
    constraintComponent: violation.constraintComponent,
    shape: violation.shape,
    declaredBy: violation.declaredBy,
    to,
  };
}
