/**
 * The Interego-native layer: a judgment becomes a Context Descriptor whose payload graph
 * carries the judgment AND the controls an agent may follow next. The controls are
 * authority-closed (they live in the signed payload, and the executable ones name the
 * bridge's own targets), and they EMERGE from the judged state: a low-confidence navigation
 * offers a narrowed search, an auto-ok verdict offers nothing but proceed, a triage with
 * flaky failures offers a retry. Outcomes are Asserted and supersede the Hypothetical
 * judgment they score.
 *
 * Two serializations, one payload:
 *   payloadTurtle   — the named graph's triples with absolute IRIs, what publish_context takes
 *   descriptorTrig  — a self-contained descriptor + payload for local and CI use
 * plus the HyperMarkdown projection a human sees in the viewer.
 */

import type { AnyJudgment } from './judgments/outcome.js';
import type { OutcomeRecord } from './judgments/outcome.js';
import { iriRef } from './turtle.js';
import { round } from './judgments/common.js';

export const IEP = 'https://markjspivey-xwisee.github.io/interego/ns/iep#';
export const IEH = 'https://markjspivey-xwisee.github.io/interego/ns/harness#';
export const HMD = 'https://relay.interego.xwisee.com/ns/maintainer/hmd#';
export const HMD_PROFILE = 'https://relay.interego.xwisee.com/ns/maintainer/hmd';
export const HYDRA = 'http://www.w3.org/ns/hydra/core#';
export const PROV = 'http://www.w3.org/ns/prov#';
export const DCT = 'http://purl.org/dc/terms/';
export const SKOS = 'http://www.w3.org/2004/02/skos/core#';
export const SCHEMA = 'https://schema.org/';
export const XSD = 'http://www.w3.org/2001/XMLSchema#';
export const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
export const AS = 'https://www.w3.org/ns/activitystreams#';
export const DCAT = 'http://www.w3.org/ns/dcat#';
export const DEFAULT_NS = 'https://jev-harness.interego.xwisee.com/ns/jev-harness#';

export type Published = AnyJudgment | OutcomeRecord;

export interface PublishContext {
  /** Bridge deployment URL, no trailing slash. */
  readonly base: string;
  /** Vertical namespace, ending in '#'. */
  readonly ns: string;
  readonly agentId: string;
  readonly ownerWebId?: string;
}

export interface Control {
  readonly id: string;
  readonly name: string;
  readonly title: string;
  readonly action: string;
  readonly method: 'GET' | 'POST';
  readonly target?: string;
  readonly expects?: string;
  readonly returns?: string;
  readonly arguments?: unknown;
  readonly scopeNote: string;
  readonly declarative: boolean;
}

export function contextFromEnv(base: string): PublishContext {
  const ownerWebId = process.env['JEV_HARNESS_OWNER_WEBID'];
  return {
    base: base.replace(/\/$/, ''),
    ns: process.env['JEV_HARNESS_NS'] ?? DEFAULT_NS,
    agentId: process.env['JEV_HARNESS_AGENT_ID'] ?? 'urn:agent:interego:jev-harness',
    ...(ownerWebId ? { ownerWebId } : {}),
  };
}

export function actionIri(verb: string): string {
  return `urn:iep:action:jev-harness:${verb}`;
}

export function judgmentUrl(j: Published, ctx: PublishContext): string {
  return `${ctx.base}/jev-harness/judgments/${j.id}`;
}

export function descriptorIri(j: Published): string {
  return `urn:iep:jev-harness:${j.kind}:${j.id}`;
}

export function subjectIri(j: Published): string {
  return `urn:jev-harness:${j.kind}:${j.id}`;
}

export function modalStatus(j: Published): 'Asserted' | 'Hypothetical' {
  return j.kind === 'outcome' ? 'Asserted' : 'Hypothetical';
}

export function payloadType(j: Published): string {
  switch (j.kind) {
    case 'navigation': return 'Navigation';
    case 'test-selection': return 'TestSelection';
    case 'failure-triage': return 'FailureTriage';
    case 'review-verdict': return 'ReviewVerdict';
    case 'outcome': return 'Outcome';
  }
}

// ── Emergent controls ─────────────────────────────────────────────────────────

