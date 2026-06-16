/**
 * Shared dereferenceable-ontology serving.
 *
 * Every Interego vertical (and the substrate) should AUTHOR its ontology in
 * OWL (+ SHACL) AND SERVE it as dereferenceable RESTful linked data with
 * content negotiation + HATEOAS — not just ship a `.ttl` that nothing resolves.
 * The extraction survey found most verticals authored-but-did-not-serve; this
 * module makes the serve side a one-liner so the pattern is uniform everywhere.
 *
 * Wire it into a vertical bridge via the createVerticalBridge `middleware` hook:
 *
 *   import { ontologyServingMiddleware } from '../../_shared/ontology-serve/index.js';
 *   const app = createVerticalBridge({
 *     ...,
 *     middleware: ontologyServingMiddleware({
 *       mountPath: '/ns/adp',
 *       ontologyIri: 'https://.../adp',
 *       namespace: 'https://.../adp#',
 *       ontologyTurtle: () => readFileSync(new URL('../ontology/adp.ttl', import.meta.url), 'utf8'),
 *     }),
 *   });
 *
 * Routes registered (shapes/jsonld/term are optional — provide them when the
 * vertical has them):
 *   GET <mountPath>             -> Turtle (always) | JSON-LD (when `jsonld` given + Accept asks)
 *   GET <mountPath>/shapes      -> SHACL Turtle (when `shapesTurtle` given)
 *   GET <mountPath>/term/:name  -> per-term JSON-LD (when `term` resolver given);
 *                                  an owned-namespace fragment NEVER 404s — it
 *                                  returns a minimal back-pointer to the ontology.
 */
import type { Express, Request, Response } from 'express';

export interface OntologyServingOptions {
  /** Mount path, e.g. '/ns/agp'. */
  readonly mountPath: string;
  /** The owl:Ontology IRI (no trailing #). */
  readonly ontologyIri: string;
  /** Namespace base, with trailing '#'. */
  readonly namespace: string;
  /** Canonical OWL Turtle — a string or a lazy getter (read from disk on demand). */
  readonly ontologyTurtle: string | (() => string);
  /** Optional SHACL shapes Turtle, served at <mountPath>/shapes. */
  readonly shapesTurtle?: string | (() => string);
  /** Optional full-ontology JSON-LD, served when Accept asks for JSON. */
  readonly jsonld?: Record<string, unknown> | (() => Record<string, unknown>);
  /** Optional per-term resolver for <mountPath>/term/:name. */
  readonly term?: (name: string) => Record<string, unknown> | null;
}

const resolve = <T>(v: T | (() => T)): T => (typeof v === 'function' ? (v as () => T)() : v);
const wantsJson = (req: Request): boolean => /json/i.test(req.headers.accept ?? '');

/** Register the dereferenceable ontology routes on an existing Express app. */
export function attachOntologyServing(app: Express, opts: OntologyServingOptions): void {
  const mount = opts.mountPath.replace(/\/$/, '');
  const cors = (res: Response) => res.setHeader('Access-Control-Allow-Origin', '*');

  app.get(mount, (req: Request, res: Response) => {
    cors(res);
    if (opts.jsonld && wantsJson(req)) res.type('application/ld+json').json(resolve(opts.jsonld));
    else res.type('text/turtle').send(resolve(opts.ontologyTurtle));
  });

  if (opts.shapesTurtle !== undefined) {
    app.get(`${mount}/shapes`, (_req: Request, res: Response) => {
      cors(res);
      res.type('text/turtle').send(resolve(opts.shapesTurtle!));
    });
  }

  if (opts.term) {
    app.get(`${mount}/term/:name`, (req: Request, res: Response) => {
      cors(res);
      const node = opts.term!(req.params.name);
      res.type('application/ld+json').json(node ?? {
        '@id': `${opts.namespace}${req.params.name}`,
        '_links': { ontology: opts.ontologyIri },
        note: 'Unknown term in an owned namespace — see the ontology for declared terms.',
      });
    });
  }
}

/** createVerticalBridge `middleware`-hook form: `middleware: ontologyServingMiddleware({...})`. */
export function ontologyServingMiddleware(opts: OntologyServingOptions): (app: Express) => void {
  return (app: Express) => attachOntologyServing(app, opts);
}
