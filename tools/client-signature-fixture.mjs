/** Declarative, synthetic-only approval scenario shared by the runner and its signers. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export const roles = ['submitter', 'reviewer-1', 'reviewer-2'];
export const labels = { approve: 'Confirm synthetic test result', finish: 'Finish synthetic canary' };
export const purpose = 'SYNTHETIC autonomous approval test. Never a real release approval.';

export function fixture(id, participants) {
  assert.match(id, /^urn:graph:interego:application:client-signature-ci-canary-[0-9]+-[a-f0-9]+$/);
  assert.equal(participants.length, 3);
  for (const field of ['agentDid', 'podUrl', 'address']) {
    assert.ok(participants.every(p => typeof p[field] === 'string' && p[field].length > 0));
    assert.equal(new Set(participants.map(p => p[field].toLowerCase())).size, 3, 'Three distinct ' + field + ' values are required');
  }
  const submitter = participants[0].agentDid;
  const reviewers = participants.slice(1).map(p => p.agentDid);
  const graphs = Object.fromEntries(['contract', 'definition', 'state', 'catalog'].map(kind => [kind, id + ':' + kind]));
  // Each worker recomputes this result before signing. The exercise measures
  // separately authenticated confirmations, not independent human judgment.
  const candidate = { inputs: [2, 3, 5, 7], sum: 17 };
  const candidateDigest = createHash('sha256').update(JSON.stringify(candidate)).digest('hex');
  const baseGuard = [{ op: 'eq', left: '$state.status', right: 'test-review' },
    { op: 'eq', left: '$authorization.verified', right: true }];
  const approve = { actionIri: id + ':approve', label: labels.approve, method: 'POST',
    target: 'urn:interego:runtime:signed-domain:v1', clientSignature: true, inputs: [],
    guard: { op: 'all', guards: [...baseGuard,
      { op: 'ne', left: '$actor', right: '$state.submitter' },
      { op: 'any', guards: reviewers.map(did => ({ op: 'eq', left: '$actor', right: did })) },
      { op: 'none', path: '$state.approvals', where: { itemPath: 'approver', eq: '$actor' } },
      { op: 'none', path: '$state.approvals', where: { itemPath: 'keyId', eq: '$authorization.keyId' } }] },
    effects: [{ op: 'appendUnique', path: '$state.approvals', by: 'approver', value: {
      approver: '$actor', keyId: '$authorization.keyId', verified: '$authorization.verified',
      candidateDigest: '$state.candidateDigest', at: '$now' } }] };
  const finish = { actionIri: id + ':finish', label: labels.finish, method: 'POST',
    target: approve.target, clientSignature: true, inputs: [],
    guard: { op: 'all', guards: [...baseGuard,
      { op: 'eq', left: '$actor', right: '$state.submitter' },
      { op: 'countDistinct', path: '$state.approvals', itemPath: 'approver', gte: 2 },
      { op: 'countDistinct', path: '$state.approvals', itemPath: 'keyId', gte: 2 },
      { op: 'none', path: '$state.approvals', where: { op: 'any', guards: [
        { op: 'eq', left: '$item.approver', right: '$state.submitter' },
        { op: 'ne', left: '$item.verified', right: true },
        { op: 'ne', left: '$item.candidateDigest', right: '$state.candidateDigest' }] } }] },
    effects: [{ op: 'set', path: '$state.status', value: 'synthetic-test-complete' }] };
  return { graphs, candidateDigest,
    contract: { schema: 'interego.application.contract/v1', applicationId: id, version: '1.1.0',
      runtimeIri: approve.target, actions: [approve, finish] },
    definition: { schema: 'interego.application.definition/v1', id,
      title: purpose, description: 'One submitter and two separately keyed reviewer processes.',
      version: '1.1.0', stateGraphIri: graphs.state, contractGraphIri: graphs.contract },
    state: { schema: 'interego.application.state/v1', applicationId: id, version: 0,
      data: { status: 'test-review', submitter, candidate, candidateDigest, approvals: [] } },
    catalog: refs => ({ schema: 'interego.application.catalog/v1', id: graphs.catalog,
      version: 1, applications: [{ applicationId: id, contractGraphIri: graphs.contract,
        definitionGraphIri: graphs.definition, definitionDescriptorUrl: refs.definition.descriptorUrl,
        stateGraphIri: graphs.state, manifestCids: { contract: refs.contract,
          definition: refs.definition, genesisState: refs.genesis } }] }),
  };
}