export function controlsFor(j: Published, ctx: PublishContext): Control[] {
  const c = (name: string, spec: Omit<Control, 'id' | 'name' | 'action'> & { action?: string }): Control => ({
    id: `urn:control:jev-harness:${j.id}:${name}`,
    name,
    action: spec.action ?? actionIri(name),
    ...spec,
  });
  const executable = (name: string, verb: string, title: string, args: unknown, note: string, method: 'GET' | 'POST' = 'POST'): Control =>
    c(name, {
      title, method,
      action: actionIri(verb),
      target: `${ctx.base}/jev-harness/${verb === 'record-outcome' ? 'outcome' : verb}`,
      expects: `${ctx.ns}${shapeFor(verb)}`,
      returns: `${ctx.ns}${returnsFor(verb)}`,
      arguments: args,
      scopeNote: note,
      declarative: false,
    });
  const declarative = (name: string, title: string, args: unknown, note: string): Control =>
    c(name, { title, method: 'POST', arguments: args, scopeNote: note, declarative: true });
  const outcome = (args: Record<string, unknown>, note: string): Control =>
    executable('record-outcome', 'record-outcome', 'Record what actually happened', { judgment_iri: j.graphIri, ...args }, note);

  const out: Control[] = [];
  switch (j.kind) {
    case 'navigation': {
      const top = j.advice === 'open-top-file' ? j.files.slice(0, 1) : j.files.slice(0, 3);
      const paths = top.map((f) => f.path);
      out.push(declarative('open-files', j.advice === 'open-top-file' ? 'Open the top candidate' : 'Open the top three candidates', { files: paths, tests: j.tests.slice(0, 2).map((t) => t.path), docs: j.docs.slice(0, 1).map((d) => d.path) },
        `Advice ${j.advice} at confidence ${j.confidence}. Declarative: the editor or agent opens these; nothing is executed here.`));
      if (j.advice !== 'open-top-file') {
        const dir = j.files[0]?.path.split('/').slice(0, -1).join('/') ?? '';
        if (dir) out.push(executable('refine', 'navigate', 'Search again within the top directory', { task: j.task, scope: dir, top_k: 5 },
          'Offered because confidence was below the open-top-file threshold: a narrowed second pass usually separates neighbouring files.'));
      }
      if (paths.length > 0) out.push(executable('select-tests', 'select-tests', 'Select the tests these files warrant', { changed_files: paths, task: j.task },
        'Assumes the change lands in the candidate files; the selection is recomputed from the real diff before CI runs.'));
      out.push(outcome({ files_changed: [] }, 'After the change lands, pass files_changed; the Outcome supersedes this navigation and scores hit@1, hit@3 and Brier.'));
      break;
    }
    case 'test-selection': {
      const tests = j.tests.map((t) => t.path);
      const command = j.mode === 'full' ? 'npx vitest run' : `npx vitest run ${tests.join(' ')}`;
      out.push(declarative('run-selected-tests', j.mode === 'full' ? 'Run the whole suite' : `Run the ${tests.length} selected tests`, { mode: j.mode, tests, command },
        'Declarative by design: the bridge judges, it does not execute. A follower runs the command in the repository and passes the log to triage.'));
      out.push(executable('triage', 'triage', 'Triage the failures in the run log', { changed_files: j.changedFiles, log: '' },
        'Post the runner output as `log`; each failure is classified and the classes carry their own next steps.'));
      out.push(outcome({ tests_run: tests, tests_failed: [] }, 'Pass tests_failed from the run; the Outcome records whether every failing test was in the selection.'));
      break;
    }
    case 'failure-triage': {
      for (const g of j.groups) {
        const failures = j.failures.filter((f) => g.failures.includes(f.id)).map((f) => ({ id: f.id, ...(f.file ? { file: f.file } : {}), ...(f.name ? { name: f.name } : {}) }));
        out.push(declarative(g.action, `${g.action} (${g.count} ${g.causeClass})`, { causeClass: g.causeClass, failures },
          `Warranted by cause class ${g.causeClass}. Declarative: retries, fixes and remediation tasks are performed by the follower or a person.`));
      }
      out.push(outcome({ confirmed_classes: '{}' }, 'Pass confirmed_classes as a JSON object of failure id to the class a person confirmed; the Outcome scores the classification.'));
      break;
    }
    case 'review-verdict': {
      if (j.verdict === 'auto-ok') {
        out.push(declarative('proceed', 'Proceed without a human reviewer', { verdict: j.verdict, policy: j.policy },
          'The gate does not demand a person. Merging remains the workflow\'s decision, never this control\'s.'));
      } else if (j.verdict === 'block') {
        out.push(declarative('remove-secret', 'Remove the secret and republish the diff', { checks: j.checks },
          'A secret-like value is in the diff. Nothing proceeds until it is removed and rotated.'));
      } else {
        out.push(declarative('request-human-review', 'Ask a person to review', { reasons: j.reasons, hazards: j.hazards.filter((h) => h.fired).map((h) => h.name), ...(ctx.ownerWebId ? { to: ctx.ownerWebId } : {}) },
          'Send via notify_agent to the pod owner (the `to` argument) with the reasons as the summary; the reviewer records their decision through record-outcome.'));
      }
      out.push(outcome({ human_decision: '' }, 'Pass human_decision (approved, changes-requested or blocked); the Outcome records agreement with the verdict.'));
      break;
    }
    case 'outcome': {
      out.push(executable('calibration', 'calibration', 'Read the calibration view', {}, 'Per judgment kind: hit rates and Brier scores over recorded outcomes. A cell is Hypothetical until it has five samples.', 'GET'));
      break;
    }
  }
  return out;
}

