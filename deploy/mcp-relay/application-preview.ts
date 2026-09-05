/** Read-only live boundary. It receives no signing, publishing or persistence capability. */
import {
  resolveApplicationLab, resolveApplicationActionEvidence,
  type ApplicationLabReads, type Json,
} from './application-lab-runtime.js';
import { simulateApplication } from './application-simulation.js';

export async function previewApplicationAction(
  request: Record<string, unknown>,
  session: { readonly actor: string; readonly now: string },
  reads: ApplicationLabReads,
) {
  const required = (key: string): string => {
    const value = request[key];
    if (typeof value !== 'string' || !value) throw new Error(`${key} is required`);
    return value;
  };
  const catalogDescriptorUrl = required('catalog_descriptor_url');
  const applicationId = required('application_id');
  const actionIri = required('action_iri');
  const expectedHead = required('expected_head');
  const expectedContract = required('expected_contract_digest');
  if (!session.actor) throw new Error('authenticated actor is required');
  const payload = request['payload'];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('payload must be an object');
  const resolveInput = {
    catalogDescriptorUrl, applicationId, actor: session.actor,
    ...(typeof request['catalog_graph_iri'] === 'string' ? { catalogGraphIri: request['catalog_graph_iri'] } : {}),
  };
  const resolved = await resolveApplicationLab(resolveInput, reads);
  if (!resolved.catalogCurrent || !resolved.replay.complete) throw new Error('preview requires current authority and complete verified replay');
  if (resolved.stateHead.cid !== expectedHead) throw new Error('stale application head; refresh before previewing');
  if (resolved.activeContractEnvelope.declaredDigest !== expectedContract) throw new Error('stale application contract; refresh before previewing');
  // Payload URLs select dependencies; only the real verifier can provide evidence.
  const evidence = await resolveApplicationActionEvidence(resolved, { actionIri, payload: payload as Record<string, unknown> }, reads);
  const result = simulateApplication(resolved, {
    actor: session.actor, now: session.now, expectedHead, actionIri, enumerate: false,
    samples: [{ actionIri, payload: payload as Record<string, Json>, evidence }], maxCandidates: 1,
  });
  // Re-resolve after evidence reads. Concurrent state/catalog/governance activation
  // invalidates the preview even when the application state CID alone is unchanged.
  const after = await resolveApplicationLab(resolveInput, reads);
  if (!after.catalogCurrent || !after.replay.complete
      || after.stateHead.cid !== resolved.stateHead.cid
      || after.catalogEnvelope.declaredDigest !== resolved.catalogEnvelope.declaredDigest
      || after.definitionEnvelope.declaredDigest !== resolved.definitionEnvelope.declaredDigest
      || after.activeContractEnvelope.declaredDigest !== resolved.activeContractEnvelope.declaredDigest) {
    throw new Error('application authority changed during preview; refresh and retry');
  }
  return { ...result, live: true, committed: false, replay: {
    complete: resolved.replay.complete, verifiedLinks: resolved.replay.verifiedLinks, chainLength: resolved.replay.chainLength,
  } };
}
