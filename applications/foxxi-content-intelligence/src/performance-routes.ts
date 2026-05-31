/**
 * Bridge routes for the Foxxi Performance & Knowledge Architecture.
 *
 * Exposes the diagnosis → intervention spine (performance-architecture.ts),
 * the emergent-content authoring tools (emergent-content.ts) and the
 * knowledge map (knowledge-architecture.ts) as HTTP endpoints. The
 * endpoints ARE the authoring tools: a human instructional designer
 * reaches them through the dashboard, an agent reaches them as a tool
 * call — the same affordances, which is what makes H2H / H2A / A2H / A2A
 * authoring symmetric.
 *
 *   GET  /performance                  self-describing HATEOAS index
 *   POST /performance/plan             diagnose a gap → an InterventionPlan
 *   POST /content/compose-course       author an emergent course
 *   POST /content/personalize          personalise a course for a performer
 *   GET  /knowledge                    self-describing knowledge index
 *   POST /knowledge/map                map a competency's knowledge
 *
 * Layer: L3 vertical. Thin HTTP adapter over the pure modules.
 */

import type { Express, Request, Response } from 'express';
import type { WorkRegime } from './agent-disposition.js';
import {
  diagnose, recommendInterventions, rollUpPortfolio,
  type PerformanceSituation, type Performer, type DiagnoseInput, type PortfolioEntry,
} from './performance-architecture.js';
import {
  buildCalibrationProfile, expandOutcomeCorpus, composeCalibrationProfiles,
  calibrate, calibrationReadout, federationView,
  type OutcomeRecord, type CauseKey,
} from './performance-calibration.js';
import { SAMPLE_OUTCOMES, SAMPLE_PEER_OUTCOMES } from './sample-outcomes.js';
import {
  frameTeachingIntervention, verifyCapabilityTransfer,
  transferAttestation, teachingToOutcome,
  type TeachingPackageRef, type BehaviourSignature, type OlkeStage,
} from './agent-teaching.js';
import type { AgentTrajectory } from './agent-trajectory.js';
import {
  authorFragment, authorLesson, authorModule, composeCourse,
  personalize, forAudience, courseToCmi5Outline, scaffoldFromPlan,
  type Course, type Module, type Lesson, type GroundingFragment,
  type FragmentModality, type CognitiveLevel,
} from './emergent-content.js';
import {
  mapKnowledge, type KnowledgeComponent, type ComponentInput,
} from './knowledge-architecture.js';
import {
  publishOutcomeDescriptor, publishSituationDescriptor, publishTeachingPackageDescriptor,
  publishTeachingAttestationDescriptor, publishCalibrationSnapshotDescriptor,
  publishParticipationClaimDescriptor, verifySignature, FOXXI_TYPES,
  type DescriptorPublishConfig, type PublishedDescriptor,
} from './outcome-descriptor-publisher.js';
import { FederationOutcomeLoader, parseFederationPods } from './federation-outcome-loader.js';
import { bridgeAuthor, signAsBridge, withPublishLock } from './bridge-signer.js';
import type { IRI } from '@interego/core';

// ── JSON-LD context bound at the top of every linked-data response. ───
// Resolves the prefixes used in @type / facets / affordances so a
// consumer doesn't have to memorise our IRIs. The Foxxi vertical's vocab
// is dereferenceable at /ns/foxxi.
const JSONLD_CONTEXT = {
  cg: 'https://markjspivey-xwisee.github.io/interego/ns/cg/v1#',
  pgsl: 'https://markjspivey-xwisee.github.io/interego/ns/pgsl/v1#',
  ac: 'https://markjspivey-xwisee.github.io/interego/ns/ac/v1#',
  amta: 'https://markjspivey-xwisee.github.io/interego/ns/amta/v1#',
  prov: 'http://www.w3.org/ns/prov#',
  dct: 'http://purl.org/dc/terms/',
  hydra: 'http://www.w3.org/ns/hydra/core#',
  foxxi: 'https://interego-foxxi-bridge.livelysky-8b81abb0.eastus.azurecontainerapps.io/ns/foxxi#',
};

/**
 * Wrap a domain payload in the canonical JSON-LD envelope. Every endpoint
 * that produces (or operates on) a real cg:ContextDescriptor returns this
 * shape so the response itself is consumable as linked data — not just
 * the descriptors it points at. The `_affordances` block is HATEOAS
 * (typed hydra:Operation links) so a caller can navigate the substrate
 * by following links instead of memorising paths.
 */
function jsonLdEnvelope(args: {
  baseUrl: string;
  id: string;
  types: string[];
  body: Record<string, unknown>;
  published?: PublishedDescriptor[];
  affordances?: Record<string, { method: string; href: string; note?: string; expects?: string; returns?: string }>;
}) {
  return {
    '@context': JSONLD_CONTEXT,
    '@id': args.id,
    '@type': args.types,
    ...args.body,
    ...(args.published && args.published.length > 0 ? {
      published: args.published.map(p => ({
        '@id': p.descriptorIri,
        '@type': ['cg:ContextDescriptor', p.foxxiType],
        'cg:describes': p.graphIri,
        'pgsl:hasAtom': p.payloadAtom,
        'hydra:resourceUrl': p.descriptorUrl,
        'foxxi:graphUrl': p.graphUrl,
      })),
    } : {}),
    ...(args.affordances ? {
      _affordances: Object.fromEntries(
        Object.entries(args.affordances).map(([k, v]) => [k, {
          '@type': 'hydra:Operation',
          'hydra:method': v.method,
          'hydra:target': v.href,
          ...(v.note ? { 'foxxi:note': v.note } : {}),
          ...(v.expects ? { 'hydra:expects': v.expects } : {}),
          ...(v.returns ? { 'hydra:returns': v.returns } : {}),
        }])
      ),
    } : {}),
  };
}