function shapeFor(verb: string): string {
  switch (verb) {
    case 'navigate': return 'NavigateInputShape';
    case 'select-tests': return 'SelectTestsInputShape';
    case 'triage': return 'TriageInputShape';
    case 'review-gate': return 'ReviewGateInputShape';
    case 'record-outcome': return 'RecordOutcomeInputShape';
    default: return 'JudgmentShape';
  }
}

function returnsFor(verb: string): string {
  switch (verb) {
    case 'navigate': return 'Navigation';
    case 'select-tests': return 'TestSelection';
    case 'triage': return 'FailureTriage';
    case 'review-gate': return 'ReviewVerdict';
    case 'record-outcome': return 'Outcome';
    default: return 'Calibration';
  }
}

// ── Turtle ────────────────────────────────────────────────────────────────────

/** Turtle STRING_LITERAL_QUOTE escaping: backslash, quote, LF, CR, TAB. */
export function escapeTurtleLiteral(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t');
}

const lit = (s: string): string => `"${escapeTurtleLiteral(s)}"`;
const dbl = (n: number): string => `"${Number.isFinite(n) ? n : 0}"^^xsd:double`;
const bool = (b: boolean): string => `"${b}"^^xsd:boolean`;
const iri = (i: string): string => iriRef(i);
const prefixLine = (prefix: string, ns: string): string => `@prefix ${prefix}: ${iriRef(ns)} .`;

/** Prefixes the payload body uses. Predicates are written as prefixed names on purpose: the
 *  relay's note projection recognises a payload as readable by the tokens `schema:text`,
 *  `schema:name`, `dct:title` and friends in the Turtle it stores (deploy/mcp-relay/note-view.ts),
 *  and projects `hmd:control` entries into :::control blocks the same way. Absolute IRIs are
 *  semantically identical and render nothing — measured on the first published judgment. */
export const PAYLOAD_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['rdf', RDF], ['dct', DCT], ['schema', SCHEMA], ['prov', PROV], ['skos', SKOS], ['hmd', HMD], ['iep', IEP], ['hydra', HYDRA], ['xsd', XSD],
];

export function payloadPrefixes(ctx: PublishContext): string {
  return [...PAYLOAD_PREFIXES.map(([p, ns]) => prefixLine(p, ns)), prefixLine('jvh', ctx.ns)].join('\n');
}

/** The judgment's named-graph triples as a complete Turtle document — what publish_context stores. */
export function payloadTurtle(j: Published, ctx: PublishContext): string {
  return `${payloadPrefixes(ctx)}\n\n${payloadBody(j, ctx)}`;
}

