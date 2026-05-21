/**
 * Bridge routes for the Foxxi Performance Architecture.
 *
 * Exposes the diagnosis → intervention spine (performance-architecture.ts)
 * and the emergent-content authoring tools (emergent-content.ts) as HTTP
 * endpoints. The endpoints ARE the authoring tools: a human instructional
 * designer reaches them through the dashboard, an agent reaches them as a
 * tool call — the same affordances, which is what makes H2H / H2A / A2H /
 * A2A authoring symmetric.
 *
 *   GET  /performance                  self-describing HATEOAS index
 *   POST /performance/plan             diagnose a gap → an InterventionPlan
 *   POST /content/compose-course       author an emergent course
 *   POST /content/personalize          personalise a course for a performer
 *
 * Layer: L3 vertical. Thin HTTP adapter over the two pure modules.
 */

import type { Express, Request, Response } from 'express';
import {
  diagnose, recommendInterventions,
  type PerformanceGap, type Performer, type DiagnoseInput,
} from './performance-architecture.js';
import {
  authorFragment, authorLesson, authorModule, composeCourse,
  personalize, forAudience, courseToCmi5Outline, scaffoldFromPlan,
  type Course, type Module, type Lesson, type GroundingFragment,
  type FragmentModality, type BloomLevel,
} from './emergent-content.js';

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

/** Attach the performance-architecture + emergent-content routes. */
export function attachPerformanceRoutes(app: Express, config: { selfBaseUrl: string }): void {
  const base = config.selfBaseUrl.replace(/\/+$/, '');

  // ── Self-describing index — dereferenceable, HATEOAS. ─────────────
  app.get('/performance', (_req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.json({
      system: 'Foxxi Performance Architecture',
      principle: 'Performance is the unit, not content. A diagnosis decides the intervention; content is composed only when it is the answer. Performance consulting is Cynefin-routed — HPT gap analysis for Clear/Complicated work, dispositional probes for Complex.',
      directionalities: ['H2H', 'H2A', 'A2H', 'A2A'],
      interventionParadigm: [
        'instruction', 'performance-support', 'reference', 'practice',
        'assessment', 'coaching', 'probe', 'environmental-fix', 'no-intervention',
      ],
      _affordances: {
        diagnoseAndPlan: { method: 'POST', href: `${base}/performance/plan`, note: 'Diagnose a performance gap and return the full intervention paradigm — selected and ruled-out, with reasoning.' },
        composeCourse: { method: 'POST', href: `${base}/content/compose-course`, note: 'Author an emergent course — a syntagm of modules → lessons → grounding fragments. The same tool for human and agent authors.' },
        personalizeCourse: { method: 'POST', href: `${base}/content/personalize`, note: 'Resolve a course for one performer via the composition algebra (restriction + override).' },
      },
      vocabulary: `${base}/ns/foxxi`,
      demo: 'tools/performance-architecture-example.mjs',
    });
  });

  // ── POST /performance/plan — the diagnosis → intervention spine. ──
  app.post('/performance/plan', (req: Request, res: Response) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    const body = (req.body ?? {}) as Record<string, unknown>;
    const g = body.gap as Record<string, unknown> | undefined;
    if (!g || typeof g !== 'object') { bad(res, 'a "gap" object is required'); return; }
    const performer = asPerformer(g.performer);
    if (!performer) { bad(res, 'gap.performer must be { id, kind: "human"|"agent" }'); return; }
    for (const f of ['workContext', 'competency', 'desired', 'observed']) {
      if (typeof g[f] !== 'string' || !g[f]) { bad(res, `gap.${f} (string) is required`); return; }
    }
    const gap: PerformanceGap = {
      id: typeof g.id === 'string' ? g.id : `urn:foxxi:gap:${Date.now()}`,
      performer,
      workContext: g.workContext as string,
      competency: g.competency as string,
      desired: g.desired as string,
      observed: g.observed as string,
      frequency: (['continuous', 'frequent', 'occasional', 'rare'].includes(g.frequency as string) ? g.frequency : 'frequent') as PerformanceGap['frequency'],
      criticality: (['low', 'moderate', 'high', 'safety-critical'].includes(g.criticality as string) ? g.criticality : 'moderate') as PerformanceGap['criticality'],
      modalStatus: g.modalStatus === 'Asserted' ? 'Asserted' : 'Hypothetical',
      provenance: typeof g.provenance === 'string' ? g.provenance : 'caller-supplied',
      ...(['Clear', 'Complicated', 'Complex', 'Chaotic'].includes(g.domain as string) ? { domain: g.domain as PerformanceGap['domain'] } : {}),
    };
    const diagnoseInput: DiagnoseInput = {
      gap,
      ...(typeof body.couldDoIfLifeDependedOnIt === 'boolean' ? { couldDoIfLifeDependedOnIt: body.couldDoIfLifeDependedOnIt } : {}),
      ...(typeof body.performedWellBefore === 'boolean' ? { performedWellBefore: body.performedWellBefore } : {}),
      ...(body.bemEvidence && typeof body.bemEvidence === 'object' ? { bemEvidence: body.bemEvidence as DiagnoseInput['bemEvidence'] } : {}),
    };
    const diagnosis = diagnose(diagnoseInput);
    const author = asPerformer(body.author, { id: 'urn:foxxi:agent:performance-consultant', kind: 'agent', role: 'performance consultant' })!;
    const plan = recommendInterventions({ diagnosis, gap, author });
    const scaffold = scaffoldFromPlan(plan, gap.competency);
    res.json({ diagnosis, plan, scaffold });
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
            bloom: (f.bloom as BloomLevel) ?? 'understand',
            authoredBy: author,
            ...(typeof f.suitsDisposition === 'string' ? { suitsDisposition: f.suitsDisposition } : {}),
          }));
          return authorLesson({
            title: String(l.title ?? 'Lesson'),
            competency: String(body.competency),
            audience,
            authoredBy: author,
            positions: [{ competencyPoint: String(l.competencyPoint ?? body.competency), fragments }],
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
}
