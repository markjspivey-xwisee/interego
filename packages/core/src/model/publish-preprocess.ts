/**
 * Publish-input preprocessing helpers.
 *
 * LAYER: Layer 1 — core library. These helpers encode normative protocol
 * rules that every publish path (HTTP relay, local MCP, CLI, future
 * second-implementation) MUST apply identically. Consolidated here so
 * the rules live in one place and can be exercised by the conformance
 * test suite.
 *
 * Responsibilities:
 *
 *   1. Modal-truth consistency (spec/architecture.md §5.2.2):
 *      Asserted       → groundTruth = true
 *      Counterfactual → groundTruth = false
 *      Hypothetical   → groundTruth undefined (three-valued)
 *
 *   2. Cleartext mirror (spec/revocation.md §1 + general pattern):
 *      Extract cross-descriptor relationships from graph content and
 *      thread them into the descriptor layer so federation readers can
 *      evaluate without decrypting the payload.
 *      Currently mirrors:
 *        - iep:revokedIf / iep:revokedBy  → SemioticFacet.revokedIf
 *        - prov:wasDerivedFrom          → ProvenanceFacet.wasDerivedFrom
 *        - iep:supersedes                → descriptor.supersedes
 *        - dct:conformsTo               → descriptor.conformsTo
 *
 * A single publish-path implementation calls `normalizePublishInputs()`,
 * gets back a struct, and hands it to the builder. Nothing about modal
 * truth or mirror extraction duplicates across relay / mcp-server / CLI.
 */

import type { IRI, ModalStatus, RevocationConditionData } from './types.js';
import { PUBLISH_DEFAULT_EPISTEMIC_CONFIDENCE } from './types.js';

export interface PublishInputs {
  /**
   * Semiotic modal status — defaults to `'Asserted'` when unset.
   *
   * An explicit `publish_context` call is semantically an Assertion:
   * the caller stepped over the auto-supersede + screening gates to
   * commit a claim to the record. The user-facing docs
   * (docs/FIRST-HOUR.md, docs/AGENT-INTEGRATION-GUIDE.md,
   * docs/integrations/path-5-hermes-memory-provider.md) and the L2
   * integration shims (integrations/openclaw-memory,
   * integrations/hermes-memory) all encode the same intent: a publish
   * lands as Asserted at 0.85. Callers recording an inferred-but-
   * uncommitted observation MUST pass `modalStatus: 'Hypothetical'`
   * explicitly. The screening preflight + the explicit-call-required
   * gate mitigate the historical "drift to Asserted for safety"
   * concern — an LLM that doesn't actively choose to publish_context
   * won't accidentally Assert anything.
   */
  readonly modalStatus?: ModalStatus;
  /**
   * Caller-supplied epistemic confidence `[0.0, 1.0]`. Defaults to
   * `0.85` — paired with the Asserted default for an explicit publish.
   * Hypothetical callers should pass a lower value (the L2 shims use
   * 0.5) so the affordance engine still gates `apply` / `forward` on
   * a stricter confidence threshold.
   */
  readonly confidence?: number;
  /** Raw Turtle graph content — mined for cross-descriptor mirrors. */
  readonly graphContent?: string;
}

export interface PreprocessedPublish {
  /** Facet data ready to hand to `.semiotic({ ...result.semiotic })`. */
  readonly semiotic: {
    readonly modalStatus: ModalStatus;
    readonly epistemicConfidence: number;
    readonly groundTruth?: boolean;
    readonly revokedIf?: readonly RevocationConditionData[];
  };
  /** IRIs to thread into the builder via `.supersedes(...iris)`. */
  readonly supersedes: readonly IRI[];
  /** IRIs to thread into Provenance's wasDerivedFrom. */
  readonly wasDerivedFrom: readonly IRI[];
  /** IRI of a schema/vocab this claim conforms to (dct:conformsTo). */
  readonly conformsTo: readonly IRI[];
}

/**
 * Apply modal-truth consistency + cleartext mirror to a caller's
 * publish inputs. Returns a struct the builder can use directly.
 */
