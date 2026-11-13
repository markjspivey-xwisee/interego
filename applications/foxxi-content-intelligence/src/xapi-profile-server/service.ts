/**
 * The xAPI Profile Server (xAPI Profiles, Part Three) as Foxxi serves it.
 *
 * Nothing here is a separate product bolted on. The parts are ones the bridge already has:
 *
 *   store     each profile version is a holon in a public PGSL lattice on the commons pod, the
 *             exact document its content. Its triples are projected from that into
 *             @interego/pgsl triple stores, which are the "RDF triple store" the specification
 *             asks for. This module is given `persist` and `hydrate` and does not know where
 *             they lead.
 *   query     @interego/pgsl's SPARQL engine, over the named graphs in ./dataset.ts.
 *   validate  ./processor.ts, the specification's own algorithms.
 *   add       a signed affordance: an agent adds a profile as itself, by contents or by URI.
 *
 * The specification's "administrators" are, here, the agents that sign: whoever first adds a
 * profile IRI is the one who may add later versions of it or take it down, and the operator may
 * take down any.
 */
import type { Express, Request, Response, RequestHandler } from 'express';
import { ProfileDataset, SparqlRefused, type HeldProfile } from './dataset.js';
import { follows, validates, type Json as PJson } from './processor.js';
import type { Json } from './rdf.js';

