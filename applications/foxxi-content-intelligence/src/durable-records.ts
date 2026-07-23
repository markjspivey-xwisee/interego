/**
 * durable-records.ts — self-sovereign durability for agent-authored Foxxi
 * artifacts: recorded xAPI Statements (performance, course completion,
 * agentic-SCORM outcomes) AND authored agentic-SCORM courses.
 *
 * WHY: the `lens:<agent>` LRS tenants are DERIVED, in-memory views,
 * re-projected from the agent's pod each cycle — never the system of record
 * (see xapi-lrs.ts). An agent's recorded performance must therefore live on
 * the agent's OWN pod to survive a restart and stay self-sovereign. The
 * in-memory lens write alone is ephemeral.
 *
 * HOW: each Statement is published to the agent's pod as a
 * `foxxi:RecordedPerformance` descriptor whose graph embeds the FULL Statement
 * JSON (with result/score/success) as a base64 literal — the SAME mechanism
 * `credentials.ts` uses for VCs, and authenticated by the SAME tenant-origin
 * pod-write wrapper (agent pods are `eth-<addr>` on the tenant origin). On
 * read, the ELR composes these durable records back. The mesh projector SKIPS
 * this type, so the durable read is the SINGLE source of these statements (no
 * double-count, no bogus competency keyed off the envelope type).
 */
import { publish, discover, fetchGraphContent, resolveStorageForShape } from '@interego/solid';
import { assertSafeFetchTarget } from "./ssrf-guard.js";
import type { ContextDescriptorData, IRI, ManifestEntry, FetchFn } from '@interego/core';
// Foundation-first (additive): also persist an encrypted canonical PGSL holon +
// a projected descriptor alongside the authoritative RDF record, so agents get
// both altitudes (encrypted PGSL + discoverable RDF). The holon is built via the
// Foxxi-vertical xAPI ingestion profile. The shared altitude helper owns the
// encryption keypair + best-effort semantics (also used by credentials.ts).
import { ingest, ingestWithProfile } from '@interego/pgsl';
import { alsoPersistEncryptedHolon } from './foundation-holon-altitude.js';
import { FOXXI_NS } from './foxxi-vocab.js';
import { validateStatement } from './xapi-validate.js';
import { tesc, iesc } from './turtle-escape.js';

const FXS = FOXXI_NS;
export const RECORDED_PERFORMANCE_TYPE = `${FXS}RecordedPerformance` as IRI;
export const SCORM_COURSE_TYPE = `${FXS}ScormCourse` as IRI;
/** Local names the mesh projector skips (durable Foxxi artifacts, not
 *  performances) and the durable reads match on. */
export const RECORDED_PERFORMANCE_LOCALNAME = 'RecordedPerformance';
export const SCORM_COURSE_LOCALNAME = 'ScormCourse';
/** Foxxi-native durable artifact types the domain-agnostic mesh projector must
 *  NOT turn into performed statements (they'd mint bogus competencies). */
export const NON_PROJECTABLE_LOCALNAMES = new Set([RECORDED_PERFORMANCE_LOCALNAME, SCORM_COURSE_LOCALNAME]);

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'rec';
}

