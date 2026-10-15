/**
 * The four directory actions share real authenticated effects, rather than success-shaped stubs.
 * Authentication/tenant and course authorization are supplied by the bridge's existing gates.
 * Payloads are encrypted to a signature-bound owner key and the stable bridge key; no unsigned
 * key discovery, fallback to plaintext, automatic completion, scheduler, or credential issuance.
 */
import { createHash } from 'node:crypto';
import { Parser, type Quad } from 'n3';
import { ContextDescriptor, CGProp, CG, openEncryptedEnvelope, type FetchFn, type EncryptedEnvelope, type IRI, type ContextDescriptorData, type EncryptionKeyPair } from '@interego/core';
import { publish, fetchGraphContent } from '@interego/solid';
import { loadControlSet } from '@interego/compliance';
import { buildAgentActionDescriptor } from '../../../integrations/compliance-overlay/src/overlay.js';
import type { VerifyPrivateCaller } from './private-performance-auth.js';
import type { FoxxiAgenticPayload } from './agentic-rag.js';
import { hasControlChars } from './subject-pod-url.js';
import { ownerKeyBinding } from './i2idlx-workbench.js';
import { guardedFetchFn, assertSafeFetchTarget } from './ssrf-guard.js';
import { iesc, tesc } from './turtle-escape.js';

