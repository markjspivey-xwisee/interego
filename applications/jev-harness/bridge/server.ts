/**
 * jev-harness bridge — the vertical's HTTP surface.
 *
 * Generic Interego agents discover it by dereferencing GET /affordances (an iep:Affordance
 * manifest in the same Turtle every vertical bridge serves) and act by following each
 * affordance's hydra:target. Every judgment it produces is dereferenceable at
 * /jev-harness/judgments/<id> as JSON, text/turtle (payload), application/trig (descriptor +
 * payload) or text/markdown (HyperMarkdown with :::control blocks), and the payload carries
 * the next-step controls the judgment affords.
 *
 * Run:
 *   PORT=6090 JEV_HARNESS_REPO=/path/to/repo BRIDGE_DEPLOYMENT_URL=http://localhost:6090 \
 *     npx tsx bridge/server.ts
 *
 * Optional: INTEREGO_BEARER (+ INTEREGO_RELAY_URL) publishes every judgment to the pod through
 * the relay; JEV_HARNESS_OWNER_WEBID / JEV_HARNESS_AGENT_ID fill the descriptor's facets.
 */

import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jevHarnessAffordances } from '../affordances.js';
import { affordancesManifestTurtle } from '../src/affordance-turtle.js';
import { DEFAULT_NS, controlsFor, type Published } from '../src/descriptor.js';
import { jevFromEnv, type JevClient } from '../src/jev-client.js';
import { relayFromEnv, type RelayClient } from '../src/publish.js';
import { Harness, HarnessError } from '../src/service.js';
import { parseShapes, shapeViolationEnvelope, validate, type NodeShape } from '../src/shacl-lite.js';
import type { HarnessStore } from '../src/store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ONTOLOGY_PATH = join(HERE, '..', 'ontology', 'jev-harness.ttl');

export interface AppOptions {
  readonly jev: JevClient;
  readonly repoRoot: string;
  readonly base: string;
  readonly relay?: RelayClient | null;
  readonly store?: HarnessStore;
  readonly ns?: string;
}