export function normalizePublishInputs(inputs: PublishInputs): PreprocessedPublish {
  // Default to Asserted / 0.85 — see `PublishInputs.modalStatus` docs.
  // An explicit publish_context call is semantically an Assertion (the
  // caller chose to commit a claim to the record). Callers recording
  // an inferred-but-uncommitted observation must pass Hypothetical
  // explicitly; the L2 integration shims and user-facing docs all
  // encode this same intent.
  const modalStatus: ModalStatus = inputs.modalStatus ?? 'Asserted';
  const epistemicConfidence = inputs.confidence ?? PUBLISH_DEFAULT_EPISTEMIC_CONFIDENCE;

  let groundTruth: boolean | undefined;
  if (modalStatus === 'Asserted' || modalStatus === 'Quoted') groundTruth = true;
  else if (modalStatus === 'Counterfactual' || modalStatus === 'Retracted') groundTruth = false;
  // else Hypothetical — leave undefined (three-valued)

  const graphContent = inputs.graphContent ?? '';
  // Strip Turtle string literals + comments so IRIs mentioned inside a
  // quoted SPARQL query (e.g. the successorQuery of a revokedIf block)
  // do not get mis-lifted as top-level descriptor facts. Surfaced by
  // the 2026-04-21 scientific-debate stress test.
  const cleaned = stripStringsAndComments(graphContent);
  const revokedIf = extractRevocationConditions(graphContent, cleaned);
  const wasDerivedFrom = extractIRIList(cleaned, 'prov:wasDerivedFrom');
  const supersedes = extractIRIList(cleaned, 'iep:supersedes');
  const conformsTo = extractIRIList(cleaned, 'dct:conformsTo');

  const semiotic: PreprocessedPublish['semiotic'] = groundTruth === undefined
    ? (revokedIf.length > 0
        ? { modalStatus, epistemicConfidence, revokedIf }
        : { modalStatus, epistemicConfidence })
    : (revokedIf.length > 0
        ? { modalStatus, epistemicConfidence, groundTruth, revokedIf }
        : { modalStatus, epistemicConfidence, groundTruth });

  return { semiotic, supersedes, wasDerivedFrom, conformsTo };
}

/**
 * Extract iep:revokedIf / iep:revokedBy RevocationCondition blocks from
 * caller-supplied Turtle graph content.
 *
 * Two-pass design: find block boundaries in the *cleaned* turtle (so a
 * `iep:revokedIf` string literal can't masquerade as a block opener and
 * brackets inside strings don't confuse the matcher), then extract the
 * *raw* body between those brackets because the successorQuery body
 * legitimately lives inside a `"""..."""` literal that the cleaned pass
 * would have blanked out.
 */
export function extractRevocationConditions(
  turtle: string,
  cleaned?: string,
): RevocationConditionData[] {
  const results: RevocationConditionData[] = [];
  const clean = cleaned ?? stripStringsAndComments(turtle);
  const headRe = /iep:(?:revokedIf|revokedBy)\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = headRe.exec(clean)) !== null) {
    const openIdx = m.index + m[0].length - 1; // index of '['
    const closeIdx = findMatchingBracket(clean, openIdx);
    if (closeIdx < 0) continue;
    const body = turtle.slice(openIdx + 1, closeIdx);
    const qMatch = body.match(/iep:successorQuery\s+"""([\s\S]*?)"""/)
      ?? body.match(/iep:successorQuery\s+"([^"]*)"/);
    if (!qMatch?.[1]) continue;
    const scopeMatch = body.match(/iep:evaluationScope\s+iep:(\w+)/);
    const actionMatch = body.match(/iep:onRevocation\s+iep:(\w+)/);
    const issuerMatch = body.match(/iep:revocationIssuer\s+<([^>]+)>/);
    const scope = scopeMatch?.[1];
    const action = actionMatch?.[1];
    const out: { -readonly [K in keyof RevocationConditionData]?: RevocationConditionData[K] } & { successorQuery: string } = {
      successorQuery: qMatch[1],
    };
    if (scope === 'LocalPod' || scope === 'KnownFederation' || scope === 'WebFingerResolvable') {
      out.evaluationScope = scope;
    }
    if (action === 'MarkInvalid' || action === 'DowngradeToHypothetical' || action === 'RequireReconfirmation') {
      out.onRevocation = action;
    }
    if (issuerMatch) out.revocationIssuer = issuerMatch[1] as IRI;
    results.push(out as RevocationConditionData);
  }
  return results;
}