/** The payload triples alone (prefixed names, no prefix declarations) for embedding in a graph block. */
export function payloadBody(j: Published, ctx: PublishContext): string {
  const S = iri(subjectIri(j));
  const P = (local: string): string => `jvh:${local}`;
  const lines: string[] = [];
  const t = (p: string, o: string): void => { lines.push(`${S} ${p} ${o} .`); };
  const controls = controlsFor(j, ctx);

  t('a', P(payloadType(j)));
  t('a', P('Judgment'));
  t('a', 'hmd:Document');
  t('dct:conformsTo', iri(HMD_PROFILE));
  t('dct:title', lit(titleOf(j)));
  t('schema:name', lit(titleOf(j)));
  t('schema:text', lit(proseOf(j)));
  t('schema:encodingFormat', lit('text/markdown; charset=UTF-8; variant=CommonMark'));
  t(P('model'), lit(j.model));
  t(P('confidence'), dbl(j.confidence));
  t(P('repository'), lit(j.repository.name));
  if (j.repository.commit) t(P('commit'), lit(j.repository.commit));
  t('prov:wasAttributedTo', iri(ctx.agentId));
  t('dct:created', `"${j.createdAt}"^^xsd:dateTime`);

  const bn = (props: Array<[string, string]>): string => `[ ${props.map(([p, o]) => `${p} ${o}`).join(' ; ')} ]`;
  switch (j.kind) {
    case 'navigation':
      t(P('task'), lit(j.task));
      if (j.scope) t(P('scope'), lit(j.scope));
      t(P('advice'), lit(j.advice));
      if (j.adviceBasis) t(P('adviceBasis'), lit(j.adviceBasis));
      if (j.adviceBucket) t(P('adviceBucket'), bn([[P('bucketFrom'), dbl(j.adviceBucket.from)], [P('samples'), `"${j.adviceBucket.samples}"^^xsd:integer`], [P('hitAt1Rate'), dbl(j.adviceBucket.hitAt1 ?? 0)], [P('hitAt3Rate'), dbl(j.adviceBucket.hitAt3 ?? 0)], [P('bucketSource'), lit(j.adviceBucket.source)]]));
      if (j.directoryProbability !== undefined) t(P('directoryProbability'), dbl(j.directoryProbability));
      t(P('covered'), dbl(j.covered));
      if (j.precedents) {
        t(P('precedentsConsulted'), `"${j.precedents.consulted}"^^xsd:integer`);
        t(P('precedentWeight'), dbl(j.precedents.weight));
        for (const p of j.precedents.applied) {
          t(P('precedent'), bn([[P('task'), lit(p.task)], [P('similarity'), dbl(p.similarity)], ...p.files.map((f): [string, string] => [P('path'), lit(f)]), ['prov:wasDerivedFrom', iri(p.outcomeIri)]]));
        }
      }
      for (const f of j.files) t(P('candidate'), bn([[P('role'), lit('change')], [P('path'), lit(f.path)], [P('probability'), dbl(f.probability)]]));
      for (const f of j.tests) t(P('candidate'), bn([[P('role'), lit('test')], [P('path'), lit(f.path)], [P('probability'), dbl(f.probability)]]));
      for (const f of j.docs) t(P('candidate'), bn([[P('role'), lit('document')], [P('path'), lit(f.path)], [P('probability'), dbl(f.probability)]]));
      break;
    case 'test-selection':
      t(P('mode'), lit(j.mode));
      if (j.task) t(P('task'), lit(j.task));
      for (const f of j.changedFiles) t(P('changedFile'), lit(f));
      for (const r of j.reasons) t(P('reason'), lit(r));
      for (const s of j.tests) {
        const props: Array<[string, string]> = [[P('path'), lit(s.path)], [P('selectedBy'), lit(s.selectedBy)]];
        if (s.probability !== undefined) props.push([P('probability'), dbl(s.probability)]);
        t(P('selectedTest'), bn(props));
      }
      break;
    case 'failure-triage':
      for (const f of j.changedFiles) t(P('changedFile'), lit(f));
      for (const f of j.failures) {
        const props: Array<[string, string]> = [['dct:identifier', lit(f.id)], [P('causeClass'), lit(f.causeClass)], [P('action'), lit(f.action)], [P('confidence'), dbl(f.confidence)], [P('excerpt'), lit(f.excerpt.slice(0, 600))]];
        if (f.file) props.push([P('path'), lit(f.file)]);
        if (f.name) props.push([P('testName'), lit(f.name)]);
        t(P('failure'), bn(props));
      }
      break;
    case 'review-verdict':
      t(P('verdict'), lit(j.verdict));
      t(P('policy'), lit(j.policy));
      if (j.title) t(P('changeTitle'), lit(j.title));
      if (j.descriptionMatch !== null) t(P('descriptionMatch'), dbl(j.descriptionMatch));
      if (j.risk) t(P('risk'), lit(j.risk.choice));
      for (const c of j.checks) t(P('check'), lit(c));
      for (const r of j.reasons) t(P('reason'), lit(r));
      for (const f of j.changedFiles) t(P('changedFile'), lit(f));
      for (const h of j.hazards) t(P('hazard'), bn([[P('hazardName'), lit(h.name)], [P('probability'), dbl(h.probability)], [P('fired'), bool(h.fired)]]));
      break;
    case 'outcome':
      t(P('judgmentIri'), iri(j.judgmentIri));
      t(P('judgmentKind'), lit(j.judgmentKind));
      t(P('priorConfidence'), dbl(j.priorConfidence));
      t(P('outcomeSource'), lit(j.source));
      if (j.hitAt1 !== null) t(P('hitAt1'), bool(j.hitAt1));
      if (j.hitAt3 !== null) t(P('hitAt3'), bool(j.hitAt3));
      if (j.brier !== null) t(P('brier'), dbl(j.brier));
      if (j.agreement) t(P('agreement'), lit(j.agreement));
      for (const m of j.missed) t(P('missed'), lit(m));
      t(P('summary'), lit(j.summary));
      // The pair (task, observed files) is what a later navigation consults as a precedent, so
      // an outcome read back from the pod carries it without dereferencing the judgment.
      if (j.task) t(P('task'), lit(j.task));
      for (const f of j.observed.filesChanged ?? []) t(P('observedFile'), lit(f));
      if (j.priorPrecedentWeight !== undefined) t(P('priorPrecedentWeight'), dbl(j.priorPrecedentWeight));
      break;
  }

  for (const c of controls) {
    const C = iri(c.id);
    t('hmd:control', C);
    lines.push(`${C} a hmd:Control, iep:Affordance, hydra:Operation .`);
    lines.push(`${C} dct:title ${lit(c.title)} .`);
    lines.push(`${C} hmd:rel ${iri(c.action)} .`);
    lines.push(`${C} iep:action ${iri(c.action)} .`);
    lines.push(`${C} hmd:method ${lit(c.method)} .`);
    lines.push(`${C} hydra:method ${lit(c.method)} .`);
    if (c.target) lines.push(`${C} hydra:target ${iri(c.target)} .`);
    if (c.expects) { lines.push(`${C} hydra:expects ${iri(c.expects)} .`); lines.push(`${C} iep:inputShape ${iri(c.expects)} .`); }
    if (c.returns) lines.push(`${C} hydra:returns ${iri(c.returns)} .`);
    if (c.arguments !== undefined) lines.push(`${C} ${P('argumentsJson')} ${lit(JSON.stringify(c.arguments))} .`);
    lines.push(`${C} ${P('declarative')} ${bool(c.declarative)} .`);
    lines.push(`${C} skos:scopeNote ${lit(c.scopeNote)} .`);
  }
  return lines.join('\n') + '\n';
}

