/**
 * Pod-backed loader for the agent-development-practice vertical.
 *
 * Walks the user's pod manifest and assembles a typed view of the
 * probe cycle: capabilities, probes, narrative fragments, syntheses,
 * evolution steps, constraints, capability evolution events.
 */

import { discover } from '../../../src/index.js';
import type { IRI } from '../../../src/index.js';

// ── Typed records ────────────────────────────────────────────────────

export interface CapabilityRecord {
  readonly iri: IRI;
  readonly name: string;
  readonly cynefinDomain: string;
  readonly rubricCriterionCount: number;
}

export interface ProbeRecord {
  readonly iri: IRI;
  readonly capabilityIri?: IRI;
  readonly variant: string;
  readonly hypothesis: string;
  readonly amplificationTrigger: string;
  readonly dampeningTrigger: string;
  readonly timeBound: string;
  readonly modalStatus: string;
}

export interface NarrativeFragmentRecord {
  readonly iri: IRI;
  readonly probeIri?: IRI;
  readonly contextSignifiers: readonly string[];
  readonly response: string;
  readonly emergentSignifier: string;
  readonly modalStatus: string;
}

export interface SynthesisRecord {
  readonly iri: IRI;
  readonly probeIri?: IRI;
  readonly fragmentsConsidered: readonly IRI[];
  readonly emergentPattern: string;
  readonly coherentNarratives: readonly string[];
  readonly modalStatus: string;
}

export interface EvolutionStepRecord {
  readonly iri: IRI;
  readonly synthesisIri?: IRI;
  readonly amplifyProbeIris: readonly IRI[];
  readonly dampenProbeIris: readonly IRI[];
  readonly explicitDecisionNotMade: string;
  readonly nextRevisitAt: string;
  readonly modalStatus: string;
}

export interface ConstraintRecord {
  readonly iri: IRI;
  readonly capabilityIri?: IRI;
  readonly emergedFromIris: readonly IRI[];
  readonly boundary: string;
  readonly exitsConstraint: string;
  readonly modalStatus: string;
}

export interface CapabilityEvolutionRecord {
  readonly iri: IRI;
  readonly capabilityIri?: IRI;
  readonly evolutionType: string;
  readonly olkeStage: string;
  readonly emergedFromIris: readonly IRI[];
  readonly explicitDecisionNotMade: string;
  readonly modalStatus: string;
}

export interface ProbeCycleState {
  readonly operatorDid: IRI;
  readonly capabilities: readonly CapabilityRecord[];
  readonly probes: readonly ProbeRecord[];
  readonly fragments: readonly NarrativeFragmentRecord[];
  readonly syntheses: readonly SynthesisRecord[];
  readonly evolutionSteps: readonly EvolutionStepRecord[];
  readonly constraints: readonly ConstraintRecord[];
  readonly capabilityEvolutions: readonly CapabilityEvolutionRecord[];
}

export interface LoaderConfig {
  readonly podUrl: string;
  readonly operatorDid: IRI;
  readonly fetchTimeoutMs?: number;
  readonly fetchConcurrency?: number;
  readonly logger?: (level: 'warn' | 'info', msg: string) => void;
}

// ── Helpers ──────────────────────────────────────────────────────────

async function fetchPool<T, R>(items: readonly T[], worker: (i: T) => Promise<R>, n: number): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await worker(items[i]!);
    }
  }));
  return out;
}

async function fetchTurtle(url: string, timeoutMs: number): Promise<string | null> {
  // CSS does content negotiation; for .trig files asking for text/turtle
  // strips named graphs (which is where domain-namespace triples live).
  // Request trig+turtle so we get both default + named graph content.
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      headers: { Accept: 'application/trig, text/turtle;q=0.5, */*;q=0.1' },
      signal: ac.signal,
    });
    return r.ok ? await r.text() : null;
  } catch { return null; } finally { clearTimeout(t); }
}

function extractGraphUrl(turtle: string): string | null {
  const m = /cg:affordance\s+\[[^\]]*?hydra:target\s+<([^>]+)>/s.exec(turtle);
  return m ? m[1]! : null;
}