type Obj = { [key: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const MAX_PROFILE_BYTES = 256 * 1024;
/** Everything ever added, together. The lattice is append-only and lives in one pod resource. */
export const MAX_KEPT_BYTES = 12 * 1024 * 1024;
export const MAX_PROFILE_TRIPLES = 6000;
export const MAX_PATTERN_STATEMENTS = 500;

/** What is kept for each added version, and replayed when the bridge starts. */
export type ProfileRecord =
  | { kind: 'added'; doc: Json; by: string; at: string; source?: string }
  | { kind: 'removed'; iri: string; by: string; at: string };

export interface ProfileServerOptions {
  /** Profiles that are part of the deployment itself (Foxxi's own). Never removable, never persisted. */
  readonly builtIn: () => Json[];
  /** Keep a record durably. Resolves with where it went, or throws. */
  readonly persist?: (record: ProfileRecord, held?: HeldProfile) => Promise<{ holonUri?: string; persisted?: boolean }>;
  /** Every record kept so far. */
  readonly hydrate?: () => Promise<ProfileRecord[]>;
  /** A stored statement by id, for templates that check a referenced statement. */
  readonly statementById?: (id: string) => PJson | undefined;
  readonly isOperator?: (did: string) => boolean;
}

export class ProfileServerError extends Error { constructor(readonly status: number, message: string) { super(message); } }

export class ProfileServer {
  readonly dataset = new ProfileDataset();
  /** profile IRI → the agent that first added it. */
  private readonly owners = new Map<string, string>();
  private readonly builtInIds = new Set<string>();
  private hydrated: Promise<void> | undefined;
  private keptBytes = 0;

  constructor(private readonly options: ProfileServerOptions) {
    for (const doc of options.builtIn()) this.builtInIds.add(this.dataset.add(doc).id);
  }

  /** Replay what was kept. Safe to call on every request: it runs once, and again after a failure. */
  ready(): Promise<void> {
    return this.hydrated ??= (async () => {
      const records = (await this.options.hydrate?.()) ?? [];
      for (const r of [...records].sort((a, b) => a.at.localeCompare(b.at))) {
        try {
          if (r.kind === 'added') { this.keptBytes += sizeOf(r.doc); this.hold(r.doc, r.by); }
          else this.drop(r.iri);
        } catch { /* a record that no longer reads is skipped, not fatal */ }
      }
    })().catch(e => { this.hydrated = undefined; throw e; });
  }

  private hold(doc: Json, by: string): HeldProfile {
    const why = whyNotAddable(doc);
    if (why) throw new ProfileServerError(400, why);
    const id = (doc as Obj).id as string;
    if (this.builtInIds.has(id)) throw new ProfileServerError(409, `${id} is this deployment's own profile and is served from its code.`);
    const owner = this.owners.get(id);
    if (owner && owner !== by) throw new ProfileServerError(409, `${id} was added by another agent, and only that agent adds versions of it.`);
    const held = this.dataset.add(doc);
    if (held.stated.length > MAX_PROFILE_TRIPLES) {
      this.dataset.remove(held.version);
      throw new ProfileServerError(413, `The profile states ${held.stated.length} triples; this server holds profiles of up to ${MAX_PROFILE_TRIPLES}.`);
    }
    this.owners.set(id, by);
    return held;
  }

  private drop(iri: string): string[] {
    const gone = this.dataset.remove(iri);
    if (!this.dataset.all().some(h => h.id === iri)) this.owners.delete(iri);
    return gone;
  }

  /** Add a profile version by its contents. */
  async add(doc: Json, by: string, source?: string): Promise<{ held: HeldProfile; replaced: boolean; holonUri?: string; persisted: boolean }> {
    await this.ready();
    const before = isObj(doc) && typeof doc.id === 'string' ? this.dataset.all().map(h => h.version) : [];
    const size = sizeOf(doc);
    if (this.options.persist && this.keptBytes + size > MAX_KEPT_BYTES) throw new ProfileServerError(507, 'This server has kept as many profile documents as it holds; an operator has to make room.');
    const held = this.hold(doc, by);
    this.keptBytes += size;
    const replaced = before.includes(held.version);
    let kept: { holonUri?: string; persisted?: boolean } = {};
    if (this.options.persist) {
      try { kept = await this.options.persist({ kind: 'added', doc, by, at: new Date().toISOString(), ...(source ? { source } : {}) }, held); }
      catch (e) { kept = { persisted: false }; void e; }
    }
    return { held, replaced, ...(kept.holonUri ? { holonUri: kept.holonUri } : {}), persisted: kept.persisted === true };
  }

  /** Take down a profile (every version) or one version. */
  async remove(iri: string, by: string): Promise<{ removed: string[]; persisted: boolean }> {
    await this.ready();
    const target = this.dataset.all().find(h => h.id === iri || h.version === iri);
    if (!target) throw new ProfileServerError(404, `No profile or version ${iri} is held here.`);
    if (this.builtInIds.has(target.id)) throw new ProfileServerError(409, `${target.id} is this deployment's own profile and cannot be taken down.`);
    if (this.owners.get(target.id) !== by && !this.options.isOperator?.(by)) throw new ProfileServerError(403, 'Only the agent that added a profile, or the operator, takes it down.');
    const removed = this.drop(iri);
    let persisted = false;
    if (this.options.persist) { try { persisted = (await this.options.persist({ kind: 'removed', iri, by, at: new Date().toISOString() })).persisted === true; } catch { persisted = false; } }
    return { removed, persisted };
  }

  owner(profileId: string): string | undefined { return this.builtInIds.has(profileId) ? undefined : this.owners.get(profileId); }
  isBuiltIn(profileId: string): boolean { return this.builtInIds.has(profileId); }

  private parts(profile: unknown): { held: HeldProfile; templates: PJson[]; patterns: PJson[] } {
    if (typeof profile !== 'string' || profile === '') throw new ProfileServerError(400, 'Name the profile by its id in `profile`.');
    const held = this.dataset.get(profile);
    if (!held) throw new ProfileServerError(400, `No profile with id ${profile} is on this server. GET the server root for the ones that are, or add it.`);
    const doc = held.doc as Obj;
    const list = (v: Json | undefined) => (Array.isArray(v) ? v.filter(isObj) : []) as unknown as PJson[];
    return { held, templates: list(doc.templates), patterns: list(doc.patterns) };
  }

  /** The specification's /validate_templates: no comments means the statement validates. */
  async validateTemplates(statement: unknown, profile: unknown): Promise<{ comments: string[]; templates: string[]; skipped: string[] }> {
    await this.ready();
    const { templates } = this.parts(profile);
    const one = parsed(statement, 'statement');
    if (!isObj(one)) throw new ProfileServerError(400, '`statement` is one xAPI Statement, as a JSON object.');
    let r;
    try { r = validates(one as unknown as PJson, templates, { ...(this.options.statementById ? { statementById: this.options.statementById } : {}) }); }
    catch (e) { return { comments: [(e as Error).message], templates: [], skipped: [] }; }
    const comments = r.outcome === 'success' ? []
      : r.outcome === 'unmatched' ? ['The statement matches no statement template of this profile: no template\'s determining properties (verb, object activity type, context activity types, attachment usage types) all match it.']
        : r.findings.map(f => `${f.template}: ${f.location ? `rule at ${f.location}: ` : ''}${f.reason}`);
    return { comments, templates: r.templates, skipped: r.skipped };
  }

  /** The specification's /validate_patterns. */
  async validatePatterns(statements: unknown, profile: unknown): Promise<{ comments: string[]; pattern?: string }> {
    await this.ready();
    const { templates, patterns } = this.parts(profile);
    const many = parsed(statements, 'statements');
    if (!Array.isArray(many) || !many.every(isObj)) throw new ProfileServerError(400, '`statements` is an array of xAPI Statements.');
    if (many.length > MAX_PATTERN_STATEMENTS) throw new ProfileServerError(413, `Up to ${MAX_PATTERN_STATEMENTS} statements are checked in one request.`);
    let r;
    try { r = follows(many as unknown as PJson[], templates, patterns, { ...(this.options.statementById ? { statementById: this.options.statementById } : {}) }); }
    catch (e) { return { comments: [(e as Error).message] }; }
    return r.follows ? { comments: [], ...(r.pattern ? { pattern: r.pattern } : {}) } : { comments: r.reasons };
  }
}

function sizeOf(doc: unknown): number { try { return Buffer.byteLength(JSON.stringify(doc) ?? ''); } catch { return 0; } }

/** A POST variable that may arrive as JSON text (a form) or already as JSON (a JSON body). */
function parsed(value: unknown, name: string): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); }
  catch { throw new ProfileServerError(400, `\`${name}\` is not valid JSON.`); }
}