export interface DescriptorOptions {
  readonly supersedes?: readonly string[];
  readonly validFrom?: string;
}

/** A self-contained descriptor (facets, affordance, payload graph) in TriG. */
export function descriptorTrig(j: Published, ctx: PublishContext, opts: DescriptorOptions = {}): string {
  const D = iri(descriptorIri(j));
  const status = modalStatus(j);
  const validFrom = opts.validFrom ?? j.createdAt;
  const issuer = ctx.ownerWebId ?? ctx.agentId;
  const url = judgmentUrl(j, ctx);
  const prefixes = [payloadPrefixes(ctx), prefixLine('ieh', IEH), prefixLine('as', AS), prefixLine('dcat', DCAT)].join('\n');
  const supersedes = (opts.supersedes ?? []).map((s) => `    iep:supersedes ${iri(s)} ;`).join('\n');
  const semiotic = status === 'Asserted'
    ? `        iep:groundTruth ${bool(true)} ;\n        iep:modalStatus iep:Asserted ;`
    : `        iep:modalStatus iep:Hypothetical ;`;
  const descriptor = `${D}
    a iep:ContextDescriptor ;
    iep:version "1"^^xsd:integer ;
    iep:validFrom "${validFrom}"^^xsd:dateTime ;
${supersedes}
    dct:conformsTo ${iri(`${ctx.ns}${payloadType(j)}Shape`)} ;
    dct:conformsTo ${iri(HMD_PROFILE)} ;
    iep:describes ${iri(j.graphIri)} ;
    iep:hasFacet [
        a iep:TemporalFacet ;
        iep:validFrom "${validFrom}"^^xsd:dateTime
    ] ;
    iep:hasFacet [
        a iep:ProvenanceFacet ;
        prov:wasGeneratedBy [
            a prov:Activity ;
            prov:wasAssociatedWith ${iri(ctx.agentId)} ;
            prov:used ${iri(`urn:typesafe:model:${j.model}`)} ;
            prov:endedAtTime "${j.createdAt}"^^xsd:dateTime
        ] ;
        prov:wasAttributedTo ${iri(issuer)} ;
        prov:generatedAtTime "${j.createdAt}"^^xsd:dateTime
    ] ;
    iep:hasFacet [
        a iep:AgentFacet ;
        iep:assertingAgent [
            a prov:SoftwareAgent, as:Application ;
            iep:agentIdentity ${iri(ctx.agentId)}
        ] ;
        iep:agentRole iep:Author${ctx.ownerWebId ? ` ;\n        iep:onBehalfOf ${iri(ctx.ownerWebId)}` : ''}
    ] ;
    iep:hasFacet [
        a iep:SemioticFacet ;
${semiotic}
        iep:epistemicConfidence ${dbl(j.confidence)}
    ] ;
    iep:hasFacet [
        a iep:TrustFacet ;
        iep:issuer ${iri(issuer)} ;
        iep:trustLevel iep:SelfAsserted
    ] ;
    iep:hasFacet [
        a iep:FederationFacet ;
        iep:origin ${iri(ctx.base + '/')} ;
        iep:storageEndpoint ${iri(ctx.base + '/')}
    ] .

${D} iep:affordance [
    a iep:Affordance, ieh:Affordance, hydra:Operation, dcat:Distribution ;
    iep:action iep:canFetchPayload ;
    hydra:method "GET" ;
    hydra:target ${iri(`${url}.trig`)} ;
    hydra:returns iep:GraphPayload ;
    hydra:title "Fetch graph payload" ;
    dcat:accessURL ${iri(`${url}.trig`)} ;
    dcat:mediaType "application/trig" ;
    iep:encrypted false ;
    iep:visibility "public"
] .

${iri(j.graphIri)} {
${payloadBody(j, ctx).split('\n').filter(Boolean).map((l) => `    ${l}`).join('\n')}
}
`;
  return `${prefixes}\n\n${descriptor}`;
}

