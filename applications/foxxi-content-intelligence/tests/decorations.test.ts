/**
 * The decorator kit and its five decorations (LRS-X, LMS-X, LTI-X, LER-X, TLA-X): each spec holds
 * together; every term it names exists where it says; the catalog and the proposals are separate
 * documents in W3C and Interego terms, each saying whose it is; binding fills templates and fetches
 * nothing; and the bridge serves all of it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readdirSync, readFileSync } from 'node:fs';
import { DECORATIONS } from '../src/decorations/index.js';
import {
  bindControls, catalogGraph, checkDecoration, expandTemplate, notAffiliated, proposalsGraph, proposalsSssom, templateVariables, turtleOf,
} from '../src/decorations/kit.js';
import { attachDecorationRoutes } from '../src/decorations/routes.js';
import { parseTurtle } from '../src/ns/rdf.js';
import { LtiPlatform } from '../src/lti-platform.js';
import { foxxiAdminAffordances, foxxiAffordances } from '../affordances.js';

const ALL = Object.values(DECORATIONS);
const BASE = 'https://bridge.example';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const HYDRA = 'http://www.w3.org/ns/hydra/core#';
const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';

/** The latest released Turtle of one of Foxxi's ontologies. */
function released(module: string): string {
  const dir = new URL(`../ns-releases/${module}/`, import.meta.url);
  const latest = readdirSync(dir).filter(f => /^\d{4}\.\d+\.\d+\.ttl$/.test(f)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).at(-1)!;
  return readFileSync(new URL(latest, dir), 'utf8');
}