function detectAdpType(blob: string): 'Capability'|'Probe'|'NarrativeFragment'|'Synthesis'|'EvolutionStep'|'Constraint'|'CapabilityEvolution'|'unknown' {
  if (/\ba\b\s+adp:Capability\b/.test(blob)) return 'Capability';
  if (/\ba\b\s+adp:Probe\b/.test(blob)) return 'Probe';
  if (/\ba\b\s+adp:NarrativeFragment\b/.test(blob)) return 'NarrativeFragment';
  if (/\ba\b\s+adp:Synthesis\b/.test(blob)) return 'Synthesis';
  if (/\ba\b\s+adp:EvolutionStep\b/.test(blob)) return 'EvolutionStep';
  if (/\ba\b\s+adp:Constraint\b/.test(blob)) return 'Constraint';
  if (/\ba\b\s+adp:CapabilityEvolution\b/.test(blob)) return 'CapabilityEvolution';
  return 'unknown';
}

function descriptorIri(turtle: string): IRI {
  const m = /^\s*<([^>]+)>\s+a\s+/m.exec(turtle);
  return (m?.[1] ?? '') as IRI;
}

function findString(s: string, pred: string): string | undefined {
  const m = new RegExp(`${pred}\\s+"((?:[^"\\\\]|\\\\.)*)"`).exec(s);
  return m?.[1]?.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

function findMulti(s: string, pred: string): string | undefined {
  const m = new RegExp(`${pred}\\s+"""([\\s\\S]*?)"""`).exec(s);
  return m?.[1] ?? findString(s, pred);
}

function findAllMulti(s: string, pred: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${pred}\\s+"""([\\s\\S]*?)"""`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1]!);
  if (out.length === 0) {
    const re2 = new RegExp(`${pred}\\s+"((?:[^"\\\\]|\\\\.)*)"`, 'g');
    while ((m = re2.exec(s)) !== null) out.push(m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  }
  return out;
}

function findAllString(s: string, pred: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`${pred}\\s+"((?:[^"\\\\]|\\\\.)*)"`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  return out;
}

function findIri(s: string, pred: string): IRI | undefined {
  const m = new RegExp(`${pred}\\s+<([^>]+)>`).exec(s);
  return m ? (m[1] as IRI) : undefined;
}

