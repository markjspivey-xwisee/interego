/**
 * Offline fixture adapter for resolveApplicationLab. Real canonical document digests;
 * descriptor CIDs and signature-verifier results are explicitly test doubles.
 * This adapter neither signs nor publishes anything.
 */
import {
  canonicalJson, prepareApplicationAction, resolveApplicationLab, signedJsonGraph,
  type ApplicationLabReads, type ApplicationState, type Json, type LabDescriptor, type LabHead,
  type LabManifestEntry, type PrepareActionInput, type ResolvedApplicationLab,
} from '../../deploy/mcp-relay/application-lab-runtime.js';
import type { RulePack } from './rule-packs.js';

export function fixtureStore(pack: RulePack) {
  const id = pack.contract.applicationId;
  const podUrl = 'https://pod.example/simulation/';
  const graphs = { catalog: `${id}:catalog`, definition: `${id}:definition`, contract: `${id}:contract`, state: `${id}:state` };
  const descriptors = new Map<string, LabDescriptor>();
  const heads = new Map<string, LabHead>();
  const history: LabManifestEntry[] = [];
  let readCount = 0;
  let writeCount = 0;
  const put = (name: string, graphIri: string, documentType: string, document: unknown) => {
    const signed = signedJsonGraph(graphIri, documentType, JSON.parse(canonicalJson(document)) as Record<string, Json>);
    const url = `${podUrl}context-graphs/${name}.ttl`;
    const cid = `fixture-cid-${signed.digest}`;
    descriptors.set(url, { url, cid, content: signed.graphContent, authorship: {
      authorshipVerified: true, contentBinding: 'bound', descriptorBinding: { bound: true, basis: 'offline-fixture' },
      effectiveTrustLevel: 'CryptographicallyVerified', signedBy: 'did:example:fixture', verificationMethod: 'did:example:fixture#key',
    } });
    heads.set(graphIri, { forked: false, head: { descriptorUrl: url, cid } });
    return { descriptorUrl: url, cid, documentDigest: signed.digest, graphIri };
  };
  const definition = put('definition', graphs.definition, 'application-definition', {
    schema: 'interego.application.definition/v1', id, title: id, stateGraphIri: graphs.state, contractGraphIri: graphs.contract,
  });
  const contract = put('contract', graphs.contract, 'application-contract', pack.contract);
  const genesis = put('state-0', graphs.state, 'application-state', {
    schema: 'interego.application.state/v1', applicationId: id, version: 0, data: pack.initialData,
  });
  history.push({ descriptorUrl: genesis.descriptorUrl, cid: genesis.cid });
  const catalog = put('catalog', graphs.catalog, 'application-catalog', {
    schema: 'interego.application.catalog/v1', id: graphs.catalog, version: 1, applications: [{
      applicationId: id, contractGraphIri: graphs.contract, definitionGraphIri: graphs.definition,
      definitionDescriptorUrl: definition.descriptorUrl, stateGraphIri: graphs.state,
      manifestCids: { contract, definition, genesisState: genesis },
    }],
  });
  const reads: ApplicationLabReads = {
    discoverCatalogs: async () => { readCount++; return [{ podUrl, entry: catalog }]; },
    currentHead: async (_pod, graph) => { readCount++; return heads.get(graph) ?? { head: null }; },
    discoverGraph: async (_pod, graph) => { readCount++; return graph === graphs.state ? history : []; },
    descriptor: async url => {
      readCount++;
      const descriptor = descriptors.get(url);
      if (!descriptor) throw new Error(`missing fixture descriptor: ${url}`);
      return descriptor;
    },
  };
  const resolve = (actor = 'did:example:alice') => resolveApplicationLab({
    applicationId: id, actor, podUrl, catalogGraphIri: graphs.catalog, catalogDescriptorUrl: catalog.descriptorUrl,
  }, reads);
  // This intentionally explicit test-only write lets acceptance tests exercise full
  // replay after choosing a candidate. Simulation itself never receives this function.
  const record = (resolved: ResolvedApplicationLab, input: PrepareActionInput): ApplicationState => {
    const prepared = prepareApplicationAction(resolved, input);
    const ref = put(`state-${prepared.successor.version}`, graphs.state, 'application-state', prepared.successor);
    history.push({ descriptorUrl: ref.descriptorUrl, cid: ref.cid, supersedes: [resolved.stateHead.descriptorUrl] });
    writeCount++;
    return prepared.successor;
  };
  return { resolve, record, reads, graphs, descriptors, heads, history,
    counts: () => ({ reads: readCount, writes: writeCount }) };
}
