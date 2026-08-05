#!/usr/bin/env tsx
/**
 * A vertical-blind observer: read outcomes off a pod, submit them to an affordance.
 *
 * ★ WHAT THIS PROGRAM IS NOT ALLOWED TO KNOW. It does not know which application produced the
 * records it reads, which application owns the affordance it submits to, or what either of
 * them calls anything. Its four arguments are all URLs, all dereferenced at run time:
 *
 *     --pod                     a pod to read
 *     --map-iri                 a published observation map: which predicate becomes which
 *                               argument, and how to select records
 *     --affordance-descriptor   a document carrying the affordance to invoke
 *     --action-iri              the iep:action IRI of that affordance
 *
 * The predicate names it reads and the argument names it submits under live in the MAP, not
 * in this source. `tools/emergence-boundary-lint.mjs` greps this file for any mention of the
 * application whose records the demo run happens to point it at, and fails the build on a
 * single hit. The transplant run — same binary, same map, a different application's pod —
 * is the empirical version of the same claim.
 *
 * ★ WHAT IT REFUSES TO DO. It never invents an outcome. A record that does not carry every
 * `required` source in the map is SKIPPED and counted, never submitted with a default. An
 * outcome nobody asserted must not become an outcome an observer manufactured — that is the
 * one way a program like this could quietly turn a log into a lie.
 *
 * ★ WHOSE PERFORMANCE IT REPORTS. Its own. `sign_request` binds the caller's authenticated
 * identity and the target binds the recorded subject to that identity, so this cannot record
 * a performance for anybody else. Point it at a pod that is not yours and the submission is
 * still attributed to you — which is why it is run by the pod's own owner, and why it is not
 * a channel for attributing work to a third party.
 *
 * Usage:
 *   IEP_BEARER=<tok> npx tsx tools/observe-pod-performance-live.ts \
 *     --pod https://gate.example/<pod>/ \
 *     --map-iri https://relay.example/ns/<owner>/<map> \
 *     --affordance-descriptor https://vertical.example/affordances \
 *     --action-iri https://relay.example/ns/iep/action/<vertical>/<verb> \
 *     [--since <ISO8601>] [--dry-run]
 */

/* eslint-disable no-console */

import { parseTrig, type ParsedDocument, type ParsedTerm } from '@interego/core';

const RELAY = process.env.IEP_RELAY ?? 'https://relay.interego.xwisee.com';
const BEARER = process.env.IEP_BEARER;
if (!BEARER) { console.error('IEP_BEARER is required.'); process.exit(2); }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const POD = arg('pod');
const MAP_IRI = arg('map-iri');
const AFFORDANCE_DESCRIPTOR = arg('affordance-descriptor');
const ACTION_IRI = arg('action-iri');
const SINCE = arg('since');
const DRY_RUN = process.argv.includes('--dry-run');
if (!POD || !MAP_IRI || !AFFORDANCE_DESCRIPTOR || !ACTION_IRI) {
  console.error('--pod, --map-iri, --affordance-descriptor and --action-iri are all required.');
  process.exit(2);
}

// ── The relay ────────────────────────────────────────────────────────────────

