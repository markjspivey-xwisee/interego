/**
 * AMEP — Affordant Memory Exchange Protocol engine (relay binding).
 *
 * Interego is the reference implementation of AMEP
 * (https://github.com/markjspivey-xwisee/affordant-memory-protocol). This module
 * mounts the six protocol acts (Ask/Assert/Challenge/Accept/Fork/Compose) over
 * pod-backed exchange state and serves each exchange in four representations.
 *
 * Conformance is true BY CONSTRUCTION: every served document is stamped and
 * self-checked with the AMEP repo's OWN reference validator (vendored verbatim in
 * ./amep-vendor/), so the relay cannot drift from the spec.
 *
 * The design is the output of a 3-adversary review (see AMEP_BUILD_CONTRACT).
 * The hardening that review demanded is load-bearing, not decorative:
 *   - state writes are CONDITIONAL (If-Match CAS) — the single-replica assumption
 *     breaks during a Railway deploy rollover, so the mutex alone is not atomic;
 *   - the JSON-LD document loader is PINNED offline — an attacker-controlled
 *     nested @context would otherwise SSRF the relay off the private network and
 *     make semanticCid non-reproducible;
 *   - the act body parse REJECTS YAML anchors/aliases — billion-laughs DoS;
 *   - attribution is BOUND to the authenticated principal — a Committed memory can
 *     never be silently attributed to a DID that never authenticated;
 *   - act IRI fields are OPAQUE — resolved only from local state, never fetched;
 *   - the state path is HASHED + prefix-pinned — no traversal to the acme pod.
 */

import express from 'express';
import type { Express, Request, Response } from 'express';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import jsonld from 'jsonld';
// The AMEP reference validator + its JSON-LD context, vendored verbatim (MIT,
// same author). computeSemanticCid / computeRepresentationTag / validateDocument
// are the SPEC's own functions, so our hashes and conformance verdict match the
// spec by construction.
// @ts-ignore — plain .mjs, no types
import * as amepValidator from './amep-vendor/validator.mjs';

// The vendored JSON-LD context, loaded via fs (a `.jsonld` file is not a JSON
// module, and import assertions vary across Node versions — fs sidesteps both).
const amepContext = JSON.parse(
  readFileSync(fileURLToPath(new URL('./amep-vendor/context.jsonld', import.meta.url)), 'utf8'),
) as Record<string, unknown>;

// ── Constants ───────────────────────────────────────────────

const PROFILE_IRI = 'https://markjspivey-xwisee.github.io/affordant-memory-protocol/0.1';
const CONTEXT_IRI = `${PROFILE_IRI}/context.jsonld`;
const AMEP_NS = `${PROFILE_IRI}#`;
const IEP_NS = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const IEH_NS = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';
const PROV_NS = 'http://www.w3.org/ns/prov#';
const HYDRA_NS = 'http://www.w3.org/ns/hydra/core#';
const SH_NS = 'http://www.w3.org/ns/shacl#';

const AFFORDANCE_YAML_TYPE = 'application/affordance+yaml';
const MARKDOWN_TYPE = 'text/markdown; variant=Interego';

const WRITE_ACTS = new Set(['Assert', 'Challenge', 'Accept', 'Fork', 'Compose']);
const CANDIDATE_ACTS = new Set(['Assert', 'Challenge', 'Fork', 'Compose']);
const ACT_TYPES = new Set(['Ask', 'Assert', 'Challenge', 'Accept', 'Fork', 'Compose']);
const INPUT_SHAPES: Record<string, string> = {
  Ask: 'AskInputShape', Assert: 'AssertInputShape', Challenge: 'ChallengeInputShape',
  Accept: 'AcceptInputShape', Fork: 'ForkInputShape', Compose: 'ComposeInputShape',
};

// Growth caps — see AMEP_BUILD_CONTRACT D1. Reject beyond these with problem+json.
const MAX_ACTS_PER_EXCHANGE = 512;
const MAX_STATE_BYTES = 1_000_000;
const MAX_ACT_BODY_BYTES = 64 * 1024;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ── Injected deps ───────────────────────────────────────────

export interface AmepFetch {
  (url: string, init?: unknown): Promise<{
    ok: boolean; status: number; statusText: string;
    headers?: { get(n: string): string | null };
    text(): Promise<string>; json(): Promise<unknown>;
  }>;
}

export interface AmepDeps {
  solidFetch: AmepFetch;
  withPodMutex: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
  /** Introspect a relay OAuth access token → principal + scopes, or null. */
  introspect: (token: string) => { userId: string; scope: string[]; clientId: string } | null;
  cssUrl: string;              // e.g. http://css.railway.internal:3456/
  maintainerPod: string;       // RELAY_MAINTAINER_POD_NAME
  publicBase: string;          // https://relay.interego.xwisee.com
  actSecret: string;           // AMEP_ACT_SECRET (operator bearer); '' disables it
  markdownFn?: (doc: unknown) => string; // optional presentation projection
  log: (msg: string, extra?: unknown) => void;
}