// ── HyperMarkdown projection ──────────────────────────────────────────────────

export function titleOf(j: Published): string {
  switch (j.kind) {
    case 'navigation': return `Navigation: ${j.task.slice(0, 80)}`;
    case 'test-selection': return `Test selection: ${j.mode} (${j.tests.length} tests for ${j.changedFiles.length} changed files)`;
    case 'failure-triage': return `Failure triage: ${j.failures.length} failures in ${j.groups.length} classes`;
    case 'review-verdict': return `Review verdict: ${j.verdict}${j.title ? ` for "${j.title.slice(0, 60)}"` : ''}`;
    case 'outcome': return `Outcome of ${j.judgmentKind}: ${j.summary.slice(0, 80)}`;
  }
}

export function proseOf(j: Published): string {
  const pct = (p: number): string => `${Math.round(p * 100)}%`;
  const lines: string[] = [`# ${titleOf(j)}`, ''];
  lines.push(`Model ${j.model}, confidence ${j.confidence}, repository ${j.repository.name}${j.repository.commit ? ` at ${j.repository.commit.slice(0, 10)}` : ''}, ${j.usage.requests} request(s), ${j.usage.input_tokens} input tokens.`, '');
  switch (j.kind) {
    case 'navigation':
      lines.push(`Task: ${j.task}`, '', `Advice: **${j.advice}**${j.adviceBasis === 'calibrated' && j.adviceBucket ? ` (calibrated: ${j.adviceBucket.samples} outcomes at confidence ${j.adviceBucket.from} to ${round(j.adviceBucket.from + 0.2, 2)} hit@1 ${j.adviceBucket.hitAt1 ?? 'n/a'}, hit@3 ${j.adviceBucket.hitAt3 ?? 'n/a'})` : ' (default bands)'}. Existing coverage: ${pct(j.covered)}.`, '', '| Role | Path | Probability |', '| --- | --- | --- |');
      for (const f of j.files) lines.push(`| change | ${f.path} | ${f.probability} |`);
      for (const f of j.tests) lines.push(`| test | ${f.path} | ${f.probability} |`);
      for (const f of j.docs) lines.push(`| document | ${f.path} | ${f.probability} |`);
      if (j.precedents) {
        lines.push('', `Memory: ${j.precedents.consulted} precedent(s) consulted, ${j.precedents.applied.length} applied, share ${j.precedents.weight}.`);
        for (const p of j.precedents.applied) lines.push(`- "${p.task.slice(0, 80)}" (similarity ${p.similarity}) → ${p.files.join(', ')}`);
      }
      break;
    case 'test-selection':
      lines.push(`Mode: **${j.mode}**. ${j.reasons.join(' ')}`, '', `Changed: ${j.changedFiles.join(', ')}`, '', '| Test | Selected by | Probability |', '| --- | --- | --- |');
      for (const t of j.tests.slice(0, 60)) lines.push(`| ${t.path} | ${t.selectedBy} | ${t.probability ?? ''} |`);
      if (j.tests.length > 60) lines.push(`| … ${j.tests.length - 60} more | | |`);
      break;
    case 'failure-triage':
      lines.push('| Failure | File | Class | Confidence | Action |', '| --- | --- | --- | --- | --- |');
      for (const f of j.failures) lines.push(`| ${f.id} ${f.name ?? ''} | ${f.file ?? ''} | ${f.causeClass} | ${f.confidence} | ${f.action} |`);
      break;
    case 'review-verdict':
      lines.push(`Verdict: **${j.verdict}**`, '', ...j.reasons.map((r) => `- ${r}`), '', `Policy: ${j.policy}`, '');
      if (j.hazards.length > 0) {
        lines.push('| Hazard | Probability | Fired |', '| --- | --- | --- |');
        for (const h of j.hazards) lines.push(`| ${h.name} | ${h.probability} | ${h.fired ? 'yes' : 'no'} |`);
      }
      if (j.risk) lines.push('', `Risk: ${j.risk.choice} (confidence ${j.risk.confidence})${j.descriptionMatch !== null ? `; description match ${j.descriptionMatch} of 2` : ''}.`);
      break;
    case 'outcome':
      lines.push(`Scores ${j.judgmentIri}.`, '', j.summary, '', `hit@1 ${j.hitAt1 ?? 'n/a'}, hit@3 ${j.hitAt3 ?? 'n/a'}, Brier ${j.brier ?? 'n/a'}${j.agreement ? `, agreement ${j.agreement}` : ''}.`);
      if (j.missed.length > 0) lines.push('', `Missed: ${j.missed.join(', ')}`);
      break;
  }
  return lines.join('\n');
}

