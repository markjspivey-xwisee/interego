/**
 * The relay's PUBLISHED PGSL node commons — the substrate's own answer for the ids it
 * mints under PGSL_ID_AUTHORITY.
 *
 * ★ THE INVARIANT:  resolvable(id) ⟺ id is in the durable published store.
 *
 * Publication is an explicit, authenticated act (`publish_node`). Minting is not.
 * `mintNodeId` is `sha256` — a pure function, callable offline, taking no consent and
 * touching no network — so the standing "every identifier is a dereferenceable URL"
 * principle cannot attach to it. It attaches to PUBLICATION. Before this module the
 * relay minted `…/ns/pgsl/atom/<hash>` and unconditionally 302'd every one of the
 * 16^40 well-formed addresses at a foreign lattice that had never heard of them, so
 * the substrate's own `@id` resolved to `{"error":"no such node"}`.
 *
 * ★ WHY NOT JUST SERVE THE KERNEL LATTICE. The obvious fix — "the relay holds the node,
 * let the relay serve it" — is a disclosure oracle and was rejected deliberately. The
 * kernel lattice (packages/pgsl/src/kernel-adapter.ts) is ONE untenanted process-global
 * map written by `mint` / `promote` / `pgsl_ingest`, and `/ns/pgsl/*` is unauthenticated
 * with `Access-Control-Allow-Origin: *`. Serving it by hash would let anyone confirm any
 * guess with `sha256("atom:" + guess)`, cross-origin, over every caller's content — the
 * exact oracle packages/pgsl-store/src/addressing.ts keys against. It is worse for
 * encrypted atoms, whose uri is content-addressed from the PLAINTEXT while the stored
 * value is a placeholder: a public hash resolver confirms plaintext guesses without
 * leaking a byte. It is also not durable — heap only, so a Railway rolling deploy or an
 * OOM restart turns a 200 into a 404, and an intermittently-resolving identifier is
 * worse than a consistently-absent one, because it poisons caches and agent memory with
 * a fact the origin will later deny.
 *
 * ★ THE CACHE ORDERING RULE. `commons` is a strict SUBSET of the durable store. Nothing
 * enters it except (a) immediately after a successful durable write, or (b) as the
 * result of a read FROM the durable store. Never the other way around — a local-first
 * write would let this process answer for a node no other replica can see.
 */
import { createHash } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  openStore, openPgStore, InMemoryFdb,
  type PgslStore, type StoredNode,
} from '@interego/pgsl-store';
import { createPGSL, describeNode, collectLatticeSlice } from '@interego/pgsl';
import type { PGSLInstance, Node, NodeProvenance } from '@interego/pgsl';
import type { IRI } from '@interego/core';

const CONNSTR = process.env['RELAY_PGSL_PG_CONNSTR'] ?? '';
const TABLE = process.env['RELAY_PGSL_TABLE'] ?? 'relay_pgsl_published';

/**
 * Full-rehydrate debounce. A point-read miss-fill gives the exact identity facets
 * immediately; the derived `_context` / `_paradigm` facets converge at this bound.
 */
const REHYDRATE_TTL_MS = 60_000;

/** Bound the closure walk on a cold point-read, so one deep fragment cannot turn a
 *  single GET into thousands of store round trips. */
const MAX_CLOSURE = 5_000;

let _store: PgslStore | null = null;
let _openErr: string | null = null;
let _commons: PGSLInstance | null = null;
let _lastRehydrate = 0;
let _inflight: Promise<void> | null = null;

/**
 * Is a durable store configured at all? Unconfigured ⇒ the route answers 503 rather
 * than silently degrading to "nothing is published", which would read to a client as a
 * definitive "this id does not exist".
 */
export function isConfigured(): boolean {
  return CONNSTR.length > 0 || process.env['RELAY_PGSL_IN_MEMORY'] === '1';
}

/**
 * The published commons — a SECOND PGSLInstance, deliberately distinct from the kernel
 * singleton. Safe despite the usual one-lattice-per-process guidance because ids are
 * content-addressed (both instances agree on identity), this one has exactly one writer
 * (`publishSlice`), and it is a strict subset of the durable store. It must never be
 * handed to a `getKernelPGSL` caller.
 */
export function commons(): PGSLInstance {
  if (!_commons) {
    _commons = createPGSL({
      wasAttributedTo: 'https://relay.interego.xwisee.com/ns/pgsl' as IRI,
      generatedAtTime: new Date().toISOString(),
    });
  }
  return _commons;
}

