/**
 * The decorations, dereferenceable on the bridge:
 *
 *   GET  /decorations                        every decoration, with its documents
 *   GET  /decorations/:id                    its catalog: Turtle, JSON-LD, JSON (the agent view) or HTML
 *   GET  /decorations/:id/proposals          its proposals (Hypothetical): Turtle, JSON-LD or SSSOM/TSV
 *   GET  /decorations/:id/proposals.sssom.tsv
 *   POST /agent/decorations/bind             an instance decoration's controls, bound to your instance
 *
 * Binding is string work: the bridge contacts nothing it is given.
 */
import type { Express, Request, Response } from 'express';
import { turtleIriRef } from '@interego/core';
import { htmlEscape, page } from '../lti-player.js';
import { negotiate } from '../ns/rdf.js';
import { DECORATIONS, decorationById } from './index.js';
import {
  bindControls, canonicalDecorationBase, catalogGraph, decorationIri, decorationView, jsonLdOf, notAffiliated, originOf, proposalsGraph, proposalsIri, proposalsSssom, turtleOf,
  type DecorationSpec,
} from './kit.js';

const CATALOG_OFFERS = ['text/turtle', 'application/ld+json', 'application/json', 'text/html'] as const;
const PROPOSAL_OFFERS = ['text/turtle', 'application/ld+json', 'text/tab-separated-values'] as const;

function renderHtml(spec: DecorationSpec, base: string, canonicalBase?: string): string {
  const doc = decorationIri(base, spec.id, canonicalBase);
  const parts = spec.parts.map(p => {
    const controls = spec.controls.filter(c => c.part === p.id)
      .map(c => `<li><code>${htmlEscape(c.method)} ${htmlEscape(c.target.replace('{+bridge}', base))}</code> — ${htmlEscape(c.title)}${c.auth ? `<br><span class="muted">${htmlEscape(c.auth)}</span>` : ''}</li>`).join('');
    const proposed = [
      ...spec.alignments.filter(a => a.part === p.id).map(a => `${a.relation} <a href="${htmlEscape(a.target)}">${htmlEscape(a.targetLabel)}</a>`),
      ...spec.enactments.filter(e => e.part === p.id).map(e => `${e.role} by <code>${htmlEscape(e.action.split(':').pop()!)}</code>`),
      ...(spec.gaps ?? []).filter(g => g.part === p.id).map(g => `no term in ${htmlEscape(g.vocabulary)}`),
    ];
    return `<div class="card" id="${htmlEscape(p.id)}"><b>${htmlEscape(p.label)}</b>${p.identifier ? ` <code>${htmlEscape(p.identifier)}</code>` : ''}
<p>${htmlEscape(p.description)}</p><p class="muted">${htmlEscape(p.cites)}${p.citeUrl ? ` · <a href="${htmlEscape(p.citeUrl)}">specification</a>` : ''}</p>
${controls ? `<ul>${controls}</ul>` : ''}${proposed.length ? `<p class="muted">Proposed (Hypothetical): ${proposed.join('; ')}</p>` : ''}</div>`;
  }).join('');
  const inner = `<h1>${htmlEscape(spec.title)}</h1><p>${htmlEscape(spec.summary)}</p>
<p class="muted">${htmlEscape(notAffiliated(spec))}</p>
<p>Turtle and JSON-LD at <code>${htmlEscape(doc)}</code>; proposals at <a href="${htmlEscape(proposalsIri(base, spec.id, canonicalBase))}">${htmlEscape(proposalsIri(base, spec.id, canonicalBase))}</a>.</p>${parts}`;
  return page(`${spec.title} · Foxxi decoration`, `Foxxi decorations · ${originOf(spec).catalog}`, inner);
}