export function hmdMarkdown(j: Published, ctx: PublishContext): string {
  const url = judgmentUrl(j, ctx);
  const controls = controlsFor(j, ctx);
  const front = [
    '---',
    '"@context":',
    `  - iep: "${IEP}"`,
    `    hydra: "${HYDRA}"`,
    `    hmd: "${HMD}"`,
    `    jvh: "${ctx.ns}"`,
    `"@id": "${url}"`,
    `"@type": ["jvh:${payloadType(j)}", "hmd:Document"]`,
    `descriptorUrl: "${url}.trig"`,
    `state: "${modalStatus(j).toLowerCase()}"`,
    `graph: "${j.graphIri}"`,
    '---',
    '',
  ];
  const body = [proseOf(j), '', `_${modalStatus(j)} judgment — its controls are below. Executable controls name this bridge's own targets; declarative ones are performed by the follower or a person._`, ''];
  for (const c of controls) {
    body.push(`:::control ${c.name}`);
    body.push(`type: ["hmd:Control", "hydra:Operation"]`);
    body.push(`title: ${JSON.stringify(c.title)}`);
    body.push(`rel: "${c.action}"`);
    body.push(`method: "${c.method}"`);
    if (c.target) body.push(`target: "${c.target}"`);
    else body.push('declarative: true');
    if (c.expects) body.push(`expects: "${c.expects}"`);
    if (c.returns) body.push(`returns: "${c.returns}"`);
    if (c.arguments !== undefined) body.push(`arguments: ${JSON.stringify(c.arguments)}`);
    body.push(`source: "${url}.trig"`);
    body.push(`note: ${JSON.stringify(c.scopeNote)}`);
    body.push(':::', '');
  }
  body.push('> To act: dereference the descriptor and follow a control by its `rel` — the follower re-resolves the live `target` from the signed source, never from this rendering.');
  return `${front.join('\n')}${body.join('\n')}\n`;
}