/** Test seam: run the whole module over an injected store (or the in-memory fake). */
export function _resetForTests(store?: PgslStore): void {
  _store = store ?? null;
  _openErr = null;
  _commons = null;
  _lastRehydrate = 0;
  _inflight = null;
}

async function store(): Promise<PgslStore> {
  if (_store) return _store;
  if (_openErr) throw new Error(_openErr);
  try {
    const fdb = process.env['RELAY_PGSL_IN_MEMORY'] === '1'
      ? new InMemoryFdb()
      // ensureSchema:false — the runtime role deliberately has NO DDL rights. It holds
      // SELECT/INSERT/UPDATE/DELETE on exactly one table and nothing else, so a relay
      // compromise cannot create or alter anything in a database it shares with the
      // CSS's pod storage. `bootstrapDurableStore` creates the table, as the admin,
      // once. Leaving the default (true) made every boot attempt CREATE TABLE and fail
      // with "permission denied for schema public" — the tight grant working correctly.
      : await openPgStore({ connectionString: CONNSTR, table: TABLE, ensureSchema: false });
    _store = openStore(fdb);
    return _store;
  } catch (e) {
    _openErr = `pgsl node store unavailable: ${(e as Error).message}`;
    throw new Error(_openErr);
  }
}

// ── mapping between the lattice's Node and the store's StoredNode ────────────

function toStored(n: Node): StoredNode {
  if (n.kind === 'Atom') {
    return {
      uri: String(n.uri), kind: 'atom', level: 0, value: n.value,
      provenance: { ...n.provenance } as Record<string, unknown>,
    };
  }
  return {
    uri: String(n.uri), kind: 'fragment', level: n.level, height: n.height,
    items: n.items.map(String),
    ...(n.left ? { left: String(n.left) } : {}),
    ...(n.right ? { right: String(n.right) } : {}),
    provenance: { ...n.provenance } as Record<string, unknown>,
  };
}

function toNode(sn: StoredNode): Node {
  const provenance = (sn.provenance ?? {}) as unknown as NodeProvenance;
  if (sn.kind === 'atom') {
    return { kind: 'Atom', uri: sn.uri as IRI, value: sn.value as string, level: 0, provenance };
  }
  return {
    kind: 'Fragment', uri: sn.uri as IRI, level: sn.level,
    // Rows written before `height` existed reconstruct it from the level.
    height: sn.height ?? Math.max(0, sn.level - 1),
    items: (sn.items ?? []) as IRI[],
    ...(sn.left ? { left: sn.left as IRI } : {}),
    ...(sn.right ? { right: sn.right as IRI } : {}),
    provenance,
  } as Node;
}

/** Rule (b): the ONLY way a node enters the commons from a read. */
function admit(sn: StoredNode): void {
  const p = commons();
  const n = toNode(sn);
  (p.nodes as Map<IRI, Node>).set(n.uri, n);
  if (n.kind === 'Atom') (p.atoms as Map<string, IRI>).set(String(n.value), n.uri);
  else (p.fragments as Map<string, IRI>).set(n.items.join('|'), n.uri);
}

// ── publish ──────────────────────────────────────────────────────────────────

export interface PublishOutcome { published: number; dedup: number; nodes: number }

/**
 * Publish the FULL lattice slice spanned by `topUri` into the durable store, then admit
 * it to the commons.
 *
 * The whole slice, not just the top node: a fragment's `items` are ids, so persisting
 * the apex alone leaves every constituent dangling and the served description
 * unresolvable.
 *
 * Refuses any slice containing an encrypted atom — its uri is content-addressed from
 * the plaintext, so publishing one turns the public resolver into a confirmation oracle
 * for plaintext guesses.
 */
export async function publishSlice(
  src: PGSLInstance, topUri: IRI, publisher: { iri: string; at: string },
): Promise<PublishOutcome> {
  const slice = collectLatticeSlice(src, topUri);
  if (slice.size === 0) throw new Error(`not in this lattice: ${topUri}`);
  for (const n of slice.values()) {
    if (n.kind === 'Atom'
      && ((n as unknown as { encrypted?: unknown }).encrypted || n.value === '__ENCRYPTED__')) {
      throw new Error('refusing to publish an encrypted atom: its id is addressed from its plaintext');
    }
  }
  const rows = [...slice.values()].map((n) => {
    const sn = toStored(n);
    // The kernel singleton stamps every node with the FIRST minter's provenance in this
    // process, which is wrong for every later writer. Stamp the actual publisher so the
    // served description is honest about who put this in public.
    sn.provenance = {
      ...(sn.provenance ?? {}),
      'iep:publishedBy': publisher.iri,
      'iep:publishedAt': publisher.at,
    };
    return sn;
  });
  const s = await store();
  const r = await s.putMany(rows);        // one transaction, content-addressed set-if-absent
  for (const sn of rows) admit(sn);        // rule (a): only ever AFTER the durable write
  return { published: r.created, dedup: r.dedup, nodes: rows.length };
}