export function loadOntology(ns: string): string {
  const text = readFileSync(ONTOLOGY_PATH, 'utf8');
  return ns === DEFAULT_NS ? text : text.split(DEFAULT_NS).join(ns).split(DEFAULT_NS.replace(/#$/, '')).join(ns.replace(/#$/, ''));
}

export function createApp(opts: AppOptions): { app: Express; harness: Harness } {
  const base = opts.base.replace(/\/$/, '');
  const ns = opts.ns ?? process.env['JEV_HARNESS_NS'] ?? DEFAULT_NS;
  const ontology = loadOntology(ns);
  const shapes = parseShapes(ontology);
  const shape = (name: string): NodeShape => {
    const s = shapes.get(`${ns}${name}`);
    if (!s) throw new Error(`ontology is missing shape ${name}`);
    return s;
  };
  const harness = new Harness({
    jev: opts.jev,
    repoRoot: opts.repoRoot,
    base,
    ...(opts.store ? { store: opts.store } : {}),
    relay: opts.relay ?? null,
    // The agent named on every descriptor: set explicitly, else the relay agent's own did:key when
    // the bridge holds a key, else a placeholder IRI for a bridge that publishes nothing.
    context: { base, ns, agentId: process.env['JEV_HARNESS_AGENT_ID'] ?? opts.relay?.agentDid ?? 'urn:agent:interego:jev-harness', ...(process.env['JEV_HARNESS_OWNER_WEBID'] ? { ownerWebId: process.env['JEV_HARNESS_OWNER_WEBID'] } : {}) },
  });

  const app = express();
  app.disable('x-powered-by');
  // HSTS before the body parser: a malformed-body 400 leaves the parser's error path before any
  // later middleware runs, so a header registered after express.json() would be missing from
  // exactly the responses an attacker provokes. max-age only, as the other bridges send it;
  // includeSubDomains and preload are separate decisions with blast radius.
  app.use((_req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });
  app.use(express.json({ limit: '25mb' }));

  const wants = (req: Request, type: string): boolean => (req.headers.accept ?? '').includes(type);

  app.get('/', (_req, res) => {
    res.type('application/ld+json').send(JSON.stringify({
      '@context': { iep: 'https://markjspivey-xwisee.github.io/interego/ns/iep#', hydra: 'http://www.w3.org/ns/hydra/core#', jvh: ns },
      '@id': `${base}/`,
      '@type': ['hydra:Resource'],
      title: 'jev-harness — System One development judgments as affordances',
      description: 'Discover capabilities at the manifest; follow each affordance\'s hydra:target. Every judgment is a dereferenceable descriptor whose payload carries its next-step controls.',
      manifest: `${base}/affordances`,
      ontology: `${base}/ns/jev-harness`,
      health: `${base}/health`,
      affordances: jevHarnessAffordances.map((a) => ({ action: a.action, method: a.method, target: a.targetTemplate.replace('{base}', base), title: a.title })),
    }, null, 2));
  });

  app.get('/health', (_req, res) => {
    const inv = harness.inventory();
    // `build` is the sha the image was built from (INTEREGO_BUILD_SHA, baked by the Dockerfile),
    // which is how a deploy verifies the rollout it just made; `commit` is the tree being judged.
    res.json({
      status: 'ok', vertical: 'jev-harness', build: process.env['INTEREGO_BUILD_SHA'] ?? null, repository: inv.name, commit: inv.commit, files: inv.files.length, model: opts.jev.model, relay: Boolean(opts.relay),
      // What calibration is computed from: outcomes this container recorded, outcomes read back
      // from the pod, and how the last read-back went.
      outcomes: { local: harness.store.localOutcomes().length, pod: harness.store.podOutcomes().length },
      podBackfill: harness.store.podBackfill,
      calibrationPublish: harness.calibrationPublish,
    });
  });

  app.get('/affordances', (req, res) => {
    if (wants(req, 'application/json') && !wants(req, 'text/turtle')) {
      res.json(jevHarnessAffordances.map((a) => ({ ...a, target: a.targetTemplate.replace('{base}', base) })));
      return;
    }
    res.type('text/turtle').send(affordancesManifestTurtle(`${base}/affordances`, jevHarnessAffordances, base, {
      verticalLabel: 'jev-harness affordance manifest',
      rdfsComment: 'Capabilities exposed by the jev-harness vertical bridge: System One judgments about the bound repository. Generic Interego agents discover via this manifest; each judgment they receive carries its own next-step controls.',
    }));
  });

  app.get('/ns/jev-harness', (_req, res) => { res.type('text/turtle').send(ontology); });

  const guarded = (shapeName: string, fn: (body: Record<string, unknown>) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const report = validate(shape(shapeName), req.body);
        if (!report.conforms) { res.status(422).json(shapeViolationEnvelope(report)); return; }
        res.json(await fn(req.body as Record<string, unknown>));
      } catch (err) { next(err); }
    };

  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : typeof v === 'string' ? [v] : []);
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);

  app.post('/jev-harness/navigate', guarded('NavigateInputShape', (b) => harness.navigate({
    task: b['task'] as string,
    ...(str(b['scope']) ? { scope: str(b['scope'])! } : {}),
    ...(typeof b['top_k'] === 'number' ? { topK: b['top_k'] } : {}),
  })));

  app.post('/jev-harness/select-tests', guarded('SelectTestsInputShape', (b) => harness.selectTests({
    changedFiles: strings(b['changed_files']),
    ...(str(b['base_ref']) ? { baseRef: str(b['base_ref'])! } : {}),
    ...(str(b['head_ref']) ? { headRef: str(b['head_ref'])! } : {}),
    ...(str(b['task']) ? { task: str(b['task'])! } : {}),
  })));

  app.post('/jev-harness/triage', guarded('TriageInputShape', (b) => harness.triage({
    log: b['log'] as string,
    ...(strings(b['changed_files']).length > 0 ? { changedFiles: strings(b['changed_files']) } : {}),
  })));

  app.post('/jev-harness/review-gate', guarded('ReviewGateInputShape', (b) => harness.reviewGate({
    ...(str(b['diff']) ? { diff: str(b['diff'])! } : {}),
    ...(str(b['base_ref']) ? { baseRef: str(b['base_ref'])! } : {}),
    ...(str(b['head_ref']) ? { headRef: str(b['head_ref'])! } : {}),
    ...(str(b['title']) ? { title: str(b['title'])! } : {}),
    ...(str(b['description']) ? { description: str(b['description'])! } : {}),
  })));

  app.post('/jev-harness/outcome', guarded('RecordOutcomeInputShape', (b) => {
    let confirmed: Record<string, string> | undefined;
    if (str(b['confirmed_classes'])) {
      try { confirmed = JSON.parse(b['confirmed_classes'] as string) as Record<string, string>; } catch { throw new HarnessError(400, 'confirmed_classes must be a JSON object'); }
    }
    return harness.recordOutcome({
      judgmentIri: b['judgment_iri'] as string,
      ...(strings(b['files_changed']).length > 0 ? { filesChanged: strings(b['files_changed']) } : {}),
      ...(strings(b['tests_run']).length > 0 ? { testsRun: strings(b['tests_run']) } : {}),
      ...(strings(b['tests_failed']).length > 0 ? { testsFailed: strings(b['tests_failed']) } : {}),
      ...(str(b['human_decision']) ? { humanDecision: b['human_decision'] as 'approved' | 'changes-requested' | 'blocked' } : {}),
      ...(confirmed ? { confirmedClasses: confirmed } : {}),
    });
  }));

  // ?refresh=1 reads the pod first, so a caller can see every outcome the delegate has published
  // rather than waiting for the hourly read-back.
  app.get('/jev-harness/calibration', async (req, res, next) => {
    try {
      const backfill = req.query['refresh'] === '1' ? await harness.backfillFromPod() : harness.store.podBackfill;
      res.json({ ...harness.calibration(), podBackfill: backfill });
    } catch (err) { next(err); }
  });

  // The view onto the pod, and the attestation it grounds. Forced unless ?if_changed=1.
  app.post('/jev-harness/calibration/publish', async (req, res, next) => {
    try { res.json(await harness.publishCalibration({ force: req.query['if_changed'] !== '1' })); } catch (err) { next(err); }
  });

  app.get('/jev-harness/judgments', (_req, res) => { res.json(harness.store.index()); });

  app.get('/jev-harness/judgments/:ref', (req, res) => {
    const ref = req.params['ref'] ?? '';
    const m = /^(.+?)(?:\.(trig|ttl|md|json))?$/.exec(ref);
    const id = m?.[1] ?? ref;
    const ext = m?.[2];
    const j: Published | undefined = harness.store.get(id);
    if (!j) { res.status(404).json({ error: 'not_found', id }); return; }
    const format = ext ?? (wants(req, 'application/trig') ? 'trig' : wants(req, 'text/turtle') ? 'ttl' : wants(req, 'text/markdown') ? 'md' : 'json');
    if (format === 'trig') { res.type('application/trig').send(harness.store.artifact(id, 'trig')); return; }
    if (format === 'ttl') { res.type('text/turtle').send(harness.store.artifact(id, 'payload.ttl')); return; }
    if (format === 'md') { res.type('text/markdown').send(harness.store.artifact(id, 'md')); return; }
    // Controls are recomputed from the stored judgment so a dereference always shows the live set.
    res.json({ judgment: j, url: `${base}/jev-harness/judgments/${id}`, controls: controlsFor(j, harness.ctx) });
  });

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof HarnessError ? err.status : 500;
    const message = err instanceof Error ? err.message : String(err);
    if (status >= 500) console.error('[jev-harness]', message);
    res.status(status).json({ error: status >= 500 ? 'internal_error' : 'bad_request', message });
  });

  return { app, harness };
}

export function main(): void {
  const port = Number(process.env['PORT'] ?? 6090);
  const repoRoot = resolve(process.env['JEV_HARNESS_REPO'] ?? process.cwd());
  const base = (process.env['BRIDGE_DEPLOYMENT_URL'] ?? `http://localhost:${port}`).replace(/\/$/, '');
  const relay = relayFromEnv();
  const { app, harness } = createApp({ jev: jevFromEnv(), repoRoot, base, relay });
  app.listen(port, () => {
    console.log(`[jev-harness] bridge on ${base}  repo=${repoRoot}  manifest=${base}/affordances  relay=${relay ? 'configured' : 'off'}`);
    // Calibration from the pod: once at boot, then hourly, so a fresh container starts from
    // everything the delegate has published and picks up outcomes other bridges add.
    const backfill = async (): Promise<void> => {
      const s = await harness.backfillFromPod();
      if (s.status !== 'off') console.log(`[jev-harness] pod calibration: ${s.status}${s.status === 'ok' ? ` (${s.added} new of ${s.total} outcomes; ${s.errors?.length ?? 0} unreadable)` : s.error ? ` ${s.error}` : ''}`);
    };
    void backfill();
    setInterval(() => { void backfill(); }, 60 * 60 * 1000).unref();
  });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