/** Publish silently — if the pod write fails, log it but keep the response. */
async function tryPublish<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
  try { return await fn(); }
  catch (err) {
    console.error(`[foxxi-bridge] descriptor publish failed (${label}):`, (err as Error).message);
    return null;
  }
}

/**
 * Bounded-await publish: return the result if it lands within `ms` ms,
 * otherwise return null AND let the publish keep running in the
 * background. The API call doesn't block on a slow pod (Azure ingress
 * → CSS) — the upward-causation record is already in liveOutcomes, and
 * the descriptor will catch up to the pod on its own schedule. When
 * publish finishes after the timeout, its success / failure is logged
 * via tryPublish() so operators can still see it.
 */
async function tryPublishBounded<T>(label: string, fn: () => Promise<T>, ms: number): Promise<T | null> {
  const inFlight = tryPublish(label, fn);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      console.warn(`[foxxi-bridge] publish (${label}) did not land in ${ms}ms; continuing in background`);
      resolve(null);
    }, ms);
  });
  try {
    const result = await Promise.race([inFlight, timeout]);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    // Detach: in-flight publish keeps running after timeout. Swallow its
    // promise so Node doesn't log an unhandled rejection if it later
    // throws something tryPublish missed.
    void inFlight.catch(() => {});
  }
}

function bad(res: Response, msg: string): void {
  res.status(400).json({ error: msg });
}

function asPerformer(v: unknown, fallback?: Performer): Performer | undefined {
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string' && (o.kind === 'human' || o.kind === 'agent')) {
      return { id: o.id, kind: o.kind, ...(typeof o.role === 'string' ? { role: o.role } : {}) };
    }
  }
  return fallback;
}

