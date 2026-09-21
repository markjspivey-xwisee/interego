import { describe, expect, it } from 'vitest';
import { outcomeRequests } from '../src/outcomes-on-close.js';
import { gateComment, judgmentsInComments, selectionComment } from '../src/pr-comment.js';

const gate = gateComment({ judgment: { kind: 'review-verdict', graphIri: 'urn:graph:jev-harness:review-verdict:v1', verdict: 'auto-ok', confidence: 0.9 }, publish: { status: 'skipped' } });
const selection = selectionComment([
  { verb: 'select-tests', body: { judgment: { kind: 'test-selection', graphIri: 'urn:graph:jev-harness:test-selection:s1', mode: 'full', tests: [], reasons: [] }, publish: { status: 'skipped' } } },
  { verb: 'triage', body: { judgment: { kind: 'failure-triage', graphIri: 'urn:graph:jev-harness:failure-triage:f1', failures: [] } } },
]);

describe('what a closed pull request records', () => {
  it('finds every judgment the harness comments name, once each, in order', () => {
    expect(judgmentsInComments([gate, selection, gate])).toEqual([
      { graphIri: 'urn:graph:jev-harness:review-verdict:v1', kind: 'review-verdict' },
      { graphIri: 'urn:graph:jev-harness:test-selection:s1', kind: 'test-selection' },
      { graphIri: 'urn:graph:jev-harness:failure-triage:f1', kind: 'failure-triage' },
    ]);
    expect(judgmentsInComments(['a comment by a person', 'Codex Review Summary'])).toEqual([]);
  });

  it('scores the verdict against the merge and leaves selections and triages to the run that made them', () => {
    const merged = outcomeRequests([gate, selection], { merged: true, filesChanged: ['src/a.ts'] });
    expect(merged).toEqual([{ graphIri: 'urn:graph:jev-harness:review-verdict:v1', kind: 'review-verdict', body: { judgment_iri: 'urn:graph:jev-harness:review-verdict:v1', human_decision: 'approved', files_changed: ['src/a.ts'] } }]);
    const closed = outcomeRequests([gate], { merged: false, filesChanged: [] });
    expect(closed[0]?.body).toEqual({ judgment_iri: 'urn:graph:jev-harness:review-verdict:v1', human_decision: 'changes-requested' });
  });

  it('scores a navigation a session linked to the pull request only when it merged with changes', () => {
    const nav = '<!-- jev-harness:judgment urn:graph:jev-harness:navigation:n1 navigation -->';
    expect(outcomeRequests([nav], { merged: true, filesChanged: ['src/x.ts'] })[0]?.body).toEqual({ judgment_iri: 'urn:graph:jev-harness:navigation:n1', files_changed: ['src/x.ts'] });
    expect(outcomeRequests([nav], { merged: false, filesChanged: ['src/x.ts'] })).toEqual([]);
  });

  it('an automatic merge is no person\'s approval: the verdict is left unscored, a navigation still scored', () => {
    const nav = '<!-- jev-harness:judgment urn:graph:jev-harness:navigation:n1 navigation -->';
    const reqs = outcomeRequests([gate, nav], { merged: true, filesChanged: ['src/x.ts'], autoMerged: true });
    expect(reqs.map((r) => r.kind)).toEqual(['navigation']);
    expect(outcomeRequests([gate], { merged: true, filesChanged: [], autoMerged: false }).map((r) => r.kind)).toEqual(['review-verdict']);
  });
});
