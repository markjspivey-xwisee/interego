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
 *        - cg:revokedIf / cg:revokedBy  → SemioticFacet.revokedIf
 *        - prov:wasDerivedFrom          → ProvenanceFacet.wasDerivedFrom
 *        - cg:supersedes                → descriptor.supersedes
 *        - dct:conformsTo               → descriptor.conformsTo
 *
 * A single publish-path implementation calls `normalizePublishInputs()`,
 * gets back a struct, and hands it to the builder. Nothing about modal
 * truth or mirror extraction duplicates across relay / mcp-server / CLI.
 */

import type { IRI, ModalStatus, RevocationConditionData } from './types.js';

export interface PublishInputs {
  /** Semiotic modal status — defaults to 'Asserted' if unset. */
  readonly modalStatus?: ModalStatus;
  /** Caller-supplied epistemic confidence [0.0, 1.0]. */
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
  const modalStatus: ModalStatus = inputs.modalStatus ?? 'Asserted';
  const epistemicConfidence = inputs.confidence ?? 0.85;

  let groundTruth: boolean | undefined;
  if (modalStatus === 'Asserted' || modalStatus === 'Quoted') groundTruth = true;
  else if (modalStatus === 'Counterfactual' || modalStatus === 'Retracted') groundTruth = false;
  // else Hypothetical — leave undefined (three-valued)

  const graphContent = inputs.graphContent ?? '';
  const revokedIf = extractRevocationConditions(graphContent);
  const wasDerivedFrom = extractIRIList(graphContent, 'prov:wasDerivedFrom');
  const supersedes = extractIRIList(graphContent, 'cg:supersedes');
  const conformsTo = extractIRIList(graphContent, 'dct:conformsTo');

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
 * Extract cg:revokedIf / cg:revokedBy RevocationCondition blocks from
 * caller-supplied Turtle graph content. Regex-based rather than
 * full-parser; the shape coverage is small and conformance fixtures
 * pin the expected format.
 */
export function extractRevocationConditions(turtle: string): RevocationConditionData[] {
  const results: RevocationConditionData[] = [];
  const blockRe = /cg:(?:revokedIf|revokedBy)\s*\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(turtle)) !== null) {
    const body = m[1] ?? '';
    const qMatch = body.match(/cg:successorQuery\s+"""([\s\S]*?)"""/)
      ?? body.match(/cg:successorQuery\s+"([^"]*)"/);
    if (!qMatch?.[1]) continue;
    const scopeMatch = body.match(/cg:evaluationScope\s+cg:(\w+)/);
    const actionMatch = body.match(/cg:onRevocation\s+cg:(\w+)/);
    const issuerMatch = body.match(/cg:revocationIssuer\s+<([^>]+)>/);
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
 * predicate matches the qualified name. Used for predicates that take
 * an IRI value and can legitimately repeat (prov:wasDerivedFrom,
 * cg:supersedes, dct:conformsTo). De-duplicated.
 */
function extractIRIList(turtle: string, predicate: string): IRI[] {
  const escaped = predicate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`${escaped}\\s+<([^>]+)>`, 'g');
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(turtle)) !== null) {
    if (m[1]) seen.add(m[1]);
  }
  return [...seen].map(s => s as IRI);
}