// ── resolve ──────────────────────────────────────────────────────────────────

export async function hydrateAll(force = false): Promise<void> {
  if (!force && Date.now() - _lastRehydrate < REHYDRATE_TTL_MS) return;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const s = await store();
    const all = await s.rehydrate();
    _commons = null;                       // rebuild from the durable truth, never merge into stale
    for (const sn of all.values()) admit(sn);
    _lastRehydrate = Date.now();
  })().finally(() => { _inflight = null; });
  return _inflight;
}

/** Point-read a node and its transitive closure straight from the durable store. */
async function pointFill(iri: string): Promise<boolean> {
  const s = await store();
  const seen = new Set<string>();
  const stack = [iri];
  let found = false;
  while (stack.length && seen.size < MAX_CLOSURE) {
    const u = stack.pop()!;
    if (seen.has(u)) continue;
    seen.add(u);
    // ★ DO NOT SWALLOW. A throw here is a STORE FAULT, and turning it into `null`
    // makes an unreachable store read as "this id was never published" — the single
    // outcome this design must never produce, because it is indistinguishable to a
    // client from a definitive answer. It propagates to resolvePublished's catch,
    // which reports `unavailable`, which the route renders as 503.
    // (Caught by this module's own test: the store threw and the route answered 302.)
    // A genuinely malformed id cannot reach here — the route validates the grammar
    // before calling, and closure item uris come from rows we wrote ourselves.
    const sn: StoredNode | null = await s.resolve(u);
    if (!sn) continue;
    if (u === iri) found = true;
    admit(sn);
    for (const i of sn.items ?? []) stack.push(i);
    if (sn.left) stack.push(sn.left);
    if (sn.right) stack.push(sn.right);
  }
  return found;
}

export type Resolution =
  | { status: 'ok'; body: Record<string, unknown> }
  | { status: 'not-published' }
  | { status: 'unavailable'; detail: string };

/**
 * THE SHARED RESOLVER CORE — used by BOTH the public GET route and the `dereference`
 * tool's published check. One core, two surfaces.
 *
 * Its absence is precisely why the tool reported `status: 'ok'` for an id whose URL
 * 404'd: the tool read the in-process lattice and the URL read a foreign one, and
 * nothing made them agree.
 */