export function attachDecorationRoutes(app: Express, opts: { baseUrl: string; canonicalBase?: string }): void {
  const base = opts.baseUrl.replace(/\/$/, '');
  const canonicalBase = opts.canonicalBase === undefined ? undefined : canonicalDecorationBase(opts.canonicalBase);
  const link = (res: Response, iri: string): void => {
    if (canonicalBase !== undefined) {
      const target = turtleIriRef(iri);
      if (target === null) throw new Error('canonical decoration identity is not serializable');
      res.setHeader('Link', `${target}; rel="canonical"`);
    }
  };
  const open = (res: Response): void => { res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Vary', 'Accept'); };
  const notFound = (res: Response): void => { res.status(404).json({ error: 'no such decoration', decorations: Object.keys(DECORATIONS).map(id => decorationIri(base, id as keyof typeof DECORATIONS, canonicalBase)) }); };

  app.get('/decorations', (_req, res) => {
    open(res);
    res.json({
      kind: 'decorations',
      note: 'Each decorates a system Foxxi does not control, keeping the system\'s record apart from what Foxxi adds (the catalog) and proposes (Hypothetical). The pattern: docs/patterns/decorating-an-external-system.md in the Interego repository.',
      decorations: Object.values(DECORATIONS).map(d => ({
        id: d.id, title: d.title, version: d.version, summary: d.summary, decorates: d.decorates.name, kind: d.decorates.kind,
        catalog: decorationIri(base, d.id, canonicalBase), proposals: proposalsIri(base, d.id, canonicalBase),
        ...(d.decorates.bindings ? { bindings: Object.keys(d.decorates.bindings) } : {}),
      })),
    });
  });

  app.get('/decorations/:id/proposals.sssom.tsv', (req: Request, res: Response) => {
    const spec = decorationById(String(req.params.id));
    if (!spec) { notFound(res); return; }
    open(res);
    link(res, `${proposalsIri(base, spec.id, canonicalBase)}.sssom.tsv`);
    res.type('text/tab-separated-values').send(proposalsSssom(spec, base, canonicalBase));
  });

  app.get('/decorations/:id/proposals', (req: Request, res: Response) => {
    const spec = decorationById(String(req.params.id));
    if (!spec) { notFound(res); return; }
    open(res);
    link(res, proposalsIri(base, spec.id, canonicalBase));
    const type = negotiate(req.headers.accept ?? '*/*', PROPOSAL_OFFERS);
    if (!type) { res.status(406).json({ error: 'not acceptable', offers: PROPOSAL_OFFERS }); return; }
    if (type === 'text/tab-separated-values') { res.type(type).send(proposalsSssom(spec, base, canonicalBase)); return; }
    const g = proposalsGraph(spec, base, canonicalBase);
    if (type === 'application/ld+json') { res.type(type).send(JSON.stringify(jsonLdOf(g), null, 2)); return; }
    res.type('text/turtle').send(turtleOf(g, spec, 'proposals'));
  });

  app.get('/decorations/:id', (req: Request, res: Response) => {
    const spec = decorationById(String(req.params.id));
    if (!spec) { notFound(res); return; }
    open(res);
    link(res, decorationIri(base, spec.id, canonicalBase));
    const type = negotiate(req.headers.accept ?? '*/*', CATALOG_OFFERS);
    if (!type) { res.status(406).json({ error: 'not acceptable', offers: CATALOG_OFFERS }); return; }
    if (type === 'application/json') { res.json(decorationView(spec, base, canonicalBase)); return; }
    if (type === 'text/html') { res.type('html').send(renderHtml(spec, base, canonicalBase)); return; }
    const g = catalogGraph(spec, base, canonicalBase);
    if (type === 'application/ld+json') { res.type(type).send(JSON.stringify(jsonLdOf(g), null, 2)); return; }
    res.type('text/turtle').send(turtleOf(g, spec, 'catalog'));
  });

  app.post('/agent/decorations/bind', (req: Request, res: Response) => {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const spec = typeof body.decoration === 'string' ? decorationById(body.decoration) : undefined;
    if (!spec) { res.status(400).json({ error: 'decoration must name one of the decorations', decorations: Object.keys(DECORATIONS) }); return; }
    if (!spec.decorates.bindings) { res.status(400).json({ error: `${spec.title} decorates a ${spec.decorates.kind}, not an instance: its controls need no binding`, catalog: decorationIri(base, spec.id, canonicalBase) }); return; }
    const values = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values as Record<string, unknown> : {};
    if (Object.values(values).some(v => typeof v !== 'string')) { res.status(400).json({ error: 'every value must be a URL string' }); return; }
    const bound = bindControls(spec, values as Record<string, string>, base);
    if (!bound.ok) { res.status(400).json({ error: bound.error }); return; }
    res.json({
      kind: 'bound-decoration', decoration: spec.id, title: spec.title, catalog: decorationIri(base, spec.id, canonicalBase), values,
      controls: bound.controls,
      unbound: Object.keys(spec.decorates.bindings).filter(k => !(k in values)),
      note: `The controls whose variables you gave, with the query variables left for each call. Nothing was fetched: the bridge only filled the templates. ${notAffiliated(spec)}`,
    });
  });
}
