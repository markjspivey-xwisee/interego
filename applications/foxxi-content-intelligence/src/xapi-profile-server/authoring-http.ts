/**
 * The authoring tool and the host over HTTP. Every route here is the target of an affordance in
 * ./affordances.ts; an agent reaches them by following those, not by knowing these paths.
 *
 *   write   POST /agent/xapi-profiles/draft | lint | publish, each signed: a draft is its writer's.
 *   host    GET  /xapi/profiles/resource?iri=…   any IRI held here
 *           GET  /xapi/profiles/p/…              a profile written here, at its own IRI
 *           GET  <an own path>/…                 the parts of the deployment's own profile
 *
 * A hosted IRI answers as JSON-LD (the default), or as N-Triples, which is also Turtle, by the
 * request's Accept header. A term that its profile's current version no longer has still answers,
 * with `deprecated: true`.
 */
import type { Express, Request, Response, RequestHandler } from 'express';
import { rateLimit, type Options as RateLimitOptions } from 'express-rate-limit';
import { LintRefused, type DraftView, type ProfileAuthoring } from './authoring.js';
import { emptyExamples, type ExternalTerm, type ProfileExamples } from './lint.js';
import { ProfileServerError, PublicationNotKept, type ProfileServer, type Resolved } from './service.js';

type Body = Record<string, unknown>;
const isObj = (v: unknown): v is Body => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Who signed a request, and what they signed. The bridge passes its own verifier. */
export type VerifySigned = (body: unknown) => Promise<{ ok: true; callerDid: string; payload: Body } | { ok: false; status: number; error: string }>;

export interface AuthoringRouteOptions {
  /** `<bridge>/xapi/profiles`. */
  readonly base: string;
  readonly verify: VerifySigned;
  /**
   * How many requests a caller may make to the signed routes, and over what time. Required: each
   * of these routes verifies a signature, which costs more than the request does, so none is
   * mounted without a limit. The limiter is made here, beside the routes it guards.
   */
  readonly limit: Pick<RateLimitOptions, 'windowMs' | 'limit'> & Partial<RateLimitOptions>;
  /** Called before a publication with who is publishing; throws a ProfileServerError to refuse it (a count per signer, say). */
  readonly beforePublish?: (by: string) => void;
  /** How the bridge sends an action's result (it adds the links that follow). Defaults to plain JSON. */
  readonly send?: (req: Request, res: Response, payload: Body, title: string) => void;
}

const JSON_LD = 'application/ld+json', N_TRIPLES = 'application/n-triples', TURTLE = 'text/turtle';

/** Where an IRI held here is read from this server. */
export const resourceUrl = (base: string, iri: string): string => `${base}/resource?iri=${encodeURIComponent(iri)}`;

function draftPayload(view: DraftView, base: string): Body {
  const d = view.draft;
  return {
    ok: true, profile: d.profile, version: d.version, ...(d.revises ? { revises: d.revises } : {}), updatedAt: d.updatedAt,
    document: d.document, examples: d.examples, external: d.external,
    findings: view.findings, publishable: view.publishable,
    examplesWhenPublished: `Public. The examples are published with the version and served to anyone at ${base}/examples?iri=<version IRI>. Keep real people out of them.`,
    counts: { concepts: count(d.document.concepts), templates: count(d.document.templates), patterns: count(d.document.patterns),
      exampleStatements: d.examples.statements.length, exampleSequences: d.examples.sequences.length },
    lint: `${base.replace(/\/xapi\/profiles$/, '')}/agent/xapi-profiles/lint`,
    publish: `${base.replace(/\/xapi\/profiles$/, '')}/agent/xapi-profiles/publish`,
  };
}
const count = (v: unknown): number => Array.isArray(v) ? v.length : 0;

export function mountProfileAuthoring(app: Express, authoring: ProfileAuthoring, o: AuthoringRouteOptions): void {
  const send = o.send ?? ((_req, res, payload) => { res.json(payload); });
  const guard = rateLimit({ standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'too_many_requests' }, ...o.limit });
  const signed = (title: string, run: (payload: Body, by: string) => Promise<Body>): RequestHandler => async (req, res) => {
    try {
      const auth = await o.verify(req.body);
      if (!auth.ok) { res.status(auth.status).json({ error: auth.error }); return; }
      send(req, res, await run(auth.payload, auth.callerDid), title);
    } catch (e) {
      if (e instanceof LintRefused) { res.status(e.status).json({ error: e.message, publishable: false, findings: e.findings }); return; }
      // Not ok, not published, not immutable: the durable write did not land, and the draft is as it was.
      if (e instanceof PublicationNotKept) {
        res.status(e.status).json({ ok: false, published: false, persisted: false, error: e.message, profile: e.profile, version: e.version,
          draftKept: true, retry: `${o.base.replace(/\/xapi\/profiles$/, '')}/agent/xapi-profiles/publish` });
        return;
      }
      if (e instanceof ProfileServerError) { res.status(e.status).json({ error: e.message }); return; }
      res.status(500).json({ error: 'The profile server could not answer.' });
    }
  };

  app.post('/agent/xapi-profiles/draft', guard, signed('Profile draft', async (p, by) => {
    if (p.profile === undefined) return { ok: true, drafts: await authoring.draftsOf(by) };
    const r = await authoring.edit(p, by);
    return 'discarded' in r ? { ok: true, discarded: r.discarded } : draftPayload(r, o.base);
  }));

  app.post('/agent/xapi-profiles/lint', guard, signed('Profile lint', async (p, by) => {
    if (p.document !== undefined) {
      const examples = isObj(p.examples) ? { ...emptyExamples(), ...p.examples } as ProfileExamples : emptyExamples();
      if (!Array.isArray(examples.statements) || !Array.isArray(examples.sequences)) throw new ProfileServerError(400, '`examples` is { statements: [...], sequences: [...] }.');
      const findings = authoring.lintDocument(p.document, examples, Array.isArray(p.external) ? p.external as ExternalTerm[] : []);
      return { ok: true, findings, publishable: findings.length === 0 };
    }
    return draftPayload(await authoring.lint(p.profile, by), o.base);
  }));

  app.post('/agent/xapi-profiles/publish', guard, signed('Profile version published', async (p, by) => {
    // Lint first: a draft with findings is refused without spending the signer's allowance.
    await authoring.lint(p.profile, by).then(view => { if (!view.publishable) throw new LintRefused(view.findings); });
    o.beforePublish?.(by);
    const r = await authoring.publish(p.profile, by);
    return {
      ok: true, profile: r.held.id, version: r.held.version, generatedAtTime: r.generatedAtTime,
      ...(r.revises ? { wasRevisionOf: r.revises } : {}), deprecated: r.deprecated, immutable: true,
      triples: r.held.stated.length, publishedBy: by,
      document: resourceUrl(o.base, r.held.version), resolve: `${o.base}/resource`,
      validateTemplates: `${o.base}/validate_templates`, validatePatterns: `${o.base}/validate_patterns`, sparql: `${o.base}/sparql`,
      // Public from now on: what the draft's examples were is served to anyone here.
      examples: `${o.base}/examples?iri=${encodeURIComponent(r.held.version)}`,
      holonUri: r.holonUri ?? null, persisted: r.persisted,
    };
  }));
}