export async function resolvePublished(iri: string, base: string): Promise<Resolution> {
  if (!isConfigured()) return { status: 'unavailable', detail: 'RELAY_PGSL_PG_CONNSTR unset' };
  try {
    let node = commons().nodes.get(iri as IRI);
    let contextComplete = true;
    if (!node) {
      if (await pointFill(iri)) {
        // A cold point-read has exact identity facets but only a partial neighbourhood;
        // schedule the full rehydrate and say so in-band rather than overclaim.
        contextComplete = false;
        void hydrateAll().catch(() => {});
      }
      node = commons().nodes.get(iri as IRI);
    }
    if (!node) return { status: 'not-published' };

    const d = describeNode(commons(), iri as IRI, {
      hrefFor: (u) => String(u),          // the canonical id IS the locator here
      maxNeighbors: 200,
    })!;
    const act = (verb: string) => `${base}/ns/iep/action/relay/${verb}`;
    return {
      status: 'ok',
      body: {
        '@context': { iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#' },
        '@id': iri,
        '@type': d.kind === 'Atom' ? 'iep:Atom' : 'iep:Fragment',
        'iep:level': d.level,
        'iep:hash': d.hash,
        ...(d.value !== undefined ? { 'iep:value': d.value } : {}),
        ...(d.height !== undefined ? { 'iep:height': d.height } : {}),
        'iep:resolved': d.resolved,
        'iep:provenance': d.provenance,
        'iep:structure': d._structure,
        'iep:context': d._context,
        'iep:paradigm': d._paradigm,
        // Identity facets are exact and immutable; the reuse/paradigm facets are
        // eventually consistent across replicas, bounded by REHYDRATE_TTL_MS.
        //
        // ★★ AND NOW ALSO FALSE WHEN THE CAP CLIPPED THE NEIGHBOURHOOD. This read `contextComplete`
        // alone, which only ever went false after a cold point-fill — so a capped description was
        // published as complete, and a node reused 20,000 times advertised its first 200 containers
        // as the whole story. `describeNode` computes `truncated` from real counts now.
        //
        // Expect published bodies to flip from true to false for heavily-reused atoms. Any consumer
        // treating `contextComplete: true` as "I hold the whole neighbourhood" was already wrong;
        // this is where it stops being invisible.
        'iep:contextComplete': contextComplete && !d.truncated,
        'iep:contextTotals': {
          'iep:containers': d._context.totalContainers,
          'iep:sourceOptions': d._paradigm.totalSourceOptions,
          'iep:targetOptions': d._paradigm.totalTargetOptions,
        },
        'iep:affordances': [
          { 'iep:action': act('dereference'), 'iep:target': iri, 'iep:method': 'GET' },
          { 'iep:action': act('promote'), 'iep:target': iri },
          { 'iep:action': act('decompose'), 'iep:target': iri },
        ],
      },
    };
  } catch (e) {
    return { status: 'unavailable', detail: (e as Error).message };
  }
}

// ── the HTTP surface ─────────────────────────────────────────────────────────

/** Byte-identical for never-minted, minted-but-unpublished, and private. */
export const PGSL_NODE_404 = { error: 'no such pgsl node' } as const;

/**
 * The `GET /ns/pgsl/:kind/:hash` handler, as a factory.
 *
 * ★ EXPORTED AS A FACTORY SO THE TEST CAN MOUNT THE REAL THING. server.ts registers
 * exactly this function; the regression test mounts exactly this function. A test that
 * re-implemented the handler would assert a composition we do not ship — which is how a
 * 302-to-a-foreign-404 survived a suite that already contained a test literally named
 * "…resolves at its authority".
 */
export function nodeRouteHandler(opts: { resolverBase: string; publicBase: string }) {
  return async function pgslNodeRoute(req: Request, res: Response): Promise<void> {
    // CORS (ACAO:*) is applied upstream by the /ns/* public linked-data carve-out.
    // Whole body in try/catch: this is an async Express 4 route, and an uncaught throw
    // is an unhandled rejection — process exit on Node 22.
    try {
      const kind = String(req.params['kind']);
      const hash = String(req.params['hash']).toLowerCase();
      // EXACT grammar: atom|fragment at exactly 40 hex — the only shape the node-address
      // codec can represent and the only shape the tier-2 resolver registers.
      // `metagraph` (24 hex) now gets the uniform 404 rather than a 302 into a foreign
      // HTML error page.
      if (!['atom', 'fragment'].includes(kind) || !/^[0-9a-f]{40}$/.test(hash)) {
        res.setHeader('Cache-Control', 'no-store');
        res.status(404).json(PGSL_NODE_404);
        return;
      }
      const base = (opts.publicBase || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
      const iri = `${base}/ns/pgsl/${kind}/${hash}`;

      const r = await resolvePublished(iri, base);
      if (r.status === 'ok') {
        const body = JSON.stringify(r.body, null, 2);
        const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 32)}"`;
        if (req.headers['if-none-match'] === etag) { res.status(304).end(); return; }
        res.setHeader('ETag', etag);
        res.setHeader('Vary', 'Accept');
        // Identity facets are immutable, but the reuse/paradigm facets grow as more is
        // published — cacheable, but deliberately NOT `immutable`.
        res.setHeader('Cache-Control', 'public, max-age=300, stale-while-revalidate=86400');
        res.type('application/ld+json').send(body);
        return;
      }
      if (r.status === 'unavailable') {
        // Fail LOUD: an unreachable store must never read as "not published".
        res.setHeader('Cache-Control', 'no-store');
        res.status(503).json({ error: 'pgsl node store unavailable' });
        return;
      }
      // Tier 2. no-store, because this id may be published here a second from now and a
      // heuristically-cached negative (RFC 9111 §4.2.2) would keep 404ing it.
      res.setHeader('Cache-Control', 'no-store');
      res.redirect(302, `${opts.resolverBase}/${kind}/${hash}`);
    } catch {
      res.setHeader('Cache-Control', 'no-store');
      res.status(503).json({ error: 'pgsl node store unavailable' });
    }
  };
}

