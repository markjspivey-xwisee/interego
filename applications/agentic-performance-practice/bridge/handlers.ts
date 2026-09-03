/**
 * agp bridge capability handlers.
 *
 * ★ EXTRACTED FROM server.ts BECAUSE server.ts CALLS app.listen() AT MODULE SCOPE.
 * Importing it to exercise a handler binds a port, so nothing could ever test the
 * real handlers — which is a large part of why six of them stayed stubs and the
 * seventh published SHACL-invalid nodes unnoticed. The factory takes the fetch it
 * publishes with, so a test drives the REAL handler + the REAL publisher + the
 * REAL shapes and inspects the bytes that would have reached a pod. The network
 * is the only thing doubled.
 */
import { diagnose, recommendInterventions, evaluateIntervention } from '../src/performance-architecture.js';
import { AGP_ONTOLOGY_IRI } from '../src/ontology.js';
import { proposeStandardsExtension, type ExtensionKind } from '../src/standards-extension.js';
// ★ COMPOSED, NOT REBUILT. The blocker recorded on this handler was "no pod
// container-enumeration helper". The substrate already walks a pod's manifest chain over
// the LDP membership each container ADVERTISES (`ldp:contains`), and exports it. Adding a
// second enumerator here would have been a private reimplementation of a published one —
// and a filename-shaped one, which is exactly what silently dropped %-encoded names there.
import { fetchAllManifestEntries, predictManifestUrl } from '@interego/solid';
import { guardedFetchFn, assertSafeFetchTarget } from '@interego/core';
import { refuse } from '../../_shared/vertical-bridge/refusal.js';
import {
  coerceSituation, coerceDiagnosis, coercePlan, fetchJson,
  publishAgpArtifact, agpEvaluationProperties, agpOutcomeProperties, deterministicIri, AGP,
  type AgpProperty,
} from './pod-helpers.js';

const REGIME_IRI: Record<string, string> = {
  Evident: `${AGP}Evident`, Knowable: `${AGP}Knowable`,
  Emergent: `${AGP}Emergent`, Turbulent: `${AGP}Turbulent`,
};
const METHOD_IRI: Record<string, string> = {
  'apply-practice': `${AGP}ApplyPractice`, 'gap-analysis': `${AGP}GapAnalysis`,
  'dispositional-read': `${AGP}DispositionalRead`, 'stabilise-first': `${AGP}StabiliseFirst`,
  'classify-first': `${AGP}ClassifyFirst`,
};

/**
 * A stub must name the blocker that is ACTUALLY unmet.
 *
 * ★ The previous factory hard-coded `pending: 'stage-2'` and the sentence
 * "Publisher + regime engine arrive in Stage 2, when the performance engine is
 * moved out of Foxxi". That move SHIPPED (the engine's canonical home is
 * src/performance-architecture.ts and Foxxi re-exports it via a shim), and the
 * sentence stayed, because it was a string literal derived from nothing — no
 * test, lint or probe could observe that a stated precondition had become false.
 * The reason is now a required argument at each call site, so a stale one cannot
 * be copy-pasted in from a sibling.
 */
/**
 * A handler that cannot do its job yet, carrying the reason WHY as a required argument.
 *
 * ★ THE MARKER IS A PROPERTY, NOT A BEHAVIOUR. The bridge's boot banner used to list the
 * pending tools by hand and went stale the moment one became real. The obvious replacement —
 * call each handler with `{}` and see which answers with a `pending` field — is WRONG, and
 * measurably so: it classified `diagnose` and `plan_intervention` as pending, because a REAL
 * handler given no input also declines. "Refused empty input" and "is a stub" are different
 * questions and only this tag answers the second one.
 */
export const PENDING_BLOCKER = Symbol.for('agp.pendingBlocker');

function pendingHandler(toolName: string, required: string[], blocker: string, reason: string) {
  const fn = async (args: Record<string, unknown>) => {
    const missing = required.filter(k => args[k] === undefined || args[k] === null || args[k] === '');
    if (missing.length) throw new Error(`${toolName}: missing required input(s): ${missing.join(', ')}`);
    return { pending: blocker, tool: toolName, note: reason, ontology: AGP_ONTOLOGY_IRI, received: args };
  };
  return Object.assign(fn, { [PENDING_BLOCKER]: blocker });
}