export interface HostingRouteOptions {
  /** `<bridge>/xapi/profiles`. */
  readonly base: string;
  /**
   * Paths of this deployment whose address is itself a hosted IRI, with the IRI each stands for:
   * `{ path: '/xapi/profile', iri: 'https://…/xapi/profile' }` serves `/xapi/profile/templates/x`
   * as `https://…/xapi/profile/templates/x`. The path itself is left to whatever already serves it.
   */
  readonly own?: ReadonlyArray<{ path: string; iri: string }>;
}

/** The read side of hosting: an IRI to its representation. */
export function mountProfileHosting(app: Express, server: ProfileServer, o: HostingRouteOptions): void {
  const answer = (req: Request, res: Response, found: Resolved | undefined, iri: string) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept');
    if (!found) { res.status(404).json({ error: `Nothing with the IRI ${iri} is held here.` }); return; }
    const type = req.accepts([JSON_LD, 'application/json', TURTLE, N_TRIPLES]);
    if (type === false) { res.status(406).json({ error: 'This IRI is served as application/ld+json, application/json, text/turtle or application/n-triples.' }); return; }
    const whole = found.kind === 'profile' || found.kind === 'version';
    const links = [`<${resourceUrl(o.base, found.held.version)}>; rel="${whole ? 'canonical' : 'up'}"`, `<${resourceUrl(o.base, found.held.id)}>; rel="collection"`];
    if (found.held.versions.find(v => v.id === found.held.version)?.wasRevisionOf.length)
      for (const prior of found.held.versions.find(v => v.id === found.held.version)!.wasRevisionOf) links.push(`<${resourceUrl(o.base, prior)}>; rel="predecessor-version"`);
    res.setHeader('Link', links.join(', '));
    if (type === TURTLE || type === N_TRIPLES) {
      res.type(type).send(server.ntriples(found.held, whole ? undefined : iri));
      return;
    }
    res.type(type === 'application/json' ? type : JSON_LD).send(JSON.stringify(found.body, null, 2));
  };
  const serve = (iriOf: (req: Request) => string | undefined): RequestHandler => async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { next(); return; }
    try {
      await server.ready();
      const iri = iriOf(req);
      if (iri === undefined) { res.status(400).json({ error: 'Name what to read as `iri`: a profile, a version, a concept, a statement template or a pattern.' }); return; }
      answer(req, res, server.resolve(iri), iri);
    } catch { res.status(500).json({ error: 'The profile server could not answer.' }); }
  };

  app.get('/xapi/profiles/resource', serve(req => typeof req.query.iri === 'string' && req.query.iri !== '' ? req.query.iri : undefined));
  // The examples a version was published with: what its writer showed the lint. Public, like the
  // version itself: no signature is asked for. The writer is told so when drafting and publishing.
  // A built-in profile answers with the examples the deployment keeps with it, and no publishedAt.
  app.get('/xapi/profiles/examples', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    try {
      await server.ready();
      const held = typeof req.query.iri === 'string' ? server.dataset.get(req.query.iri) : undefined;
      const kept = held ? server.keptWith(held.version) : undefined;
      if (!held || !kept) { res.status(404).json({ error: 'No version with that iri was published from a draft here, so none has examples kept with it.' }); return; }
      res.json({ profile: held.id, version: held.version, ...(kept.at ? { publishedAt: kept.at } : {}), builtIn: server.isBuiltIn(held.id), examples: kept.examples, external: kept.external });
    } catch { res.status(500).json({ error: 'The profile server could not answer.' }); }
  });
  // A profile written here has its IRI under <base>/p/, so the IRI is this address.
  app.use('/xapi/profiles/p', serve(req => `${o.base}/p${req.path}`));
  for (const own of o.own ?? []) {
    app.use(own.path, (req, res, next) => {
      // The path itself has its own route; only what is beneath it, and held, is answered here.
      if (req.path === '/' || (req.method !== 'GET' && req.method !== 'HEAD')) { next(); return; }
      const iri = `${own.iri}${req.path}`;
      void server.ready().then(() => { const found = server.resolve(iri); if (found) answer(req, res, found, iri); else next(); }).catch(() => { next(); });
    });
  }
}