/** Coerce a request `situation` object into a PerformanceSituation, or an error string. */
function coerceSituation(v: unknown): PerformanceSituation | string {
  if (!v || typeof v !== 'object') return 'a "situation" object is required';
  const g = v as Record<string, unknown>;
  const performer = asPerformer(g.performer);
  if (!performer) return 'situation.performer must be { id, kind: "human"|"agent" }';
  for (const f of ['workContext', 'competency', 'observed']) {
    if (typeof g[f] !== 'string' || !g[f]) return `situation.${f} (string) is required`;
  }
  return {
    id: typeof g.id === 'string' ? g.id : `urn:foxxi:situation:${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    performer,
    workContext: g.workContext as string,
    competency: g.competency as string,
    observed: g.observed as string,
    frequency: (['continuous', 'frequent', 'occasional', 'rare'].includes(g.frequency as string) ? g.frequency : 'frequent') as PerformanceSituation['frequency'],
    criticality: (['low', 'moderate', 'high', 'safety-critical'].includes(g.criticality as string) ? g.criticality : 'moderate') as PerformanceSituation['criticality'],
    modalStatus: g.modalStatus === 'Asserted' ? 'Asserted' : 'Hypothetical',
    provenance: typeof g.provenance === 'string' ? g.provenance : 'caller-supplied',
    ...(['Evident', 'Knowable', 'Emergent', 'Turbulent'].includes(g.domain as string) ? { domain: g.domain as PerformanceSituation['domain'] } : {}),
  };
}

/**
 * Build a DiagnoseInput from a situation + the request fields carrying
 * the regime-method evidence. `exemplary` (what good looks like) is only
 * used by the Knowable regime's gap analysis.
 */
function coerceDiagnoseInput(situation: PerformanceSituation, src: Record<string, unknown>): DiagnoseInput {
  return {
    situation,
    ...(typeof src.exemplary === 'string' && src.exemplary ? { exemplary: src.exemplary } : {}),
    ...(typeof src.couldPerformUnderIdealConditions === 'boolean' ? { couldPerformUnderIdealConditions: src.couldPerformUnderIdealConditions } : {}),
    ...(typeof src.performedWellBefore === 'boolean' ? { performedWellBefore: src.performedWellBefore } : {}),
    ...(src.factorEvidence && typeof src.factorEvidence === 'object' ? { factorEvidence: src.factorEvidence as DiagnoseInput['factorEvidence'] } : {}),
  };
}

/** Attach the performance-architecture + emergent-content routes. */
export function attachPerformanceRoutes(app: Express, config: {
  selfBaseUrl: string;
  /** Where to mint cg:ContextDescriptor records for outcomes / situations / teaching packages. */
  publishConfig?: DescriptorPublishConfig;
}): void {
  const base = config.selfBaseUrl.replace(/\/+$/, '');
  const podConfigured = !!config.publishConfig?.podUrl;
  const publishConfig = config.publishConfig;

  // Track per-cell modal status so we can publish a foxxi:CalibrationProfile
  // descriptor each time a cell crosses Hypothetical → Asserted. The flip
  // is the precise marker of emergence; capturing it as a versioned
  // descriptor gives the substrate a permanent record of when the
  // collective's evidence became claimable knowledge.
  const lastSeenCellStatus = new Map<string, string>();
  const cellKey = (cause: string, intervention: string): string => `${cause}::${intervention}`;
  let lastCalibrationDescriptorIri: string | null = null;
  async function maybePublishCalibrationFlipDescriptor(): Promise<void> {
    if (!podConfigured || !publishConfig) return;
    const profile = calibrationProfiles().tenant;
    const flips: Array<{ cause: string; intervention: string; samples: number; closureRate: number }> = [];
    for (const cell of profile.cells) {
      const key = cellKey(String(cell.causeFactor), String(cell.intervention));
      const prev = lastSeenCellStatus.get(key);
      const curr = String(cell.modalStatus);
      lastSeenCellStatus.set(key, curr);
      if (prev && prev !== 'Asserted' && curr === 'Asserted') {
        flips.push({ cause: String(cell.causeFactor), intervention: String(cell.intervention),
          samples: Number(cell.samples), closureRate: Number(cell.closureRate) });
      }
    }
    if (flips.length === 0) return;
    const snapshot = {
      flips, totalSamples: profile.totalSamples,
      profile: { cells: profile.cells.map(c => ({ causeFactor: c.causeFactor, intervention: c.intervention,
        samples: c.samples, closureRate: c.closureRate, modalStatus: c.modalStatus })) },
      supersedes: lastCalibrationDescriptorIri,
      flippedAt: new Date().toISOString(),
    };
    // Bridge-originated descriptor: sign as the bridge service so the
    // calibration snapshot lands with cg:CryptographicallyVerified trust
    // (not SelfAsserted). Readers that filter on trust level still accept
    // it; anonymous junk that gets PUT directly to CSS does not.
    const author = bridgeAuthor();
    const signedPayloadJson = JSON.stringify(snapshot);
    const signature = await signAsBridge(snapshot).catch(() => undefined);
    const result = await withPublishLock(() => publishCalibrationSnapshotDescriptor(
      snapshot, author, signature, publishConfig, signedPayloadJson,
    )).catch(err => {
      console.error('[foxxi-bridge] calibration descriptor publish failed:', (err as Error).message);
      return null;
    });
    if (result) lastCalibrationDescriptorIri = result.descriptorIri;
  }

  // The calibration profile — the system's track record of its own
  // Knowable-regime recommendations, and a live upward↔downward causal
  // loop. The UPWARD arm: completed loops record outcomes into
  // `liveOutcomes`, and the profile is recomposed from the seeded
  // historical baseline + those live outcomes on every read — parts
  // (outcomes) causing the whole (the profile). The DOWNWARD arm:
  // `calibrate()` lets the profile press back on the next plan. The
  // federated profile composes a peer organization's evidence
  // (federationView withholds sub-k cells before they cross a boundary).
  const seedRecords = expandOutcomeCorpus(SAMPLE_OUTCOMES);
  // Prime lastSeenCellStatus with the seeded-corpus baseline so we don't
  // emit a "flip" descriptor for cells that arrived already Asserted from
  // the historical seed. Only genuine post-startup transitions publish.
  {
    const baselineProfile = buildCalibrationProfile(seedRecords);
    for (const c of baselineProfile.cells) {
      lastSeenCellStatus.set(cellKey(String(c.causeFactor), String(c.intervention)), String(c.modalStatus));
    }
  }
  // Federation: load peer outcomes from real pods via discover(),
  // not from the in-memory SAMPLE_PEER_OUTCOMES corpus. The loader
  // caches per pod with a TTL so the calibration recompute path
  // stays synchronous. SAMPLE_PEER_OUTCOMES is the fallback seed for
  // dev / first-run when no federation pods are configured or
  // available — once peers come online, the loader takes over.
  const federationPods = parseFederationPods(process.env.FOXXI_FEDERATION_PODS);
  const federationLoader = new FederationOutcomeLoader({ ttlMs: 60_000 });
  let cachedPeerProfile = buildCalibrationProfile(expandOutcomeCorpus(SAMPLE_PEER_OUTCOMES));
  let lastFederationRefreshAt = 0;
  let federationOutcomeCount = 0;
  async function refreshFederationPeerProfile(): Promise<void> {
    if (federationPods.length === 0) return; // keep seed fallback
    try {
      const outcomes = await federationLoader.loadAll(federationPods);
      if (outcomes.length > 0) {
        cachedPeerProfile = buildCalibrationProfile(outcomes);
        lastFederationRefreshAt = Date.now();
        federationOutcomeCount = outcomes.length;
      }
    } catch (err) {
      console.error('[foxxi-bridge] federation refresh failed:', (err as Error).message);
    }
  }
  // Kick the initial load (best-effort) + schedule a periodic refresh.
  void refreshFederationPeerProfile();
  setInterval(() => { void refreshFederationPeerProfile(); }, 60_000).unref?.();

  const liveOutcomes: OutcomeRecord[] = [];
  const calibrationProfiles = () => {
    const tenant = buildCalibrationProfile([...seedRecords, ...liveOutcomes]);
    const federated = composeCalibrationProfiles([tenant, federationView(cachedPeerProfile)]);
    return { tenant, federated };
  };
  // Expose federation status for the calibration endpoint to surface.
  const federationStatus = () => ({
    pods: federationPods,
    lastRefreshAt: lastFederationRefreshAt === 0 ? null : new Date(lastFederationRefreshAt).toISOString(),
    peerOutcomeCount: federationOutcomeCount,
    usingSeedFallback: federationPods.length === 0 || lastFederationRefreshAt === 0,
  });

  // Validate + record a live outcome — the reflexive loop's upward arm.
  const CAUSE_KEYS: CauseKey[] = ['information', 'instrumentation', 'incentives', 'knowledgeSkill', 'capacity', 'motives', 'not-applicable'];
  function recordLiveOutcome(v: unknown): OutcomeRecord | string {
    if (!v || typeof v !== 'object') return 'an outcome object is required';
    const o = v as Record<string, unknown>;
    if (!['Evident', 'Knowable', 'Emergent', 'Turbulent'].includes(o.regime as string)) return 'outcome.regime is invalid';
    if (!CAUSE_KEYS.includes(o.causeFactor as CauseKey)) return 'outcome.causeFactor is invalid';
    if (typeof o.intervention !== 'string') return 'outcome.intervention (string) is required';
    if (!['closed', 'improved', 'no-change', 'worsened'].includes(o.verdict as string)) return 'outcome.verdict is invalid';
    return {
      regime: o.regime as OutcomeRecord['regime'],
      method: ['apply-practice', 'gap-analysis', 'dispositional-read', 'stabilise-first'].includes(o.method as string)
        ? o.method as OutcomeRecord['method'] : 'gap-analysis',
      causeFactor: o.causeFactor as CauseKey,
      intervention: o.intervention as OutcomeRecord['intervention'],
      verdict: o.verdict as OutcomeRecord['verdict'],
      ...(CAUSE_KEYS.includes(o.reDiagnosedCause as CauseKey) ? { reDiagnosedCause: o.reDiagnosedCause as CauseKey } : {}),
      source: typeof o.source === 'string' ? o.source : 'live',
    };
  }

  // ── Self-describing index — dereferenceable, HATEOAS. ─────────────
  app.get('/performance', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      system: 'Foxxi Performance Architecture',
      principle: 'Performance is the unit, not content. The universal first step is to contextualize a performance situation — read its work regime — then route to that regime\'s method. Idealising an exemplary state and closing a gap to it is the method of one regime (Knowable), not a universal frame: Evident applies an established practice, Emergent runs dispositional probes, Turbulent stabilises first.',
      directionalities: ['H2H', 'H2A', 'A2H', 'A2A'],
      interventionParadigm: [
        'instruction', 'performance-support', 'reference', 'practice',
        'assessment', 'coaching', 'probe', 'environmental-fix', 'no-intervention',
      ],
      _affordances: {
        contextualizeAndPlan: { method: 'POST', href: `${base}/performance/plan`, note: 'Contextualize a performance situation — read its regime, apply that regime\'s method — and return the full intervention paradigm, selected and ruled-out with reasoning.' },
        portfolio: { method: 'POST', href: `${base}/performance/portfolio`, note: 'Contextualize a set of performance situations and roll them up — the performance-management read. The headline: how few situations route to a course.' },
        calibration: { method: 'POST', href: `${base}/performance/calibration`, note: 'The reflexive loop — the system\'s recorded track record of its own recommendations, recomposed live from seeded + recorded outcomes, federated across organizations.' },
        recordOutcome: { method: 'POST', href: `${base}/performance/outcome`, note: 'The reflexive loop\'s upward arm — a completed performance loop records its outcome; the calibration profile recomposes to include it, and so shapes the next recommendation.' },
        teachAgent: { method: 'POST', href: `${base}/agent/teach`, note: 'The performance lens over an agent-collective ac:TeachingPackage — frames a learner agent\'s acquisition as an A2A instruction intervention, verifies the transfer from the learner\'s trajectories, and emits an amta:Attestation. Foxxi composes the teaching foundation; it does not reinvent it.' },
        composeCourse: { method: 'POST', href: `${base}/content/compose-course`, note: 'Author an emergent course — a syntagm of modules → lessons → grounding fragments. The same tool for human and agent authors.' },
        personalizeCourse: { method: 'POST', href: `${base}/content/personalize`, note: 'Resolve a course for one performer via the composition algebra (restriction + override).' },
        knowledgeIndex: { method: 'GET', href: `${base}/knowledge`, note: 'The knowledge architecture — how much of a competency can honestly become content.' },
      },
      vocabulary: `${base}/ns/foxxi`,
      demo: 'tools/performance-architecture-example.mjs',
    });
  });

  // ── POST /performance/plan — contextualize → intervention spine. ──
  // Real linked-data shape: the situation becomes a published
  // cg:ContextDescriptor on the tenant pod (conformsTo foxxi:Situation),
  // the response is JSON-LD with the descriptor IRIs and HATEOAS
  // affordances pointing at the next operations (record outcome, fetch
  // descriptor, read the calibration profile).
  app.post('/performance/plan', async (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const situation = coerceSituation(body.situation);
    if (typeof situation === 'string') { bad(res, situation); return; }
    const diagnosis = diagnose(coerceDiagnoseInput(situation, body));
    const author = asPerformer(body.author, { id: 'urn:foxxi:agent:performance-consultant', kind: 'agent', role: 'performance consultant' })!;
    const plan = recommendInterventions({ diagnosis, situation, author });
    const scaffold = scaffoldFromPlan(plan, situation.competency);
    // Every plan carries its own track record (downward causation): how
    // often this kind of recommendation has actually closed the gap, and
    // whether a sibling intervention out-performs it. Federated, live.
    const calibration = calibrate(diagnosis, plan, calibrationProfiles().federated);

    // Publish the situation as a real cg:ContextDescriptor on the pod.
    // The descriptor lives at a dereferenceable URL; the graph it
    // describes carries the situation payload + a pgsl:hasAtom link to
    // the content-addressed atom holding the raw JSON.
    const published: PublishedDescriptor[] = [];
    if (podConfigured && publishConfig) {
      const situationDesc = await tryPublishBounded('situation', () =>
        withPublishLock(() => publishSituationDescriptor(
          { situation, diagnosis, plan: { paradigm: plan.paradigm, selected: plan.selected.map(o => o.type), summary: plan.summary } },
          author,
          publishConfig,
        )), 4000);
      if (situationDesc) published.push(situationDesc);
    }

    const responseBody = jsonLdEnvelope({
      baseUrl: base,
      id: `urn:foxxi:plan-response:${situation.id}`,
      types: ['foxxi:PerformancePlanResponse'],
      body: { diagnosis, plan, scaffold, calibration },
      published,
      affordances: {
        recordOutcome: { method: 'POST', href: `${base}/performance/outcome`,
          note: 'Record the outcome of applying this plan in the field — closes the upward arm of the reflexive loop.',
          expects: 'foxxi:OutcomeInput', returns: 'foxxi:Outcome' },
        readCalibration: { method: 'POST', href: `${base}/performance/calibration`,
          note: 'Read the live calibration profile (tenant + federated) — see how often recommendations of this kind actually close the gap.',
          returns: 'foxxi:CalibrationProfile' },
        ...(published[0] ? {
          fetchSituationDescriptor: { method: 'GET', href: published[0].descriptorUrl,
            note: 'Dereference the cg:ContextDescriptor for the filed situation (Turtle).',
            returns: 'cg:ContextDescriptor' },
          fetchSituationGraph: { method: 'GET', href: published[0].graphUrl,
            note: 'Dereference the situation graph (TriG).',
            returns: 'cg:NamedGraph' },
        } : {}),
      },
    });
    res.setHeader('Content-Type', 'application/ld+json');
    res.json(responseBody);
  });

  // ── POST /performance/calibration — the reflexive loop. ───────────
  // The system's track record of its own Knowable-regime cause →
  // intervention recommendations: for each cell, how often that
  // recommendation actually closed the gap, and — when it did not — what
  // the cause turned out to be. The federated profile composes a peer
  // organization's published evidence; one org's lesson calibrates the
  // next.
  app.post('/performance/calibration', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const { tenant, federated } = calibrationProfiles();
    res.json({
      tenant: { profile: tenant, readout: calibrationReadout(tenant) },
      federated: { profile: federated, readout: calibrationReadout(federated) },
      provenance: {
        seededOutcomes: seedRecords.length,
        liveOutcomes: liveOutcomes.length,
        federation: federationStatus(),
        note: 'The profile is recomposed on every read from the seeded historical baseline plus the '
          + 'outcomes this deployment\'s own completed loops have recorded — the upward arm of the loop.',
      },
      note: 'The Performance Architecture turned on itself, as a live upward↔downward causal loop. '
        + 'Upward: completed loops record outcomes (POST /performance/outcome) and the profile '
        + 'recomposes to include them. Downward: a fresh plan is annotated with that track record, and '
        + 'with any sibling intervention the evidence favours. The federated profile composes a peer '
        + 'organization\'s evidence — only cells above a k-anonymity threshold cross the boundary. A '
        + 'cell is Hypothetical until it has the samples to Assert a rate.',
    });
  });

  // ── POST /performance/outcome — the reflexive loop's upward arm. ───
  // A completed performance loop records its outcome here.
  //
  // SIGNATURE REQUIRED (Option D — signature-verified writes):
  //   body must include { signedPayload: <stringified outcome JSON>,
  //                       signature: <ECDSA sig over `sha256:<hash>`>,
  //                       author: { id: <did:key:0x…>, kind } }.
  //   The bridge verifies the signature recovers to the author's DID
  //   before recording. Unsigned / unverifiable writes return 401.
  //   The substrate-level rationale: CSS stays allow-all (zero-trust
  //   storage); anonymous PUTs can still land on the pod but the bridge
  //   API rejects them, AND all readers (federation loader, calibration
  //   recompose) filter on cg:CryptographicallyVerified — so anonymous
  //   junk is inert at every consumer surface even when it bypasses the
  //   API.
  app.post('/performance/outcome', async (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const author = asPerformer(body.author);
    const signature = typeof body.signature === 'string' ? body.signature : undefined;
    const signedPayload = typeof body.signedPayload === 'string' ? body.signedPayload : undefined;
    if (!author?.id || !signature || !signedPayload) {
      res.status(401).json({
        error: 'signature required',
        detail: 'POST /performance/outcome requires { author: { id: did:key:0x…, kind }, signature: <ecdsa>, signedPayload: <canonical outcome JSON string> }. The bridge verifies the ECDSA signature against author.id before recording.',
      });
      return;
    }
    const verdict = verifySignature({ signature, agentDid: author.id, payloadJson: signedPayload });
    if (!verdict.verified) {
      res.status(401).json({
        error: 'signature does not verify',
        detail: `recovered address ${verdict.recoveredAddress ?? '<none>'} did not match author.id ${author.id}.`,
      });
      return;
    }
    // signedPayload is the EXACT bytes the agent signed; parse + validate it.
    let parsedPayload: unknown;
    try { parsedPayload = JSON.parse(signedPayload); }
    catch { bad(res, 'signedPayload must be valid JSON'); return; }
    const outcome = recordLiveOutcome(parsedPayload);
    if (typeof outcome === 'string') { bad(res, outcome); return; }
    liveOutcomes.push(outcome);

    const evidence = typeof (parsedPayload as Record<string, unknown>)?.evidence === 'string'
      ? (parsedPayload as Record<string, unknown>).evidence as string : undefined;
    const published: PublishedDescriptor[] = [];
    if (podConfigured && publishConfig) {
      // Pass the EXACT signed bytes through to the publisher so the
      // descriptor's atom + foxxi:bundleJson are byte-identical with
      // what the agent signed — federation peers re-verifying the
      // signature key off the same bytes. Bounded wait: don't block the
      // API call on a slow pod write; if the publish doesn't land in
      // 4s, it keeps running in the background and the response just
      // omits the descriptor URL. The upward-causation record is
      // already in liveOutcomes — the substrate has it either way.
      const outcomeDesc = await tryPublishBounded('outcome', () =>
        withPublishLock(() => publishOutcomeDescriptor(
          { ...outcome, ...(evidence ? { evidence } : {}) },
          author,
          signature,
          publishConfig,
          signedPayload,
        )), 4000);
      if (outcomeDesc) published.push(outcomeDesc);
      // Calibration-flip descriptor is fire-and-forget — we never let
      // the bridge response wait on it. It's a derived view; missing it
      // here just means the next outcome's flip detection picks up the
      // same cells.
      void maybePublishCalibrationFlipDescriptor();
    }

    const responseBody = jsonLdEnvelope({
      baseUrl: base,
      id: `urn:foxxi:outcome-response:${Date.now().toString(36)}`,
      types: ['foxxi:OutcomeResponse'],
      body: {
        recorded: true,
        outcome,
        liveOutcomes: liveOutcomes.length,
        totalSamples: calibrationProfiles().tenant.totalSamples,
      },
      published,
      affordances: {
        readCalibration: { method: 'POST', href: `${base}/performance/calibration`,
          note: 'Read the calibration profile — the part you just contributed is now in the whole.',
          returns: 'foxxi:CalibrationProfile' },
        supersedeOutcome: { method: 'POST', href: `${base}/performance/outcome`,
          note: 'If field evidence revises the verdict, record a follow-up outcome that supersedes this one (cg:supersedes link in the next descriptor).',
          expects: 'foxxi:OutcomeInput' },
        ...(published[0] ? {
          fetchOutcomeDescriptor: { method: 'GET', href: published[0].descriptorUrl,
            note: 'Dereference the cg:ContextDescriptor for this outcome (Turtle).',
            returns: 'cg:ContextDescriptor' },
          fetchOutcomeGraph: { method: 'GET', href: published[0].graphUrl,
            note: 'Dereference the outcome graph (TriG) — contains the foxxi:bundleJson + pgsl:hasAtom link.',
            returns: 'cg:NamedGraph' },
          fetchPayloadAtom: { method: 'GET', href: `${base}/pgsl/atom/${encodeURIComponent(published[0].payloadAtom)}`,
            note: 'Resolve the content-addressed PGSL atom for the outcome payload (same content → same URI globally).',
            returns: 'pgsl:Atom' },
        } : {}),
      },
    });
    res.setHeader('Content-Type', 'application/ld+json');
    res.json(responseBody);
  });

  // ── POST /performance/portfolio — the performance-management read. ─
  // Contextualize a set of performance situations and roll them up. The
  // headline number is how few route to a course: a performance-driven
  // practice sends most situations to non-content interventions
  // (environmental fixes, coaching, probes).
  app.post('/performance/portfolio', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const items = Array.isArray(body.situations) ? body.situations as Array<Record<string, unknown>> : [];
    if (items.length === 0) {
      bad(res, 'situations[] is required — each { situation, exemplary?, factorEvidence?, couldPerformUnderIdealConditions?, performedWellBefore? }');
      return;
    }
    const author = asPerformer(body.author, { id: 'urn:foxxi:agent:performance-consultant', kind: 'agent', role: 'performance consultant' })!;
    const entries: PortfolioEntry[] = [];
    for (const item of items) {
      const situation = coerceSituation(item.situation);
      if (typeof situation === 'string') { bad(res, situation); return; }
      const diagnosis = diagnose(coerceDiagnoseInput(situation, item));
      const plan = recommendInterventions({ diagnosis, situation, author });
      entries.push({ situation, plan });
    }
    const portfolio = rollUpPortfolio(entries);
    res.json({
      portfolio,
      entries: entries.map(e => ({
        situationId: e.situation.id,
        workContext: e.situation.workContext,
        regime: e.plan.diagnosis.domain,
        method: e.plan.diagnosis.method,
        rootCause: e.plan.diagnosis.rootCauses[0] ?? null,
        interventions: e.plan.selected.map(o => o.type),
        contentWarranted: e.plan.contentWarranted,
        summary: e.plan.summary,
      })),
      note: 'A contextualized performance portfolio. contentVsNonContent is the headline: a performance-driven practice routes most situations to non-content interventions — no course fixes a broken tool or a misaligned incentive.',
    });
  });

  // ── POST /agent/teach — the performance lens over ac:TeachingPackage.
  // Foxxi does not author the teaching package — agent-collective's
  // bundleTeachingPackage does (an ac:AgentTool artifact + adp:
  // practice). Given a reference to that package, this route adds the
  // performance dimension: it frames the learner agent's acquisition as
  // an A2A instruction intervention, verifies the transfer by reading
  // the learner's own trajectories, emits an amta:Attestation into the
  // discipline ac: already uses, and feeds the reflexive calibration loop.
  // ── POST /agent/attest — publish a registry-style ParticipationClaim ─
  // Each agent in the autonomous demo (and future production callers)
  // POSTs its signed participation claim here at the start of a run.
  // The bridge verifies the ECDSA signature and publishes a real
  // foxxi:ParticipationClaim descriptor on the pod — agent identities
  // accrue durable history across runs instead of being ephemeral.
  app.post('/agent/attest', async (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof b.name === 'string' ? b.name : null;
    const did = typeof b.did === 'string' ? b.did : null;
    const address = typeof b.address === 'string' ? b.address : null;
    const claim = typeof b.claim === 'string' ? b.claim : null;
    const signature = typeof b.signature === 'string' ? b.signature : null;
    if (!name || !did || !address || !claim || !signature) {
      bad(res, 'name, did, address, claim, signature are all required'); return;
    }
    const published: PublishedDescriptor[] = [];
    if (podConfigured && publishConfig) {
      const result = await tryPublishBounded('participation-claim', () =>
        withPublishLock(() => publishParticipationClaimDescriptor(
          { name, did, address, claim, signature,
            agentRoleHint: typeof b.agentRoleHint === 'string' ? b.agentRoleHint : undefined },
          publishConfig,
        )), 4000);
      if (result) {
        published.push(result);
        res.setHeader('Content-Type', 'application/ld+json');
        res.json(jsonLdEnvelope({
          baseUrl: base,
          id: `urn:foxxi:attestation-response:${Date.now().toString(36)}`,
          types: ['foxxi:ParticipationAttestationResponse'],
          body: { name, did, address, trust: result.trust },
          published,
          affordances: {
            fetchAttestation: { method: 'GET', href: result.descriptorUrl,
              note: 'Dereference the foxxi:ParticipationClaim descriptor (Turtle).',
              returns: 'foxxi:ParticipationClaim' },
          },
        }));
        return;
      }
    }
    res.status(503).json({ error: 'pod publishing is not configured on this bridge — set FOXXI_TENANT_POD_URL' });
  });

  app.post('/agent/teach', async (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const teacher = asPerformer(b.teacher);
    const learner = asPerformer(b.learner);
    if (!teacher || teacher.kind !== 'agent') { bad(res, 'teacher must be an agent — { id, kind: "agent" }'); return; }
    if (!learner || learner.kind !== 'agent') { bad(res, 'learner must be an agent — { id, kind: "agent" }'); return; }

    // Signature gate (Option D): the TEACHER must sign the teaching
    // package + targetBehaviour they're transmitting. Without a verified
    // ECDSA signature recovering to teacher.id, the teaching transfer
    // doesn't count — the calibration profile (outcome.source 'teaching')
    // would otherwise be poisonable by anyone POSTing to /agent/teach.
    const teacherSignature = typeof b.signature === 'string' ? b.signature : undefined;
    const signedPayload = typeof b.signedPayload === 'string' ? b.signedPayload : undefined;
    if (!teacherSignature || !signedPayload) {
      res.status(401).json({
        error: 'signature required',
        detail: 'POST /agent/teach requires { signature: <ecdsa>, signedPayload: <canonical { teachingPackage, targetBehaviour } JSON string> } signed by teacher.id. The transfer attests to a behaviour transmission; an unsigned attestation has no weight.',
      });
      return;
    }
    const teachVerdict = verifySignature({
      signature: teacherSignature, agentDid: teacher.id, payloadJson: signedPayload,
    });
    if (!teachVerdict.verified) {
      res.status(401).json({
        error: 'signature does not verify',
        detail: `recovered address ${teachVerdict.recoveredAddress ?? '<none>'} did not match teacher.id ${teacher.id}.`,
      });
      return;
    }
    const tp = b.teachingPackage as Record<string, unknown> | undefined;
    if (!tp || typeof tp.iri !== 'string' || typeof tp.competency !== 'string') {
      bad(res, 'a "teachingPackage" reference { iri, artifactIri, competency, olkeStage } is required '
        + '— authored by agent-collective\'s ac:bundleTeachingPackage'); return;
    }
    const tb = b.targetBehaviour as Record<string, unknown> | undefined;
    if (!tb || typeof tb.description !== 'string' || !Array.isArray(tb.signalMarkers)) {
      bad(res, 'targetBehaviour { description, signalMarkers[], antiSignalMarkers? } is required'); return;
    }
    const before = (Array.isArray(b.before) ? b.before : []) as AgentTrajectory[];
    const after = (Array.isArray(b.after) ? b.after : []) as AgentTrajectory[];
    const olke: OlkeStage = ['Tacit', 'Articulate', 'Collective', 'Institutional'].includes(tp.olkeStage as string)
      ? tp.olkeStage as OlkeStage : 'Articulate';
    const pkg: TeachingPackageRef = {
      iri: tp.iri,
      artifactIri: typeof tp.artifactIri === 'string' ? tp.artifactIri : tp.iri,
      competency: tp.competency,
      olkeStage: olke,
      modalStatus: tp.modalStatus === 'Asserted' ? 'Asserted' : 'Hypothetical',
    };
    const targetBehaviour: BehaviourSignature = {
      description: tb.description,
      signalMarkers: tb.signalMarkers as string[],
      ...(Array.isArray(tb.antiSignalMarkers) ? { antiSignalMarkers: tb.antiSignalMarkers as string[] } : {}),
    };
    try {
      const intervention = frameTeachingIntervention(pkg, teacher, learner);
      const verdict = verifyCapabilityTransfer({ package: pkg, targetBehaviour, learner, before, after });
      const attestation = transferAttestation(verdict);
      const outcome = teachingToOutcome(verdict);
      // Cross-vertical upward causation: an A2A teaching outcome (which
      // itself composes agent-collective's ac:TeachingPackage) flows up
      // into the same calibration profile as human course completions.
      if (outcome) liveOutcomes.push(outcome);

      // Publish two real linked-data descriptors: the ac:TeachingPackage
      // (the transmissible capability itself) and the amta:Attestation
      // (the cryptographic transfer-verified attestation). The teaching
      // package is Hypothetical until the attestation flips it; we keep
      // the attestation's modal status whatever amta: assigned (this
      // version: Asserted on a verified transfer).
      const published: PublishedDescriptor[] = [];
      if (podConfigured && publishConfig) {
        const pkgDesc = await tryPublishBounded('teaching-package', () =>
          withPublishLock(() => publishTeachingPackageDescriptor(
            { package: pkg, targetBehaviour, teacher: teacher.id, learner: learner.id, intervention },
            { id: teacher.id, kind: 'agent' },
            publishConfig,
          )), 4000);
        if (pkgDesc) published.push(pkgDesc);
        const attDesc = await tryPublishBounded('teaching-attestation', () =>
          withPublishLock(() => publishTeachingAttestationDescriptor(
            { attestation, verdict, learner: learner.id, teacher: teacher.id, teachingPackageIri: tp.iri },
            { id: teacher.id, kind: 'agent' },
            publishConfig,
          )), 4000);
        if (attDesc) published.push(attDesc);
      }

      const responseBody = jsonLdEnvelope({
        baseUrl: base,
        id: `urn:foxxi:teach-response:${Date.now().toString(36)}`,
        types: ['foxxi:TeachingResponse'],
        body: { intervention, verdict, attestation, outcome },
        published,
        affordances: {
          readCalibration: { method: 'POST', href: `${base}/performance/calibration`,
            note: 'The teaching transfer (if verified) flows up into the same calibration profile as field outcomes.',
            returns: 'foxxi:CalibrationProfile' },
          ...(published[0] ? {
            fetchTeachingPackage: { method: 'GET', href: published[0].descriptorUrl,
              note: 'Dereference the ac:TeachingPackage descriptor (Turtle).',
              returns: 'ac:TeachingPackage' },
          } : {}),
          ...(published[1] ? {
            fetchAttestation: { method: 'GET', href: published[1].descriptorUrl,
              note: 'Dereference the amta:Attestation descriptor (Turtle) — the cryptographic record of the transfer verification.',
              returns: 'amta:Attestation' },
          } : {}),
        },
      });
      res.setHeader('Content-Type', 'application/ld+json');
      res.json(responseBody);
    } catch (e) {
      bad(res, `teach failed: ${(e as Error).message}`);
    }
  });

  // ── POST /content/compose-course — the authoring tool. ────────────
  app.post('/content/compose-course', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const author = asPerformer(body.authoredBy);
    if (!author) { bad(res, 'authoredBy must be { id, kind: "human"|"agent" } — the human or agent acting as instructional designer'); return; }
    if (typeof body.title !== 'string' || typeof body.competency !== 'string') {
      bad(res, 'title and competency (strings) are required'); return;
    }
    const audience: Performer['kind'] = body.audience === 'agent' ? 'agent' : 'human';
    const modulesIn = Array.isArray(body.modules) ? body.modules as Array<Record<string, unknown>> : [];
    if (modulesIn.length === 0) { bad(res, 'modules[] is required — each with { title, competencyPoint, lessons[] }'); return; }

    try {
      const modules: Array<{ competencyPoint: string; modules: Module[] }> = modulesIn.map(m => {
        const lessonsIn = Array.isArray(m.lessons) ? m.lessons as Array<Record<string, unknown>> : [];
        const lessons: Lesson[] = lessonsIn.map(l => {
          const fragsIn = Array.isArray(l.fragments) ? l.fragments as Array<Record<string, unknown>> : [];
          const fragments: GroundingFragment[] = fragsIn.map(f => authorFragment({
            modality: (f.modality as FragmentModality) ?? 'concept',
            competencyPoint: String(f.competencyPoint ?? l.competencyPoint ?? m.competencyPoint ?? body.competency),
            body: String(f.body ?? ''),
            level: (f.level as CognitiveLevel) ?? 'working',
            authoredBy: author,
            ...(typeof f.suitsDisposition === 'string' ? { suitsDisposition: f.suitsDisposition } : {}),
          }));
          // A lesson is a SEQUENCE of fragments (concept → worked
          // example → assessment), so each fragment is its own syntagm
          // position. Putting them all in one position would make them
          // interchangeable paradigm alternatives — and flattening the
          // course for delivery would then keep only the first.
          const lessonCp = String(l.competencyPoint ?? m.competencyPoint ?? body.competency);
          return authorLesson({
            title: String(l.title ?? 'Lesson'),
            competency: String(body.competency),
            audience,
            authoredBy: author,
            positions: fragments.length > 0
              ? fragments.map(f => ({ competencyPoint: lessonCp, fragments: [f] }))
              : [{ competencyPoint: lessonCp, fragments }],
          });
        });
        return {
          competencyPoint: String(m.competencyPoint ?? body.competency),
          modules: [authorModule({
            title: String(m.title ?? 'Module'),
            competency: String(body.competency),
            authoredBy: author,
            positions: lessons.map(ls => ({ competencyPoint: ls.competency, lessons: [ls] })),
          })],
        };
      });
      const course = composeCourse({
        title: body.title,
        competency: body.competency,
        audience,
        authoredBy: author,
        positions: modules,
        ...(body.moveOn === 'Completed' || body.moveOn === 'Passed' || body.moveOn === 'CompletedOrPassed' ? { moveOn: body.moveOn } : {}),
      });
      res.json({
        course,
        cmi5Outline: courseToCmi5Outline(course),
        note: 'An emergent course — a syntagm of modules → lessons → grounding fragments. POST it to /content/personalize to resolve it for a performer, or launch its cmi5 outline via the cmi5 LMS layer.',
      });
    } catch (e) {
      bad(res, `compose failed: ${(e as Error).message}`);
    }
  });

  // ── POST /content/personalize — the composition algebra. ──────────
  app.post('/content/personalize', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const course = body.course as Course | undefined;
    if (!course || typeof course !== 'object' || !Array.isArray(course.syntagm)) {
      bad(res, 'a "course" object (from /content/compose-course) is required'); return;
    }
    const performer = asPerformer(body.performer);
    if (!performer) { bad(res, 'performer must be { id, kind: "human"|"agent" }'); return; }
    const resolved = personalize(course, performer, {
      ...(Array.isArray(body.masteredCompetencyPoints) ? { masteredCompetencyPoints: body.masteredCompetencyPoints as string[] } : {}),
      ...(typeof body.dispositionPreference === 'string' ? { dispositionPreference: body.dispositionPreference } : {}),
    });
    const rendering = forAudience(resolved, course.authoredBy);
    res.json({ resolved, rendering });
  });

  // ── GET /knowledge — self-describing knowledge index. ─────────────
  app.get('/knowledge', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      system: 'Foxxi Knowledge Architecture',
      principle: 'Of the knowledge a competent performer draws on, only part can honestly become content. The work regime decides the strategy: codify in Evident/Knowable regimes, connect-and-flow in the Emergent regime.',
      knowledgeComponents: ['recorded', 'trained', 'judged', 'lived', 'innate'],
      _affordances: {
        mapKnowledge: { method: 'POST', href: `${base}/knowledge/map`, note: 'Decompose a competency into knowledge components, choose a regime-routed strategy, and split it into what to codify (content) and what to enable as a flow.' },
      },
    });
  });

  // ── POST /knowledge/map — decompose a competency's knowledge. ──────
  app.post('/knowledge/map', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.competency !== 'string' || !body.competency) { bad(res, 'competency (string) is required'); return; }
    const regime: WorkRegime = ['Evident', 'Knowable', 'Emergent', 'Turbulent'].includes(body.regime as string)
      ? body.regime as WorkRegime : 'Knowable';
    const valid = ['recorded', 'trained', 'judged', 'lived', 'innate'];
    const components: ComponentInput[] = Array.isArray(body.components)
      ? (body.components as Array<Record<string, unknown>>)
          .filter(c => valid.includes(c.component as string) && typeof c.description === 'string')
          .map(c => ({ component: c.component as KnowledgeComponent, description: c.description as string }))
      : [];
    if (components.length === 0) {
      bad(res, 'components[] is required — each { component: "recorded"|"trained"|"judged"|"lived"|"innate", description }');
      return;
    }
    const performer = asPerformer(body.performer);
    const knowledgeMap = mapKnowledge({
      competency: body.competency, regime, components,
      ...(performer ? { performer } : {}),
    });
    res.json({ knowledgeMap });
  });
}