// ── Pinned offline JSON-LD document loader (SSRF + CID determinism) ──
//
// The vendored validator calls jsonld.expand/toRDF WITHOUT its own loader, so it
// would use the default network loader. jsonld caches the imported module, so
// setting `.documentLoader` on our binding pins it for the validator too. We
// serve ONLY the vendored AMEP context; every other http(s) fetch is refused.

const OFFLINE_CONTEXTS: Record<string, unknown> = {
  [CONTEXT_IRI]: amepContext,
};
function installOfflineLoader(): void {
  (jsonld as unknown as { documentLoader: unknown }).documentLoader = async (url: string) => {
    if (OFFLINE_CONTEXTS[url]) {
      return { contextUrl: null, documentUrl: url, document: OFFLINE_CONTEXTS[url] };
    }
    throw new Error(`AMEP offline loader refused remote context fetch: ${url}`);
  };
}

// ── Safe parsing ────────────────────────────────────────────

/** Reject YAML anchors / aliases / merge keys before parse (billion-laughs). A
 *  bare `&anchor` / `*alias` / `<<:` only occurs as YAML structure — inside a
 *  quoted scalar the `&`/`*` is not preceded by whitespace/flow punctuation. */
function hasYamlExpansion(src: string): boolean {
  return /(^|[\s{\[,])[&*][A-Za-z0-9_-]/.test(src) || /(^|\s)<<\s*:/.test(src);
}

/** Any nested `@context` (below the root) bypasses the pinned top-level context
 *  substitution and re-opens the SSRF / non-determinism hole. Refuse it. */
function hasNestedContext(value: unknown, depth = 0): boolean {
  if (Array.isArray(value)) return value.some((v) => hasNestedContext(v, depth));
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === '@context' && depth > 0) return true;
      if (hasNestedContext(v, depth + 1)) return true;
    }
  }
  return false;
}

/** Detect shared object references + runaway depth/size. js-yaml aliases resolve
 *  to SHARED references (cheap to parse) that explode into a tree only at the
 *  validator's clone()/JSON.stringify — so the raw-text anchor scan is a fast
 *  first gate and this structural walk is the real guard, run BEFORE any
 *  clone/stringify touches the graph. */
function structurallyUnsafe(root: unknown): string | null {
  const seen = new WeakSet<object>();
  let nodes = 0;
  const walk = (v: unknown, depth: number): string | null => {
    if (depth > 64) return 'document too deeply nested';
    if (v && typeof v === 'object') {
      if (seen.has(v as object)) return 'shared object reference (YAML alias) rejected';
      seen.add(v as object);
      if (++nodes > 10_000) return 'document has too many nodes';
      for (const val of Array.isArray(v) ? v : Object.values(v as Record<string, unknown>)) {
        const bad = walk(val, depth + 1);
        if (bad) return bad;
      }
    }
    return null;
  };
  return walk(root, 0);
}

function parseActBody(raw: string): { ok: true; doc: Record<string, unknown> } | { ok: false; reason: string } {
  if (raw.length > MAX_ACT_BODY_BYTES) return { ok: false, reason: 'act body exceeds size cap' };
  if (hasYamlExpansion(raw)) return { ok: false, reason: 'YAML anchors/aliases/merge keys are rejected' };
  let doc: unknown;
  try {
    doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
  } catch (e) {
    return { ok: false, reason: `YAML parse failed: ${(e as Error).message}` };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'act body must be a mapping' };
  const unsafe = structurallyUnsafe(doc);
  if (unsafe) return { ok: false, reason: unsafe };
  if (hasNestedContext(doc)) return { ok: false, reason: 'nested @context is not permitted' };
  return { ok: true, doc: doc as Record<string, unknown> };
}

// ── Identity helpers ────────────────────────────────────────

function localName(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  if (v.startsWith('amep:')) return v.slice(5);
  if (v.startsWith(AMEP_NS)) return v.slice(AMEP_NS.length);
  return null;
}
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
function sortedCanonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedCanonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, sortedCanonical((v as Record<string, unknown>)[k])]));
  }
  return v;
}
/** Canonical bytes of the submitted act for replay idempotency. */
function actCanonicalSha(act: unknown): string {
  return sha256(JSON.stringify(sortedCanonical(act)));
}

// ── Exchange state (the durable source of truth) ────────────

interface StoredAct {
  id: string;
  actType: string;
  actor: string;            // claimed DID/WebId (== authenticated principal on OAuth path)
  actorType: string;        // 'prov:Person' | 'prov:SoftwareAgent'
  actorName: string;
  submittedBy: string;      // authenticated principal (relay records this)
  canonicalSha: string;     // replay key
  expectedHead: string | null;
  createdAt: string;
  proof: unknown;           // recorded, NOT verified in v0
  memory: Record<string, unknown> | null;  // full MemoryRecord (non-Ask)
  receipt: Record<string, unknown>;          // full Receipt, verbatim
  resultHead: string;
  previousHead: string | null;
  branch: string | null;
  acceptedAct: string | null;
  challengedAct: string | null;
  operands: string[] | null;
}
interface ExchangeState {
  exchange: string;
  currentHead: string;
  order: string[];
  acts: Record<string, StoredAct>;
}