let id = 300;
async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const r = await fetch(`${RELAY}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${BEARER}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  let j: Record<string, unknown> | null = null;
  try { j = JSON.parse(raw) as Record<string, unknown>; } catch {
    const data = raw.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('');
    try { j = JSON.parse(data) as Record<string, unknown>; } catch { /* neither */ }
  }
  const text = (j as { result?: { content?: { text?: string }[] } } | null)?.result?.content?.[0]?.text;
  try { return JSON.parse(text ?? '{}') as Record<string, unknown>; } catch { return { raw: text ?? raw }; }
}

// ── The map ──────────────────────────────────────────────────────────────────

/**
 * ★ THE MAP'S OWN TERMS ARE RESOLVED AGAINST THE VOCABULARY ITS rdf:type NAMES, so there is
 * no namespace constant in this file at all. A map typed `a <X>#ObservationMap` has its
 * `field`, `toArgument` and so on read from `<X>#`, which means the document a reader
 * dereferences to find out what those words mean is named by the map itself. A map that
 * declares its own vocabulary IS `<X>`, so a self-describing one resolves to itself; a
 * second map for a different practice's records cites the first rather than restating it.
 */
interface FieldMapping {
  readonly fromPredicate?: string;
  readonly fromRecordAddress: boolean;
  /**
   * The matched record's own SUBJECT IRI.
   *
   * ★ WHY A MAP WOULD CHOOSE THIS OVER `fromRecordAddress`. The storage address is the
   * signed artifact, but dereferencing it yields the DESCRIPTOR — provenance, facets, an
   * authorship proof, and an affordance pointing at a payload on a host that does not
   * resolve from outside. So an affordance handed that address, asked to check the record
   * against a shape, would be checking the envelope. The subject IRI is what the shape
   * targets, what every citation of the record names, and what a reader means by "the
   * record"; the relay resolves it to the published version whose triples it is.
   */
  readonly fromRecordSubject: boolean;
  /** A value fixed BY THE MAP rather than read off the record — e.g. the shape the
   *  submitter wants its own evidence checked against. Keeps a constant the reader must
   *  send out of this source and in the published document, where a reader can see it. */
  readonly constant?: string;
  readonly toArgument: string;
  readonly required: boolean;
}
interface ObservationMap {
  readonly fields: readonly FieldMapping[];
  /** `everyRecord` or `currentHeadsOnly` — see `readMap`. */
  readonly selection: 'everyRecord' | 'currentHeadsOnly';
  /**
   * ★ A TYPE THE RECORD MUST DECLARE, WHEN THE MAP SAYS SO.
   *
   * Selecting purely on predicates was a hole a reviewer walked through. A publisher's work
   * contract is a SHACL shape with an `sh:targetClass`, so deleting one `rdf:type` triple
   * leaves the shape with no focus node, the gate accepts the record — and this reader,
   * which looked only at predicates, still read it as evidence. A record that dodged its own
   * contract was fully countable. When the map declares a type, a record that does not carry
   * it is not one of the records this map is about.
   */
  readonly requiresType?: string;
}

const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';

const iriOf = (t: ParsedTerm | undefined): string | undefined =>
  t?.kind === 'iri' ? String(t.iri) : undefined;
const bnodeOf = (t: ParsedTerm | undefined): string | undefined =>
  t?.kind === 'bnode' ? t.id : undefined;
const litOf = (t: ParsedTerm | undefined): string | undefined =>
  t?.kind === 'literal' ? t.value : undefined;

function subjectProps(doc: ParsedDocument, key: string): ReadonlyMap<string, readonly ParsedTerm[]> | undefined {
  for (const s of doc.subjects) {
    const k = typeof s.subject === 'string' ? s.subject : `_:${s.subject.bnode}`;
    if (k === key) return s.properties as ReadonlyMap<string, readonly ParsedTerm[]>;
  }
  return undefined;
}

async function readMap(mapIri: string): Promise<ObservationMap> {
  const r = await fetch(mapIri, { headers: { Accept: 'text/turtle' } });
  if (!r.ok) throw new Error(`observation map <${mapIri}> did not resolve: ${r.status}`);
  const doc = parseTrig(await r.text());
  const root = subjectProps(doc, mapIri);
  if (!root) throw new Error(`observation map <${mapIri}> resolves but states nothing about itself.`);

  // ★ THE MAP'S rdf:type NAMES ITS VOCABULARY, so a SECOND map can reuse a first one's terms
  // instead of restating them.
  //
  // Terms used to be resolved against the map's own IRI unconditionally, which meant every
  // map had to re-declare the whole vocabulary at its own URL — and the moment a second map
  // was published for a different practice's records, it read as "declares no
  // recordSelection" because its terms were defined one document over. Two copies of a
  // vocabulary is how two copies drift. The type is already there, it is already a term of
  // the vocabulary in question, and everything before its `#` is the base: that is ordinary
  // RDF, not a convention this reader invented. Absent a type, the map's own IRI stands, so
  // a self-describing map keeps working unchanged.
  const typeIri = (root.get(RDF_TYPE) ?? [])
    .map(t => iriOf(t)).find((i): i is string => i !== undefined && i.endsWith('#ObservationMap'));
  const vocab = typeIri !== undefined ? typeIri.slice(0, -'ObservationMap'.length) : `${mapIri}#`;
  const T = (local: string): string => `${vocab}${local}`;

  // ★ SELECTION IS DECLARED, NOT GUESSED, AND ABSENT IS AN ERROR. Whether `iep:supersedes`
  // on a record means "this replaces that" or "this comes after that in my log" is a
  // question about the log's semantics that no observer can answer by looking. Guess
  // "heads only" over an append-only chain and eleven of twelve records vanish; guess
  // "every record" over a corrected one and a retracted value is counted twice. Both
  // failures are silent and both produce a plausible number, so the map has to say.
  const selRaw = iriOf(root.get(T('recordSelection'))?.[0]);
  const selection = selRaw === T('everyRecord') ? 'everyRecord'
    : selRaw === T('currentHeadsOnly') ? 'currentHeadsOnly'
      : null;
  if (selection === null) {
    throw new Error(
      `observation map <${mapIri}> declares no ${T('recordSelection')}. It must be `
      + `<${T('everyRecord')}> or <${T('currentHeadsOnly')}> — defaulting would silently pick `
      + 'one of two readings that each produce a plausible, wrong count.',
    );
  }

  const fields: FieldMapping[] = [];
  for (const fieldTerm of root.get(T('field')) ?? []) {
    const bn = bnodeOf(fieldTerm);
    const key = bn !== undefined ? `_:${bn}` : iriOf(fieldTerm);
    const props = key ? subjectProps(doc, key) : undefined;
    if (!props) continue;
    const toArgument = litOf(props.get(T('toArgument'))?.[0]);
    if (!toArgument) continue;
    // A constant may be an IRI (a shape, a term) or a literal — the map decides which.
    const constant = iriOf(props.get(T('constant'))?.[0]) ?? litOf(props.get(T('constant'))?.[0]);
    fields.push({
      ...(iriOf(props.get(T('fromPredicate'))?.[0]) !== undefined
        ? { fromPredicate: iriOf(props.get(T('fromPredicate'))?.[0])! } : {}),
      fromRecordAddress: litOf(props.get(T('fromRecordAddress'))?.[0]) === 'true',
      fromRecordSubject: litOf(props.get(T('fromRecordSubject'))?.[0]) === 'true',
      ...(constant !== undefined ? { constant } : {}),
      toArgument,
      required: litOf(props.get(T('required'))?.[0]) === 'true',
    });
  }
  if (fields.length === 0) throw new Error(`observation map <${mapIri}> declares no fields.`);
  const requiresType = iriOf(root.get(T('requiresType'))?.[0]);
  return { fields, selection, ...(requiresType !== undefined ? { requiresType } : {}) };
}

// ── The pod ──────────────────────────────────────────────────────────────────

interface Candidate { readonly descriptorUrl: string; readonly validFrom: string | null }

async function readPod(podUrl: string, selection: ObservationMap['selection'], since?: string): Promise<readonly Candidate[]> {
  const res = await call('discover_context', {
    pod_url: podUrl, sort: 'oldest-first', ...(since ? { valid_from: since } : {}),
  });
  // ★ A FAILED READ MUST NOT LOOK LIKE AN EMPTY POD. The relay reports an unreachable host
  // as DATA — the tool result is a plain string — and an empty pod as `{entries: []}`. Both
  // reduce to zero candidates, and "this pod holds nothing" is not "we never reached it".
  if (!Array.isArray(res['entries'])) {
    throw new Error(`discover_context on <${podUrl}> returned no entries array: ${JSON.stringify(res).slice(0, 300)}`);
  }
  const entries = (res['entries'] as Record<string, unknown>[]).map(e => ({
    descriptorUrl: String(e['descriptorUrl'] ?? ''),
    validFrom: typeof e['validFrom'] === 'string' ? e['validFrom'] : null,
    supersedes: Array.isArray(e['supersedes']) ? (e['supersedes'] as unknown[]).filter((s): s is string => typeof s === 'string') : [],
  })).filter(e => e.descriptorUrl.length > 0);
  if (selection === 'everyRecord') return entries.map(({ descriptorUrl, validFrom }) => ({ descriptorUrl, validFrom }));
  const superseded = new Set(entries.flatMap(e => e.supersedes));
  return entries.filter(e => !superseded.has(e.descriptorUrl)).map(({ descriptorUrl, validFrom }) => ({ descriptorUrl, validFrom }));
}

/**
 * The record's address as a reader of the SUBMISSION will see it.
 *
 * ★ THE MANIFEST RECORDS A STORAGE-INTERNAL ADDRESS, AND FORWARDING THAT WOULD BE FORWARDING
 * A DEAD LINK. The pod's own manifest names each descriptor by the address the storage layer
 * knows it by, which is canonical and is what the signatures are over — but it is not
 * reachable from outside. This observer was handed a public address for the same pod, so it
 * re-bases the record's path onto that and then FETCHES IT to check, because a value that
 * "should" resolve and does not is exactly the dangling evidence pointer this whole exercise
 * is about. A record whose public address does not answer is skipped, not submitted.
 */
function publicAddress(descriptorUrl: string, podUrl: string): string {
  const d = new URL(descriptorUrl);
  const p = new URL(podUrl);
  if (!d.pathname.startsWith(p.pathname)) return descriptorUrl;
  return new URL(d.pathname + d.search, p.origin).toString();
}

function valueOf(term: ParsedTerm): string | boolean | null {
  if (term.kind === 'iri') return String(term.iri);
  if (term.kind === 'bnode') return null;
  if (term.datatype === 'http://www.w3.org/2001/XMLSchema#boolean') return term.value === 'true';
  return term.value;
}

// ── The run ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const map = await readMap(MAP_IRI!);
  console.log(`\nmap        ${MAP_IRI}`);
  console.log(`  selection ${map.selection}`);
  if (map.requiresType !== undefined) console.log(`  type      <${map.requiresType}> [required]`);
  for (const f of map.fields) {
    const source = f.fromRecordAddress ? '(the record\'s own storage address)'
      : f.fromRecordSubject ? '(the record\'s own subject IRI)'
        : f.constant !== undefined ? `(the map's own constant) ${f.constant}`
          : `<${f.fromPredicate}>`;
    console.log(`  ${f.toArgument.padEnd(14)} <- ${source}${f.required ? ' [required]' : ''}`);
  }
  console.log(`pod        ${POD}`);
  console.log(`affordance ${ACTION_IRI}\n            via ${AFFORDANCE_DESCRIPTOR}\n`);

  const candidates = await readPod(POD!, map.selection, SINCE);
  console.log(`${candidates.length} record(s) on the pod to consider\n`);

  const required = map.fields.filter(f => f.required && f.fromPredicate !== undefined).map(f => f.fromPredicate!);
  let submitted = 0, skipped = 0, failed = 0;

  for (const c of candidates) {
    const desc = await call('get_descriptor', { url: c.descriptorUrl });
    const graph = desc['graph'] as { content?: string } | undefined;
    const content = typeof graph?.content === 'string' ? graph.content : '';
    if (content === '') { skipped++; console.log(`  skip  ${c.descriptorUrl} — no readable content`); continue; }

    let doc: ParsedDocument;
    try { doc = parseTrig(content); } catch (e) {
      skipped++; console.log(`  skip  ${c.descriptorUrl} — unparseable (${(e as Error).message.slice(0, 80)})`); continue;
    }

    // The record's own subject is whichever one carries every required source. A document
    // that carries none is not addressed to this map and is passed over in silence; one that
    // carries them in two different subjects is ambiguous and is refused rather than picked.
    const matches = doc.subjects.filter(s => {
      const props = s.properties as ReadonlyMap<string, readonly ParsedTerm[]>;
      if (!required.every(p => props.get(p)?.length)) return false;
      // The declared type, when the map declares one — see `ObservationMap.requiresType`.
      if (map.requiresType === undefined) return true;
      return (props.get(RDF_TYPE) ?? []).some(t => iriOf(t) === map.requiresType);
    });
    if (matches.length === 0) { skipped++; continue; }
    if (matches.length > 1) {
      skipped++;
      console.log(`  skip  ${c.descriptorUrl} — ${matches.length} subjects carry the required predicates; which one is the record is not this program's guess to make`);
      continue;
    }
    const props = matches[0]!.properties as ReadonlyMap<string, readonly ParsedTerm[]>;
    const subjectTerm = matches[0]!.subject;
    const subjectIri = typeof subjectTerm === 'string' ? subjectTerm : null;

    // ★ EVERY ADDRESS THIS PROGRAM FORWARDS IS FETCHED FIRST. A value that "should" resolve
    // and does not is exactly the dangling evidence pointer this whole exercise is about,
    // and the map decides WHICH address is the record's — so both are checked, and only the
    // ones the map actually asks for.
    const wantsAddress = map.fields.some(f => f.fromRecordAddress);
    const wantsSubject = map.fields.some(f => f.fromRecordSubject);
    const address = publicAddress(c.descriptorUrl, POD!);
    let unreachable: string | null = null;
    for (const [what, url] of [
      ...(wantsAddress ? [['its public address', address] as const] : []),
      ...(wantsSubject ? [['its own subject IRI', subjectIri] as const] : []),
    ]) {
      if (url === null) { unreachable = `${what} is a blank node, which nothing outside this document can dereference`; break; }
      const probe = await fetch(url, { method: 'GET', headers: { Accept: 'text/turtle' } });
      if (!probe.ok) { unreachable = `${what} ${url} answered ${probe.status}`; break; }
    }
    if (unreachable !== null) {
      skipped++;
      console.log(`  skip  ${c.descriptorUrl} — ${unreachable}; forwarding an unreachable pointer is worse than forwarding nothing`);
      continue;
    }

    const args: Record<string, unknown> = {};
    let missing: string | null = null;
    for (const f of map.fields) {
      if (f.fromRecordAddress) { args[f.toArgument] = address; continue; }
      if (f.fromRecordSubject) { args[f.toArgument] = subjectIri!; continue; }
      if (f.constant !== undefined) { args[f.toArgument] = f.constant; continue; }
      const term = props.get(f.fromPredicate!)?.[0];
      // A blank node has no value that survives leaving this document, so it is treated as
      // absent rather than stringified into an argument that names nothing.
      const value = term === undefined ? null : valueOf(term);
      if (value === null) { if (f.required) missing = f.fromPredicate!; continue; }
      args[f.toArgument] = value;
    }
    if (missing !== null) { skipped++; console.log(`  skip  ${c.descriptorUrl} — no <${missing}>`); continue; }

    if (DRY_RUN) {
      submitted++;
      console.log(`  would ${JSON.stringify(args).slice(0, 240)}`);
      continue;
    }

    const envelope = await call('sign_request', { payload: args });
    const act = await call('act', { descriptor_url: AFFORDANCE_DESCRIPTOR, action_iri: ACTION_IRI, payload: envelope });
    // ★ READ THE DISCRIMINATING FIELD, NOT THE STATUS. `act` reports the transport's status,
    // and a 200 whose body is `{"error": ...}` is a failure the status cannot tell you about.
    const status = Number(act['status'] ?? 0);
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(String(act['body'] ?? '{}')) as Record<string, unknown>; } catch { /* non-JSON */ }
    if (status !== 200 || body['ok'] !== true) {
      failed++;
      console.log(`  FAIL  ${address}\n        ${status} ${JSON.stringify(body).slice(0, 300)}`);
      continue;
    }
    submitted++;
    console.log(`  sent  ${address}`);
    console.log(`        -> ${JSON.stringify({ taskId: body['taskId'], activityType: body['activityType'], success: body['success'], durable: body['durable'] })}`);
  }

  console.log(`\n${submitted} submitted, ${skipped} skipped, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