/** The agp: namespace, for deciding which manifest entries are this vertical's. */
const AGP_NS_FOR_LIST = 'https://markjspivey-xwisee.github.io/interego/applications/agentic-performance-practice/agp#';
const str = (v: unknown): string => String(v ?? '');
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);

export function createAgpHandlers(deps: { fetchFn?: typeof fetch } = {}): Record<string, (a: Record<string, unknown>) => Promise<unknown>> {
  // The double is passed as an ARGUMENT, never assigned to globalThis.fetch:
  // vitest shares one globalThis here, and a global fetch patch in this file
  // would break unrelated pod-touching suites in a full run only.
  const pub = (a: Parameters<typeof publishAgpArtifact>[0]): Promise<string | null> =>
    publishAgpArtifact(deps.fetchFn ? { ...a, fetchFn: deps.fetchFn } : a);
  const readJson = (iri: string, podUrl?: string): Promise<unknown | null> =>
    fetchJson(iri, podUrl, deps.fetchFn ?? globalThis.fetch);

  return {
    'agp.contextualize_situation': async (args) => {
      const statement = str(args.situation_statement);
      if (!statement) throw new Error('agp.contextualize_situation: missing required input(s): situation_statement');
      const situationIri = deterministicIri('situation', `${statement}|${str(args.performer_iri)}`);
      // Run the REAL engine to place the regime. A caller-supplied `regime` becomes
      // situation.domain, which diagnose() records as regimeSource 'asserted'.
      const d = diagnose({
        situation: {
          id: situationIri,
          performer: { id: args.performer_iri ? str(args.performer_iri) : 'urn:agp:performer:anon', kind: 'agent' },
          workContext: statement,
          competency: statement,
          observed: statement,
          frequency: 'occasional',
          criticality: 'moderate',
          modalStatus: 'Hypothetical',
          provenance: str(args.operator_did) || 'agp.contextualize_situation',
          ...(args.regime ? { domain: args.regime as 'Evident' | 'Knowable' | 'Emergent' | 'Turbulent' } : {}),
        },
      });
      // ★ regimeSource is ENGINE-DERIVED and must never be caller-asserted.
      // 'derived' is the one provenance the model reserves for trajectory
      // evidence, and only a derived regime may gap-analyse or accrue
      // calibration authority — honouring args.regime_source would be a
      // one-field backdoor into both.
      const regimeSource = d.regimeSource;
      if (!d.domain) {
        // PerformanceSituationShape requires agp:regime minCount 1. Publishing
        // here would emit an invalid node; saying so is the honest answer.
        // ★ 400, NOT 200. I left this one untyped in the round that typed its three siblings,
        // reasoning it was a PARTIAL success: the engine really did run, and situationIri and
        // method are real output. An audit disagreed and is right — `persisted: false` and
        // `descriptorUrl: null` mean the thing this affordance EXISTS to do did not happen, and
        // the note below says the caller can fix it by supplying evidence. That is a declined
        // call whose analysis is returned with it, not a success with a footnote.
        return {
          ...refuse(400, 'Situation not published: a conformant agp:PerformanceSituation MUST carry a regime, and no evidence placed one. Assert `regime`, or diagnose with trajectories/factor evidence first.',
            'the arguments carried no evidence that could place the situation in a work regime'),
          situationIri, regime: null, regimeSource, method: d.method,
          descriptorUrl: null, persisted: false,
          pending: 'no-regime-evidence',
          note: 'Situation not published: a conformant agp:PerformanceSituation MUST carry a regime, and no evidence placed one. Assert `regime`, or diagnose with trajectories/factor evidence first.',
        };
      }
      const properties: AgpProperty[] = [
        { predicate: `${AGP}regime`, object: { iri: REGIME_IRI[d.domain]! } },
        { predicate: `${AGP}regimeSource`, object: { literal: regimeSource } },
      ];
      let descriptorUrl: string | null = null;
      if (args.pod_url) {
        descriptorUrl = await pub({
          iri: situationIri, typeIri: `${AGP}PerformanceSituation`, label: statement,
          podUrl: str(args.pod_url), properties,
          author: args.operator_did ? { id: str(args.operator_did), kind: 'agent', role: 'performance consultant' } : undefined,
          slug: `situation-${situationIri.split(':').pop()}`,
        });
      }
      return { situationIri, regime: d.domain, regimeSource, method: d.method, descriptorUrl, persisted: !!descriptorUrl, pending: null };
    },

    'agp.define_capability': async (args) => {
      const name = str(args.name);
      if (!name) throw new Error('agp.define_capability: missing required input(s): name');
      const composedOf = [...strList(args.skill_iris), ...strList(args.tool_iris)];
      if (composedOf.length === 0) {
        // CapabilityShape rejects an empty capability. Minting one anyway would
        // be a fabricated capability, so REFUSE rather than publish-and-fail.
        throw new Error('agp.define_capability: a capability MUST be composed of at least one constituent — supply skill_iris and/or tool_iris. An empty capability is not productive (agpsh:CapabilityShape).');
      }
      const capabilityIri = deterministicIri('capability', `${name}|${composedOf.join(',')}`);
      let descriptorUrl: string | null = null;
      if (args.pod_url) {
        descriptorUrl = await pub({
          iri: capabilityIri, typeIri: `${AGP}Capability`, label: name, podUrl: str(args.pod_url),
          properties: composedOf.map(iri => ({ predicate: `${AGP}composedOf`, object: { iri } })),
          author: args.operator_did ? { id: str(args.operator_did), kind: 'agent' } : undefined,
          slug: `capability-${capabilityIri.split(':').pop()}`,
        });
      }
      return { capabilityIri, composedOf, descriptorUrl, persisted: !!descriptorUrl, pending: null };
    },

    'agp.map_affordance': async (args) => {
      const missing = ['situation_iri', 'affordance_statement', 'requires_capability_iri'].filter(k => !args[k]);
      if (missing.length) throw new Error(`agp.map_affordance: missing required input(s): ${missing.join(', ')}`);
      const statement = str(args.affordance_statement);
      const requiresCapability = str(args.requires_capability_iri);
      const affordanceIri = deterministicIri('affordance', `${str(args.situation_iri)}|${statement}`);
      let descriptorUrl: string | null = null;
      if (args.pod_url) {
        descriptorUrl = await pub({
          iri: affordanceIri, typeIri: `${AGP}PerformanceAffordance`, label: statement, podUrl: str(args.pod_url),
          properties: [{ predicate: `${AGP}requiresCapability`, object: { iri: requiresCapability } }],
          author: args.operator_did ? { id: str(args.operator_did), kind: 'agent' } : undefined,
          slug: `affordance-${affordanceIri.split(':').pop()}`,
        });
      }
      return { affordanceIri, requiresCapability, descriptorUrl, persisted: !!descriptorUrl, pending: null };
    },

    'agp.actualize': async (args) => {
      const missing = ['situation_iri', 'capability_iri', 'affordance_iri', 'performance_statement'].filter(k => !args[k]);
      if (missing.length) throw new Error(`agp.actualize: missing required input(s): ${missing.join(', ')}`);
      /**
       * ★★ `success` AND `score_scaled` ARE RECORDED. They were declared, accepted, and dropped —
       * see `agpOutcomeProperties`, which carries the whole account. An out-of-range score is
       * REFUSED rather than clamped: the affordance advertises [-1,1], and quietly rounding a
       * caller's number into range would publish a measurement nobody took.
       */
      const success = args.success === undefined || args.success === null
        ? undefined : Boolean(args.success);
      let scoreScaled: number | undefined;
      if (args.score_scaled !== undefined && args.score_scaled !== null) {
        const n = Number(args.score_scaled);
        if (!Number.isFinite(n) || n < -1 || n > 1) {
          return refuse(400,
            `agp.actualize: score_scaled must be a finite number in [-1,1], got `
              + `${JSON.stringify(args.score_scaled)}. Nothing was published — a score outside the `
              + 'declared range is refused rather than clamped, because a clamped score is a '
              + 'measurement nobody took.',
            'the scaled score is outside the range this affordance declares');
        }
        scoreScaled = n;
      }
      const statement = str(args.performance_statement);
      const performanceIri = deterministicIri('performance', `${str(args.situation_iri)}|${statement}`);
      const actualizationIri = deterministicIri('actualization', `${str(args.capability_iri)}|${str(args.affordance_iri)}|${performanceIri}`);
      let descriptorUrl: string | null = null;
      if (args.pod_url) {
        descriptorUrl = await pub({
          iri: actualizationIri, typeIri: `${AGP}Actualization`, label: statement, podUrl: str(args.pod_url),
          // All four triples ActualizationShape requires. This is the productive
          // join; an actualization missing any of them denotes nothing.
          properties: [
            { predicate: `${AGP}engages`, object: { iri: str(args.capability_iri) } },
            { predicate: `${AGP}inSituation`, object: { iri: str(args.situation_iri) } },
            { predicate: `${AGP}actualizes`, object: { iri: str(args.affordance_iri) } },
            { predicate: `${AGP}yields`, object: { iri: performanceIri } },
            // The observed outcome, when the caller observed one. Nothing is emitted otherwise.
            ...agpOutcomeProperties(success, scoreScaled),
          ],
          author: args.operator_did ? { id: str(args.operator_did), kind: 'agent' } : undefined,
          slug: `actualization-${actualizationIri.split(':').pop()}`,
        });
      }
      // xapiStatementId stays null: projecting to Foxxi's LRS from here would
      // invert the dependency arrow (it is foxxi → agp, never the reverse). It is
      // not in the affordance's outputs.required, so null is honest, not missing.
      return {
        actualizationIri, performanceIri, xapiStatementId: null, descriptorUrl,
        persisted: !!descriptorUrl, pending: null,
        // Echoed so a caller can see WHICH outcome landed, and see nothing when it sent nothing.
        // Absent from `outputs.required` for the same reason: an unobserved outcome is not a null
        // one. Only meaningful when `persisted` is true - without a pod_url nothing was written.
        recordedOutcome: (success === undefined && scoreScaled === undefined) ? null : {
          ...(success === undefined ? {} : { success }),
          ...(scoreScaled === undefined ? {} : { scoreScaled }),
        },
      };
    },

    // REAL: run the regime engine. Accepts an inline `situation` object (preferred)
    // OR a resolvable situation_iri + pod_url; honestly degrades if the situation
    // cannot be resolved. Honours the engine's regime-honesty contract (a named
    // factor ONLY for the Knowable regime).
    'agp.diagnose': async (args) => {
      const raw = args.situation ?? (args.situation_iri ? await readJson(str(args.situation_iri), args.pod_url ? str(args.pod_url) : undefined) : null);
      const situation = coerceSituation(raw);
      if (!situation) {
      /**
       * ★★ THIS ANSWERED HTTP 200 AND THE ENGINE HAD RUN NOTHING.
       *
       * A repo-wide census cleared this file twice: its key was error|reason|refused|denied and
       * this payload contains none of those words. `pending` was a THIRD spelling of "no", after
       * `error` and `reason`, and no word list would have anticipated it. Found by POSTing.
       *
       * 400: the caller brought neither a resolvable situation nor an inline one. `pending` and
       * `received` are kept — they are the useful half — but the STATUS now says declined.
       */
        return { ...refuse(400, 'Pass an inline `situation` object, or a `situation_iri` resolvable against `pod_url`. The engine ran nothing because no situation could be resolved.',
          'no situation could be resolved from the arguments supplied'),
          pending: 'situation-not-resolvable', tool: 'agp.diagnose', received: args };
      }
      const factorEvidence = (args.factor_evidence ?? args.factorEvidence) as Record<string, { adequate: boolean; evidence: string }> | undefined;
      const d = diagnose({
        situation,
        exemplary: args.exemplary ? str(args.exemplary) : undefined,
        factorEvidence,
        trajectories: Array.isArray(args.trajectories) ? args.trajectories as never : undefined,
        couldPerformUnderIdealConditions: typeof args.could_perform_under_ideal_conditions === 'boolean' ? args.could_perform_under_ideal_conditions : undefined,
        performedWellBefore: typeof args.performed_well_before === 'boolean' ? args.performed_well_before : undefined,
      });
      const diagnosisIri = deterministicIri('diagnosis', `${situation.id}|${d.regimeSource}|${d.method}`);
      let descriptorUrl: string | null = null;
      if (args.pod_url) {
        descriptorUrl = await pub({
          iri: diagnosisIri, typeIri: `${AGP}Diagnosis`, label: `Diagnosis of ${situation.id}`, podUrl: str(args.pod_url),
          // ★ The pre-existing live defect: this call published a label-only graph,
          // which fails DiagnosisShape on both agp:diagnoses and agp:method. Every
          // agp:Diagnosis this bridge has written to a pod is invalid.
          properties: [
            { predicate: `${AGP}diagnoses`, object: { iri: situation.id } },
            { predicate: `${AGP}method`, object: { iri: METHOD_IRI[d.method]! } },
          ],
          author: args.operator_did ? { id: str(args.operator_did), kind: 'agent', role: 'performance consultant' } : undefined,
          slug: `diagnosis-${diagnosisIri.split(':').pop()}`,
        });
      }
      /**
       * ★★ THE RESULT MUST BE ACCEPTED BY THE AFFORDANCE THAT COMES NEXT.
       *
       * This projection used to drop `situationId` and `factors`, keeping only
       * `rootCauses[0]` as `factor`. Those are exactly the two fields the NEXT tool needs:
       * `coerceDiagnosis` refuses a diagnosis with no `situationId`, and
       * `recommendInterventions` reads `factors.<key>.adequate` on the Knowable branch.
       *
       * So an agent doing the obvious thing — call `agp.diagnose`, feed the result to
       * `agp.plan_intervention` — got `pending: inputs-not-resolvable`, and a hand-built
       * diagnosis with an ARRAY of factor strings crashed the engine with
       * "Cannot read properties of undefined (reading 'adequate')". Driven against the live
       * bridge; neither failure is reachable from the unit tests, which pass a diagnosis
       * built by hand to the shape the coercer wants.
       *
       * A vertical whose thesis is that agents chain published affordances cannot publish two
       * that do not compose. Both fields are restored here, additively — every existing key
       * keeps its meaning.
       */
      return {
        diagnosisIri,
        // Carried so the diagnosis this returns is the diagnosis `plan_intervention` accepts.
        situationId: situation.id,
        regime: d.domain ?? null, regimeSource: d.regimeSource, method: d.method,
        ...(d.domain === 'Knowable' && d.rootCauses.length ? { factor: d.rootCauses[0] } : {}),
        // The six-factor reading, not just its top row — the planner branches on all of it.
        ...(d.factors ? { factors: d.factors } : {}),
        skillDeficiency: d.skillDeficiency, exemplary: d.exemplary ?? null, reasoning: d.reasoning,
        caveat: d.caveat ?? null, descriptorUrl, persisted: !!descriptorUrl, pending: null,
      };
    },

    // REAL: emit a regime-appropriate intervention plan. Accepts an inline
    // `diagnosis` (+ `situation`) OR a resolvable diagnosis_iri.
    'agp.plan_intervention': async (args) => {
      const rawDiag = args.diagnosis ?? (args.diagnosis_iri ? await readJson(str(args.diagnosis_iri), args.pod_url ? str(args.pod_url) : undefined) : null);
      const diagnosis = coerceDiagnosis(rawDiag);
      const situation = coerceSituation(args.situation ?? null);
      if (!diagnosis || !situation) {
        return { ...refuse(400, 'Pass an inline `diagnosis` AND `situation` object (or a resolvable diagnosis_iri + the situation). The engine ran nothing.',
          'no diagnosis and situation pair could be resolved from the arguments supplied'),
          pending: 'inputs-not-resolvable', tool: 'agp.plan_intervention', received: args };
      }
      const author = args.operator_did ? { id: str(args.operator_did), kind: 'agent' as const, role: 'performance consultant' } : undefined;
      const plan = recommendInterventions({ diagnosis, situation, author });
      const planIri = deterministicIri('plan', `${diagnosis.situationId}|${plan.selected.map(o => o.type).join(',')}`);
      let descriptorUrl: string | null = null;
      if (args.pod_url) {
        // InterventionPlan is the one publishable class with no shape declared in
        // agp-shapes.ttl, so it needs no domain triples to conform. Left as-is
        // rather than inventing predicates the ontology does not require.
        descriptorUrl = await pub({ iri: planIri, typeIri: `${AGP}InterventionPlan`, label: `Intervention plan for ${diagnosis.situationId}`, podUrl: str(args.pod_url), author, slug: `plan-${planIri.split(':').pop()}` });
      }
      /**
       * ★★ THE SAME SEAM DEFECT AS diagnose->plan, ONE LINK FURTHER ALONG.
       *
       * This returned `interventions` — `plan.selected` renamed AND projected down to
       * `{type, rationale}` — and dropped `diagnosis` entirely. Those are exactly the two
       * fields `coercePlan` requires (`if (!p.diagnosis || !Array.isArray(p.selected)) return
       * null`), so feeding this handler's own answer into `agp.evaluate_intervention` returned
       * `pending: inputs-not-resolvable`.
       *
       * The diagnose->plan seam was fixed earlier the same day and a test written for THAT
       * PAIR. The chain is diagnose -> plan -> evaluate, and verifying one link of two is how
       * this survived the fix aimed at its own defect class. The companion test now walks the
       * whole chain, feeding each answer forward verbatim.
       *
       * `interventions` is KEPT: it is the readable projection callers already use, and
       * removing it would break them to fix a different problem. `selected` and `diagnosis`
       * are ADDED beside it, so the answer is both readable and re-feedable.
       */
      return {
        planIri,
        interventions: plan.selected.map(o => ({ type: o.type, rationale: o.rationale })),
        // What the next affordance in the chain requires, carried verbatim.
        selected: plan.selected,
        diagnosis,
        situationId: diagnosis.situationId,
        contentWarranted: plan.contentWarranted, direction: plan.direction, summary: plan.summary,
        descriptorUrl, persisted: !!descriptorUrl, pending: null,
      };
    },

    // REAL: run the four-level evaluation engine (evaluateIntervention has been
    // exported from the engine module this bridge already imports the whole time).
    'agp.evaluate_intervention': async (args) => {
      if (!args.intervention_iri) throw new Error('agp.evaluate_intervention: missing required input(s): intervention_iri');
      const plan = coercePlan(args.plan ?? null);
      const situation = coerceSituation(args.situation ?? null);
      if (!plan || !situation) {
        return { ...refuse(400, 'Pass an inline `plan` (an agp:InterventionPlan with its `diagnosis` and `selected`) AND the `situation` it targeted. The engine ran nothing and nothing was published.',
          'no plan and situation pair could be resolved from the arguments supplied'),
          pending: 'inputs-not-resolvable', tool: 'agp.evaluate_intervention', received: args };
      }
      const ev = evaluateIntervention({
        plan, situation,
        ...(args.note ? { response: { favourable: args.outcome_success === true, note: str(args.note) } } : {}),
        ...(typeof args.new_observed === 'string' ? { newObserved: args.new_observed } : {}),
      });
      const evaluationIri = deterministicIri('evaluation', `${str(args.intervention_iri)}|${ev.verdict}|${situation.id}`);
      let descriptorUrl: string | null = null;
      if (args.pod_url) {
        descriptorUrl = await pub({
          iri: evaluationIri, typeIri: `${AGP}InterventionEvaluation`, label: `Evaluation of ${str(args.intervention_iri)}`, podUrl: str(args.pod_url),
          // ★ THE ENGINE'S ANSWER WAS COMPUTED AND THEN DROPPED AT THE POD BOUNDARY.
          //
          // `evaluateIntervention` decides a verdict — closed / improved / no-change /
          // worsened / too-early — and that verdict is the entire content of an evaluation.
          // It was returned to the caller and never written, so every agp:InterventionEvaluation
          // on a pod said only WHICH intervention it judged and nothing about the judgement.
          // The triple list lives in pod-helpers so a program that wants a record this
          // vertical would recognise cannot compose its own and claim it is one.
          properties: agpEvaluationProperties(str(args.intervention_iri), ev.verdict),
          author: args.operator_did ? { id: str(args.operator_did), kind: 'agent' } : undefined,
          slug: `evaluation-${evaluationIri.split(':').pop()}`,
        });
      }
      return { evaluationIri, verdict: ev.verdict, levels: ev.levels, supersedes: ev.supersedes, nextAction: ev.nextAction, descriptorUrl, persisted: !!descriptorUrl, pending: null };
    },

    /**
     * REAL. Reads the operator's agp: state by walking the pod's own manifest chain and
     * keeping the entries whose declared type is in the agp: namespace.
     *
     * ★ THE BLOCKER WAS REAL BUT ALREADY SOLVED UPSTREAM. It read: "this bridge has no pod
     * container-enumeration helper — pod-helpers.ts exposes only fetchJson". True of THIS
     * bridge, and the reason it stayed a stub. But `@interego/solid` exports
     * `fetchAllManifestEntries`, which walks the manifest chain (hot + archives) built from
     * the `ldp:contains` membership each container publishes. So the honest fix is to compose
     * it, not to add a ninth enumerator that would have to relearn the same lessons — the
     * substrate's own note records that a filename regex there "silently dropped %-encoded
     * credential names and whole containers".
     *
     * Grouped by declared type rather than by filename, and it reports `complete` from the
     * walk instead of implying the list is exhaustive: a bounded or partially-unreachable
     * chain is a DIFFERENT answer from an empty practice, and collapsing the two is the
     * "a read that FAILED is not a thing that is missing" defect this repo has hit before.
     */
    'agp.list_practice': async (args) => {
      const podUrl = str(args.pod_url ?? args.podUrl);
      if (!podUrl) throw new Error('agp.list_practice: missing required input(s): pod_url');
      /**
       * ★ ASKED OF THE SUBSTRATE, NOT GUESSED. This read `new URL('manifest.ttl', pod)`, which
       * is not where a manifest lives: `packages/solid` keeps it at `.well-known/context-graphs`
       * and exports `predictManifestUrl` to say so. The guess 404s on every real pod, and a 404
       * is reported — correctly — as "no manifest, therefore no practice", so the handler
       * answered `{}` for every operator with a completely healthy-looking result.
       *
       * The unit tests could not catch it: their fixture fetch answers with a manifest whatever
       * URL is asked for, so the path was never the variable under test. It surfaced only
       * against a live pod, where `.well-known/context-graphs` returns 14 KB and `manifest.ttl`
       * returns 404.
       */
      const manifestUrl = predictManifestUrl(podUrl.endsWith('/') ? podUrl : `${podUrl}/`);
      /**
       * ★ THE POD IS THE CALLER'S TO NAME, SO THE FETCH IS THE CALLER'S TO AIM. This handler
       * takes `pod_url` from the request body and this bridge authenticates nobody, so an
       * unauthenticated request chose where the process connected. I wrote this handler today
       * and shipped it with the same gap the publish path had — the census found it, a fix of
       * the one site I had been looking at would not have.
       *
       * Screen the pod before the first hop, then hand the manifest walker a fetch that
       * re-guards every hop after it: a chain walk follows archive links, and a pre-check on
       * the first URL says nothing about the fifth.
       */
      await assertSafeFetchTarget(podUrl);
      const walk = await fetchAllManifestEntries(
        manifestUrl, guardedFetchFn(deps.fetchFn ?? globalThis.fetch));
      // Grouped by the agp: term each entry DECLARES conformance to. `conformsTo` is the
      // entry's own statement about what it is; `describes` names the subject it is about.
      // Neither is inferred from the filename — see the import note.
      const byType: Record<string, { subjects: string[]; descriptorUrl: string }[]> = {};
      let agpEntries = 0;
      for (const e of walk.entries) {
        const agpTerms = (e.conformsTo ?? []).filter(t => t.startsWith(AGP_NS_FOR_LIST));
        if (agpTerms.length === 0) continue;
        agpEntries += 1;
        for (const t of agpTerms) {
          (byType[t.slice(AGP_NS_FOR_LIST.length)] ??= []).push({
            subjects: [...e.describes],
            descriptorUrl: e.descriptorUrl,
          });
        }
      }
      return {
        podUrl,
        manifestUrl,
        ontology: AGP_ONTOLOGY_IRI,
        practice: byType,
        agpEntries,
        entriesWalked: walk.entries.length,
        // ★ THE WALK'S OWN VERDICT, FORWARDED RATHER THAN FLATTENED — AND ITS STATUS WITH IT.
        // The substrate answers `complete: true` for a 404, deliberately: no manifest is a
        // DEFINITE empty practice, not an unreadable one. Only a non-404 failure means "could
        // not tell". Both are reported, because a caller that sees an empty `practice` needs
        // to know which of the two it is looking at, and `complete` alone cannot say.
        complete: walk.complete,
        manifestStatus: walk.hotStatus,
        ...(walk.archivesUnreachable.length ? { archivesUnreachable: walk.archivesUnreachable } : {}),
      };
    },

    // REAL: pure + composes Foxxi's standards, so it needs no pod write to produce
    // a conformant, self-descriptive, guided artifact.
    'agp.extend_standards': async (args) => proposeStandardsExtension({
      kind: str(args.kind) as ExtensionKind,
      name: str(args.name),
      definition: str(args.definition),
      label: args.label as string | undefined,
      extendsStandard: args.extends_standard as string | undefined,
      subClassOf: args.subclass_of as string | undefined,
      buildsCapability: args.builds_capability as string | undefined,
    }),
  };
}