describe('each decoration holds together', () => {
  it.each(ALL.map(d => [d.id, d] as const))('%s: every control, alignment, enactment and gap names a part, and every template variable is bound', (_id, d) => {
    expect(checkDecoration(d)).toEqual([]);
  });

  it('every enactment is a Foxxi affordance this bridge declares', () => {
    const actions = new Set([...foxxiAffordances, ...foxxiAdminAffordances].map(a => String(a.action)));
    const missing = ALL.flatMap(d => d.enactments.filter(e => !actions.has(e.action)).map(e => `${d.id}: ${e.action}`));
    expect(missing).toEqual([]);
  });

  it('every Foxxi ontology term a decoration names is declared in that ontology\'s release', () => {
    const modules: Record<string, [string, string]> = {
      'https://foxxi-bridge.interego.xwisee.com/ns/xapi#': ['xapi', 'foxxi-xapi'],
      'https://foxxi-bridge.interego.xwisee.com/ns/ieee-ler#': ['ieee-ler', 'foxxi-ieee-ler'],
      'https://foxxi-bridge.interego.xwisee.com/ns/adl-tla#': ['adl-tla', 'foxxi-adl-tla'],
    };
    const named = ALL.flatMap(d => [...d.alignments.map(a => a.target), ...d.parts.flatMap(p => (p.modelledBy ? [p.modelledBy] : []))]);
    const foxxi = named.filter(t => t.startsWith('https://foxxi-bridge.'));
    expect(foxxi.length).toBeGreaterThan(20);
    const undeclared = foxxi.filter(t => {
      const ns = Object.keys(modules).find(n => t.startsWith(n));
      if (!ns) return true;
      const [module, prefix] = modules[ns]!;
      return !new RegExp(`^${prefix}:${t.slice(ns.length)} a `, 'm').test(released(module));
    });
    expect(undeclared).toEqual([]);
  });

  it('names I2IDL concepts by their IRIs, and other targets by IRIs in a namespace it declares', () => {
    for (const d of ALL) for (const a of d.alignments) {
      expect(a.target).toMatch(/^https:\/\/(id\.i2idl\.org\/concepts\/[a-z0-9-]+|foxxi-bridge\.interego\.xwisee\.com\/ns\/[a-z-]+#[A-Za-z]+)$/);
    }
  });

  it('acts through the bridge only at addresses the bridge serves', async () => {
    const affordanceTargets = new Set([...foxxiAffordances, ...foxxiAdminAffordances].map(a => a.targetTemplate.replace('{base}', '')));
    const sources = [
      readFileSync(new URL('../bridge/server.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/lti13.ts', import.meta.url), 'utf8'),
      readFileSync(new URL('../src/xapi-lrs.ts', import.meta.url), 'utf8'),
    ].join('\n');
    const platform = new LtiPlatform({ selfBaseUrl: BASE });
    const platformPaths = new Set([new URL(platform.jwksUrl).pathname, `${new URL(platform.issuer).pathname}/.well-known/openid-configuration`]);
    const paths = ALL.flatMap(d => d.controls.filter(c => c.target.startsWith('{+bridge}')).map(c => c.target.slice('{+bridge}'.length).replace(/\{\?[^}]*\}$/, '')));
    expect(paths.length).toBeGreaterThan(20);
    const unserved = paths.filter(p => !affordanceTargets.has(p) && !platformPaths.has(p) && !sources.includes(`'${p}'`) && !sources.includes(`\`${p}\``));
    expect(unserved).toEqual([]);
  });
});

describe('the documents', () => {
  const lrs = DECORATIONS['lrs-x'];
  const lti = DECORATIONS['lti-x'];

  it('publish the catalog as a HyprCat catalog of affordance-bearing controls, with templates for what the caller binds', () => {
    const g = parseTurtle(turtleOf(catalogGraph(lrs, BASE), lrs, 'catalog'));
    const types = (s: string) => g.triples.filter(t => t.s.value === s && t.p.value === RDF_TYPE).map(t => t.o.value);
    expect(types(`${BASE}/decorations/lrs-x`)).toEqual(expect.arrayContaining(['http://www.w3.org/ns/dcat#Catalog', 'https://markjspivey-xwisee.github.io/interego/ns/hyprcat#FederatedCatalog']));
    const control = `${BASE}/decorations/lrs-x#control-statements-query`;
    expect(types(control)).toEqual(expect.arrayContaining([`${IEP}Affordance`, `${HYDRA}Operation`, 'http://www.w3.org/ns/dcat#Distribution']));
    const target = g.triples.find(t => t.s.value === control && t.p.value === `${HYDRA}target`)!.o;
    const template = g.triples.find(t => t.s.value === target.value && t.p.value === `${HYDRA}template`)!.o.value;
    expect(template).toBe('{+endpoint}/statements{?statementId,agent,verb,activity,registration,related_activities,related_agents,since,until,limit,format,attachments,ascending}');
    expect(g.triples.some(t => t.s.value === `${BASE}/decorations/lrs-x#statements` && t.p.value === `${IEP}affordance` && t.o.value === control)).toBe(true);
  });

  it('fill in the serving bridge, so a control that acts through Foxxi is a plain address', () => {
    const g = parseTurtle(turtleOf(catalogGraph(lti, BASE), lti, 'catalog'));
    const keys = g.triples.find(t => t.s.value === `${BASE}/decorations/lti-x#control-tool-keys` && t.p.value === `${HYDRA}target`)!.o;
    expect(keys).toMatchObject({ termType: 'NamedNode', value: `${BASE}/lti/.well-known/jwks.json` });
    const login = g.triples.find(t => t.s.value === `${BASE}/decorations/lti-x#control-tool-login` && t.p.value === `${HYDRA}target`)!.o;
    expect(g.triples.find(t => t.s.value === login.value && t.p.value === `${HYDRA}template`)!.o.value).toBe(`${BASE}/lti/login{?iss,login_hint,target_link_uri,lti_message_hint,client_id,lti_deployment_id}`);
  });

  it('keep the proposals apart, as SKOS mappings with their reasons, enactments and gaps, all Hypothetical', () => {
    const tla = DECORATIONS['tla-x'];
    const ttl = turtleOf(proposalsGraph(tla, BASE), tla, 'proposals');
    expect(ttl).toMatch(/^# TLA-X proposals \(Hypothetical\)/);
    const g = parseTurtle(ttl);
    for (const a of tla.alignments) expect(g.triples.some(t => t.s.value === `${BASE}/decorations/tla-x#${a.part}` && t.p.value === `${SKOS}${a.relation}` && t.o.value === a.target)).toBe(true);
    const description = g.triples.find(t => t.s.value === `${BASE}/decorations/tla-x/proposals` && t.p.value === 'http://purl.org/dc/terms/description')!.o.value;
    expect(description).toMatch(/Hypothetical: none is settled until reviewers ratify it, and none is a statement by the ADL Initiative\./);
    expect(g.triples.filter(t => t.p.value === `${IEP}action`)).toHaveLength(tla.enactments.length);
    // The catalog carries no proposal.
    const catalog = parseTurtle(turtleOf(catalogGraph(tla, BASE), tla, 'catalog'));
    expect(catalog.triples.some(t => t.p.value.startsWith(SKOS) && /Match$/.test(t.p.value))).toBe(false);
  });

  it('say in every document whose they are, and that the publisher of what they decorate did not make them', () => {
    for (const d of ALL) {
      const statement = notAffiliated(d);
      expect(statement).toContain(`not affiliated with or endorsed by ${d.decorates.publisher}`);
      for (const g of [catalogGraph(d, BASE), proposalsGraph(d, BASE)]) expect(g.triples.some(t => t.p.value === RDFS_COMMENT && t.o.value === statement)).toBe(true);
      expect(proposalsSssom(d, BASE)).toContain(`#comment: "${statement}"`);
    }
    expect(notAffiliated(DECORATIONS['lrs-x'])).toContain('not affiliated with or endorsed by the IEEE, or the vendor of any LRS it is bound to');
  });

  it('write the proposals as an SSSOM mapping set, a gap as sssom:NoTermFound', () => {
    const lms = DECORATIONS['lms-x'];
    const tsv = proposalsSssom(lms, BASE);
    const rows = tsv.split('\n').filter(l => l && !l.startsWith('#'));
    expect(rows[0]).toBe('subject_id\tsubject_label\tpredicate_id\tobject_id\tobject_label\tmapping_justification\tcomment');
    expect(rows).toHaveLength(1 + lms.alignments.length + (lms.gaps?.length ?? 0));
    expect(rows).toContain('lms-x:lms\tLearning management system\tskos:exactMatch\tsssom:NoTermFound\t\tsemapv:ManualMappingCuration\tthe I2IDL glossary (v0.0.86): It has no term for a learning management system.');
    expect(tsv).toContain(`#  lms-x: "${BASE}/decorations/lms-x#"`);
    expect(tsv).toContain('#  i2idl: "https://id.i2idl.org/concepts/"');
  });
});

describe('binding an instance decoration', () => {
  const lrs = DECORATIONS['lrs-x'];

  it('fills the instance\'s endpoint and leaves the query variables for each call', () => {
    const bound = bindControls(lrs, { endpoint: 'https://lrs.example.com/xapi/' }, BASE);
    if (!bound.ok) throw new Error(bound.error);
    expect(bound.controls).toHaveLength(lrs.controls.length);
    expect(bound.controls.find(c => c.id === 'about')).toMatchObject({ method: 'GET', href: 'https://lrs.example.com/xapi/about', readOnly: true });
    expect(bound.controls.find(c => c.id === 'state-put')).toMatchObject({ method: 'PUT', href: 'https://lrs.example.com/xapi/activities/state{?activityId,agent,registration,stateId}', headers: { 'X-Experience-API-Version': '2.0.0' } });
  });

  it('gives only the controls whose variables were bound', () => {
    const bound = bindControls(DECORATIONS['lms-x'], { oneroster: 'https://lms.example.com' }, BASE);
    if (!bound.ok) throw new Error(bound.error);
    expect(bound.controls.map(c => c.id)).toEqual(['roster-users', 'roster-classes', 'roster-enrollments', 'roster-courses']);
    expect(bound.controls[0]!.href).toBe('https://lms.example.com/ims/oneroster/rostering/v1p2/users{?limit,offset,sort,filter,fields}');
  });

  it('takes only https URLs (http on loopback), with no credentials, for variables it binds', () => {
    expect(bindControls(lrs, { endpoint: 'http://lrs.example.com/xapi' }, BASE)).toEqual({ ok: false, error: 'endpoint must be an https URL' });
    expect(bindControls(lrs, { endpoint: 'https://user:secret@lrs.example.com/xapi' }, BASE)).toEqual({ ok: false, error: 'endpoint must not carry credentials' });
    expect(bindControls(lrs, { endpoint: 'not a url' }, BASE)).toEqual({ ok: false, error: 'endpoint is not a URL' });
    expect(bindControls(lrs, { bridge: 'https://evil.example' }, BASE)).toEqual({ ok: false, error: 'LRS-X binds no variable named bridge' });
    expect(bindControls(lrs, { endpoint: 'http://127.0.0.1:6789/xapi' }, BASE).ok).toBe(true);
  });

  it('expands RFC 6570 simple, reserved and form-style query expressions', () => {
    expect(expandTemplate('{+a}/x{?b,c}', { a: 'https://h.example/p', b: 'one two', c: undefined })).toBe('https://h.example/p/x?b=one%20two');
    expect(expandTemplate('/u/{id}', { id: 'a/b' })).toBe('/u/a%2Fb');
    expect(templateVariables('{+endpoint}/agents{?agent}')).toEqual({ path: ['endpoint'], query: ['agent'] });
  });
});

describe('the bridge serves the decorations', () => {
  let server: Server;
  let base = '';
  beforeAll(async () => {
    server = createServer();
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // The bridge's app: the shared vertical bridge's express, with its JSON parser in front.
    const sharedExpress = createRequire(new URL('../../_shared/vertical-bridge/index.ts', import.meta.url))('express') as { (): Express; json(o: object): never };
    const app = sharedExpress();
    app.use(sharedExpress.json({ limit: '50mb' }));
    attachDecorationRoutes(app, { baseUrl: base });
    server.on('request', app);
  });
  afterAll(() => new Promise<void>((r) => { server.close(() => r()); }));
  const get = (path: string, accept?: string) => fetch(`${base}${path}`, accept ? { headers: { Accept: accept } } : {});

  it('lists them', async () => {
    const r = await (await get('/decorations')).json() as { decorations: Array<{ id: string; catalog: string; bindings?: string[] }> };
    expect(r.decorations.map(d => d.id)).toEqual(['lrs-x', 'lms-x', 'lti-x', 'ler-x', 'tla-x']);
    expect(r.decorations[0]).toMatchObject({ catalog: `${base}/decorations/lrs-x`, bindings: ['endpoint'] });
  });

  it('serves a catalog as Turtle by default, and as JSON-LD, JSON or HTML when asked', async () => {
    const ttl = await get('/decorations/ler-x');
    expect(ttl.headers.get('content-type')).toMatch(/^text\/turtle/);
    expect(parseTurtle(await ttl.text()).size).toBeGreaterThan(100);
    const ld = await (await get('/decorations/ler-x', 'application/ld+json')).json() as { '@graph': unknown[] };
    expect(ld['@graph'].length).toBeGreaterThan(10);
    const view = await (await get('/decorations/ler-x', 'application/json')).json() as { parts: Array<{ id: string; proposed: { modalStatus: string } }> };
    expect(view.parts.find(p => p.id === 'enterprise-learner-record')!.proposed.modalStatus).toBe('Hypothetical');
    const html = await (await get('/decorations/ler-x', 'text/html')).text();
    expect(html).toContain('not affiliated with or endorsed by the IEEE and its Learning Technology Standards Committee');
    expect(html).toContain(`POST ${base}/foxxi/assemble_learner_record`);
    expect((await get('/decorations/ler-x', 'image/png')).status).toBe(406);
    expect((await get('/decorations/nope')).status).toBe(404);
  });

  it('serves the proposals apart: Turtle, JSON-LD and SSSOM', async () => {
    expect(await (await get('/decorations/tla-x/proposals')).text()).toMatch(/^# TLA-X proposals \(Hypothetical\)/);
    expect((await get('/decorations/tla-x/proposals', 'text/tab-separated-values')).headers.get('content-type')).toMatch(/^text\/tab-separated-values/);
    expect(await (await get('/decorations/tla-x/proposals.sssom.tsv')).text()).toContain('#mapping_set_title: "TLA-X — proposed alignments"');
  });

  it('binds an instance decoration\'s controls for an agent, and refuses what it cannot bind', async () => {
    const bind = (body: unknown) => fetch(`${base}/agent/decorations/bind`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const ok = await (await bind({ decoration: 'lms-x', values: { lineitem: 'https://lms.example.com/courses/42/lineitems/7' } })).json() as { controls: Array<{ id: string; href: string }>; unbound: string[] };
    expect(ok.controls.map(c => [c.id, c.href])).toEqual([
      ['score-post', 'https://lms.example.com/courses/42/lineitems/7/scores'],
      ['results-read', 'https://lms.example.com/courses/42/lineitems/7/results{?user_id,limit}'],
    ]);
    expect(ok.unbound).toEqual(['configuration', 'jwks', 'lineitems', 'memberships', 'oneroster']);
    expect((await bind({ decoration: 'tla-x', values: {} })).status).toBe(400);
    expect((await bind({ decoration: 'lrs-x', values: { endpoint: 'http://lrs.example.com' } })).status).toBe(400);
    expect((await bind({ decoration: 'lrs-x', values: { endpoint: 7 } })).status).toBe(400);
    expect((await bind({ decoration: 'nope' })).status).toBe(400);
  });
});