/**
 * Extract every `<predicate> <iri>` object from Turtle content where
 * predicate matches the qualified name. Handles Turtle's object-list
 * shorthand — `predicate <a> , <b> , <c>` produces three IRIs, not
 * one. Used for predicates that take an IRI value and can legitimately
 * repeat (prov:wasDerivedFrom, iep:supersedes, dct:conformsTo).
 * De-duplicated.
 *
 * Callers MUST pass turtle that has already had string literals and
 * comments blanked via `stripStringsAndComments` so IRIs inside quoted
 * SPARQL queries are not spuriously lifted. Surfaced 2026-04-21 by
 * the emergent-semiotics demo where a synthesis descriptor's
 * `prov:wasDerivedFrom <a>, <b>, <c>` only lifted the first IRI.
 */
function extractIRIList(turtle: string, predicate: string): IRI[] {
  const escaped = predicate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Match the predicate followed by an object list:
  //   <iri>  |  <iri> , <iri>  |  <iri> , <iri> , <iri>  ...
  // Whitespace around commas is permitted (incl. newlines, since
  // strippingStringsAndComments preserves newline structure).
  const re = new RegExp(`${escaped}\\s+(<[^>]+>(?:\\s*,\\s*<[^>]+>)*)`, 'g');
  const iriRe = /<([^>]+)>/g;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(turtle)) !== null) {
    const list = m[1] ?? '';
    iriRe.lastIndex = 0;
    let im: RegExpExecArray | null;
    while ((im = iriRe.exec(list)) !== null) {
      if (im[1]) seen.add(im[1]);
    }
  }
  return [...seen].map(s => s as IRI);
}

/**
 * Blank out Turtle string literals (`"..."`, `'...'`, `"""..."""`,
 * `'''...'''`) and `#` line comments, preserving the rest of the input
 * character-for-character. Returns a string of identical length — so
 * indices into the cleaned version are valid indices into the raw
 * version.
 *
 * Zero-dep: no parser. The goal is narrow: let extractor regexes see
 * through non-descriptive text so IRIs inside SPARQL ASK queries or
 * comments don't get treated as first-class cross-descriptor links.
 *
 * Exported so it can be pinned by the conformance suite.
 */
export function stripStringsAndComments(turtle: string): string {
  const n = turtle.length;
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    const c = turtle[i];
    // Comment: # to end-of-line. Inside an IRI `<...>` a literal `#`
    // is legal (fragment). We avoid that by handling `<...>` first.
    if (c === '#') {
      out.push(' ');
      i++;
      while (i < n && turtle[i] !== '\n') { out.push(' '); i++; }
      continue;
    }
    // IRI `<...>` — pass through. Never contains line breaks.
    if (c === '<') {
      out.push('<');
      i++;
      while (i < n && turtle[i] !== '>' && turtle[i] !== '\n') {
        out.push(turtle[i]!);
        i++;
      }
      if (i < n && turtle[i] === '>') { out.push('>'); i++; }
      continue;
    }
    // Triple-quoted string: `"""..."""` or `'''...'''`
    if ((c === '"' || c === "'")
        && turtle[i + 1] === c
        && turtle[i + 2] === c) {
      out.push(c, c, c);
      i += 3;
      while (i < n && !(turtle[i] === c && turtle[i + 1] === c && turtle[i + 2] === c)) {
        // Preserve newlines so downstream line-based diagnostics still
        // line up with the raw input.
        out.push(turtle[i] === '\n' ? '\n' : ' ');
        i++;
      }
      if (i + 2 < n) { out.push(c, c, c); i += 3; }
      continue;
    }
    // Single-quoted string: `"..."` or `'...'`. Turtle forbids raw
    // newlines inside single-quoted strings; we terminate on EOL too
    // to keep a malformed input from swallowing the rest of the file.
    if (c === '"' || c === "'") {
      const q = c;
      out.push(q);
      i++;
      while (i < n && turtle[i] !== q && turtle[i] !== '\n') {
        if (turtle[i] === '\\' && i + 1 < n) {
          out.push(' ', ' ');
          i += 2;
        } else {
          out.push(' ');
          i++;
        }
      }
      if (i < n) { out.push(turtle[i]!); i++; }
      continue;
    }
    out.push(c!);
    i++;
  }
  return out.join('');
}

/** Given `[` at openIdx, return index of matching `]`, or -1. */
function findMatchingBracket(s: string, openIdx: number): number {
  let depth = 1;
  let i = openIdx + 1;
  while (i < s.length && depth > 0) {
    if (s[i] === '[') depth++;
    else if (s[i] === ']') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}