function localName(iri: string): string {
  return iri.split(/[#/]/).pop() ?? '';
}

export interface PersistRecordArgs {
  /** The agent's OWN pod (system of record) — e.g. resolveSubjectPodUrl(callerDid). */
  podUrl: string;
  /** The agent the record is attributed to (the performer/subject). */
  agentDid: string;
  /** The xAPI Statement to persist. MUST carry an `id` (assign before calling). */
  statement: Record<string, unknown>;
  fetch?: FetchFn;
  /** Additional recipient pods (beyond owner+bridge) for the encrypted canonical
   *  holon — each resolved via its durable `keys/encryption.json`, for cross-seat
   *  owner-decrypt. Best-effort: unresolved recipients are skipped. */
  recipientPods?: readonly string[];
}

/**
 * Confidentiality (option A): strip free-text / potentially-sensitive content
 * from an xAPI statement, leaving only interop-safe STRUCTURAL metadata, for the
 * CLEARTEXT RDF record written when the canonical content is encrypted to
 * specific recipients. The FULL statement is preserved in the encrypted holon.
 * Rationale: the public `statementJson` is base64 — encoding, NOT encryption —
 * so without this an "encrypted" record's content stays world-readable in the
 * clear. Kept: actor, verb, object.id, result.success/score, timestamp,
 * operational context kinds. Stripped: object.definition free-text (name/
 * description), result.response, non-operational extensions.
 */
function redactStatementForPublic(stmt: Record<string, unknown>): Record<string, unknown> {
  const s = JSON.parse(JSON.stringify(stmt)) as Record<string, unknown>;
  const obj = s.object as Record<string, unknown> | undefined;
  if (obj && typeof obj === 'object') {
    const def = obj.definition as Record<string, unknown> | undefined;
    obj.definition = {
      ...(def && def.type ? { type: def.type } : {}),
      name: { en: '[redacted — confidential; full statement in the encrypted canonical holon (iep:encryptedHolon)]' },
    };
  }
  const res = s.result as Record<string, unknown> | undefined;
  if (res && typeof res === 'object' && 'response' in res) delete res.response;
  const ctx = (s.context as Record<string, unknown> | undefined) ?? {};
  const srcExt = (ctx.extensions as Record<string, unknown> | undefined) ?? {};
  const ext: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(srcExt)) {
    if (/#(actorKind|contextKind|observedBy)$/.test(k)) ext[k] = v;
  }
  ext[`${FXS}redacted`] = true;
  s.context = { ...ctx, extensions: ext };
  return s;
}

/**
 * Persist one recorded xAPI Statement to the agent's own pod as a durable
 * `foxxi:RecordedPerformance` descriptor. Idempotent on the Statement id —
 * a re-persist overwrites the same descriptor/graph slug. Returns the
 * descriptor IRI.
 */
export async function persistRecordedStatement(args: PersistRecordArgs): Promise<string> {
  const stmtId = String((args.statement as { id?: unknown }).id ?? '');
  if (!stmtId) throw new Error('persistRecordedStatement: statement.id is required');
  // No emit path may durably persist a non-conformant xAPI Statement to the pod
  // system-of-record (defense-in-depth alongside the LRS + handler gates).
  const vErrs = validateStatement(args.statement);
  if (vErrs.length) throw new Error(`persistRecordedStatement: refusing non-conformant statement — ${vErrs.slice(0, 3).join('; ')}`);
  const key = slug(stmtId);
  const now = new Date().toISOString();
  const hasRecipients = !!(args.recipientPods && args.recipientPods.length);

  // Resolve placement FIRST so the record's ids are dereferenceable pod URLs — the
  // exact URLs publish() writes to — not a bare urn:foxxi:record: (everything-is-a-URL).
  // Shape-driven: where does THIS agent store performance records? default foxxi-records/.
  const place = await resolveStorageForShape(args.podUrl, RECORDED_PERFORMANCE_TYPE, { fetch: args.fetch, defaultContainer: 'foxxi-records/' });
  const containerPath = place.target.startsWith(place.podRoot) ? place.target.slice(place.podRoot.length) : 'foxxi-records/';
  const container = place.podRoot + (containerPath.endsWith('/') ? containerPath : `${containerPath}/`);
  // publish() lands the descriptor at <container><slug>.ttl and the graph at
  // <container><slug>-graph.trig (plaintext) / .envelope.jose.json (encrypted).
  const graphDocUrl = `${container}rec-${key}-graph.${hasRecipients ? 'envelope.jose.json' : 'trig'}`;
  const graphIri = `${graphDocUrl}#record` as IRI;
  const descriptorId = `${container}rec-${key}.ttl#descriptor` as IRI;

  const descriptor: ContextDescriptorData = {
    id: descriptorId,
    describes: [graphIri],
    conformsTo: [RECORDED_PERFORMANCE_TYPE],
    facets: [
      { type: 'Temporal', validFrom: now },
      { type: 'Provenance', wasAttributedTo: args.agentDid as IRI },
      { type: 'Agent', assertingAgent: { identity: args.agentDid as IRI } },
      { type: 'Semiotic', modalStatus: 'Asserted' },
    ],
  };

  // When the canonical content is encrypted to specific recipients, the public
  // cleartext record is REDACTED to structural metadata only (option A); the
  // full statement is preserved in the encrypted holon below.
  const publicStatement = hasRecipients ? redactStatementForPublic(args.statement) : args.statement;
  const json = JSON.stringify(publicStatement);
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  const graphContent = `<${iesc(graphIri)}> a <${RECORDED_PERFORMANCE_TYPE}> ;
    <http://www.w3.org/ns/prov#wasAttributedTo> <${iesc(args.agentDid)}> ;
    <http://purl.org/dc/terms/identifier> "${tesc(stmtId)}" ;
    <${FXS}statementJson> "${b64}"^^<http://www.w3.org/2001/XMLSchema#base64Binary> .
`;

  await publish(descriptor, graphContent, place.podRoot, {
    fetch: args.fetch,
    containerPath,
    descriptorSlug: `rec-${key}`,
    graphSlug: `rec-${key}-graph`,
  });

  // Additive: encrypted canonical PGSL holon (built via the Foxxi xAPI profile)
  // + projected descriptor, alongside the RDF record above. Best-effort.
  void alsoPersistEncryptedHolon({
    podUrl: args.podUrl,
    agentDid: args.agentDid,
    shapeClass: RECORDED_PERFORMANCE_TYPE,
    defaultContainer: 'foxxi-records/',
    fetch: args.fetch,
    ...(args.recipientPods && args.recipientPods.length ? { additionalRecipientPods: args.recipientPods } : {}),
    build: (pgsl, prov) => {
      try { return ingestWithProfile(pgsl, 'xapi', args.statement, prov); }
      catch { return ingest(pgsl, [stmtId], prov); }
    },
  });

  return descriptorId;
}

export interface ReadRecordsArgs {
  /** The agent's own pod to read durable records from. */
  podUrl: string;
  fetch?: FetchFn;
}

/**
 * Read all durable `foxxi:RecordedPerformance` Statements from an agent's pod.
 * Mirrors the CLR credential-read path (discover → descriptor → graph → decode
 * the base64 Statement JSON). Best-effort per record: a malformed or
 * unreadable row is skipped, never throwing the whole read. Returns [] if the
 * pod is unreachable, so a degraded read never breaks an ELR assembly.
 */
export async function readDurableRecordedStatements(args: ReadRecordsArgs): Promise<Record<string, unknown>[]> {
  let entries: ManifestEntry[];
  try {
    entries = (await discover(
      args.podUrl,
      undefined,
      args.fetch ? { fetch: args.fetch as never } : undefined,
    )) as ManifestEntry[];
  } catch {
    return [];
  }

  const recs = entries.filter(e =>
    (e.conformsTo ?? []).some(c => localName(c) === RECORDED_PERFORMANCE_LOCALNAME));
  const fetchFn = (args.fetch ?? globalThis.fetch) as typeof globalThis.fetch;
  const out: Record<string, unknown>[] = [];

  for (const e of recs) {
    try {
      if (!e.descriptorUrl) continue;
      await assertSafeFetchTarget(e.descriptorUrl); // 2nd-hop SSRF
      const descRes = await fetchFn(e.descriptorUrl, { headers: { Accept: 'text/turtle' } });
      if (!descRes.ok) continue;
      const descTurtle = await descRes.text();
      const gm = descTurtle.match(/hydra:target\s+<([^>]+)>/) ?? descTurtle.match(/dcat:accessURL\s+<([^>]+)>/);
      const graphUrl = gm?.[1];
      if (!graphUrl) continue;
      await assertSafeFetchTarget(graphUrl); // 2nd-hop SSRF
      const { content } = await fetchGraphContent(
        graphUrl,
        args.fetch ? { fetch: args.fetch as never } : undefined,
      );
      if (!content) continue;
      const m = content.match(/<[^>]*#statementJson>\s+"([A-Za-z0-9+/=\s]+)"/);
      if (!m) continue;
      const stmtJson = Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8');
      out.push(JSON.parse(stmtJson) as Record<string, unknown>);
    } catch {
      continue;
    }
  }
  return out;
}

/** Minimal structural mirror of xapi-lrs `StoredStatement` — the wrapper the
 *  ELR consumes (it reads `.statement`). Kept local so this module doesn't
 *  depend on the LRS store's types. */
export interface StoredStatementLike {
  id: string;
  statement: Record<string, unknown>;
  stored: string;
  voided: boolean;
}

/**
 * Merge the in-memory lens view (already-wrapped StoredStatements) with durable
 * pod records (raw xAPI Statements), deduped by Statement id. The lens copy and
 * the pod copy of the same record share an id, so the union is the lens plus
 * any pod records the lens has lost — e.g. after a restart that emptied it.
 * Durable raw Statements are wrapped into the StoredStatement shape so the ELR
 * consumes them uniformly. Records without an id are always kept.
 */
export function mergeStatementsById(
  lensStatements: StoredStatementLike[],
  durableRaw: Record<string, unknown>[],
): StoredStatementLike[] {
  const seen = new Set<string>();
  const out: StoredStatementLike[] = [];
  for (const s of lensStatements) {
    const id = String(s.id ?? '');
    const key = id || `anon:${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  for (const raw of durableRaw) {
    const id = String((raw as { id?: unknown }).id ?? '');
    const key = id || `anon:${out.length}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      id: id || key,
      statement: raw,
      stored: String((raw as { stored?: unknown }).stored ?? (raw as { timestamp?: unknown }).timestamp ?? ''),
      voided: false,
    });
  }
  return out;
}

// ── Authored agentic-SCORM courses ──────────────────────────────────────────
// An authored course is a real, self-sovereign artifact — persisted to the
// author's pod, addressable by a stable IRI, and dereferenceable (the in-memory
// catalog is a cache, the pod is the system of record). The stored course
// carries assessment answers HASHED, never plaintext: pod resources are
// world-readable, so the bridge grades by hash compare rather than leak the key.

export interface PersistScormCourseArgs {
  /** The author's OWN pod. */
  podUrl: string;
  authorDid: string;
  /** Stable id used to address the course (slugged into the descriptor IRI). */
  courseId: string;
  /** The course payload (AgentScormCourse shape; assessment answers already hashed). */
  course: Record<string, unknown>;
  fetch?: FetchFn;
}

/** Persist an authored SCORM course to the author's pod as an addressable
 *  `foxxi:ScormCourse` descriptor. Idempotent on courseId. Returns the IRI. */
export async function persistScormCourse(args: PersistScormCourseArgs): Promise<string> {
  const key = slug(args.courseId);
  const graphIri = `urn:foxxi:scorm-course:${key}` as IRI;
  const now = new Date().toISOString();
  const descriptor: ContextDescriptorData = {
    id: `${graphIri}#descriptor` as IRI,
    describes: [graphIri],
    conformsTo: [SCORM_COURSE_TYPE],
    facets: [
      { type: 'Temporal', validFrom: now },
      { type: 'Provenance', wasAttributedTo: args.authorDid as IRI },
      { type: 'Agent', assertingAgent: { identity: args.authorDid as IRI } },
      { type: 'Semiotic', modalStatus: 'Asserted' },
    ],
  };
  const b64 = Buffer.from(JSON.stringify(args.course), 'utf8').toString('base64');
  const graphContent = `<${iesc(graphIri)}> a <${SCORM_COURSE_TYPE}> ;
    <http://www.w3.org/ns/prov#wasAttributedTo> <${iesc(args.authorDid)}> ;
    <http://purl.org/dc/terms/identifier> "${tesc(args.courseId)}" ;
    <${FXS}courseJson> "${b64}"^^<http://www.w3.org/2001/XMLSchema#base64Binary> .
`;
  // Shape-driven placement: where does THIS author store SCORM courses
  // (ScormCourse shape)? Read their own Type Index; default foxxi-courses/.
  const place = await resolveStorageForShape(args.podUrl, SCORM_COURSE_TYPE, { fetch: args.fetch, defaultContainer: 'foxxi-courses/' });
  const containerPath = place.target.startsWith(place.podRoot) ? place.target.slice(place.podRoot.length) : 'foxxi-courses/';
  await publish(descriptor, graphContent, place.podRoot, {
    fetch: args.fetch,
    containerPath,
    descriptorSlug: `scorm-${key}`,
    graphSlug: `scorm-${key}-graph`,
  });

  // Additive: encrypted canonical PGSL holon (structural: courseId + title) +
  // projected descriptor, alongside the RDF course above. Best-effort.
  void alsoPersistEncryptedHolon({
    podUrl: args.podUrl,
    agentDid: args.authorDid,
    shapeClass: SCORM_COURSE_TYPE,
    defaultContainer: 'foxxi-courses/',
    fetch: args.fetch,
    build: (pgsl, prov) => {
      const title = String((args.course as { title?: unknown }).title ?? '');
      const chain = [args.courseId, ...title.split(/\s+/).filter(Boolean)];
      return ingest(pgsl, chain.length ? chain : [args.courseId], prov);
    },
  });

  return `${graphIri}#descriptor`;
}

export interface LoadScormCourseArgs {
  /** The pod to load the course from (the author's pod). */
  podUrl: string;
  courseId: string;
  fetch?: FetchFn;
}

/** Load an authored SCORM course from a pod by courseId. Returns the decoded
 *  course payload, or null if not found / unreadable. */
export async function loadScormCourse(args: LoadScormCourseArgs): Promise<Record<string, unknown> | null> {
  const entries = await discoverCourseEntries(args.podUrl, args.fetch);
  const key = slug(args.courseId);
  // Narrow to the one course's descriptor before decoding any of them.
  const recs = entries.filter(e => e.descriptorUrl!.includes(`scorm-${key}`));
  for (const e of recs) {
    const course = await decodeCourseEntry(e, args.fetch);
    if (course && String(course.courseId ?? '') === args.courseId) return course;
  }
  return null;
}

/** Every authored SCORM course durably recorded on a pod — the same discover +
 *  decode path loadScormCourse uses, minus the courseId filter, so a CATALOG can
 *  be rebuilt from durable state instead of being held in memory. Best-effort:
 *  an entry that won't decode is skipped, never fatal. */
export async function listScormCourses(args: { podUrl: string; fetch?: FetchFn }): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  for (const e of await discoverCourseEntries(args.podUrl, args.fetch)) {
    const course = await decodeCourseEntry(e, args.fetch);
    if (course && typeof course.courseId === 'string' && course.courseId) out.push(course);
  }
  return out;
}