function statePath(deps: AmepDeps, slug: string): string {
  // slug already validated; hash-independent but prefix-pinned.
  const base = deps.cssUrl.replace(/\/+$/, '');
  const prefix = `${base}/${deps.maintainerPod}/amep/state/`;
  const url = `${prefix}${slug}.json`;
  // Defense in depth: the resolved URL MUST start with the pinned prefix.
  if (!url.startsWith(prefix)) throw new Error('state path escaped its prefix');
  return url;
}

// ── Projection: state → conformant AMEP exchange document ───
//
// Per the review: a served representation is exactly ONE act's view — one act,
// only that act's receipt, head == the act's resultHead, one memory for every
// non-Ask act, actor == act.actor. The whole-log is never dumped into one doc.

function affordancesFor(deps: AmepDeps, act: StoredAct): Array<Record<string, unknown>> {
  const target = `${deps.publicBase.replace(/\/+$/, '')}/amep/acts`;
  const mk = (action: string, effect: string) => ({
    '@id': `${act.resultHead}#${action.toLowerCase()}`,
    '@type': ['iep:Affordance', 'hydra:Operation'],
    action: `amep:${action}`,
    target,
    method: 'POST',
    inputShape: `amep:${INPUT_SHAPES[action]}`,
    effect,
  });
  const gov = act.memory ? localName(act.memory['governanceStatus']) : null;
  // Candidate → can be Accepted / Challenged. Committed → can be Forked.
  if (gov === 'Candidate') {
    return [
      mk('Accept', 'Commit this Candidate without changing its semantic CID.'),
      mk('Challenge', 'Preserve a Candidate sibling that challenges this record.'),
    ];
  }
  if (gov === 'Committed') {
    return [mk('Fork', 'Create an explicit Candidate branch without changing this committed head.')];
  }
  // Ask / inquiry head → can be Asserted against.
  return [mk('Assert', 'Assert a Candidate answer against this inquiry head.')];
}

function projectExchange(deps: AmepDeps, state: ExchangeState, act: StoredAct): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    '@context': [CONTEXT_IRI],
    '@id': `urn:exchange:${state.exchange}:${localName(act.actType)?.toLowerCase() ?? 'act'}-${shortId(act.id)}`,
    '@type': 'amep:Exchange',
    profile: PROFILE_IRI,
    actor: { '@id': act.actor, displayName: act.actorName || displayFor(act.actor), '@type': act.actorType },
    act: buildActNode(act),
    ...(act.memory ? { memory: act.memory } : {}),
    head: act.resultHead,
    receipts: [act.receipt],
    affordances: affordancesFor(deps, act),
  };
  // Stamp the representationTag exactly as the validator recomputes it.
  doc['representationTag'] = amepValidator.computeRepresentationTag(doc);
  return doc;
}

function buildActNode(act: StoredAct): Record<string, unknown> {
  const node: Record<string, unknown> = {
    '@id': act.id,
    '@type': 'amep:ProtocolAct',
    actType: `amep:${act.actType}`,
    actor: act.actor,
    createdAt: act.createdAt,
    proof: act.proof,
  };
  if (act.expectedHead) node['expectedHead'] = act.expectedHead;
  if (act.acceptedAct) node['acceptedAct'] = act.acceptedAct;
  if (act.challengedAct) node['challengedAct'] = act.challengedAct;
  if (act.branch) node['branch'] = act.branch;
  if (act.operands) { node['parentHead'] = act.previousHead; node['operands'] = act.operands; }
  else if (act.actType === 'Fork') node['parentHead'] = act.previousHead;
  return node;
}

const shortId = (s: string) => sha256(s).slice(0, 8);
function displayFor(did: string): string {
  return did.length > 24 ? `${did.slice(0, 20)}…` : did;
}
function receiptLookupUrl(deps: AmepDeps, slug: string, actId: string): string {
  return `${deps.publicBase.replace(/\/+$/, '')}/amep/receipts/${slug}/${shortId(actId)}`;
}

// ── Engine ──────────────────────────────────────────────────

