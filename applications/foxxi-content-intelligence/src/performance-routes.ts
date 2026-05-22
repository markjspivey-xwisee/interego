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
export function attachPerformanceRoutes(app: Express, config: { selfBaseUrl: string }): void {
  const base = config.selfBaseUrl.replace(/\/+$/, '');

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
  const peerProfile = buildCalibrationProfile(expandOutcomeCorpus(SAMPLE_PEER_OUTCOMES));
  const liveOutcomes: OutcomeRecord[] = [];
  const calibrationProfiles = () => {
    const tenant = buildCalibrationProfile([...seedRecords, ...liveOutcomes]);
    const federated = composeCalibrationProfiles([tenant, federationView(peerProfile)]);
    return { tenant, federated };
  };

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
  app.post('/performance/plan', (req: Request, res: Response) => {
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
    res.json({ diagnosis, plan, scaffold, calibration });
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
  // A completed performance loop records its outcome here; the next
  // calibration read recomposes the profile to include it. The parts
  // (individual outcomes) cause the whole (the calibration profile),
  // which then exerts downward causation on the next plan.
  app.post('/performance/outcome', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const outcome = recordLiveOutcome((req.body ?? {}) as Record<string, unknown>);
    if (typeof outcome === 'string') { bad(res, outcome); return; }
    liveOutcomes.push(outcome);
    res.json({
      recorded: true,
      liveOutcomes: liveOutcomes.length,
      totalSamples: calibrationProfiles().tenant.totalSamples,
      note: 'Outcome recorded. The calibration profile recomposes to include it on the next read — '
        + 'a completed loop now shapes the next recommendation.',
    });
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
  app.post('/agent/teach', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const b = (req.body ?? {}) as Record<string, unknown>;
    const teacher = asPerformer(b.teacher);
    const learner = asPerformer(b.learner);
    if (!teacher || teacher.kind !== 'agent') { bad(res, 'teacher must be an agent — { id, kind: "agent" }'); return; }
    if (!learner || learner.kind !== 'agent') { bad(res, 'learner must be an agent — { id, kind: "agent" }'); return; }
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
      res.json({
        intervention,
        verdict,
        attestation,
        outcome,
        note: 'The performance lens over an ac:TeachingPackage. Foxxi does not invent agent teaching — '
          + 'agent-collective authors the package, agent-development-practice supplies the practice. '
          + 'Foxxi frames the acquisition as an A2A instruction intervention, verifies the transfer '
          + 'from the learner\'s trajectories, and emits an amta:Attestation that feeds ac:\'s modal '
          + 'discipline and the reflexive calibration loop.',
      });
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
