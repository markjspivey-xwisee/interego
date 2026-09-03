/**
 * SEALING BEFORE ANYTHING LEAVES THIS PROCESS.
 *
 * ── ★★ WHAT THIS CHANGES, AND WHY IT COULD NOT BE DONE AT THE RELAY ─────────
 *
 * Until this file existed, a "private" workspace worked like this: the client sent the relay the
 * PLAINTEXT, the relay encrypted it, and — because `authorEncryptionKey` is hardcoded to
 * `relayAgentKey.publicKey` — the relay put its own key in every envelope. Measured on the live
 * fleet: two runs with four unrelated wallets produced envelopes sharing one third key. So the
 * relay read every private word at write time and could read every one of them again afterwards.
 * That is encryption at rest performed by a trusted server. It is not end-to-end, and no amount of
 * member-key registration could have made it so while the sealing happened over there.
 *
 * This is the other half: the envelope is built HERE, out of keys belonging to members, and the
 * relay receives ciphertext it cannot open.
 *
 * ── ★ THE FOUR THINGS THE RELAY USED TO DO WITH THE PLAINTEXT ───────────────
 *
 * They do not disappear because the relay went blind; each has to happen somewhere. Three move
 * here, and one is genuinely lost:
 *
 *   1. SENSITIVITY SCREENING — moves here, and stays a WARNING. `screenForSensitiveContent` is an
 *      ordinary importable package, so this is a relocation and not a casualty — but a relocated
 *      check must not quietly change severity. The relay appends a warning and publishes anyway;
 *      so does this, returning the flags for the host to surface.
 *   2. SHAPE CONFORMANCE — moves here, and this is the real cost. The relay's guarantee was
 *      "everything in this container conforms"; a server that cannot read the content cannot offer
 *      that, and nothing can give it back. What remains is a publisher that checks before sealing
 *      and a reader that checks after opening. A modified client can now land a malformed entry.
 *   3. THE CLEARTEXT MIRROR — moves here, and it is load-bearing in a way that is easy to miss.
 *      `normalizePublishInputs` lifts `iep:supersedes` OUT of the payload and into the descriptor;
 *      hand the relay ciphertext and it finds nothing, so every entry becomes its own head and the
 *      chain silently forks. This runs the relay's own extractor over the plaintext and sends the
 *      result alongside.
 *   4. THE CONTENT DIGEST — moves here, and it changes what a signature MEANS. See `sealForRoster`.
 *
 * ── ★★ A SEPARATE ENTRY POINT, LIKE `opener.ts`, AND FOR A HARDER REASON ────
 *
 * `crypto/encryption.ts` imports `node:crypto` at module scope. The published artifact bundles
 * `index.ts` with esbuild's browser platform, so anything reachable from the index that touches
 * node breaks that build outright. The artifact therefore CANNOT seal — not as a policy, as a fact
 * — and must refuse private writes rather than fall back to letting the relay do it, which is the
 * arrangement being removed.
 */

import {
  canonicalGraphDigest, createEncryptedEnvelope, extractRevocationConditions,
  normalizePublishInputs, validateAgainstShape, type EncryptionKeyPair,
} from '@interego/core';
import { screenForSensitiveContent } from '@interego/privacy';
import { wrapAsTriG } from '@interego/solid';

/** What to send, or why nothing may be sent. */
export type SealResult =
  | {
      readonly ok: true;
      /** The serialized envelope, to send as `graph_content`. */
      readonly graphContent: string;
      /** Set `sealed_payload: true` alongside it. */
      readonly contentDigest: string;
      readonly cleartextMirror: string;
      readonly recipientCount: number;
      /**
       * What the sensitivity screen noticed, for the host to surface.
       *
       * ★★ A WARNING, BECAUSE THAT IS WHAT THE RELAY DID. `handlePublishContext` appends
       * `formatSensitivityWarning` to its response and publishes anyway — the human decides. An
       * earlier version of this file REFUSED instead, on the reasoning that there is nobody
       * downstream left to warn once the relay is blind. That reasoning was wrong twice: the
       * caller is downstream and can be told, and relocating a check must not quietly make it
       * stricter. It was caught by the live probe, whose own marker tripped the phone-number
       * heuristic and could not publish at all.
       */
      readonly sensitivity: readonly unknown[];
    }
  | { readonly ok: false; readonly why: string; readonly code: 'shape_violation' | 'no_recipients' | 'unmirrorable' };

/**
 * The descriptor-layer statements the relay would have lifted out of the plaintext.
 *
 * ★★ IT RUNS THE RELAY'S OWN EXTRACTOR RATHER THAN RE-READING THE TURTLE. `normalizePublishInputs`
 * is the function the relay calls on `graph_content`; calling anything else here would be a second
 * implementation of "what counts as a supersession", and the two would drift into a forked chain
 * that nothing reports. Only the EMISSION is new, and it emits about the graph IRI because that is
 * the subject the relay's own extraction is understood to be about.
 */