/** Why a document cannot be added as a profile, or undefined. Shape only: what a query or a validation would trip on. */
export function whyNotAddable(doc: unknown): string | undefined {
  if (!isObj(doc)) return 'A profile is a JSON object.';
  let size = 0;
  try { size = Buffer.byteLength(JSON.stringify(doc)); } catch { return 'The profile is not serializable JSON.'; }
  if (size > MAX_PROFILE_BYTES) return `The profile is ${size} bytes; this server holds profiles of up to ${MAX_PROFILE_BYTES}.`;
  const iri = (v: unknown) => typeof v === 'string' && /^https?:\/\/[^\s<>"{}|\\^`]+$/i.test(v);
  if (!iri(doc.id)) return 'A profile needs an "id" that is an http(s) IRI.';
  const types = Array.isArray(doc.type) ? doc.type : [doc.type];
  if (!types.includes('Profile')) return 'A profile has "type": "Profile".';
  if (!Array.isArray(doc.versions) || doc.versions.length === 0 || !doc.versions.every(v => isObj(v) && iri(v.id)))
    return 'A profile needs "versions": an array of objects, each with an "id" that is an http(s) IRI.';
  if (doc.versions.some(v => (v as Obj).id === doc.id)) return 'A version\'s "id" is different from the profile\'s own.';
  for (const key of ['concepts', 'templates', 'patterns'] as const) {
    const v = doc[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || !v.every(e => isObj(e) && iri(e.id))) return `"${key}" is an array of objects, each with an "id" that is an http(s) IRI.`;
  }
  return undefined;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────────────────────

export interface ReadRouteOptions {
  /** `<bridge>/xapi/profiles`, where the server is mounted. */
  readonly base: string;
  readonly urlencoded: RequestHandler;
  readonly text: RequestHandler;
  /** Where the add and remove affordances are, for the index to point at. */
  readonly addTarget: string;
  readonly removeTarget: string;
}

const label = (doc: Json, key: 'prefLabel' | 'definition'): Json | undefined => isObj(doc) ? doc[key] : undefined;

/** The read side: the index, a profile's document, /sparql, /validate_templates and /validate_patterns. */
export function mountProfileServerReads(app: Express, server: ProfileServer, o: ReadRouteOptions): void {
  const open = (res: Response) => { res.setHeader('Access-Control-Allow-Origin', '*'); };
  const fail = (res: Response, e: unknown) => {
    if (e instanceof ProfileServerError) { res.status(e.status).json({ error: e.message, comments: [e.message] }); return; }
    if (e instanceof SparqlRefused) { res.status(400).json({ error: e.message }); return; }
    res.status(500).json({ error: 'The profile server could not answer.' });
  };
  const documentUrl = (iri: string) => `${o.base}/profile?iri=${encodeURIComponent(iri)}`;

  app.get('/xapi/profiles', async (_req, res) => {
    open(res);
    try {
      await server.ready();
      const current = new Set(server.dataset.current().map(h => h.version));
      res.json({
        '@id': o.base,
        type: 'xAPI Profile Server',
        conformsTo: 'https://github.com/adlnet/xapi-profiles/blob/master/xapi-profiles-communication.md#part-three',
        sparql: `${o.base}/sparql`,
        validateTemplates: `${o.base}/validate_templates`,
        validatePatterns: `${o.base}/validate_patterns`,
        add: o.addTarget,
        remove: o.removeTarget,
        profiles: server.dataset.all().map(h => ({
          id: h.id, version: h.version, current: current.has(h.version),
          ...(h.generatedAtTime ? { generatedAtTime: h.generatedAtTime } : {}),
          ...(label(h.doc, 'prefLabel') !== undefined ? { prefLabel: label(h.doc, 'prefLabel') } : {}),
          builtIn: server.isBuiltIn(h.id),
          ...(server.owner(h.id) ? { addedBy: server.owner(h.id) } : {}),
          document: documentUrl(h.version),
          graph: h.version,
        })),
      });
    } catch (e) { fail(res, e); }
  });

  // The exact document a profile or a version was added as.
  app.get('/xapi/profiles/profile', async (req, res) => {
    open(res);
    try {
      await server.ready();
      const held = typeof req.query.iri === 'string' ? server.dataset.get(req.query.iri) : undefined;
      if (!held) { res.status(404).json({ error: 'No profile or version with that iri is held here.' }); return; }
      res.type('application/ld+json').send(JSON.stringify(held.doc, null, 2));
    } catch (e) { fail(res, e); }
  });

  const sparql = async (req: Request, res: Response) => {
    open(res);
    try {
      await server.ready();
      const body: unknown = req.body;
      const from = (name: string): string[] => {
        const q: unknown = req.query[name], b: unknown = isObj(body) ? body[name] : undefined;
        return [q, b].flatMap((v): unknown[] => Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((v): v is string => typeof v === 'string');
      };
      const query = typeof body === 'string' && body.trim() !== '' ? body
        : isObj(body) && typeof body.query === 'string' ? body.query
          : typeof req.query.query === 'string' ? req.query.query : '';
      if (!query) { res.status(400).json({ error: 'Send the query as `query` (GET, or a POSTed form or JSON), or as an application/sparql-query body.' }); return; }
      const answer = server.dataset.query(query, { defaultGraphUris: from('default-graph-uri'), namedGraphUris: from('named-graph-uri') });
      res.type('application/sparql-results+json').send(JSON.stringify(answer));
    } catch (e) { fail(res, e); }
  };
  app.get('/xapi/profiles/sparql', sparql);
  app.post('/xapi/profiles/sparql', o.urlencoded, o.text, sparql);

  app.post('/xapi/profiles/validate_templates', o.urlencoded, async (req, res) => {
    open(res);
    try {
      const body = isObj(req.body) ? req.body : {};
      const r = await server.validateTemplates(body.statement, body.profile);
      if (r.comments.length === 0) { res.status(204).end(); return; }
      res.status(400).json({ valid: false, comments: r.comments, ...(r.skipped.length ? { notChecked: r.skipped } : {}) });
    } catch (e) { fail(res, e); }
  });

  app.post('/xapi/profiles/validate_patterns', o.urlencoded, async (req, res) => {
    open(res);
    try {
      const body = isObj(req.body) ? req.body : {};
      const r = await server.validatePatterns(body.statements, body.profile);
      if (r.comments.length === 0) { res.status(204).end(); return; }
      res.status(400).json({ valid: false, comments: r.comments });
    } catch (e) { fail(res, e); }
  });
}
