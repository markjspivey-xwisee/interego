/**
 * The xapi-x rules and the controls document over HTTP, on the profile server. Each route is the
 * target of an affordance in ../xapi-profile-server/affordances.ts.
 *
 *   POST /xapi/profiles/lint_decorations   rules X1 to X10 (./lint.ts) over statements, a profile, or both
 *   GET  /xapi/profiles/controls           what the templates named offer, as this deployment serves it (./controls.ts)
 *   POST /xapi/profiles/controls           the same, for the templates a statement follows
 *
 * All three read and change nothing, and none asks for a signature: the lint is a function of
 * what it is sent and of the profiles held, which are public, and the controls document says
 * nothing a statement says. A statement sent here is judged and not kept.
 *
 * The lint fetches nothing. The two lookups rule X9 needs (is this a design idea; is this an
 * affordance) are passed in by the bridge, and the answer says whether each was available, so a
 * profile that passes with a lookup missing is not reported as checked.
 */
import type { Express, Request, Response } from 'express';
import { MAX_PATTERN_STATEMENTS, ProfileServerError, type ProfileServer } from '../xapi-profile-server/service.js';
import { validates, type Json } from '../xapi-profile-server/processor.js';
import type { LintFinding, ProfileExamples } from '../xapi-profile-server/lint.js';
import { lintXapixProfile, lintXapixStatements, type XapixProfileOptions } from './lint.js';
import { controlsDocument, controlsUrl, offersOf, type AffordanceCard } from './controls.js';
import { XAPIX_PROFILE_ID } from './namespace.js';

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v : v === undefined ? [] : [v]).filter((s): s is string => typeof s === 'string' && s !== '');

export interface XapixRouteOptions {
  /** `<bridge>/xapi/profiles`. */
  readonly base: string;
  /** The two lookups of rule X9, as they stand now. Either may be absent: its targets are then checked for shape only. */
  readonly links?: () => Promise<Pick<XapixProfileOptions, 'designIdea' | 'affordance'>>;
  /** An affordance this deployment serves, by its IRI. */
  readonly describeAffordance?: (iri: string) => AffordanceCard | undefined;
}

export interface DecorationLintAnswer {
  findings: LintFinding[];
  clean: boolean;
  /** What was judged, so an empty list of findings is not read as more than it is. */
  checked: { statements: number; declaredBy: string[]; profile?: string; examples?: number };
  /** When a profile was judged: whether each X9 lookup was available. False: those targets were checked for shape only. */
  linksChecked?: { evidences: boolean; offers: boolean };
}

/** The templates of every current profile held, or of the one named, that judge: not deprecated. */
function liveTemplates(server: ProfileServer, profile?: string): Json[] {
  const held = profile === undefined ? server.dataset.current() : [server.dataset.get(profile)].filter(h => h !== undefined);
  return held.flatMap(h => { const t = (h.doc as unknown as Json).templates; return Array.isArray(t) ? t.filter(isObj).filter(x => x.deprecated !== true) : []; });
}

/** Rules X1 to X10 over what was sent. */
export async function lintDecorations(server: ProfileServer, body: unknown, o: Pick<XapixRouteOptions, 'links'>): Promise<DecorationLintAnswer> {
  await server.ready();
  const input = isObj(body) ? body : {};
  const findings: LintFinding[] = [];
  const checked: DecorationLintAnswer['checked'] = { statements: 0, declaredBy: [] };
  const held = (iri: string): Json => {
    const h = server.dataset.get(iri);
    if (!h) throw new ProfileServerError(400, `No profile with id ${iri} is on this server. GET the server root for the ones that are.`);
    return h.doc as unknown as Json;
  };

  if (input.statements !== undefined) {
    const statements = input.statements;
    if (!Array.isArray(statements) || !statements.every(isObj)) throw new ProfileServerError(400, '`statements` is an array of xAPI Statements.');
    if (statements.length > MAX_PATTERN_STATEMENTS) throw new ProfileServerError(413, `Up to ${MAX_PATTERN_STATEMENTS} statements are checked in one request.`);
    // The xapi-x profile declares the decoration keys, so it is always among the profiles read,
    // with the domain profiles the caller names.
    const named = [...new Set([XAPIX_PROFILE_ID, ...strings(input.profiles)])].filter(iri => iri !== XAPIX_PROFILE_ID || server.dataset.get(iri) !== undefined);
    const docs = named.map(held);
    findings.push(...lintXapixStatements(statements, docs, { outcomeVerbs: strings(input.outcomeVerbs) }));
    checked.statements = statements.length;
    checked.declaredBy = named;
  }

  let linksChecked: DecorationLintAnswer['linksChecked'];
  if (input.document !== undefined || input.profile !== undefined) {
    if (input.document !== undefined && !isObj(input.document)) throw new ProfileServerError(400, '`document` is a profile document, as a JSON object.');
    if (input.document === undefined && typeof input.profile !== 'string') throw new ProfileServerError(400, 'Name a held profile by its id in `profile`, or send one as `document`.');
    const doc = input.document !== undefined ? input.document as Json : held(input.profile as string);
    // A held version is judged with the examples it is kept with, unless the caller sends others.
    const kept = input.document === undefined ? server.keptWith(server.dataset.get(input.profile as string)!.version)?.examples : undefined;
    let examples: ProfileExamples = kept ?? { statements: [], sequences: [] };
    if (input.examples !== undefined) {
      const e = input.examples;
      if (!isObj(e) || (e.statements !== undefined && !Array.isArray(e.statements)) || (e.sequences !== undefined && !Array.isArray(e.sequences))) throw new ProfileServerError(400, '`examples` is { statements: [...], sequences: [...] }.');
      examples = { statements: (e.statements ?? []) as ProfileExamples['statements'], sequences: (e.sequences ?? []) as ProfileExamples['sequences'] };
    }
    // Only a profile has links to look up, so only here are the lookups asked for: on the bridge
    // that can mean reading the glossary release, which a request about statements never waits on.
    type Links = Pick<XapixProfileOptions, 'designIdea' | 'affordance'>;
    const none: Links = {};
    const links: Links = o.links ? await o.links().catch(() => none) : none;
    linksChecked = { evidences: links.designIdea !== undefined, offers: links.affordance !== undefined };
    findings.push(...lintXapixProfile(doc, examples, links));
    checked.profile = typeof doc.id === 'string' ? doc.id : '(a document with no id)';
    checked.examples = examples.statements.length;
  }
  if (input.statements === undefined && input.document === undefined && input.profile === undefined)
    throw new ProfileServerError(400, 'Send `statements` (with the ids of the profiles that declare their keys as `profiles`), a profile as `profile` or `document`, or both.');
  return { findings, clean: findings.length === 0, checked, ...(linksChecked ? { linksChecked } : {}) };
}