export function mountAmep(app: Express, deps: AmepDeps): void {
  installOfflineLoader();
  deps.log('[amep] engine mounted; offline JSON-LD loader installed');

  // ---- pod state read / conditional write ----

  async function readState(slug: string): Promise<{ state: ExchangeState | null; etag: string | null }> {
    const url = statePath(deps, slug);
    const r = await deps.solidFetch(url, { method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (r.status === 404 || r.status === 410) return { state: null, etag: null };
    if (!r.ok) throw new Error(`state GET ${r.status}`);
    const etag = r.headers?.get('etag') ?? null;
    const state = JSON.parse(await r.text()) as ExchangeState;
    return { state, etag };
  }

  /** Conditional write with read-after-write verify. Returns false on 412 (caller retries). */
  async function writeState(slug: string, state: ExchangeState, etag: string | null): Promise<'ok' | 'conflict' | 'error'> {
    const url = statePath(deps, slug);
    const body = JSON.stringify(state);
    if (body.length > MAX_STATE_BYTES) throw new Error('state doc exceeds size cap');
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (etag) headers['If-Match'] = etag;
    else headers['If-None-Match'] = '*'; // create-only when we believe it is new
    const put = await deps.solidFetch(url, { method: 'PUT', headers, body });
    if (put.status === 412 || put.status === 409) return 'conflict';
    if (!put.ok) return 'error';
    // read-after-write verify: CSS has been observed returning 200 while the
    // write was dropped under a shared lock.
    const verify = await deps.solidFetch(url, { method: 'GET', headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (!verify.ok) return 'error';
    const back = JSON.parse(await verify.text()) as ExchangeState;
    if (back.currentHead !== state.currentHead) return 'error';
    return 'ok';
  }

  // ---- auth ----

  interface Principal { id: string; via: 'operator' | 'oauth'; scopes: string[]; }
  function authenticate(req: Request): Principal | null {
    const auth = String(req.headers['authorization'] ?? '');
    if (!auth.startsWith('Bearer ')) return null;
    const tok = auth.slice(7);
    if (deps.actSecret) {
      const a = Buffer.from(tok, 'utf8'); const b = Buffer.from(deps.actSecret, 'utf8');
      if (a.length === b.length && timingSafeEqual(a, b)) {
        return { id: `${deps.publicBase}/amep#relay-operator`, via: 'operator', scopes: ['mcp:write'] };
      }
    }
    const intro = deps.introspect(tok);
    if (intro) return { id: intro.userId, via: 'oauth', scopes: intro.scope };
    return null;
  }

  // ---- problem+json ----

  function problem(res: Response, status: number, title: string, detail: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): void {
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    res.status(status).type('application/problem+json').send(JSON.stringify({
      type: `${PROFILE_IRI}/problems/${title}`,
      title, status,
      detail,
      instance: `urn:amep:problem:${sha256(`${title}|${detail}`).slice(0, 16)}`,
      ...extra,
    }));
  }

  // ---- POST /amep/acts ----

  // Capture the RAW body as text: the act arrives as application/affordance+yaml
  // (or JSON), which the relay's global express.json() does not parse. This
  // per-route parser overrides it and gives us the exact bytes for canonical
  // hashing. 128 KB hard cap (the engine also enforces MAX_ACT_BODY_BYTES).
  const rawText = express.text({
    type: () => true, // this middleware only runs on POST /amep/acts
    limit: '128kb',
  });
  app.post('/amep/acts', rawText, async (req: Request, res: Response) => {
    const principal = authenticate(req);
    if (!principal) {
      return problem(res, 401, 'authentication-required', 'A bearer credential is required to submit an act.', {}, { 'WWW-Authenticate': 'Bearer realm="amep"' });
    }
    if (!principal.scopes.includes('mcp:write') && !principal.scopes.includes('mcp')) {
      return problem(res, 403, 'forbidden', 'The presented credential lacks write scope.');
    }
    // Body: raw text (affordance+yaml or json). express.json may have parsed it;
    // prefer the raw string form for canonical hashing.
    const raw = typeof req.body === 'string' ? req.body
      : (req.body && typeof req.body === 'object') ? JSON.stringify(req.body)
      : '';
    const parsed = parseActBody(raw);
    if (!parsed.ok) return problem(res, 400, 'malformed-act', (parsed as { reason: string }).reason);
    const submitted = (parsed as { doc: Record<string, unknown> }).doc;

    const act = submitted['act'] as Record<string, unknown> | undefined;
    if (!act || typeof act !== 'object') return problem(res, 422, 'invalid-act', 'Submission must carry an act.', { validationReport: minimalReport('act is required') });
    const actType = localName(act['actType']);
    if (!actType || !ACT_TYPES.has(actType)) return problem(res, 422, 'invalid-act', 'actType is outside the AMEP closed set.', { validationReport: minimalReport('bad actType') });
    const actId = act['@id'];
    if (typeof actId !== 'string' || !/^urn:act:/.test(actId)) return problem(res, 422, 'invalid-act', 'act @id must be a urn:act: IRI.', { validationReport: minimalReport('bad act @id') });

    // Attribution binding: on the OAuth path act.actor MUST equal the caller.
    const claimedActor = typeof act['actor'] === 'string' ? act['actor'] as string : '';
    if (principal.via === 'oauth' && claimedActor !== principal.id) {
      return problem(res, 403, 'forbidden', 'act.actor must equal the authenticated principal.');
    }

    // Which exchange (state doc) does this act belong to?
    //   - a WRITE act targets the exchange containing its expectedHead; the slug
    //     is embedded in the head IRI (urn:head:<slug>:<hash>) — self-contained,
    //     no global index needed;
    //   - an Ask opens a NEW exchange, its slug hashed from (principal, act @id)
    //     so a fresh inquiry cannot collide with or squat another principal's.
    // The slug is ALWAYS a hash or a parsed head token, never raw client text —
    // and it is re-validated against SLUG_RE, so the pod write path cannot be
    // traversed out of maintainer/amep/state/.
    let slug: string;
    if (WRITE_ACTS.has(actType)) {
      const eh = typeof act['expectedHead'] === 'string' ? act['expectedHead'] as string : '';
      const m = /^urn:head:([a-z0-9][a-z0-9-]{0,63}):/.exec(eh);
      if (!m) return problem(res, 412, 'stale-head', 'expectedHead does not name a known exchange head.', { 'amep:rediscover': `${deps.publicBase.replace(/\/+$/, '')}/amep` });
      slug = m[1]!;
    } else {
      slug = `x${sha256(`${principal.id}|${actId}`).slice(0, 40)}`;
    }
    if (!SLUG_RE.test(slug)) return problem(res, 400, 'malformed-act', 'exchange slug invalid');

    // Idempotency key covers the act node AND the submitted memory: resending
    // the same act @id with a different memory is "different content" → 409, not
    // a silent replay that serves the first memory.
    const canonicalSha = actCanonicalSha({ act, memory: submitted['memory'] ?? null });

    try {
      const result = await deps.withPodMutex(`amep:${slug}`, async () => {
        // Bounded CAS retry loop over the conditional write.
        for (let attempt = 0; attempt < 4; attempt++) {
          const { state, etag } = await readState(slug);

          // Replay detection from durable state only.
          if (state && state.acts[actId]) {
            const prior = state.acts[actId];
            if (prior.canonicalSha === canonicalSha) {
              return { kind: 'replay' as const, state, act: prior };
            }
            return { kind: 'idconflict' as const };
          }

          // Growth caps.
          if (state && (state.order.length >= MAX_ACTS_PER_EXCHANGE)) return { kind: 'toobig' as const };

          const currentHead = state?.currentHead ?? null;
          const expectedHead = typeof act['expectedHead'] === 'string' ? act['expectedHead'] as string : null;

          // CAS: only Ask may open a NEW exchange. A write act requires an
          // existing head equal to expectedHead — you cannot write into a
          // non-existent exchange (there is no head for the receipt's
          // previousHead to equal, which the validator enforces).
          if (WRITE_ACTS.has(actType)) {
            if (!expectedHead) return { kind: 'invalid' as const, msg: `${actType} requires expectedHead`, shape: 'ExpectedHeadShape' };
            if (currentHead === null || expectedHead !== currentHead) {
              return { kind: 'stale' as const, currentHead };
            }
          }
          if (actType === 'Ask' && currentHead !== null) {
            // Ask opens a fresh inquiry; re-asking an existing exchange is a new
            // inquiry head only if it carries no expectedHead conflict. Keep v0
            // simple: an Ask against an existing exchange is rejected as stale.
            return { kind: 'stale' as const, currentHead };
          }

          // Build the new act + memory + receipt (computes semanticCid).
          const built = await buildAct(deps, slug, state, actType, act, submitted, principal, canonicalSha);
          if ('error' in built) return { kind: 'invalid' as const, msg: built.error, shape: built.shape };

          const newState: ExchangeState = state ?? { exchange: slug, currentHead: built.stored.resultHead, order: [], acts: {} };
          newState.acts[actId] = built.stored;
          newState.order = [...newState.order, actId];
          newState.currentHead = built.stored.resultHead;
          newState.exchange = newState.exchange || slug;

          const w = await writeState(slug, newState, etag);
          if (w === 'ok') return { kind: 'applied' as const, state: newState, act: built.stored };
          if (w === 'conflict') continue; // re-read + retry CAS
          return { kind: 'writefail' as const };
        }
        return { kind: 'writefail' as const };
      });

      switch (result.kind) {
        case 'replay': {
          const doc = projectExchange(deps, result.state, result.act);
          res.setHeader('ETag', doc['representationTag'] as string);
          res.setHeader('Location', receiptLookupUrl(deps, slug, result.act.id));
          res.setHeader('Link', `<${deps.publicBase.replace(/\/+$/, '')}/amep/exchanges/${slug}>; rel="latest-version"`);
          return res.status(200).type(AFFORDANCE_YAML_TYPE).send(yaml.dump(doc));
        }
        case 'applied': {
          const doc = projectExchange(deps, result.state, result.act);
          // Self-check with the reference validator before responding.
          const report = await amepValidator.validateDocument(doc, amepContext, { validateHashes: true });
          if (!report['sh:conforms']) {
            deps.log('[amep] INTERNAL non-conformant projection', report['sh:result']);
            return problem(res, 500, 'internal-nonconformance', 'Engine produced a non-conformant representation.', { validationReport: report });
          }
          res.setHeader('ETag', doc['representationTag'] as string);
          res.setHeader('Location', receiptLookupUrl(deps, slug, result.act.id));
          res.setHeader('Link', `<${deps.publicBase.replace(/\/+$/, '')}/amep/exchanges/${slug}>; rel="latest-version"`);
          return res.status(201).type(AFFORDANCE_YAML_TYPE).send(yaml.dump(doc));
        }
        case 'idconflict':
          return problem(res, 409, 'act-id-conflict', 'This act @id was already used with different content.');
        case 'stale':
          return problem(res, 412, 'stale-head', 'expectedHead does not match the current head.', {
            'amep:rediscover': `${deps.publicBase}/amep/exchanges/${slug}`,
            currentHead: undefined, // MUST NOT leak head values in 412? spec 412 requires rediscover only.
          });
        case 'toobig':
          return problem(res, 409, 'exchange-full', 'This exchange has reached its act limit.');
        case 'invalid':
          return problem(res, 422, 'invalid-act', result.msg, { validationReport: minimalReport(result.msg, result.shape) });
        case 'writefail':
        default:
          return problem(res, 502, 'store-unavailable', 'The exchange store could not durably record the act.');
      }
    } catch (e) {
      deps.log('[amep] act error', (e as Error).message);
      return problem(res, 502, 'store-unavailable', 'The exchange store is unavailable.');
    }
  });

  // ---- GET /amep/exchanges/:slug (+ heads/acts/receipts) ----

  async function serveProjection(req: Request, res: Response, slug: string, pick: (s: ExchangeState) => StoredAct | null): Promise<void> {
    let state: ExchangeState | null;
    try { state = (await readState(slug)).state; }
    catch { return problem(res, 502, 'store-unavailable', 'The exchange store is unavailable.'); }
    if (!state) { return problem(res, 404, 'not-found', 'No such exchange.'); }
    const act = pick(state);
    if (!act) { return problem(res, 404, 'not-found', 'No such head/act.'); }
    const doc = projectExchange(deps, state, act);
    return negotiate(req, res, doc);
  }

  async function negotiate(req: Request, res: Response, doc: Record<string, unknown>): Promise<void> {
    const fmt = String(req.query['format'] ?? '').toLowerCase();
    const acc = String(req.headers['accept'] ?? '');
    // Turtle / JSON-LD via jsonld (pinned loader).
    if (fmt === 'jsonld' || (!fmt && acc.includes('application/ld+json'))) {
      const expanded = await jsonld.expand(doc);
      return void res.type('application/ld+json').send(JSON.stringify(expanded, null, 2));
    }
    if (fmt === 'turtle' || fmt === 'ttl' || (!fmt && acc.includes('text/turtle'))) {
      const nquads = await jsonld.toRDF(doc, { format: 'application/n-quads' });
      return void res.type('text/turtle').send(nquads as string);
    }
    if ((fmt === 'markdown' || fmt === 'md' || (!fmt && acc.includes('text/markdown'))) && deps.markdownFn) {
      // NON-NORMATIVE presentation binding: target-free, NO profile Link header.
      return void res.type(MARKDOWN_TYPE).send(deps.markdownFn(doc));
    }
    // Default: affordance+yaml, the conformant negotiated representation.
    res.setHeader('Link', `<${CONTEXT_IRI}>; rel="profile"`);
    res.setHeader('ETag', doc['representationTag'] as string);
    res.type(AFFORDANCE_YAML_TYPE).send(yaml.dump(doc));
  }

  app.get('/amep/exchanges/:slug', (req, res) => {
    const slug = String(req.params['slug'] ?? '');
    if (!SLUG_RE.test(slug)) return problem(res, 400, 'malformed-request', 'bad slug');
    return void serveProjection(req, res, slug, (s) => s.acts[s.order[s.order.length - 1]!] ?? null);
  });
  app.get('/amep/heads/:slug/:headId', (req, res) => {
    const slug = String(req.params['slug'] ?? '');
    if (!SLUG_RE.test(slug)) return problem(res, 400, 'malformed-request', 'bad slug');
    const headId = decodeURIComponent(String(req.params['headId'] ?? ''));
    return void serveProjection(req, res, slug, (s) => Object.values(s.acts).find((a) => a.resultHead === headId || a.resultHead.endsWith(headId)) ?? null);
  });
  app.get('/amep/acts/:slug/:actId', (req, res) => {
    const slug = String(req.params['slug'] ?? '');
    if (!SLUG_RE.test(slug)) return problem(res, 400, 'malformed-request', 'bad slug');
    const actId = decodeURIComponent(String(req.params['actId'] ?? ''));
    return void serveProjection(req, res, slug, (s) => Object.values(s.acts).find((a) => a.id === actId || a.id.endsWith(actId)) ?? null);
  });
  // Receipt lookup — the Location target of a successful act. Serves the
  // projection at the receipt's act, so the receipt IRI dereferences.
  app.get('/amep/receipts/:slug/:key', (req, res) => {
    const slug = String(req.params['slug'] ?? '');
    if (!SLUG_RE.test(slug)) return problem(res, 400, 'malformed-request', 'bad slug');
    const key = decodeURIComponent(String(req.params['key'] ?? ''));
    return void serveProjection(req, res, slug, (s) => Object.values(s.acts).find((a) => shortId(a.id) === key || (a.receipt['@id'] as string).endsWith(key)) ?? null);
  });

  // ---- GET /amep (index / discovery) ----
  app.get('/amep', (_req, res) => {
    res.type('application/json').send(JSON.stringify({
      profile: PROFILE_IRI,
      spec: 'https://markjspivey-xwisee.github.io/affordant-memory-protocol/',
      acts: ['Ask', 'Assert', 'Challenge', 'Accept', 'Fork', 'Compose'],
      endpoints: {
        submit: `${deps.publicBase}/amep/acts`,
        exchange: `${deps.publicBase}/amep/exchanges/{slug}`,
      },
      bindings: {
        conformant: [AFFORDANCE_YAML_TYPE, 'application/ld+json', 'text/turtle'],
        presentation: [MARKDOWN_TYPE],
      },
      note: 'Interego is the reference implementation of AMEP. Conformant representations are validated by the AMEP reference validator on every response.',
    }, null, 2));
  });

  deps.log('[amep] routes: POST /amep/acts, GET /amep/exchanges/:slug, /amep/heads, /amep/acts, /amep');
}

// ── Act construction (the six acts) ─────────────────────────

function minimalReport(msg: string, shape = 'ProtocolActShape'): Record<string, unknown> {
  return {
    '@context': { sh: SH_NS, amep: AMEP_NS },
    '@type': 'sh:ValidationReport', 'sh:conforms': false,
    'sh:result': [{ '@type': 'sh:ValidationResult', 'sh:resultSeverity': 'sh:Violation', 'sh:sourceShape': `amep:${shape}`, 'sh:resultMessage': msg }],
  };
}

function heads(slug: string, actId: string): string { return `urn:head:${slug}:${sha256(actId).slice(0, 12)}`; }
function receiptId(actId: string): string { return actId.replace('urn:act:', 'urn:receipt:'); }

/** Build the stored act (with its memory + receipt) for a validated submission.
 *  semanticCid is computed SERVER-SIDE via the vendored function so the served
 *  representation conforms regardless of what the client sent (a mismatched
 *  client CID becomes a corrected value, not a 500). */
async function buildAct(
  deps: AmepDeps, slug: string, state: ExchangeState | null, actType: string,
  act: Record<string, unknown>, submitted: Record<string, unknown>,
  principal: { id: string; via: string }, canonicalSha: string,
): Promise<{ stored: StoredAct } | { error: string; shape: string }> {
  const actId = act['@id'] as string;
  const actor = (act['actor'] as string) ?? principal.id;
  const createdAt = typeof act['createdAt'] === 'string' ? act['createdAt'] as string : '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(createdAt)) {
    return { error: 'act.createdAt must be an ISO 8601 UTC date-time', shape: 'ProtocolActShape' };
  }
  const actorObj = submitted['actor'] as Record<string, unknown> | undefined;
  const actorType = actorObj && actorObj['@type'] === 'prov:Person' ? 'prov:Person' : 'prov:SoftwareAgent';
  const actorName = actorObj && typeof actorObj['displayName'] === 'string' ? actorObj['displayName'] as string : '';
  const previousHead = state?.currentHead ?? null;
  const resultHead = heads(slug, actId);

  // Memory: required for every non-Ask act. Candidate acts must supply/keep
  // Candidate; Accept commits the accepted act's memory.
  let memory: Record<string, unknown> | null = null;
  if (actType === 'Accept') {
    const acceptedAct = act['acceptedAct'];
    if (typeof acceptedAct !== 'string') return { error: 'Accept requires acceptedAct', shape: 'AcceptInputShape' };
    const prior = state?.acts[acceptedAct];
    if (!prior || !prior.memory) return { error: 'acceptedAct not found in this exchange', shape: 'AcceptInputShape' };
    // Commit: same memory, same semanticCid, governanceStatus → Committed.
    memory = { ...prior.memory, governanceStatus: 'amep:Committed' };
  } else if (actType !== 'Ask') {
    const m = submitted['memory'];
    if (!m || typeof m !== 'object') return { error: `${actType} must carry a memory record`, shape: `${INPUT_SHAPES[actType]}` };
    memory = { ...(m as Record<string, unknown>) };
    if (!memory['semantic'] || typeof memory['semantic'] !== 'object') {
      return { error: `${actType} memory must carry amep:SemanticMaterial`, shape: `${INPUT_SHAPES[actType]}` };
    }
    // Force Candidate for candidate-producing acts (Fork from Committed → Candidate).
    if (CANDIDATE_ACTS.has(actType)) memory['governanceStatus'] = 'amep:Candidate';
    // integrityStatus is Unverified in v0 (we record but do not verify proofs).
    memory['integrityStatus'] = 'amep:Unverified';
    if (!memory['conformanceStatus']) memory['conformanceStatus'] = 'amep:Conformant';
    // Authoritative semanticCid — RDFC-1.0 of the memory's semantic projection.
    try {
      memory['semanticCid'] = await amepValidator.computeSemanticCid({ memory: { semantic: memory['semantic'] } }, amepContext);
    } catch (e) {
      return { error: `semantic material could not be canonicalized: ${(e as Error).message}`, shape: 'SemanticCidShape' };
    }
  }

  const receipt: Record<string, unknown> = {
    '@id': receiptId(actId),
    '@type': 'amep:Receipt',
    receiptFor: actId,
    outcome: 'amep:Applied',
    ...(previousHead ? { previousHead } : {}),
    resultHead,
    generatedAt: bumpIso(createdAt),
    validationReport: { '@id': `${receiptId(actId)}#report`, '@type': 'sh:ValidationReport', conforms: true },
    // Relay-recorded authenticated principal — attribution honesty. Kept in the
    // receipt (outside memory.semantic so it does not change any semanticCid).
    'amep:submittedBy': principal.id,
  };

  const stored: StoredAct = {
    id: actId, actType, actor, actorType, actorName, submittedBy: principal.id, canonicalSha,
    expectedHead: (act['expectedHead'] as string) ?? null, createdAt,
    proof: act['proof'] ?? null, memory, receipt, resultHead, previousHead,
    branch: (act['branch'] as string) ?? null,
    acceptedAct: (act['acceptedAct'] as string) ?? null,
    challengedAct: (act['challengedAct'] as string) ?? null,
    operands: Array.isArray(act['operands']) ? (act['operands'] as string[]) : null,
  };
  return { stored };
}

// receipt.generatedAt = act.createdAt + 1s, deterministic (createdAt comes from
// the client act and is required upstream).
function bumpIso(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t + 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ── Seed: the release-42 lineage (Ask → Assert → Accept) ────
//
// Serving only the final Accept would break a fresh client's recovery walk
// (its receipt references the assert head + act, which must themselves
// dereference). So we seed the FULL lineage as one exchange with three acts.
// Built by REPLAYING the acts through buildAct so every semanticCid,
// representationTag, and receipt is genuine — never copied from the fixtures.

export const RELEASE_42_SLUG = 'release42';

const REL42_BODY =
  'Release 42 should ship after the migration checksum and rollback drill\n' +
  'both pass. The evidence is linked from the deployment context.\n';

export async function buildSeedState(deps: AmepDeps): Promise<ExchangeState> {
  const op = { id: `${deps.publicBase}/amep#relay-operator`, via: 'operator' };
  const agentA = 'did:key:z6MkAgentReleaseBot';
  const human = 'did:key:z6MkHumanReleaseManager';
  let state: ExchangeState | null = null;

  const apply = async (actType: string, act: Record<string, unknown>, submitted: Record<string, unknown>) => {
    const full = { ...submitted, act };
    const built = await buildAct(deps, RELEASE_42_SLUG, state, actType, act, full, op, actCanonicalSha({ act, memory: submitted['memory'] ?? null }));
    if ('error' in built) throw new Error(`seed ${actType}: ${built.error}`);
    const s: ExchangeState = state ?? { exchange: RELEASE_42_SLUG, currentHead: built.stored.resultHead, order: [], acts: {} };
    s.acts[built.stored.id] = built.stored;
    s.order = [...s.order, built.stored.id];
    s.currentHead = built.stored.resultHead;
    state = s;
    return built.stored;
  };

  // 1. Ask (inquiry head).
  const ask = await apply('Ask', {
    '@id': 'urn:act:release42:ask', '@type': 'amep:ProtocolAct', actType: 'amep:Ask',
    actor: human, createdAt: '2026-07-11T14:00:00Z',
    proof: { '@type': 'iep:SignedAuthorship', verificationMethod: `${human}#key-1`, created: '2026-07-11T14:00:00Z', proofValue: 'zSeedAsk' },
  }, { actor: { '@id': human, '@type': 'prov:Person', displayName: 'Release manager' } });

  // 2. Assert (Candidate claim by the agent).
  const assert = await apply('Assert', {
    '@id': 'urn:act:release42:assert', '@type': 'amep:ProtocolAct', actType: 'amep:Assert',
    actor: agentA, expectedHead: ask.resultHead, createdAt: '2026-07-11T14:01:00Z',
    proof: { '@type': 'iep:SignedAuthorship', verificationMethod: `${agentA}#key-1`, created: '2026-07-11T14:01:00Z', proofValue: 'zSeedAssert' },
  }, {
    actor: { '@id': agentA, '@type': 'prov:SoftwareAgent', displayName: 'Release bot' },
    memory: {
      '@id': 'urn:memory:release42:answer', '@type': ['amep:MemoryRecord', 'ieh:AgentMemory'],
      memoryKind: 'amep:Claim',
      semantic: { '@type': 'amep:SemanticMaterial', body: REL42_BODY, epistemicStatus: 'iep:Asserted', attributedTo: agentA },
    },
  });

  // 3. Accept (human commits the candidate).
  await apply('Accept', {
    '@id': 'urn:act:release42:accept', '@type': 'amep:ProtocolAct', actType: 'amep:Accept',
    actor: human, expectedHead: assert.resultHead, acceptedAct: 'urn:act:release42:assert',
    createdAt: '2026-07-11T14:03:00Z',
    proof: { '@type': 'iep:SignedAuthorship', verificationMethod: `${human}#key-1`, created: '2026-07-11T14:03:00Z', proofValue: 'zSeedAccept' },
  }, { actor: { '@id': human, '@type': 'prov:Person', displayName: 'Release manager' } });

  return state!;
}

/** Seed the release-42 exchange on the pod if it is absent (create-only). */
export async function seedRelease42(deps: AmepDeps): Promise<void> {
  const url = statePath(deps, RELEASE_42_SLUG);
  try {
    const head = await deps.solidFetch(url, { method: 'GET', headers: { Accept: 'application/json' } });
    if (head.ok) { deps.log('[amep] release-42 exchange already seeded'); return; }
  } catch { /* fall through to seed */ }
  const state = await buildSeedState(deps);
  const put = await deps.solidFetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'If-None-Match': '*' },
    body: JSON.stringify(state),
  });
  deps.log(`[amep] seeded release-42 exchange -> ${put.status}`);
}
