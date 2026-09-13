/** Audience gate for derived resource writes, independent of installed interpreters. */
import { parseTrig, type ParsedTerm } from '@interego/core';
import type { ResourceDescriptor, ResourceReads, ResourceWriteContext } from './resource-compositions.js';

const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const DCAT = 'http://www.w3.org/ns/dcat#';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
type Publication = Parameters<ResourceWriteContext['publish']>[0];
type Audience = 'public' | 'private';
type Source = { url: string; cid: string; audience: Audience; signer: string };
const refuse = (message: string): never => { throw new Error(message); };
const termId = (term: ParsedTerm): string | undefined => term.kind === 'iri' ? term.iri : term.kind === 'bnode' ? '_:' + term.id : undefined;

function sourceAudience(descriptor: ResourceDescriptor): Source {
  const trust = descriptor.authorship;
  if (!descriptor.cid || !descriptor.content || !descriptor.turtle || !descriptor.distribution
    || trust?.authorshipVerified !== true || trust.contentBinding !== 'bound'
    || trust.descriptorBinding?.bound !== true || !trust.signedBy) {
    return refuse('derived publication requires readable, verified source descriptors with observed distributions');
  }
  const subjects = parseTrig(descriptor.turtle).subjects;
  const distributions = subjects.filter(node => (node.properties.get(RDF + 'type') ?? [])
    .some(term => term.kind === 'iri' && term.iri === DCAT + 'Distribution'));
  if (distributions.length !== 1) return refuse('source distribution is missing or ambiguous');
  const distribution = distributions[0]!;
  const id = typeof distribution.subject === 'string' ? distribution.subject : '_:' + distribution.subject.bnode;
  if (!subjects.some(node => [IEP + 'affordance', IEP + 'hasDistribution'].some(predicate =>
    (node.properties.get(predicate) ?? []).some(term => termId(term) === id)))) {
    return refuse('source distribution is not linked from its descriptor');
  }
  const scalar = (predicate: string, kind: 'iri' | 'literal'): string => {
    const terms = distribution.properties.get(predicate) ?? [];
    if (terms.length !== 1 || terms[0]!.kind !== kind) return refuse('source distribution policy is missing or ambiguous');
    const term = terms[0]!;
    if (term.kind === 'iri') return term.iri;
    if (term.kind !== 'literal' || term.language) return refuse('source distribution policy is not a plain value');
    return term.value;
  };
  const access = scalar(DCAT + 'accessURL', 'iri');
  const target = distribution.properties.has(HYDRA + 'target') ? scalar(HYDRA + 'target', 'iri') : access;
  const encrypted = scalar(IEP + 'encrypted', 'literal');
  if (!['true', 'false', '1', '0'].includes(encrypted) || access !== descriptor.distribution.url || target !== access
    || (encrypted === 'true' || encrypted === '1') !== descriptor.distribution.encrypted) {
    return refuse('source distribution differs from the observed payload or encryption');
  }
  // Absence never authorizes public output, including legacy plaintext records.
  const visibility = scalar(IEP + 'visibility', 'literal');
  if (visibility === 'shared') return refuse('exact shared source recipients cannot be preserved by derived publication');
  if (visibility !== 'public' && visibility !== 'private') return refuse('source audience is unknown');
  if ((visibility === 'private') !== descriptor.distribution.encrypted) return refuse('source visibility contradicts observed encryption');
  return { url: descriptor.url, cid: descriptor.cid, audience: visibility, signer: trust.signedBy };
}

/**
 * Capture the full descriptor read set, including history and evidence, before a
 * module can alter its returned objects. Modules cannot forget a privacy source.
 * This is conservative: even a source read only for a guard constrains output.
 * It is not general information-flow tracking of arbitrary external module I/O.
 */
export function protectResourcePublication(
  reads: ResourceReads,
  principal: string,
  publish: (request: Publication, visibility: Audience) => Promise<Record<string, unknown>>,
): { reads: ResourceReads; publish: ResourceWriteContext['publish'] } {
  const sources = new Map<string, Source>();
  let sourceError: string | undefined;
  let pendingReads = 0;
  let publishing = false;
  const protectedReads: ResourceReads = { ...reads, descriptor: async url => {
    if (publishing) {
      sourceError ??= 'source reads cannot start during derived publication';
      return refuse(sourceError);
    }
    pendingReads++;
    try {
      const descriptor = await reads.descriptor(url);
      try {
        if (descriptor.url !== url) refuse('source descriptor resolved to a different resource');
        const source = sourceAudience(descriptor);
        const previous = sources.get(url);
        if (previous && JSON.stringify(previous) !== JSON.stringify(source)) refuse('source descriptor changed during derived publication');
        sources.set(url, source);
      } catch (error) {
        sourceError ??= (error as Error).message;
      }
      return descriptor;
    } finally {
      pendingReads--;
    }
  } };
  return { reads: protectedReads, publish: async input => {
    const request: Publication = Object.freeze({ podUrl: input.podUrl, graphIri: input.graphIri, graphContent: input.graphContent,
      expectedHead: input.expectedHead, actor: input.actor });
    if (publishing || pendingReads) return { error: 'resource_audience_refused', message: 'source reads or publication are still in progress', published: false, committed: false };
    publishing = true;
    // A refusal is known to precede the write, not an uncertain publication.
    try {
      if (!principal || request.actor !== principal) refuse('authenticated resource actor is required');
      if (Object.values(request).some(value => typeof value !== 'string' || !value)) refuse('publication requires explicit string pod, graph, content, actor and expected head');
      if (sourceError) refuse(sourceError);
      if (!sources.size) refuse('derived publication has no verified source audience');
      const head = await reads.currentHead(request.podUrl, request.graphIri);
      if (sourceError) refuse(sourceError);
      if (head.forked || !head.head?.descriptorUrl || head.head.cid !== request.expectedHead) refuse('derived publication predecessor is not the unique expected head');
      const predecessor = sources.get(head.head!.descriptorUrl!);
      if (!predecessor || predecessor.cid !== request.expectedHead) refuse('derived publication predecessor was not read and verified');
      if ([...sources.values()].some(source => source.audience === 'private' && source.signer !== principal)) {
        refuse('private source audience cannot be preserved for a different actor');
      }
    } catch (error) {
      publishing = false;
      return { error: 'resource_audience_refused', message: (error as Error).message, published: false, committed: false };
    }
    const visibility = [...sources.values()].some(source => source.audience === 'private') ? 'private' : 'public';
    try { return await publish(request, visibility); } finally { publishing = false; }
  } };
}