/** Pod manifest entries that are SCORM-course records with a descriptor. */
async function discoverCourseEntries(podUrl: string, fetchFn?: FetchFn): Promise<Array<ManifestEntry & { descriptorUrl: string }>> {
  let entries: ManifestEntry[];
  try {
    entries = (await discover(podUrl, undefined, fetchFn ? { fetch: fetchFn as never } : undefined)) as ManifestEntry[];
  } catch {
    return [];
  }
  return entries.filter((e): e is ManifestEntry & { descriptorUrl: string } =>
    (e.conformsTo ?? []).some(c => localName(c) === SCORM_COURSE_LOCALNAME) && !!e.descriptorUrl);
}

/** Follow one course record: descriptor → graph → the base64 courseJson payload. */
async function decodeCourseEntry(
  e: ManifestEntry & { descriptorUrl: string },
  fetchFn?: FetchFn,
): Promise<Record<string, unknown> | null> {
  const doFetch = (fetchFn ?? globalThis.fetch) as typeof globalThis.fetch;
  try {
    const descRes = await doFetch(e.descriptorUrl, { headers: { Accept: 'text/turtle' } });
    if (!descRes.ok) return null;
    const descTurtle = await descRes.text();
    const gm = descTurtle.match(/hydra:target\s+<([^>]+)>/) ?? descTurtle.match(/dcat:accessURL\s+<([^>]+)>/);
    const graphUrl = gm?.[1];
    if (!graphUrl) return null;
    await assertSafeFetchTarget(graphUrl); // 2nd-hop SSRF
    const { content } = await fetchGraphContent(graphUrl, fetchFn ? { fetch: fetchFn as never } : undefined);
    if (!content) return null;
    const m = content.match(/<[^>]*#courseJson>\s+"([A-Za-z0-9+/=\s]+)"/);
    if (!m) return null;
    return JSON.parse(Buffer.from(m[1].replace(/\s+/g, ''), 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}