function findAllIri(s: string, pred: string): IRI[] {
  const out: IRI[] = [];
  const re = new RegExp(`${pred}\\s+<([^>]+)>`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out.push(m[1]! as IRI);
  return out;
}

function findEnum(s: string, pred: string): string {
  const m = new RegExp(`${pred}\\s+(?:adp|olke|cg):(\\w+)`).exec(s);
  return m?.[1] ?? 'unknown';
}

// ── Public API ───────────────────────────────────────────────────────

export async function loadProbeCycle(config: LoaderConfig): Promise<ProbeCycleState> {
  const concurrency = config.fetchConcurrency ?? 8;
  const timeoutMs = config.fetchTimeoutMs ?? 6000;
  const log = config.logger ?? ((level, msg) => { if (level === 'warn') console.warn(`[adp-loader] ${msg}`); });

  const entries = await discover(config.podUrl).catch((e) => {
    log('warn', `manifest discovery failed: ${(e as Error).message}`);
    return [];
  });

  const enriched = await fetchPool(
    entries,
    async (entry) => {
      const turtle = await fetchTurtle(entry.descriptorUrl, timeoutMs);
      if (!turtle) return null;
      const graphUrl = extractGraphUrl(turtle);
      const graphContent = graphUrl ? await fetchTurtle(graphUrl, timeoutMs) : null;
      const blob = `${turtle}\n${graphContent ?? ''}`;
      return { turtle, graphContent: graphContent ?? '', blob, type: detectAdpType(blob) };
    },
    concurrency,
  );

  const capabilities: CapabilityRecord[] = [];
  const probes: ProbeRecord[] = [];
  const fragments: NarrativeFragmentRecord[] = [];
  const syntheses: SynthesisRecord[] = [];
  const evolutionSteps: EvolutionStepRecord[] = [];
  const constraints: ConstraintRecord[] = [];
  const capabilityEvolutions: CapabilityEvolutionRecord[] = [];

  for (const e of enriched) {
    if (!e) continue;
    try {
      const iri = descriptorIri(e.turtle);
      switch (e.type) {
        case 'Capability':
          capabilities.push({
            iri,
            name: findString(e.blob, 'rdfs:label') ?? 'untitled',
            cynefinDomain: findEnum(e.blob, 'adp:cynefinDomain'),
            rubricCriterionCount: findAllIri(e.graphContent, 'adp:rubricCriterion').length,
          });
          break;
        case 'Probe':
          probes.push({
            iri,
            capabilityIri: findIri(e.graphContent, 'adp:capability'),
            variant: findString(e.graphContent, 'adp:variant') ?? '',
            hypothesis: findMulti(e.graphContent, 'adp:hypothesis') ?? '',
            amplificationTrigger: findMulti(e.graphContent, 'adp:amplificationTrigger') ?? '',
            dampeningTrigger: findMulti(e.graphContent, 'adp:dampeningTrigger') ?? '',
            timeBound: findString(e.graphContent, 'adp:timeBound') ?? '',
            modalStatus: findEnum(e.blob, 'cg:modalStatus'),
          });
          break;
        case 'NarrativeFragment':
          fragments.push({
            iri,
            probeIri: findIri(e.graphContent, 'adp:probe'),
            contextSignifiers: findAllString(e.graphContent, 'adp:contextSignifier'),
            response: findMulti(e.graphContent, 'adp:response') ?? '',
            emergentSignifier: findString(e.graphContent, 'adp:emergentSignifier') ?? '',
            modalStatus: findEnum(e.blob, 'cg:modalStatus'),
          });
          break;
        case 'Synthesis':
          syntheses.push({
            iri,
            probeIri: findIri(e.graphContent, 'adp:probe'),
            fragmentsConsidered: findAllIri(e.graphContent, 'adp:fragmentsConsidered'),
            emergentPattern: findMulti(e.graphContent, 'adp:emergentPattern') ?? '',
            coherentNarratives: findAllMulti(e.graphContent, 'adp:coherentNarrative'),
            modalStatus: findEnum(e.blob, 'cg:modalStatus'),
          });
          break;
        case 'EvolutionStep':
          evolutionSteps.push({
            iri,
            synthesisIri: findIri(e.graphContent, 'adp:basedOnSynthesis'),
            amplifyProbeIris: findAllIri(e.graphContent, 'adp:amplifyProbe'),
            dampenProbeIris: findAllIri(e.graphContent, 'adp:dampenProbe'),
            explicitDecisionNotMade: findMulti(e.graphContent, 'adp:explicitDecisionNotMade') ?? '',
            nextRevisitAt: findString(e.graphContent, 'adp:nextRevisitAt') ?? '',
            modalStatus: findEnum(e.blob, 'cg:modalStatus'),
          });
          break;
        case 'Constraint':
          constraints.push({
            iri,
            capabilityIri: findIri(e.graphContent, 'adp:appliesTo'),
            emergedFromIris: findAllIri(e.graphContent, 'adp:emergedFrom'),
            boundary: findMulti(e.graphContent, 'adp:boundary') ?? '',
            exitsConstraint: findMulti(e.graphContent, 'adp:exitsConstraint') ?? '',
            modalStatus: findEnum(e.blob, 'cg:modalStatus'),
          });
          break;
        case 'CapabilityEvolution':
          capabilityEvolutions.push({
            iri,
            capabilityIri: findIri(e.graphContent, 'adp:capability'),
            evolutionType: findEnum(e.blob, 'adp:evolutionType'),
            olkeStage: findEnum(e.blob, 'adp:olkeStage'),
            emergedFromIris: findAllIri(e.graphContent, 'adp:emergedFrom'),
            explicitDecisionNotMade: findMulti(e.graphContent, 'adp:explicitDecisionNotMade') ?? '',
            modalStatus: findEnum(e.blob, 'cg:modalStatus'),
          });
          break;
        case 'unknown':
          break;
      }
    } catch (err) {
      log('warn', `parse failure: ${(err as Error).message}`);
    }
  }

  return {
    operatorDid: config.operatorDid,
    capabilities, probes, fragments, syntheses,
    evolutionSteps, constraints, capabilityEvolutions,
  };
}