export type DirectoryAction = 'consume_lesson' | 'connect_lms' | 'publish_concept_map' | 'publish_compliance_evidence';
export interface ActionAuthority {
  actor: string;
  /** Already authorized exact target, never an unchecked request URL. */
  pod: string;
  /** ONLY the recovered signature-covered payload, no unsigned envelope properties. */
  payload: Record<string, unknown>;
}
export interface ConfiguredLms {
  id: string;
  /** Exact canonical own pod whose verified owner may use these server-held credentials. */
  ownerPod: string;
  product: string;
  instance: string;
  /** Exact operator-configured authenticated JSON API GET, never caller-selected. */
  probeUrl: string;
  authorization: string;
  authMethod: string;
  /** Fields identifying the authenticated account returned by the configured API. */
  identityPath: readonly string[];
  expectedIdentity: string;
}
export interface DirectoryActionConfig {
  authorize: (action: DirectoryAction, envelope: Record<string, unknown>) => Promise<ActionAuthority>;
  /** Must enforce course access and hydrate the real pod package; never accept inline course data. */
  course: (authority: ActionAuthority, courseIri: string) => Promise<FoxxiAgenticPayload | null>;
  fetch: typeof fetch;
  encryptionKeypair: () => EncryptionKeyPair | null;
  configuredLms?: () => readonly ConfiguredLms[];
}
export class DirectoryActionError extends Error {
  constructor(message: string, readonly status = 400, readonly effects = 'none') { super(message); }
}
/** Existing signed caller + own-pod/scope gates, composed without reading unsigned outer args. */
export function makeDirectoryActionAuthorizer(config: {
  verifyCaller: VerifyPrivateCaller;
  /** Exact deployment origin bound by the author, never a request header. */
  audience: string;
  ownPod: (actor: string) => string;
  samePod: (a: string | undefined, b: string) => boolean;
}): DirectoryActionConfig['authorize'] {
  return async (action, envelope) => {
    let audience: URL;
    try { audience = new URL(config.audience); }
    catch { throw new DirectoryActionError('Directory actions require an exact HTTPS deployment origin; configure the bridge audience before use', 503); }
    if (audience.origin !== config.audience || audience.username || audience.password || audience.protocol !== 'https:') throw new DirectoryActionError('Directory actions require an exact HTTPS deployment origin; configure the bridge audience before use', 503);
    const read = await config.verifyCaller(envelope, false);
    if (!read.ok) throw new DirectoryActionError(read.error, read.status);
    if (read.payload.bridge_audience !== config.audience) throw new DirectoryActionError('The signed bridge audience does not match this deployment', 403);
    if (read.payload.action !== 'foxxi.' + action) throw new DirectoryActionError('The signed action does not match this directory operation', 403);
    const write = action !== 'consume_lesson' || (read.payload.mode !== undefined && read.payload.mode !== 'load');
    if (write) {
      const checked = await config.verifyCaller(envelope, true);
      if (!checked.ok) throw new DirectoryActionError(checked.error, checked.status);
      if (checked.callerDid !== read.callerDid || JSON.stringify(checked.payload) !== JSON.stringify(read.payload)) throw new DirectoryActionError('The authenticated request changed during scope verification', 403);
    }
    let pod: string;
    try { pod = config.ownPod(read.callerDid); } catch { throw new DirectoryActionError('The authenticated caller has no canonical own pod on this deployment', 403); }
    const stamped = read.payload.tenant_pod_url;
    if (stamped !== undefined && (typeof stamped !== 'string' || !config.samePod(stamped, pod))) throw new DirectoryActionError('tenant_pod_url must name the authenticated own pod', 403);
    return { actor: read.callerDid, pod, payload: read.payload };
  };
}
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const PROV = 'http://www.w3.org/ns/prov#';
const DCT = 'http://purl.org/dc/terms/';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const DCAT = 'http://www.w3.org/ns/dcat#';
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function text(v: unknown, field: string, max = 2048): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || hasControlChars(v)) throw new DirectoryActionError(field + ' must be a bounded nonempty string');
  return v.trim();
}
function iri(v: unknown, field: string): string {
  const s = text(v, field);
  if (!/^(https?:\/\/|urn:|did:)[^\s<>"{}|\\^\x60]+$/.test(s)) throw new DirectoryActionError(field + ' must be an absolute IRI');
  return s;
}
function term(t: Quad['subject'] | Quad['predicate'] | Quad['object']): string {
  return JSON.stringify([t.termType, t.value, 'language' in t ? t.language : '', 'datatype' in t ? t.datatype.value : '']);
}
function graphTerms(ttl: string, namedGraph?: string): string[] {
  return [...new Set(new Parser().parse(ttl).filter(q => namedGraph === undefined || q.graph.value === namedGraph).map(q => [term(q.subject), term(q.predicate), term(q.object)].join('|')))].sort();
}
function sameGraph(expected: string, actual: string, graphIri: string): boolean {
  const a = graphTerms(expected), b = graphTerms(actual, graphIri);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function proofOf(envelope: Record<string, unknown>): { _signed_payload: string; _signature: string } {
  if (envelope._session !== undefined) throw new DirectoryActionError('Session-key envelopes are not durable author proofs for directory writes; sign with the established author identity', 401);
  if (typeof envelope._signed_payload !== 'string' || typeof envelope._signature !== 'string') throw new DirectoryActionError('A signed request envelope is required', 401);
  if (envelope._signed_payload.length > 131072 || envelope._signature.length > 2048) throw new DirectoryActionError('Signed request exceeds the supported byte limit', 413);
  return { _signed_payload: envelope._signed_payload, _signature: envelope._signature };
}
async function boundedBody(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new DirectoryActionError('Upstream response has no readable body', 502);
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new DirectoryActionError('Upstream response exceeded the byte limit', 502); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
function descriptor(graph: string, type: string, actor: string, now: string, hypothetical = false): ContextDescriptorData {
  const b = ContextDescriptor.create((graph + '#descriptor') as IRI).describes(graph as IRI)
    .conformsTo(type as IRI).agent(actor as IRI).selfAsserted(actor as IRI)
    .generatedBy(actor as IRI, { endedAt: now }).temporal({ validFrom: now });
  return (hypothetical ? b.hypothetical(0.5) : b.asserted(1)).build();
}
/** Configuration is operator-owned JSON; credentials remain server-side, never in a connection record. */
export function configuredLmsFromEnv(raw: string | undefined): readonly ConfiguredLms[] {
  if (!raw) return [];
  let v: unknown;
  try { v = JSON.parse(raw); } catch { throw new Error('FOXXI_LMS_CONNECTORS must contain valid JSON configuration'); }
  if (!Array.isArray(v) || v.length > 100) throw new Error('FOXXI_LMS_CONNECTORS must be an array of at most 100 configurations');
  const ids = new Set<string>();
  return v.map(entry => {
    if (!object(entry)) throw new Error('Invalid LMS configuration');
    const id = text(entry.id, 'connector id', 80);
    if (!/^[a-zA-Z0-9_-]+$/.test(id) || ids.has(id)) throw new Error('LMS connector ids must be unique safe identifiers');
    ids.add(id);
    const ownerPod = new URL(text(entry.ownerPod, 'ownerPod'));
    if (ownerPod.protocol !== 'https:' || ownerPod.username || ownerPod.password || ownerPod.search || ownerPod.hash
      || !/^\/[A-Za-z0-9_-]+\/$/.test(ownerPod.pathname) || ownerPod.href !== entry.ownerPod) throw new Error('LMS credentials require an exact canonical HTTPS own pod binding');
    const instance = new URL(text(entry.instance, 'instance')), probe = new URL(text(entry.probeUrl, 'probeUrl'));
    if (instance.protocol !== 'https:' || probe.protocol !== 'https:' || instance.origin !== probe.origin
      || instance.username || instance.password || instance.search || instance.hash
      || probe.username || probe.password || probe.hash) throw new Error('LMS probes require the configured HTTPS instance origin');
    return { id, ownerPod: ownerPod.href, product: text(entry.product, 'product', 100), instance: instance.href, probeUrl: probe.href,
      authorization: text(entry.authorization, 'authorization', 8192), authMethod: text(entry.authMethod, 'authMethod', 100),
      identityPath: (() => {
        if (!Array.isArray(entry.identityPath) || !entry.identityPath.length || entry.identityPath.length > 8 || entry.identityPath.some(k => typeof k !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(k))) throw new Error('LMS identityPath must identify a bounded account field');
        return entry.identityPath as string[];
      })(),
      expectedIdentity: text(entry.expectedIdentity, 'expectedIdentity', 500) };
  });
}

export class DirectoryActions {
  constructor(private readonly config: DirectoryActionConfig) {}
  async run(action: DirectoryAction, envelope: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const proof = proofOf(envelope);
      const auth = await this.config.authorize(action, envelope);
      iri(auth.actor, 'authenticated actor');
      const common = ['agent_id', 'timestamp', 'action', 'bridge_audience', 'tenant_pod_url', 'subject_pod_url', 'owner_encryption_key', 'federation_share_with', 'recipient_encryption_keys'];
      const fields: Record<DirectoryAction, readonly string[]> = {
        consume_lesson: ['course_iri', 'learner_did', 'mode', 'advanced_slide_ids', 'lrs_endpoint', 'lrs_auth_header'],
        connect_lms: ['connector_id', 'product', 'instance', 'auth_method', 'sync_frequency'],
        publish_concept_map: ['course_iri', 'federation_share_with', 'recipient_encryption_keys'],
        publish_compliance_evidence: ['event_type', 'event_payload', 'framework', 'controls'],
      };
      if (Object.keys(auth.payload).some(key => !common.includes(key) && !fields[action].includes(key))) throw new DirectoryActionError('The signed payload contains undeclared fields; credentials and unrelated data must remain in your client');
      if (action === 'consume_lesson') return await this.consume(auth, proof);
      if (action === 'connect_lms') return await this.connect(auth, proof);
      if (action === 'publish_concept_map') return await this.conceptMap(auth, proof);
      return await this.compliance(auth, proof);
    } catch (e) {
      const err = e instanceof DirectoryActionError ? e : new DirectoryActionError('A configured source or pod operation failed; no verified success receipt is available', 502, 'unknown');
      return { kind: 'refusal', 'iep:refusalStatus': err.status, 'iep:refusalReason': err.message,
        error: err.message, effects: err.effects, published: false };
    }
  }
  private encryption(auth: ActionAuthority): { recipients: string[]; senderKeyPair: EncryptionKeyPair } {
    const owner = ownerKeyBinding(auth.payload.owner_encryption_key), sender = this.config.encryptionKeypair();
    if (!owner || !sender) throw new DirectoryActionError('Author-signed owner_encryption_key and stable bridge encryption configuration are required; no plaintext or bridge-only fallback', 503);
    if (owner === sender.publicKey) throw new DirectoryActionError('owner_encryption_key must be a distinct owner-held key; bridge-only storage is refused', 400);
    const shares = auth.payload.federation_share_with;
    const bindings = auth.payload.recipient_encryption_keys;
    if (shares !== undefined && (!Array.isArray(shares) || shares.length > 32 || shares.some(v => typeof v !== 'string'))) throw new DirectoryActionError('federation_share_with must be a bounded IRI array');
    const namedShares = shares as string[] | undefined ?? [];
    if (new Set(namedShares).size !== namedShares.length) throw new DirectoryActionError('federation_share_with must not contain duplicate identities');
    if (bindings !== undefined && (!object(bindings) || Object.keys(bindings).length !== namedShares.length
      || Object.entries(bindings).some(([who, key]) => !namedShares.includes(who) || !ownerKeyBinding(key)))) throw new DirectoryActionError('recipient_encryption_keys must contain exactly the declared public recipient bindings');
    const recipients = [owner, sender.publicKey];
    for (const who of namedShares) {
      iri(who, 'recipient');
      const key = object(bindings) ? ownerKeyBinding(bindings[who]) : null;
      if (!key) throw new DirectoryActionError('Every explicit recipient requires its signature-covered recipient_encryption_keys binding');
      recipients.push(key);
    }
    return { recipients: [...new Set(recipients)], senderKeyPair: sender };
  }
  private async save(auth: ActionAuthority, desc: ContextDescriptorData, graph: string) {
    const encrypt = this.encryption(auth);
    await assertSafeFetchTarget(auth.pod);
    const fetch = guardedFetchFn(this.config.fetch);
    const sentEnvelopes = new Map<string, string>();
    const publishingFetch: FetchFn = async (url, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'PUT' && url.endsWith('.envelope.jose.json') && typeof init?.body === 'string') sentEnvelopes.set(url, init.body);
      return fetch(url, init);
    };
    const id = hash(graph + '|' + JSON.stringify(encrypt.recipients)).slice(0, 40);
    const result = await publish(desc, graph, auth.pod, {
      fetch: publishingFetch, containerPath: 'foxxi/work-products/', descriptorSlug: 'action-' + id, graphSlug: 'action-' + id + '-graph',
      encrypt, visibility: encrypt.recipients.length > 2 ? 'shared' : 'private',
    });
    // Read the actual returned locations, constrained to the already authorized exact pod.
    const pod = new URL(auth.pod);
    for (const url of [result.descriptorUrl, result.graphUrl]) {
      const u = new URL(url);
      if (u.origin !== pod.origin || !u.pathname.startsWith(pod.pathname.endsWith('/') ? pod.pathname : pod.pathname + '/')) throw new DirectoryActionError('Publisher returned a resource outside the authorized pod', 502, 'write-attempted');
    }
    const dr = await fetch(result.descriptorUrl, { headers: { Accept: 'text/turtle' } });
    if (!dr.ok) throw new DirectoryActionError('Published descriptor could not be read back', 502, 'write-attempted');
    const dt = new Parser().parse(await dr.text());
    if (!dt.some(q => q.subject.value === desc.id && q.predicate.value === CGProp.describes && q.object.value === desc.describes[0])) throw new DirectoryActionError('Published descriptor identity did not match', 502, 'write-attempted');
    const semiotic = desc.facets.find(f => f.type === 'Semiotic');
    const facets = new Set(dt.filter(q => q.subject.value === desc.id && q.predicate.value === CGProp.hasFacet).map(q => q.object.value));
    const modes = dt.filter(q => facets.has(q.subject.value) && q.predicate.value === CGProp.modalStatus);
    if (semiotic?.type === 'Semiotic' && (modes.length !== 1 || modes[0]!.object.value !== CG + semiotic.modalStatus)) throw new DirectoryActionError('Published descriptor modal status did not match', 502, 'write-attempted');
    const sent = sentEnvelopes.get(result.graphUrl);
    const read = await fetchGraphContent(result.graphUrl, { fetch,
      openEnvelope: (env: EncryptedEnvelope) => {
        const actual = env.wrappedKeys.map(k => k.recipientPublicKey).sort(), expected = [...encrypt.recipients].sort();
        if (env.version !== 1 || env.algorithm !== 'X25519-XSalsa20-Poly1305' || actual.length !== expected.length
          || actual.some((key, i) => key !== expected[i]) || !sent || JSON.stringify(env) !== JSON.stringify(JSON.parse(sent))) throw new DirectoryActionError('Published encrypted recipient bindings or ciphertext changed during readback', 502, 'write-attempted');
        return openEncryptedEnvelope(env, encrypt.senderKeyPair);
      },
    });
    if (!read.encrypted || !read.content || !sameGraph(graph, read.content, desc.describes[0]!)) throw new DirectoryActionError('Encrypted published graph failed exact RDF readback', 502, 'write-attempted');
    return { published: true, encrypted: true, readbackVerified: true, ...result,
      graphIri: desc.describes[0], trustLevel: 'SelfAsserted', authorship: 'signed request retained inside encrypted graph' };
  }
  private async source(auth: ActionAuthority): Promise<FoxxiAgenticPayload> {
    const requested = iri(auth.payload.course_iri, 'course_iri');
    const course = await this.config.course(auth, requested);
    if (!course) throw new DirectoryActionError('No accessible published course package for course_iri', 404);
    const actual = course.packageMeta.federation_iri_base + '#package';
    if (actual !== requested) throw new DirectoryActionError('Published course identity does not match requested course_iri', 409);
    if (!Array.isArray(course.slides) || !Array.isArray(course.concepts) || course.slides.length > 10000 || course.concepts.length > 10000) throw new DirectoryActionError('Published course exceeds supported package bounds', 413);
    return course;
  }
  private async consume(auth: ActionAuthority, proof: { _signed_payload: string; _signature: string }) {
    if (auth.payload.lrs_endpoint || auth.payload.lrs_auth_header) throw new DirectoryActionError('Arbitrary LRS forwarding is refused; configure the existing authenticated LRS forwarding capability separately');
    if (auth.payload.learner_did && auth.payload.learner_did !== auth.actor) throw new DirectoryActionError('learner_did must be the authenticated caller', 403);
    const course = await this.source(auth);
    const mode = auth.payload.mode ?? 'load';
    if (mode !== 'load' && mode !== 'record-progress') throw new DirectoryActionError('mode must be load or record-progress');
    const lesson = { courseIri: course.packageMeta.federation_iri_base + '#package', title: course.packageMeta.title,
      slides: [...course.slides].sort((a, b) => a.sequence_index - b.sequence_index) };
    if (mode === 'load') return { lesson, loaded: true, consumed: false, completed: false, writesPerformed: false,
      recording: 'none', next: 'Rendering a lesson does not establish consumption; record-progress accepts only your signed self-report.' };
    const advanced = auth.payload.advanced_slide_ids;
    if (!Array.isArray(advanced) || advanced.length === 0 || advanced.length > 10000 || advanced.some(id => typeof id !== 'string')
      || new Set(advanced).size !== advanced.length) throw new DirectoryActionError('advanced_slide_ids must be a nonempty unique slide-id array');
    const available = new Set(course.slides.map(s => s.id));
    if (advanced.some(id => !available.has(id))) throw new DirectoryActionError('A reported slide is not in the published course');
    const now = new Date().toISOString();
    const report = { actor: auth.actor, courseIri: lesson.courseIri, advanced_slide_ids: advanced,
      source: 'caller-self-report', completed: false, proof };
    const graphIri = auth.pod.replace(/\/$/, '') + '/foxxi/lesson-report/' + hash(JSON.stringify(report));
    const graph = '<' + iesc(graphIri) + '> a <' + PROV + 'Activity> ; <' + PROV + 'wasAttributedTo> <' + iesc(auth.actor)
      + '> ; <' + DCT + 'subject> <' + iesc(lesson.courseIri) + '> ; <' + RDF + 'value> "' + tesc(JSON.stringify(report)) + '" .';
    const saved = await this.save(auth, descriptor(graphIri, PROV + 'Activity', auth.actor, now, true), graph);
    return { ...saved, loaded: true, consumed: false, completed: false, source: 'caller-self-report', modalStatus: 'Hypothetical',
      advancedSlideIds: advanced, xapiStatementIds: [], lesson, note: 'Saved the authenticated progress claim; no completion, achievement, credential or forwarded xAPI statement was created.' };
  }
  private async conceptMap(auth: ActionAuthority, proof: { _signed_payload: string; _signature: string }) {
    const course = await this.source(auth);
    this.encryption(auth);
    const courseIri = course.packageMeta.federation_iri_base + '#package', map = course.packageMeta.federation_iri_base + '#concept-map';
    const conceptIri = (id: string) => course.packageMeta.federation_iri_base + '#concept-' + encodeURIComponent(id);
    const lines = ['<' + iesc(map) + '> a <' + SKOS + 'ConceptScheme> ; <' + DCT + 'source> <' + iesc(courseIri)
      + '> ; <' + DCT + 'title> "' + tesc(course.packageMeta.title) + '" ; <' + RDF + 'value> "' + tesc(JSON.stringify({ proof,
        concepts: course.concepts, prereq_edges: course.prereq_edges ?? [], modifier_pairs: course.modifier_pairs ?? [] })) + '" .'];
    const ids = new Set(course.concepts.map(c => c.id));
    for (const c of course.concepts) {
      lines.push('<' + iesc(conceptIri(c.id)) + '> a <' + SKOS + 'Concept> ; <' + SKOS + 'inScheme> <' + iesc(map)
        + '> ; <' + SKOS + 'prefLabel> "' + tesc(c.label) + '" ; <' + DCT + 'identifier> "' + tesc(c.id) + '" .');
    }
    for (const edge of course.prereq_edges ?? []) {
      if (!ids.has(edge.from) || !ids.has(edge.to)) throw new DirectoryActionError('Published prerequisite edge names a missing concept', 422);
      lines.push('<' + iesc(conceptIri(edge.to)) + '> <' + DCT + 'requires> <' + iesc(conceptIri(edge.from)) + '> .');
    }
    const graph = lines.join('\n');
    const saved = await this.save(auth, descriptor(map, SKOS + 'ConceptScheme', auth.actor, new Date().toISOString()), graph);
    return { ...saved, courseIri, conceptCount: course.concepts.length, prerequisiteCount: course.prereq_edges?.length ?? 0,
      sharedWith: auth.payload.federation_share_with ?? [], note: 'Published extracted concepts and their source relations; this is not a validation or mastery assertion.' };
  }
  private async compliance(auth: ActionAuthority, proof: { _signed_payload: string; _signature: string }) {
    this.encryption(auth);
    const eventType = text(auth.payload.event_type, 'event_type', 40);
    if (!['assignment-created', 'completion', 'exception', 'audit-action'].includes(eventType)) throw new DirectoryActionError('Unsupported event_type');
    const payload = auth.payload.event_payload;
    if (!object(payload) || Object.keys(payload).length === 0 || JSON.stringify(payload).length > 64000) throw new DirectoryActionError('event_payload must be a nonempty bounded object');
    if (eventType === 'completion' || eventType === 'assignment-created') {
      text(payload.user_id, 'event_payload.user_id', 500);
      iri(payload.course_iri, 'event_payload.course_iri');
      const field = eventType === 'completion' ? 'completed_at' : 'due_at';
      const when = text(payload[field], 'event_payload.' + field, 80);
      if (!/^\d{4}-\d{2}-\d{2}T/.test(when) || !Number.isFinite(Date.parse(when))) throw new DirectoryActionError('event_payload.' + field + ' must be an ISO timestamp');
    } else if (eventType === 'exception') {
      text(payload.reason, 'event_payload.reason', 4000);
    } else {
      text(payload.action, 'event_payload.action', 4000);
    }
    const framework = auth.payload.framework ?? 'soc2';
    if (framework !== 'soc2' && framework !== 'eu-ai-act' && framework !== 'nist-rmf') throw new DirectoryActionError('Unsupported compliance framework');
    const controls = auth.payload.controls;
    if (controls !== undefined && (!Array.isArray(controls) || controls.length > 100 || controls.some(c => typeof c !== 'string'))) throw new DirectoryActionError('controls must be a bounded IRI array');
    const validControls = new Set(loadControlSet(framework).controls.map(c => c.iri as string));
    for (const c of controls as string[] | undefined ?? []) { if (!validControls.has(iri(c, 'control'))) throw new DirectoryActionError('Control is not in the published framework control set'); }
    // A caller's submitted historical event is evidence of THEIR CLAIM. It is not independent
    // proof of completion or a finding that a regulatory control was met.
    const built = buildAgentActionDescriptor({ toolName: 'foxxi.' + eventType, agentDid: auth.actor as IRI,
      args: { event_type: eventType, event_payload: payload, source: 'caller-reported', proof },
      outcome: 'partial', resultSummary: 'Authenticated caller-reported event, not independently verified; no credential or control satisfaction is asserted.',
      startedAt: new Date().toISOString(),
    }, { framework, controls: controls as IRI[] | undefined });
    const saved = await this.save(auth, built.descriptor, built.graphContent);
    return { ...saved, eventIri: built.eventIri, cited: built.cited, modalStatus: 'Hypothetical',
      evidenceSource: 'authenticated-caller-report', independentlyVerified: false, complianceSatisfied: false, credentialIssued: false };
  }
  private async connect(auth: ActionAuthority, proof: { _signed_payload: string; _signature: string }) {
    this.encryption(auth);
    const id = text(auth.payload.connector_id, 'connector_id', 80);
    let configured: ConfiguredLms | undefined;
    try { configured = this.config.configuredLms?.().find(c => c.id === id); }
    catch { throw new DirectoryActionError('Operator LMS connector configuration is invalid or unavailable', 503); }
    if (!configured) throw new DirectoryActionError('Connector is not configured. The operator must configure FOXXI_LMS_CONNECTORS with an exact HTTPS API probe and server-held authorization.', 503);
    for (const [field, actual] of [['product', configured.product], ['instance', configured.instance], ['auth_method', configured.authMethod]] as const) {
      if (auth.payload[field] !== actual) throw new DirectoryActionError(field + ' must match the operator-configured connector');
    }
    // Reject all caller credential/target overrides, including otherwise plausible aliases.
    if (['authorization', 'api_key', 'password', 'probe_url', 'probeUrl', 'credential'].some(k => k in auth.payload)) throw new DirectoryActionError('LMS credentials and probe targets are operator-configured, never request-supplied');
    if (auth.payload.sync_frequency && auth.payload.sync_frequency !== 'manual') throw new DirectoryActionError('This connector performs authenticated verification only; sync_frequency must be manual');
    let validated: ConfiguredLms;
    try { validated = configuredLmsFromEnv(JSON.stringify([configured]))[0]!; }
    catch { throw new DirectoryActionError('Operator LMS connector configuration requires an exact canonical HTTPS own pod and authenticated probe binding', 503); }
    if (auth.pod !== validated.ownerPod) throw new DirectoryActionError('This configured LMS connector is not authorized for the authenticated own pod', 403);
    await assertSafeFetchTarget(validated.probeUrl);
    const f = guardedFetchFn(this.config.fetch);
    const res = await f(validated.probeUrl, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(10000),
      headers: { Authorization: validated.authorization, Accept: 'application/json' } });
    if (!res.ok || res.status >= 300) throw new DirectoryActionError('Configured LMS authenticated API probe failed (HTTP ' + res.status + '); no connection artifact published', 502);
    if (!(res.headers.get('content-type') ?? '').includes('json')) throw new DirectoryActionError('Configured LMS probe did not return JSON', 502);
    const body = await boundedBody(res as unknown as Response, 262144);
    let identity: unknown;
    try { identity = JSON.parse(body); } catch { throw new DirectoryActionError('Configured LMS probe returned invalid JSON', 502); }
    for (const field of validated.identityPath) identity = object(identity) ? identity[field] : undefined;
    if ((typeof identity !== 'string' && typeof identity !== 'number') || String(identity) !== validated.expectedIdentity) throw new DirectoryActionError('Configured LMS API did not identify the expected authenticated account; no connection artifact published', 502);
    const report = { connector_id: id, product: validated.product, instance: validated.instance, auth_method: validated.authMethod,
      checkedAt: new Date().toISOString(), probeStatus: res.status, authenticatedProbe: true, syncScheduled: false, sync_frequency: 'manual', proof };
    const graphIri = auth.pod.replace(/\/$/, '') + '/foxxi/lms-connection/' + hash(JSON.stringify(report));
    const graph = '<' + iesc(graphIri) + '> a <' + DCAT + 'DataService> ; <' + DCT + 'title> "' + tesc(validated.product)
      + '" ; <' + DCAT + 'endpointURL> <' + iesc(validated.instance) + '> ; <' + RDF + 'value> "' + tesc(JSON.stringify(report)) + '" .';
    const saved = await this.save(auth, descriptor(graphIri, DCAT + 'DataService', auth.actor, report.checkedAt), graph);
    return { ...saved, ...report, proof: undefined, credentialsPersisted: false, remotePayloadPersisted: false,
      note: 'Authenticated API probe verified and its non-secret connection artifact read back. No synchronization job was scheduled.' };
  }
}
