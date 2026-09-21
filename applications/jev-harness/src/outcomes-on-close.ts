/**
 * What a closed pull request tells the harness about the judgments it carried.
 *
 * The review verdict predicted whether a person needed to look; the merge, or the close
 * without one, is the human decision it is scored against — unless the merge was made by the
 * gated auto-merge job, which is no person's decision at all: the verdict is then left
 * unscored rather than credited with an approval nobody gave. A navigation, when a session
 * linked one to the pull request, is scored against the files the pull request changed
 * whoever merged it. Selections and triages were scored in the run that made them, so they are
 * left alone.
 */

import { judgmentsInComments } from './pr-comment.js';

export interface CloseFacts {
  readonly merged: boolean;
  readonly filesChanged: readonly string[];
  /** The merge was made by the auto-merge job (the pull request carries AUTO_MERGED_LABEL). */
  readonly autoMerged?: boolean;
}

export interface OutcomeRequest {
  readonly graphIri: string;
  readonly kind: string;
  readonly body: Record<string, unknown>;
}

/** The outcome requests a closed pull request's comments and facts justify. */
export function outcomeRequests(commentBodies: readonly string[], facts: CloseFacts): OutcomeRequest[] {
  const decision = facts.merged ? 'approved' : 'changes-requested';
  const out: OutcomeRequest[] = [];
  for (const j of judgmentsInComments(commentBodies)) {
    if (j.kind === 'review-verdict') {
      if (facts.autoMerged) continue;
      out.push({ ...j, body: { judgment_iri: j.graphIri, human_decision: decision, ...(facts.filesChanged.length > 0 ? { files_changed: [...facts.filesChanged] } : {}) } });
    } else if (j.kind === 'navigation' && facts.merged && facts.filesChanged.length > 0) {
      out.push({ ...j, body: { judgment_iri: j.graphIri, files_changed: [...facts.filesChanged] } });
    }
  }
  return out;
}