/** The templates a statement follows, across the current profiles held or the one named: matched, with no rule broken. */
export async function templatesFollowed(server: ProfileServer, statement: Json, profile?: string): Promise<Json[]> {
  await server.ready();
  if (profile !== undefined && !server.dataset.get(profile)) throw new ProfileServerError(400, `No profile with id ${profile} is on this server.`);
  const templates = liveTemplates(server, profile);
  // Each template is judged on its own. Asked of them all at once, `validates` answers with the
  // failing templates alone as soon as one matched template is not followed, so a rule broken in
  // one profile would hide a template the statement does follow in another.
  return templates.filter(t => {
    if (typeof t.id !== 'string') return false;
    let r;
    try { r = validates(statement, [t]); } catch (e) { throw new ProfileServerError(400, (e as Error).message); }
    return r.outcome === 'success';
  });
}

export function mountXapixRoutes(app: Express, server: ProfileServer, o: XapixRouteOptions): void {
  const open = (res: Response) => { res.setHeader('Access-Control-Allow-Origin', '*'); };
  const fail = (res: Response, e: unknown) => {
    if (e instanceof ProfileServerError) { res.status(e.status).json({ error: e.message }); return; }
    res.status(500).json({ error: 'The profile server could not answer.' });
  };
  const describe = o.describeAffordance ?? (() => undefined);

  app.post('/xapi/profiles/lint_decorations', async (req: Request, res: Response) => {
    open(res);
    try { res.json({ ok: true, ...(await lintDecorations(server, req.body, o)) }); } catch (e) { fail(res, e); }
  });

  // What the named templates offer. A template that offers nothing, or an IRI that is not a
  // template held here, is named in the answer and has no controls.
  app.get('/xapi/profiles/controls', async (req: Request, res: Response) => {
    open(res);
    try {
      await server.ready();
      const named = strings(req.query.template);
      if (named.length === 0) { res.status(400).json({ error: 'Name one or more statement templates as `template`.' }); return; }
      if (named.length > 20) { res.status(400).json({ error: 'Up to 20 templates are read in one request.' }); return; }
      const found = named.map(iri => ({ iri, resolved: server.resolve(iri) }));
      const missing = found.filter(f => f.resolved?.kind !== 'template').map(f => f.iri);
      if (missing.length === named.length) { res.status(404).json({ error: 'None of those is a statement template held here.', notTemplates: missing }); return; }
      const templates = found.filter(f => f.resolved?.kind === 'template').map(f => f.resolved!.body as unknown as Json);
      res.json({ ...controlsDocument({ id: controlsUrl(o.base, templates.map(t => String(t.id))), templates, describe }), ...(missing.length ? { notTemplates: missing } : {}) });
    } catch (e) { fail(res, e); }
  });

  // The same for one statement: the templates it follows are found here, and the statement is not kept.
  app.post('/xapi/profiles/controls', async (req: Request, res: Response) => {
    open(res);
    try {
      const body = isObj(req.body) ? req.body : {};
      if (!isObj(body.statement)) { res.status(400).json({ error: '`statement` is one xAPI Statement, as a JSON object.' }); return; }
      const templates = (await templatesFollowed(server, body.statement, typeof body.profile === 'string' ? body.profile : undefined)).filter(t => offersOf(t).length > 0);
      const ids = templates.map(t => String(t.id));
      res.json({ ...controlsDocument({ id: ids.length ? controlsUrl(o.base, ids) : `${o.base}/controls`, templates, describe }), ...(ids.length ? { link: controlsUrl(o.base, ids) } : {}) });
    } catch (e) { fail(res, e); }
  });
}