export function mirrorTurtleFor(payloadTurtle: string, graphIri: string): { ok: true; turtle: string } | { ok: false; why: string } {
  const pre = normalizePublishInputs({ graphContent: payloadTurtle });

  /**
   * ★ REFUSED RATHER THAN DROPPED. A revocation condition is a `iep:revokedIf [ … ]` block with a
   * SPARQL body, and re-emitting it faithfully is not a line of code. Silently omitting it would
   * publish a claim whose revocation condition had evaporated — the record would outlive the thing
   * that was supposed to retire it, and nothing would say so. No workspace document emits one
   * today; a vertical that starts to must extend this rather than discover the loss later.
   */
  if (extractRevocationConditions(payloadTurtle).length > 0) {
    return {
      ok: false,
      why: 'this payload carries an iep:revokedIf condition, and the cleartext mirror cannot yet carry one '
        + 'across a sealed publish. Publishing anyway would drop the condition and leave a claim that '
        + 'cannot be retired. Nothing was written.',
    };
  }

  /**
   * ★★ PREFIXED NAMES, NOT FULL IRIs, AND THIS IS NOT A STYLE CHOICE. `extractIRIList` builds its
   * regex around the LITERAL STRING it is given — `iep:supersedes` — so a mirror written with
   * `<https://…/iep#supersedes>` matches nothing and the relay lifts nothing. It would be
   * well-formed, semantically identical Turtle that the extractor is simply blind to, and the only
   * symptom would be an entry chain that quietly forks. Caught by the equivalence test, which
   * compares what the relay extracts from the payload against what it extracts from the mirror.
   *
   * The prefixes are declared for the same reason: the extractor runs over whatever string it is
   * handed, and a bare `iep:` with no `@prefix` is not Turtle anybody else could read either.
   */
  const lines: string[] = [
    '@prefix iep: <https://markjspivey-xwisee.github.io/interego/ns/iep#> .',
    '@prefix prov: <http://www.w3.org/ns/prov#> .',
    '@prefix dct: <http://purl.org/dc/terms/> .',
  ];
  /**
   * ★★ TWO DEFECTS WERE HERE, AND THE COMMENT ABOVE THEM DESCRIBED NEITHER.
   *
   * 1. `graphIri` WAS NOT SCREENED AT ALL. Every triple below writes `<${graphIri}>` as its
   *    subject, and a `>` in it closes the reference and opens the rest of the line to whatever
   *    the caller supplied — the injection this package's other writers all refuse. The gate
   *    `★ every interpolated IRI is refused rather than escaped` drove eight of this package's
   *    twelve Turtle writers, and this was one of the four it did not.
   * 2. AN UNSERIALIZABLE OBJECT IRI WAS SILENTLY DROPPED. `continue` is not refusal — it is the
   *    quiet omission this very file rejects twenty lines up for revocation conditions ("the
   *    record would outlive the thing that was supposed to retire it, and nothing would say
   *    so"). A dropped `iep:supersedes` publishes a mirror asserting NO supersession, which is
   *    that same failure with a different predicate.
   *
   * Both are refusals now, which this function's return type already expressed.
   */
  const UNSERIALIZABLE = /[\s<>"{}|\\^`]/;
  if (UNSERIALIZABLE.test(graphIri)) {
    return {
      ok: false,
      why: 'the graph IRI is not serializable as a Turtle IRI reference, and a reference ends at '
        + 'the first `>` with no escape available — writing it would let the rest of the line be '
        + `chosen by whoever supplied it: ${graphIri}`,
    };
  }
  let refusal: string | undefined;
  const emit = (predicate: string, iris: readonly string[]): void => {
    for (const iri of iris) {
      // Refused rather than escaped OR dropped: an unserializable IRI must stop the document.
      if (UNSERIALIZABLE.test(iri)) {
        refusal ??= `a ${predicate} object is not serializable as a Turtle IRI reference, and `
          + `omitting it would publish a mirror claiming the relation does not exist: ${iri}`;
        continue;
      }
      lines.push(`<${graphIri}> ${predicate} <${iri}> .`);
    }
  };
  emit('iep:supersedes', pre.supersedes);
  emit('prov:wasDerivedFrom', pre.wasDerivedFrom);
  emit('dct:conformsTo', pre.conformsTo);
  if (refusal !== undefined) return { ok: false, why: refusal };
  // Nothing to mirror: an empty string is what `normalizePublishInputs` is happy to receive, and
  // three lonely prefix declarations would be a document that asserts nothing.
  return { ok: true, turtle: lines.length === 3 ? '' : lines.join('\n') };
}

/**
 * Seal a payload for a workspace's roster.
 *
 * ── ★★ WHAT `contentDigest` MEANS AFTER THIS, WHICH IS NOT WHAT IT MEANT BEFORE ─
 *
 * The relay signs authorship over this digest without being able to verify it, so the proof stops
 * saying "I hashed these bytes" and starts saying "the agent I authenticated ASSERTED this digest".
 * That is weaker, and it is not hidden: the meaning is recovered on the reading side, where a
 * recipient recomputes the digest over the payload it just opened. A publisher who lies produces a
 * `mismatched` binding for every entitled reader — detection is lazy rather than absent.
 *
 * The digest is taken over the SAME bytes a reader will reconstruct — `wrapAsTriG` output, which
 * `extractNamedGraphTurtle` inverts — and not over the raw payload, or no reader could reproduce it.
 */
export function sealForRoster(args: {
  readonly graphIri: string;
  readonly payloadTurtle: string;
  /** Base64 X25519 public keys, one per member. Must not contain the relay's. */
  readonly recipientKeys: readonly string[];
  readonly sender: EncryptionKeyPair;
  /** The workspace's entry shape, fetched by the caller. Omitted means nothing to check against. */
  readonly shape?: { readonly iri: string; readonly turtle: string };
}): SealResult {
  if (args.recipientKeys.length === 0) {
    return { ok: false, code: 'no_recipients', why: 'no recipient keys were supplied, so this would be sealed to nobody and readable by nobody, including its author. Nothing was written.' };
  }

  // 1 · the screen the relay used to run. Relocated with its SEVERITY intact — see `sensitivity`.
  const sensitivity = screenForSensitiveContent(args.payloadTurtle);

  // 2 · the conformance gate the relay can no longer run
  if (args.shape) {
    // ★ THE GATE'S SEVERITY POLICY, STATED RATHER THAN INHERITED.
    //
    // `conforms` used to mean "no sh:Violation" in this engine, everywhere, with no way to
    // ask for anything else. That was a misreading of §3.6 — which says ANY result — and
    // fixing it silently tightened every gate that reads the flag, including this one.
    //
    // Measured, on a shape this repo publishes: iep:AgentProvenanceConsistencyShape
    // declares `sh:severity sh:Warning` and its own prose says why — "Warning (not
    // violation) because there are legitimate ghost-write patterns (e.g. agent X proxying
    // for agent Y) where this is intentional". Under the corrected rule that Warning
    // refuses the publish, so a pattern the shape author explicitly permits would start
    // being rejected by a change that was about a boolean's definition.
    //
    // sh:conformanceDisallows is SHACL 1.2's answer: the severities that defeat
    // conformance are a property of the REQUEST, not of the engine. Declaring
    // ['Violation'] here preserves exactly the behaviour this gate has always had, and
    // says so out loud at the call site instead of relying on the engine to keep getting
    // a boolean wrong in a convenient direction. Warnings still travel in `results` —
    // they are advice, and the caller below already carries the notes forward.
    const report = validateAgainstShape(args.payloadTurtle, args.shape.turtle,
      { entailment: 'rdfs', conformanceDisallows: ['Violation'] });
    if (!report.conforms) {
      return {
        ok: false, code: 'shape_violation',
        why: 'this payload does not conform to the workspace\'s entry shape (' + args.shape.iri + '): '
          + report.results.slice(0, 3).map((r) => String(r.message ?? r.constraintComponent)).join('; ')
          + '. The relay cannot check this for a sealed payload, so it is checked here — before sealing, '
          + 'while the words are still readable.',
      };
    }
  }

  // 3 · the mirror, or a refusal
  const mirror = mirrorTurtleFor(args.payloadTurtle, args.graphIri);
  if (!mirror.ok) return { ok: false, code: 'unmirrorable', why: mirror.why };

  /**
   * 4 · the bytes. `wrapAsTriG('', …)` — an EMPTY descriptor prefix block, because the descriptor
   * is written by the relay afterwards and this process has not seen it. The emitter tolerates it
   * (`lastIndexOf('@prefix')` on an empty string is -1, so the prefix block is empty and the
   * caller's own prefixes are hoisted), and `extractNamedGraphTurtle` inverts the result — which
   * is what makes the digest below reproducible by a reader.
   */
  const wrapped = wrapAsTriG('', args.payloadTurtle, args.graphIri);
  const digest = canonicalGraphDigest(args.payloadTurtle);
  const envelope = createEncryptedEnvelope(wrapped, args.recipientKeys, args.sender);

  return {
    ok: true,
    graphContent: JSON.stringify(envelope),
    contentDigest: digest ?? '',
    cleartextMirror: mirror.turtle,
    recipientCount: args.recipientKeys.length,
    sensitivity,
  };
}