// ── one-time provisioning ────────────────────────────────────────────────────

/**
 * Create the least-privilege role and table this module needs, from INSIDE the private
 * network.
 *
 * ★ WHY THIS EXISTS RATHER THAN A README STEP. The Postgres instance has no TCP proxy
 * and no public exposure — deliberately. Running `CREATE ROLE` from an operator laptop
 * would mean publishing a database that also holds the CSS's `pgsl_kv` (every pod's
 * statements, keyed by bare public hash) to the internet, even briefly, to execute one
 * statement. The relay already sits on that private network and already legitimately
 * talks to this database, so provisioning runs here instead.
 *
 * ★ WHY A SEPARATE ROLE AT ALL. The obvious shortcut is to hand the relay the same
 * admin connection string the CSS uses. That makes any relay compromise a full
 * pod-content disclosure, because both live in one database. This role can touch
 * exactly one table.
 *
 * Runs only when RELAY_PGSL_BOOTSTRAP_CONNSTR is set, is fully idempotent, and is
 * expected to be removed from the environment once it has run — the steady state is the
 * least-privilege RELAY_PGSL_PG_CONNSTR alone. Never logs either credential.
 */
export async function bootstrapDurableStore(
  log: (msg: string) => void = () => {},
): Promise<'skipped' | 'provisioned' | 'failed'> {
  const admin = process.env['RELAY_PGSL_BOOTSTRAP_CONNSTR'];
  const rolePassword = process.env['RELAY_PGSL_ROLE_PASSWORD'];
  if (!admin) return 'skipped';
  if (!rolePassword) {
    log('[pgsl] bootstrap requested but RELAY_PGSL_ROLE_PASSWORD is unset — skipping');
    return 'failed';
  }
  // Table name is operator-controlled, never caller-controlled, but it is interpolated
  // into DDL where parameters are not allowed — so constrain it to a safe identifier.
  if (!/^[a-z_][a-z0-9_]*$/.test(TABLE)) {
    log(`[pgsl] refusing to bootstrap: unsafe table identifier ${JSON.stringify(TABLE)}`);
    return 'failed';
  }
  // ★ The role password cannot be a bind parameter. CREATE ROLE / ALTER ROLE are
  // utility statements that take no parameters, and wrapping them in a DO block does
  // not help — `$1` inside dollar-quoting is literal text, not a placeholder, so the
  // server rejects the bind outright ("bind message supplies 1 parameters, but prepared
  // statement requires 0"). It has to be an inline literal, so the password is
  // constrained to a charset that cannot terminate the literal, and validated here
  // rather than trusted.
  if (!/^[A-Za-z0-9_-]{16,200}$/.test(rolePassword)) {
    log('[pgsl] refusing to bootstrap: RELAY_PGSL_ROLE_PASSWORD must be 16-200 chars of [A-Za-z0-9_-]');
    return 'failed';
  }
  const pwLiteral = `'${rolePassword}'`;

  const { Client } = await import('pg');
  const c = new Client({ connectionString: admin });
  try {
    await c.connect();
    // Postgres has no CREATE ROLE IF NOT EXISTS, so branch in the client.
    const exists = await c.query('SELECT 1 FROM pg_roles WHERE rolname = $1', ['relay_pgsl']);
    await c.query(exists.rowCount
      ? `ALTER ROLE relay_pgsl LOGIN PASSWORD ${pwLiteral}`
      : `CREATE ROLE relay_pgsl LOGIN PASSWORD ${pwLiteral}`);
    await c.query(`CREATE TABLE IF NOT EXISTS ${TABLE} (k bytea PRIMARY KEY, v bytea NOT NULL)`);
    // Fail closed: strip anything inherited, then grant exactly this one table.
    await c.query('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM relay_pgsl');
    await c.query('GRANT USAGE ON SCHEMA public TO relay_pgsl');
    await c.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ${TABLE} TO relay_pgsl`);
    log(`[pgsl] bootstrap complete: role relay_pgsl scoped to ${TABLE} only`);
    return 'provisioned';
  } catch (e) {
    // Never echo the connection string — it carries the admin password.
    log(`[pgsl] bootstrap FAILED: ${(e as Error).message}`);
    return 'failed';
  } finally {
    await c.end().catch(() => {});
  }
}
