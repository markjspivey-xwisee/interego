/** The same readonly methodology resource is served by AGP and FOXXI. */
import type { Express, Request, Response } from 'express';
import { renderHypermediaMarkdown } from '@interego/core';
import { sendHmd, wantsHmd, hmdProse, affordanceControl, sendActionResult } from '../../_shared/hypermedia/index.js';
import { interventionMethodAffordances } from '../method-affordances.js';
import { AGP_NS, readMethodsTurtle } from '../src/ontology.js';
import { interventionMethods, findInterventionMethod, reviewMethodEvidence, MethodEvidenceInputError,
  METHOD_CONTEXT, type InterventionMethod } from '../src/intervention-methods.js';

function methodBody(m: InterventionMethod): string {
  return `## ${m.title}\n\n${m.appliesWhen}\n\nVersion: ${m.version}. Token: ${m.token}.\n\n`
    + m.steps.map(s => `### ${s.sequence}. ${s.title}\n\n${s.description}\n\n`
      + `Required criteria: ${s.requires.join(', ')}.\n\nNext: ${s.next.join(', ')}.`
      + (s.revisits.length ? ` Revisit: ${s.revisits.join(', ')}.` : '')).join('\n\n')
    + '\n\n### Required evidence\n\n'
    + m.criteria.map(c => `- **${c.title}**: ${c.workProduct}. ${c.description}\n  Criterion: ${c['@id']}`).join('\n');
}

export function attachInterventionMethodRoutes(app: Express, selfBaseUrl: string): void {
  const base = selfBaseUrl.replace(/\/+$/, '');
  app.get('/performance/methods', (req: Request, res: Response) => {
    res.vary('Accept');
    res.setHeader('Access-Control-Allow-Origin', '*');
    const requested = req.query.method;
    if (requested !== undefined && (typeof requested !== 'string' || !requested.trim() || requested.length > 2048)) {
      res.status(400).json({ error: 'method must be a non-empty profile token or IRI' }); return;
    }
    const selected = typeof requested === 'string' ? findInterventionMethod(requested) : undefined;
    if (requested !== undefined && !selected) { res.status(404).json({ error: 'Unknown methodology', catalogue: `${base}/performance/methods` }); return; }
    const methods = selected ? [selected] : interventionMethods();
    const format = String(req.query.format ?? '').toLowerCase();
    // Turtle is the canonical connected graph, including dependencies. A selected
    // profile stays in that graph; do not ship a partial graph with dangling steps.
    if (format === 'turtle' || (!format && req.accepts(['application/ld+json', 'text/turtle', 'text/markdown']) === 'text/turtle')) {
      res.type('text/turtle').send(readMethodsTurtle()); return;
    }
    const id = selected ? `${base}/performance/methods?method=${encodeURIComponent(selected.token)}` : `${base}/performance/methods`;
    const links = [
      { label: 'Canonical method graph', href: `${base}/performance/methods?format=turtle`, rel: 'alternate', type: 'text/turtle' },
      { label: 'Affordance authority', href: `${base}/affordances`, rel: 'describedby', type: 'text/turtle' },
      ...interventionMethods().map(m => ({ label: m.title, href: `${base}/performance/methods?method=${encodeURIComponent(m.token)}&format=markdown`, rel: 'item', type: 'text/markdown' })),
      ...[...new Set(methods.flatMap(m => m.criteria.flatMap(c => c.source)))].map(href => ({ label: 'Method source guidance', href, rel: 'related', type: 'text/html' })),
    ];
    if (wantsHmd(req)) {
      sendHmd(res, renderHypermediaMarkdown({ id, type: 'schema:Collection', descriptorUrl: `${base}/affordances`,
        title: selected?.title ?? 'Performance consulting and intervention methods',
        body: hmdProse('# Performance consulting and intervention methods\n\n'
          + 'Contextualize the work before choosing an intervention. These practice profiles define work and evidence to review; they do not certify quality or prove effectiveness.\n\n'
          + methods.map(methodBody).join('\n\n')),
        links, controls: interventionMethodAffordances.map(a => affordanceControl(a, base)),
      })); return;
    }
    res.type('application/ld+json').json({ '@context': METHOD_CONTEXT, '@id': id,
      '@graph': methods, 'http://www.w3.org/2000/01/rdf-schema#seeAlso': links.map(l => ({ '@id': l.href })),
      'https://schema.org/about': { '@id': `${AGP_NS}Methodology` } });
  });
  app.post('/performance/methods/review', (req: Request, res: Response) => {
    try {
      sendActionResult(req, res, reviewMethodEvidence(req.body), base, 'Method evidence coverage', interventionMethodAffordances,
        [{ label: 'Method catalogue', href: `${base}/performance/methods?format=markdown`, rel: 'related', type: 'text/markdown' }]);
    } catch (error) {
      if (!(error instanceof MethodEvidenceInputError)) throw error;
      res.status(400).json({ error: error.message, catalogue: `${base}/performance/methods`, verified: false });
    }
  });
}
